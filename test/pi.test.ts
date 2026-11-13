import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { checkAuthentication, inspectConfiguration, PiConnectionError, runConnectionCheck } from "../src/pi.ts";

const fakeKey = "sk-LOCAL_FAKE_SDK_TEST_NOT_A_REAL_KEY";
type ChatRequest = {
  model: string;
  stream?: boolean;
  enable_thinking?: boolean;
  store?: boolean;
  reasoning_effort?: string;
  tools?: Array<{ function: { name: string } }>;
  messages: Array<{ role: string; content: unknown }>;
};

async function withModelServer(mode: "success" | "unauthorized" | "skip-tool" | "recover-tool-error", verify: (modelsPath: string, requests: ChatRequest[]) => Promise<void>) {
  const requests: ChatRequest[] = [];
  const headerMatches: boolean[] = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const payload = JSON.parse(body) as ChatRequest;
    requests.push(payload);
    headerMatches.push(request.headers.authorization === `Bearer ${fakeKey}`);
    if (mode === "unauthorized") {
      response.writeHead(401, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: { message: `Denied ${fakeKey}`, type: "invalid_request_error", code: "invalid_api_key" } }));
      return;
    }
    if (payload.stream === false) {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "OK" } }] }));
      return;
    }
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    const base = { id: "sdk-test", object: "chat.completion.chunk", created: 1, model: "qwen3.7-plus" };
    const hasReadTool = payload.tools?.some(tool => tool.function.name === "read_probe");
    const toolResult = payload.messages.findLast(message => message.role === "tool");
    const needsTool = hasReadTool && mode !== "skip-tool" && (!toolResult || (mode === "recover-tool-error" && !String(toolResult.content).includes("PI_REPOPILOT_")));
    const wrongTool = mode === "recover-tool-error" && !toolResult;
    const delta = needsTool
      ? { role: "assistant", tool_calls: [{ index: 0, id: wrongTool ? "unknown-probe-1" : "read-probe-1", type: "function", function: { name: wrongTool ? "missing_probe" : "read_probe", arguments: "{}" } }] }
      : { role: "assistant", content: hasReadTool ? String(toolResult?.content ?? "I read the file.") : "PI_QWEN_OK" };
    const finishReason = "tool_calls" in delta ? "tool_calls" : "stop";
    response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
    response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: finishReason }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } })}\n\n`);
    response.end("data: [DONE]\n\n");
  });
  const tempRoot = resolve(tmpdir());
  const directory = await mkdtemp(join(tempRoot, "repopilot-sdk-test-"));
  const previousKey = process.env.DASHSCOPE_API_KEY;
  process.env.DASHSCOPE_API_KEY = `  ${fakeKey}  `;
  try {
    await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const modelsPath = join(directory, "models.json");
    await writeFile(modelsPath, JSON.stringify({ providers: { dashscope: {
      baseUrl: `http://127.0.0.1:${address.port}/v1`, api: "openai-completions", apiKey: "sk-CONFIG_FAKE_MUST_NOT_OVERRIDE_RUNTIME",
      compat: { supportsStore: false, supportsDeveloperRole: false, supportsReasoningEffort: false, maxTokensField: "max_tokens", thinkingFormat: "qwen" },
      models: [{ id: "qwen3.7-plus", reasoning: true }],
    } } }));
    await verify(modelsPath, requests);
    assert.ok(headerMatches.length > 0 && headerMatches.every(Boolean), "Runtime credential must be trimmed and used in the Authorization header");
  } finally {
    if (previousKey === undefined) delete process.env.DASHSCOPE_API_KEY;
    else process.env.DASHSCOPE_API_KEY = previousKey;
    server.closeAllConnections();
    server.close();
    assert.equal(dirname(resolve(directory)), tempRoot);
    await rm(directory, { recursive: true, force: true });
  }
}

test("configuration can be checked without credentials", async () => {
  const previousKey = process.env.DASHSCOPE_API_KEY;
  delete process.env.DASHSCOPE_API_KEY;
  try {
    assert.deepEqual(await inspectConfiguration(), { kind: "sdk_configuration_check", model: "dashscope/qwen3.7-plus", credential: "missing" });
    await assert.rejects(runConnectionCheck(), error => error instanceof PiConnectionError && error.code === "API_KEY_MISSING");
  } finally {
    if (previousKey !== undefined) process.env.DASHSCOPE_API_KEY = previousKey;
  }
});

test("SDK verifies a streamed reply and an actual fixed-file read", async () => {
  await withModelServer("success", async (modelsPath, requests) => {
    const result = await runConnectionCheck(modelsPath);
    assert.equal(result.status, "passed");
    assert.equal(result.text.toolCalls, 0);
    assert.equal(result.readTool.toolCalls, 1);
    assert.equal(result.text.streamed, true);
    assert.equal(result.readTool.streamed, true);
    assert.ok(result.readTool.tokens.total > 0);
    assert.equal(requests.length, 3);
    for (const request of requests) {
      assert.equal(request.model, "qwen3.7-plus");
      assert.equal(request.enable_thinking, false);
      assert.equal("store" in request, false);
      assert.equal("reasoning_effort" in request, false);
    }
    assert.ok(!JSON.stringify(result).includes(fakeKey));
  });
});

test("a provider error is rejected without returning the credential", async () => {
  await withModelServer("unauthorized", async (modelsPath, requests) => {
    await assert.rejects(runConnectionCheck(modelsPath), error => {
      assert.ok(error instanceof PiConnectionError);
      assert.equal(error.code, "MODEL_REQUEST_FAILED");
      assert.ok(!error.message.includes(fakeKey));
      return true;
    });
    assert.equal(requests.length, 1);
  });
});

test("claiming a file was read does not pass the tool check", async () => {
  await withModelServer("skip-tool", async (modelsPath) => {
    await assert.rejects(runConnectionCheck(modelsPath), error => error instanceof PiConnectionError && error.code === "REPLY_MISMATCH");
  });
});


test("an extra failed tool call cannot pass as exactly one successful read", async () => {
  await withModelServer("recover-tool-error", async (modelsPath) => {
    await assert.rejects(runConnectionCheck(modelsPath), error => error instanceof PiConnectionError && error.code === "TOOL_CHECK_FAILED");
  });
});



test("direct authentication check bypasses the SDK request adapter", async () => {
  await withModelServer("success", async (modelsPath, requests) => {
    const result = await checkAuthentication(modelsPath);
    assert.equal(result.status, "accepted");
    assert.equal(result.httpStatus, 200);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].stream, false);
    assert.ok(!JSON.stringify(result).includes(fakeKey));
  });
});

test("direct rejection records only a known service code", async () => {
  await withModelServer("unauthorized", async (modelsPath) => {
    const result = await checkAuthentication(modelsPath);
    assert.equal(result.status, "rejected");
    assert.equal(result.httpStatus, 401);
    assert.equal(result.serviceCode, "invalid_api_key");
    assert.ok(!JSON.stringify(result).includes(fakeKey));
  });
});

test("masked and plan-specific keys are rejected before a request", async () => {
  const previousKey = process.env.DASHSCOPE_API_KEY;
  try {
    for (const [key, code] of [["sk-***", "API_KEY_INVALID"], ["sk-sp-LOCAL_FAKE", "API_KEY_PLAN_MISMATCH"]]) {
      process.env.DASHSCOPE_API_KEY = key;
      await assert.rejects(checkAuthentication(), error => error instanceof PiConnectionError && error.code === code);
    }
  } finally {
    if (previousKey === undefined) delete process.env.DASHSCOPE_API_KEY;
    else process.env.DASHSCOPE_API_KEY = previousKey;
  }
});
