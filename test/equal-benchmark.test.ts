import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runEqualBenchmark, summarizeEqualBenchmark, type EqualBenchmarkRow } from "../src/equal-benchmark.ts";
import { findGitExecutable } from "../src/git.ts";
import { executionEnvironment, runProcess } from "../src/process.ts";
import { loadRun } from "../src/run-history.ts";

const original = "export const value = 1;\n";
const edit = (value: number) => ({ edits: [{ path: "src/value.ts", before: original, after: `export const value = ${value};\n` }] });
const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const project = fileURLToPath(new URL("../", import.meta.url));
const parent = join(project, ".repopilot", "equal-tests");
type Report = Awaited<ReturnType<typeof runEqualBenchmark>>;

test("equal summaries retain both budgets and count actual independent calls once", () => {
  const result = { status: "resolved" as const, modelRequests: 2, wallMs: 10, reviewWaitMs: 3, activeMs: 7, verificationReport: null };
  const rows = [
    { noFeedback: { ...result, status: "unresolved", modelRequests: 3 }, feedback: result },
    { noFeedback: null, feedback: { ...result, status: "awaiting_review", modelRequests: 1 } },
    { noFeedback: null, feedback: null },
  ] as EqualBenchmarkRow[];
  const summary = summarizeEqualBenchmark(rows, 6);
  assert.equal(summary.plannedTasks, 3); assert.equal(summary.processedTasks, 1);
  assert.equal(summary.actualModelRequests, 6);
  assert.equal(summary.noFeedback.modelRequests, 3); assert.equal(summary.feedback.modelRequests, 3);
  assert.equal(summary.noFeedback.statusCounts.unresolved, 1); assert.equal(summary.noFeedback.statusCounts.not_run, 2);
  assert.equal(summary.feedback.statusCounts.resolved, 1); assert.equal(summary.feedback.statusCounts.awaiting_review, 1);
  assert.equal(summary.feedback.statusCounts.not_run, 1);
});

async function withFixture(use: (fixture: { suite: string; taskFiles: string[]; run: (...args: Parameters<typeof runEqualBenchmark> extends [string, ...infer T] ? T : never) => Promise<Report> }) => Promise<void>) {
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(join(parent, "fixture-"));
  const repo = join(directory, "repo"), reports: Report[] = [];
  const env = executionEnvironment(), git = await findGitExecutable(env); assert.ok(git);
  async function command(args: string[]) {
    const result = await runProcess(git!, args, { cwd: repo, env, timeoutMs: 30000, captureOutput: true });
    assert.equal(result.exitCode, 0); return result.stdout.trim();
  }
  try {
    await mkdir(join(repo, "src"), { recursive: true }); await mkdir(join(repo, "test"));
    const pkg = { name: "repopilot-equal-fixture", version: "1.0.0" };
    await writeFile(join(repo, "package.json"), JSON.stringify({ ...pkg, type: "module", scripts: { "test:reproduce": "node --test test/reproduce.test.js", "test:regression": "node --test test/regression.test.js" } }));
    await writeFile(join(repo, "package-lock.json"), JSON.stringify({ ...pkg, lockfileVersion: 3, requires: true, packages: { "": pkg } }));
    await writeFile(join(repo, "src/value.ts"), original);
    await writeFile(join(repo, "test/reproduce.test.js"), "import test from 'node:test';import assert from 'node:assert/strict';import {value} from '../src/value.ts';test('value must be zero',()=>assert.equal(value,0));");
    await writeFile(join(repo, "test/regression.test.js"), "import test from 'node:test';import assert from 'node:assert/strict';import {value} from '../src/value.ts';test('existing behavior',()=>assert.equal(typeof value,'number'));");
    await command(["init", "--initial-branch=main"]); await command(["config", "core.autocrlf", "false"]); await command(["add", "."]);
    await command(["-c", "user.name=RepoPilot Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "-c", `core.hooksPath=${join(directory, "empty-hooks")}`, "commit", "-m", "Private equal-budget fixture"]);
    const baseCommit = await command(["rev-parse", "HEAD"]), entries = [], taskFiles = [];
    for (const label of ["a", "b"]) {
      const task = { id: `equal-test-${label}`, repoPath: repo, baseCommit, issue: `Case ${label}: value must be zero.`, reproduceScript: "test:reproduce", regressionScript: "test:regression", expectedFailure: "value must be zero", allowedPaths: ["src/value.ts"] };
      const bytes = JSON.stringify(task), path = `${label}.json`;
      await writeFile(join(directory, path), bytes); taskFiles.push(join(directory, path)); entries.push({ path, sha256: hash(bytes) });
    }
    const suite = join(directory, "suite.json"); await writeFile(suite, JSON.stringify({ id: "equal-test", tasks: entries }));
    await use({ suite, taskFiles, async run(...args) { const report = await runEqualBenchmark(suite, ...args); reports.push(report); return report; } });
    assert.equal(await command(["rev-parse", "HEAD"]), baseCommit); assert.equal(await command(["status", "--porcelain=v1"]), "");
    assert.equal(await readFile(join(repo, "src/value.ts"), "utf8"), original);
  } finally {
    const runs = await realpath(join(project, ".repopilot/runs")), owned = new Set<string>();
    for (const report of reports) {
      owned.add(dirname(report.reportPath));
      for (const row of report.rows) for (const path of [row.noFeedbackReport, row.feedbackReport]) {
        if (!path) continue; owned.add(dirname(path));
        const repair = JSON.parse(await readFile(path, "utf8"));
        assert.ok(["equal-test-a", "equal-test-b"].includes(repair.taskId));
        for (const attempt of repair.attempts) for (const child of [attempt.proposalReport, attempt.verificationReport]) if (child) owned.add(dirname(child));
      }
    }
    for (const path of owned) {
      const canonical = await realpath(path); assert.equal(dirname(canonical), runs); assert.match(basename(canonical), /^(?:bench|repair|baseline)-[A-Za-z0-9]{6}$/);
      await rm(canonical, { recursive: true, force: true });
    }
    assert.equal(dirname(await realpath(directory)), await realpath(parent)); await rm(directory, { recursive: true, force: true });
  }
}

test("equal benchmark independently verifies both strategies, alternates order and sums real callback attempts", async () => {
  await withFixture(async fixture => {
    const prompts = new Map<string, string[]>(), reviewOrder: string[] = [];
    const report = await fixture.run(async candidate => {
      reviewOrder.push(`${candidate.taskId}:${candidate.strategy}:${candidate.attempt}`);
      assert.equal(hash(await readFile(candidate.patchPath)), candidate.candidateHash); return true;
    }, async (prompt, context) => {
      const key = `${context.taskId}:${context.strategy}`, list = prompts.get(key) ?? [];
      list.push(prompt); prompts.set(key, list);
      assert.equal(context.attempt, list.length);
      const parsed = JSON.parse(prompt); assert.deepEqual(parsed.sources, [{ path: "src/value.ts", content: original }]);
      assert.equal(Boolean(parsed.feedback), context.strategy === "feedback" && list.length > 1);
      return edit(context.taskId.endsWith("b") ? 0 : context.strategy === "feedback" && list.length === 2 ? 0 : list.length + 1);
    });
    assert.equal(report.status, "completed", report.reason); assert.equal(report.design, "equal_budget_independent");
    assert.deepEqual(report.budgets, { noFeedback: 3, feedback: 3 });
    assert.equal(report.summary.actualModelRequests, 7);
    assert.equal(report.summary.noFeedback.modelRequests, 4); assert.equal(report.summary.feedback.modelRequests, 3);
    assert.equal(report.rows[0].noFeedback?.status, "unresolved"); assert.equal(report.rows[0].feedback?.status, "resolved");
    assert.equal(report.rows[0].noFeedback?.code, "ATTEMPT_LIMIT");
    assert.deepEqual(report.rows[0].order, ["no_feedback", "feedback"]); assert.deepEqual(report.rows[1].order, ["feedback", "no_feedback"]);
    assert.notEqual(report.rows[1].noFeedback?.verificationReport, report.rows[1].feedback?.verificationReport);
    const baseline = prompts.get("equal-test-a:no_feedback")!; assert.equal(baseline.length, 3); assert.ok(baseline.every(prompt => prompt === baseline[0]));
    assert.equal(prompts.get("equal-test-a:feedback")![0], baseline[0]);
    assert.deepEqual(reviewOrder.slice(-2), ["equal-test-b:feedback:1", "equal-test-b:no_feedback:1"]);
    const history = await loadRun(basename(dirname(report.reportPath))); assert.equal(history.modelRequests, 7); assert.equal(history.relatedRuns.length, 4);
    assert.match(await readFile(report.artifacts.markdown, "utf8"), /独立|不共享/);
  });
});

test("declining equal benchmark review retains fixed denominators and starts no later arm", async () => {
  await withFixture(async fixture => {
    let requests = 0;
    const report = await fixture.run(async () => false, async () => { requests++; return edit(0); });
    assert.equal(report.status, "incomplete"); assert.equal(requests, 1);
    assert.equal(report.summary.plannedTasks, 2); assert.equal(report.summary.processedTasks, 0);
    assert.equal(report.summary.noFeedback.statusCounts.awaiting_review, 1); assert.equal(report.summary.feedback.statusCounts.not_run, 2);
  });
});

test("cancellation and task drift stop an equal benchmark before review or another strategy", async () => {
  for (const mode of ["cancel", "drift"]) await withFixture(async fixture => {
    const controller = new AbortController(); let requests = 0;
    const report = await fixture.run(async () => { assert.fail("must not review"); }, async () => {
      requests++;
      if (mode === "cancel") controller.abort(); else await writeFile(fixture.taskFiles[1], "{}");
      return edit(0);
    }, controller.signal);
    assert.equal(requests, 1); assert.equal(report.summary.actualModelRequests, 1);
    assert.equal(report.status, mode === "cancel" ? "incomplete" : "error");
    assert.equal(report.code, mode === "cancel" ? "OPERATION_CANCELLED" : "BENCHMARK_INPUT_CHANGED");
    assert.equal(report.rows[0].feedback, null);
  });
});
