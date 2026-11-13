#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { EnvHttpProxyAgent, install, setGlobalDispatcher } from "undici";
import { checkAuthentication, inspectConfiguration, PiConnectionError, runConnectionCheck } from "./pi.ts";
import type { CandidateReview } from "./repair.ts";

const command = process.argv[2] ?? "--help";
const terminalChat = command === "chat" || command === "tui";
let transport: EnvHttpProxyAgent | undefined;
const help = `RepoPilot 0.1.0

Usage: npm run dev -- <command>
  check       Check SDK and model configuration without a model request
  smoke       Check a real text reply and one fixed read-only tool call
  auth-check  Send one direct HTTP request to diagnose authentication
  task init [repoPath]  Create a fixed task interactively without a model request
  baseline <task.json>  Prepare a fixed worktree and verify baseline tests
  locate <task.json>  Rank authorized sources and select bounded context offline
  propose <task.json>  Ask Qwen for one candidate patch for review
  repair <task.json>  Try up to three candidates with explicit review before each verification
  bench <suite.json>  Compare paired workflows with a shared first candidate and explicit review
  bench-equal <suite.json>  Compare independent feedback/no-feedback workflows, at most 3 attempts each
  verify <task.json> <patch.diff>  Independently verify a candidate patch
  chat [task.json]  Start an interactive chat with optional task tools and a local image
  tui [task.json]   Start the full-screen terminal chat with optional task tools and a local image
  --help      Show help
  --version   Show version

smoke, propose, repair, bench, bench-equal, chat and tui require DASHSCOPE_API_KEY. Use Start-RepoPilot.ps1 for hidden input.
`;
const chatHelp = `直接输入问题开始对话。
/image <本地路径>  为下一条问题附上一张 PNG、JPEG 或 WebP 图片，路径可加引号
/image  查看待发送图片的文件名、格式和大小
/image clear  移除待发送图片，不清空对话
也可直接输入 "本地图片路径" 问题；只输入路径则先附图，等待下一条问题
/save   保存完整文字对话，不保存图片原始数据
/sessions   查看本地保存的会话
/resume <会话ID>   确认后恢复会话，替换当前对话
/runs   查看本地运行记录，不调用模型
/report <运行ID>   查看本地运行摘要和验收结果
/status   离线查看当前会话已加载的模型与配置状态
/doctor   离线检查当前配置、进程凭据与绑定任务
/auth-check   确认后发送一次固定文本，联网检查鉴权
/reset  清空对话和待发送图片
/help   显示对话命令
/exit   退出对话
`;

type Ask = (prompt: string) => Promise<string | undefined>;

async function saveCheckResult(result: object, filename: "connection-check.json" | "authentication-check.json" = "connection-check.json") {
  const stateDir = new URL("../.repopilot/", import.meta.url);
  await mkdir(stateDir, { recursive: true });
  await writeFile(new URL(filename, stateDir), JSON.stringify(result, null, 2) + "\n", "utf8");
}

async function reviewCandidate(candidate: CandidateReview & { taskId?: string; taskIndex?: number; taskCount?: number; strategy?: "feedback" | "no_feedback" }, ask?: Ask) {
  const task = candidate.taskId === undefined ? "" : `任务 ${candidate.taskIndex}/${candidate.taskCount}：${candidate.taskId}\n`;
  const strategy = candidate.strategy === undefined ? "" : `策略：${candidate.strategy === "feedback" ? "带失败反馈" : "无反馈重试"}\n`;
  process.stderr.write(`\n${task}${strategy}第 ${candidate.attempt}/3 轮候选\n补丁：${candidate.patchPath}\nSHA-256：${candidate.candidateHash}\n`);
  const prompt = "请先打开补丁审阅；输入 yes 后独立验收，其他输入保留补丁并停止：";
  if (ask) return (await ask(prompt))?.trim().toLowerCase() === "yes";
  if (!process.stdin.isTTY) {
    process.stderr.write("当前输入非交互式，候选已保留，等待审阅。\n");
    return false;
  }
  const reader = createInterface({ input: process.stdin, output: process.stderr });
  const controller = new AbortController();
  reader.once("close", () => controller.abort());
  try {
    const answer = await reader.question(prompt, { signal: controller.signal });
    return answer.trim().toLowerCase() === "yes";
  } catch {
    return false;
  } finally {
    reader.close();
  }
}

async function runChat(taskFile: string | undefined) {
  const { createChat } = await import("./chat.ts");
  const { ChatImageError, loadChatAttachment, formatImageAttachment, parseImageCommand, parseImageInput } = await import("./chat-image.ts");
  const reader = createInterface({ input: process.stdin, output: process.stderr });
  const controller = new AbortController();
  reader.once("close", () => controller.abort());
  reader.on("SIGINT", () => reader.close());
  const ask: Ask = async prompt => {
    if (controller.signal.aborted) return;
    try {
      return await reader.question(prompt, { signal: controller.signal });
    } catch (error) {
      if (!controller.signal.aborted) throw error;
    }
  };

  try {
    const chat = await createChat({
      taskFile,
      confirmAction: async action => {
        const label = action === "locate" ? "源码定位" : "修复流程";
        const answer = await ask(`对话请求执行${label}。输入 yes 继续，其他输入拒绝：`);
        return answer?.trim().toLowerCase() === "yes";
      },
      review: candidate => reviewCandidate(candidate, ask),
      onReport: ({ status, reportPath, patchPath }) => {
        process.stderr.write(`\n状态：${status}\n报告：${reportPath}\n`);
        if (patchPath) process.stderr.write(`补丁：${patchPath}\n`);
      },
    });
    process.stderr.write(chat.taskId ? `已选择任务 ${chat.taskId}。输入 /help 查看对话命令。\n` : "已启动对话。输入 /help 查看对话命令。\n");
    let attachment: Awaited<ReturnType<typeof loadChatAttachment>> | undefined;
    while (!controller.signal.aborted) {
      const line = (await ask("你> "))?.trim();
      if (line === undefined || line === "/exit") { attachment = undefined; break; }
      if (!line) continue;
      if (line === "/help") {
        process.stderr.write(chatHelp);
      } else if (/^\/status(?:\s|$)/.test(line)) {
        if (line !== "/status") { process.stderr.write("用法：/status（不需要参数）。\n"); continue; }
        try {
          const { formatChatStatus } = await import("./chat-status.ts");
          if (!controller.signal.aborted) process.stderr.write(`${formatChatStatus(chat.status())}\n`);
        } catch {
          if (!controller.signal.aborted) process.stderr.write("无法读取当前会话状态。\n");
        }
      } else if (/^\/auth-check(?:\s|$)/.test(line)) {
        if (line !== "/auth-check") { process.stderr.write("用法：/auth-check（不需要参数）。\n"); continue; }
        try {
          const { authenticationDisclosure, formatAuthenticationResult } = await import("./chat-doctor.ts");
          if (controller.signal.aborted) continue;
          const approved = await ask(`${authenticationDisclosure(chat.status())}\n输入 yes 执行一次联网检查，其他输入取消：`);
          if (controller.signal.aborted) continue;
          if (approved?.trim().toLowerCase() !== "yes") { process.stderr.write("未发送联网检查请求。\n"); continue; }
          const result = await chat.authCheck(controller.signal);
          if (!controller.signal.aborted) process.stderr.write(`${formatAuthenticationResult(result)}\n`);
        } catch (error) {
          if (!controller.signal.aborted) process.stderr.write(`${error instanceof PiConnectionError ? error.message : "联网检查未完成，请检查网络和服务配置。"}\n`);
        }
      } else if (/^\/doctor(?:\s|$)/.test(line)) {
        if (line !== "/doctor") { process.stderr.write("用法：/doctor（不需要参数）。\n"); continue; }
        try {
          const { formatChatDiagnosis } = await import("./chat-doctor.ts");
          if (controller.signal.aborted) continue;
          const result = await chat.doctor(controller.signal);
          if (!controller.signal.aborted) process.stderr.write(`${formatChatDiagnosis(result)}\n`);
        } catch {
          if (!controller.signal.aborted) process.stderr.write("离线诊断未完成，请稍后重试或退出后运行 check。\n");
        }
      } else if (/^\/(?:runs|report)(?:\s|$)/.test(line)) {
        const [operation, ...arguments_] = line.split(/\s+/);
        if ((operation === "/runs" && arguments_.length !== 0)
          || (operation === "/report" && arguments_.length !== 1)) {
          process.stderr.write("用法：/runs 或 /report <运行ID>。\n");
          continue;
        }
        const history = await import("./run-history.ts");
        const display = await import("./run-display.ts");
        const options = { apiKey: process.env.DASHSCOPE_API_KEY?.trim(), signal: controller.signal };
        try {
          const text = operation === "/runs"
            ? display.formatRunList(await history.listRuns(options))
            : display.formatRunDetail(await history.loadRun(arguments_[0], options));
          if (!controller.signal.aborted) process.stderr.write(`${text}\n`);
        } catch (error) {
          if (!controller.signal.aborted) process.stderr.write(`${error instanceof history.RunHistoryError ? error.message : "运行报告读取失败。"}\n`);
        }
      } else if (/^\/(?:save|sessions|resume)(?:\s|$)/.test(line)) {
        const [operation, ...arguments_] = line.split(/\s+/);
        if ((operation === "/resume" && arguments_.length !== 1)
          || (operation !== "/resume" && arguments_.length !== 0)) {
          process.stderr.write("用法：/save、/sessions 或 /resume <会话ID>。\n");
          continue;
        }
        const store = await import("./session-store.ts");
        const options = { apiKey: process.env.DASHSCOPE_API_KEY?.trim() };
        try {
          if (operation === "/save") {
            const snapshot = chat.snapshot();
            if (!snapshot.turns.length) {
              process.stderr.write("请先完成一轮对话再保存。\n");
              continue;
            }
            const saved = await store.saveSession(snapshot, options);
            if (!controller.signal.aborted) process.stderr.write(`已保存会话：${saved.id}\n仅保存完整文字对话和历史报告引用；图片原始数据未保存。退出不会自动保存。\n`);
          } else if (operation === "/sessions") {
            const sessions = await store.listSessions(options);
            if (!controller.signal.aborted) process.stderr.write(sessions.length
              ? sessions.map(session => `${session.id} · ${session.createdAt} · ${session.turns} 轮 · ${session.taskId ?? "未绑定任务"}`).join("\n") + "\n"
              : "暂无已保存会话。\n");
          } else {
            const saved = await store.loadSession(arguments_[0], options);
            if (controller.signal.aborted) continue;
            const approved = await ask("恢复会话将替换当前对话；图片不会恢复，也不会执行历史工具。输入 yes 恢复，其他输入取消：");
            if (controller.signal.aborted) continue;
            if (approved?.trim().toLowerCase() !== "yes") {
              process.stderr.write("已取消恢复，当前对话保留。\n");
              continue;
            }
            await chat.restore({ task: saved.task, turns: saved.turns }, controller.signal);
            if (controller.signal.aborted) continue;
            attachment = undefined;
            for (const turn of saved.turns) {
              process.stdout.write(`\n你${turn.hadImage ? " · 图片未恢复，请重新附加" : ""}\n${turn.user}\nRepoPilot\n${turn.assistant}\n`);
              for (const report of turn.reports) {
                process.stderr.write(`历史报告引用：${report.status}\n报告：${report.reportPath}${report.patchPath ? `\n补丁：${report.patchPath}` : ""}\n`);
              }
            }
            process.stderr.write(`已恢复会话：${saved.id}，可以继续提问。\n`);
          }
        } catch (error) {
          if (!controller.signal.aborted) process.stderr.write(`${error instanceof store.SessionError || error instanceof PiConnectionError ? error.message : "会话操作失败。"}\n`);
        }
      } else if (line === "/reset") {
        chat.reset();
        attachment = undefined;
        process.stderr.write("已清空对话和待发送图片。\n");
      } else if (/^\/image(?:\s|$)/.test(line)) {
        try {
          const command = parseImageCommand(line);
          if (command.action === "show") {
            process.stderr.write(attachment ? `待发送图片：${formatImageAttachment(attachment)}\n` : "当前无待发送图片。\n");
          } else if (command.action === "clear") {
            const hadAttachment = Boolean(attachment);
            attachment = undefined;
            process.stderr.write(hadAttachment ? "待发送图片已移除。\n" : "当前无待发送图片。\n");
          } else {
            attachment = undefined;
            const loaded = await loadChatAttachment(command.path, process.env.DASHSCOPE_API_KEY?.trim());
            if (controller.signal.aborted) continue;
            attachment = loaded;
            process.stderr.write(`图片已就绪：${formatImageAttachment(attachment)}\n下一条问题会将它发送给模型服务。输入 /image clear 可移除待发送图片。\n`);
          }
        } catch (error) {
          attachment = undefined;
          if (!controller.signal.aborted) process.stderr.write(`${error instanceof ChatImageError ? error.message : "无法读取图片。"}当前无待发送图片。\n`);
        }
      } else if (line.startsWith("/")) {
        process.stderr.write("未知对话命令，请输入 /help。\n");
      } else {
        try {
          const inlineImage = parseImageInput(line);
          let text = line;
          if (inlineImage) {
            attachment = undefined;
            const loaded = await loadChatAttachment(inlineImage.path, process.env.DASHSCOPE_API_KEY?.trim());
            if (controller.signal.aborted) continue;
            attachment = loaded;
            if (!inlineImage.prompt) {
              process.stderr.write(`图片已就绪：${formatImageAttachment(attachment)}\n下一条问题会将它发送给模型服务。输入 /image clear 可移除待发送图片。\n`);
              continue;
            }
            text = inlineImage.prompt;
          }
          if (attachment) process.stderr.write("正在将问题和图片发送给模型服务。\n");
          const answer = await chat.send(text, attachment?.image);
          attachment = undefined;
          if (!controller.signal.aborted) process.stdout.write(`${answer}\n`);
        } catch (error) {
          if (!controller.signal.aborted) process.stderr.write(`${error instanceof ChatImageError ? error.message + "当前无待发送图片。" : error instanceof PiConnectionError ? error.message : "对话请求失败。"}\n`);
        }
      }
    }
  } finally {
    reader.close();
  }
}

async function main() {
  if (command === "task") {
    if (process.argv[3] !== "init" || process.argv.length > 5 || process.argv[4]?.trim() === "") {
      throw new PiConnectionError("USAGE", "请使用 task init [repoPath] 创建任务。");
    }
    if (!process.stdin.isTTY) throw new PiConnectionError("TTY_REQUIRED", "请在交互式终端中运行任务向导。");
    const { runTaskWizard } = await import("./task-wizard.ts");
    const result = await runTaskWizard(process.argv[4]);
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    process.exitCode = result.precheck?.baselineStatus === "error" ? 2 : result.precheck?.baselineStatus === "not_reproduced" ? 1 : 0;
    return;
  }
  const taskFile = process.argv[3];
  const expectedArguments = command === "verify" ? 5 : command === "baseline" || command === "locate" || command === "propose" || command === "repair" || command === "bench" || command === "bench-equal" ? 4 : undefined;
  const wrongArgumentCount = expectedArguments ? process.argv.length !== expectedArguments : process.argv.length > (terminalChat ? 4 : 3);
  if (wrongArgumentCount || (command === "tui" && taskFile?.trim() === "")) {
    throw new PiConnectionError("USAGE", "请按 --help 中的命令格式提供参数。");
  }
  if (command === "--help" || command === "-h") { process.stdout.write(help); return; }
  if (command === "--version" || command === "-v") { process.stdout.write("0.1.0\n"); return; }
  if (command === "check") {
    process.stdout.write(JSON.stringify(await inspectConfiguration(), null, 2) + "\n");
    return;
  }
  if (command === "baseline") {
    const { runBaseline } = await import("./baseline.ts");
    const result = await runBaseline(process.argv[3]!);
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    process.exitCode = result.baselineStatus === "ready" ? 0 : result.baselineStatus === "not_reproduced" ? 1 : 2;
    return;
  }
  if (command === "locate") {
    const { locateTask } = await import("./localization.ts");
    const result = await locateTask(process.argv[3]!);
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    process.exitCode = result.status === "located" ? 0 : result.status === "not_reproduced" ? 1 : 2;
    return;
  }
  if (command === "verify") {
    const { verifyPatch } = await import("./verifier.ts");
    const result = await verifyPatch(process.argv[3]!, process.argv[4]!);
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    process.exitCode = result.status === "resolved" ? 0 : result.status === "error" ? 2 : 1;
    return;
  }
  if (command !== "smoke" && command !== "auth-check" && command !== "propose" && command !== "repair" && command !== "bench" && command !== "bench-equal" && !terminalChat) {
    throw new PiConnectionError("USAGE", "未知命令，请运行 --help。");
  }
  if ((terminalChat && !process.stdin.isTTY) || (command === "tui" && !process.stdout.isTTY)) {
    throw new PiConnectionError("TTY_REQUIRED", `请在交互式终端中运行 ${command}。`);
  }
  transport = new EnvHttpProxyAgent({ proxyTunnel: true });
  setGlobalDispatcher(transport);
  install();
  if (command === "tui") {
    const { runChatTui } = await import("./chat-tui.ts");
    await runChatTui(taskFile);
    return;
  }
  if (command === "chat") {
    await runChat(taskFile);
    return;
  }
  if (command === "bench") {
    const { runBenchmark } = await import("./benchmark.ts");
    const result = await runBenchmark(process.argv[3]!, reviewCandidate);
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    process.exitCode = result.status === "completed" ? 0 : result.status === "error" ? 2 : 1;
    return;
  }
  if (command === "bench-equal") {
    const { runEqualBenchmark } = await import("./equal-benchmark.ts");
    const controller = new AbortController();
    const cancel = () => controller.abort();
    process.on("SIGINT", cancel);
    try {
      const result = await runEqualBenchmark(taskFile!, reviewCandidate, undefined, controller.signal);
      process.stdout.write(JSON.stringify(result, null, 2) + "\n");
      process.exitCode = result.status === "completed" ? 0 : result.status === "error" ? 2 : 1;
    } finally { process.removeListener("SIGINT", cancel); }
    return;
  }
  if (command === "repair") {
    const { repairTask } = await import("./repair.ts");
    const result = await repairTask(process.argv[3]!, reviewCandidate);
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    process.exitCode = result.status === "resolved" ? 0 : result.status === "error" ? 2 : 1;
    return;
  }
  if (command === "propose") {
    const { proposeRepair } = await import("./proposal.ts");
    const result = await proposeRepair(process.argv[3]!);
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    process.exitCode = result.status === "proposed" ? 0 : result.status === "not_reproduced" ? 1 : 2;
    return;
  }
  if (command === "auth-check") {
    const result = await checkAuthentication();
    await saveCheckResult(result, "authentication-check.json");
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    process.exitCode = result.status === "accepted" ? 0 : 1;
    return;
  }
  const result = await runConnectionCheck();
  await saveCheckResult(result);
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  process.stderr.write(`检查记录：${fileURLToPath(new URL("../.repopilot/connection-check.json", import.meta.url))}\n`);
}

try {
  await main();
} catch (error) {
  const taskFailure = command === "task";
  const publicError = error instanceof PiConnectionError ? error
    : taskFailure && error instanceof (await import("./task.ts")).TaskInputError ? error : undefined;
  const tuiFailure = command === "tui";
  const chatFailure = command === "chat";
  const proposalFailure = command === "propose";
  const repairFailure = command === "repair";
  const benchmarkFailure = command === "bench" || command === "bench-equal";
  const failure = {
    kind: taskFailure ? "task_initialization" : terminalChat ? `terminal_${command}` : benchmarkFailure ? "benchmark_run" : repairFailure ? "repair_run" : proposalFailure ? "repair_proposal" : command === "locate" ? "source_localization" : command === "verify" ? "patch_verification" : command === "baseline" ? "baseline_check" : command === "auth-check" ? "direct_authentication_check" : "sdk_connection_check",
    ...(command === "baseline" ? { baselineStatus: "error" } : { status: taskFailure || terminalChat || benchmarkFailure || repairFailure || proposalFailure || command === "locate" || command === "verify" ? "error" : "failed" }),
    code: publicError ? publicError.code : taskFailure ? "TASK_INIT_ERROR" : tuiFailure ? "TUI_ERROR" : chatFailure ? "CHAT_ERROR" : benchmarkFailure ? "BENCHMARK_ERROR" : repairFailure ? "REPAIR_ERROR" : proposalFailure ? "PROPOSAL_ERROR" : command === "locate" ? "LOCALIZATION_ERROR" : command === "verify" ? "VERIFICATION_ERROR" : command === "baseline" ? "BASELINE_ERROR" : command === "auth-check" ? "DIRECT_REQUEST_FAILED" : "SDK_ERROR",
    message: publicError ? publicError.message : taskFailure ? "任务创建未完成；原始异常未输出。" : tuiFailure ? "无法启动全屏终端对话。" : chatFailure ? "无法启动终端对话。" : benchmarkFailure ? "对照评测失败；原始异常未输出。" : repairFailure ? "修复流程失败；原始异常未输出。" : proposalFailure ? "候选补丁生成失败。" : command === "locate" ? "源码定位失败；原始异常未输出。" : command === "verify" ? "补丁验收失败；原始异常未输出。" : command === "baseline" ? "基准检查失败；原始异常未输出。" : command === "auth-check" ? "直接 HTTP 检查未完成，请检查网络、接口和运行环境。" : "SDK 检查失败；原始异常未输出，请检查配置、网络与运行环境。",
  };
  if (command === "smoke" || command === "auth-check") await saveCheckResult(failure, command === "auth-check" ? "authentication-check.json" : "connection-check.json").catch(() => {});
  process.stderr.write(JSON.stringify(failure, null, 2) + "\n");
  process.exitCode = taskFailure || terminalChat || benchmarkFailure || repairFailure || proposalFailure || command === "locate" || failure.code === "USAGE" ? 2 : 1;
} finally {
  await transport?.close().catch(() => {});
}


