import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { connect, type Socket } from "node:net";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const root = fileURLToPath(new URL("..", import.meta.url));

type ChatRequest = {
  model: string;
  stream: boolean;
  tools?: Array<{ function: { name: string } }>;
  messages: Array<{ role: string; content: unknown }>;
};

async function verifyProxy(command: "auth-check" | "smoke") {
  const fakeKey = "sk-LOCAL_FAKE_PROXY_TEST";
  const credentialMatches: boolean[] = [];
  const requests: ChatRequest[] = [];
  let tunnels = 0;
  const upstream = createServer(async (request, response) => {
    credentialMatches.push(request.headers.authorization === `Bearer ${fakeKey}`);
    let body = "";
    for await (const chunk of request) body += chunk;
    const payload = JSON.parse(body) as ChatRequest;
    requests.push(payload);
    if (command === "auth-check") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "OK" } }] }));
      return;
    }
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    const base = { id: "proxy-sdk-test", object: "chat.completion.chunk", created: 1, model: "qwen3.7-plus" };
    const hasReadTool = payload.tools?.some(tool => tool.function.name === "read_probe");
    const toolResult = payload.messages.findLast(message => message.role === "tool");
    const delta = hasReadTool && !toolResult
      ? { role: "assistant", tool_calls: [{ index: 0, id: "read-probe-1", type: "function", function: { name: "read_probe", arguments: "{}" } }] }
      : { role: "assistant", content: hasReadTool ? String(toolResult?.content ?? "") : "PI_QWEN_OK" };
    const finishReason = "tool_calls" in delta ? "tool_calls" : "stop";
    response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
    response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: finishReason }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } })}\n\n`);
    response.end("data: [DONE]\n\n");
  });
  const proxy = createServer();
  const sockets = new Set<Socket>();
  proxy.on("connection", socket => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
  const parent = resolve(root, ".repopilot");
  await mkdir(parent, { recursive: true });
  const fixture = await mkdtemp(join(parent, "proxy-test-"));
  try {
    await new Promise<void>(done => upstream.listen(0, "127.0.0.1", done));
    const target = upstream.address();
    assert.ok(target && typeof target !== "string");
    proxy.on("connect", (_request, client, head) => {
      tunnels++;
      const remote = connect(target.port, "127.0.0.1", () => {
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length) remote.write(head);
        client.pipe(remote);
        remote.pipe(client);
      });
      remote.on("error", () => client.destroy());
      client.on("error", () => remote.destroy());
      client.on("close", () => remote.destroy());
    });
    await new Promise<void>(done => proxy.listen(0, "127.0.0.1", done));
    const proxyAddress = proxy.address();
    assert.ok(proxyAddress && typeof proxyAddress !== "string");
    const proxyUrl = `http://127.0.0.1:${proxyAddress.port}`;
    await mkdir(join(fixture, "src"));
    await mkdir(join(fixture, "config"));
    for (const name of ["cli.ts", "pi.ts"]) await copyFile(join(root, "src", name), join(fixture, "src", name));
    await writeFile(join(fixture, "config/models.json"), JSON.stringify({ providers: { dashscope: {
      baseUrl: "http://repopilot-proxy-test.invalid/v1", api: "openai-completions", apiKey: "${DASHSCOPE_API_KEY}",
      compat: { supportsStore: false, supportsDeveloperRole: false, supportsReasoningEffort: false, maxTokensField: "max_tokens", thinkingFormat: "qwen" },
      models: [{ id: "qwen3.7-plus", reasoning: true }],
    } } }));
    const execution = promisify(execFile)(process.execPath, [join(fixture, "src/cli.ts"), command], {
      timeout: 20_000, windowsHide: true,
      env: { ...process.env, DASHSCOPE_API_KEY: fakeKey, PI_OFFLINE: "1", NODE_USE_ENV_PROXY: "0",
        HTTP_PROXY: proxyUrl, HTTPS_PROXY: proxyUrl, http_proxy: proxyUrl, https_proxy: proxyUrl, NO_PROXY: "", no_proxy: "", ALL_PROXY: "" },
    });
    execution.child.stdin?.end();
    const { stdout, stderr } = await execution;
    const resultJson = stdout;
    const result = JSON.parse(resultJson) as {
      status: string; httpStatus?: number;
      text?: { toolCalls: number; streamed: boolean };
      readTool?: { toolCalls: number; streamed: boolean };
    };
    if (command === "auth-check") {
      assert.equal(result.status, "accepted");
      assert.equal(result.httpStatus, 200);
      assert.equal(requests.length, 1);
    } else {
      assert.equal(result.status, "passed");
      assert.match(stderr, /检查记录：/);
      assert.deepEqual(JSON.parse(await readFile(join(fixture, ".repopilot/connection-check.json"), "utf8")), result);
      assert.equal(result.text?.toolCalls, 0);
      assert.equal(result.readTool?.toolCalls, 1);
      assert.equal(result.text?.streamed, true);
      assert.equal(result.readTool?.streamed, true);
      assert.equal(requests.length, 3);
    }
    for (const request of requests) {
      assert.equal(request.model, "qwen3.7-plus");
      assert.equal(request.stream, command === "smoke");
    }
    assert.ok(credentialMatches.length > 0 && credentialMatches.every(Boolean));
    assert.ok(tunnels > 0);
    assert.ok(!(stdout + stderr + resultJson).includes(fakeKey));
  } finally {
    for (const socket of sockets) socket.destroy();
    upstream.closeAllConnections();
    proxy.closeAllConnections();
    upstream.close();
    proxy.close();
    assert.equal(dirname(resolve(fixture)), parent);
    await rm(fixture, { recursive: true, force: true });
  }
}

test("CLI direct request uses the configured HTTP proxy", () => verifyProxy("auth-check"));
test("CLI SDK smoke uses the configured HTTP proxy for all three model requests", () => verifyProxy("smoke"));
