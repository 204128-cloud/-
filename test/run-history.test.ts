import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { listRuns, loadRun, RunHistoryError } from "../src/run-history.ts";

const hash = "a".repeat(64);
const baseCommit = "b".repeat(40);
const baseline = (extra: Record<string, unknown> = {}) => ({
  kind: "baseline_check", taskId: "pagination-empty-001", baseCommit,
  baselineStatus: "ready", reason: "复现目标失败，回归测试通过。", checks: [],
  startedAt: "2026-01-01T00:00:00.000Z", finishedAt: "2026-01-01T00:00:01.000Z",
  artifacts: { patch: null, worktree: null, logs: [] }, ...extra,
});
const check = (phase: string, statuses: string[]) => ({
  phase, tests: statuses.map(status => ({ file: "test.ts", fullName: "fixture", status, assertionFailure: status === "failed" })),
  exitCode: statuses.includes("failed") ? 1 : 0, timedOut: false, interrupted: false, executionError: false, outputTruncated: false,
  command: ["SHOULD_NOT_DISPLAY"], stdout: "PRIVATE_OUTPUT",
});
const verification = (folder: string, id: string, extra: Record<string, unknown> = {}) => ({
  ...baseline(), kind: "patch_verification", status: "resolved", candidateHash: hash,
  checks: [check("before-reproduce", ["failed"]), check("before-regression", ["passed", "passed"]),
    check("after-reproduce", ["passed"]), check("after-regression", ["passed", "passed"])],
  integrity: { stable: true, replayVerified: true },
  artifacts: { patch: join(folder, id, "patch.diff"), baseline: join(folder, id, "baseline.json"), logs: [] }, ...extra,
});
const repair = (folder: string, reference: string, extra: Record<string, unknown> = {}) => ({
  ...baseline(), kind: "repair_run", status: "resolved", modelRequests: 2, wallMs: 1200.25,
  attempts: [{ number: 1, candidateHash: hash, reviewed: true, modelRequests: 2,
    verificationReport: reference, proposalReport: join(folder, "baseline-A1B2C3", "proposal.json") }],
  artifacts: { patch: join(dirname(reference), "patch.diff"), verification: reference }, ...extra,
});
const errorCode = (code: string) => (error: unknown) => error instanceof RunHistoryError && error.code === code;

async function directory(t: TestContext) {
  const root = resolve(tmpdir());
  const folder = await mkdtemp(join(root, "repopilot-run-history-"));
  t.after(async () => {
    assert.equal(dirname(resolve(folder)), root);
    await rm(folder, { recursive: true, force: true });
  });
  return folder;
}

async function report(folder: string, id: string, name: string, value: unknown, date?: string) {
  await mkdir(join(folder, id), { recursive: true });
  const path = join(folder, id, name);
  await writeFile(path, JSON.stringify(value));
  if (date) await utimes(path, new Date(date), new Date(date));
  return path;
}

test("lists existing reports by file update time while retaining failures and in-progress runs", async t => {
  const folder = await directory(t);
  await report(folder, "baseline-ABC123", "baseline.json", baseline(), "2026-01-04T00:00:00.000Z");
  await report(folder, "baseline-DEF456", "baseline.json", baseline({ baselineStatus: "error", code: "GIT_FAILED" }), "2026-01-02T00:00:00.000Z");
  await report(folder, "repair-ABC123", "repair.json", repair(folder, "", { status: "awaiting_review", finishedAt: "", artifacts: { patch: null, verification: null } }), "2026-01-03T00:00:00.000Z");
  await report(folder, "bench-ABC123", "benchmark.json", { kind: "benchmark_run", status: "completed", reason: "评测完成。", rows: [] }, "2026-01-01T00:00:00.000Z");
  const result = await listRuns({ directory: folder });
  assert.equal(result.unavailable, 0);
  assert.deepEqual(result.runs.map(run => [run.id, run.status]), [["baseline-ABC123", "ready"], ["repair-ABC123", "awaiting_review"], ["baseline-DEF456", "error"], ["bench-ABC123", "completed"]]);
  assert.equal(result.runs[0].updatedAt, "2026-01-04T00:00:00.000Z");
  assert.equal(result.runs[1].attempts, 1);
  assert.equal((await loadRun("bench-ABC123", { directory: folder })).verification, "not_run");
});

test("chooses the newest pipeline stage and never falls back from a broken preferred report", async t => {
  const folder = await directory(t);
  await report(folder, "baseline-ABC123", "baseline.json", baseline());
  await report(folder, "baseline-ABC123", "location.json", { ...baseline(), kind: "source_localization", status: "located" });
  await report(folder, "baseline-ABC123", "proposal.json", { ...baseline(), kind: "repair_proposal", status: "proposed" });
  assert.equal((await loadRun("baseline-ABC123", { directory: folder })).status, "proposed");
  await writeFile(join(folder, "baseline-ABC123", "report.json"), "{");
  await assert.rejects(loadRun("baseline-ABC123", { directory: folder }), errorCode("RUN_REPORT_INVALID"));
  await report(folder, "baseline-DEF456", "baseline.json", baseline({ baselineStatus: "error" }));
  const listed = await listRuns({ directory: folder });
  assert.equal(listed.unavailable, 1);
  assert.deepEqual(listed.runs.map(run => run.status), ["error"]);
});

test("benchmark model requests use the feedback total without adding shared single candidates", async t => {
  const folder = await directory(t);
  const id = "bench-ABC123";
  const benchmark = { kind: "benchmark_run", status: "completed", reason: "评测完成。", modelRequests: 99, rows: [] };
  await report(folder, id, "benchmark.json", { ...benchmark,
    summary: { single: { modelRequests: 3 }, feedback: { modelRequests: 5 } } });
  assert.equal((await loadRun(id, { directory: folder })).modelRequests, 5);
  await report(folder, id, "benchmark.json", benchmark);
  assert.equal((await loadRun(id, { directory: folder })).modelRequests, null);
  for (const modelRequests of [-1, 1.5, "5"]) {
    await report(folder, id, "benchmark.json", { ...benchmark, summary: { feedback: { modelRequests } } });
    await assert.rejects(loadRun(id, { directory: folder }), errorCode("RUN_REPORT_INVALID"));
  }
});

test("equal-budget histories use the total independent attempts and expose both repair references", async t => {
  const folder = await directory(t), id = "bench-ABC123";
  const value = { kind: "benchmark_run", design: "equal_budget_independent", status: "completed", reason: "独立对照完成。",
    summary: { actualModelRequests: 5, feedback: { modelRequests: 2 }, noFeedback: { modelRequests: 3 } },
    rows: [{ noFeedbackReport: join(folder, "repair-ABC123", "repair.json"), feedbackReport: join(folder, "repair-DEF456", "repair.json") }] };
  await report(folder, id, "benchmark.json", value);
  const detail = await loadRun(id, { directory: folder });
  assert.equal(detail.modelRequests, 5); assert.equal(detail.verification, "not_run");
  assert.deepEqual(detail.relatedRuns, ["repair-ABC123", "repair-DEF456"]);
  for (const actualModelRequests of [-1, 1.5, "5"]) {
    await report(folder, id, "benchmark.json", { ...value, summary: { actualModelRequests } });
    await assert.rejects(loadRun(id, { directory: folder }), errorCode("RUN_REPORT_INVALID"));
  }
});

test("projects only selected test counts and requires independent evidence for verification success", async t => {
  const folder = await directory(t);
  const id = "baseline-ABC123";
  const good = verification(folder, id);
  await report(folder, id, "report.json", { ...good, checks: [...good.checks, check("replay-reproduce", ["passed"])], env: "PRIVATE_ENV", source: "PRIVATE_SOURCE" });
  const detail = await loadRun(id, { directory: folder });
  assert.equal(detail.verification, "passed");
  assert.equal(detail.durationMs, 1000);
  assert.deepEqual(detail.tests, [
    { phase: "before-reproduce", passed: 0, failed: 1, skipped: 0 },
    { phase: "before-regression", passed: 2, failed: 0, skipped: 0 },
    { phase: "after-reproduce", passed: 1, failed: 0, skipped: 0 },
    { phase: "after-regression", passed: 2, failed: 0, skipped: 0 },
  ]);
  assert.doesNotMatch(JSON.stringify(detail), /PRIVATE_|SHOULD_NOT_DISPLAY|command|stdout|fullName/);
  for (const extra of [
    { integrity: { stable: true, replayVerified: false } },
    { artifacts: { patch: null } },
    { checks: good.checks.filter(item => item.phase !== "before-regression") },
    { checks: [...good.checks.slice(0, 3), check("after-regression", [])] },
    { checks: [...good.checks.slice(0, 3), check("after-regression", ["failed"])] },
  ]) {
    await report(folder, id, "report.json", { ...good, ...extra });
    assert.equal((await loadRun(id, { directory: folder })).verification, "unavailable");
  }
  await report(folder, id, "report.json", { ...good, status: "unresolved" });
  assert.equal((await loadRun(id, { directory: folder })).verification, "failed");
});

test("repair follows only a matching independent verification and cannot hide a failed child", async t => {
  const folder = await directory(t);
  const child = "baseline-ABC123";
  const path = await report(folder, child, "report.json", verification(folder, child));
  await report(folder, "repair-ABC123", "repair.json", repair(folder, path));
  const detail = await loadRun("repair-ABC123", { directory: folder });
  assert.equal(detail.verification, "passed");
  assert.equal(detail.modelRequests, 2);
  assert.equal(detail.durationMs, 1200.25);
  assert.equal(detail.tests.length, 4);
  assert.deepEqual(detail.relatedRuns, ["baseline-ABC123", "baseline-A1B2C3"]);
  for (const extra of [{ taskId: "other-task" }, { baseCommit: "c".repeat(40) }, { candidateHash: "d".repeat(64) }, { status: "unresolved" }, { status: "error" }]) {
    await report(folder, child, "report.json", verification(folder, child, extra));
    assert.equal((await loadRun("repair-ABC123", { directory: folder })).verification, "unavailable");
  }
  await report(folder, child, "report.json", verification(folder, child, { status: "unresolved" }));
  await report(folder, "repair-ABC123", "repair.json", repair(folder, path, { status: "unresolved" }));
  assert.equal((await loadRun("repair-ABC123", { directory: folder })).verification, "failed");
});

test("contradictory process results or assertion evidence cannot be reported as verified", async t => {
  const folder = await directory(t);
  const id = "baseline-ABC123";
  for (const [phase, field, value] of [
    ["before-reproduce", "exitCode", 0], ["before-regression", "exitCode", 1],
    ["after-reproduce", "exitCode", null], ["after-regression", "timedOut", true],
    ["after-reproduce", "interrupted", true], ["before-regression", "executionError", true],
    ["after-regression", "outputTruncated", true],
  ] as const) {
    const good = verification(folder, id);
    const checks = good.checks.map(item => item.phase === phase ? { ...item, [field]: value } : item);
    await report(folder, id, "report.json", { ...good, checks });
    assert.equal((await loadRun(id, { directory: folder })).verification, "unavailable", `${phase}.${field}`);
  }
  const good = verification(folder, id);
  good.checks[0].tests[0].assertionFailure = false;
  await report(folder, id, "report.json", good);
  assert.equal((await loadRun(id, { directory: folder })).verification, "unavailable");
});

test("verification preserves original test identities and duplicate counts before claiming success", async t => {
  const folder = await directory(t);
  const id = "baseline-ABC123";
  const good = verification(folder, id);
  const passed = check("after-reproduce", ["passed"]).tests[0];
  for (const [phase, tests] of [
    ["after-reproduce", [{ ...passed, fullName: "unrelated replacement test" }]],
    ["after-reproduce", [{ ...passed, file: "replacement.ts" }]],
    ["after-reproduce", [{ ...passed, file: undefined }]],
    ["before-regression", [{ ...passed, fullName: undefined }, passed]],
    ["after-regression", [passed]],
    ["after-regression", [passed, passed, passed]],
  ] as const) {
    await report(folder, id, "report.json", { ...good,
      checks: good.checks.map(item => item.phase === phase ? { ...item, tests } : item) });
    assert.equal((await loadRun(id, { directory: folder })).verification, "unavailable");
  }
  await report(folder, id, "report.json", { ...good, checks: good.checks.map(item => item.phase === "after-regression"
    ? { ...item, tests: [...item.tests, { ...passed, fullName: "additional test" }] } : item) });
  assert.equal((await loadRun(id, { directory: folder })).verification, "passed");
});

test("repair success requires matching last review and nonempty parent-child patch references", async t => {
  const folder = await directory(t);
  const path = await report(folder, "baseline-ABC123", "report.json", verification(folder, "baseline-ABC123"));
  const good = repair(folder, path);
  for (const extra of [
    { artifacts: { ...good.artifacts, patch: null } },
    { artifacts: { ...good.artifacts, patch: join(folder, "baseline-DEF456", "patch.diff") } },
    { attempts: [{ ...good.attempts[0], verificationReport: join(folder, "baseline-DEF456", "report.json") }] },
    { attempts: [{ ...good.attempts[0], verificationReport: null }] },
    { attempts: [{ ...good.attempts[0], status: "unresolved" }] },
  ]) {
    await report(folder, "repair-ABC123", "repair.json", { ...good, ...extra });
    assert.equal((await loadRun("repair-ABC123", { directory: folder })).verification, "unavailable");
  }
});

test("external or malformed verification references never supply success or related paths", async t => {
  const folder = await directory(t);
  const external = await directory(t);
  const path = await report(external, "baseline-ABC123", "report.json", verification(external, "baseline-ABC123"));
  await report(folder, "repair-ABC123", "repair.json", repair(folder, path, { attempts: [{ candidateHash: hash, reviewed: true }] }));
  let detail = await loadRun("repair-ABC123", { directory: folder });
  assert.equal(detail.verification, "unavailable");
  assert.deepEqual(detail.relatedRuns, []);
  await report(folder, "repair-ABC123", "repair.json", repair(folder, join(folder, "baseline-DEF456", "report.json")));
  detail = await loadRun("repair-ABC123", { directory: folder });
  assert.equal(detail.verification, "unavailable");
});

test("missing histories are empty and ids cannot select arbitrary files", async t => {
  const folder = await directory(t);
  assert.deepEqual(await listRuns({ directory: join(folder, "absent") }), { runs: [], unavailable: 0 });
  for (const id of ["../baseline-ABC123", "baseline-ABC123/report.json", "baseline-ABC12", "baseline-ABC1234", "D:\\private\\key", ""]) {
    await assert.rejects(loadRun(id, { directory: folder }), errorCode("RUN_ID_INVALID"));
  }
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(listRuns({ directory: folder, signal: controller.signal }), errorCode("RUN_HISTORY_CANCELLED"));
});

test("rejects oversized and non-UTF8 reports without copying report contents into errors", async t => {
  const folder = await directory(t);
  await report(folder, "baseline-ABC123", "baseline.json", baseline());
  const path = join(folder, "baseline-ABC123", "baseline.json");
  await writeFile(path, Buffer.alloc(2 * 1024 * 1024 + 1, 65));
  await assert.rejects(loadRun("baseline-ABC123", { directory: folder }), errorCode("RUN_REPORT_TOO_LARGE"));
  await writeFile(path, Buffer.from([0x7b, 0x22, 0xff, 0x22, 0x7d]));
  await assert.rejects(loadRun("baseline-ABC123", { directory: folder }), errorCode("RUN_REPORT_INVALID"));
});

test("displayed values reject credentials and terminal control sequences", async t => {
  const folder = await directory(t);
  const apiKey = "PRIVATE_SYNTHETIC_CREDENTIAL";
  for (const reason of ["\x1b[2Jreset", "sk-LOCAL_FAKE_REPORT_FOREIGN", apiKey, "bad\rline"]) {
    await report(folder, "baseline-ABC123", "baseline.json", baseline({ reason }));
    await assert.rejects(loadRun("baseline-ABC123", { directory: folder, apiKey }), error => {
      assert.ok(error instanceof RunHistoryError);
      assert.equal(error.code, "RUN_UNSAFE_CONTENT");
      assert.equal(error.message.includes(reason), false);
      return true;
    });
  }
});

test("does not follow a run directory junction or a report symlink", async t => {
  const folder = await directory(t);
  const external = await directory(t);
  const target = await report(external, "baseline-ABC123", "baseline.json", baseline());
  await symlink(dirname(target), join(folder, "baseline-ABC123"), "junction");
  await assert.rejects(loadRun("baseline-ABC123", { directory: folder }), errorCode("RUN_READ_FAILED"));
  await mkdir(join(folder, "baseline-DEF456"));
  try { await symlink(target, join(folder, "baseline-DEF456", "baseline.json"), "file"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "EPERM") return; throw error; }
  await assert.rejects(loadRun("baseline-DEF456", { directory: folder }), errorCode("RUN_READ_FAILED"));
});
