import type { RunDetail, RunSummary } from "./run-history.ts";

const kinds: Record<string, string> = {
  baseline_check: "基准检查", source_localization: "源码定位", repair_proposal: "候选生成",
  patch_verification: "独立验收", repair_run: "修复流程", benchmark_run: "评测",
};
const statuses: Record<string, string> = {
  ready: "基准就绪（尚未修复）", located: "已定位", proposed: "候选已生成（未验收）",
  awaiting_review: "等待审阅", resolved: "修复记录为成功", unresolved: "未修复",
  not_reproduced: "未复现", error: "执行错误", completed: "评测已完成", incomplete: "评测未完成",
};
const phases: Record<string, string> = {
  "before-reproduce": "修复前 · 复现测试", "before-regression": "修复前 · 回归测试",
  "after-reproduce": "修复后 · 目标测试", "after-regression": "修复后 · 回归测试",
};
const verification = {
  passed: "历史验收通过", failed: "历史验收未通过", not_run: "尚无独立验收",
  unavailable: "验收记录缺失或无法核对",
};

export function formatRunList(result: { runs: RunSummary[]; unavailable: number }): string {
  const lines = ["历史运行记录（只读，未重新执行）"];
  if (!result.runs.length) lines.push("暂无可读取的运行记录。");
  for (const run of result.runs) {
    lines.push(`${run.id} · ${kinds[run.kind] ?? run.kind} · ${run.taskId ?? "任务未记录"}`,
      `  ${statuses[run.status] ?? run.status} · 更新时间 ${run.updatedAt}${run.attempts === null ? "" : ` · ${run.attempts} 轮`}`);
  }
  if (result.unavailable) lines.push(`另有 ${result.unavailable} 条记录暂不可读取，未将其计为成功。`);
  lines.push("使用 /report <运行ID> 查看记录的测试、原因和补丁位置。");
  return lines.join("\n");
}

export function formatRunDetail(run: RunDetail): string {
  const lines = ["历史运行报告（只读，未重新执行）", `运行 ID：${run.id}`,
    `类型：${kinds[run.kind] ?? run.kind}`, `任务：${run.taskId ?? "未记录"}`,
    `记录状态：${statuses[run.status] ?? run.status} (${run.status})`, `更新时间：${run.updatedAt}`,
    `修复轮数：${run.attempts ?? "不适用或未记录"}`, `模型调用次数：${run.modelRequests ?? "未记录"}`,
    `总耗时（记录）：${run.durationMs === null ? "未记录" : `${(run.durationMs / 1000).toFixed(1)} 秒`}`,
    `原因：${run.reason}`];
  if (run.code) lines.push(`错误码：${run.code}`);
  lines.push("", "测试记录：");
  if (!run.tests.length) lines.push("暂无可用测试记录，不能据此认定通过。");
  for (const test of run.tests) {
    lines.push(`${phases[test.phase] ?? test.phase}：通过 ${test.passed}，失败 ${test.failed}，跳过 ${test.skipped}`);
  }
  lines.push("", `独立验收：${verification[run.verification]}`,
    `补丁位置（报告记录）：${run.patchPath ?? "无"}`, `报告位置：${run.reportPath}`);
  if (run.relatedRuns.length) lines.push(`关联运行：${run.relatedRuns.join(", ")}`);
  lines.push("历史报告与补丁引用不代表本次重新验收，查看不会执行任何任务。");
  return lines.join("\n");
}
