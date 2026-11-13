import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { setTimeout } from "node:timers/promises";
import { stripTerminalSequences, TuiAltScreen, visibleWidth, type Terminal } from "@earendil-works/pi-tui";
import { runChatTui } from "../src/chat-tui.ts";
import type { createChat } from "../src/chat.ts";
import type { SessionSnapshot } from "../src/session-store.ts";

type SendOptions = { signal?: AbortSignal; onText?: (text: string) => void };

async function patchFixture(name = "candidate.diff") {
  const folder = await mkdtemp(join(tmpdir(), "repopilot-review-tui-"));
  const patch = "diff --git a/src/value.ts b/src/value.ts\n--- a/src/value.ts\n+++ b/src/value.ts\n@@ -1 +1 @@\n-export const value = 1;\n+export const value = 0;\n";
  const patchPath = join(folder, name);
  await writeFile(patchPath, patch);
  return { folder, patch, candidate: {
    attempt: 1, patchPath, candidateHash: createHash("sha256").update(patch).digest("hex"), proposalReport: join(folder, "proposal.json"),
  } };
}

class TestTerminal implements Terminal {
  columns = 92;
  rows = 24;
  kittyProtocolActive = false;
  output = "";
  stopped = false;
  input?: (data: string) => void;

  start(onInput: (data: string) => void) { this.input = onInput; }
  stop() { this.stopped = true; this.input = undefined; }
  async drainInput() {}
  write(data: string) { this.output += data; }
  moveBy() {}
  hideCursor() {}
  showCursor() {}
  clearLine() {}
  clearFromCursor() {}
  clearScreen() {}
  setTitle() {}
  setProgress() {}
  setProgramStatus() {}

  async until(condition: () => boolean) {
    for (let attempt = 0; attempt < 150 && !condition(); attempt++) await setTimeout(10);
    assert.ok(condition(), "Expected terminal state was not reached");
  }

  submit(text: string) {
    assert.ok(this.input);
    this.input(`\x1b[200~${text}\x1b[201~`);
    this.input("\r");
  }
}

test("only Shift+Enter adds a keyboard newline while Ctrl+J does nothing", async () => {
  const terminal = new TestTerminal();
  const requests: string[] = [];
  const running = runChatTui(undefined, { terminal, createChat: async () => ({
    taskId: null, reset() {}, async send(text) { requests.push(text); return "多行输入已收到"; },
  }) });
  try {
    await terminal.until(() => terminal.output.includes("就绪"));
    terminal.input?.("\x1b[200~第一行\x1b[201~");
    terminal.input?.("\n");
    terminal.input?.("\x1b[106;5u");
    terminal.input?.("\x1b[13;2u");
    terminal.input?.("\x1b[200~第二行\x1b[201~");
    assert.equal(requests.length, 0);
    terminal.input?.("\r");
    await terminal.until(() => terminal.output.includes("多行输入已收到"));
    assert.deepEqual(requests, ["第一行\n第二行"]);
  } finally { terminal.input?.("\x11"); await running; }
});

test("multiline bracketed paste preserves newline chunks with Ctrl+J disabled", async () => {
  const terminal = new TestTerminal();
  const requests: string[] = [];
  const running = runChatTui(undefined, { terminal, createChat: async () => ({
    taskId: null, reset() {}, async send(text) { requests.push(text); return "粘贴内容已收到"; },
  }) });
  try {
    await terminal.until(() => terminal.output.includes("就绪"));
    terminal.input?.("\x1b[200~");
    terminal.input?.("粘贴第一行");
    terminal.input?.("\n");
    terminal.input?.("粘贴第二行");
    terminal.input?.("\x1b[201~");
    terminal.input?.("\r");
    await terminal.until(() => terminal.output.includes("粘贴内容已收到"));
    assert.deepEqual(requests, ["粘贴第一行\n粘贴第二行"]);
  } finally { terminal.input?.("\x11"); await running; }
});

test("Ctrl+C leaves generation and the message choice intact while Ctrl+Q exits", async () => {
  const terminal = new TestTerminal();
  const finished = Promise.withResolvers<void>();
  let signal: AbortSignal | undefined;
  let requests = 0;
  let copies = 0;
  const running = runChatTui(undefined, { terminal, copyToClipboard: async () => { copies++; }, createChat: async () => ({
    taskId: null, reset() {}, async send(_text, _image, options?: SendOptions) {
      requests++; signal = options?.signal;
      await Promise.race([finished.promise, new Promise<void>(resolve => signal?.addEventListener("abort", () => resolve(), { once: true }))]);
      return "不应显示的退出回复";
    },
  }) });
  try {
    await terminal.until(() => terminal.output.includes("就绪"));
    terminal.input?.("\x03"); await setTimeout(20); assert.equal(terminal.stopped, false);
    terminal.submit("先生成回答"); await terminal.until(() => requests === 1);
    terminal.submit("准备排队的问题"); await terminal.until(() => terminal.output.includes("排队发送"));
    terminal.input?.("\x03"); await setTimeout(20);
    assert.equal(signal?.aborted, false); assert.equal(terminal.stopped, false); assert.equal(copies, 0);
    terminal.input?.("\r"); terminal.input?.("\x11");
    await terminal.until(() => terminal.stopped);
    assert.equal(signal?.aborted, true); assert.equal(requests, 1);
    assert.ok(!terminal.output.includes("不应显示的退出回复"));
  } finally {
    finished.resolve(); terminal.input?.("\x1b");
    if (terminal.input) terminal.submit("/exit");
    await running;
  }
});

for (const failure of [false, true]) {
  test(`Ctrl+C copies selected Chinese text without exiting, clipboard failure=${failure}`, async t => {
    const terminal = new TestTerminal();
    terminal.rows = 40;
    let viewport: TuiAltScreen | undefined;
    const start = TuiAltScreen.prototype.start;
    t.mock.method(TuiAltScreen.prototype, "start", function (this: TuiAltScreen) { viewport = this; start.call(this); });
    const copied: string[] = [];
    const text = "复制测试 CopyCheck";
    const running = runChatTui(undefined, { terminal, copyToClipboard: async value => {
      copied.push(value);
      if (failure) throw new Error("private-clipboard-error");
    }, createChat: async () => ({ taskId: null, reset() {}, async send() { return text; } }) });
    try {
      await terminal.until(() => terminal.output.includes("就绪"));
      terminal.submit("返回复制测试内容");
      await terminal.until(() => Boolean(viewport?.getScreenLines().some(line => stripTerminalSequences(line).includes(text))));
      const lines = viewport!.getScreenLines().map(stripTerminalSequences);
      const row = lines.findIndex(line => line.includes(text));
      const column = visibleWidth(lines[row].slice(0, lines[row].indexOf(text))) + 1;
      const end = column + visibleWidth(text) - 1;
      terminal.input?.(`\x1b[<0;${column};${row + 1}M`);
      terminal.input?.(`\x1b[<32;${end};${row + 1}M`);
      terminal.input?.(`\x1b[<0;${end};${row + 1}m`);
      assert.equal(copied.length, 0);
      terminal.input?.("\x03");
      await terminal.until(() => copied.length === 1);
      assert.deepEqual(copied, [text]); assert.equal(terminal.stopped, false);
      if (failure) {
        await terminal.until(() => terminal.output.includes("复制失败"));
        assert.ok(!terminal.output.includes("private-clipboard-error"));
      }
    } finally {
      terminal.input?.("\x1b");
      if (terminal.input) terminal.submit("/exit");
      await running;
    }
  });
}

test("status is local and preserves the conversation and pending image, including on invalid arguments", async () => {
  const terminal = new TestTerminal();
  terminal.rows = 40;
  const folder = await mkdtemp(join(tmpdir(), "repopilot-status-tui-"));
  const imagePath = join(folder, "status.png");
  await writeFile(imagePath, Buffer.from("89504e470d0a1a0a7465737420696d616765", "hex"));
  const requests: unknown[][] = [];
  let reads = 0;
  const running = runChatTui(undefined, { terminal, createChat: async () => ({
    taskId: "bound-status-task", reset() { assert.fail("status must not reset chat"); },
    snapshot() { assert.fail("status must not read the transcript"); },
    status() { reads++; return { model: "dashscope/qwen3.7-plus", endpoint: "https://example.test/v1", imageInput: true, taskId: "bound-status-task" }; },
    async send(...request) { requests.push(request); return `状态测试回答 ${requests.length}`; },
  }) });
  try {
    await terminal.until(() => terminal.output.includes("就绪"));
    terminal.submit("原对话");
    await terminal.until(() => terminal.output.includes("状态测试回答 1"));
    terminal.submit(`/image "${imagePath}"`);
    await terminal.until(() => terminal.output.includes("图片已就绪"));
    terminal.output = "";
    terminal.submit("/status extra");
    await terminal.until(() => terminal.output.includes("用法：/status"));
    assert.equal(reads, 0);
    terminal.submit("/status");
    await terminal.until(() => terminal.output.includes("当前会话状态"));
    assert.ok(terminal.output.includes("https://example.test/v1"));
    assert.ok(terminal.output.includes("bound-status-task"));
    assert.ok(terminal.output.includes("已加载，未验证鉴权"));
    assert.ok(!terminal.output.includes("正在发送问题和图片"));
    assert.equal(reads, 1);
    assert.equal(requests.length, 1);
    terminal.submit("继续附图提问");
    await terminal.until(() => terminal.output.includes("状态测试回答 2"));
    assert.equal(requests[1][0], "继续附图提问");
    assert.equal((requests[1][1] as { mimeType: string }).mimeType, "image/png");
  } finally {
    terminal.input?.("\x11"); await running;
    assert.equal(dirname(resolve(folder)), resolve(tmpdir())); await rm(folder, { recursive: true, force: true });
  }
});

test("status entered during generation stays a draft and failures hide raw details", async () => {
  const terminal = new TestTerminal();
  const finished = Promise.withResolvers<void>();
  let requests = 0;
  let reads = 0;
  const running = runChatTui(undefined, { terminal, createChat: async () => ({
    taskId: null, reset() {},
    status() { reads++; throw new Error("private-status-error"); },
    async send() { requests++; await finished.promise; return "生成完成"; },
  }) });
  try {
    await terminal.until(() => terminal.output.includes("就绪"));
    terminal.submit("先提问");
    await terminal.until(() => requests === 1);
    terminal.submit("/status");
    assert.equal(reads, 0);
    finished.resolve();
    await terminal.until(() => terminal.output.includes("生成完成"));
    terminal.input?.("\r");
    await terminal.until(() => terminal.output.includes("无法读取当前会话状态"));
    assert.equal(reads, 1);
    assert.equal(requests, 1);
    assert.ok(!terminal.output.includes("private-status-error"));
  } finally { finished.resolve(); terminal.input?.("\x11"); await running; }
});

test("offline doctor stays local and retains conversation and attachment through invalid input and read errors", async () => {
  const terminal = new TestTerminal();
  terminal.rows = 40;
  const folder = await mkdtemp(join(tmpdir(), "repopilot-doctor-tui-"));
  const imagePath = join(folder, "doctor.png");
  await writeFile(imagePath, Buffer.from("89504e470d0a1a0a7465737420696d616765", "hex"));
  const requests: unknown[][] = [];
  let reads = 0;
  const running = runChatTui(undefined, { terminal, createChat: async () => ({
    taskId: null, reset() { assert.fail("diagnosis must not reset chat"); },
    snapshot() { assert.fail("diagnosis must not inspect model history"); },
    async doctor(signal?: AbortSignal) {
      assert.ok(signal && !signal.aborted);
      if (++reads > 1) throw new Error("private-doctor-error");
      return { checks: [{ name: "模型配置", status: "ok" as const, message: "本地诊断证据" }] };
    },
    async send(...request) { requests.push(request); return `诊断后回答 ${requests.length}`; },
  }) });
  try {
    await terminal.until(() => terminal.output.includes("就绪"));
    terminal.submit("原会话问题");
    await terminal.until(() => terminal.output.includes("诊断后回答 1"));
    terminal.submit(`/image "${imagePath}"`);
    await terminal.until(() => terminal.output.includes("图片已就绪"));
    terminal.output = "";
    terminal.submit("/doctor extra");
    await terminal.until(() => terminal.output.includes("用法：/doctor"));
    assert.equal(reads, 0);
    terminal.submit("/doctor");
    await terminal.until(() => terminal.output.includes("本地诊断证据"));
    assert.ok(terminal.output.includes("未联网，未验证鉴权或模型可用性"));
    terminal.submit("/doctor");
    await terminal.until(() => terminal.output.includes("离线诊断未完成"));
    assert.ok(!terminal.output.includes("private-doctor-error"));
    assert.ok(!terminal.output.includes("正在发送问题和图片"));
    assert.equal(requests.length, 1);
    terminal.submit("诊断后继续附图");
    await terminal.until(() => terminal.output.includes("诊断后回答 2"));
    assert.equal((requests[1][1] as { mimeType: string }).mimeType, "image/png");
  } finally {
    terminal.input?.("\x11"); await running;
    assert.equal(dirname(resolve(folder)), resolve(tmpdir())); await rm(folder, { recursive: true, force: true });
  }
});

test("Escape cancels offline diagnosis and keeps the waiting draft without showing a late result", async () => {
  const terminal = new TestTerminal();
  const finish = Promise.withResolvers<void>();
  let signal: AbortSignal | undefined;
  const requests: string[] = [];
  const running = runChatTui(undefined, { terminal, createChat: async () => ({
    taskId: null, reset() {},
    async doctor(current?: AbortSignal) {
      signal = current; await finish.promise;
      return { checks: [{ name: "模型配置", status: "ok" as const, message: "LATE_DIAGNOSIS_RESULT" }] };
    },
    async send(text) { requests.push(text); return "继续当前对话"; },
  }) });
  try {
    await terminal.until(() => terminal.output.includes("就绪"));
    terminal.submit("/doctor");
    await terminal.until(() => Boolean(signal));
    terminal.submit("诊断时留下的草稿");
    terminal.input?.("\x1b");
    assert.equal(signal?.aborted, true);
    finish.resolve();
    await terminal.until(() => terminal.output.includes("已中断"));
    assert.ok(!terminal.output.includes("LATE_DIAGNOSIS_RESULT"));
    terminal.input?.("\r");
    await terminal.until(() => terminal.output.includes("继续当前对话"));
    assert.deepEqual(requests, ["诊断时留下的草稿"]);
  } finally { finish.resolve(); terminal.input?.("\x11"); await running; }
});

test("exit during diagnosis aborts the operation and suppresses late output", async () => {
  const terminal = new TestTerminal();
  const finish = Promise.withResolvers<void>();
  let signal: AbortSignal | undefined;
  const running = runChatTui(undefined, { terminal, createChat: async () => ({
    taskId: null, reset() {}, async send() { assert.fail("must stay local"); },
    async doctor(current?: AbortSignal) {
      signal = current; await finish.promise;
      return { checks: [{ name: "模型配置", status: "ok" as const, message: "LATE_EXIT_DIAGNOSIS" }] };
    },
  }) });
  try {
    await terminal.until(() => terminal.output.includes("就绪"));
    terminal.submit("/doctor");
    await terminal.until(() => Boolean(signal));
    terminal.input?.("\x11");
    finish.resolve();
    await running;
    assert.equal(signal?.aborted, true);
    assert.equal(terminal.stopped, true);
    assert.ok(!terminal.output.includes("LATE_EXIT_DIAGNOSIS"));
  } finally { finish.resolve(); terminal.input?.("\x11"); await running; }
});

test("authentication requires explicit confirmation and preserves conversation and pending attachment", async () => {
  const terminal = new TestTerminal(); terminal.rows = 45;
  const folder = await mkdtemp(join(tmpdir(), "repopilot-auth-tui-"));
  const imagePath = join(folder, "auth.png");
  await writeFile(imagePath, Buffer.from("89504e470d0a1a0a7465737420696d616765", "hex"));
  const requests: unknown[][] = [];
  let probes = 0;
  const running = runChatTui(undefined, { terminal, createChat: async () => ({
    taskId: null, reset() { assert.fail("must not reset"); },
    status() { return { model: "dashscope/qwen3.7-plus", endpoint: "https://example.test/v1", imageInput: true, taskId: null }; },
    async authCheck(signal?: AbortSignal) {
      assert.ok(signal && !signal.aborted); probes++;
      if (probes > 1) throw new Error("raw-private-auth-failure");
      return { kind: "direct_authentication_check" as const, model: "dashscope/qwen3.7-plus", status: "accepted" as const, httpStatus: 200, checkedAt: new Date().toISOString() };
    },
    async send(...request) { requests.push(request); return `联网检查后回答 ${requests.length}`; },
  }) });
  try {
    await terminal.until(() => terminal.output.includes("就绪"));
    terminal.submit("原对话"); await terminal.until(() => terminal.output.includes("联网检查后回答 1"));
    terminal.submit(`/image "${imagePath}"`); await terminal.until(() => terminal.output.includes("图片已就绪"));
    terminal.output = "";
    terminal.submit("/auth-check extra"); await terminal.until(() => terminal.output.includes("用法：/auth-check"));
    terminal.submit("/auth-check"); await terminal.until(() => terminal.output.includes("输入 yes 执行一次联网检查"));
    assert.ok(terminal.output.includes("Reply OK.") && terminal.output.includes("https://example.test/v1"));
    assert.ok(terminal.output.includes("可能产生少量费用")); assert.equal(probes, 0);
    terminal.submit("no"); await terminal.until(() => terminal.output.includes("未发送联网检查请求"));
    assert.equal(probes, 0);
    terminal.output = "";
    terminal.submit("/auth-check"); await terminal.until(() => terminal.output.includes("输入 yes 执行一次联网检查"));
    terminal.submit("yes"); await terminal.until(() => terminal.output.includes("HTTP 200"));
    assert.equal(probes, 1); assert.equal(requests.length, 1);
    assert.ok(!terminal.output.includes("正在发送问题和图片"));
    terminal.output = "";
    terminal.submit("/auth-check"); await terminal.until(() => terminal.output.includes("输入 yes 执行一次联网检查"));
    terminal.submit("yes"); await terminal.until(() => terminal.output.includes("联网检查未完成"));
    assert.ok(!terminal.output.includes("raw-private-auth-failure"));
    terminal.submit("保留图片继续问"); await terminal.until(() => terminal.output.includes("联网检查后回答 2"));
    assert.equal((requests[1][1] as { mimeType: string }).mimeType, "image/png");
  } finally {
    terminal.input?.("\x11"); await running;
    assert.equal(dirname(resolve(folder)), resolve(tmpdir())); await rm(folder, { recursive: true, force: true });
  }
});

test("Escape before authentication confirmation sends nothing and a cancelled request cannot display late results", async () => {
  const terminal = new TestTerminal();
  const finish = Promise.withResolvers<void>();
  let signal: AbortSignal | undefined;
  let probes = 0;
  const requests: string[] = [];
  const running = runChatTui(undefined, { terminal, createChat: async () => ({
    taskId: null, reset() {},
    status() { return { model: "dashscope/qwen3.7-plus", endpoint: "https://example.test/v1", imageInput: true, taskId: null }; },
    async authCheck(current?: AbortSignal) {
      probes++; signal = current; await finish.promise;
      return { kind: "direct_authentication_check" as const, model: "dashscope/qwen3.7-plus", status: "accepted" as const, httpStatus: 200, checkedAt: new Date().toISOString() };
    },
    async send(text) { requests.push(text); return "中断后继续对话"; },
  }) });
  try {
    await terminal.until(() => terminal.output.includes("就绪"));
    terminal.submit("/auth-check"); await terminal.until(() => terminal.output.includes("输入 yes 执行一次联网检查"));
    terminal.input?.("\x1b"); await terminal.until(() => terminal.output.includes("已中断"));
    assert.equal(probes, 0);
    terminal.output = "";
    terminal.submit("/auth-check"); await terminal.until(() => terminal.output.includes("输入 yes 执行一次联网检查"));
    terminal.submit("yes"); await terminal.until(() => Boolean(signal));
    terminal.submit("联网期间保留的草稿"); terminal.input?.("\x1b");
    assert.equal(signal?.aborted, true); finish.resolve();
    await terminal.until(() => terminal.output.includes("已中断"));
    assert.ok(!terminal.output.includes("HTTP 200"));
    terminal.input?.("\r"); await terminal.until(() => terminal.output.includes("中断后继续对话"));
    assert.deepEqual(requests, ["联网期间保留的草稿"]);
  } finally { finish.resolve(); terminal.input?.("\x11"); await running; }
});

test("exiting authentication confirmation or an active request cannot send or display a late result", async () => {
  for (const approve of [false, true]) {
    const terminal = new TestTerminal();
    const finish = Promise.withResolvers<void>();
    let signal: AbortSignal | undefined;
    let probes = 0;
    const running = runChatTui(undefined, { terminal, createChat: async () => ({
      taskId: null, reset() {}, async send() { assert.fail("must not send chat"); },
      status() { return { model: "dashscope/qwen3.7-plus", endpoint: "https://example.test/v1", imageInput: false, taskId: null }; },
      async authCheck(current?: AbortSignal) {
        probes++; signal = current; await finish.promise;
        return { kind: "direct_authentication_check" as const, model: "dashscope/qwen3.7-plus", status: "accepted" as const, httpStatus: 200, checkedAt: new Date().toISOString() };
      },
    }) });
    try {
      await terminal.until(() => terminal.output.includes("就绪"));
      terminal.submit("/auth-check"); await terminal.until(() => terminal.output.includes("输入 yes 执行一次联网检查"));
      if (approve) { terminal.submit("yes"); await terminal.until(() => Boolean(signal)); }
      terminal.input?.("\x11"); finish.resolve(); await running;
      assert.equal(probes, approve ? 1 : 0);
      if (approve) assert.equal(signal?.aborted, true);
      assert.ok(!terminal.output.includes("HTTP 200"));
      assert.equal(terminal.stopped, true);
    } finally { finish.resolve(); terminal.input?.("\x11"); await running; }
  }
});

test("loads quoted image paths, clears failed replacements, and keeps image data off-screen", async () => {
  const terminal = new TestTerminal();
  const folder = await mkdtemp(join(tmpdir(), "repopilot-tui-"));
  const imagePath = join(folder, "an image.png");
  const imageBytes = Buffer.from("89504e470d0a1a0a7465737420696d616765", "hex");
  await writeFile(imagePath, imageBytes);
  const requests: Parameters<Awaited<ReturnType<typeof createChat>>["send"]>[] = [];
  const running = runChatTui(undefined, {
    terminal,
    createChat: async () => ({
      taskId: null,
      reset() {},
      async send(...request) { requests.push(request); return "测试回复"; },
    }),
  });
  try {
    await terminal.until(() => terminal.output.includes("RepoPilot"));
    assert.ok(terminal.output.includes("欢迎使用 RepoPilot"));
    assert.ok(terminal.output.includes("我是你的 AI 编程助手"));
    assert.ok(!terminal.output.includes("按 Enter 开始对话"));
    assert.ok(terminal.output.includes("▀"));
    assert.equal(requests.length, 0);
    await terminal.until(() => terminal.output.includes("就绪"));
    terminal.submit(`/image "${imagePath}"`);
    await terminal.until(() => terminal.output.includes("图片已就绪"));
    terminal.submit("第一行\n第二行");
    await terminal.until(() => terminal.output.includes("测试回复"));
    assert.deepEqual(requests[0].slice(0, 2), ["第一行\n第二行", { type: "image", mimeType: "image/png", data: imageBytes.toString("base64") }]);
    terminal.output = "";
    terminal.submit(`/image '${imagePath}'`);
    await terminal.until(() => terminal.output.includes("图片已就绪"));
    terminal.submit("/image \"missing.png\"");
    await terminal.until(() => terminal.output.includes("无法读取图片文件"));
    terminal.submit("再问一次");
    await terminal.until(() => requests.length === 2);
    assert.deepEqual(requests[1].slice(0, 2), ["再问一次", undefined]);
    assert.ok(!terminal.output.includes(imageBytes.toString("base64")));
  } finally {
    terminal.input?.("\x11");
    await running;
    await rm(folder, { recursive: true, force: true });
  }
  assert.equal(terminal.stopped, true);
  assert.ok(terminal.output.includes("\x1b[?1049l"));
});

test("pasted image and question send image bytes and only the caption to chat", async () => {
  const terminal = new TestTerminal();
  const folder = await mkdtemp(join(tmpdir(), "repopilot-inline-tui-"));
  const imagePath = join(folder, "微信图片 an image.png");
  const bytes = Buffer.from("89504e470d0a1a0a7465737420696d616765", "hex");
  await writeFile(imagePath, bytes);
  const requests: unknown[][] = [];
  const running = runChatTui(undefined, { terminal, createChat: async () => ({
    taskId: null, reset() {}, async send(...request) { requests.push(request); return "直接附图回复"; },
  }) });
  try {
    await terminal.until(() => terminal.output.includes("就绪"));
    terminal.submit(`"${imagePath}"描述一下这张图片`);
    await terminal.until(() => terminal.output.includes("直接附图回复"));
    assert.deepEqual(requests[0].slice(0, 2), ["描述一下这张图片", { type: "image", mimeType: "image/png", data: bytes.toString("base64") }]);
    assert.ok(!terminal.output.includes(bytes.toString("base64")));
    terminal.submit("/image");
    await terminal.until(() => terminal.output.includes("当前没有待发送图片"));
  } finally { terminal.input?.("\x11"); await running; await rm(folder, { recursive: true, force: true }); }
});

test("pasted image alone queues locally and failed replacements cannot send the old attachment", async () => {
  const terminal = new TestTerminal();
  const folder = await mkdtemp(join(tmpdir(), "repopilot-inline-queue-"));
  const imagePath = join(folder, "queued.png");
  await writeFile(imagePath, Buffer.from("89504e470d0a1a0a7465737420696d616765", "hex"));
  const requests: unknown[][] = [];
  const running = runChatTui(undefined, { terminal, createChat: async () => ({
    taskId: null, reset() {}, async send(...request) { requests.push(request); return "替换失败后继续"; },
  }) });
  try {
    await terminal.until(() => terminal.output.includes("就绪"));
    terminal.submit(`"${imagePath}"`);
    await terminal.until(() => terminal.output.includes("图片已就绪"));
    assert.equal(requests.length, 0);
    terminal.submit(`"${join(folder, 'missing.png')}"解释图片`);
    await terminal.until(() => terminal.output.includes("无法读取图片文件"));
    assert.equal(requests.length, 0);
    terminal.submit("替换失败后的问题");
    await terminal.until(() => requests.length === 1);
    assert.deepEqual(requests[0].slice(0, 2), ["替换失败后的问题", undefined]);
  } finally { terminal.input?.("\x11"); await running; await rm(folder, { recursive: true, force: true }); }
});

test("pasted image loading can be cancelled without sending or attaching a late result", async () => {
  const terminal = new TestTerminal();
  const folder = await mkdtemp(join(tmpdir(), "repopilot-inline-cancel-"));
  const imagePath = join(folder, "cancel.png");
  await writeFile(imagePath, Buffer.from("89504e470d0a1a0a7465737420696d616765", "hex"));
  const requests: unknown[][] = [];
  const running = runChatTui(undefined, { terminal, createChat: async () => ({
    taskId: null, reset() {}, async send(...request) { requests.push(request); return "取消后重新提问"; },
  }) });
  try {
    await terminal.until(() => terminal.output.includes("就绪"));
    terminal.submit(`"${imagePath}"描述图片`);
    terminal.submit("保留下一条草稿");
    terminal.input?.("\x1b");
    await terminal.until(() => terminal.output.includes("已中断"));
    await setTimeout(40);
    assert.equal(requests.length, 0);
    terminal.input?.("\r");
    await terminal.until(() => requests.length === 1);
    assert.deepEqual(requests[0].slice(0, 2), ["保留下一条草稿", undefined]);
  } finally { terminal.input?.("\x11"); await running; await rm(folder, { recursive: true, force: true }); }
});

test("shows attachment details, inspects without removing it, and clears only the pending image", async () => {
  const terminal = new TestTerminal();
  const folder = await mkdtemp(join(tmpdir(), "repopilot-attachment-tui-"));
  const imagePath = join(folder, "an image.png");
  const bytes = Buffer.from("89504e470d0a1a0a7465737420696d616765", "hex");
  await writeFile(imagePath, bytes);
  const requests: unknown[][] = [];
  const running = runChatTui(undefined, { terminal, createChat: async () => ({
    taskId: null, reset() {}, async send(...request) { requests.push(request); return "附件测试回复"; },
  }) });
  try {
    await terminal.until(() => terminal.output.includes("就绪"));
    terminal.submit(`/image "${imagePath}"`);
    await terminal.until(() => terminal.output.includes("图片已就绪"));
    assert.ok(terminal.output.includes("an image.png"));
    assert.ok(terminal.output.includes("PNG"));
    assert.ok(terminal.output.includes(`${bytes.length} B`));
    terminal.output = "";
    terminal.submit("/image");
    await terminal.until(() => terminal.output.includes("an image.png"));
    assert.equal(requests.length, 0);
    terminal.submit("/help");
    await terminal.until(() => terminal.output.includes("/image clear"));
    terminal.submit("请看附件");
    await terminal.until(() => terminal.output.includes("附件测试回复"));
    assert.deepEqual(requests[0].slice(0, 2), ["请看附件", { type: "image", mimeType: "image/png", data: bytes.toString("base64") }]);
    terminal.output = "";
    terminal.submit(`/image "${imagePath}"`);
    await terminal.until(() => terminal.output.includes("图片已就绪"));
    terminal.submit("/image clear");
    await terminal.until(() => terminal.output.includes("待发送图片已移除"));
    terminal.output = "";
    terminal.submit("/image");
    await terminal.until(() => terminal.output.includes("当前没有待发送图片"));
    terminal.submit("继续文字对话");
    await terminal.until(() => requests.length === 2);
    assert.equal(requests[1][1], undefined);
  } finally {
    terminal.input?.("\x11"); await running; await rm(folder, { recursive: true, force: true });
  }
});

test("a failed or cancelled reply keeps the pending attachment available for manual retry", async () => {
  const terminal = new TestTerminal();
  const folder = await mkdtemp(join(tmpdir(), "repopilot-attachment-retry-"));
  const imagePath = join(folder, "retry.png");
  const bytes = Buffer.from("89504e470d0a1a0a7465737420696d616765", "hex");
  await writeFile(imagePath, bytes);
  const requests: unknown[][] = [];
  const running = runChatTui(undefined, { terminal, createChat: async () => ({
    taskId: null, reset() {}, async send(...request) {
      requests.push(request);
      if (requests.length === 1) throw new Error("Synthetic image reply failure");
      if (requests.length === 2) {
        const options = request[2] as SendOptions;
        await new Promise<void>(resolve => options.signal?.addEventListener("abort", () => resolve(), { once: true }));
      }
      return "重试完成";
    },
  }) });
  try {
    await terminal.until(() => terminal.output.includes("就绪"));
    terminal.submit(`/image "${imagePath}"`);
    await terminal.until(() => terminal.output.includes("图片已就绪"));
    terminal.submit("失败的一次");
    await terminal.until(() => terminal.output.includes("对话请求失败"));
    terminal.output = "";
    terminal.submit("/image");
    await terminal.until(() => terminal.output.includes("retry.png"));
    terminal.submit("中断的一次");
    await terminal.until(() => requests.length === 2);
    terminal.submit("/image clear");
    await terminal.until(() => terminal.output.includes("草稿已保留"));
    terminal.input?.("\x1b");
    await terminal.until(() => terminal.output.includes("已中断"));
    assert.equal(requests.length, 2);
    terminal.input?.("\r");
    await terminal.until(() => terminal.output.includes("待发送图片已移除"));
    terminal.submit("清除后继续");
    await terminal.until(() => requests.length === 3);
    assert.ok(requests[0][1] && requests[1][1]);
    assert.equal(requests[2][1], undefined);
  } finally {
    terminal.input?.("\x11"); await running; await rm(folder, { recursive: true, force: true });
  }
});

test("Escape during local image loading cannot attach a late image or lose the next draft", async () => {
  const terminal = new TestTerminal();
  const folder = await mkdtemp(join(tmpdir(), "repopilot-attachment-cancel-"));
  const imagePath = join(folder, "late.png");
  await writeFile(imagePath, Buffer.from("89504e470d0a1a0a7465737420696d616765", "hex"));
  const requests: unknown[][] = [];
  const running = runChatTui(undefined, { terminal, createChat: async () => ({
    taskId: null, reset() {}, async send(...request) { requests.push(request); return "取消加载后继续"; },
  }) });
  try {
    await terminal.until(() => terminal.output.includes("就绪"));
    terminal.submit(`/image "${imagePath}"`);
    terminal.submit("加载取消后保留的草稿");
    terminal.input?.("\x1b");
    await terminal.until(() => terminal.output.includes("已中断"));
    await setTimeout(40);
    assert.ok(!terminal.output.includes("图片已就绪"));
    terminal.input?.("\r");
    await terminal.until(() => requests.length === 1);
    assert.deepEqual(requests[0].slice(0, 2), ["加载取消后保留的草稿", undefined]);
    terminal.submit("/image");
    await terminal.until(() => terminal.output.includes("当前没有待发送图片"));
  } finally {
    terminal.input?.("\x11"); await running; await rm(folder, { recursive: true, force: true });
  }
});

test("invalid replacement commands clear the old attachment even when parsing or credential checks reject them", async () => {
  const terminal = new TestTerminal();
  const folder = await mkdtemp(join(tmpdir(), "repopilot-invalid-attachment-"));
  const path = join(folder, "safe.png");
  await writeFile(path, Buffer.from("89504e470d0a1a0a7465737420696d616765", "hex"));
  const requests: unknown[][] = [];
  const running = runChatTui(undefined, { terminal, createChat: async () => ({
    taskId: null, reset() {}, async send(...request) { requests.push(request); return "没有新附件的回答"; },
  }) });
  try {
    await terminal.until(() => terminal.output.includes("就绪"));
    for (const [index, replacement] of ["https://example.invalid/image.png", "'unclosed.png", "sk-LOCAL_FAKE_ATTACHMENT_ONLY"].entries()) {
      terminal.output = "";
      terminal.submit(`/image "${path}"`);
      await terminal.until(() => terminal.output.includes("图片已就绪"));
      terminal.submit(`/image ${replacement}`);
      await terminal.until(() => terminal.output.includes("当前没有待发送图片"));
      terminal.submit(`失败更换后提问 ${index}`);
      await terminal.until(() => requests.length === index + 1);
      assert.equal(requests[index][1], undefined);
      assert.ok(!terminal.output.includes("sk-LOCAL_FAKE_ATTACHMENT_ONLY"));
    }
  } finally {
    terminal.input?.("\x11"); await running; await rm(folder, { recursive: true, force: true });
  }
});

test("only explicit confirmation starts a task and exiting declines the pending patch review", async () => {
  const terminal = new TestTerminal();
  const finished = Promise.withResolvers<boolean>();
  const settle = Promise.withResolvers<void>();
  const fixture = await patchFixture();
  const sha = fixture.candidate.candidateHash;
  let exited = false;
  const running = runChatTui("task.json", {
    terminal,
    createChat: async options => ({
      taskId: "TEST-1",
      reset() {},
      async send() {
        if (await options?.confirmAction?.("repair") !== true) {
          finished.resolve(false);
          return "Declined";
        }
        const approved = await options?.review?.(fixture.candidate);
        finished.resolve(approved === true);
        await settle.promise;
        return "Done";
      },
    }),
  }).then(() => { exited = true; });
  try {
    await terminal.until(() => terminal.output.includes("TEST-1"));
    await terminal.until(() => terminal.output.includes("就绪"));
    terminal.submit("请修复");
    await terminal.until(() => terminal.output.includes("输入 yes"));
    assert.ok(!terminal.output.includes("candidate.diff"));
    terminal.submit("yes");
    await terminal.until(() => terminal.output.includes("candidate.diff"));
    assert.ok(terminal.output.includes(sha));
    terminal.input?.("\x11");
    await terminal.until(() => terminal.stopped);
    assert.equal(await finished.promise, false);
    assert.equal(exited, false);
  } finally {
    terminal.input?.("\x11");
    settle.resolve();
    await running;
    await rm(fixture.folder, { recursive: true, force: true });
  }
});

test("busy message choice queues follow-ups in order without overlapping requests", async () => {
  const terminal = new TestTerminal();
  const first = Promise.withResolvers<string>();
  const second = Promise.withResolvers<string>();
  const requests: string[] = [];
  let inFlight = 0;
  const running = runChatTui(undefined, { terminal, createChat: async () => ({
    taskId: null, reset() {}, async send(text) {
      assert.equal(inFlight++, 0); requests.push(text);
      try { return requests.length === 1 ? await first.promise : requests.length === 2 ? await second.promise : "第三条完成"; }
      finally { inFlight--; }
    },
  }) });
  try {
    await terminal.until(() => terminal.output.includes("就绪"));
    terminal.submit("第一条"); await terminal.until(() => requests.length === 1);
    terminal.submit("第二条"); await terminal.until(() => terminal.output.includes("排队发送"));
    assert.equal(requests.length, 1); terminal.input?.("\r");
    terminal.submit("第三条"); terminal.input?.("\r");
    assert.equal(requests.length, 1);
    terminal.input?.("\x1b[200~下一条还没提交的草稿\x1b[201~");
    first.resolve("第一条完成"); await terminal.until(() => requests.length === 2);
    assert.deepEqual(requests, ["第一条", "第二条"]);
    second.resolve("第二条完成"); await terminal.until(() => terminal.output.includes("第三条完成"));
    assert.deepEqual(requests, ["第一条", "第二条", "第三条"]);
    terminal.input?.("\r"); await terminal.until(() => requests.length === 4);
    assert.equal(requests[3], "下一条还没提交的草稿");
  } finally { first.resolve("结束"); second.resolve("结束"); terminal.input?.("\x11"); await running; }
});

test("busy message steering waits for cancellation and retains the original question and image", async () => {
  const terminal = new TestTerminal();
  const folder = await mkdtemp(join(tmpdir(), "repopilot-steer-"));
  const file = join(folder, "photo.png");
  const data = Buffer.from("89504e470d0a1a0a74657374", "hex"); await writeFile(file, data);
  const settled = Promise.withResolvers<void>();
  const requests: Array<{ text: string; image: unknown }> = [];
  let options: SendOptions | undefined;
  let cancelled = false;
  const running = runChatTui(undefined, { terminal, createChat: async () => ({
    taskId: null, reset() {}, async send(text, image, sendOptions?: SendOptions) {
      requests.push({text, image});
      if (requests.length > 1) return "按新要求回答";
      options = sendOptions; options?.onText?.("原回答的一部分");
      await new Promise<void>(resolve => options?.signal?.addEventListener("abort", () => { cancelled = true; resolve(); }, {once: true}));
      await settled.promise; return "迟到的旧回答";
    },
  }) });
  try {
    await terminal.until(() => terminal.output.includes("就绪"));
    terminal.submit(`/image "${file}"`); await terminal.until(() => terminal.output.includes("图片已就绪"));
    terminal.submit("解释图中的流程"); await terminal.until(() => requests.length === 1);
    terminal.submit("用初学者能理解的方式解释");
    terminal.input?.("\x1b[C"); terminal.input?.("\r");
    await terminal.until(() => cancelled); assert.equal(requests.length, 1);
    options?.onText?.("取消后迟到的片段");
    settled.resolve(); await terminal.until(() => terminal.output.includes("按新要求回答"));
    assert.match(requests[1].text, /解释图中的流程/);
    assert.match(requests[1].text, /用初学者能理解的方式解释/);
    assert.deepEqual(requests[1].image, requests[0].image);
    assert.ok(!terminal.output.includes("迟到的旧回答") && !terminal.output.includes("取消后迟到的片段"));
  } finally { settled.resolve(); terminal.input?.("\x11"); await running; await rm(folder, {recursive: true, force: true}); }
});

test("busy message choice Escape returns to editing without cancelling generation", async () => {
  const terminal = new TestTerminal();
  const finish = Promise.withResolvers<string>();
  const requests: string[] = [];
  let signal: AbortSignal | undefined;
  const running = runChatTui(undefined, {terminal, createChat: async () => ({
    taskId: null, reset() {}, async send(text, _image, options?: SendOptions) { requests.push(text); signal = options?.signal; return requests.length === 1 ? finish.promise : "草稿发送成功"; },
  })});
  try {
    await terminal.until(() => terminal.output.includes("就绪"));
    terminal.submit("原问题"); await terminal.until(() => requests.length === 1);
    terminal.submit("草稿第一行\n第二行"); await terminal.until(() => terminal.output.includes("排队发送"));
    terminal.input?.("\x1b"); assert.equal(signal?.aborted, false);
    finish.resolve("原回答完成"); await terminal.until(() => terminal.output.includes("原回答完成"));
    assert.equal(requests.length, 1); terminal.input?.("\r");
    await terminal.until(() => requests.length === 2); assert.equal(requests[1], "草稿第一行\n第二行");
  } finally { finish.resolve("结束"); terminal.input?.("\x11"); await running; }
});

test("busy message selection still requires confirmation if the current reply finishes first", async () => {
  const terminal = new TestTerminal();
  const finish = Promise.withResolvers<string>(); const requests: string[] = [];
  const running = runChatTui(undefined, {terminal, createChat: async () => ({
    taskId:null, reset(){}, async send(text){requests.push(text); return requests.length === 1 ? finish.promise : "确认后发送";},
  })});
  try {
    await terminal.until(() => terminal.output.includes("就绪"));
    terminal.submit("先回答"); await terminal.until(() => requests.length === 1);
    terminal.submit("稍后回答"); await terminal.until(() => terminal.output.includes("排队发送"));
    finish.resolve("先前回答结束"); await terminal.until(() => terminal.output.includes("先前回答结束"));
    assert.equal(requests.length,1); terminal.input?.("\r");
    await terminal.until(() => terminal.output.includes("确认后发送")); assert.deepEqual(requests,["先回答","稍后回答"]);
  } finally { finish.resolve("结束");terminal.input?.("\x11");await running; }
});

test("busy message queue pauses on Escape and can resume without losing waiting questions", async () => {
  const terminal = new TestTerminal(); const requests: string[] = [];
  const running = runChatTui(undefined, {terminal, createChat: async () => ({
    taskId:null, reset(){}, async send(text,_image,options?:SendOptions){
      requests.push(text); if(requests.length>1)return "队列恢复后完成";
      await new Promise<void>(resolve=>options?.signal?.addEventListener("abort",()=>resolve(),{once:true}));return "取消后的结尾";
    },
  })});
  try {
    await terminal.until(()=>terminal.output.includes("就绪"));
    terminal.submit("长回答");await terminal.until(()=>requests.length===1);
    terminal.submit("等待的问题");terminal.input?.("\r");terminal.input?.("\x1b");
    await terminal.until(()=>terminal.output.includes("已中断"));assert.equal(requests.length,1);
    terminal.submit("/queue");await terminal.until(()=>terminal.output.includes("等待的问题"));
    terminal.submit("/queue resume");await terminal.until(()=>terminal.output.includes("队列恢复后完成"));
    assert.deepEqual(requests,["长回答","等待的问题"]);
  }finally{terminal.input?.("\x11");await running;}
});

test("busy message queue pauses after a failure and clear prevents deferred requests", async () => {
  const terminal = new TestTerminal();const finish=Promise.withResolvers<string>();let requests=0;
  const running=runChatTui(undefined,{terminal,createChat:async()=>({taskId:null,reset(){},async send(){requests++;return finish.promise;}})});
  try{
    await terminal.until(()=>terminal.output.includes("就绪"));terminal.submit("会失败的请求");await terminal.until(()=>requests===1);
    terminal.submit("排队但暂不发送");terminal.input?.("\r");finish.reject(new Error("synthetic failure"));
    await terminal.until(()=>terminal.output.includes("对话请求失败"));assert.equal(requests,1);
    terminal.submit("/queue clear");terminal.submit("/queue resume");await setTimeout(30);assert.equal(requests,1);
  }finally{finish.resolve("结束");terminal.input?.("\x11");await running;}
});

test("busy message choice refuses credential and oversized input before adding to the queue", async () => {
  const terminal=new TestTerminal();const finish=Promise.withResolvers<string>();const requests:string[]=[];
  const running=runChatTui(undefined,{terminal,createChat:async()=>({taskId:null,reset(){},async send(text){requests.push(text);return finish.promise;}})});
  try{
    await terminal.until(()=>terminal.output.includes("就绪"));terminal.submit("原问题");await terminal.until(()=>requests.length===1);
    terminal.submit("sk-LOCAL_FAKE_QUEUE_TEST_ONLY");await terminal.until(()=>terminal.output.includes("疑似包含 API Key"));
    terminal.input?.("\x15");terminal.submit("x".repeat(8193));await terminal.until(()=>terminal.output.includes("8 KiB"));
    finish.resolve("原请求完成");await terminal.until(()=>terminal.output.includes("原请求完成"));assert.deepEqual(requests,["原问题"]);
  }finally{finish.resolve("结束");terminal.input?.("\x11");await running;}
});

test("busy message queue pauses when a queued image cannot be loaded", async () => {
  const terminal = new TestTerminal();
  const finish = Promise.withResolvers<string>();
  const requests: string[] = [];
  const missing = join(tmpdir(), `repopilot-queue-missing-${randomUUID()}.png`);
  const running = runChatTui(undefined, { terminal, createChat: async () => ({
    taskId: null, reset() {}, async send(text) { requests.push(text); return requests.length === 1 ? finish.promise : "后续回复"; },
  }) });
  try {
    await terminal.until(() => terminal.output.includes("就绪"));
    terminal.submit("当前问题"); await terminal.until(() => requests.length === 1);
    terminal.submit(`"${missing}"描述图片`); terminal.input?.("\r");
    terminal.submit("图片失败后应暂停的问题"); terminal.input?.("\r");
    finish.resolve("当前回复结束");
    await terminal.until(() => terminal.output.includes("无法读取图片文件"));
    await setTimeout(30); assert.equal(requests.length, 1);
    terminal.submit("/queue"); await terminal.until(() => terminal.output.includes("队列已暂停"));
    terminal.submit("/queue clear");
  } finally { finish.resolve("结束"); terminal.input?.("\x11"); await running; }
});

test("busy message steering keeps earlier queued messages for after the revised answer", async () => {
  const terminal = new TestTerminal();
  const requests: string[] = [];
  const running = runChatTui(undefined, { terminal, createChat: async () => ({
    taskId: null, reset() {}, async send(text, _image, options?: SendOptions) {
      requests.push(text);
      if (requests.length === 1) {
        await new Promise<void>(resolve => options?.signal?.addEventListener("abort", () => resolve(), { once: true }));
      }
      return `回答完成 ${requests.length}`;
    },
  }) });
  try {
    await terminal.until(() => terminal.output.includes("就绪"));
    terminal.submit("原问题"); await terminal.until(() => requests.length === 1);
    terminal.submit("等原问题结束后的另一个问题"); terminal.input?.("\r");
    terminal.submit("补充当前问题的要求"); terminal.input?.("\x1b[C"); terminal.input?.("\r");
    await terminal.until(() => terminal.output.includes("回答完成 3"));
    assert.match(requests[1], /原问题/);
    assert.match(requests[1], /补充当前问题的要求/);
    assert.equal(requests[2], "等原问题结束后的另一个问题");
  } finally { terminal.input?.("\x11"); await running; }
});

test("busy message steering can be cancelled again before the old request settles", async () => {
  const terminal = new TestTerminal();
  const settled = Promise.withResolvers<void>();
  const requests: string[] = [];
  let aborted = false;
  const running = runChatTui(undefined, { terminal, createChat: async () => ({
    taskId: null, reset() {}, async send(text, _image, options?: SendOptions) {
      requests.push(text);
      if (requests.length === 1) {
        await new Promise<void>(resolve => options?.signal?.addEventListener("abort", () => { aborted = true; resolve(); }, { once: true }));
        await settled.promise;
      }
      return "随后完成";
    },
  }) });
  try {
    await terminal.until(() => terminal.output.includes("就绪"));
    terminal.submit("原问题"); await terminal.until(() => requests.length === 1);
    terminal.submit("改为简短回答"); terminal.input?.("\x1b[C"); terminal.input?.("\r");
    await terminal.until(() => aborted);
    terminal.input?.("\x1b"); settled.resolve();
    await terminal.until(() => terminal.output.includes("已中断"));
    await setTimeout(30); assert.equal(requests.length, 1);
    terminal.input?.("\r"); await terminal.until(() => requests.length === 2);
    assert.equal(requests[1], "改为简短回答");
  } finally { settled.resolve(); terminal.input?.("\x11"); await running; }
});

test("busy message choice after completion can still guide using the original question", async () => {
  const terminal = new TestTerminal();
  const finish = Promise.withResolvers<string>();
  const requests: string[] = [];
  const running = runChatTui(undefined, { terminal, createChat: async () => ({
    taskId: null, reset() {}, async send(text) { requests.push(text); return requests.length === 1 ? finish.promise : "重新回答完成"; },
  }) });
  try {
    await terminal.until(() => terminal.output.includes("就绪"));
    terminal.submit("已经问过的问题"); await terminal.until(() => requests.length === 1);
    terminal.submit("请增加示例"); finish.resolve("首轮正常结束");
    await terminal.until(() => terminal.output.includes("首轮正常结束"));
    assert.equal(requests.length, 1);
    terminal.input?.("\x1b[C"); terminal.input?.("\r");
    await terminal.until(() => terminal.output.includes("重新回答完成"));
    assert.match(requests[1], /已经问过的问题/); assert.match(requests[1], /请增加示例/);
  } finally { finish.resolve("结束"); terminal.input?.("\x11"); await running; }
});

test("busy message exit drops the queue without starting a deferred request", async () => {
  const terminal = new TestTerminal();
  const finish = Promise.withResolvers<string>();
  const requests: string[] = [];
  const running = runChatTui(undefined, { terminal, createChat: async () => ({
    taskId: null, reset() {}, async send(text) { requests.push(text); return finish.promise; },
  }) });
  try {
    await terminal.until(() => terminal.output.includes("就绪"));
    terminal.submit("当前问题"); await terminal.until(() => requests.length === 1);
    terminal.submit("退出后不应发送的问题"); terminal.input?.("\r");
    terminal.input?.("\x11"); finish.resolve("退出后的旧结果"); await running;
    assert.equal(terminal.stopped, true); assert.deepEqual(requests, ["当前问题"]);
    assert.ok(!terminal.output.includes("退出后的旧结果"));
  } finally { finish.resolve("结束"); terminal.input?.("\x11"); await running; }
});

for (const outcome of ["reply", "error"] as const) {
  test(`keeps an editable draft after cancelling the busy choice before a model ${outcome}`, async () => {
    const terminal = new TestTerminal();
    const first = Promise.withResolvers<string>();
    const requests: string[] = [];
    const running = runChatTui(undefined, {
      terminal,
      createChat: async () => ({
        taskId: null, reset() {},
        async send(text) {
          requests.push(text);
          return requests.length === 1 ? first.promise : "第二条回复";
        },
      }),
    });
    try {
      await terminal.until(() => terminal.output.includes("就绪"));
      terminal.submit("第一条问题");
      await terminal.until(() => requests.length === 1);
      // A CR arriving in the middle of a bracketed paste must remain a newline.
      terminal.input?.("\x1b[200~");
      terminal.input?.("草稿第一行");
      terminal.input?.("\r");
      terminal.input?.("草稿第二行");
      terminal.input?.("\x1b[201~");
      terminal.input?.("\r");
      await terminal.until(() => terminal.output.includes("排队发送"));
      terminal.input?.("\x1b");
      await terminal.until(() => terminal.output.includes("草稿已保留"));
      assert.equal(requests.length, 1);
      terminal.input?.("\n");
      terminal.input?.("\x1b[13;2u");
      terminal.input?.("\x1b[200~补充内容\x1b[201~");
      terminal.input?.("\r");
      terminal.input?.("\x1b");
      if (outcome === "reply") first.resolve("第一条回复");
      else first.reject(new Error("Simulated request failure"));
      await terminal.until(() => terminal.output.includes(outcome === "reply" ? "第一条回复" : "对话请求失败"));
      assert.equal(requests.length, 1, "a retained draft is not automatically sent");
      terminal.input?.("\r");
      await terminal.until(() => requests.length === 2);
      assert.deepEqual(requests, ["第一条问题", "草稿第一行\n草稿第二行\n补充内容"]);
      await terminal.until(() => terminal.output.includes("第二条回复"));
      terminal.input?.("\r");
      assert.equal(requests.length, 2);
    } finally {
      first.resolve("第一条回复");
      terminal.input?.("\x11");
      await running;
    }
  });
}

test("restores a busy draft across action confirmation and candidate review", async () => {
  const terminal = new TestTerminal();
  const ready = Promise.withResolvers<void>();
  const requests: string[] = [];
  let actions = 0;
  const fixture = await patchFixture("draft-review.diff");
  const running = runChatTui("task.json", {
    terminal,
    createChat: async options => ({
      taskId: "TEST-1", reset() {},
      async send(text) {
        requests.push(text);
        if (requests.length === 1) {
          await ready.promise;
          if (await options?.confirmAction?.("repair")) {
            actions++;
            await options?.review?.(fixture.candidate);
          }
        }
        return "操作完成";
      },
    }),
  });
  try {
    await terminal.until(() => terminal.output.includes("就绪"));
    terminal.submit("请修复");
    await terminal.until(() => requests.length === 1);
    terminal.submit("审阅后再问的草稿");
    await terminal.until(() => terminal.output.includes("排队发送"));
    ready.resolve();
    await terminal.until(() => terminal.output.includes("对话请求执行修复流程"));
    terminal.submit("yes");
    await terminal.until(() => terminal.output.includes("draft-review.diff"));
    terminal.submit("no");
    await terminal.until(() => terminal.output.includes("操作完成"));
    assert.equal(actions, 1);
    assert.deepEqual(requests, ["请修复"]);
    terminal.input?.("\r");
    await terminal.until(() => requests.length === 2);
    assert.equal(requests[1], "审阅后再问的草稿");
  } finally {
    ready.resolve();
    terminal.input?.("\x11");
    await running;
    await rm(fixture.folder, { recursive: true, force: true });
  }
});

test("shows the complete candidate diff before accepting a review confirmation", async () => {
  const terminal = new TestTerminal();
  const fixture = await patchFixture();
  let reviewed: boolean | undefined;
  const running = runChatTui("task.json", {
    terminal,
    createChat: async options => ({
      taskId: "TEST-1", reset() {},
      async send() { reviewed = await options?.review?.(fixture.candidate); return "审阅结束"; },
    }),
  });
  try {
    await terminal.until(() => terminal.output.includes("就绪"));
    terminal.submit("请修复");
    await terminal.until(() => terminal.output.includes("输入 yes"));
    assert.equal(reviewed, undefined);
    assert.ok(terminal.output.includes("-export const value = 1;"));
    assert.ok(terminal.output.includes("+export const value = 0;"));
    assert.ok(terminal.output.includes("@@ -1 +1 @@"));
    terminal.submit("yes");
    await terminal.until(() => terminal.output.includes("审阅结束"));
    assert.equal(reviewed, true);
  } finally {
    terminal.input?.("\x11"); await running;
    await rm(fixture.folder, { recursive: true, force: true });
  }
});

test("rejects a changed candidate before allowing approval", async () => {
  const terminal = new TestTerminal();
  const fixture = await patchFixture();
  await writeFile(fixture.candidate.patchPath, fixture.patch + "+UNREVIEWED_CONTENT\n");
  let reviewed: boolean | undefined;
  const running = runChatTui("task.json", {
    terminal,
    createChat: async options => ({
      taskId: "TEST-1", reset() {},
      async send() { reviewed = await options?.review?.(fixture.candidate); return "任务停止"; },
    }),
  });
  try {
    await terminal.until(() => terminal.output.includes("就绪"));
    terminal.submit("请修复");
    await terminal.until(() => terminal.output.includes("任务停止"));
    assert.equal(reviewed, false);
    assert.ok(!terminal.output.includes("输入 yes"));
    assert.ok(!terminal.output.includes("UNREVIEWED_CONTENT"));
    assert.ok(terminal.output.includes("无法预览候选补丁"));
  } finally {
    terminal.input?.("\x11"); await running;
    await rm(fixture.folder, { recursive: true, force: true });
  }
});

test("does not open a late review after its request is cancelled during preview loading", async () => {
  const terminal = new TestTerminal();
  const fixture = await patchFixture();
  const requests: string[] = [];
  let reviewing: Promise<boolean> | undefined;
  const running = runChatTui("task.json", {
    terminal,
    createChat: async options => ({
      taskId: "TEST-1", reset() {},
      async send(text, _image, sendOptions?: SendOptions) {
        requests.push(text);
        if (requests.length === 1) {
          reviewing = options?.review?.(fixture.candidate);
          await new Promise<void>(resolve => sendOptions?.signal?.addEventListener("abort", () => resolve(), { once: true }));
        }
        return "新回答";
      },
    }),
  });
  try {
    await terminal.until(() => terminal.output.includes("就绪"));
    terminal.submit("请修复");
    terminal.submit("预览取消后保留的草稿");
    terminal.input?.("\x1b");
    terminal.input?.("\x1b");
    await terminal.until(() => terminal.output.includes("已中断"));
    await setTimeout(50);
    assert.ok(!terminal.output.includes("候选补丁 · 完整预览"));
    assert.ok(!terminal.output.includes("请先审阅补丁"));
    terminal.input?.("\r");
    await terminal.until(() => requests.length === 2);
    assert.equal(requests[1], "预览取消后保留的草稿");
  } finally {
    terminal.input?.("\x11"); await running; await reviewing;
    await rm(fixture.folder, { recursive: true, force: true });
  }
});

test("shows task stages without replacing approval prompts and ignores late stages", async () => {
  const terminal = new TestTerminal();
  const ready = Promise.withResolvers<void>();
  let reportStage: ((event: { stage: "baseline" | "localize" | "review" | "verify"; attempt?: number }) => void) | undefined;
  let approved: boolean | undefined;
  const running = runChatTui("task.json", {
    terminal,
    createChat: async options => {
      reportStage = options?.onProgress;
      return {
        taskId: "TEST-1", reset() {},
        async send() {
          options?.onProgress?.({ stage: "baseline", attempt: 1 });
          await ready.promise;
          approved = await options?.confirmAction?.("repair");
          return "本轮结束";
        },
      };
    },
  });
  try {
    await terminal.until(() => terminal.output.includes("就绪"));
    terminal.submit("请修复");
    await terminal.until(() => terminal.output.includes("第 1/3 轮 · 复现基准"));
    ready.resolve();
    await terminal.until(() => terminal.output.includes("输入 yes"));
    terminal.output = "";
    reportStage?.({ stage: "localize", attempt: 1 });
    await setTimeout(30);
    assert.ok(!terminal.output.includes("定位源码"));
    terminal.input?.("\x1b");
    await terminal.until(() => terminal.output.includes("已中断"));
    assert.equal(approved, false);
    terminal.output = "";
    reportStage?.({ stage: "verify", attempt: 2 });
    await setTimeout(30);
    assert.ok(!terminal.output.includes("独立验收"));
  } finally {
    ready.resolve(); terminal.input?.("\x11"); await running;
  }
});

test("accepts /exit while a model request is busy", async () => {
  const terminal = new TestTerminal();
  const reply = Promise.withResolvers<string>();
  let requests = 0;
  const running = runChatTui(undefined, {
    terminal,
    createChat: async () => ({
      taskId: null, reset() {},
      async send() { requests++; return reply.promise; },
    }),
  });
  try {
    await terminal.until(() => terminal.output.includes("就绪"));
    terminal.submit("等待回复");
    await terminal.until(() => requests === 1);
    terminal.submit("/exit");
    await terminal.until(() => terminal.stopped);
    assert.equal(requests, 1);
  } finally {
    reply.resolve("完成");
    terminal.input?.("\x11");
    await running;
  }
});

test("shows streamed text before the request finishes", async () => {
  const terminal = new TestTerminal();
  const finish = Promise.withResolvers<void>();
  let completed = false;
  const running = runChatTui(undefined, {
    terminal,
    createChat: async () => ({
      taskId: null, reset() {},
      async send(_text, _image, options?: SendOptions) {
        options?.onText?.("已经生成的第一段");
        await finish.promise;
        options?.onText?.("已经生成的第一段，以及后续回答");
        completed = true;
        return "已经生成的第一段，以及后续回答";
      },
    }),
  });
  try {
    await terminal.until(() => terminal.output.includes("就绪"));
    terminal.submit("分段回答");
    await terminal.until(() => terminal.output.includes("已经生成的第一段"));
    assert.equal(completed, false);
    finish.resolve();
    await terminal.until(() => terminal.output.includes("后续回答"));
    assert.equal(completed, true);
  } finally {
    finish.resolve();
    terminal.input?.("\x11");
    await running;
  }
});

test("Escape aborts generation, retains the partial reply and draft, and permits a new question", async () => {
  const terminal = new TestTerminal();
  const finish = Promise.withResolvers<void>();
  const requests: string[] = [];
  let aborted = false;
  let firstOptions: SendOptions | undefined;
  const running = runChatTui(undefined, {
    terminal,
    createChat: async () => ({
      taskId: null, reset() {},
      async send(text, _image, options?: SendOptions) {
        requests.push(text);
        if (requests.length > 1) return "新的回答";
        firstOptions = options;
        options?.onText?.("保留这段已生成的回答");
        await new Promise<void>(resolve => {
          const stop = () => { aborted = true; resolve(); };
          options?.signal?.addEventListener("abort", stop, { once: true });
          void finish.promise.then(resolve);
        });
        return "取消后不应显示的结尾";
      },
    }),
  });
  try {
    await terminal.until(() => terminal.output.includes("就绪"));
    terminal.submit("长回答");
    await terminal.until(() => terminal.output.includes("保留这段"));
    terminal.submit("停止后发送的草稿");
    await terminal.until(() => terminal.output.includes("排队发送"));
    terminal.input?.("\x1b");
    terminal.input?.("\x1b");
    await terminal.until(() => terminal.output.includes("已中断"));
    assert.equal(aborted, true);
    assert.equal(terminal.stopped, false);
    assert.ok(!terminal.output.includes("取消后不应显示的结尾"));
    firstOptions?.onText?.("取消后的延迟片段");
    await setTimeout(30);
    assert.ok(!terminal.output.includes("取消后的延迟片段"));
    terminal.input?.("\r");
    await terminal.until(() => terminal.output.includes("新的回答"));
    assert.deepEqual(requests, ["长回答", "停止后发送的草稿"]);
  } finally {
    finish.resolve();
    terminal.input?.("\x11");
    await running;
  }
});

test("Escape declines a pending action and restores the draft without exiting", async () => {
  const terminal = new TestTerminal();
  const ready = Promise.withResolvers<void>();
  const requests: string[] = [];
  let approved: boolean | undefined;
  let signal: AbortSignal | undefined;
  const running = runChatTui("task.json", {
    terminal,
    createChat: async options => ({
      taskId: "TEST-1", reset() {},
      async send(text, _image, sendOptions?: SendOptions) {
        requests.push(text);
        if (requests.length === 1) {
          signal = sendOptions?.signal;
          await ready.promise;
          approved = await options?.confirmAction?.("repair");
        }
        return "完成";
      },
    }),
  });
  try {
    await terminal.until(() => terminal.output.includes("就绪"));
    terminal.submit("请修复");
    await terminal.until(() => requests.length === 1);
    terminal.submit("审阅后发送的草稿");
    await terminal.until(() => terminal.output.includes("排队发送"));
    ready.resolve();
    await terminal.until(() => terminal.output.includes("输入 yes"));
    terminal.input?.("\x1b");
    await terminal.until(() => terminal.output.includes("已中断"));
    assert.equal(approved, false);
    assert.equal(signal?.aborted, true);
    assert.equal(terminal.stopped, false);
    terminal.input?.("\r");
    await terminal.until(() => requests.length === 2);
    assert.equal(requests[1], "审阅后发送的草稿");
  } finally {
    ready.resolve();
    terminal.input?.("\x11");
    await running;
  }
});

test("marks interrupted stream output as unfinished when the model fails", async () => {
  const terminal = new TestTerminal();
  const running = runChatTui(undefined, {
    terminal,
    createChat: async () => ({
      taskId: null, reset() {},
      async send(_text, _image, options?: SendOptions) {
        options?.onText?.("尚未生成完整的回答");
        throw new Error("Synthetic failure");
      },
    }),
  });
  try {
    await terminal.until(() => terminal.output.includes("就绪"));
    terminal.submit("请回答");
    await terminal.until(() => terminal.output.includes("未完成"));
    assert.ok(terminal.output.includes("尚未生成完整的回答"));
    assert.ok(terminal.output.includes("对话请求失败"));
  } finally {
    terminal.input?.("\x11");
    await running;
  }
});

for (const exit of ["ctrl+q", "/exit"]) {
  test(`${exit} aborts the pending model request before restoring the terminal`, async () => {
    const terminal = new TestTerminal();
    const finish = Promise.withResolvers<void>();
    let started = false;
    let aborted = false;
    const running = runChatTui(undefined, {
      terminal,
      createChat: async () => ({
        taskId: null, reset() {},
        async send(_text, _image, options?: SendOptions) {
          started = true;
          await new Promise<void>(resolve => {
            options?.signal?.addEventListener("abort", () => { aborted = true; resolve(); }, { once: true });
            void finish.promise.then(resolve);
          });
          return "不应显示的退出后回复";
        },
      }),
    });
    try {
      await terminal.until(() => terminal.output.includes("就绪"));
      terminal.submit("等待回答");
      await terminal.until(() => started);
      if (exit === "ctrl+q") terminal.input?.("\x11");
      else terminal.submit(exit);
      await terminal.until(() => terminal.stopped);
      assert.equal(aborted, true);
      assert.ok(!terminal.output.includes("不应显示的退出后回复"));
    } finally {
      finish.resolve();
      terminal.input?.("\x11");
      await running;
    }
  });
}

const savedSnapshot = (): SessionSnapshot => ({ task: null, turns: [{
  user: "保存的问题", assistant: "保存的回答", hadImage: true,
  reports: [{ status: "located", reportPath: "history-report.json" }],
}] });

async function sessionFixture() {
  const folder = await mkdtemp(join(tmpdir(), "repopilot-session-tui-"));
  const id = randomUUID();
  const snapshot = savedSnapshot();
  await writeFile(join(folder, `${id}.json`), JSON.stringify({ version: 1, id, createdAt: new Date().toISOString(), ...snapshot }));
  return { folder, id, snapshot };
}

test("saves and lists local sessions and restores text and report references after confirmation", async () => {
  const terminal = new TestTerminal();
  const folder = await mkdtemp(join(tmpdir(), "repopilot-session-save-tui-"));
  const imagePath = join(folder, "queued.png");
  await writeFile(imagePath, Buffer.from("89504e470d0a1a0a7465737420696d616765", "hex"));
  const requests: unknown[][] = [];
  let restored: SessionSnapshot | undefined;
  const running = runChatTui(undefined, { terminal, sessionDirectory: folder,
    createChat: async () => ({
      taskId: null, reset() {}, snapshot: savedSnapshot,
      async restore(snapshot: SessionSnapshot) { restored = snapshot; },
      async send(...request) { requests.push(request); return "继续后的回答"; },
    }),
  });
  try {
    await terminal.until(() => terminal.output.includes("就绪"));
    terminal.submit("/save");
    await terminal.until(() => terminal.output.includes("会话已保存"));
    const files = (await readdir(folder)).filter(name => name.endsWith(".json"));
    assert.equal(files.length, 1);
    const saved = JSON.parse(await readFile(join(folder, files[0]), "utf8"));
    assert.deepEqual(saved.turns, savedSnapshot().turns);
    terminal.submit("/sessions");
    await terminal.until(() => terminal.output.includes("本地会话"));
    assert.ok(terminal.output.includes(saved.id));
    assert.ok(terminal.output.includes("1 轮"));
    terminal.submit(`/image "${imagePath}"`);
    await terminal.until(() => terminal.output.includes("图片已就绪"));
    terminal.submit(`/resume ${saved.id}`);
    await terminal.until(() => terminal.output.includes("输入 yes 恢复"));
    assert.equal(restored, undefined);
    terminal.submit("yes");
    await terminal.until(() => terminal.output.includes("会话已恢复"));
    assert.deepEqual(restored, savedSnapshot());
    assert.ok(terminal.output.includes("保存的问题"));
    assert.ok(terminal.output.includes("保存的回答"));
    assert.ok(terminal.output.includes("历史工具结果"));
    assert.ok(terminal.output.includes("history-report.json"));
    assert.ok(terminal.output.includes("图片未恢复"));
    assert.equal(requests.length, 0, "session operations never call the model");
    terminal.submit("继续提问");
    await terminal.until(() => terminal.output.includes("继续后的回答"));
    assert.equal(requests[0][1], undefined, "successful resume clears the pending image");
  } finally {
    terminal.input?.("\x11"); await running; await rm(folder, { recursive: true, force: true });
  }
});

test("declining session restoration preserves the current conversation and the waiting draft", async () => {
  const terminal = new TestTerminal();
  const fixture = await sessionFixture();
  const requests: string[] = [];
  let restorations = 0;
  const running = runChatTui(undefined, { terminal, sessionDirectory: fixture.folder,
    createChat: async () => ({
      taskId: null, reset() {}, snapshot: savedSnapshot,
      async restore() { restorations++; },
      async send(text) { requests.push(text); return "原会话继续回答"; },
    }),
  });
  try {
    await terminal.until(() => terminal.output.includes("就绪"));
    terminal.submit(`/resume ${fixture.id}`);
    terminal.submit("拒绝后保留的草稿");
    await terminal.until(() => terminal.output.includes("输入 yes 恢复"));
    terminal.submit("no");
    await terminal.until(() => terminal.output.includes("未恢复会话"));
    assert.equal(restorations, 0);
    assert.ok(!terminal.output.includes("保存的问题"));
    terminal.input?.("\r");
    await terminal.until(() => terminal.output.includes("原会话继续回答"));
    assert.deepEqual(requests, ["拒绝后保留的草稿"]);
  } finally {
    terminal.input?.("\x11"); await running; await rm(fixture.folder, { recursive: true, force: true });
  }
});

test("invalid saved sessions never clear the current conversation or expose stored content", async () => {
  const terminal = new TestTerminal();
  const fixture = await sessionFixture();
  const marker = "sk-LOCAL_FAKE_BROKEN_SESSION_ONLY";
  await writeFile(join(fixture.folder, `${fixture.id}.json`), `{invalid: '${marker}'}`);
  let restorations = 0;
  let requests = 0;
  const running = runChatTui(undefined, { terminal, sessionDirectory: fixture.folder,
    createChat: async () => ({
      taskId: null, reset() {}, snapshot: savedSnapshot,
      async restore() { restorations++; },
      async send() { requests++; return "原会话仍可提问"; },
    }),
  });
  try {
    await terminal.until(() => terminal.output.includes("就绪"));
    terminal.submit(`/resume ${fixture.id}`);
    await terminal.until(() => terminal.output.includes("会话操作失败"));
    assert.equal(restorations, 0);
    assert.ok(!terminal.output.includes("输入 yes 恢复"));
    assert.ok(!terminal.output.includes(marker));
    terminal.submit("新问题");
    await terminal.until(() => terminal.output.includes("原会话仍可提问"));
    assert.equal(requests, 1);
  } finally {
    terminal.input?.("\x11"); await running; await rm(fixture.folder, { recursive: true, force: true });
  }
});

test("busy session commands remain drafts and save only after the completed turn", async () => {
  const terminal = new TestTerminal();
  const folder = await mkdtemp(join(tmpdir(), "repopilot-busy-session-tui-"));
  const finish = Promise.withResolvers<void>();
  let completed = false;
  let snapshots = 0;
  const running = runChatTui(undefined, { terminal, sessionDirectory: folder,
    createChat: async () => ({
      taskId: null, reset() {},
      snapshot() { snapshots++; assert.equal(completed, true); return savedSnapshot(); },
      async restore() {},
      async send() { await finish.promise; completed = true; return "完整的一轮回答"; },
    }),
  });
  try {
    await terminal.until(() => terminal.output.includes("就绪"));
    terminal.submit("先完成这一轮");
    terminal.submit("/save");
    await terminal.until(() => terminal.output.includes("草稿已保留"));
    assert.equal(snapshots, 0);
    assert.deepEqual(await readdir(folder), []);
    finish.resolve();
    await terminal.until(() => terminal.output.includes("完整的一轮回答"));
    terminal.input?.("\r");
    await terminal.until(() => terminal.output.includes("会话已保存"));
    assert.equal(snapshots, 1);
  } finally {
    finish.resolve(); terminal.input?.("\x11"); await running; await rm(folder, { recursive: true, force: true });
  }
});

test("cancelling a session load cannot open a late confirmation or replace the next draft", async () => {
  const terminal = new TestTerminal();
  const fixture = await sessionFixture();
  let restorations = 0;
  const requests: string[] = [];
  const running = runChatTui(undefined, { terminal, sessionDirectory: fixture.folder,
    createChat: async () => ({
      taskId: null, reset() {}, snapshot: savedSnapshot,
      async restore() { restorations++; },
      async send(text) { requests.push(text); return "取消后继续"; },
    }),
  });
  try {
    await terminal.until(() => terminal.output.includes("就绪"));
    terminal.submit(`/resume ${fixture.id}`);
    terminal.submit("取消加载后保留的草稿");
    terminal.input?.("\x1b");
    await terminal.until(() => terminal.output.includes("已中断"));
    await setTimeout(50);
    assert.equal(restorations, 0);
    assert.ok(!terminal.output.includes("输入 yes 恢复"));
    assert.ok(!terminal.output.includes("保存的问题"));
    terminal.input?.("\r");
    await terminal.until(() => terminal.output.includes("取消后继续"));
    assert.deepEqual(requests, ["取消加载后保留的草稿"]);
  } finally {
    terminal.input?.("\x11"); await running; await rm(fixture.folder, { recursive: true, force: true });
  }
});

test("a rejected restore leaves the waiting draft and current chat usable", async () => {
  const terminal = new TestTerminal();
  const fixture = await sessionFixture();
  const requests: string[] = [];
  const running = runChatTui(undefined, { terminal, sessionDirectory: fixture.folder,
    createChat: async () => ({
      taskId: null, reset() {}, snapshot: savedSnapshot,
      async restore() { throw new Error("Private task mismatch details"); },
      async send(text) { requests.push(text); return "原任务继续回答"; },
    }),
  });
  try {
    await terminal.until(() => terminal.output.includes("就绪"));
    terminal.submit(`/resume ${fixture.id}`);
    terminal.submit("恢复失败后保留的草稿");
    await terminal.until(() => terminal.output.includes("输入 yes 恢复"));
    terminal.submit("yes");
    await terminal.until(() => terminal.output.includes("会话操作失败"));
    assert.ok(!terminal.output.includes("Private task mismatch details"));
    assert.ok(!terminal.output.includes("保存的问题"));
    terminal.input?.("\r");
    await terminal.until(() => terminal.output.includes("原任务继续回答"));
    assert.deepEqual(requests, ["恢复失败后保留的草稿"]);
  } finally {
    terminal.input?.("\x11"); await running; await rm(fixture.folder, { recursive: true, force: true });
  }
});

test("Escape reaches a restore already in progress without replacing the conversation", async () => {
  const terminal = new TestTerminal();
  const fixture = await sessionFixture();
  let restoring = false;
  let restoreSignal: AbortSignal | undefined;
  let changed = false;
  const finish = Promise.withResolvers<void>();
  const requests: string[] = [];
  const running = runChatTui(undefined, { terminal, sessionDirectory: fixture.folder,
    createChat: async () => ({
      taskId: null, reset() {}, snapshot: savedSnapshot,
      async restore(_snapshot, signal) {
        restoring = true; restoreSignal = signal;
        await new Promise<void>(resolve => {
          signal?.addEventListener("abort", () => resolve(), { once: true });
          void finish.promise.then(resolve);
        });
        signal?.throwIfAborted();
        changed = true;
      },
      async send(text) { requests.push(text); return "取消恢复后继续"; },
    }),
  });
  try {
    await terminal.until(() => terminal.output.includes("就绪"));
    terminal.submit(`/resume ${fixture.id}`);
    await terminal.until(() => terminal.output.includes("输入 yes 恢复"));
    terminal.submit("yes");
    await terminal.until(() => restoring);
    terminal.submit("恢复中取消后保留的草稿");
    terminal.input?.("\x1b");
    await terminal.until(() => terminal.output.includes("已中断"));
    assert.equal(restoreSignal?.aborted, true);
    assert.equal(changed, false);
    assert.ok(!terminal.output.includes("保存的问题"));
    terminal.input?.("\r");
    await terminal.until(() => terminal.output.includes("取消恢复后继续"));
    assert.deepEqual(requests, ["恢复中取消后保留的草稿"]);
  } finally {
    finish.resolve(); terminal.input?.("\x11"); await running; await rm(fixture.folder, { recursive: true, force: true });
  }
});

test("saving an empty conversation asks for a completed turn without writing a session", async () => {
  const terminal = new TestTerminal();
  const folder = await mkdtemp(join(tmpdir(), "repopilot-empty-session-tui-"));
  let requests = 0;
  const running = runChatTui(undefined, { terminal, sessionDirectory: folder,
    createChat: async () => ({
      taskId: null, reset() {}, snapshot: () => ({ task: null, turns: [] }), async restore() {},
      async send() { requests++; return "可以继续聊天"; },
    }),
  });
  try {
    await terminal.until(() => terminal.output.includes("就绪"));
    terminal.submit("/save");
    await terminal.until(() => terminal.output.includes("请先完成一轮对话再保存"));
    assert.deepEqual(await readdir(folder), []);
    assert.equal(requests, 0);
    terminal.submit("开始聊天");
    await terminal.until(() => terminal.output.includes("可以继续聊天"));
    assert.equal(requests, 1);
  } finally {
    terminal.input?.("\x11"); await running; await rm(folder, { recursive: true, force: true });
  }
});

test("local session loading keeps the attachment visible without claiming that it is being sent", async t => {
  const terminal = new TestTerminal();
  const fixture = await sessionFixture();
  const imagePath = join(fixture.folder, "local-only.png");
  await writeFile(imagePath, Buffer.from("89504e470d0a1a0a7465737420696d616765", "hex"));
  const ready = Promise.withResolvers<void>();
  let loading = false;
  let requests = 0;
  const originalLstat = fsPromises.lstat;
  const delayed = t.mock.method(fsPromises, "lstat", async (path: Parameters<typeof fsPromises.lstat>[0]) => {
    if (String(path) === join(fixture.folder, `${fixture.id}.json`)) {
      loading = true;
      await ready.promise;
    }
    return originalLstat(path);
  });
  syncBuiltinESMExports();
  const running = runChatTui(undefined, { terminal, sessionDirectory: fixture.folder,
    createChat: async () => ({
      taskId: null, reset() {}, snapshot: savedSnapshot, async restore() {},
      async send() { requests++; return "Unused reply"; },
    }),
  });
  try {
    await terminal.until(() => terminal.output.includes("就绪"));
    terminal.submit(`/image "${imagePath}"`);
    await terminal.until(() => terminal.output.includes("图片已就绪"));
    terminal.output = "";
    terminal.submit(`/resume ${fixture.id}`);
    await terminal.until(() => loading);
    await setTimeout(35);
    assert.ok(!terminal.output.includes("正在发送问题和图片"));
    assert.equal(requests, 0);
    ready.resolve();
    await terminal.until(() => terminal.output.includes("输入 yes 恢复"));
    terminal.submit("no");
    await terminal.until(() => terminal.output.includes("当前对话和草稿已保留"));
    terminal.submit("/image");
    await terminal.until(() => terminal.output.includes("local-only.png"));
    assert.equal(requests, 0);
  } finally {
    ready.resolve(); terminal.input?.("\x11"); await running;
    delayed.mock.restore(); syncBuiltinESMExports();
    await rm(fixture.folder, { recursive: true, force: true });
  }
});

async function runFixture() {
  const folder = await mkdtemp(join(tmpdir(), "repopilot-run-tui-"));
  const id = "baseline-ABC123";
  const directory = join(folder, id);
  await mkdir(directory);
  const reportPath = join(directory, "report.json");
  const patchPath = join(directory, "patch.diff");
  await writeFile(patchPath, "--- a/src/value.ts\n+++ b/src/value.ts\n@@ -1 +1 @@\n-export const value = 1;\n+export const value = 0;\n");
  const checks = ["before-reproduce", "before-regression", "after-reproduce", "after-regression"].map((phase, index) => ({
    phase, script: "test:target", command: ["node", "--test"], logPath: join(directory, `${phase}.json`),
    exitCode: index === 0 ? 1 : 0, timedOut: false, interrupted: false, executionError: false,
    outputTruncated: false, durationMs: 5, stdoutBytes: 0, stderrBytes: 0,
    tests: [{ file: "test/value.test.ts", fullName: "value", status: index === 0 ? "failed" : "passed", assertionFailure: index === 0 }],
  }));
  await writeFile(reportPath, JSON.stringify({
    kind: "patch_verification", status: "resolved", taskId: "local-report-task", baseCommit: "a".repeat(40),
    candidateHash: "b".repeat(64),
    reason: "历史验收原因", startedAt: "2026-11-12T01:00:00.000Z", finishedAt: "2026-11-12T01:00:01.000Z",
    changedPaths: ["src/value.ts"], checks, integrity: { stable: true, replayVerified: true },
    artifacts: { baseline: join(directory, "baseline.json"), worktree: null, replayWorktree: null, inputPatch: null, patch: patchPath, logs: [] },
  }));
  return { folder, id, reportPath, patchPath };
}

test("local run list and detail preserve the conversation and pending image without model requests", async () => {
  const terminal = new TestTerminal();
  terminal.rows = 50;
  const fixture = await runFixture();
  const imagePath = join(fixture.folder, "run-view.png");
  await writeFile(imagePath, Buffer.from("89504e470d0a1a0a7465737420696d616765", "hex"));
  const requests: Parameters<Awaited<ReturnType<typeof createChat>>["send"]>[] = [];
  const running = runChatTui(undefined, { terminal, runsDirectory: fixture.folder,
    createChat: async () => ({
      taskId: "current-task", reset() { assert.fail("local history must not reset chat"); },
      snapshot() { assert.fail("local history must not inspect the model snapshot"); },
      async restore() { assert.fail("local history must not replace chat"); },
      async send(...request) { requests.push(request); return `当前会话回答 ${requests.length}`; },
    }),
  });
  try {
    await terminal.until(() => terminal.output.includes("就绪"));
    terminal.submit("先完成一轮");
    await terminal.until(() => terminal.output.includes("当前会话回答 1"));
    terminal.submit(`/image "${imagePath}"`);
    await terminal.until(() => terminal.output.includes("图片已就绪"));
    terminal.output = "";
    terminal.submit("/runs");
    await terminal.until(() => terminal.output.includes(fixture.id));
    terminal.submit(`/report ${fixture.id}`);
    await terminal.until(() => terminal.output.includes("历史验收原因"));
    assert.ok(terminal.output.includes("独立验收"));
    assert.ok(terminal.output.includes("修复前 · 复现测试：通过 0，失败 1，跳过 0"));
    assert.ok(terminal.output.includes("修复后 · 目标测试：通过 1，失败 0，跳过 0"));
    assert.ok(terminal.output.includes("历史验收通过"));
    assert.ok(terminal.output.includes("未重新执行"));
    assert.ok(terminal.output.includes("report.json"));
    assert.ok(terminal.output.includes("patch.diff"));
    assert.ok(!terminal.output.includes("正在发送问题和图片"));
    assert.equal(requests.length, 1);
    terminal.submit("接着看这张图片");
    await terminal.until(() => terminal.output.includes("当前会话回答 2"));
    assert.equal(requests[1][0], "接着看这张图片");
    assert.equal(requests[1][1]?.mimeType, "image/png");
  } finally {
    terminal.input?.("\x11"); await running; await rm(fixture.folder, { recursive: true, force: true });
  }
});

test("run history handles empty storage, bad syntax, unknown IDs, and corrupted reports safely", async () => {
  const terminal = new TestTerminal();
  const folder = await mkdtemp(join(tmpdir(), "repopilot-empty-run-tui-"));
  let requests = 0;
  const running = runChatTui(undefined, { terminal, runsDirectory: folder,
    createChat: async () => ({ taskId: null, reset() {}, async send() { requests++; return "不会调用"; } }),
  });
  try {
    await terminal.until(() => terminal.output.includes("就绪"));
    terminal.submit("/runs");
    await terminal.until(() => terminal.output.includes("暂无"));
    terminal.submit("/runs unexpected");
    await terminal.until(() => terminal.output.includes("用法"));
    terminal.submit("/report");
    await terminal.until(() => terminal.output.includes("用法"));
    terminal.output = "";
    terminal.submit("/report baseline-NO0000");
    await terminal.until(() => terminal.output.includes("运行记录操作失败"));
    await mkdir(join(folder, "baseline-BAD123"));
    await writeFile(join(folder, "baseline-BAD123", "report.json"), "{ private-report-content \u001b[31m");
    terminal.output = "";
    terminal.submit("/report baseline-BAD123");
    await terminal.until(() => terminal.output.includes("格式无效"));
    assert.ok(!terminal.output.includes("private-report-content"));
    assert.equal(requests, 0);
    terminal.submit("/help");
    await terminal.until(() => terminal.output.includes("/runs") && terminal.output.includes("/report"));
  } finally {
    terminal.input?.("\x11"); await running; await rm(folder, { recursive: true, force: true });
  }
});

test("a run command entered while busy stays a draft until the completed turn", async () => {
  const terminal = new TestTerminal();
  const fixture = await runFixture();
  const finish = Promise.withResolvers<void>();
  let requests = 0;
  const running = runChatTui(undefined, { terminal, runsDirectory: fixture.folder,
    createChat: async () => ({ taskId: null, reset() {}, async send() { requests++; await finish.promise; return "先前请求已完成"; } }),
  });
  try {
    await terminal.until(() => terminal.output.includes("就绪"));
    terminal.submit("处理当前问题");
    terminal.submit("/runs");
    await terminal.until(() => terminal.output.includes("草稿已保留"));
    assert.ok(!terminal.output.includes(fixture.id));
    finish.resolve();
    await terminal.until(() => terminal.output.includes("先前请求已完成"));
    assert.ok(!terminal.output.includes(fixture.id));
    terminal.input?.("\r");
    await terminal.until(() => terminal.output.includes(fixture.id));
    assert.equal(requests, 1);
  } finally {
    finish.resolve(); terminal.input?.("\x11"); await running; await rm(fixture.folder, { recursive: true, force: true });
  }
});

test("cancelling a slow local report suppresses late results and preserves the waiting draft", async t => {
  const terminal = new TestTerminal();
  const fixture = await runFixture();
  const finish = Promise.withResolvers<void>();
  let loading = false;
  const originalLstat = fsPromises.lstat;
  const delayed = t.mock.method(fsPromises, "lstat", async (path: Parameters<typeof fsPromises.lstat>[0]) => {
    if (String(path) === fixture.reportPath) { loading = true; await finish.promise; }
    return originalLstat(path);
  });
  syncBuiltinESMExports();
  const requests: string[] = [];
  const running = runChatTui(undefined, { terminal, runsDirectory: fixture.folder,
    createChat: async () => ({ taskId: null, reset() {}, async send(text) { requests.push(text); return "继续当前对话"; } }),
  });
  try {
    await terminal.until(() => terminal.output.includes("就绪"));
    terminal.submit(`/report ${fixture.id}`);
    await terminal.until(() => loading);
    terminal.submit("查看报告时留下的草稿");
    terminal.input?.("\x1b");
    finish.resolve();
    await terminal.until(() => terminal.output.includes("已中断"));
    assert.ok(!terminal.output.includes("历史验收原因"));
    terminal.input?.("\r");
    await terminal.until(() => terminal.output.includes("继续当前对话"));
    assert.deepEqual(requests, ["查看报告时留下的草稿"]);
  } finally {
    finish.resolve(); terminal.input?.("\x11"); await running;
    delayed.mock.restore(); syncBuiltinESMExports();
    await rm(fixture.folder, { recursive: true, force: true });
  }
});

test("closing during local report loading cannot display a late report", async t => {
  const terminal = new TestTerminal();
  const fixture = await runFixture();
  const finish = Promise.withResolvers<void>();
  let loading = false;
  const originalLstat = fsPromises.lstat;
  const delayed = t.mock.method(fsPromises, "lstat", async (path: Parameters<typeof fsPromises.lstat>[0]) => {
    if (String(path) === fixture.reportPath) { loading = true; await finish.promise; }
    return originalLstat(path);
  });
  syncBuiltinESMExports();
  const running = runChatTui(undefined, { terminal, runsDirectory: fixture.folder,
    createChat: async () => ({ taskId: null, reset() {}, async send() { assert.fail("must stay local"); } }),
  });
  try {
    await terminal.until(() => terminal.output.includes("就绪"));
    terminal.submit(`/report ${fixture.id}`);
    await terminal.until(() => loading);
    terminal.input?.("\x11");
    finish.resolve();
    await running;
    assert.equal(terminal.stopped, true);
    assert.ok(!terminal.output.includes("历史验收原因"));
  } finally {
    finish.resolve(); terminal.input?.("\x11"); await running;
    delayed.mock.restore(); syncBuiltinESMExports();
    await rm(fixture.folder, { recursive: true, force: true });
  }
});
