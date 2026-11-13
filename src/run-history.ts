import { constants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export type RunSummary = {
  id: string;
  kind: string;
  taskId: string | null;
  status: string;
  updatedAt: string;
  attempts: number | null;
};
export type RunDetail = RunSummary & {
  reason: string;
  code?: string;
  reportPath: string;
  patchPath: string | null;
  verification: "passed" | "failed" | "not_run" | "unavailable";
  tests: { phase: string; passed: number; failed: number; skipped: number }[];
  modelRequests: number | null;
  durationMs: number | null;
  relatedRuns: string[];
};
export type RunOptions = { directory?: string; apiKey?: string; signal?: AbortSignal };

const defaultDirectory = fileURLToPath(new URL("../.repopilot/runs/", import.meta.url));
const runId = /^(?:baseline|repair|bench)-[A-Za-z0-9]{6}$/;
const MAX_BYTES = 2 * 1024 * 1024;
const phases = ["before-reproduce", "before-regression", "after-reproduce", "after-regression"];
const reports: Record<string, { kind: string; statuses: string[] }> = {
  "baseline.json": { kind: "baseline_check", statuses: ["ready", "not_reproduced", "error"] },
  "location.json": { kind: "source_localization", statuses: ["located", "not_reproduced", "error"] },
  "proposal.json": { kind: "repair_proposal", statuses: ["proposed", "not_reproduced", "error"] },
  "report.json": { kind: "patch_verification", statuses: ["resolved", "unresolved", "not_reproduced", "error"] },
  "repair.json": { kind: "repair_run", statuses: ["awaiting_review", "resolved", "unresolved", "not_reproduced", "error"] },
  "benchmark.json": { kind: "benchmark_run", statuses: ["completed", "incomplete", "error"] },
};

export class RunHistoryError extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(message); this.name = "RunHistoryError"; this.code = code; }
}

function invalid(): never { throw new RunHistoryError("RUN_REPORT_INVALID", "运行报告格式无效或文件尚未写完。"); }
function unreadable(): never { throw new RunHistoryError("RUN_READ_FAILED", "无法读取指定的本地运行报告。"); }
function tooLarge(): never { throw new RunHistoryError("RUN_REPORT_TOO_LARGE", "运行报告超过读取上限，未截断内容。"); }
function cancelled(options: RunOptions) {
  if (options.signal?.aborted) throw new RunHistoryError("RUN_HISTORY_CANCELLED", "已取消读取运行历史。");
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}
function optionalRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function safeString(value: unknown, options: RunOptions, multiline = false, limit = 8192): string {
  if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value) > limit) invalid();
  const controls = multiline ? /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]|\r(?!\n)/ : /[\x00-\x1f\x7f-\x9f]/;
  if (controls.test(value) || /\bsk-[A-Za-z0-9_-]{16,}\b/.test(value)
    || Boolean(options.apiKey && (value.includes(options.apiKey) || value.includes(JSON.stringify(options.apiKey).slice(1, -1))))) {
    throw new RunHistoryError("RUN_UNSAFE_CONTENT", "运行报告含控制字符或疑似凭据，未显示该记录。");
  }
  return value;
}
function nonnegative(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) invalid();
  return value;
}
async function directory(path: string, options: RunOptions, missingAllowed = false): Promise<boolean> {
  cancelled(options);
  try {
    const info = await lstat(path);
    cancelled(options);
    if (!info.isDirectory()) unreadable();
    return true;
  } catch (error) {
    cancelled(options);
    if (missingAllowed && (error as NodeJS.ErrnoException).code === "ENOENT") return false;
    if (error instanceof RunHistoryError) throw error;
    unreadable();
  }
}

async function readReport(root: string, id: string, name: string, options: RunOptions) {
  const folder = join(root, id);
  await directory(folder, options);
  const path = join(folder, name);
  let bytes: Buffer;
  let updatedAt: string;
  try {
    const before = await lstat(path);
    cancelled(options);
    if (!before.isFile()) unreadable();
    const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0));
    try {
      const info = await file.stat();
      if (!info.isFile() || info.dev !== before.dev || info.ino !== before.ino) unreadable();
      if (info.size > MAX_BYTES) tooLarge();
      const buffer = Buffer.allocUnsafe(MAX_BYTES + 1);
      let length = 0;
      while (length < buffer.length) {
        cancelled(options);
        const { bytesRead } = await file.read(buffer, length, buffer.length - length, length);
        if (!bytesRead) break;
        length += bytesRead;
      }
      if (length > MAX_BYTES) tooLarge();
      const after = await file.stat();
      if (after.size !== info.size || after.mtimeMs !== info.mtimeMs || length !== after.size) invalid();
      bytes = buffer.subarray(0, length);
      updatedAt = after.mtime.toISOString();
    } finally { await file.close(); }
    await directory(root, options);
    await directory(folder, options);
  } catch (error) {
    cancelled(options);
    if (error instanceof RunHistoryError) throw error;
    unreadable();
  }
  cancelled(options);
  let value: unknown;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes)); }
  catch { invalid(); }
  const data = record(value);
  if (data.kind !== reports[name].kind) invalid();
  return { data, path: safeString(path, options, false, 4096), updatedAt };
}

async function selectReport(root: string, id: string, options: RunOptions) {
  const names = id.startsWith("repair-") ? ["repair.json"] : id.startsWith("bench-")
    ? ["benchmark.json"] : ["report.json", "proposal.json", "location.json", "baseline.json"];
  await directory(join(root, id), options);
  for (const name of names) {
    cancelled(options);
    try { await lstat(join(root, id, name)); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      unreadable();
    }
    return { ...await readReport(root, id, name, options), name };
  }
  unreadable();
}

function summary(id: string, data: Record<string, unknown>, name: string, updatedAt: string, options: RunOptions): RunSummary {
  const kind = reports[name].kind;
  const status = data[kind === "baseline_check" ? "baselineStatus" : "status"];
  if (typeof status !== "string" || !reports[name].statuses.includes(status)) invalid();
  let taskId: string | null = null;
  if (data.taskId !== undefined && data.taskId !== null) {
    taskId = safeString(data.taskId, options, false, 64);
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(taskId)) invalid();
  }
  if (kind !== "benchmark_run" && data.taskId === undefined) invalid();
  let attempts: number | null = null;
  if (kind === "repair_run") {
    if (!Array.isArray(data.attempts)) invalid();
    attempts = data.attempts.length;
  }
  return { id, kind, taskId, status, updatedAt, attempts };
}

function testCounts(data: Record<string, unknown>): RunDetail["tests"] {
  if (data.checks === undefined) return [];
  if (!Array.isArray(data.checks)) invalid();
  const counts: RunDetail["tests"] = [];
  for (const value of data.checks) {
    const check = record(value);
    if (typeof check.phase !== "string" || !phases.includes(check.phase)) continue;
    if (check.tests === undefined) continue;
    if (!Array.isArray(check.tests)) invalid();
    if (!check.tests.length) continue;
    const count = { phase: check.phase, passed: 0, failed: 0, skipped: 0 };
    for (const test of check.tests) {
      const status = record(test).status;
      if (status !== "passed" && status !== "failed" && status !== "skipped") invalid();
      count[status]++;
    }
    counts.push(count);
  }
  return counts;
}
function testIdentities(check: Record<string, unknown>): Map<string, number> | null {
  const identities = new Map<string, number>();
  for (const value of check.tests as unknown[]) {
    const test = record(value);
    if (typeof test.file !== "string" || !test.file.trim() || typeof test.fullName !== "string" || !test.fullName.trim()) return null;
    const identity = JSON.stringify([test.file, test.fullName]);
    identities.set(identity, (identities.get(identity) ?? 0) + 1);
  }
  return identities;
}
function verificationStatus(data: Record<string, unknown>, counts: RunDetail["tests"]): RunDetail["verification"] {
  if (data.status === "unresolved") return "failed";
  const integrity = optionalRecord(data.integrity);
  const artifacts = optionalRecord(data.artifacts);
  if (data.status !== "resolved" || integrity.stable !== true || integrity.replayVerified !== true
    || typeof artifacts.patch !== "string" || !artifacts.patch.trim()) return "unavailable";
  if (phases.some(phase => counts.filter(count => count.phase === phase).length !== 1)) return "unavailable";
  const checks = (data.checks as unknown[]).map(record);
  for (const phase of phases) {
    const check = checks.find(item => item.phase === phase)!;
    if (check.exitCode !== (phase === "before-reproduce" ? 1 : 0)
      || ["timedOut", "interrupted", "executionError", "outputTruncated"].some(flag => check[flag] !== false)
      || (check.tests as unknown[]).map(record).some(test => test.assertionFailure !== (test.status === "failed"))) return "unavailable";
  }
  for (const [before, after] of [["before-reproduce", "after-reproduce"], ["before-regression", "after-regression"]]) {
    const original = testIdentities(checks.find(item => item.phase === before)!);
    const actual = testIdentities(checks.find(item => item.phase === after)!);
    if (!original || !actual || [...original].some(([identity, count]) => actual.get(identity) !== count)) return "unavailable";
  }
  const before = counts.find(count => count.phase === "before-reproduce")!;
  if (!before.failed || before.skipped) return "unavailable";
  return counts.filter(count => count.phase !== "before-reproduce").every(count => count.passed > 0 && count.failed === 0 && count.skipped === 0)
    ? "passed" : "unavailable";
}
function reference(root: string, value: unknown, options: RunOptions): { id: string; name: string } | null {
  if (value === undefined || value === null || value === "") return null;
  const path = safeString(value, options, false, 4096);
  if (!isAbsolute(path)) return null;
  const parts = relative(root, resolve(path)).split(sep);
  if (parts.length !== 2 || !runId.test(parts[0]) || !Object.hasOwn(reports, parts[1])) return null;
  return { id: parts[0], name: parts[1] };
}
function related(root: string, data: Record<string, unknown>, options: RunOptions): string[] {
  const artifacts = optionalRecord(data.artifacts);
  const values: unknown[] = [artifacts.verification, artifacts.baseline, artifacts.location];
  if (Array.isArray(data.attempts)) for (const attempt of data.attempts) {
    const item = record(attempt);
    values.push(item.proposalReport, item.verificationReport);
  }
  if (Array.isArray(data.rows)) for (const row of data.rows) {
    const item = record(row);
    values.push(item.repairReport, item.noFeedbackReport, item.feedbackReport);
  }
  return [...new Set(values.map(value => reference(root, value, options)?.id).filter((id): id is string => Boolean(id)))];
}
function duration(data: Record<string, unknown>): number | null {
  if (data.wallMs !== undefined) {
    if (typeof data.wallMs !== "number" || !Number.isFinite(data.wallMs) || data.wallMs < 0) invalid();
    return data.wallMs;
  }
  if (typeof data.startedAt !== "string" || typeof data.finishedAt !== "string") return null;
  const start = Date.parse(data.startedAt);
  const end = Date.parse(data.finishedAt);
  return Number.isFinite(start) && Number.isFinite(end) && end >= start ? end - start : null;
}

export async function loadRun(id: string, options: RunOptions = {}): Promise<RunDetail> {
  cancelled(options);
  if (!runId.test(id)) throw new RunHistoryError("RUN_ID_INVALID", "请提供运行历史列表中的完整运行编号。");
  const root = resolve(options.directory ?? defaultDirectory);
  await directory(root, options);
  const selected = await selectReport(root, id, options);
  const { data } = selected;
  const header = summary(id, data, selected.name, selected.updatedAt, options);
  const reason = safeString(data.reason, options, true);
  const code = data.code === undefined ? undefined : safeString(data.code, options, false, 64);
  if (code && !/^[A-Z][A-Z0-9_]*$/.test(code)) invalid();
  const artifacts = optionalRecord(data.artifacts);
  const patchPath = artifacts.patch === undefined || artifacts.patch === null ? null : safeString(artifacts.patch, options, false, 4096);
  let tests = testCounts(data);
  let verification: RunDetail["verification"] = header.kind === "patch_verification" ? verificationStatus(data, tests) : "not_run";
  if (header.kind === "repair_run") {
    const child = reference(root, artifacts.verification, options);
    if (artifacts.verification || header.status === "resolved") verification = "unavailable";
    if (child && child.name === "report.json" && child.id.startsWith("baseline-")) {
      try {
        const childReport = await readReport(root, child.id, child.name, options);
        const attempt = record((data.attempts as unknown[]).at(-1));
        const lastReference = reference(root, attempt.verificationReport, options);
        if (childReport.data.taskId === data.taskId && typeof data.baseCommit === "string" && childReport.data.baseCommit === data.baseCommit
          && typeof attempt.candidateHash === "string" && /^[a-f0-9]{64}$/.test(attempt.candidateHash)
          && childReport.data.candidateHash === attempt.candidateHash && attempt.reviewed === true
          && lastReference?.id === child.id && lastReference.name === child.name
          && (attempt.status === undefined || attempt.status === header.status)) {
          const childTests = testCounts(childReport.data);
          const childStatus = verificationStatus(childReport.data, childTests);
          const statusesMatch = header.status === childReport.data.status && (header.status === "resolved" || header.status === "unresolved");
          const childPatch = optionalRecord(childReport.data.artifacts).patch;
          const patchMatches = typeof childPatch === "string" && patchPath !== null
            && isAbsolute(safeString(childPatch, options, false, 4096)) && isAbsolute(patchPath)
            && relative(resolve(patchPath), resolve(childPatch)) === "";
          if (statusesMatch && (childStatus !== "passed" || patchMatches)) { tests = childTests; verification = childStatus; }
        }
      } catch { cancelled(options); }
    }
  }
  const modelRequests = header.kind === "benchmark_run"
    ? data.design === "equal_budget_independent" ? optionalRecord(data.summary).actualModelRequests
      : optionalRecord(optionalRecord(data.summary).feedback).modelRequests : data.modelRequests;
  const detail: RunDetail = { ...header, reason, ...(code ? { code } : {}), reportPath: selected.path,
    patchPath, verification, tests, modelRequests: nonnegative(modelRequests), durationMs: duration(data),
    relatedRuns: related(root, data, options).filter(relatedId => relatedId !== id) };
  cancelled(options);
  return detail;
}

export async function listRuns(options: RunOptions = {}): Promise<{ runs: RunSummary[]; unavailable: number }> {
  cancelled(options);
  const root = resolve(options.directory ?? defaultDirectory);
  if (!await directory(root, options, true)) return { runs: [], unavailable: 0 };
  let names: string[];
  try { names = await readdir(root); }
  catch { cancelled(options); unreadable(); }
  const runs: RunSummary[] = [];
  let unavailable = 0;
  for (const id of names) {
    cancelled(options);
    if (!runId.test(id)) continue;
    try {
      const detail = await loadRun(id, { ...options, directory: root });
      const { kind, taskId, status, updatedAt, attempts } = detail;
      runs.push({ id, kind, taskId, status, updatedAt, attempts });
    } catch { cancelled(options); unavailable++; }
  }
  cancelled(options);
  runs.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id));
  return { runs, unavailable };
}
