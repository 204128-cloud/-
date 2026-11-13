import { createHash } from "node:crypto";
import { lstat, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { runBaseline } from "./baseline.ts";
import type { TestEvidence } from "./evidence.ts";
import { findGitExecutable } from "./git.ts";
import { captureTree, IntegrityError, type TreeSnapshot } from "./integrity.ts";
import { executionEnvironment, runProcess } from "./process.ts";
import { emitProgress, type ProgressSink } from "./progress.ts";
import { loadTask, TaskInputError } from "./task.ts";

const MAX_CONTEXT_BYTES = 32 * 1024;
const MAX_SCAN_BYTES = 1024 * 1024;
const MAX_SELECTED_FILES = 3;

export class LocalizationError extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(message); this.code = code; }
}

const ignoredTerms = new Set([
  "the", "and", "for", "from", "with", "when", "then", "this", "that", "should", "must", "are", "was",
  "test", "target", "assertion", "src", "const", "let", "export", "return", "true", "false", "undefined",
  "null", "string", "number", "function", "input", "ts", "js", "tsx", "jsx", "mjs", "cjs", "mts", "cts",
]);

function terms(text: string): Set<string> {
  const result = new Set<string>();
  for (const match of text.matchAll(/[A-Za-z][A-Za-z0-9]*|[\p{Script=Han}]+/gu)) {
    const word = match[0];
    if (/\p{Script=Han}/u.test(word)) {
      const characters = [...word];
      for (let index = 1; index < characters.length; index++) result.add(characters[index - 1] + characters[index]);
    } else {
      const parts = word.replace(/([A-Z])([A-Z][a-z])/g, "$1 $2").replace(/([a-z0-9])([A-Z])/g, "$1 $2").split(" ");
      for (const part of [word, ...parts]) {
        const value = part.toLowerCase();
        if (value.length > 1 && !ignoredTerms.has(value)) result.add(value);
      }
    }
  }
  return result;
}

type Evidence = { reproduce: TestEvidence[]; regression: TestEvidence[] };
type RankedSource = { path: string; bytes: number; score: number; pathMatches: number; contentMatches: number; selected: boolean };

export function selectContext(issue: string, expectedFailure: string, sources: Map<string, string>, evidence: Evidence) {
  const query = terms(`${issue}\n${expectedFailure}`);
  const ranking: RankedSource[] = [...sources].map(([path, content]) => {
    const pathTerms = terms(path);
    const contentTerms = terms(content);
    const pathMatches = [...query].filter(term => pathTerms.has(term)).length;
    const contentMatches = [...query].filter(term => contentTerms.has(term)).length;
    return { path, bytes: Buffer.byteLength(content), score: pathMatches * 5 + contentMatches, pathMatches, contentMatches, selected: false };
  }).sort((left, right) => right.score - left.score || (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  const scanBytes = ranking.reduce((sum, file) => sum + file.bytes, 0);
  if (scanBytes > MAX_SCAN_BYTES) throw new LocalizationError("SCAN_TOO_LARGE", "授权源码总量超过 1 MiB 的本地扫描限制。");
  const matched = ranking.filter(file => file.score > 0);
  const strategy = matched.length ? "lexical" as const : "single_file" as const;
  const candidates = matched.length ? matched : ranking.length === 1 ? ranking : [];
  if (!candidates.length) throw new LocalizationError("LOCATION_NO_MATCH", "未找到与问题或目标测试名匹配的授权源码，请补充具体符号或文件名。");
  const selected = new Map<string, string>();
  const promptFor = (files: Map<string, string>) => JSON.stringify({
    issue, expectedFailure, ...evidence,
    sources: [...files].map(([path, content]) => ({ path, content })),
  });
  for (const candidate of candidates) {
    if (selected.size === MAX_SELECTED_FILES) break;
    selected.set(candidate.path, sources.get(candidate.path)!);
    if (Buffer.byteLength(promptFor(selected)) > MAX_CONTEXT_BYTES) {
      selected.delete(candidate.path);
      if (!selected.size) throw new LocalizationError("CONTEXT_TOO_LARGE", "最高相关源码与问题、测试摘要合计超过 32 KiB，无法完整提供该文件。");
      continue;
    }
    candidate.selected = true;
  }
  const prompt = promptFor(selected);
  return { sources: selected, prompt, ranking, strategy, contextBytes: Buffer.byteLength(prompt), scanBytes };
}

async function readSources(worktree: string, paths: string[], snapshot: TreeSnapshot) {
  const sources = new Map<string, string>();
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  const root = await realpath(worktree);
  let bytes = 0;
  for (const path of paths) {
    const file = join(root, path);
    const original = snapshot.files[path];
    if (original?.kind !== "file" || await realpath(file) !== file) {
      throw new LocalizationError("SOURCE_INVALID", "任务源码必须是工作副本内的常规文件。");
    }
    const info = await lstat(file);
    if (!info.isFile() || info.nlink !== 1) throw new LocalizationError("SOURCE_INVALID", "任务源码必须是独立的常规文件。");
    if (bytes + info.size > MAX_SCAN_BYTES) throw new LocalizationError("SCAN_TOO_LARGE", "授权源码总量超过 1 MiB 的本地扫描限制。");
    const content = await readFile(file);
    if (createHash("sha256").update(content).digest("hex") !== original.hash) {
      throw new LocalizationError("WORKTREE_CHANGED", "读取源码时工作副本已变化，请重新运行定位或提议命令。");
    }
    bytes += content.byteLength;
    if (bytes > MAX_SCAN_BYTES) throw new LocalizationError("SCAN_TOO_LARGE", "授权源码总量超过 1 MiB 的本地扫描限制。");
    try {
      const text = decoder.decode(content);
      if (text.includes("\0")) throw new Error();
      sources.set(path, text);
    } catch {
      throw new LocalizationError("SOURCE_INVALID", "任务源码必须是 UTF-8 文本。");
    }
  }
  return sources;
}

type LocationReport = {
  kind: "source_localization"; taskId: string | null; baseCommit: string | null;
  status: "located" | "not_reproduced" | "error"; reason: string; code?: string;
  strategy: "lexical" | "single_file" | null; selectedPaths: string[]; ranking: RankedSource[];
  contextBytes: number; contextLimitBytes: number; scanBytes: number;
  artifacts: { baseline: string; worktree: string | null };
};

type RepairContext = {
  worktree: string; before: TreeSnapshot; sources: Map<string, string>; prompt: string;
  assertStable: () => Promise<void>; git: (args: string[]) => Promise<string>;
};

export async function prepareRepairContext(taskFile: string, signal?: AbortSignal, onProgress?: ProgressSink) {
  const taskBytes = await readFile(taskFile).catch(() => undefined);
  const baseline = await runBaseline(taskFile, signal, onProgress);
  const reportPath = join(dirname(baseline.reportPath), "location.json");
  const report: LocationReport = {
    kind: "source_localization", taskId: baseline.taskId, baseCommit: baseline.baseCommit,
    status: baseline.baselineStatus === "not_reproduced" ? "not_reproduced" : "error", reason: baseline.reason,
    strategy: null, selectedPaths: [], ranking: [], contextBytes: 0, contextLimitBytes: MAX_CONTEXT_BYTES, scanBytes: 0,
    artifacts: { baseline: baseline.reportPath, worktree: baseline.artifacts.worktree },
  };
  if (baseline.code) report.code = baseline.code;
  let context: RepairContext | undefined;
  if (baseline.baselineStatus === "ready") {
    try {
      emitProgress("localize", onProgress, signal);
      async function requireTaskStable() {
        signal?.throwIfAborted();
        const current = await readFile(taskFile).catch(() => undefined);
        if (!taskBytes || !current?.equals(taskBytes)) throw new LocalizationError("TASK_CHANGED", "任务文件已变化，请重新运行定位或提议命令。");
      }
      await requireTaskStable();
      const task = await loadTask(taskFile);
      const worktree = baseline.artifacts.worktree!;
      const env = executionEnvironment();
      const gitExecutable = await findGitExecutable(env);
      if (!gitExecutable) throw new LocalizationError("GIT_NOT_FOUND", "未找到可执行的 Git。");
      async function git(args: string[]) {
        const result = await runProcess(gitExecutable!, ["--literal-pathspecs", "-c", "core.fsmonitor=false", ...args], {
          cwd: worktree, env, timeoutMs: 30_000, captureOutput: true, signal,
        });
        signal?.throwIfAborted();
        if (result.exitCode !== 0 || result.outputTruncated) throw new LocalizationError("PROPOSAL_GIT_FAILED", "无法检查基准提交或导出候选补丁。");
        return result.stdout.trim();
      }
      async function requireHead() {
        if (await git(["rev-parse", "HEAD"]) !== task.baseCommit) throw new LocalizationError("COMMIT_MISMATCH", "工作副本与任务基准不一致。");
      }
      async function requirePlainSources(paths: string[]) {
        const attributes = (await git(["check-attr", "-z", "--all", "--", ...paths])).split("\0");
        if (attributes.some((value, index) => index % 3 === 1 && value === "filter")) {
          throw new LocalizationError("SOURCE_FILTER_UNSUPPORTED", "定位与生成候选要求授权源码不使用 Git 自定义过滤器。");
        }
      }
      await requireHead();
      await requirePlainSources(task.allowedPaths);
      const before = await captureTree(worktree);
      const selection = selectContext(task.issue, task.expectedFailure, await readSources(worktree, task.allowedPaths, before), {
        reproduce: baseline.checks.find(check => check.phase === "before-reproduce")!.tests!,
        regression: baseline.checks.find(check => check.phase === "before-regression")!.tests!,
      });
      async function assertStable() {
        await requireTaskStable();
        await requireHead();
        if ((await captureTree(worktree)).fingerprint !== before.fingerprint) {
          throw new LocalizationError("WORKTREE_CHANGED", "工作副本已变化，请重新运行定位或提议命令。");
        }
        await requirePlainSources(task.allowedPaths);
        await readSources(worktree, [...selection.sources.keys()], before);
      }
      await assertStable();
      Object.assign(report, {
        status: "located", reason: "已从授权源码中选取完整文件，等待模型提议。",
        strategy: selection.strategy, selectedPaths: [...selection.sources.keys()], ranking: selection.ranking,
        contextBytes: selection.contextBytes, scanBytes: selection.scanBytes,
      });
      context = { worktree, before, sources: selection.sources, prompt: selection.prompt, assertStable, git };
    } catch (error) {
      const known = error instanceof LocalizationError || error instanceof TaskInputError || error instanceof IntegrityError;
      report.code = signal?.aborted ? "OPERATION_CANCELLED" : known ? error.code : "LOCALIZATION_ERROR";
      report.reason = signal?.aborted ? "操作已取消。" : known ? error.message : "源码定位失败；原始异常未输出。";
    }
  }
  await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
  return { report: { ...report, reportPath }, context };
}

export async function locateTask(taskFile: string, signal?: AbortSignal, onProgress?: ProgressSink) {
  return (await prepareRepairContext(taskFile, signal, onProgress)).report;
}
