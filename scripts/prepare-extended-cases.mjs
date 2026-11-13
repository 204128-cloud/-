import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { findGitExecutable } from "../src/git.ts";
import { executionEnvironment, runProcess } from "../src/process.ts";
import { loadTask } from "../src/task.ts";
import { loadBenchmarkSuite } from "../src/benchmark.ts";

const project = fileURLToPath(new URL("../", import.meta.url));
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
class PreparationError extends Error {}

async function saveUnchanged(path, text) {
  try { await writeFile(path, text, { flag: "wx" }); }
  catch (error) {
    if (error.code !== "EEXIST" || await readFile(path, "utf8") !== text) {
      throw new PreparationError("生成文件已存在且内容不同；未覆盖，请核对任务集版本或本地文件。");
    }
  }
}

async function main() {
  if (process.argv.length !== 2) throw new PreparationError("用法：node scripts/prepare-extended-cases.mjs（不需要参数或密钥）。");
  const manifest = JSON.parse(await readFile(new URL("../benchmarks/extended-v1.cases.json", import.meta.url), "utf8"));
  if (manifest.id !== "extended-v1" || manifest.cases.length !== 3) throw new PreparationError("案例清单版本或数量不符。");
  const root = join(project, ".repopilot", manifest.id);
  const hooks = join(root, "empty-hooks");
  await mkdir(hooks, { recursive: true });
  await mkdir(join(root, "repos"), { recursive: true });
  await mkdir(join(root, "tasks"), { recursive: true });
  const env = { ...executionEnvironment(), GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_AUTHOR_DATE: "2026-11-13T00:00:00Z", GIT_COMMITTER_DATE: "2026-11-13T00:00:00Z" };
  const executable = await findGitExecutable(env);
  if (!executable) throw new PreparationError("未找到 Git，请先准备项目支持的 Git 安装。");
  async function git(repo, args) {
    const result = await runProcess(executable, ["-c", "core.autocrlf=false", "-c", `core.hooksPath=${hooks}`,
      "-c", "commit.gpgsign=false", "-c", "user.name=RepoPilot fixtures", "-c", "user.email=fixtures@example.invalid",
      "-C", repo, ...args], { cwd: project, env, timeoutMs: 30000, captureOutput: true });
    if (result.exitCode !== 0 || result.executionError || result.timedOut || result.interrupted || result.outputTruncated) {
      throw new PreparationError("Git 案例准备失败；未输出原始异常或命令日志。");
    }
    return result.stdout.trim();
  }
  const tasks = [];
  const prepared = [];
  for (const entry of manifest.cases) {
    if (!/^[a-z][a-z0-9-]*$/.test(entry.name)) throw new PreparationError("案例目录名无效。");
    const sources = new Map();
    for (const [path, sha256] of Object.entries(entry.files)) {
      if (/[\\:]/.test(path) || path.split("/").some(part => !part || part === "." || part === ".." || part === ".git")) throw new PreparationError("案例文件路径无效。");
      const source = join(project, "cases", entry.name, path);
      if (!(await lstat(source)).isFile()) throw new PreparationError("案例快照须为常规文件。");
      const text = (await readFile(source, "utf8")).replace(/\r\n/g, "\n");
      if (hash(text) !== sha256) throw new PreparationError("案例快照与冻结哈希不符；请明确更新版本，未自动接受变化。");
      sources.set(path, text);
    }
    const repo = join(root, "repos", entry.name);
    const info = await lstat(repo).catch(error => { if (error.code !== "ENOENT") throw error; });
    if (!info) {
      await mkdir(repo);
      await git(repo, ["init", "--object-format=sha1", "--initial-branch=main"]);
      for (const [path, text] of sources) {
        const destination = join(repo, path);
        await mkdir(dirname(destination), { recursive: true });
        await writeFile(destination, text, { flag: "wx" });
      }
      await git(repo, ["add", "--", ...sources.keys()]);
      await git(repo, ["commit", "-m", `Freeze constructed ${entry.name} baseline (${manifest.id})`]);
    } else if (!info.isDirectory() || !(await lstat(join(repo, ".git"))).isDirectory()) {
      throw new PreparationError("案例目录已存在且不是独立 Git 仓库，未覆盖。");
    }
    if (resolve(await git(repo, ["rev-parse", "--show-toplevel"])) !== resolve(repo)
      || await git(repo, ["status", "--porcelain=v1", "--untracked-files=all"])) throw new PreparationError("已有案例仓库不是预期根目录或含未提交内容，未覆盖。");
    const paths = (await git(repo, ["ls-tree", "-r", "--name-only", "HEAD"])).split("\n").sort();
    if (JSON.stringify(paths) !== JSON.stringify([...sources.keys()].sort())) throw new PreparationError("已有案例提交的文件集合不符。");
    for (const [path, text] of sources) {
      if (await readFile(join(repo, path), "utf8") !== text) throw new PreparationError("已有案例源码与冻结快照不符，未覆盖。");
    }
    const baseCommit = await git(repo, ["rev-parse", "--verify", "HEAD"]);
    if (!/^[a-f0-9]{40}$/.test(baseCommit)) throw new PreparationError("案例提交必须是完整 SHA-1。");
    const task = { id: entry.id, repoPath: repo, baseCommit, issue: entry.issue,
      reproduceScript: "test:reproduce", regressionScript: "test:regression", expectedFailure: entry.expectedFailure, allowedPaths: entry.allowedPaths };
    const taskPath = join(root, "tasks", `${entry.name}.json`);
    const bytes = JSON.stringify(task, null, 2) + "\n";
    await saveUnchanged(taskPath, bytes);
    await loadTask(taskPath);
    tasks.push({ path: relative(root, taskPath).split("\\").join("/"), sha256: hash(bytes) });
    prepared.push({ id: task.id, baseCommit, taskPath });
  }
  const suitePath = join(root, "suite.json");
  await saveUnchanged(suitePath, JSON.stringify({ id: manifest.id, tasks }, null, 2) + "\n");
  await loadBenchmarkSuite(suitePath);
  process.stdout.write(JSON.stringify({ kind: "constructed_cases_prepared", modelRequests: 0, suitePath, tasks: prepared }, null, 2) + "\n");
}

try { await main(); }
catch (error) {
  process.stderr.write(`${error instanceof PreparationError ? error.message : "案例准备失败；未输出原始异常，请核对清单和本地目录。"}\n`);
  process.exitCode = 1;
}

