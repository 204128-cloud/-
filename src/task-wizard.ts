import { basename, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { runBaseline } from "./baseline.ts";
import { assertTaskInitSafe, buildTask, inspectTaskRepository, saveTask } from "./task-init.ts";
import { TaskInputError } from "./task.ts";

type Precheck = { baselineStatus: "ready" | "not_reproduced" | "error"; reportPath: string; code?: string };
type WizardDependencies = {
  ask?: (prompt: string) => Promise<string | undefined>;
  write?: (text: string) => void;
  inspect?: typeof inspectTaskRepository;
  build?: typeof buildTask;
  save?: typeof saveTask;
  baseline?: (taskPath: string, signal?: AbortSignal) => Promise<Precheck>;
  signal?: AbortSignal;
};
type WizardResult = {
  kind: "task_initialization"; status: "created" | "cancelled"; taskPath: string | null; precheck: Precheck | null;
};

export async function runTaskWizard(initialRepoPath?: string, dependencies: WizardDependencies = {}): Promise<WizardResult> {
  if (!dependencies.ask && !process.stdin.isTTY) throw new TaskInputError("TTY_REQUIRED", "请在交互式终端中运行任务向导。");
  const controller = new AbortController();
  const signal = dependencies.signal ? AbortSignal.any([controller.signal, dependencies.signal]) : controller.signal;
  const reader = dependencies.ask ? undefined : createInterface({ input: process.stdin, output: process.stderr });
  const cancel = () => { controller.abort(); reader?.close(); };
  reader?.once("close", () => controller.abort());
  reader?.on("SIGINT", cancel);
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  const ask = dependencies.ask ?? (async (prompt: string) => {
    if (signal.aborted) return;
    try { return await reader!.question(prompt, { signal }); }
    catch (error) { if (!signal.aborted) throw error; }
  });
  const write = dependencies.write ?? ((text: string) => { process.stderr.write(text + "\n"); });
  const result: WizardResult = { kind: "task_initialization", status: "cancelled", taskPath: null, precheck: null };

  async function field(prompt: string, defaultValue = "", valid: (value: string) => boolean = value => Boolean(value)) {
    while (!signal.aborted) {
      const answer = await ask(prompt);
      if (answer === undefined || signal.aborted) return;
      const value = answer.trim() || defaultValue;
      try { assertTaskInitSafe(value); }
      catch { write("输入含控制字符或疑似凭据，请移除后重试。"); continue; }
      if (valid(value)) return value;
      write("输入无效，请按提示重新填写。");
    }
  }

  async function choose(prompt: string, choices: string[]) {
    write(choices.map((name, index) => `  ${index + 1}. ${name}`).join("\n"));
    const answer = await field(prompt, "", value => /^\d+$/.test(value) && Number(value) >= 1 && Number(value) <= choices.length);
    return answer === undefined ? undefined : choices[Number(answer) - 1];
  }

  try {
    write("创建固定故障任务；不调用模型，不需要 API Key。请只使用你信任的本地仓库。");
    const repoPath = initialRepoPath ?? await field("本地仓库路径：");
    if (repoPath === undefined) return result;
    assertTaskInitSafe(repoPath);
    const snapshot = await (dependencies.inspect ?? inspectTaskRepository)(repoPath, signal);
    if (signal.aborted) return result;
    write(`仓库：${snapshot.repoPath}\n固定提交：${snapshot.baseCommit}\n以下脚本和源码取自此提交，未提交修改不会纳入任务。`);
    const stem = basename(snapshot.repoPath).replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[^A-Za-z0-9]+|[-._]+$/g, "");
    const defaultId = stem ? `${stem.slice(0, 60)}-fix` : "task-fix";
    const id = await field(`任务编号 [${defaultId}]：`, defaultId, value => /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value));
    if (id === undefined) return result;
    const issue = await field("问题描述（复现条件、实际行为、预期行为）：");
    if (issue === undefined) return result;
    write("请选择已有 npm script 名称，不填写 shell 命令。复现集合应包含故意失败用例，回归集合应排除该用例并在基准版本全部通过。");
    const reproduceScript = await choose("复现脚本编号：", snapshot.scripts);
    if (reproduceScript === undefined) return result;
    const regressionScript = await choose("回归脚本编号（排除已选复现脚本）：", snapshot.scripts.filter(name => name !== reproduceScript));
    if (regressionScript === undefined) return result;
    const expectedFailure = await field("失败测试完整名称（嵌套用例格式：父名称 > 子名称）：");
    if (expectedFailure === undefined) return result;
    write("只授权确实允许修改的具体源码文件；不会默认全选。");
    write(snapshot.sourcePaths.map((path, index) => `  ${index + 1}. ${path}`).join("\n"));
    const selection = await field("允许修改的文件编号（如 1,3）：", "", value => {
      if (!/^\d+(?:\s*,\s*\d+)*$/.test(value)) return false;
      const indexes = value.split(",").map(Number);
      return new Set(indexes).size === indexes.length && indexes.every(index => index >= 1 && index <= snapshot.sourcePaths.length);
    });
    if (selection === undefined) return result;
    const task = await (dependencies.build ?? buildTask)(snapshot, { id, issue, reproduceScript, regressionScript, expectedFailure,
      allowedPaths: selection.split(",").map(index => snapshot.sourcePaths[Number(index) - 1]) });
    const defaultOutput = fileURLToPath(new URL(`../tasks/${id}.json`, import.meta.url));
    while (!signal.aborted) {
      const answer = await field(`输出 JSON 路径 [${defaultOutput}]（不覆盖已有文件）：`, defaultOutput, value => /\.json$/i.test(value));
      if (answer === undefined) return result;
      const outputPath = resolve(answer);
      assertTaskInitSafe(outputPath);
      write(`待保存任务：\n${JSON.stringify(task, null, 2)}\n输出：${outputPath}`);
      const approved = await field("输入 yes 保存，其他输入取消 [no]：", "no");
      if (approved?.toLowerCase() !== "yes" || signal.aborted) return result;
      try {
        result.taskPath = await (dependencies.save ?? saveTask)(task, outputPath);
        result.status = "created";
        break;
      } catch (error) {
        if (!(error instanceof TaskInputError) || error.code !== "TASK_OUTPUT_EXISTS") throw error;
        write(error.message);
      }
    }
    if (!result.taskPath) return result;
    write("任务文件已创建；这不代表缺陷已复现或已修复。");
    const precheck = await field("现在准备依赖并运行测试做基准预检吗？不调用模型，但 npm ci 可能联网 [yes/no，默认 no]：", "no");
    if (precheck?.toLowerCase() === "yes" && !signal.aborted) {
      const report = await (dependencies.baseline ?? runBaseline)(result.taskPath, signal);
      result.precheck = { baselineStatus: report.baselineStatus, reportPath: report.reportPath, ...(report.code ? { code: report.code } : {}) };
      write(`基准预检：${report.baselineStatus}\n报告：${report.reportPath}`);
    }
    const quoted = `'${result.taskPath.replaceAll("'", "''")}'`;
    write(`后续在 RepoPilot 目录运行：\nnpm.cmd run dev -- baseline ${quoted}\npowershell.exe -NoProfile -ExecutionPolicy Bypass -File .\\Start-RepoPilot.ps1 tui ${quoted}`);
    return result;
  } catch (error) {
    if (signal.aborted) return result;
    throw error;
  } finally {
    process.off("SIGINT", cancel);
    process.off("SIGTERM", cancel);
    reader?.close();
  }
}
