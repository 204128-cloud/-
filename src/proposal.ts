import { rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { captureTree, inspectCandidate, IntegrityError } from "./integrity.ts";
import { LocalizationError, prepareRepairContext } from "./localization.ts";
import { MODEL, PiConnectionError, requestRepairEdits } from "./pi.ts";
import { emitProgress, type ProgressSink } from "./progress.ts";
import { applyRepairEdits, RepairEditError } from "./repair-edits.ts";
import { TaskInputError } from "./task.ts";

type ProposalReport = {
  kind: "repair_proposal";
  taskId: string | null;
  baseCommit: string | null;
  model: string;
  status: "proposed" | "not_reproduced" | "error";
  reason: string;
  code?: string;
  changedPaths: string[];
  artifacts: { baseline: string; location: string; worktree: string | null; patch: string | null };
};

class ProposalError extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(message); this.code = code; }
}

export async function proposeRepair(taskFile: string, request: (prompt: string) => Promise<unknown> = prompt => requestRepairEdits(prompt, undefined, signal), signal?: AbortSignal, onProgress?: ProgressSink) {
  const { report: location, context } = await prepareRepairContext(taskFile, signal, onProgress);
  const runDir = dirname(location.reportPath);
  const reportPath = join(runDir, "proposal.json");
  const patchPath = join(runDir, "candidate.diff");
  const report: ProposalReport = {
    kind: "repair_proposal", taskId: location.taskId, baseCommit: location.baseCommit, model: MODEL,
    status: location.status === "not_reproduced" ? "not_reproduced" : "error",
    reason: location.reason, changedPaths: [],
    artifacts: { baseline: location.artifacts.baseline, location: location.reportPath, worktree: location.artifacts.worktree, patch: null },
  };
  if (location.code) report.code = location.code;

  if (context) {
    try {
      signal?.throwIfAborted();
      const { worktree, before, sources, git } = context;
      emitProgress("generate", onProgress, signal);
      const edits = applyRepairEdits(await request(context.prompt), sources);
      signal?.throwIfAborted();
      await context.assertStable();
      signal?.throwIfAborted();
      for (const [path, content] of edits) await writeFile(join(worktree, path), content, "utf8");
      const scope = inspectCandidate(before, await captureTree(worktree), [...sources.keys()]);
      if (!scope.valid) throw new ProposalError("PATCH_SCOPE_INVALID", scope.reason);
      await git(["diff", "--no-ext-diff", "--no-textconv", "--no-color", "--no-relative", "--default-prefix", "--no-renames",
        "--binary", "--full-index", `--output=${patchPath}`, location.baseCommit!, "--", ...scope.changedPaths]);
      if (!(await stat(patchPath)).size) throw new ProposalError("PATCH_EMPTY", "Git 未导出非空候选补丁。");
      report.changedPaths = scope.changedPaths;
      report.artifacts.patch = patchPath;
      report.status = "proposed";
      report.reason = "候选补丁已生成，等待审阅并独立验收。";
    } catch (error) {
      const known = error instanceof ProposalError || error instanceof RepairEditError || error instanceof PiConnectionError
        || error instanceof TaskInputError || error instanceof IntegrityError || error instanceof LocalizationError;
      report.code = signal?.aborted ? "OPERATION_CANCELLED" : known ? error.code : "PROPOSAL_ERROR";
      report.reason = signal?.aborted ? "操作已取消。" : known ? error.message : "候选补丁生成失败。";
      await rm(patchPath, { force: true }).catch(() => {});
    }
  }

  await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
  return { ...report, reportPath };
}
