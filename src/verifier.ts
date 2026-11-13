import { createHash } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runBaseline, type BaselineReport } from "./baseline.ts";
import { evaluateVerification, readEvidence, type TestEvidence } from "./evidence.ts";
import { findGitExecutable } from "./git.ts";
import { assertContainedLinks, captureTree, inspectCandidate, IntegrityError, LinkBoundaryError } from "./integrity.ts";
import { executionEnvironment, runProcess } from "./process.ts";
import { emitProgress, type ProgressSink } from "./progress.ts";
import { loadTask } from "./task.ts";

type VerificationCheck = BaselineReport["checks"][number] & { snapshot?: string };
export type VerificationReport = {
  kind: "patch_verification";
  taskId: string | null;
  baseCommit: string | null;
  status: "resolved" | "unresolved" | "not_reproduced" | "error";
  reason: string;
  code?: string;
  startedAt: string;
  finishedAt: string;
  changedPaths: string[];
  checks: VerificationCheck[];
  candidateHash?: string;
  patchHash?: string;
  integrity: { baseline?: string; candidate?: string; final?: string; stable: boolean; replayVerified: boolean };
  artifacts: { baseline: string; worktree: string | null; replayWorktree: string | null; inputPatch: string | null; patch: string | null; logs: string[] };
};

class VerificationError extends Error {
  readonly status: "error" | "unresolved";
  readonly code: string;
  constructor(status: "error" | "unresolved", code: string, message: string) {
    super(message); this.status = status; this.code = code;
  }
}

const hash = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");

async function hostSnapshot(taskFile: string) {
  const codeRoot = dirname(fileURLToPath(import.meta.url));
  const schemaRoot = fileURLToPath(new URL("../schemas/", import.meta.url));
  await assertContainedLinks(codeRoot);
  await assertContainedLinks(schemaRoot);
  const code = await captureTree(codeRoot);
  const schemas = await captureTree(schemaRoot);
  const files = [taskFile, fileURLToPath(new URL("../package.json", import.meta.url)), fileURLToPath(new URL("../package-lock.json", import.meta.url))];
  const hashes = await Promise.all(files.map(async file => hash(await readFile(file))));
  const state = { code: code.fingerprint, schemas: schemas.fingerprint, task: hashes[0], package: hashes[1], lock: hashes[2] };
  return { ...state, fingerprint: hash(JSON.stringify(state)) };
}

export async function verifyPatch(taskFile: string, patchFile: string, signal?: AbortSignal, onProgress?: ProgressSink) {
  const startedAt = new Date().toISOString();
  const hostBefore = await hostSnapshot(taskFile).catch(() => undefined);
  const baseline = await runBaseline(taskFile, signal, onProgress);
  const runDir = dirname(baseline.reportPath);
  const logsDir = join(runDir, "logs");
  const reportPath = join(runDir, "report.json");
  const patchPath = join(runDir, "patch.diff");
  const report: VerificationReport = {
    kind: "patch_verification", taskId: baseline.taskId, baseCommit: baseline.baseCommit,
    status: baseline.baselineStatus === "not_reproduced" ? "not_reproduced" : "error",
    reason: baseline.reason, startedAt, finishedAt: "", changedPaths: [], checks: [...baseline.checks],
    integrity: { stable: false, replayVerified: false },
    artifacts: { baseline: baseline.reportPath, worktree: baseline.artifacts.worktree, replayWorktree: null,
      inputPatch: null, patch: null, logs: [...baseline.artifacts.logs] },
  };
  const env = executionEnvironment();
  env.NPM_CONFIG_USERCONFIG = join(runDir, "empty-user.npmrc");
  env.NPM_CONFIG_GLOBALCONFIG = join(runDir, "empty-global.npmrc");

  async function record(name: string, value: object) {
    const path = join(logsDir, `${name}.json`);
    await writeFile(path, JSON.stringify(value, null, 2) + "\n");
    report.artifacts.logs.push(path);
  }
  async function execute(executable: string, args: string[], cwd: string, phase: string, script: string | null = null, captureOutput = false) {
    signal?.throwIfAborted();
    const result = await runProcess(executable, args, { cwd, env, timeoutMs: 120_000, captureOutput, signal });
    const { stdout: _stdout, ...publicResult } = result;
    const logPath = join(logsDir, `${String(report.checks.length + 1).padStart(2, "0")}-${phase}.json`);
    const check: VerificationCheck = { phase, script, command: [executable, ...args], ...publicResult, logPath };
    report.checks.push(check);
    report.artifacts.logs.push(logPath);
    await writeFile(logPath, JSON.stringify(check, null, 2) + "\n");
    signal?.throwIfAborted();
    if (result.timedOut || result.interrupted) throw new VerificationError("error", result.timedOut ? "COMMAND_TIMEOUT" : "COMMAND_INTERRUPTED", "验收命令超时或被中断。");
    if (result.executionError || result.outputTruncated || result.exitCode === null) throw new VerificationError("error", "COMMAND_EXECUTION_FAILED", "验收命令未能可靠执行。");
    return { result, check };
  }

  if (baseline.baselineStatus === "ready") {
    try {
      if (!hostBefore) throw new VerificationError("error", "HOST_SNAPSHOT_FAILED", "无法建立宿主验收程序与任务的完整性记录。");
      await record("host-before", hostBefore);
      async function requireHostStable() {
        signal?.throwIfAborted();
        const current = await hostSnapshot(taskFile);
        if (current.fingerprint !== hostBefore!.fingerprint) throw new VerificationError("error", "HOST_CHANGED", "任务或宿主验收程序在运行中被改变，证据不可用于成功结论。");
        if (report.artifacts.inputPatch && hash(await readFile(report.artifacts.inputPatch)) !== report.candidateHash) {
          throw new VerificationError("error", "INPUT_PATCH_CHANGED", "候选补丁副本在运行中被改变。");
        }
      }
      await requireHostStable();
      const task = await loadTask(taskFile);
      const worktree = baseline.artifacts.worktree!;
      const gitExecutable = await findGitExecutable(env);
      if (!gitExecutable) throw new VerificationError("error", "GIT_NOT_FOUND", "未找到可执行的 Git。");
      async function git(args: string[], phase: string, cwd = worktree, invalidPatch = false, captureOutput = false) {
        const { result } = await execute(gitExecutable!, ["-c", "core.quotePath=false", ...args], cwd, phase, null, captureOutput);
        if (result.exitCode !== 0) throw new VerificationError(invalidPatch ? "unresolved" : "error", invalidPatch ? "PATCH_INVALID" : "GIT_CHECK_FAILED", invalidPatch ? "候选补丁无法完整应用到故障基准。" : "验收所需的 Git 检查未通过。");
        return result.stdout.trim();
      }
      async function requireHeadStable() {
        if (await git(["rev-parse", "HEAD"], "candidate-head", worktree, false, true) !== task.baseCommit) {
          throw new VerificationError("unresolved", "HEAD_CHANGED", "候选执行改变了基准提交，不能验收。");
        }
      }
      await assertContainedLinks(worktree);
      const before = await captureTree(worktree);
      report.integrity.baseline = before.fingerprint;
      await record("snapshot-before", before);
      const input = await readFile(patchFile).catch(() => { throw new VerificationError("error", "PATCH_READ_FAILED", "无法读取候选补丁文件。"); });
      if (!input.toString("utf8").trim()) throw new VerificationError("unresolved", "PATCH_EMPTY", "候选补丁为空，不能计为修复。");
      report.candidateHash = hash(input);
      report.artifacts.inputPatch = join(runDir, "candidate-input.diff");
      await writeFile(report.artifacts.inputPatch, input);
      await git(["apply", "--check", "-p1", "--whitespace=nowarn", "--", report.artifacts.inputPatch], "patch-check", worktree, true);
      await git(["apply", "-p1", "--whitespace=nowarn", "--", report.artifacts.inputPatch], "patch-apply", worktree, true);
      const candidate = await captureTree(worktree);
      report.integrity.candidate = candidate.fingerprint;
      await record("snapshot-candidate", candidate);
      const scope = inspectCandidate(before, candidate, task.allowedPaths);
      report.changedPaths = scope.changedPaths;
      if (!scope.valid) throw new VerificationError("unresolved", "PATCH_SCOPE_INVALID", scope.reason);
      await requireHeadStable();
      await requireHostStable();

      async function requireCandidateStable(phase: string) {
        const snapshot = await captureTree(worktree);
        report.integrity.final = snapshot.fingerprint;
        await record(`snapshot-${phase}`, snapshot);
        if (snapshot.fingerprint !== candidate.fingerprint) {
          report.changedPaths = inspectCandidate(before, snapshot, task.allowedPaths).changedPaths;
          throw new VerificationError("unresolved", "SNAPSHOT_CHANGED", "执行测试期间代码、测试或依赖发生变化，不能把结果归于同一候选补丁。");
        }
        await assertContainedLinks(worktree);
        await requireHeadStable();
        await requireHostStable();
      }
      const npmCli = join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
      const reporter = new URL(import.meta.url.endsWith(".ts") ? "./test-reporter.ts" : "./test-reporter.js", import.meta.url).href;
      async function testScript(script: string, phase: string) {
        const evidencePath = join(logsDir, `${phase}.jsonl`);
        env.NODE_OPTIONS = `--test-reporter=${reporter} --test-reporter-destination="${evidencePath.replaceAll("\\", "/")}"`;
        env.REPOPILOT_EVIDENCE_PATH = evidencePath;
        const execution = await execute(process.execPath, [npmCli, "run", "--ignore-scripts", script], worktree, phase, script);
        execution.check.snapshot = candidate.fingerprint;
        for (const path of [evidencePath, `${evidencePath}.writer`, `${evidencePath}.multiple`]) {
          if ((await stat(path).catch(() => undefined))?.isFile()) report.artifacts.logs.push(path);
        }
        let tests: TestEvidence[] | undefined;
        try { tests = await readEvidence(evidencePath, worktree, true); }
        catch { /* File integrity is checked before classifying an evidence failure. */ }
        if (tests) execution.check.tests = tests;
        await writeFile(execution.check.logPath, JSON.stringify(execution.check, null, 2) + "\n");
        await requireCandidateStable(phase);
        if (!tests) throw new VerificationError("error", "EVIDENCE_INVALID", "候选测试的结构化证据缺失或不可靠。");
        return { tests, exitCode: execution.result.exitCode };
      }
      emitProgress("target-tests", onProgress, signal);
      const reproduce = await testScript(task.reproduceScript, "after-reproduce");
      emitProgress("regression-tests", onProgress, signal);
      const regression = await testScript(task.regressionScript, "after-regression");
      const beforeReproduce = baseline.checks.find(check => check.phase === "before-reproduce")!.tests!;
      const beforeRegression = baseline.checks.find(check => check.phase === "before-regression")!.tests!;
      const conclusion = evaluateVerification(beforeReproduce, beforeRegression, reproduce.tests, regression.tests, task.expectedFailure, reproduce.exitCode, regression.exitCode);
      if (conclusion.status === "error") throw new VerificationError("error", "EVIDENCE_INCONSISTENT", conclusion.reason);

      await git(["diff", "--no-ext-diff", "--no-textconv", "--no-color", "--no-relative", "--default-prefix", "--no-renames", "--binary", "--full-index", `--output=${patchPath}`, task.baseCommit, "--"], "export-patch");
      if (!(await stat(patchPath)).size) throw new VerificationError("unresolved", "PATCH_EMPTY", "最终代码没有可交付的非空补丁。");
      report.patchHash = hash(await readFile(patchPath));
      emitProgress("replay", onProgress, signal);
      const replay = join(runDir, "patch-replay");
      const noHooks = join(runDir, "empty-hooks");
      await mkdir(noHooks, { recursive: true });
      await git(["-c", `core.hooksPath=${noHooks}`, "worktree", "add", "--detach", replay, task.baseCommit], "replay-worktree");
      report.artifacts.replayWorktree = replay;
      const replayBefore = await captureTree(replay);
      await git(["apply", "-p1", "--whitespace=nowarn", "--", patchPath], "replay-patch", replay);
      const replayAfter = await captureTree(replay);
      await record("snapshot-replay", replayAfter);
      const replayScope = inspectCandidate(replayBefore, replayAfter, task.allowedPaths);
      const sameSource = task.allowedPaths.every(path => JSON.stringify(candidate.files[path]) === JSON.stringify(replayAfter.files[path]));
      if (!replayScope.valid || !sameSource) throw new VerificationError("error", "PATCH_REPLAY_MISMATCH", "导出的补丁不能重建实际测试的源码。");
      report.integrity.replayVerified = true;
      await requireCandidateStable("final");
      if (hash(await readFile(patchPath)) !== report.patchHash) throw new VerificationError("error", "PATCH_ARTIFACT_CHANGED", "导出的补丁在验收过程中被改变。");
      signal?.throwIfAborted();
      report.integrity.stable = true;
      report.artifacts.patch = patchPath;
      report.status = conclusion.status;
      report.reason = conclusion.reason;
    } catch (error) {
      report.status = signal?.aborted ? "error" : error instanceof VerificationError ? error.status : "error";
      report.code = signal?.aborted ? "OPERATION_CANCELLED" : error instanceof VerificationError || error instanceof IntegrityError || error instanceof LinkBoundaryError ? error.code : "VERIFICATION_ERROR";
      report.reason = signal?.aborted ? "操作已取消。" : error instanceof VerificationError || error instanceof IntegrityError || error instanceof LinkBoundaryError ? error.message : "补丁验收未完成；原始异常未输出。";
      await rm(patchPath, { force: true }).catch(() => {});
      delete report.patchHash;
    }
  } else if (baseline.code) {
    report.code = baseline.code;
  }
  report.finishedAt = new Date().toISOString();
  await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
  return { ...report, reportPath };
}
