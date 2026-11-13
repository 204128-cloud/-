import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { setTimeout } from "node:timers/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { findGitExecutable } from "../src/git.ts";
import { PiConnectionError } from "../src/pi.ts";
import { executionEnvironment, runProcess } from "../src/process.ts";

const fakeKey = "sk-LOCAL_FAKE_CHAT_TEST_ONLY";
const imageData = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRk8AAAAASUVORK5CYII=";

type StreamReply = { chunks: string[]; afterChunk?: (index: number, response: ServerResponse) => Promise<void> };
type Reply = string | { toolNames: string[] } | StreamReply;
type Request = {
  messages: Array<{ role: string; content?: unknown; tool_call_id?: string }>;
  tools?: Array<{ function: { name: string } }>;
  tool_choice?: string;
};

async function withProvider(
  replies: Reply[],
  run: (modelsPath: string, requests: Request[], directory: string) => Promise<void>,
) {
  const requests: Request[] = [];
  const authorization: boolean[] = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    authorization.push(request.headers.authorization === `Bearer ${fakeKey}`);
    const reply = replies[requests.length] ?? "unexpected request";
    requests.push(JSON.parse(body) as Request);
    if ((requests.at(-1) as Request & { stream?: boolean }).stream === false) {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "OK" } }] }));
      return;
    }
    const delta = typeof reply === "string" ? { role: "assistant", content: reply } : "chunks" in reply ? {} : {
      role: "assistant",
      tool_calls: reply.toolNames.map((name, index) => ({
        index, id: `call_${index}`, type: "function", function: { name, arguments: "{}" },
      })),
    };
    const base = { id: "chat-test", object: "chat.completion.chunk", created: 1, model: "qwen3.7-plus" };
    const emit = (part: object, finish: string | null) =>
      `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: part, finish_reason: finish }] })}\n\n`;
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    if (typeof reply === "object" && "chunks" in reply) {
      for (const [index, content] of reply.chunks.entries()) {
        if (response.destroyed) return;
        response.write(emit({ role: "assistant", content }, null));
        await reply.afterChunk?.(index, response);
      }
      response.end(emit({}, "stop") + "data: [DONE]\n\n");
      return;
    }
    response.end(emit(delta, null) + emit({}, typeof reply === "string" ? "stop" : "tool_calls") + "data: [DONE]\n\n");
  });
  const temporaryRoot = resolve(tmpdir());
  const directory = await mkdtemp(join(temporaryRoot, "repopilot-chat-test-"));
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
      models: [{ id: "qwen3.7-plus", reasoning: true, input: ["text", "image"] }],
    } } }));
    await run(modelsPath, requests, directory);
    assert.ok(authorization.every(Boolean), "only the synthetic key belongs in the Authorization header");
  } finally {
    if (previousKey === undefined) delete process.env.DASHSCOPE_API_KEY;
    else process.env.DASHSCOPE_API_KEY = previousKey;
    server.closeAllConnections();
    server.close();
    assert.equal(dirname(resolve(directory)), temporaryRoot);
    await rm(directory, { recursive: true, force: true });
  }
}

async function writeTask(directory: string) {
  const taskFile = join(directory, "chat-private-task.json");
  const repoPath = join(directory, "chat-private-repository");
  await writeFile(taskFile, JSON.stringify({
    id: "chat-fixture", repoPath, baseCommit: "a".repeat(40), issue: "Return zero for empty input",
    reproduceScript: "test:reproduce", regressionScript: "test:regression",
    expectedFailure: "expected zero", allowedPaths: ["src/demo.ts"],
  }));
  return taskFile;
}

const conversation = (request: Request) => request.messages
  .filter(({ role }) => role === "user" || role === "assistant")
  .map(({ role, content }) => [role, content]);

async function until(condition: () => boolean) {
  for (let attempt = 0; attempt < 150 && !condition(); attempt++) await setTimeout(10);
  assert.ok(condition(), "Expected streaming state was not reached");
}

test("status uses the loaded chat configuration without network calls or conversation changes", async () => {
  await withProvider([], async (modelsPath, requests, directory) => {
    const { createChat } = await import("../src/chat.ts");
    const chat = await createChat({ modelsPath, taskFile: await writeTask(directory) });
    const before = chat.snapshot();
    const status = chat.status();
    assert.equal(status.model, "dashscope/qwen3.7-plus");
    assert.match(status.endpoint, /^http:\/\/127\.0\.0\.1:\d+\/v1$/);
    assert.equal(status.imageInput, true);
    assert.equal(status.taskId, "chat-fixture");
    status.model = "external mutation";
    await writeFile(modelsPath, "{}");
    delete process.env.DASHSCOPE_API_KEY;
    assert.equal(chat.status().model, "dashscope/qwen3.7-plus");
    assert.equal(chat.status().imageInput, true);
    assert.deepEqual(chat.snapshot(), before);
    assert.equal(requests.length, 0);
    assert.ok(!JSON.stringify(chat.status()).includes(fakeKey));
  });
});

test("offline doctor diagnoses configuration changes and invalid files without changing loaded chat or making requests", async () => {
  await withProvider([], async (modelsPath, requests) => {
    const { createChat } = await import("../src/chat.ts");
    const chat = await createChat({ modelsPath });
    const before = chat.snapshot();
    const loaded = chat.status();
    const original = await readFile(modelsPath, "utf8");
    const first = await chat.doctor();
    assert.equal(first.checks.find(check => check.name === "模型配置")?.status, "ok");
    assert.equal(first.checks.find(check => check.name === "进程凭据")?.status, "ok");
    assert.equal(first.checks.find(check => check.name === "绑定任务")?.status, "info");
    const changed = JSON.parse(original);
    changed.providers.dashscope.baseUrl = "https://changed.example.test/v1";
    await writeFile(modelsPath, JSON.stringify(changed));
    assert.equal((await chat.doctor()).checks[0].status, "warning");
    for (const text of ["{", "{}"]) {
      await writeFile(modelsPath, text);
      const result = await chat.doctor();
      assert.equal(result.checks[0].status, "error");
      assert.match(result.checks[0].message, /配置|模型/);
    }
    await rm(modelsPath);
    assert.equal((await chat.doctor()).checks[0].status, "error");
    assert.deepEqual(chat.status(), loaded);
    assert.deepEqual(chat.snapshot(), before);
    assert.equal(requests.length, 0);
    assert.ok(!JSON.stringify(first).includes(fakeKey));
  });
});

test("offline doctor distinguishes changed credentials and task files and respects cancellation", async () => {
  await withProvider([], async (modelsPath, requests, directory) => {
    const { createChat } = await import("../src/chat.ts");
    const taskFile = await writeTask(directory);
    const chat = await createChat({ modelsPath, taskFile });
    assert.equal((await chat.doctor()).checks.find(check => check.name === "绑定任务")?.status, "ok");
    for (const [key, status, message] of [
      [undefined, "error", /缺少/], ["masked-key", "error", /格式/],
      ["sk-sp-LOCAL_FAKE_PLAN_ONLY", "error", /套餐/], ["sk-LOCAL_FAKE_OTHER_CREDENTIAL", "warning", /不同/],
    ] as const) {
      if (key === undefined) delete process.env.DASHSCOPE_API_KEY; else process.env.DASHSCOPE_API_KEY = key;
      const result = await chat.doctor();
      const credential = result.checks.find(check => check.name === "进程凭据")!;
      assert.equal(credential.status, status);
      assert.match(credential.message, message);
      assert.ok(!JSON.stringify(result).includes(key ?? fakeKey));
    }
    await writeFile(taskFile, "changed-private-task-content");
    assert.equal((await chat.doctor()).checks.find(check => check.name === "绑定任务")?.status, "error");
    await rm(taskFile);
    assert.equal((await chat.doctor()).checks.find(check => check.name === "绑定任务")?.status, "error");
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(chat.doctor(controller.signal), (error: unknown) => error instanceof PiConnectionError && error.code === "CHAT_CANCELLED");
    const active = new AbortController();
    const pending = chat.doctor(active.signal);
    active.abort();
    await assert.rejects(pending, { code: "CHAT_CANCELLED" });
    assert.equal(requests.length, 0);
    assert.deepEqual(chat.snapshot().turns, []);
    assert.equal(chat.status().taskId, "chat-fixture");
  });
});

test("chat authentication uses its loaded endpoint and credential and excludes conversation and task data", async () => {
  await withProvider(["Original conversation", "unused probe slot", "Continued conversation"], async (modelsPath, requests, directory) => {
    const { createChat } = await import("../src/chat.ts");
    const chat = await createChat({ modelsPath, taskFile: await writeTask(directory) });
    await chat.send("Private conversation should not be a probe");
    const before = chat.snapshot();
    await writeFile(modelsPath, "{");
    process.env.DASHSCOPE_API_KEY = "sk-LOCAL_FAKE_OTHER_PROBE_KEY";
    const result = await chat.authCheck();
    assert.equal(result.status, "accepted");
    assert.deepEqual(requests[1], { model: "qwen3.7-plus", messages: [{ role: "user", content: "Reply OK." }], max_tokens: 8, stream: false, enable_thinking: false });
    assert.deepEqual(chat.snapshot(), before);
    assert.equal(await chat.send("Continue normally"), "Continued conversation");
    assert.ok(JSON.stringify(requests[2]).includes("Private conversation should not be a probe"));
    assert.ok(!JSON.stringify(requests[2]).includes("Reply OK."));
  });
});

test("streams safe cumulative text before the full reply completes", async () => {
  const resume = Promise.withResolvers<void>();
  await withProvider([{ chunks: ["第一段", "第二段"], afterChunk: async index => { if (index === 0) await resume.promise; } }], async modelsPath => {
    const { createChat } = await import("../src/chat.ts");
    const chat = await createChat({ modelsPath });
    const visible: string[] = [];
    let finished = false;
    const pending = chat.send("请回答", undefined, { onText: text => visible.push(text) }).finally(() => { finished = true; });
    try {
      await until(() => visible.includes("第一段"));
      assert.equal(finished, false);
      resume.resolve();
      assert.equal(await pending, "第一段第二段");
      assert.equal(visible.at(-1), "第一段第二段");
    } finally { resume.resolve(); await pending; }
  });
});

test("a pre-cancelled chat request never reaches the provider", async () => {
  await withProvider(["Unused"], async (modelsPath, requests) => {
    const { createChat } = await import("../src/chat.ts");
    const chat = await createChat({ modelsPath });
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(chat.send("Do not send", undefined, { signal: controller.signal }), { code: "CHAT_CANCELLED" });
    assert.equal(requests.length, 0);
  });
});

test("cancelling a stream closes the provider connection and excludes its partial turn from history", async () => {
  const resume = Promise.withResolvers<void>();
  let disconnected = false;
  await withProvider([{ chunks: ["未完成片段", "不要显示"], afterChunk: async (index, response) => {
    if (index === 0) { response.once("close", () => { disconnected = !response.writableFinished; }); await resume.promise; }
  } }, "新的完整回复"], async (modelsPath, requests) => {
    const { createChat } = await import("../src/chat.ts");
    const chat = await createChat({ modelsPath });
    const controller = new AbortController();
    const visible: string[] = [];
    const pending = chat.send("中断这条", undefined, { signal: controller.signal, onText: text => visible.push(text) });
    const rejected = assert.rejects(pending, { code: "CHAT_CANCELLED" });
    try {
      await until(() => visible.includes("未完成片段"));
      controller.abort();
      await rejected;
      assert.deepEqual(chat.snapshot().turns, []);
      await until(() => disconnected);
      assert.equal(await chat.send("重新提问"), "新的完整回复");
      assert.deepEqual(conversation(requests[1]), [["user", "重新提问"]]);
      assert.ok(visible.every(text => !text.includes("不要显示")));
    } finally { controller.abort(); resume.resolve(); await rejected; }
  });
});

for (const control of [false, true]) {
test(`blocks credentials split across streamed chunks${control ? " and control characters" : ""} before exposing their prefix`, async () => {
  await withProvider([{ chunks: [`安全内容 s${control ? "\x1b" : ""}`, "k-LOCAL_", "FAKE_CHAT_TEST_ONLY"] }], async modelsPath => {
    const { createChat } = await import("../src/chat.ts");
    const chat = await createChat({ modelsPath });
    const visible: string[] = [];
    await assert.rejects(chat.send("安全测试", undefined, { onText: text => visible.push(text) }), { code: "MODEL_CREDENTIAL_IN_CONTENT" });
    assert.ok(visible.includes("安全内容 "));
    assert.ok(visible.every(text => !text.includes("sk-") && !text.includes("LOCAL_")));
  });
});
}

test("cancelling while awaiting tool confirmation stops without a follow-up model request", async () => {
  await withProvider([{ toolNames: ["repair_task"] }, "新回复"], async (modelsPath, requests, directory) => {
    const { createChat } = await import("../src/chat.ts");
    const controller = new AbortController();
    const taskFile = await writeTask(directory);
    const chat = await createChat({ modelsPath, taskFile,
      confirmAction: async () => { controller.abort(); return new Promise<boolean>(() => {}); },
    });
    await assert.rejects(chat.send("开始修复", undefined, { signal: controller.signal }), { code: "CHAT_CANCELLED" });
    assert.equal(requests.length, 1);
    assert.equal(await chat.send("普通提问"), "新回复");
    assert.deepEqual(conversation(requests[1]), [["user", "普通提问"]]);
  });
});

test("cancelling a tool summary is not converted into a successful fallback reply", async () => {
  const resume = Promise.withResolvers<void>();
  await withProvider([{ toolNames: ["repair_task"] }, {
    chunks: ["工具总结片段", "后续内容"], afterChunk: async index => { if (index === 0) await resume.promise; },
  }, "完整的新回答"], async (modelsPath, requests, directory) => {
    const { createChat } = await import("../src/chat.ts");
    const chat = await createChat({ modelsPath, taskFile: await writeTask(directory), confirmAction: async () => false });
    const controller = new AbortController();
    const visible: string[] = [];
    const pending = chat.send("请求修复", undefined, { signal: controller.signal, onText: text => visible.push(text) });
    const rejected = assert.rejects(pending, { code: "CHAT_CANCELLED" });
    try {
      await until(() => visible.includes("工具总结片段"));
      controller.abort();
      await rejected;
      assert.equal(requests.length, 2);
      assert.equal(await chat.send("下一条问题"), "完整的新回答");
      assert.deepEqual(conversation(requests[2]), [["user", "下一条问题"]]);
    } finally { controller.abort(); resume.resolve(); await rejected; }
  });
});

test("streams normal text that ends with a possible credential prefix without losing characters", async () => {
  await withProvider([{ chunks: ["This i", "s"] }], async modelsPath => {
    const { createChat } = await import("../src/chat.ts");
    const chat = await createChat({ modelsPath });
    const visible: string[] = [];
    assert.equal(await chat.send("正常文字", undefined, { onText: text => visible.push(text) }), "This is");
    assert.equal(visible.at(-1), "This is");
  });
});

test("chat retains previous exchanges until reset", async () => {
  await withProvider(["First answer", "Second answer", "Fresh answer"], async (modelsPath, requests) => {
    const { createChat } = await import("../src/chat.ts");
    const chat = await createChat({ modelsPath });
    assert.equal(await chat.send("First question"), "First answer");
    assert.equal(await chat.send("Second question"), "Second answer");
    chat.reset();
    assert.equal(await chat.send("Fresh question"), "Fresh answer");
    assert.equal(requests.length, 3);
    assert.deepEqual(conversation(requests[1]), [
      ["user", "First question"], ["assistant", "First answer"], ["user", "Second question"],
    ]);
    assert.deepEqual(conversation(requests[2]), [["user", "Fresh question"]]);
    assert.deepEqual(requests[0].tools ?? [], []);
  });
});

test("completed text snapshots restore into a new chat without model or tool requests", async () => {
  await withProvider(["Remembered answer", "Follow-up answer"], async (modelsPath, requests) => {
    const { createChat } = await import("../src/chat.ts");
    const first = await createChat({ modelsPath });
    await first.send("Remember my question");
    const saved = first.snapshot();
    assert.deepEqual(saved, { task: null, turns: [{ user: "Remember my question", assistant: "Remembered answer", hadImage: false, reports: [] }] });
    const second = await createChat({ modelsPath });
    await second.restore(saved);
    assert.equal(requests.length, 1, "restore is local and does not replay any request");
    saved.turns[0].user = "Mutated external snapshot";
    assert.equal(second.snapshot().turns[0].user, "Remember my question");
    assert.equal(await second.send("Continue"), "Follow-up answer");
    assert.deepEqual(conversation(requests[1]), [
      ["user", "Remember my question"], ["assistant", "Remembered answer"], ["user", "Continue"],
    ]);
    second.reset();
    assert.deepEqual(second.snapshot(), { task: null, turns: [] });
  });
});

test("session text omits image bytes and restoring it does not resend the saved image", async () => {
  await withProvider(["The image is blue.", "I remember the description."], async (modelsPath, requests) => {
    const { createChat } = await import("../src/chat.ts");
    const chat = await createChat({ modelsPath });
    await chat.send("Describe this image", { type: "image", mimeType: "image/png", data: imageData });
    const saved = chat.snapshot();
    assert.equal(saved.turns[0].hadImage, true);
    assert.ok(!JSON.stringify(saved).includes(imageData));
    const restored = await createChat({ modelsPath });
    await restored.restore(saved);
    await restored.send("Continue from the description");
    assert.ok(!JSON.stringify(requests[1]).includes("data:image"));
    assert.ok(!JSON.stringify(requests[1]).includes(imageData));
    assert.ok(JSON.stringify(requests[1]).includes("image omitted"));
  });
});

test("restore requires the same bound task fingerprint and rejects unsafe history without replacing current turns", async () => {
  await withProvider(["Saved answer", "Current answer"], async (modelsPath, requests, directory) => {
    const { createChat } = await import("../src/chat.ts");
    const taskFile = await writeTask(directory);
    const bound = await createChat({ modelsPath, taskFile });
    await bound.send("Bound question");
    const saved = bound.snapshot();
    assert.equal(saved.task?.id, "chat-fixture");
    assert.match(saved.task!.sha256, /^[a-f0-9]{64}$/);
    const unbound = await createChat({ modelsPath });
    await unbound.send("Current question");
    await assert.rejects(unbound.restore(saved), { code: "CHAT_SESSION_TASK_MISMATCH" });
    assert.equal(unbound.snapshot().turns[0].user, "Current question");
    const unsafe = { task: null, turns: [{ user: "Old question", assistant: fakeKey, hadImage: false, reports: [] }] };
    await assert.rejects(unbound.restore(unsafe));
    assert.equal(unbound.snapshot().turns[0].user, "Current question");
    const other = await createChat({ modelsPath, taskFile });
    await other.restore(saved);
    assert.deepEqual(other.snapshot(), saved);
    await writeFile(taskFile, (await readFile(taskFile, "utf8")).replace("Return zero", "Return one"));
    await assert.rejects(other.restore(saved), { code: "CHAT_TASK_CHANGED" });
    assert.equal(requests.length, 2);
  });
});

test("snapshots keep the visible transcript while restored model context stays within eight turns", async () => {
  await withProvider(Array.from({ length: 12 }, (_, i) => `Answer ${i}`), async (modelsPath, requests) => {
    const { createChat } = await import("../src/chat.ts");
    const chat = await createChat({ modelsPath });
    for (let i = 0; i < 10; i++) await chat.send(`Question ${i}`);
    const saved = chat.snapshot();
    assert.equal(saved.turns.length, 10);
    const restored = await createChat({ modelsPath });
    await restored.restore(saved);
    await restored.send("Newest question");
    const messages = conversation(requests[10]);
    assert.equal(messages.length, 15);
    assert.deepEqual(messages[0], ["user", "Question 3"]);
    assert.equal(restored.snapshot().turns.length, 11);
  });
});

test("cancelling restore during bound task validation leaves the current conversation intact", async () => {
  await withProvider(["Older answer", "Current answer"], async (modelsPath, requests, directory) => {
    const { createChat } = await import("../src/chat.ts");
    const taskFile = await writeTask(directory);
    const older = await createChat({ modelsPath, taskFile });
    await older.send("Older question");
    const current = await createChat({ modelsPath, taskFile });
    await current.send("Current question");
    const before = current.snapshot();
    const controller = new AbortController();
    const pending = current.restore(older.snapshot(), controller.signal);
    controller.abort();
    await assert.rejects(pending, { code: "CHAT_CANCELLED" });
    assert.deepEqual(current.snapshot(), before);
    assert.equal(requests.length, 2);
  });
});

test("chat sends an attached PNG as Qwen image content", async () => {
  await withProvider(["Image answer"], async (modelsPath, requests) => {
    const { createChat } = await import("../src/chat.ts");
    const chat = await createChat({ modelsPath });
    assert.equal(await chat.send("Describe the image", { type: "image", mimeType: "image/png", data: imageData }), "Image answer");
    assert.equal(requests.length, 1);
    assert.deepEqual(conversation(requests[0]), [["user", [
      { type: "text", text: "Describe the image" },
      { type: "image_url", image_url: { url: `data:image/png;base64,${imageData}` } },
    ]]]);
  });
});

test("chat blocks the current credential in typed input and model replies", async () => {
  await withProvider([`Model echo ${fakeKey}`, "Safe answer"], async (modelsPath, requests) => {
    const { createChat } = await import("../src/chat.ts");
    const chat = await createChat({ modelsPath });
    const safeCredentialError = (error: unknown) => {
      assert.ok(error instanceof PiConnectionError);
      assert.equal(error.code, "MODEL_CREDENTIAL_IN_CONTENT");
      assert.equal(error.message.includes(fakeKey), false);
      assert.equal(error.stack?.includes(fakeKey), false);
      return true;
    };
    await assert.rejects(chat.send(`My credential is ${fakeKey}`), safeCredentialError);
    assert.equal(requests.length, 0);
    await assert.rejects(chat.send("Please answer"), safeCredentialError);
    assert.equal(await chat.send("Try another question"), "Safe answer");
    assert.equal(requests.length, 2);
    assert.equal(JSON.stringify(requests).includes(fakeKey), false);
  });
});

test("declining a bound repair returns a tool result without running the task or sending local paths", async () => {
  await withProvider([{ toolNames: ["repair_task"] }, "Repair declined"], async (modelsPath, requests, directory) => {
    const { createChat } = await import("../src/chat.ts");
    const taskFile = await writeTask(directory);
    const confirmations: string[] = [];
    const reports: string[] = [];
    const chat = await createChat({
      modelsPath, taskFile,
      confirmAction: async action => { confirmations.push(action); return false; },
      onReport: report => reports.push(report.status),
    });
    assert.equal(chat.taskId, "chat-fixture");
    assert.equal(await chat.send("Repair the fixed task"), "Repair declined");
    assert.deepEqual(confirmations, ["repair"]);
    assert.deepEqual(reports, []);
    assert.equal(requests.length, 2);
    assert.deepEqual(requests[0].tools?.map(tool => tool.function.name).sort(), ["locate_task", "repair_task"]);
    assert.equal(requests[1].tool_choice, "none");
    const result = requests[1].messages.find(message => message.role === "tool");
    assert.equal(result?.tool_call_id, "call_0");
    assert.equal(JSON.parse(String(result?.content)).status, "declined");
    assert.doesNotMatch(JSON.stringify(requests), /chat-private-(?:task|repository)/);
  });
});

test("chat refuses multiple task actions from a single model response", async () => {
  await withProvider([{ toolNames: ["locate_task", "repair_task"] }], async (modelsPath, requests, directory) => {
    const { createChat } = await import("../src/chat.ts");
    const taskFile = await writeTask(directory);
    const confirmations: string[] = [];
    const chat = await createChat({
      modelsPath, taskFile,
      confirmAction: async action => { confirmations.push(action); return false; },
    });
    await assert.rejects(chat.send("Inspect the fixed task"), { code: "CHAT_TOOL_INVALID" });
    assert.deepEqual(confirmations, []);
    assert.equal(requests.length, 1);
  });
});

test("chat stops an approved action when the bound task changes during confirmation", async () => {
  await withProvider([{ toolNames: ["locate_task"] }], async (modelsPath, requests, directory) => {
    const { createChat } = await import("../src/chat.ts");
    const taskFile = await writeTask(directory);
    const reports: string[] = [];
    const chat = await createChat({
      modelsPath, taskFile,
      confirmAction: async action => {
        assert.equal(action, "locate");
        const task = JSON.parse(await readFile(taskFile, "utf8"));
        await writeFile(taskFile, JSON.stringify({ ...task, issue: "Changed while awaiting confirmation" }));
        return true;
      },
      onReport: report => reports.push(report.status),
    });
    await assert.rejects(chat.send("Locate the fixed task"), { code: "CHAT_TASK_CHANGED" });
    assert.deepEqual(reports, []);
    assert.equal(requests.length, 1);
  });
});

test("confirmed locate reports progress and cancellation stops subsequent task phases", async () => {
  await withProvider([{ toolNames: ["locate_task"] }, "Localization complete", { toolNames: ["locate_task"] }], async (modelsPath, requests, directory) => {
    const { createChat } = await import("../src/chat.ts");
    const repoPath = join(directory, "chat-private-repository");
    await cp(fileURLToPath(new URL("../cases/pagination-empty/", import.meta.url)), repoPath, { recursive: true });
    const env = executionEnvironment();
    const gitExecutable = await findGitExecutable(env);
    assert.ok(gitExecutable, "Chat fixture requires Git");
    async function git(args: string[]) {
      const result = await runProcess(gitExecutable!, args, { cwd: repoPath, env, timeoutMs: 15_000, captureOutput: true });
      assert.equal(result.exitCode, 0, "Chat fixture Git command must succeed");
      return result.stdout.trim();
    }
    await git(["init", "--initial-branch=main"]);
    await git(["add", "."]);
    await git(["-c", "user.name=RepoPilot Test Fixture", "-c", "user.email=fixture@localhost",
      "-c", `core.hooksPath=${join(directory, "no-hooks")}`, "commit", "--quiet", "-m", "Chat fixture"]);
    const taskFile = join(directory, "chat-private-task.json");
    await writeFile(taskFile, JSON.stringify({
      id: "chat-pagination", repoPath, baseCommit: await git(["rev-parse", "HEAD"]),
      issue: "paginate should return zero pages for empty input", expectedFailure: "paginate returns zero pages for empty input",
      reproduceScript: "test:reproduce", regressionScript: "test:regression", allowedPaths: ["src/paginate.ts"],
    }));
    const reports: Array<{ status: string; reportPath: string }> = [];
    const progress: string[] = [];
    try {
      const chat = await createChat({
        modelsPath, taskFile,
        confirmAction: async action => action === "locate",
        onReport: report => reports.push(report),
        onProgress: event => progress.push(event.stage),
      });
      assert.equal(await chat.send("Locate the defect in the fixed task"), "Localization complete");
      assert.equal(requests.length, 2);
      assert.equal(reports.length, 1);
      assert.equal(reports[0].status, "located");
      assert.deepEqual(chat.snapshot().turns[0].reports, [{ status: "located", reportPath: reports[0].reportPath }]);
      assert.deepEqual(progress, ["baseline", "localize"]);
      const report = JSON.parse(await readFile(reports[0].reportPath, "utf8"));
      assert.equal(report.taskId, "chat-pagination");
      const result = requests[1].messages.find(message => message.role === "tool");
      assert.equal(result?.tool_call_id, "call_0");
      assert.deepEqual(JSON.parse(String(result?.content)), { status: "located", selectedPaths: ["src/paginate.ts"] });
      assert.doesNotMatch(JSON.stringify(requests), /chat-private-(?:task|repository)/);
      const controller = new AbortController();
      const cancelledProgress: string[] = [];
      const cancelledChat = await createChat({
        modelsPath, taskFile, confirmAction: async () => true,
        onReport: report => reports.push(report),
        onProgress: event => { cancelledProgress.push(event.stage); controller.abort(); },
      });
      await assert.rejects(cancelledChat.send("Locate again", undefined, { signal: controller.signal }), { code: "CHAT_CANCELLED" });
      assert.deepEqual(cancelledProgress, ["baseline"]);
      assert.equal(requests.length, 3, "a cancelled tool has no summary model request");
    } finally {
      for (const { reportPath } of reports) {
        const runDir = resolve(dirname(reportPath));
        assert.equal(dirname(runDir), resolve(fileURLToPath(new URL("../.repopilot/runs/", import.meta.url))));
        const report = JSON.parse(await readFile(reportPath, "utf8"));
        if (report.artifacts.worktree) {
          assert.equal(resolve(report.artifacts.worktree), join(runDir, "worktree"));
          await git(["worktree", "remove", "--force", report.artifacts.worktree]);
        }
        await rm(runDir, { recursive: true, force: true });
      }
    }
  });
});
