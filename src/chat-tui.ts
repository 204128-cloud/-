import {
  Container, Editor, getKeybindings, getTerminalColorMode, indexedColor, isKeyRelease, matchesKey, ProcessTerminal,
  ScrollView, styleText, Text, TruncatedText, TuiAltScreen, VStack, type Terminal,
} from "@earendil-works/pi-tui";
import { copyToClipboard } from "@earendil-works/pi-coding-agent";
import { ChatImageError, formatImageAttachment, loadChatAttachment, parseImageCommand, parseImageInput, type ChatAttachment } from "./chat-image.ts";
import { createChat } from "./chat.ts";
import { MODEL, PiConnectionError, type AuthenticationCheck } from "./pi.ts";
import { loadBrandHeader } from "./brand.ts";
import { loadPatchReview } from "./patch-review.ts";
import type { TaskProgress, TaskStage } from "./progress.ts";
import { listSessions, loadSession, saveSession, SessionError, type SessionSnapshot } from "./session-store.ts";
import { listRuns, loadRun, RunHistoryError } from "./run-history.ts";
import { formatRunDetail, formatRunList } from "./run-display.ts";
import { formatChatStatus, type ChatStatus } from "./chat-status.ts";
import { authenticationDisclosure, formatAuthenticationResult, formatChatDiagnosis, type ChatDiagnosis } from "./chat-doctor.ts";

const help = [
  "/image <本地路径>   为下一条问题附上 PNG、JPEG 或 WebP 图片，路径可加引号",
  "/image              查看待发送图片的文件名、格式和大小",
  "/image clear        移除待发送图片，不清除历史图片上下文",
  '也可直接输入 "本地图片路径" 问题；只输入路径则先附图，等待下一条问题',
  "/reset              清空对话和待发送图片",
  "/save               手动保存已完成的对话文字",
  "/sessions           列出本地已保存会话",
  "/resume <会话ID>    确认后恢复对话，不恢复图片或执行历史工具",
  "/runs               查看本地运行记录，不调用模型",
  "/report <运行ID>    查看历史报告摘要，不重新执行验收",
  "/status             离线查看当前会话已加载的模型与配置状态",
  "/doctor             离线检查当前配置、进程凭据与绑定任务",
  "/auth-check         确认后发送一次固定文本，联网检查鉴权",
  "/queue              查看待发送消息；/queue clear 清空；/queue resume 恢复发送",
  "生成中提交新问题：选择排队发送或引导当前回答；←/→ 选择，Enter 确认，Esc 返回编辑",
  "/help               显示对话命令",
  "/exit               退出对话",
  "Enter 发送 · Shift+Enter 换行 · Ctrl+C 复制已选文字 · Ctrl+Q 退出 · Esc 中断当前请求",
].join("\n");
const footer = "Ctrl+C 复制 · Ctrl+Q 退出 · Enter 发送 · Shift+Enter 换行 · PgUp/PgDn 滚动 · Esc 停止 · /help";
const blockedInput = "内容疑似包含 API Key，请移除密钥后重试。";
const credentialPattern = /\bsk-[A-Za-z0-9_-]{16,}\b/;
const controlPattern = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/;
const stageLabels: Record<TaskStage, string> = {
  baseline: "复现基准", localize: "定位源码", generate: "生成候选", review: "等待审阅",
  verify: "独立验收", "target-tests": "目标测试", "regression-tests": "回归测试", replay: "补丁回放",
};

type TuiChat = Pick<Awaited<ReturnType<typeof createChat>>, "taskId" | "reset" | "send"> & {
  status?: () => ChatStatus;
  doctor?: (signal?: AbortSignal) => Promise<ChatDiagnosis>;
  authCheck?: (signal?: AbortSignal) => Promise<AuthenticationCheck>;
  snapshot?: () => SessionSnapshot;
  restore?: (snapshot: SessionSnapshot, signal?: AbortSignal) => Promise<void>;
};
type ChatTuiDependencies = {
  terminal?: Terminal;
  createChat?: (options: Parameters<typeof createChat>[0]) => Promise<TuiChat>;
  sessionDirectory?: string;
  runsDirectory?: string;
  copyToClipboard?: typeof copyToClipboard;
};
type ChatTurn = { text: string; image?: ChatAttachment };
type WaitingMessage = { text: string; steer?: ChatTurn };

export async function runChatTui(taskFile?: string, dependencies: ChatTuiDependencies = {}): Promise<void> {
  if (!dependencies.terminal && (!process.stdin.isTTY || !process.stdout.isTTY)) {
    throw new PiConnectionError("TTY_REQUIRED", "请在交互式终端中运行 tui。");
  }
  const terminal = dependencies.terminal ?? new ProcessTerminal();
  const tui = new TuiAltScreen(terminal, true, undefined, {
    copyOnSelect: false,
    copySelection: async text => {
      if (hasCredential(text)) return "所选内容含疑似凭据，未复制。";
      try {
        await (dependencies.copyToClipboard ?? copyToClipboard)(text);
        return true;
      } catch { return "复制失败，请使用终端的复制操作。"; }
    },
    wheelScrollLines: "auto",
    scrollToEndIndicator: () => "↓ 最新消息",
  });
  const colorMode = getTerminalColorMode();
  const accent = indexedColor(14);
  const title = (text: string) => styleText(text, { fg: accent, bold: true }, colorMode);
  const muted = (text: string) => styleText(text, { dim: true }, colorMode);
  const key = process.env.DASHSCOPE_API_KEY?.trim();
  const escapedKey = key && JSON.stringify(key).slice(1, -1);
  const hasCredential = (text: string) => credentialPattern.test(text)
    || Boolean(key && text.includes(key)) || Boolean(escapedKey && text.includes(escapedKey));
  const safeText = (text: string) => {
    const cleaned = text.replace(/\r\n/g, "\n").replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
    return hasCredential(cleaned) ? "<REDACTED>" : cleaned;
  };
  const transcript = new Container();
  const view = new ScrollView(transcript, { follow: "end", primary: true });
  const status = new Text("", 1, 0);
  const messageChoice = new Text("", 1, 0);
  const maskedEditor = new TruncatedText(muted("[输入已隐藏]"));
  const editor = new class extends Editor {
    private receivingPaste = false;
    override handleInput(data: string) {
      const wasPasting = this.receivingPaste;
      if (data.includes("\x1b[200~")) this.receivingPaste = true;
      if (data.includes("\x1b[201~")) this.receivingPaste = false;
      if (!wasPasting && !this.receivingPaste && matchesKey(data, "ctrl+j")) return;
      const input = this.getExpandedText().trim();
      this.disableSubmit = busy && !approval && input !== "/exit" && !/^\/queue(?:\s|$)/.test(input)
        && (!currentTurn || request?.signal.aborted || input.startsWith("/"));
      if (this.disableSubmit && !isKeyRelease(data) && getKeybindings().matches(data, "tui.input.submit")) {
        showStatus("当前请求处理中，草稿已保留；完成后按 Enter 发送。");
      }
      super.handleInput(data);
    }
    override render(width: number) {
      const input = this.getExpandedText();
      return hasCredential(input) || controlPattern.test(input) ? maskedEditor.render(width) : super.render(width);
    }
  }(tui, {
    borderColor: muted,
    selectList: { selectedPrefix: title, selectedText: title, description: muted, scrollInfo: muted, noMatch: muted },
  }, { paddingX: 1 });

  const closed = Promise.withResolvers<void>();
  let exiting = false;
  let busy = false;
  let active: Promise<void> | undefined;
  let request: AbortController | undefined;
  let image: ChatAttachment | undefined;
  let progress: TaskProgress | undefined;
  let approval: { resolve: (approved: boolean) => void; prompt: string; draft: string } | undefined;
  let currentTurn: ChatTurn | undefined;
  let choice: { text: string; target: ChatTurn; selected: number } | undefined;
  const queue: WaitingMessage[] = [];
  let queuePaused = false;
  let pendingSteer: WaitingMessage | undefined;

  function showStatus(message?: string) {
    if (exiting) return;
    const stage = progress ? `${progress.attempt ? `第 ${progress.attempt}/3 轮 · ` : ""}${stageLabels[progress.stage]}` : "处理中…";
    const waiting = queue.length ? ` · 队列 ${queue.length} 条${queuePaused ? "（已暂停）" : ""}` : "";
    status.setText((message ?? approval?.prompt ?? (busy ? stage : image ? `待发送图片：${safeText(formatImageAttachment(image))}` : "就绪")) + waiting);
    tui.requestRender();
  }

  function append(label: string, message: string) {
    if (exiting) return;
    transcript.addChild(new Text(`${title(label)}\n${safeText(message)}\n `, 1, 0));
    tui.requestRender();
  }

  function ask(prompt: string): Promise<boolean> {
    if (exiting || request?.signal.aborted) return Promise.resolve(false);
    choice = undefined;
    const draft = editor.getExpandedText();
    editor.setText("");
    const { promise, resolve } = Promise.withResolvers<boolean>();
    approval = { resolve, prompt, draft };
    tui.scrollToBottom();
    showStatus();
    return promise;
  }

  function close() {
    if (exiting) return;
    exiting = true;
    request?.abort();
    approval?.resolve(false);
    approval = undefined;
    image = undefined;
    queue.length = 0;
    pendingSteer = undefined;
    choice = undefined;
    closed.resolve();
  }

  function cancelRequest() {
    if (!request) return;
    queuePaused = true;
    if (pendingSteer && !editor.getExpandedText()) editor.setText(pendingSteer.text);
    pendingSteer = undefined;
    request.abort();
    if (approval) {
      const { resolve, draft } = approval;
      approval = undefined;
      editor.setText(draft);
      resolve(false);
    }
    showStatus("正在中断当前请求…");
  }

  function guidedPrompt(original: string, guidance: string) {
    return `原问题：\n${original}\n\n补充要求：\n${guidance}\n\n请结合原问题，按补充要求重新回答。`;
  }

  function drawChoice() {
    if (!choice) return;
    const buttons = ["排队发送", "引导当前回答"].map((label, index) =>
      index === choice!.selected ? title(`[ ${label} ]`) : `[ ${label} ]`);
    messageChoice.setText(`${buttons.join("    ")}\n${busy ? "当前回答尚未结束" : "当前回答已结束"}，如何处理这条消息？\n←/→ 选择 · Enter 确认 · Esc 返回编辑`);
    tui.requestRender();
  }

  function offerMessage(text: string) {
    editor.setText(text);
    if (!currentTurn || request?.signal.aborted) { showStatus("当前请求处理中，草稿已保留。"); return; }
    if (hasCredential(text)) { showStatus(blockedInput); return; }
    if (controlPattern.test(text)) { showStatus("输入包含不支持的控制字符。"); return; }
    if (Buffer.byteLength(parseImageInput(text)?.prompt ?? text) > 8 * 1024) { showStatus("单条文字最多 8 KiB，草稿已保留。"); return; }
    choice = { text, target: currentTurn, selected: 0 };
    drawChoice();
  }

  function drainQueue() {
    if (exiting || busy || active || choice || approval) return;
    const next = pendingSteer ?? (!queuePaused ? queue.shift() : undefined);
    pendingSteer = undefined;
    if (next) startSubmission(next.text, next.steer);
  }

  function chooseMessage() {
    if (!choice) return;
    const { text, target, selected } = choice;
    if (selected === 1) {
      const guidance = parseImageInput(text)?.prompt ?? text;
      if (!guidance || Buffer.byteLength(guidedPrompt(target.text, guidance)) > 8 * 1024) {
        showStatus("请填写引导要求；原问题与补充要求合计最多 8 KiB。可返回编辑或选择排队发送。"); return;
      }
      pendingSteer = { text, steer: target };
      if (currentTurn === target) request?.abort();
    } else {
      queue.push({ text });
      queuePaused = false;
    }
    choice = undefined;
    editor.setText("");
    showStatus(selected === 1 ? "正在切换到引导回答…" : "消息已排队，当前回答结束后发送。");
    drainQueue();
  }

  const chat = await (dependencies.createChat ?? createChat)({
    taskFile,
    confirmAction: action => ask(`对话请求执行${action === "locate" ? "源码定位" : "修复流程"}。输入 yes 继续，其他输入拒绝。`),
    review: async candidate => {
      const generation = request;
      if (exiting || !generation || generation.signal.aborted) return false;
      try {
        const preview = await loadPatchReview(candidate, key);
        if (exiting || request !== generation || generation.signal.aborted) return false;
        const colored = safeText(preview).replaceAll("\t", "    ").split("\n").map(line => {
          const color = line.startsWith("+") ? 2 : line.startsWith("-") ? 1
            : line.startsWith("@@") || line.startsWith("diff --git") ? 14 : undefined;
          return color === undefined ? line : styleText(line, { fg: indexedColor(color) }, colorMode);
        }).join("\n");
        transcript.addChild(new Text(`${title("候选补丁 · 完整预览")}\n${colored}\n `, 1, 0));
        return ask("请先审阅补丁。输入 yes 独立验收，其他输入保留补丁并停止。");
      } catch (error) {
        if (exiting || request !== generation || generation.signal.aborted) return false;
        append("候选补丁", `无法预览候选补丁，未执行验收。${error instanceof PiConnectionError ? `\n${safeText(error.message)}` : ""}`);
        showStatus("无法预览候选补丁，已停止审阅。");
        return false;
      }
    },
    onProgress: event => {
      if (exiting || !busy || !request || request.signal.aborted || approval) return;
      progress = event;
      showStatus();
    },
    onReport: ({ status, reportPath, patchPath }) => append("工具结果",
      `状态：${status}\n报告：${reportPath}${patchPath ? `\n补丁：${patchPath}` : ""}`),
  });

  async function submit(text: string, steer?: ChatTurn) {
    if (exiting || !text) return;
    if (text === "/exit") { close(); return; }
    if (approval) {
      const { resolve, draft } = approval;
      approval = undefined;
      editor.setText(draft);
      showStatus();
      resolve(text.toLowerCase() === "yes");
      return;
    }
    if (/^\/queue(?:\s|$)/.test(text)) {
      if (text === "/queue") {
        append("待发送消息", queue.length ? `${queuePaused ? "队列已暂停，可用 /queue resume 恢复。\n" : ""}${queue.map((entry, index) => `${index + 1}. ${entry.text}`).join("\n")}` : "队列为空。");
      } else if (text === "/queue clear") { queue.length = 0; showStatus("待发送队列已清空。"); }
      else if (text === "/queue resume") { queuePaused = false; showStatus("已恢复队列发送。"); drainQueue(); }
      else showStatus("用法：/queue、/queue clear 或 /queue resume。");
      return;
    }
    if (busy) { offerMessage(text); return; }
    const imageCommand = /^\/image(?:\s|$)/.test(text);
    const inlineImage = parseImageInput(text);
    const sessionCommand = /^\/(?:save|sessions|resume)(?:\s|$)/.test(text);
    const historyCommand = /^\/(?:runs|report)(?:\s|$)/.test(text);
    const doctorCommand = /^\/doctor(?:\s|$)/.test(text);
    const authCommand = /^\/auth-check(?:\s|$)/.test(text);
    if (hasCredential(text)) {
      if (imageCommand || inlineImage) image = undefined;
      showStatus(blockedInput + (imageCommand || inlineImage ? "当前没有待发送图片。" : "")); return;
    }
    if (controlPattern.test(text)) {
      if (imageCommand || inlineImage) image = undefined;
      showStatus("输入包含不支持的控制字符。" + (imageCommand || inlineImage ? "当前没有待发送图片。" : "")); return;
    }
    if (text === "/help") { append("对话命令", help); tui.scrollToBottom(); return; }
    if (/^\/status(?:\s|$)/.test(text)) {
      if (text !== "/status") { showStatus("用法：/status（不需要参数）。"); return; }
      try {
        if (!chat.status) throw new Error();
        append("会话状态", formatChatStatus(chat.status()));
        tui.scrollToBottom();
      } catch { showStatus("无法读取当前会话状态。"); }
      return;
    }
    if (text === "/reset") {
      chat.reset();
      queue.length = 0;
      queuePaused = false;
      image = undefined;
      transcript.clear();
      transcript.addChild(brandBlock);
      tui.resetTextSelection();
      tui.scrollToBottom();
      showStatus("已清空对话和待发送图片。");
      return;
    }
    if (text.startsWith("/") && !imageCommand && !sessionCommand && !historyCommand && !doctorCommand && !authCommand) { showStatus("未知对话命令，请输入 /help。"); return; }

    busy = true;
    progress = undefined;
    showStatus(authCommand ? "等待联网检查确认…" : doctorCommand ? "正在进行离线诊断…" : inlineImage ? "正在读取图片…" : !imageCommand && !sessionCommand && !historyCommand && image ? "正在发送问题和图片…" : undefined);
    let message: string | undefined;
    let controller: AbortController | undefined;
    let replyComponent: Text | undefined;
    let partial = "";
    let loadingImage = false;
    let turn: ChatTurn | undefined;
    function displayReply(text: string, label = "RepoPilot") {
      if (exiting) return;
      partial = safeText(text);
      if (!partial) {
        if (replyComponent) transcript.removeChild(replyComponent);
        replyComponent = undefined;
      } else {
        const content = `${title(label)}\n${partial}\n `;
        if (replyComponent) replyComponent.setText(content);
        else {
          replyComponent = new Text(content, 1, 0);
          transcript.addChild(replyComponent);
        }
      }
      tui.requestRender();
    }
    try {
      if (authCommand) {
        if (text !== "/auth-check") { message = "用法：/auth-check（不需要参数）。"; return; }
        if (!chat.authCheck || !chat.status) throw new Error();
        const generation = new AbortController();
        controller = generation;
        request = generation;
        const checkCurrent = () => {
          if (exiting || request !== generation || generation.signal.aborted) {
            throw new PiConnectionError("CHAT_CANCELLED", "已中断当前请求，可以继续提问。");
          }
        };
        append("联网检查确认", authenticationDisclosure(chat.status()));
        const approved = await ask("输入 yes 执行一次联网检查，其他输入取消。");
        checkCurrent();
        if (!approved) { message = "未发送联网检查请求。"; return; }
        showStatus("正在联网检查，Esc 可中断…");
        const result = await chat.authCheck(generation.signal);
        checkCurrent();
        append("联网检查", formatAuthenticationResult(result));
        tui.scrollToBottom();
      } else if (doctorCommand) {
        if (text !== "/doctor") { message = "用法：/doctor（不需要参数）。"; return; }
        if (!chat.doctor) throw new Error();
        const generation = new AbortController();
        controller = generation;
        request = generation;
        const result = await chat.doctor(generation.signal);
        if (exiting || request !== generation || generation.signal.aborted) {
          throw new PiConnectionError("CHAT_CANCELLED", "已中断当前请求，可以继续提问。");
        }
        append("配置诊断", formatChatDiagnosis(result));
        tui.scrollToBottom();
      } else if (historyCommand) {
        const generation = new AbortController();
        controller = generation;
        request = generation;
        const storage = { directory: dependencies.runsDirectory, apiKey: key, signal: generation.signal };
        let output: string;
        if (text === "/runs") output = formatRunList(await listRuns(storage));
        else if (/^\/report\s+\S+$/.test(text)) output = formatRunDetail(await loadRun(text.slice("/report".length).trim(), storage));
        else { message = "用法：/runs 或 /report <运行ID>。"; return; }
        if (exiting || request !== generation || generation.signal.aborted) {
          throw new PiConnectionError("CHAT_CANCELLED", "已中断当前请求，可以继续提问。");
        }
        append("本地运行记录（历史引用）", output);
        tui.scrollToBottom();
      } else if (sessionCommand) {
        const generation = new AbortController();
        controller = generation;
        request = generation;
        const checkCurrent = () => {
          if (exiting || request !== generation || generation.signal.aborted) {
            throw new PiConnectionError("CHAT_CANCELLED", "已中断当前请求，可以继续提问。");
          }
        };
        const storage = { directory: dependencies.sessionDirectory, apiKey: key };
        if (text === "/save") {
          if (!chat.snapshot) throw new PiConnectionError("CHAT_SESSION_UNAVAILABLE", "当前聊天实例不支持会话保存。");
          const snapshot = chat.snapshot();
          if (!snapshot.turns.length) { message = "请先完成一轮对话再保存。"; return; }
          const saved = await saveSession(snapshot, storage);
          checkCurrent();
          append("会话已保存", `会话 ID：${saved.id}\n这是手动保存的快照，继续对话后可再次输入 /save。`);
          message = "会话已保存。";
        } else if (text === "/sessions") {
          const sessions = await listSessions(storage);
          checkCurrent();
          append("本地会话", sessions.length ? sessions.map(session =>
            `${session.id} · ${session.createdAt} · ${session.turns} 轮 · ${session.taskId ?? "未绑定任务"}`).join("\n")
            : "暂无已保存会话。输入 /save 手动保存已完成的对话。");
        } else if (/^\/resume\s+\S+$/.test(text)) {
          if (!chat.restore) throw new PiConnectionError("CHAT_SESSION_UNAVAILABLE", "当前聊天实例不支持会话恢复。");
          const saved = await loadSession(text.slice("/resume".length).trim(), storage);
          checkCurrent();
          const approved = await ask("将替换当前对话，不恢复图片，也不执行历史工具。输入 yes 恢复，其他输入保留当前对话。");
          checkCurrent();
          if (!approved) { message = "未恢复会话，当前对话和草稿已保留。"; return; }
          const snapshot = { task: saved.task, turns: saved.turns };
          await chat.restore(snapshot, generation.signal);
          checkCurrent();
          queue.length = 0;
          queuePaused = false;
          image = undefined;
          editor.setText("");
          transcript.clear();
          transcript.addChild(brandBlock);
          tui.resetTextSelection();
          for (const turn of snapshot.turns) {
            append(turn.hadImage ? "你 · 历史图片未恢复" : "你 · 历史", turn.user);
            append("RepoPilot · 历史", turn.assistant);
            for (const report of turn.reports) {
              append("历史工具结果（引用）", `状态：${report.status}\n报告：${report.reportPath}${report.patchPath ? `\n补丁：${report.patchPath}` : ""}`);
            }
          }
          append("会话已恢复", `会话 ID：${saved.id}\n仅恢复对话文字和历史报告引用；历史图片需要重新附加，工具不会自动执行。`);
          tui.scrollToBottom();
          message = "会话已恢复，可以继续提问。";
        } else {
          message = "用法：/save、/sessions 或 /resume <会话ID>。";
        }
      } else if (imageCommand) {
        const command = parseImageCommand(text);
        if (command.action === "show") {
          message = image ? `待发送图片：${safeText(formatImageAttachment(image))}。输入 /image clear 移除。` : "当前没有待发送图片。";
          return;
        }
        if (command.action === "clear") {
          message = image ? "待发送图片已移除。" : "当前没有待发送图片。";
          image = undefined;
          return;
        }
        image = undefined;
        const generation = new AbortController();
        controller = generation;
        request = generation;
        const loaded = await loadChatAttachment(command.path, key);
        if (exiting || request !== generation || generation.signal.aborted) {
          throw new PiConnectionError("CHAT_CANCELLED", "已中断当前请求，可以继续提问。");
        }
        image = loaded;
        message = `图片已就绪：${safeText(formatImageAttachment(image))}，将随下一条问题发送给模型服务。`;
      } else {
        const generation = new AbortController();
        controller = generation;
        request = generation;
        if (steer && !inlineImage) image = steer.image;
        if (inlineImage) {
          image = undefined;
          loadingImage = true;
          const loaded = await loadChatAttachment(inlineImage.path, key);
          if (exiting || request !== generation || generation.signal.aborted) {
            throw new PiConnectionError("CHAT_CANCELLED", "已中断当前请求，可以继续提问。");
          }
          image = loaded;
          loadingImage = false;
          if (!inlineImage.prompt) {
            message = `图片已就绪：${safeText(formatImageAttachment(image))}，将随下一条问题发送给模型服务。`;
            return;
          }
          text = inlineImage.prompt;
          showStatus("正在发送问题和图片…");
        }
        const displayText = text;
        if (steer) text = guidedPrompt(steer.text, text);
        turn = { text, image };
        currentTurn = turn;
        append(steer ? "你 · 引导" : image ? "你 · 附图片" : "你", displayText);
        tui.scrollToBottom();
        const reply = await chat.send(text, image?.image, {
          signal: generation.signal,
          onText: text => {
            if (!generation.signal.aborted) displayReply(text);
          },
        });
        if (generation.signal.aborted) throw new PiConnectionError("CHAT_CANCELLED", "已中断当前请求，可以继续提问。");
        image = undefined;
        displayReply(reply);
      }
    } catch (error) {
      if (!pendingSteer) queuePaused = true;
      const cancelled = controller?.signal.aborted || error instanceof PiConnectionError && error.code === "CHAT_CANCELLED";
      if (imageCommand || loadingImage) image = undefined;
      if (partial) displayReply(partial, cancelled ? "RepoPilot · 已中断" : "RepoPilot · 未完成");
      message = cancelled ? "已中断当前请求，可以继续提问。"
        : authCommand ? error instanceof PiConnectionError ? safeText(error.message) : "联网检查未完成，请检查网络和服务配置。"
        : doctorCommand ? "离线诊断未完成，请稍后重试或退出后运行 check。"
        : historyCommand ? `运行记录操作失败。${error instanceof RunHistoryError ? `\n${safeText(error.message)}` : ""}`
        : sessionCommand ? `会话操作失败。${error instanceof SessionError || error instanceof PiConnectionError ? `\n${safeText(error.message)}` : ""}`
        : error instanceof ChatImageError || error instanceof PiConnectionError
          ? safeText(error.message) + (imageCommand || loadingImage ? "当前没有待发送图片。" : "") : imageCommand || loadingImage ? "无法读取图片，当前没有待发送图片。" : "对话请求失败。";
    } finally {
      if (currentTurn === turn) currentTurn = undefined;
      if (request === controller) request = undefined;
      progress = undefined;
      busy = false;
      if (choice) drawChoice();
      showStatus(message);
    }
  }

  const brand = await loadBrandHeader({ model: MODEL, taskId: chat.taskId ? safeText(chat.taskId) : undefined });
  const brandBlock = {
    render: (width: number) => {
      const statusHeight = terminal.rows >= 4 ? Math.min(2, status.render(terminal.columns).length) : 0;
      const footerHeight = terminal.rows >= 7 ? 1 : 0;
      const attachmentHeight = image && terminal.rows >= 8 ? 1 : 0;
      const choiceHeight = choice ? Math.min(4, messageChoice.render(terminal.columns).length) : 0;
      const availableHeight = terminal.rows - editor.render(terminal.columns).length - statusHeight - footerHeight - attachmentHeight - choiceHeight;
      return brand.render(width, Math.max(0, availableHeight));
    },
    invalidate: () => brand.invalidate(),
  };
  transcript.addChild(brandBlock);
  const chatLayout = new VStack([
    { component: view, basis: 0, grow: 1 },
    { component: status, maxSize: 2, visible: ({ height }) => height >= 4 },
    { component: messageChoice, maxSize: 4, visible: () => Boolean(choice) },
    { component: { render: width => new TruncatedText(image ? `图片：${safeText(formatImageAttachment(image))} · /image clear 移除` : "", 1, 0).render(width),
      invalidate() {} }, basis: 1, shrink: 0, visible: ({ height }) => Boolean(image) && height >= 8 },
    { component: editor, shrink: 1, minSize: 1 },
    { component: new TruncatedText(muted(footer)), basis: 1, visible: ({ height }) => height >= 7 },
  ]);
  tui.setLayoutRoot(chatLayout);
  tui.setFocus(editor);
  function startSubmission(text: string, steer?: ChatTurn) {
    const submission = submit(text, steer).catch(() => showStatus("对话操作失败。"));
    if (!active && busy) {
      active = submission;
      void submission.then(() => { if (active === submission) active = undefined; drainQueue(); });
    }
  }
  editor.onSubmit = text => startSubmission(text);
  tui.addInputListener(data => {
    if (matchesKey(data, "ctrl+q")) {
      if (!isKeyRelease(data)) close();
      return { consume: true };
    }
    if (matchesKey(data, "ctrl+c")) {
      if (!isKeyRelease(data)) void tui.copyActiveSelectionToClipboard().catch(() => showStatus("复制失败，请重新选中文字。"));
      return { consume: true };
    }
    if (choice) {
      if (!isKeyRelease(data)) {
        if (matchesKey(data, "escape")) { choice = undefined; showStatus("已返回编辑，草稿已保留。"); drainQueue(); }
        else if (matchesKey(data, "left") || matchesKey(data, "right") || matchesKey(data, "tab")) {
          choice.selected = matchesKey(data, "left") ? 0 : matchesKey(data, "right") ? 1 : 1 - choice.selected;
          drawChoice();
        } else if (getKeybindings().matches(data, "tui.input.submit")) chooseMessage();
      }
      return { consume: true };
    }
    if (busy && matchesKey(data, "escape")) {
      if (!isKeyRelease(data)) cancelRequest();
      return { consume: true };
    }
  });
  showStatus();

  process.once("SIGINT", close);
  process.once("SIGTERM", close);
  if (!dependencies.terminal) process.stdin.once("end", close);
  try {
    tui.start();
    await closed.promise;
  } finally {
    close();
    process.off("SIGINT", close);
    process.off("SIGTERM", close);
    if (!dependencies.terminal) process.stdin.off("end", close);
    tui.stop({ preserveScreen: true });
  }
  await active;
}
