import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { LocalizationError } from "./localization.ts";
import { MODEL, requestRepairEdits } from "./pi.ts";
import { proposeRepair } from "./proposal.ts";
import { emitProgress, type ProgressSink } from "./progress.ts";
import { loadTask, TaskInputError } from "./task.ts";
import { verifyPatch, type VerificationReport } from "./verifier.ts";

export const MAX_ATTEMPTS = 3;
export type RepairStrategy = "feedback" | "no_feedback";
const MAX_CONTEXT_BYTES = 32 * 1024;
const hash = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");

export type CandidateReview = { attempt: number; patchPath: string; candidateHash: string; proposalReport: string };

export function canRetryVerification(report: VerificationReport): boolean {
  if (report.status !== "unresolved" || report.code || !report.integrity.stable || !report.integrity.replayVerified) return false;
  const checks = ["after-reproduce", "after-regression"].map(phase => report.checks.filter(check => check.phase === phase));
  if (checks.some(group => group.length !== 1)) return false;
  const stages = checks.map(group => group[0]);
  return stages.every(check => check.tests?.length && check.tests.every(test => test.status === "passed" || test.status === "failed")
    && check.exitCode === (check.tests.some(test => test.status === "failed") ? 1 : 0))
    && stages.some(check => check.tests!.some(test => test.status === "failed"));
}

export function buildFeedbackPrompt(basePrompt: string, previousCandidate: string, verification: VerificationReport): string {
  if (!canRetryVerification(verification)) throw new LocalizationError("FEEDBACK_INVALID", "验收证据不满足继续修复的条件。");
  const prompt = JSON.stringify({
    ...JSON.parse(basePrompt),
    feedback: {
      previousCandidate,
      checks: verification.checks.filter(check => check.phase === "after-reproduce" || check.phase === "after-regression").map(check => ({
        phase: check.phase, exitCode: check.exitCode,
        tests: check.tests!.map(test => ({ file: test.file, fullName: test.fullName, status: test.status, assertionFailure: test.assertionFailure })),
      })),
    },
  });
  if (Buffer.byteLength(prompt) > MAX_CONTEXT_BYTES) throw new LocalizationError("CONTEXT_TOO_LARGE", "源码上下文与上次候选、失败证据合计超过 32 KiB，已停止重试。");
  return prompt;
}

type RepairStatus = "awaiting_review" | "resolved" | "unresolved" | "not_reproduced" | "error";

type Attempt = {
  number: number; proposalReport: string | null; patch: string | null; candidateHash: string | null;
  reviewed: boolean; verificationReport: string | null; contextBytes: number; feedbackIncluded: boolean;
  status: RepairStatus; code?: string; modelRequests: number;
  wallMs: number; reviewWaitMs: number; activeMs: number; cumulativeWallMs: number;
};
type RepairReport = {
  kind: "repair_run"; taskId: string | null; baseCommit: string | null; taskHash: string | null; model: string;
  strategy: RepairStrategy;
  status: RepairStatus;
  reason: string; code?: string; maxAttempts: number; modelRequests: number;
  startedAt: string; finishedAt: string; selectedPaths: string[]; sourceFingerprint: string | null;
  attempts: Attempt[]; artifacts: { patch: string | null; verification: string | null };
  wallMs: number; reviewWaitMs: number; activeMs: number;
};

export async function repairTask(
  taskFile: string, review: (candidate: CandidateReview) => Promise<boolean>,
  request: (prompt: string) => Promise<unknown> = prompt => requestRepairEdits(prompt, undefined, signal), signal?: AbortSignal,
  onProgress?: ProgressSink,
  strategy: RepairStrategy = "feedback",
) {
  const started = performance.now();
  const runsRoot = fileURLToPath(new URL("../.repopilot/runs/", import.meta.url));
  await mkdir(runsRoot, { recursive: true });
  const runDir = await mkdtemp(join(runsRoot, "repair-"));
  const reportPath = join(runDir, "repair.json");
  const report: RepairReport = {
    kind: "repair_run", taskId: null, baseCommit: null, taskHash: null, model: MODEL, strategy,
    status: "error", reason: "修复流程尚未完成。", maxAttempts: MAX_ATTEMPTS, modelRequests: 0,
    startedAt: new Date().toISOString(), finishedAt: "", selectedPaths: [], sourceFingerprint: null,
    attempts: [], artifacts: { patch: null, verification: null },
    wallMs: 0, reviewWaitMs: 0, activeMs: 0,
  };
  const save = () => writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
  try {
    signal?.throwIfAborted();
    const taskBytes = await readFile(taskFile);
    const task = await loadTask(taskFile);
    report.taskId = task.id;
    report.baseCommit = task.baseCommit;
    report.taskHash = hash(taskBytes);
    async function requireTaskStable() {
      signal?.throwIfAborted();
      const current = await readFile(taskFile).catch(() => undefined);
      if (!current?.equals(taskBytes)) throw new LocalizationError("TASK_CHANGED", "修复期间任务文件已变化，已停止。");
    }
    await requireTaskStable();
    let feedback: { patch: string; verification: VerificationReport } | undefined;
    const seenCandidates = new Set<string>();
    for (let number = 1; number <= MAX_ATTEMPTS; number++) {
      await requireTaskStable();
      const progress: ProgressSink | undefined = onProgress && (event => onProgress({ ...event, attempt: number }));
      const attemptStarted = performance.now();
      const attempt: Attempt = { number, proposalReport: null, patch: null, candidateHash: null,
        reviewed: false, verificationReport: null, contextBytes: 0, feedbackIncluded: strategy === "feedback" && Boolean(feedback),
        status: "error", modelRequests: 0, wallMs: 0, reviewWaitMs: 0, activeMs: 0, cumulativeWallMs: 0 };
      report.attempts.push(attempt);
      try {
        const proposal = await proposeRepair(taskFile, async basePrompt => {
          await requireTaskStable();
          const base = JSON.parse(basePrompt) as { issue: string; expectedFailure: string; sources: Array<{ path: string; content: string }> };
          const fingerprint = hash(JSON.stringify({ issue: base.issue, expectedFailure: base.expectedFailure, sources: base.sources }));
          if (report.sourceFingerprint && report.sourceFingerprint !== fingerprint) {
            throw new LocalizationError("SOURCE_SELECTION_CHANGED", "本次定位文件或原始源码与首轮不同，已停止重试。");
          }
          report.sourceFingerprint = fingerprint;
          report.selectedPaths = base.sources.map(source => source.path);
          const prompt = strategy === "feedback" && feedback ? buildFeedbackPrompt(basePrompt, feedback.patch, feedback.verification) : basePrompt;
          attempt.contextBytes = Buffer.byteLength(prompt);
          report.modelRequests++;
          attempt.modelRequests++;
          return request(prompt);
        }, signal, progress);
        attempt.proposalReport = proposal.reportPath;
        attempt.patch = proposal.artifacts.patch;
        if (proposal.status !== "proposed" || !attempt.patch) {
          report.status = proposal.status === "not_reproduced" ? "not_reproduced" : "error";
          report.reason = proposal.reason;
          if (proposal.code) report.code = proposal.code;
          break;
        }
        await requireTaskStable();
        const candidate = await readFile(attempt.patch);
        const candidateHash = hash(candidate);
        attempt.candidateHash = candidateHash;
        if (seenCandidates.has(candidateHash)) {
          report.status = "unresolved";
          report.code = "DUPLICATE_CANDIDATE";
          report.reason = "模型重复提交相同补丁，已停止重试。";
          break;
        }
        seenCandidates.add(candidateHash);
        report.status = "awaiting_review";
        report.reason = "候选补丁已生成，确认审阅后才进行独立验收。";
        await save();
        emitProgress("review", progress, signal);
        const reviewStarted = performance.now();
        let approved: boolean;
        try {
          approved = await review({ attempt: number, patchPath: attempt.patch, candidateHash, proposalReport: proposal.reportPath });
        } finally {
          attempt.reviewWaitMs = performance.now() - reviewStarted;
          report.reviewWaitMs += attempt.reviewWaitMs;
        }
        signal?.throwIfAborted();
        if (!approved) break;
        attempt.reviewed = true;
        await requireTaskStable();
        if (hash(await readFile(attempt.patch)) !== candidateHash) throw new LocalizationError("CANDIDATE_CHANGED", "候选补丁与审阅指纹不同，已停止。");
        emitProgress("verify", progress, signal);
        const verification = await verifyPatch(taskFile, attempt.patch, signal, progress);
        attempt.verificationReport = verification.reportPath;
        report.artifacts.verification = verification.reportPath;
        await requireTaskStable();
        if (verification.candidateHash && verification.candidateHash !== candidateHash
          || hash(await readFile(attempt.patch)) !== candidateHash) {
          throw new LocalizationError("CANDIDATE_CHANGED", "验收输入与审阅的候选补丁不同，已停止。");
        }
        report.status = verification.status;
        report.reason = verification.reason;
        if (verification.code) report.code = verification.code;
        if (verification.status === "resolved") {
          if (!verification.integrity.stable || !verification.integrity.replayVerified || !verification.artifacts.patch
            || hash(await readFile(verification.artifacts.patch)) !== verification.patchHash) {
            throw new LocalizationError("VERIFIED_PATCH_INVALID", "无法核对本次验收的交付补丁，已停止。");
          }
          report.artifacts.patch = verification.artifacts.patch;
          break;
        }
        if (!canRetryVerification(verification)) break;
        if (number === MAX_ATTEMPTS) {
          report.code = "ATTEMPT_LIMIT";
          report.reason = "已达到 3 次候选上限，仍未修复。";
          break;
        }
        feedback = { patch: candidate.toString("utf8"), verification };
        await save();
      } finally {
        const finished = performance.now();
        attempt.wallMs = finished - attemptStarted;
        attempt.activeMs = Math.max(0, attempt.wallMs - attempt.reviewWaitMs);
        attempt.cumulativeWallMs = finished - started;
        attempt.status = report.status;
        if (report.code) attempt.code = report.code;
      }
    }
  } catch (error) {
    report.status = "error";
    report.code = signal?.aborted ? "OPERATION_CANCELLED" : error instanceof LocalizationError || error instanceof TaskInputError ? error.code : "REPAIR_ERROR";
    report.reason = signal?.aborted ? "操作已取消。" : error instanceof LocalizationError || error instanceof TaskInputError ? error.message : "修复流程未完成；原始异常未输出。";
    report.artifacts.patch = null;
    const attempt = report.attempts.at(-1);
    if (attempt) {
      attempt.status = "error";
      attempt.code = report.code;
    }
  }
  report.wallMs = performance.now() - started;
  report.activeMs = Math.max(0, report.wallMs - report.reviewWaitMs);
  report.finishedAt = new Date().toISOString();
  await save();
  return { ...report, reportPath };
}
