import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { setTimeout } from "node:timers/promises";
import { PiConnectionError, requestRepairEdits } from "../src/pi.ts";

const fakeKey = "sk-LOCAL_FAKE_PROPOSAL_TEST_ONLY";
const prompt = JSON.stringify({ issue: "Fix the empty input result", sources: { "src/demo.ts": "return 1;" } });
const submission = { edits: [{ path: "src/demo.ts", before: "return 1;", after: "return 0;" }] };

type Reply = { tools: Array<{ name: string; arguments: string }> } | { status: 503 } | { hold: true };
type Request = { validAuth: boolean; body: string; url?: string };

async function withProvider(reply: Reply, run: (modelsPath: string, requests: Request[]) => Promise<void>) {
  const requests: Request[] = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    requests.push({ validAuth: request.headers.authorization === `Bearer ${fakeKey}`, body, url: request.url });
    if ("hold" in reply) {
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.flushHeaders();
      return;
    }
    if ("status" in reply) {
      response.writeHead(reply.status, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: { message: `synthetic upstream failure ${fakeKey}` } }));
      return;
    }
    const toolCalls = reply.tools.map((fn, index) => ({ index, id: `call_${index}`, type: "function", function: fn }));
    const delta = toolCalls.length > 0 ? { role: "assistant", tool_calls: toolCalls } : { role: "assistant", content: "I fixed it" };
    const base = { id: "proposal-test", object: "chat.completion.chunk", created: 1, model: "qwen3.7-plus" };
    const emit = (part: object, finish: string | null) => `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: part, finish_reason: finish }] })}\n\n`;
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.end(emit(delta, null) + emit({}, toolCalls.length ? "tool_calls" : "stop") + "data: [DONE]\n\n");
  });
  const temporaryRoot = resolve(tmpdir());
  const directory = await mkdtemp(join(temporaryRoot, "repopilot-proposal-model-"));
  const previousKey = process.env.DASHSCOPE_API_KEY;
  process.env.DASHSCOPE_API_KEY = fakeKey;
  try {
    await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const modelsPath = join(directory, "models.json");
    await writeFile(modelsPath, JSON.stringify({ providers: { dashscope: {
      baseUrl: `http://127.0.0.1:${address.port}/v1`, api: "openai-completions", apiKey: "${DASHSCOPE_API_KEY}",
      compat: { maxTokensField: "max_tokens", thinkingFormat: "qwen" },
      models: [{ id: "qwen3.7-plus", reasoning: true }],
    } } }));
    await run(modelsPath, requests);
  } finally {
    if (previousKey === undefined) delete process.env.DASHSCOPE_API_KEY;
    else process.env.DASHSCOPE_API_KEY = previousKey;
    server.closeAllConnections();
    server.close();
    assert.equal(dirname(resolve(directory)), temporaryRoot);
    await rm(directory, { recursive: true, force: true });
  }
}

const tool = { name: "submit_edits", arguments: JSON.stringify(submission) };
const hasSafeCode = (code: string) => (error: unknown) => {
  assert.ok(error instanceof PiConnectionError);
  assert.equal(error.code, code);
  assert.equal(error.message.includes(fakeKey), false);
  assert.equal(error.stack?.includes(fakeKey), false);
  return true;
};

test("repair proposal returns one submitted edit batch after exactly one bounded SDK request", async () => {
  await withProvider({ tools: [tool] }, async (modelsPath, requests) => {
    assert.deepEqual(await requestRepairEdits(prompt, modelsPath), submission);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].validAuth, true);
    assert.equal(requests[0].url, "/v1/chat/completions");
    assert.equal(requests[0].body.includes(fakeKey), false);
    const body = JSON.parse(requests[0].body);
    assert.equal(body.max_tokens, 2048);
    assert.equal(body.enable_thinking, false);
    assert.deepEqual(body.tools.map((item: { function: { name: string } }) => item.function.name), ["submit_edits"]);
    assert.ok(body.messages.some((message: { role: string; content: unknown }) => message.role === "user" && message.content === prompt));
  });
});

test("repair proposal rejects missing, unknown, duplicate and malformed tool calls", async () => {
  for (const tools of [[], [{ ...tool, name: "run_shell" }], [tool, tool], [{ ...tool, arguments: '{"edits":[' }]]) {
    await withProvider({ tools }, async (modelsPath, requests) => {
      await assert.rejects(requestRepairEdits(prompt, modelsPath), hasSafeCode("MODEL_EDIT_SUBMISSION_INVALID"));
      assert.equal(requests.length, 1);
    });
  }
});

test("repair proposal does not retry or expose the credential in a provider failure", async () => {
  await withProvider({ status: 503 }, async (modelsPath, requests) => {
    await assert.rejects(requestRepairEdits(prompt, modelsPath), hasSafeCode("MODEL_REQUEST_FAILED"));
    assert.equal(requests.length, 1);
  });
});

test("repair proposal blocks its credential in input or submitted edits", async () => {
  const leakingReply = { ...tool, arguments: JSON.stringify({ edits: [{ ...submission.edits[0], after: fakeKey }] }) };
  await withProvider({ tools: [leakingReply] }, async (modelsPath, requests) => {
    await assert.rejects(requestRepairEdits(JSON.stringify({ issue: fakeKey }), modelsPath), hasSafeCode("MODEL_CREDENTIAL_IN_CONTENT"));
    assert.equal(requests.length, 0);
    await assert.rejects(requestRepairEdits(prompt, modelsPath), hasSafeCode("MODEL_CREDENTIAL_IN_CONTENT"));
    assert.equal(requests.length, 1);
  });
});

test("repair proposal cancellation prevents a new model request", async () => {
  await withProvider({ tools: [tool] }, async (modelsPath, requests) => {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(requestRepairEdits(prompt, modelsPath, controller.signal), hasSafeCode("OPERATION_CANCELLED"));
    assert.equal(requests.length, 0);
  });
});

test("repair proposal aborts an in-flight model stream without retrying", async () => {
  await withProvider({ hold: true }, async (modelsPath, requests) => {
    const controller = new AbortController();
    const pending = requestRepairEdits(prompt, modelsPath, controller.signal);
    const rejected = assert.rejects(pending, hasSafeCode("OPERATION_CANCELLED"));
    try {
      for (let attempt = 0; attempt < 100 && requests.length === 0; attempt++) await setTimeout(10);
      assert.equal(requests.length, 1);
    } finally {
      controller.abort();
    }
    await rejected;
    assert.equal(requests.length, 1);
  });
});
