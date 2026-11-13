import { mkdir, realpath, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { findGitExecutable } from "./git.ts";
import { executionEnvironment, runProcess } from "./process.ts";
import { TaskInputError, validateTask, validSourcePath, type Task } from "./task.ts";

export type RepositorySnapshot = { repoPath: string; baseCommit: string; scripts: string[]; sourcePaths: string[] };
type TaskFields = Omit<Task, "repoPath" | "baseCommit">;

export function assertTaskInitSafe(text: string): void {
  const key = process.env.DASHSCOPE_API_KEY?.trim();
  if (/[\x00-\x1f\x7f-\x9f]/.test(text) || /\bsk-[A-Za-z0-9_-]{16,}\b/.test(text)
    || Boolean(key && (text.includes(key) || text.includes(JSON.stringify(key).slice(1, -1))))) {
    throw new TaskInputError("TASK_INIT_UNSAFE_CONTENT", "内容含控制字符或疑似凭据，请移除后重试。");
  }
}

export async function inspectTaskRepository(repoPath: string, signal?: AbortSignal): Promise<RepositorySnapshot> {
  try {
    signal?.throwIfAborted();
    assertTaskInitSafe(repoPath);
    if (/^(?:[a-z]+:\/\/|\\\\|\/\/)/i.test(repoPath)) {
      throw new TaskInputError("TASK_INIT_NOT_REPOSITORY", "请选择可信本地 Git 仓库目录。");
    }
    const cwd = await realpath(resolve(repoPath));
    const env = executionEnvironment();
    const executable = await findGitExecutable(env);
    if (!executable) throw new TaskInputError("GIT_NOT_FOUND", "未找到 Git，请安装 Git 或准备项目本地 Git。");
    async function git(args: string[], code: string, message: string) {
      const result = await runProcess(executable!, ["-c", "core.fsmonitor=false", "-c", "core.quotePath=false", ...args], {
        cwd, env, timeoutMs: 15_000, captureOutput: true, signal,
      });
      signal?.throwIfAborted();
      if (result.exitCode !== 0 || result.outputTruncated) throw new TaskInputError(code, message);
      return result.stdout;
    }
    const root = await realpath((await git(["rev-parse", "--show-toplevel"],
      "TASK_INIT_NOT_REPOSITORY", "所选目录不属于 Git 仓库。")).trim());
    assertTaskInitSafe(root);
    const baseCommit = (await git(["rev-parse", "--verify", "HEAD^{commit}"],
      "TASK_INIT_COMMIT_REQUIRED", "仓库需要至少一个已提交版本，才能固定故障提交。")).trim();
    if (!/^[a-f0-9]{40}$/.test(baseCommit)) throw new TaskInputError("TASK_INIT_COMMIT_REQUIRED", "需要 SHA-1 仓库的完整提交号。");
    const tree = await git(["ls-tree", "-r", "-z", "--full-tree", baseCommit, "--", "src", "package.json", "package-lock.json"],
      "TASK_INIT_SCAN_FAILED", "无法读取已提交的源码列表，或列表超过扫描上限。");
    const files = tree.split("\0").flatMap(entry => {
      const match = /^(100644|100755) blob [a-f0-9]+\t(.+)$/.exec(entry);
      return match ? [match[2]] : [];
    });
    if (!files.includes("package-lock.json")) throw new TaskInputError("TASK_INIT_LOCKFILE_REQUIRED", "固定提交中需要 package-lock.json。");
    if (!files.includes("package.json")) throw new TaskInputError("TASK_INIT_MANIFEST_INVALID", "固定提交中需要常规 package.json 文件。");
    const manifestText = await git(["cat-file", "blob", `${baseCommit}:package.json`],
      "TASK_INIT_MANIFEST_INVALID", "无法读取固定提交中的 package.json。");
    let manifest: unknown;
    try { manifest = JSON.parse(manifestText); }
    catch { throw new TaskInputError("TASK_INIT_MANIFEST_INVALID", "固定提交中的 package.json 不是有效 JSON。"); }
    const scriptsValue = manifest && typeof manifest === "object" && "scripts" in manifest ? manifest.scripts : undefined;
    const scripts = scriptsValue && typeof scriptsValue === "object" ? Object.entries(scriptsValue)
      .filter(([name, command]) => /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(name) && typeof command === "string" && command.trim())
      .map(([name]) => name).sort() : [];
    if (scripts.length < 2) throw new TaskInputError("TASK_INIT_SCRIPTS_REQUIRED", "固定提交中至少需要两个有效 npm scripts，分别用于复现和回归。");
    const sourcePaths = files.filter(validSourcePath).sort();
    if (!sourcePaths.length) throw new TaskInputError("TASK_INIT_NO_SOURCES", "固定提交中没有可授权的 src 下 JS/TS 常规源码文件。");
    for (const value of [...scripts, ...sourcePaths]) assertTaskInitSafe(value);
    return { repoPath: root, baseCommit, scripts, sourcePaths };
  } catch (error) {
    if (signal?.aborted) throw new TaskInputError("TASK_INIT_CANCELLED", "任务创建已中断。");
    if (error instanceof TaskInputError) throw error;
    throw new TaskInputError("TASK_INIT_NOT_REPOSITORY", "无法读取可信本地仓库及其已提交配置。");
  }
}

function checkSafeTask(task: Task) {
  for (const value of [task.id, task.repoPath, task.baseCommit, task.issue, task.reproduceScript,
    task.regressionScript, task.expectedFailure, ...task.allowedPaths]) assertTaskInitSafe(value);
}

export async function buildTask(snapshot: RepositorySnapshot, fields: TaskFields): Promise<Task> {
  const task = await validateTask({ ...fields, repoPath: snapshot.repoPath, baseCommit: snapshot.baseCommit });
  checkSafeTask(task);
  if (!snapshot.scripts.includes(task.reproduceScript) || !snapshot.scripts.includes(task.regressionScript)
    || task.reproduceScript === task.regressionScript) {
    throw new TaskInputError("TASK_INIT_SCRIPT_SELECTION_INVALID", "请选择固定提交中的两个不同脚本，分别用于复现和回归。");
  }
  if (task.allowedPaths.some(path => !snapshot.sourcePaths.includes(path))) {
    throw new TaskInputError("TASK_INIT_SOURCE_SELECTION_INVALID", "只能授权列表中明确选择的已提交源码文件。");
  }
  return task;
}

export async function saveTask(task: Task, outputPath: string): Promise<string> {
  const valid = await validateTask(task);
  checkSafeTask(valid);
  assertTaskInitSafe(outputPath);
  const path = resolve(outputPath);
  assertTaskInitSafe(path);
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(valid, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    return path;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new TaskInputError("TASK_OUTPUT_EXISTS", "任务文件已存在，请选择其他路径。");
    throw new TaskInputError("TASK_OUTPUT_WRITE_FAILED", "无法写入任务文件，请检查输出目录和权限。");
  }
}
