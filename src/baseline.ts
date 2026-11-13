import { lstat, mkdir, mkdtemp, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { evaluateBaseline, readEvidence, type TestEvidence } from "./evidence.ts";
import { findGitExecutable } from "./git.ts";
import { assertContainedLinks, LinkBoundaryError } from "./integrity.ts";
import { executionEnvironment, runProcess, type ProcessResult } from "./process.ts";
import { emitProgress, type ProgressSink } from "./progress.ts";
import { loadTask, TaskInputError } from "./task.ts";

type Check = Omit<ProcessResult, "stdout"> & {
  phase: string;
  script: string | null;
  command: string[];
  logPath: string;
  tests?: TestEvidence[];
};

export type BaselineReport = {
  kind: "baseline_check";
  baselineStatus: "ready" | "not_reproduced" | "error";
  taskId: string | null;
  baseCommit: string | null;
  reason: string;
  code?: string;
  startedAt: string;
  finishedAt: string;
  changedPaths: string[];
  checks: Check[];
  artifacts: { patch: null; worktree: string | null; logs: string[] };
};

class BaselineError extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(message); this.code = code; }
}

function commandFailed(result: ProcessResult) {
  return result.executionError || result.timedOut || result.interrupted || result.outputTruncated || result.exitCode !== 0;
}

function requireCommand(result: ProcessResult, code: string, message: string) {
  if (result.timedOut) throw new BaselineError("COMMAND_TIMEOUT", "命令超时，不能可靠验收基准。");
  if (result.interrupted) throw new BaselineError("COMMAND_INTERRUPTED", "命令被中断，不能可靠验收基准。");
  if (commandFailed(result)) throw new BaselineError(code, message);
}

export async function runBaseline(taskFile: string, signal?: AbortSignal, onProgress?: ProgressSink) {
  const runsRoot = fileURLToPath(new URL("../.repopilot/runs/", import.meta.url));
  await mkdir(runsRoot, { recursive: true });
  const runDir = await mkdtemp(join(runsRoot, "baseline-"));
  const logsDir = join(runDir, "logs");
  await mkdir(logsDir);
  const reportPath = join(runDir, "baseline.json");
  const report: BaselineReport = {
    kind: "baseline_check", baselineStatus: "error", taskId: null, baseCommit: null,
    reason: "基准检查未完成。", startedAt: new Date().toISOString(), finishedAt: "",
    changedPaths: [], checks: [], artifacts: { patch: null, worktree: null, logs: [] },
  };
  const env = executionEnvironment();
  const userConfig = join(runDir, "empty-user.npmrc");
  const globalConfig = join(runDir, "empty-global.npmrc");
  await writeFile(userConfig, "");
  await writeFile(globalConfig, "");
  env.NPM_CONFIG_USERCONFIG = userConfig;
  env.NPM_CONFIG_GLOBALCONFIG = globalConfig;

  async function execute(executable: string, args: string[], cwd: string, phase: string, script: string | null = null, captureOutput = false) {
    signal?.throwIfAborted();
    const result = await runProcess(executable, args, { cwd, env, timeoutMs: 120_000, captureOutput, signal });
    const { stdout: _stdout, ...publicResult } = result;
    const logPath = join(logsDir, `${String(report.checks.length + 1).padStart(2, "0")}-${phase}.json`);
    const check: Check = { phase, script, command: [executable, ...args], ...publicResult, logPath };
    report.checks.push(check);
    report.artifacts.logs.push(logPath);
    await writeFile(logPath, JSON.stringify(check, null, 2) + "\n");
    signal?.throwIfAborted();
    return { result, check };
  }

  try {
    emitProgress("baseline", onProgress, signal);
    const task = await loadTask(taskFile);
    report.taskId = task.id;
    const repo = await realpath(task.repoPath).catch(() => { throw new BaselineError("REPO_NOT_FOUND", "本地仓库路径不存在或不可访问。"); });
    const gitExecutable = await findGitExecutable(env);
    if (!gitExecutable) throw new BaselineError("GIT_NOT_FOUND", "未找到 Git。请安装 Git for Windows 并重新打开终端，或准备项目本地 Git。");
    const git = async (args: string[], cwd = repo, phase = "repository") => {
      const { result } = await execute(gitExecutable, ["-c", "core.quotePath=false", ...args], cwd, phase, null, true);
      if (result.executionError) throw new BaselineError("GIT_EXECUTION_FAILED", "找到了 Git，但无法启动；请检查安装和执行权限。");
      requireCommand(result, "GIT_CHECK_FAILED", "仓库、提交或工作副本检查失败。");
      return result.stdout.trim();
    };
    const root = await git(["rev-parse", "--show-toplevel"]);
    if (await realpath(root) !== repo) throw new BaselineError("REPO_ROOT_REQUIRED", "repoPath 必须指向 Git 仓库根目录。");
    if (await git(["rev-parse", "--show-object-format"]) !== "sha1") throw new BaselineError("SHA1_REQUIRED", "首版仅支持 SHA-1 Git 仓库。");
    if (await git(["cat-file", "-t", task.baseCommit]) !== "commit") throw new BaselineError("COMMIT_REQUIRED", "baseCommit 必须指向真实提交。");

    const worktree = join(runDir, "worktree");
    const noHooks = join(runDir, "empty-hooks");
    await mkdir(noHooks);
    await git(["-c", `core.hooksPath=${noHooks}`, "worktree", "add", "--detach", worktree, task.baseCommit], repo, "worktree");
    report.artifacts.worktree = worktree;
    const actualCommit = await git(["rev-parse", "HEAD"], worktree, "worktree-head");
    if (actualCommit !== task.baseCommit) throw new BaselineError("COMMIT_MISMATCH", "工作副本与指定提交不一致。");
    report.baseCommit = actualCommit;

    for (const source of task.allowedPaths) {
      const path = join(worktree, source);
      const resolved = await realpath(path).catch(() => { throw new BaselineError("SOURCE_PATH_INVALID", "允许修改的源码在基准提交中不存在。"); });
      const inside = relative(worktree, resolved);
      if (!inside || isAbsolute(inside) || inside === ".." || inside.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)
        || !(await lstat(path)).isFile()) {
        throw new BaselineError("SOURCE_PATH_INVALID", "允许修改的文件必须是工作副本内的常规源码文件。");
      }
      const tracked = await git(["ls-files", "--error-unmatch", "--", source], worktree, "source-path");
      if (tracked !== source) throw new BaselineError("SOURCE_PATH_INVALID", "允许修改的源码必须存在于基准提交，且路径大小写一致。");
    }
    const manifest: unknown = await readFile(join(worktree, "package.json"), "utf8").then(JSON.parse)
      .catch(() => { throw new BaselineError("MANIFEST_INVALID", "基准 package.json 不存在或不是有效 JSON。"); });
    const scripts = manifest && typeof manifest === "object" && "scripts" in manifest ? manifest.scripts : undefined;
    for (const name of [task.reproduceScript, task.regressionScript]) {
      if (!scripts || typeof scripts !== "object" || !Object.hasOwn(scripts, name)
        || typeof (scripts as Record<string, unknown>)[name] !== "string") {
        throw new BaselineError("SCRIPT_MISSING", "基准 package.json 中缺少指定的 npm script。");
      }
    }
    if (!(await stat(join(worktree, "package-lock.json")).catch(() => undefined))?.isFile()) throw new BaselineError("LOCKFILE_REQUIRED", "需要基准提交中的 package-lock.json。");
    const npmCli = join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
    if (!(await stat(npmCli).catch(() => undefined))?.isFile()) throw new BaselineError("NPM_UNAVAILABLE", "无法找到当前 Node 安装中的 npm-cli.js。");
    const install = await execute(process.execPath, [npmCli, "ci", "--ignore-scripts", "--no-audit", "--no-fund"], worktree, "dependencies");
    requireCommand(install.result, "DEPENDENCY_FAILED", "依赖准备失败，未进入基准测试。");
    await assertContainedLinks(worktree);

    const reporter = new URL(import.meta.url.endsWith(".ts") ? "./test-reporter.ts" : "./test-reporter.js", import.meta.url).href;
    async function runTests(script: string, phase: string) {
      const evidencePath = join(logsDir, `${phase}.jsonl`);
      env.NODE_OPTIONS = `--test-reporter=${reporter} --test-reporter-destination="${evidencePath.replaceAll("\\", "/")}"`;
      env.REPOPILOT_EVIDENCE_PATH = evidencePath;
      const execution = await execute(process.execPath, [npmCli, "run", "--ignore-scripts", script], worktree, phase, script);
      if (execution.result.timedOut || execution.result.interrupted || execution.result.executionError || execution.result.exitCode === null) {
        requireCommand(execution.result, "TEST_EXECUTION_FAILED", "测试命令未可靠执行。");
      }
      let tests: TestEvidence[];
      for (const path of [evidencePath, `${evidencePath}.writer`, `${evidencePath}.multiple`]) {
        if ((await stat(path).catch(() => undefined))?.isFile()) report.artifacts.logs.push(path);
      }
      try { tests = await readEvidence(evidencePath, worktree); }
      catch { throw new BaselineError("EVIDENCE_INVALID", "测试结构化证据缺失或不可靠；每个脚本须仅启动一次 node:test。"); }
      execution.check.tests = tests;
      await writeFile(execution.check.logPath, JSON.stringify(execution.check, null, 2) + "\n");
      return { tests, exitCode: execution.result.exitCode };
    }
    const reproduce = await runTests(task.reproduceScript, "before-reproduce");
    const regression = await runTests(task.regressionScript, "before-regression");
    await assertContainedLinks(worktree);
    const changes = await git(["status", "--porcelain=v1", "--untracked-files=all"], worktree, "baseline-integrity");
    if (changes) {
      const tracked = await git(["diff", "--name-only", "-z", "HEAD"], worktree, "changed-tracked");
      const untracked = await git(["ls-files", "--others", "--exclude-standard", "-z"], worktree, "changed-untracked");
      report.changedPaths = [...new Set([...tracked.split("\0"), ...untracked.split("\0")].filter(Boolean))].sort();
      throw new BaselineError("BASELINE_CHANGED", "依赖或测试改变了基准文件；不能启动修复。");
    }
    Object.assign(report, evaluateBaseline(reproduce.tests, regression.tests, task.expectedFailure, reproduce.exitCode, regression.exitCode));
  } catch (error) {
    report.baselineStatus = "error";
    report.code = signal?.aborted ? "OPERATION_CANCELLED" : error instanceof TaskInputError || error instanceof BaselineError || error instanceof LinkBoundaryError ? error.code : "BASELINE_ERROR";
    report.reason = signal?.aborted ? "操作已取消。" : error instanceof TaskInputError || error instanceof BaselineError || error instanceof LinkBoundaryError ? error.message : "基准准备或证据检查失败；原始异常未输出。";
  }
  report.finishedAt = new Date().toISOString();
  await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
  return { ...report, reportPath };
}
