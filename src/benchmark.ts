import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import { Check } from "typebox/schema";
import { captureTree } from "./integrity.ts";
import { LocalizationError } from "./localization.ts";
import { DEFAULT_MODELS_PATH, MODEL, requestRepairEdits } from "./pi.ts";
import { repairTask, type CandidateReview } from "./repair.ts";
import { loadTask, type Task } from "./task.ts";

const hash = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const suiteSchema = Type.Object({
  id: Type.String({ minLength: 1, maxLength: 64, pattern: "^[A-Za-z0-9][A-Za-z0-9._-]*$" }),
  tasks: Type.Array(Type.Object({
    path: Type.String({ minLength: 1 }), sha256: Type.String({ minLength: 64, maxLength: 64, pattern: "^[0-9a-f]{64}$" }),
  }, { additionalProperties: false }), { minItems: 1 }),
}, { additionalProperties: false });

export class BenchmarkError extends LocalizationError {}

export async function loadBenchmarkSuite(suiteFile: string) {
  let bytes: Buffer;
  let value: unknown;
  try { bytes = await readFile(suiteFile); value = JSON.parse(bytes.toString("utf8")); }
  catch { throw new BenchmarkError("BENCHMARK_SUITE_INVALID", "无法读取有效的评测任务集 JSON。"); }
  if (!Check(suiteSchema, value)) throw new BenchmarkError("BENCHMARK_SUITE_INVALID", "评测任务集格式无效。");
  const tasks: Array<{ taskPath: string; taskHash: string; task: Task }> = [];
  const identities = new Set<string>();
  const ids = new Set<string>();
  for (const entry of value.tasks) {
    if (isAbsolute(entry.path) || /[\\:\u0000-\u001f]/.test(entry.path) || !entry.path.endsWith(".json")) {
      throw new BenchmarkError("BENCHMARK_SUITE_INVALID", "任务路径必须是相对任务集目录的 JSON 路径，使用 / 分隔。");
    }
    let taskPath: string;
    let taskHash: string;
    let task: Task;
    try {
      taskPath = await realpath(resolve(dirname(suiteFile), entry.path));
      taskHash = hash(await readFile(taskPath));
      task = await loadTask(taskPath);
    } catch { throw new BenchmarkError("BENCHMARK_TASK_INVALID", "评测任务文件缺失或不符合任务契约。"); }
    if (taskHash !== entry.sha256) throw new BenchmarkError("BENCHMARK_TASK_HASH_MISMATCH", "评测任务字节与固定哈希不符，请核对任务集版本。");
    const identity = process.platform === "win32" ? taskPath.toLowerCase() : taskPath;
    if (identities.has(identity) || ids.has(task.id)) throw new BenchmarkError("BENCHMARK_TASK_DUPLICATE", "评测任务路径和任务编号不能重复。");
    identities.add(identity);
    ids.add(task.id);
    tasks.push({ taskPath, taskHash, task });
  }
  return { id: value.id, suiteHash: hash(bytes), tasks };
}

export type BenchmarkOutcome = {
  status: "resolved" | "unresolved" | "not_reproduced" | "awaiting_review" | "error";
  code?: string; modelRequests: number; wallMs: number; reviewWaitMs: number; activeMs: number;
  verificationReport: string | null;
};
export type BenchmarkRow = {
  taskId: string; taskPath: string; taskHash: string; baseCommit: string;
  sourceFingerprint: string | null; repairReport: string | null;
  single: BenchmarkOutcome | null; feedback: BenchmarkOutcome | null;
};

export function summarizeBenchmark(rows: BenchmarkRow[]) {
  const summarize = (strategy: "single" | "feedback") => {
    const statusCounts = { resolved: 0, unresolved: 0, not_reproduced: 0, awaiting_review: 0, error: 0, not_run: 0 };
    const totals = { modelRequests: 0, wallMs: 0, reviewWaitMs: 0, activeMs: 0 };
    for (const row of rows) {
      const outcome = row[strategy];
      statusCounts[outcome?.status ?? "not_run"]++;
      if (outcome) for (const key of ["modelRequests", "wallMs", "reviewWaitMs", "activeMs"] as const) totals[key] += outcome[key];
    }
    return { statusCounts, ...totals };
  };
  return { plannedTasks: rows.length, processedTasks: rows.filter(row => row.feedback !== null).length,
    single: summarize("single"), feedback: summarize("feedback") };
}

type BenchmarkReport = {
  kind: "benchmark_run"; design: "shared_first_candidate"; suiteId: string | null; suiteHash: string | null;
  status: "completed" | "incomplete" | "error"; reason: string; code?: string;
  model: string; budgets: { single: number; feedback: number }; startedAt: string; finishedAt: string;
  environment: { node: string; npm: string; platform: string; arch: string };
  inputHashes: Record<string, string>; rows: BenchmarkRow[]; summary: ReturnType<typeof summarizeBenchmark>;
  artifacts: { markdown: string };
};

function markdown(report: BenchmarkReport) {
  const lines = ["# RepoPilot 配对冒烟评测", "",
    `任务集：${report.suiteId ?? "未加载"}；状态：${report.status}；模型：${report.model}。`, "",
    "共享首候选：首轮代表单次策略，完整运行代表最多 3 轮反馈策略。预算不同；本次结果用于流程比较，不推算总体修复率或将收益单独归因于反馈。", "",
    "| 任务 | 首轮结果 | 首轮调用 | 首轮执行 ms | 反馈结果 | 反馈总调用 | 反馈执行 ms | 反馈审阅 ms |",
    "|---|---|---:|---:|---|---:|---:|---:|"];
  for (const row of report.rows) lines.push(`| ${row.taskId} | ${row.single?.status ?? "not_run"} | ${row.single?.modelRequests ?? 0} | ${row.single?.activeMs.toFixed(0) ?? "-"} | ${row.feedback?.status ?? "not_run"} | ${row.feedback?.modelRequests ?? 0} | ${row.feedback?.activeMs.toFixed(0) ?? "-"} | ${row.feedback?.reviewWaitMs.toFixed(0) ?? "-"} |`);
  lines.push("", `固定任务数 ${report.summary.plannedTasks}，已处理 ${report.summary.processedTasks}。单次修复数 ${report.summary.single.statusCounts.resolved}，反馈修复数 ${report.summary.feedback.statusCounts.resolved}。`, "",
    `本次实际模型调用尝试 ${report.summary.feedback.modelRequests}；反馈总调用已包含共享首轮。执行时间包含模型、基准、工具与验收，已扣除审阅回调耗时。`, "",
    "未审阅、错误、未复现和未运行任务在 JSON 中分别计数，不计作已修复。输入变化导致 error 时，本次比较无效。", "",
    "任务哈希、固定提交、源码指纹、环境、逐项报告路径及完整时间记录见同目录 benchmark.json。", "");
  return lines.join("\n");
}

export async function runBenchmark(
  suiteFile: string,
  review: (candidate: CandidateReview & { taskId: string; taskIndex: number; taskCount: number }) => Promise<boolean>,
  request: (prompt: string) => Promise<unknown> = requestRepairEdits,
) {
  const runsRoot = fileURLToPath(new URL("../.repopilot/runs/", import.meta.url));
  await mkdir(runsRoot, { recursive: true });
  const directory = await mkdtemp(join(runsRoot, "bench-"));
  const reportPath = join(directory, "benchmark.json");
  const report: BenchmarkReport = {
    kind: "benchmark_run", design: "shared_first_candidate", suiteId: null, suiteHash: null,
    status: "error", reason: "评测尚未完成。", model: MODEL, budgets: { single: 1, feedback: 3 },
    startedAt: new Date().toISOString(), finishedAt: "",
    environment: { node: process.version, npm: "", platform: process.platform, arch: process.arch },
    inputHashes: {}, rows: [], summary: summarizeBenchmark([]), artifacts: { markdown: join(directory, "benchmark.md") },
  };
  async function save() {
    report.summary = summarizeBenchmark(report.rows);
    await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
    await writeFile(report.artifacts.markdown, markdown(report));
  }
  try {
    const suite = await loadBenchmarkSuite(suiteFile);
    report.suiteId = suite.id;
    report.suiteHash = suite.suiteHash;
    report.rows = suite.tasks.map(entry => ({ taskId: entry.task.id, taskPath: entry.taskPath,
      taskHash: entry.taskHash, baseCommit: entry.task.baseCommit, sourceFingerprint: null, repairReport: null, single: null, feedback: null }));
    const npm = JSON.parse(await readFile(join(dirname(process.execPath), "node_modules/npm/package.json"), "utf8")) as { version: string };
    report.environment.npm = npm.version;
    async function inputHashes() {
      return {
        code: (await captureTree(dirname(fileURLToPath(import.meta.url)))).fingerprint,
        schemas: (await captureTree(fileURLToPath(new URL("../schemas/", import.meta.url)))).fingerprint,
        modelConfig: hash(await readFile(DEFAULT_MODELS_PATH)),
        package: hash(await readFile(new URL("../package.json", import.meta.url))),
        packageLock: hash(await readFile(new URL("../package-lock.json", import.meta.url))),
      };
    }
    report.inputHashes = await inputHashes();
    async function requireInputsStable() {
      if (hash(await readFile(suiteFile)) !== suite.suiteHash || JSON.stringify(await inputHashes()) !== JSON.stringify(report.inputHashes)) {
        throw new BenchmarkError("BENCHMARK_INPUT_CHANGED", "任务集、模型配置或评测程序在运行中变化，本次比较无效。");
      }
      for (const entry of suite.tasks) {
        if (hash(await readFile(entry.taskPath)) !== entry.taskHash) throw new BenchmarkError("BENCHMARK_INPUT_CHANGED", "固定任务在运行中变化，本次比较无效。");
      }
    }
    report.status = "incomplete";
    report.reason = "评测运行中。";
    await save();
    for (const [index, entry] of suite.tasks.entries()) {
      await requireInputsStable();
      const trial = await repairTask(entry.taskPath, async candidate => {
        await requireInputsStable();
        const approved = await review({ ...candidate, taskId: entry.task.id, taskIndex: index + 1, taskCount: suite.tasks.length });
        await requireInputsStable();
        return approved;
      }, async prompt => {
        await requireInputsStable();
        const result = await request(prompt);
        await requireInputsStable();
        return result;
      });
      const first = trial.attempts[0];
      const singleWall = first?.cumulativeWallMs ?? trial.wallMs;
      const singleReview = first?.reviewWaitMs ?? trial.reviewWaitMs;
      const row = report.rows[index];
      row.repairReport = trial.reportPath;
      row.sourceFingerprint = trial.sourceFingerprint;
      row.single = { status: first?.status ?? trial.status, code: first ? first.code : trial.code,
        modelRequests: first?.modelRequests ?? trial.modelRequests, wallMs: singleWall, reviewWaitMs: singleReview,
        activeMs: Math.max(0, singleWall - singleReview), verificationReport: first?.verificationReport ?? null };
      row.feedback = { status: trial.status, code: trial.code, modelRequests: trial.modelRequests,
        wallMs: trial.wallMs, reviewWaitMs: trial.reviewWaitMs, activeMs: trial.activeMs, verificationReport: trial.artifacts.verification };
      await requireInputsStable();
      await save();
      if (trial.status !== "resolved" && trial.status !== "unresolved") {
        report.reason = "任务未完成有效验收，已保留结果并停止后续任务。";
        break;
      }
      if (index === suite.tasks.length - 1) {
        report.status = "completed";
        report.reason = "固定任务的共享首候选比较已完成。";
      }
    }
  } catch (error) {
    report.status = "error";
    report.code = error instanceof BenchmarkError ? error.code : "BENCHMARK_ERROR";
    report.reason = error instanceof BenchmarkError ? error.message : "评测未完成；原始异常未输出。";
  }
  report.finishedAt = new Date().toISOString();
  await save();
  return { ...report, reportPath };
}
