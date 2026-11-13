import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runBenchmark } from "../src/benchmark.ts";
import { findGitExecutable } from "../src/git.ts";
import { executionEnvironment, runProcess } from "../src/process.ts";
import type { Task } from "../src/task.ts";

const project = fileURLToPath(new URL("..", import.meta.url));
const parent = resolve(project, ".repopilot/benchmark-run-tests");
const runsRoot = resolve(project, ".repopilot/runs");
const original = "export const value = 1;\n";
const hash = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const edit = (value: number) => ({ edits: [{ path: "src/value.ts", before: original, after: `export const value = ${value};\n` }] });
type Benchmark = Awaited<ReturnType<typeof runBenchmark>>;
type Review = Parameters<typeof runBenchmark>[1];
type Request = NonNullable<Parameters<typeof runBenchmark>[2]>;

async function withFixture(use: (fixture: {
  tasks: Task[];
  run: (review: Review, request: Request) => Promise<Benchmark>;
}) => Promise<void>) {
  const env = executionEnvironment();
  const executable = await findGitExecutable(env);
  assert.ok(executable, "Private benchmark fixtures require Git.");
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(join(parent, "case-"));
  const reports: Benchmark[] = [];
  const tasks: Task[] = [];
  async function git(repo: string, args: string[]) {
    const result = await runProcess(executable!, args, { cwd: repo, env, timeoutMs: 15_000, captureOutput: true });
    assert.equal(result.exitCode, 0, "Private benchmark fixture Git command must succeed.");
    return result.stdout.trim();
  }
  try {
    await mkdir(join(directory, "tasks"));
    const entries: Array<{ path: string; sha256: string }> = [];
    for (const label of ["a", "b"]) {
      const repo = join(directory, `repo-${label}`);
      await mkdir(join(repo, "src"), { recursive: true });
      await mkdir(join(repo, "test"));
      const pkg = { name: `repopilot-benchmark-${label}-fixture`, version: "1.0.0" };
      const files = {
        ".gitignore": "node_modules/\n",
        "package.json": JSON.stringify({ ...pkg, type: "module", scripts: {
          "test:reproduce": "node --test test/reproduce.test.ts", "test:regression": "node --test test/regression.test.ts",
        } }),
        "package-lock.json": JSON.stringify({ ...pkg, lockfileVersion: 3, requires: true, packages: { "": pkg } }),
        "src/value.ts": original,
        "test/reproduce.test.ts": "import test from 'node:test'; import assert from 'node:assert/strict'; import {value} from '../src/value.ts';\n"
          + "test('value must be zero',()=>assert.equal(value,0));\n",
        "test/regression.test.ts": "import test from 'node:test'; import assert from 'node:assert/strict'; import {value} from '../src/value.ts';\n"
          + "test('existing behavior',()=>assert.equal(typeof value,'number'));\n",
      };
      for (const [path, content] of Object.entries(files)) await writeFile(join(repo, path), content);
      await git(repo, ["init", "--initial-branch=main"]);
      await git(repo, ["config", "core.autocrlf", "false"]);
      await git(repo, ["add", "."]);
      await git(repo, ["-c", "user.name=RepoPilot Benchmark Fixture", "-c", "user.email=fixture@localhost",
        "-c", "commit.gpgsign=false", "-c", `core.hooksPath=${join(directory, "no-hooks")}`, "commit", "--quiet", "-m", "Private benchmark baseline"]);
      const task: Task = {
        id: `benchmark-run-${label}`, repoPath: repo, baseCommit: await git(repo, ["rev-parse", "HEAD"]),
        issue: `Benchmark ${label.toUpperCase()}: value must be zero.`,
        reproduceScript: "test:reproduce", regressionScript: "test:regression", expectedFailure: "value must be zero", allowedPaths: ["src/value.ts"],
      };
      tasks.push(task);
      const taskBytes = JSON.stringify(task, null, 2) + "\n";
      const path = `tasks/${label}.json`;
      await writeFile(join(directory, path), taskBytes);
      entries.push({ path, sha256: hash(taskBytes) });
    }
    const suiteFile = join(directory, "suite.json");
    await writeFile(suiteFile, JSON.stringify({ id: "benchmark-run-test", tasks: entries }, null, 2) + "\n");
    await use({ tasks, async run(review, request) {
      const report = await runBenchmark(suiteFile, review, request);
      reports.push(report);
      return report;
    } });
    for (const task of tasks) {
      assert.equal(await git(task.repoPath, ["rev-parse", "HEAD"]), task.baseCommit);
      assert.equal(await git(task.repoPath, ["status", "--porcelain=v1"]), "");
      assert.equal(await readFile(join(task.repoPath, "src/value.ts"), "utf8"), original);
    }
  } finally {
    const canonicalRuns = await realpath(runsRoot);
    const referenced = new Set<string>();
    const repairDirectories = new Set<string>();
    for (const report of reports) {
      for (const row of report.rows) {
        if (!row.repairReport) continue;
        const repairDirectory = await realpath(dirname(row.repairReport));
        assert.equal(dirname(repairDirectory), canonicalRuns);
        assert.match(basename(repairDirectory), /^repair-/);
        repairDirectories.add(repairDirectory);
        const repair = JSON.parse(await readFile(row.repairReport, "utf8")) as {
          attempts: Array<{ proposalReport: string | null; verificationReport: string | null }>;
        };
        for (const attempt of repair.attempts) {
          if (attempt.proposalReport) referenced.add(attempt.proposalReport);
          if (attempt.verificationReport) referenced.add(attempt.verificationReport);
        }
      }
    }
    for (const reportPath of referenced) {
      const runDirectory = await realpath(dirname(reportPath));
      assert.equal(dirname(runDirectory), canonicalRuns);
      assert.match(basename(runDirectory), /^baseline-/);
      const report = JSON.parse(await readFile(reportPath, "utf8")) as {
        taskId: string; artifacts: { worktree: string | null; replayWorktree?: string | null };
      };
      const task = tasks.find(task => task.id === report.taskId);
      assert.ok(task, "A referenced run must belong to a fixture task.");
      for (const [path, name] of [[report.artifacts.replayWorktree, "patch-replay"], [report.artifacts.worktree, "worktree"]]) {
        if (!path) continue;
        assert.equal(resolve(path), join(runDirectory, name!));
        assert.equal(await realpath(path), join(runDirectory, name!));
        await git(task.repoPath, ["worktree", "remove", "--force", path]);
      }
      await rm(runDirectory, { recursive: true, force: true });
    }
    for (const directory of repairDirectories) await rm(directory, { recursive: true, force: true });
    for (const report of reports) {
      const benchmarkDirectory = await realpath(dirname(report.reportPath));
      assert.equal(dirname(benchmarkDirectory), canonicalRuns);
      assert.match(basename(benchmarkDirectory), /^bench-/);
      await rm(benchmarkDirectory, { recursive: true, force: true });
    }
    const absoluteDirectory = await realpath(directory);
    assert.equal(dirname(absoluteDirectory), await realpath(parent));
    await rm(absoluteDirectory, { recursive: true, force: true });
  }
}

test("benchmark shares the first candidate and counts feedback calls once across two real repair pipelines", async () => {
  await withFixture(async fixture => {
    const calls = { a: 0, b: 0 };
    const reviews: Array<{ taskId: string; taskIndex: number; taskCount: number; attempt: number }> = [];
    const report = await fixture.run(async candidate => {
      reviews.push({ taskId: candidate.taskId, taskIndex: candidate.taskIndex, taskCount: candidate.taskCount, attempt: candidate.attempt });
      assert.equal(hash(await readFile(candidate.patchPath)), candidate.candidateHash);
      await new Promise(resolve => setTimeout(resolve, 20));
      return true;
    }, async prompt => {
      const payload = JSON.parse(prompt);
      assert.deepEqual(payload.sources, [{ path: "src/value.ts", content: original }]);
      if (payload.issue === fixture.tasks[0].issue) {
        calls.a++;
        assert.equal(Boolean(payload.feedback), calls.a > 1);
        return edit(calls.a === 1 ? 2 : 0);
      }
      assert.equal(payload.issue, fixture.tasks[1].issue);
      calls.b++;
      assert.equal(payload.feedback, undefined);
      return edit(0);
    });
    assert.equal(report.status, "completed", `${report.code ?? ""} ${report.reason}`);
    assert.equal(report.design, "shared_first_candidate");
    assert.equal(report.rows.length, 2);
    const [first, second] = report.rows;
    assert.equal(first.single?.status, "unresolved");
    assert.equal(first.single?.modelRequests, 1);
    assert.equal(first.feedback?.status, "resolved");
    assert.equal(first.feedback?.modelRequests, 2);
    assert.equal(second.single?.status, "resolved");
    assert.equal(second.feedback?.status, "resolved");
    assert.equal(second.single?.modelRequests, 1);
    assert.equal(second.feedback?.modelRequests, 1);
    assert.equal(second.single?.verificationReport, second.feedback?.verificationReport);
    assert.notEqual(first.single?.verificationReport, first.feedback?.verificationReport);
    assert.deepEqual(calls, { a: 2, b: 1 });
    assert.equal(report.summary.plannedTasks, 2);
    assert.equal(report.summary.processedTasks, 2);
    assert.equal(report.summary.single.statusCounts.resolved, 1);
    assert.equal(report.summary.single.statusCounts.unresolved, 1);
    assert.equal(report.summary.feedback.statusCounts.resolved, 2);
    assert.equal(report.summary.single.modelRequests, 2);
    assert.equal(report.summary.feedback.modelRequests, 3);
    assert.equal(calls.a + calls.b, report.summary.feedback.modelRequests);
    assert.deepEqual(reviews, [
      { taskId: fixture.tasks[0].id, taskIndex: 1, taskCount: 2, attempt: 1 },
      { taskId: fixture.tasks[0].id, taskIndex: 1, taskCount: 2, attempt: 2 },
      { taskId: fixture.tasks[1].id, taskIndex: 2, taskCount: 2, attempt: 1 },
    ]);
    for (const row of report.rows) {
      assert.ok(row.sourceFingerprint);
      for (const strategy of ["single", "feedback"] as const) {
        const outcome = row[strategy]!;
        assert.ok(Math.abs(outcome.activeMs + outcome.reviewWaitMs - outcome.wallMs) < 1);
        assert.ok(outcome.verificationReport);
        const verification = JSON.parse(await readFile(outcome.verificationReport, "utf8"));
        assert.equal(verification.status, outcome.status);
        assert.equal(verification.taskId, row.taskId);
        assert.equal(verification.baseCommit, row.baseCommit);
        assert.equal(verification.integrity.stable, true);
        assert.equal(verification.integrity.replayVerified, true);
      }
    }
    assert.ok(report.summary.feedback.reviewWaitMs >= 30);
    assert.ok((await stat(report.artifacts.markdown)).size > 0);
    assert.deepEqual(JSON.parse(await readFile(report.reportPath, "utf8")).summary, report.summary);
    const markdown = await readFile(report.artifacts.markdown, "utf8");
    assert.match(markdown, /benchmark-run-a.*unresolved.*resolved/);
    assert.match(markdown, /benchmark-run-b.*resolved.*resolved/);
  });
});

test("declining the first review preserves both planned rows and does not call the second task", async () => {
  await withFixture(async fixture => {
    const calls = { a: 0, b: 0 };
    let reviews = 0;
    const report = await fixture.run(async candidate => {
      reviews++;
      assert.equal(candidate.taskId, fixture.tasks[0].id);
      assert.equal(candidate.taskIndex, 1);
      assert.equal(candidate.taskCount, 2);
      return false;
    }, async prompt => {
      const payload = JSON.parse(prompt);
      if (payload.issue === fixture.tasks[0].issue) calls.a++;
      else if (payload.issue === fixture.tasks[1].issue) calls.b++;
      else assert.fail("Only planned fixture tasks may call the model.");
      return edit(0);
    });
    assert.equal(report.status, "incomplete", `${report.code ?? ""} ${report.reason}`);
    assert.equal(report.rows.length, 2);
    assert.equal(reviews, 1);
    assert.deepEqual(calls, { a: 1, b: 0 });
    assert.equal(report.rows[0].single?.status, "awaiting_review");
    assert.equal(report.rows[0].feedback?.status, "awaiting_review");
    assert.equal(report.rows[0].single?.verificationReport, null);
    assert.equal(report.rows[0].feedback?.verificationReport, null);
    assert.equal(report.rows[1].single, null);
    assert.equal(report.rows[1].feedback, null);
    assert.equal(report.rows[1].repairReport, null);
    assert.equal(report.summary.plannedTasks, 2);
    assert.equal(report.summary.processedTasks, 1);
    for (const strategy of ["single", "feedback"] as const) {
      assert.equal(report.summary[strategy].statusCounts.awaiting_review, 1);
      assert.equal(report.summary[strategy].statusCounts.not_run, 1);
      assert.equal(report.summary[strategy].statusCounts.resolved, 0);
      assert.equal(report.summary[strategy].modelRequests, 1);
    }
    assert.ok((await stat(report.reportPath)).size > 0);
    assert.ok((await stat(report.artifacts.markdown)).size > 0);
  });
});
