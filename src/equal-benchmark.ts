import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BenchmarkError, loadBenchmarkSuite, type BenchmarkOutcome } from "./benchmark.ts";
import { captureTree } from "./integrity.ts";
import { DEFAULT_MODELS_PATH, MODEL, requestRepairEdits } from "./pi.ts";
import { MAX_ATTEMPTS, repairTask, type CandidateReview, type RepairStrategy } from "./repair.ts";

const hash = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
export type EqualBenchmarkRow = {
  taskId: string; taskPath: string; taskHash: string; baseCommit: string;
  order: RepairStrategy[]; basePromptHash: string | null; sourceFingerprint: string | null;
  noFeedbackReport: string | null; feedbackReport: string | null;
  noFeedback: BenchmarkOutcome | null; feedback: BenchmarkOutcome | null;
};

export function summarizeEqualBenchmark(rows: Pick<EqualBenchmarkRow, "noFeedback" | "feedback">[], actualModelRequests: number) {
  function collect(key: "noFeedback" | "feedback") {
    const statusCounts = { resolved: 0, unresolved: 0, error: 0, not_reproduced: 0, awaiting_review: 0, not_run: 0 };
    const totals = { modelRequests: 0, wallMs: 0, reviewWaitMs: 0, activeMs: 0 };
    for (const row of rows) {
      const result = row[key]; statusCounts[result?.status ?? "not_run"]++;
      if (result) for (const field of ["modelRequests", "wallMs", "reviewWaitMs", "activeMs"] as const) totals[field] += result[field];
    }
    return { statusCounts, ...totals };
  }
  return { plannedTasks: rows.length, processedTasks: rows.filter(row => row.noFeedback && row.feedback).length,
    actualModelRequests, noFeedback: collect("noFeedback"), feedback: collect("feedback") };
}

type EqualReport = {
  kind: "benchmark_run"; design: "equal_budget_independent"; suiteId: string | null; suiteHash: string | null;
  status: "completed" | "incomplete" | "error"; reason: string; code?: string;
  model: string; budgets: { noFeedback: number; feedback: number }; startedAt: string; finishedAt: string;
  environment: { node: string; npm: string; platform: string; arch: string }; inputHashes: Record<string, string>;
  rows: EqualBenchmarkRow[]; summary: ReturnType<typeof summarizeEqualBenchmark>; artifacts: { markdown: string };
};
type TrialContext = { taskId: string; strategy: RepairStrategy; attempt: number };
type ReviewContext = CandidateReview & { taskId: string; taskIndex: number; taskCount: number; strategy: RepairStrategy };

function markdown(report: EqualReport) {
  const lines = ["# RepoPilot 同预算独立对照", "",
    `任务集：${report.suiteId ?? "未加载"}；状态：${report.status}；模型：${report.model}。`, "",
    `两策略各最多 ${MAX_ATTEMPTS} 次请求尝试，独立生成和验收，不共享首候选。按任务交替先后顺序；成功、重复候选和安全停止规则可能使实际调用少于预算。`, "",
    "| 任务 | 顺序 | 无反馈结果 | 无反馈调用 | 无反馈执行 ms | 反馈结果 | 反馈调用 | 反馈执行 ms |",
    "|---|---|---|---:|---:|---|---:|---:|"];
  for (const row of report.rows) lines.push(`| ${row.taskId} | ${row.order.join(" → ")} | ${row.noFeedback?.status ?? "not_run"} | ${row.noFeedback?.modelRequests ?? 0} | ${row.noFeedback?.activeMs.toFixed(0) ?? "-"} | ${row.feedback?.status ?? "not_run"} | ${row.feedback?.modelRequests ?? 0} | ${row.feedback?.activeMs.toFixed(0) ?? "-"} |`);
  lines.push("", `固定任务数 ${report.summary.plannedTasks}，双臂已处理 ${report.summary.processedTasks}；实际请求尝试共 ${report.summary.actualModelRequests}。不共享候选，实际尝试包含两臂之和，不能套用旧 shared-first 的计数。`, "",
    "执行耗时扣除审阅回调等待，详细审阅耗时见 JSON。未审阅、错误、未复现和未运行各自计数，不计为成功或普通修复失败。输入变化时整次比较无效。", "",
    "这是固定开发任务的探索性独立采样，不能推算总体修复率或统计意义上的反馈因果收益。请求尝试计数包含失败回调，不是计费用量。", "",
    "任务、上下文与程序哈希、策略顺序、各臂修复及验收报告见 benchmark.json。", "");
  return lines.join("\n");
}

export async function runEqualBenchmark(
  suiteFile: string, review: (candidate: ReviewContext) => Promise<boolean>,
  request: (prompt: string, context: TrialContext) => Promise<unknown> = prompt => requestRepairEdits(prompt, undefined, signal),
  signal?: AbortSignal,
) {
  const runsRoot = fileURLToPath(new URL("../.repopilot/runs/", import.meta.url));
  await mkdir(runsRoot, { recursive: true });
  const directory = await mkdtemp(join(runsRoot, "bench-")), reportPath = join(directory, "benchmark.json");
  let actualModelRequests = 0;
  const report: EqualReport = {
    kind: "benchmark_run", design: "equal_budget_independent", suiteId: null, suiteHash: null,
    status: "error", reason: "同预算评测尚未完成。", model: MODEL, budgets: { noFeedback: MAX_ATTEMPTS, feedback: MAX_ATTEMPTS },
    startedAt: new Date().toISOString(), finishedAt: "", environment: { node: process.version, npm: "", platform: process.platform, arch: process.arch },
    inputHashes: {}, rows: [], summary: summarizeEqualBenchmark([], 0), artifacts: { markdown: join(directory, "benchmark.md") },
  };
  async function save() {
    report.summary = summarizeEqualBenchmark(report.rows, actualModelRequests);
    await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
    await writeFile(report.artifacts.markdown, markdown(report));
  }
  try {
    signal?.throwIfAborted();
    const suite = await loadBenchmarkSuite(suiteFile);
    report.suiteId = suite.id; report.suiteHash = suite.suiteHash;
    report.rows = suite.tasks.map((entry, index) => ({ taskId: entry.task.id, taskPath: entry.taskPath, taskHash: entry.taskHash,
      baseCommit: entry.task.baseCommit, order: index % 2 ? ["feedback", "no_feedback"] : ["no_feedback", "feedback"],
      basePromptHash: null, sourceFingerprint: null, noFeedbackReport: null, feedbackReport: null, noFeedback: null, feedback: null }));
    report.environment.npm = JSON.parse(await readFile(join(dirname(process.execPath), "node_modules/npm/package.json"), "utf8")).version;
    async function inputHashes() {
      return {
        code: (await captureTree(dirname(fileURLToPath(import.meta.url)))).fingerprint,
        schemas: (await captureTree(fileURLToPath(new URL("../schemas/", import.meta.url)))).fingerprint,
        modelConfig: hash(await readFile(DEFAULT_MODELS_PATH)), package: hash(await readFile(new URL("../package.json", import.meta.url))),
        packageLock: hash(await readFile(new URL("../package-lock.json", import.meta.url))),
      };
    }
    report.inputHashes = await inputHashes();
    async function requireInputsStable() {
      signal?.throwIfAborted();
      if (hash(await readFile(suiteFile)) !== suite.suiteHash || JSON.stringify(await inputHashes()) !== JSON.stringify(report.inputHashes)) {
        throw new BenchmarkError("BENCHMARK_INPUT_CHANGED", "任务集、模型配置或评测程序发生变化，本次比较无效。");
      }
      for (const entry of suite.tasks) if (hash(await readFile(entry.taskPath)) !== entry.taskHash) {
        throw new BenchmarkError("BENCHMARK_INPUT_CHANGED", "固定任务文件发生变化，本次比较无效。");
      }
    }
    report.status = "incomplete"; report.reason = "同预算独立对照运行中。"; await save();
    tasks: for (const [index, entry] of suite.tasks.entries()) {
      const row = report.rows[index];
      for (const strategy of row.order) {
        await requireInputsStable();
        let calls = 0;
        const trial = await repairTask(entry.taskPath, async candidate => {
          await requireInputsStable();
          const approved = await review({ ...candidate, taskId: entry.task.id, taskIndex: index + 1, taskCount: suite.tasks.length, strategy });
          await requireInputsStable(); return approved;
        }, async prompt => {
          await requireInputsStable();
          const parsed = JSON.parse(prompt);
          if (strategy === "no_feedback" && Object.hasOwn(parsed, "feedback")) throw new BenchmarkError("BENCHMARK_FEEDBACK_LEAK", "无反馈策略收到反馈字段，比较无效。");
          const { feedback: _feedback, ...base } = parsed;
          const promptHash = hash(JSON.stringify(base));
          if (row.basePromptHash && row.basePromptHash !== promptHash) throw new BenchmarkError("BENCHMARK_CONTEXT_CHANGED", "两策略的原始上下文不一致，比较无效。");
          row.basePromptHash = promptHash;
          if (calls >= MAX_ATTEMPTS) throw new BenchmarkError("BENCHMARK_BUDGET_EXCEEDED", "策略超过固定调用上限，已停止。");
          await save();
          signal?.throwIfAborted();
          calls++; actualModelRequests++;
          const result = await request(prompt, { taskId: entry.task.id, strategy, attempt: calls });
          await requireInputsStable(); return result;
        }, signal, undefined, strategy);
        const key = strategy === "no_feedback" ? "noFeedback" : "feedback";
        row[key] = { status: trial.status, ...(trial.code ? { code: trial.code } : {}), modelRequests: calls,
          wallMs: trial.wallMs, reviewWaitMs: trial.reviewWaitMs, activeMs: trial.activeMs, verificationReport: trial.artifacts.verification };
        if (strategy === "no_feedback") row.noFeedbackReport = trial.reportPath; else row.feedbackReport = trial.reportPath;
        await requireInputsStable();
        if (row.sourceFingerprint && trial.sourceFingerprint && row.sourceFingerprint !== trial.sourceFingerprint) {
          throw new BenchmarkError("BENCHMARK_CONTEXT_CHANGED", "两策略读取的原始源码不同，比较无效。");
        }
        row.sourceFingerprint ??= trial.sourceFingerprint;
        if (trial.code?.startsWith("BENCHMARK_")) throw new BenchmarkError(trial.code, "同预算比较的固定输入、上下文或调用约束失效。");
        await save();
        if (trial.status !== "resolved" && trial.status !== "unresolved") {
          report.reason = "某策略未完成有效验收，已停止后续策略和任务。"; break tasks;
        }
      }
      if (index === suite.tasks.length - 1) { report.status = "completed"; report.reason = "固定任务的同预算独立对照已完成；结果不代表总体修复率。"; }
    }
  } catch (error) {
    report.status = signal?.aborted ? "incomplete" : "error";
    report.code = signal?.aborted ? "OPERATION_CANCELLED" : error instanceof BenchmarkError ? error.code : "BENCHMARK_ERROR";
    report.reason = signal?.aborted ? "同预算评测已中断，未继续后续策略或任务。" : error instanceof BenchmarkError ? error.message : "同预算评测未完成；原始异常未输出。";
  }
  report.finishedAt = new Date().toISOString(); await save();
  return { ...report, reportPath };
}
