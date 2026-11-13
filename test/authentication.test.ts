import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { requestAuthentication, PiConnectionError } from "../src/pi.ts";
import { formatAuthenticationResult } from "../src/chat-doctor.ts";

const fakeKey = "sk-LOCAL_FAKE_AUTH_PROBE_ONLY";

test("authentication transport sends only the fixed payload and returns no generated or error content", async () => {
  const requests: unknown[] = [];
  let status = 200;
  let payload = JSON.stringify({ choices: [{ message: { role: "assistant", content: fakeKey } }] });
  const server = createServer(async (request, response) => {
    let body = ""; for await (const chunk of request) body += chunk;
    assert.equal(request.headers.authorization, `Bearer ${fakeKey}`);
    assert.equal(request.url, "/v1/chat/completions");
    requests.push(JSON.parse(body));
    response.writeHead(status, { "Content-Type": "application/json", Location: "/redirected" }); response.end(payload);
  });
  try {
    await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
    const address = server.address(); assert.ok(address && typeof address !== "string");
    const model = { id: "qwen3.7-plus", baseUrl: `http://127.0.0.1:${address.port}/v1` };
    const accepted = await requestAuthentication(model, fakeKey);
    assert.equal(accepted.status, "accepted");
    assert.deepEqual(requests[0], { model: model.id, messages: [{ role: "user", content: "Reply OK." }], max_tokens: 8, stream: false, enable_thinking: false });
    assert.ok(!JSON.stringify(accepted).includes(fakeKey));
    for (const [httpStatus, serviceCode, hint] of [[401, "invalid_api_key", /密钥/], [403, "access_denied", /权限/], [404, "model_not_found", /模型/], [429, "private-code", /限流|配额/], [503, "private-code", /服务/]] as const) {
      status = httpStatus; payload = JSON.stringify({ error: { code: serviceCode, message: fakeKey } });
      const result = await requestAuthentication(model, fakeKey);
      assert.equal(result.status, "rejected");
      assert.equal(result.httpStatus, httpStatus);
      assert.equal(result.serviceCode, serviceCode === "private-code" ? undefined : serviceCode);
      assert.match(formatAuthenticationResult(result), hint);
      assert.doesNotMatch(JSON.stringify(result) + formatAuthenticationResult(result), /sk-|private-code/);
    }
    for (const body of ["<html>private error</html>", "{}", JSON.stringify({ error: { message: fakeKey } }), "x".repeat(65537)]) {
      status = 200; payload = body;
      assert.equal((await requestAuthentication(model, fakeKey)).status, "invalid_response");
    }
    status = 302; payload = "";
    const count = requests.length;
    const redirect = await requestAuthentication(model, fakeKey);
    assert.equal(redirect.httpStatus, 302);
    assert.equal(requests.length, count + 1);
    assert.match(formatAuthenticationResult(redirect), /未跟随/);
  } finally { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); }
});

test("authentication rejects unsafe endpoints and pre-cancelled requests without fetching", async t => {
  const fetch = t.mock.method(globalThis, "fetch", async () => { assert.fail("must not fetch"); });
  for (const baseUrl of ["file:///private", "invalid-private-url", "https://u:p@example.test/v1", "https://example.test/v1?token=private", "https://example.test/v1#fragment", "https://example.test/v1\nprivate"]) {
    await assert.rejects(requestAuthentication({ id: "qwen3.7-plus", baseUrl }, fakeKey), (error: unknown) => error instanceof PiConnectionError && error.code === "AUTH_ENDPOINT_INVALID" && !error.message.includes("private"));
  }
  const controller = new AbortController(); controller.abort();
  await assert.rejects(requestAuthentication({ id: "qwen3.7-plus", baseUrl: "https://example.test/v1" }, fakeKey, controller.signal), { code: "OPERATION_CANCELLED" });
  assert.equal(fetch.mock.callCount(), 0);
});

test("authentication cancellation interrupts the HTTP body and hides raw transport failures", async t => {
  const model = { id: "qwen3.7-plus", baseUrl: "http://127.0.0.1/v1" };
  const fetch = t.mock.method(globalThis, "fetch", async (_url: unknown, options?: RequestInit) => {
    return new Response(new ReadableStream({ start(stream) {
      options!.signal!.addEventListener("abort", () => stream.error(new Error(`raw-private-${fakeKey}`)), { once: true });
    } }), { status: 200 });
  });
  const controller = new AbortController();
  const pending = requestAuthentication(model, fakeKey, controller.signal);
  await new Promise(resolve => setImmediate(resolve)); controller.abort();
  await assert.rejects(pending, { code: "OPERATION_CANCELLED" });
  fetch.mock.restore();
  t.mock.method(globalThis, "fetch", async () => { throw new Error(`raw-private-${fakeKey}`); });
  await assert.rejects(requestAuthentication(model, fakeKey), (error: unknown) => error instanceof PiConnectionError && error.code === "AUTH_REQUEST_FAILED" && !error.message.includes(fakeKey));
});

test("authentication timeout has a safe distinct result", async t => {
  t.mock.method(AbortSignal, "timeout", () => AbortSignal.abort(new DOMException("private-timeout", "TimeoutError")));
  t.mock.method(globalThis, "fetch", async (_url: unknown, options?: RequestInit) => { options!.signal!.throwIfAborted(); throw new Error("unexpected"); });
  await assert.rejects(requestAuthentication({ id: "qwen3.7-plus", baseUrl: "https://example.test/v1" }, fakeKey), { code: "AUTH_TIMEOUT" });
});
