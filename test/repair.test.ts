import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { findGitExecutable } from "../src/git.ts";
import { executionEnvironment, runProcess } from "../src/process.ts";
import { repairTask, type CandidateReview } from "../src/repair.ts";
import type { ProgressSink, TaskProgress } from "../src/progress.ts";
import type { Task } from "../src/task.ts";

const project = fileURLToPath(new URL("..", import.meta.url));
const parent = resolve(project, ".repopilot/repair-tests");
const runsRoot = resolve(project, ".repopilot/runs");
const original = "export const value = 1;\n";
const targetMarker = "REPAIR_FIXTURE_PROTECTED_TARGET";
const regressionMarker = "REPAIR_FIXTURE_PROTECTED_REGRESSION";
const edit = (value: number) => ({ edits: [{ path: "src/value.ts", before: original, after: `export const value = ${value};\n` }] });
type Repair = Awaited<ReturnType<typeof repairTask>>;

type Fixture = {
  repo: string; task: Task;
  run: (review: (candidate: CandidateReview) => Promise<boolean>, request: (prompt: string) => Promise<unknown>, signal?: AbortSignal, onProgress?: ProgressSink, strategy?: "feedback" | "no_feedback") => Promise<Repair>;
  git: (args: string[]) => Promise<string>;
};

async function withFixture(use: (fixture: Fixture) => Promise<void>) {
  const env = executionEnvironment();
  const executable = await findGitExecutable(env);
  assert.ok(executable, "Repair fixtures require Git.");
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(join(parent, "case-"));
  const repo = join(directory, "repo");
  const reports: Repair[] = [];
  const git = async (args: string[]) => {
    const result = await runProcess(executable, args, { cwd: repo, env, timeoutMs: 15_000, captureOutput: true });
    assert.equal(result.exitCode, 0, "Private repair fixture Git command must succeed.");
    return result.stdout.trim();
  };
  try {
    await mkdir(join(repo, "src"), { recursive: true });
    await mkdir(join(repo, "test"));
    const pkg = { name: "repopilot-repair-fixture", version: "1.0.0" };
    const files = {
      ".gitignore": "node_modules/\n",
      "package.json": JSON.stringify({ ...pkg, type: "module", scripts: {
        "test:reproduce": "node --test test/reproduce.test.ts", "test:regression": "node --test test/regression.test.ts",
      } }),
      "package-lock.json": JSON.stringify({ ...pkg, lockfileVersion: 3, requires: true, packages: { "": pkg } }),
      "src/value.ts": original,
      "test/reproduce.test.ts": "import test from 'node:test'; import assert from 'node:assert/strict'; import {value} from '../src/value.ts';\n"
        + `test('value must be zero',()=>assert.equal(value,0,'${targetMarker}'));\n`,
      "test/regression.test.ts": "import test from 'node:test'; import assert from 'node:assert/strict'; import {value} from '../src/value.ts';\n"
        + `test('existing behavior',()=>assert.equal(typeof value,'number','${regressionMarker}'));\n`,
    };
    for (const [path, content] of Object.entries(files)) await writeFile(join(repo, path), content);
    await git(["init", "--initial-branch=main"]);
    await git(["config", "core.autocrlf", "false"]);
    await git(["add", "."]);
    await git(["-c", "user.name=RepoPilot Repair Fixture", "-c", "user.email=fixture@localhost",
      "-c", `core.hooksPath=${join(directory, "no-hooks")}`, "commit", "--quiet", "-m", "Private repair baseline"]);
    const task: Task = {
      id: "repair-test", repoPath: repo, baseCommit: await git(["rev-parse", "HEAD"]), issue: "Value must be zero.",
      reproduceScript: "test:reproduce", regressionScript: "test:regression", expectedFailure: "value must be zero", allowedPaths: ["src/value.ts"],
    };
    const taskFile = join(directory, "task.json");
    await writeFile(taskFile, JSON.stringify(task));
    await use({ repo, task, git, async run(review, request, signal, onProgress, strategy) {
      const report = await repairTask(taskFile, review, request, signal, onProgress, strategy);
      reports.push(report);
      return report;
    } });
  } finally {
    const referencedReports = new Set<string>();
    for (const report of reports) {
      for (const attempt of report.attempts) {
        if (attempt.proposalReport) referencedReports.add(attempt.proposalReport);
        if (attempt.verificationReport) referencedReports.add(attempt.verificationReport);
      }
    }
    for (const reportPath of referencedReports) {
      const runDir = await realpath(dirname(reportPath));
      assert.equal(dirname(runDir), await realpath(runsRoot));
      const report = JSON.parse(await readFile(reportPath, "utf8")) as {
        artifacts: { worktree: string | null; replayWorktree?: string | null };
      };
      for (const [path, name] of [[report.artifacts.replayWorktree, "patch-replay"], [report.artifacts.worktree, "worktree"]]) {
        if (!path) continue;
        assert.equal(resolve(path), join(runDir, name!));
        assert.equal(await realpath(path), join(runDir, name!));
        await git(["worktree", "remove", "--force", path]);
      }
      await rm(runDir, { recursive: true, force: true });
    }
    for (const report of reports) {
      const runDir = await realpath(dirname(report.reportPath));
      assert.equal(dirname(runDir), await realpath(runsRoot));
      assert.match(runDir, /[\\/]repair-[^\\/]+$/);
      await rm(runDir, { recursive: true, force: true });
    }
    const absoluteDirectory = await realpath(directory);
    assert.equal(dirname(absoluteDirectory), await realpath(parent));
    await rm(absoluteDirectory, { recursive: true, force: true });
  }
}

test("no-feedback repair resamples the original prompt up to the same three-attempt ceiling", async () => {
  await withFixture(async fixture => {
    const prompts: string[] = [];
    const report = await fixture.run(async () => true, async prompt => {
      prompts.push(prompt);
      assert.equal(JSON.parse(prompt).feedback, undefined);
      return edit(prompts.length + 1);
    }, undefined, undefined, "no_feedback");
    assert.equal(report.status, "unresolved", report.reason);
    assert.equal(report.code, "ATTEMPT_LIMIT");
    assert.equal(report.strategy, "no_feedback");
    assert.equal(report.modelRequests, 3);
    assert.equal(prompts.length, 3);
    assert.ok(prompts.every(prompt => prompt === prompts[0]));
    assert.ok(report.attempts.every(attempt => !attempt.feedbackIncluded && attempt.reviewed && attempt.verificationReport));
    assert.equal(await fixture.git(["status", "--porcelain=v1"]), "");
  });
});

test("repair feeds real failed verification into a second candidate from the original baseline", async () => {
  await withFixture(async fixture => {
    let requests = 0;
    let reviews = 0;
    const prompts: string[] = [];
    const progress: TaskProgress[] = [];
    const report = await fixture.run(async candidate => {
      reviews++;
      assert.equal(candidate.attempt, reviews);
      assert.equal(createHash("sha256").update(await readFile(candidate.patchPath)).digest("hex"), candidate.candidateHash);
      assert.ok(candidate.proposalReport);
      await new Promise(resolve => setTimeout(resolve, 20));
      return true;
    }, async prompt => {
      prompts.push(prompt);
      const payload = JSON.parse(prompt);
      assert.deepEqual(payload.sources, [{ path: "src/value.ts", content: original }]);
      assert.ok(Buffer.byteLength(prompt) <= 32 * 1024);
      return edit(++requests === 1 ? 2 : 0);
    }, undefined, event => progress.push(event));
    assert.equal(report.kind, "repair_run");
    assert.equal(report.status, "resolved", `${report.code ?? ""} ${report.reason}`);
    assert.equal(report.maxAttempts, 3);
    assert.equal(report.modelRequests, 2);
    assert.equal(requests, 2);
    assert.equal(reviews, 2);
    assert.equal(report.attempts.length, 2);
    for (const attempt of [1, 2]) {
      assert.deepEqual(progress.filter(event => event.attempt === attempt).map(event => event.stage),
        ["baseline", "localize", "generate", "review", "verify", "baseline", "target-tests", "regression-tests", "replay"]);
    }
    assert.ok(progress.every(event => Object.keys(event).sort().join(",") === "attempt,stage"));
    assert.equal(JSON.parse(prompts[0]).feedback, undefined);
    const feedback = JSON.parse(prompts[1]).feedback;
    assert.match(feedback.previousCandidate, /\+export const value = 2;/);
    assert.deepEqual(feedback.checks.map((check: { phase: string }) => check.phase), ["after-reproduce", "after-regression"]);
    assert.equal(feedback.checks[0].tests[0].status, "failed");
    assert.equal(feedback.checks[1].tests[0].status, "passed");
    assert.ok(prompts.every(prompt => !prompt.includes(targetMarker) && !prompt.includes(regressionMarker)));
    const verified = [];
    for (const attempt of report.attempts) {
      assert.equal(attempt.reviewed, true);
      assert.ok(attempt.verificationReport);
      verified.push(JSON.parse(await readFile(attempt.verificationReport, "utf8")));
    }
    assert.deepEqual(verified.map(result => result.status), ["unresolved", "resolved"]);
    assert.deepEqual(report.attempts.map(attempt => attempt.status), ["unresolved", "resolved"]);
    assert.deepEqual(report.attempts.map(attempt => attempt.modelRequests), [1, 1]);
    assert.ok(report.reviewWaitMs >= 30, "Both deliberately delayed review callbacks count as review time.");
    assert.ok(Math.abs(report.activeMs + report.reviewWaitMs - report.wallMs) < 1);
    assert.ok(Math.abs(report.reviewWaitMs - report.attempts.reduce((sum, attempt) => sum + attempt.reviewWaitMs, 0)) < 1);
    for (const attempt of report.attempts) {
      assert.ok(attempt.wallMs >= attempt.reviewWaitMs);
      assert.ok(Math.abs(attempt.activeMs + attempt.reviewWaitMs - attempt.wallMs) < 1);
      assert.ok(attempt.cumulativeWallMs >= attempt.wallMs);
      assert.ok(attempt.cumulativeWallMs <= report.wallMs);
    }
    assert.ok(report.attempts[1].cumulativeWallMs > report.attempts[0].cumulativeWallMs);
    assert.notEqual(verified[0].artifacts.worktree, verified[1].artifacts.worktree);
    assert.ok(report.artifacts.patch);
    assert.ok((await stat(report.artifacts.patch)).size > 0);
    assert.equal(await readFile(join(fixture.repo, "src/value.ts"), "utf8"), original);
    assert.equal(await fixture.git(["rev-parse", "HEAD"]), fixture.task.baseCommit);
    assert.equal(await fixture.git(["status", "--porcelain=v1"]), "");
  });
});

test("repair stops after three distinct failed candidates without a fourth request", async () => {
  await withFixture(async fixture => {
    let requests = 0;
    let reviews = 0;
    const report = await fixture.run(async () => { reviews++; return true; }, async () => edit(++requests + 1));
    assert.equal(report.status, "unresolved");
    assert.equal(report.code, "ATTEMPT_LIMIT");
    assert.equal(report.maxAttempts, 3);
    assert.equal(report.modelRequests, 3);
    assert.equal(requests, 3);
    assert.equal(reviews, 3);
    assert.equal(report.attempts.length, 3);
    assert.equal(report.attempts.every(attempt => attempt.reviewed && attempt.verificationReport), true);
    assert.equal(report.attempts.every(attempt => attempt.status === "unresolved" && attempt.modelRequests === 1), true);
    assert.equal(report.attempts.at(-1)?.code, "ATTEMPT_LIMIT");
    assert.equal(report.artifacts.patch, null);
    assert.equal(await fixture.git(["status", "--porcelain=v1"]), "");
  });
});

test("repair stops a duplicate candidate before another review or verification", async () => {
  await withFixture(async fixture => {
    let requests = 0;
    let reviews = 0;
    const report = await fixture.run(async () => { reviews++; return true; }, async () => { requests++; return edit(2); });
    assert.equal(report.status, "unresolved");
    assert.equal(report.code, "DUPLICATE_CANDIDATE");
    assert.equal(requests, 2);
    assert.equal(report.modelRequests, 2);
    assert.equal(reviews, 1);
    assert.equal(report.attempts.length, 2);
    assert.equal(report.attempts[0].candidateHash, report.attempts[1].candidateHash);
    assert.ok(report.attempts[0].verificationReport);
    assert.equal(report.attempts[1].verificationReport, null);
    assert.equal(report.attempts[1].reviewed, false);
    assert.equal(report.attempts[1].status, "unresolved");
    assert.equal(report.attempts[1].code, "DUPLICATE_CANDIDATE");
    assert.equal(report.artifacts.patch, null);
  });
});

test("declining candidate review preserves the patch without executing verification", async () => {
  await withFixture(async fixture => {
    let requests = 0;
    let reviews = 0;
    const report = await fixture.run(async () => { reviews++; return false; }, async () => { requests++; return edit(0); });
    assert.equal(report.status, "awaiting_review");
    assert.equal(requests, 1);
    assert.equal(reviews, 1);
    assert.equal(report.modelRequests, 1);
    assert.equal(report.attempts.length, 1);
    assert.equal(report.attempts[0].reviewed, false);
    assert.equal(report.attempts[0].status, "awaiting_review");
    assert.equal(report.attempts[0].verificationReport, null);
    assert.ok(report.attempts[0].patch);
    assert.ok((await stat(report.attempts[0].patch)).size > 0);
    assert.equal(report.artifacts.patch, null);
    assert.equal(report.artifacts.verification, null);
  });
});

test("invalid model edit stops repair without review, verification or another request", async () => {
  await withFixture(async fixture => {
    let requests = 0;
    let reviews = 0;
    const report = await fixture.run(async () => { reviews++; return true; }, async () => {
      requests++;
      return { edits: [{ path: "test/reproduce.test.ts", before: "value must be zero", after: "different target" }] };
    });
    assert.equal(report.status, "error");
    assert.equal(requests, 1);
    assert.equal(reviews, 0);
    assert.equal(report.modelRequests, 1);
    assert.equal(report.attempts.length, 1);
    assert.equal(report.attempts[0].patch, null);
    assert.equal(report.attempts[0].status, "error");
    assert.equal(report.attempts[0].reviewWaitMs, 0);
    assert.equal(report.reviewWaitMs, 0);
    assert.equal(report.attempts[0].verificationReport, null);
    assert.equal(report.artifacts.patch, null);
    assert.equal(await fixture.git(["status", "--porcelain=v1"]), "");
  });
});

test("cancellation after model generation stops repair before review or applying edits", async () => {
  await withFixture(async fixture => {
    const controller = new AbortController();
    let reviews = 0;
    const report = await fixture.run(async () => { reviews++; return true; }, async () => {
      controller.abort();
      return edit(0);
    }, controller.signal);
    assert.equal(report.status, "error");
    assert.equal(report.code, "OPERATION_CANCELLED");
    assert.equal(report.modelRequests, 1);
    assert.equal(report.attempts.length, 1);
    assert.equal(report.attempts[0].patch, null);
    assert.equal(report.attempts[0].verificationReport, null);
    assert.equal(reviews, 0);
    assert.equal(await fixture.git(["status", "--porcelain=v1"]), "");
  });
});

test("cancellation during review prevents verification and subsequent repair attempts", async () => {
  await withFixture(async fixture => {
    const controller = new AbortController();
    const report = await fixture.run(async () => {
      controller.abort();
      return true;
    }, async () => edit(0), controller.signal);
    assert.equal(report.status, "error");
    assert.equal(report.code, "OPERATION_CANCELLED");
    assert.equal(report.modelRequests, 1);
    assert.equal(report.attempts.length, 1);
    assert.equal(report.attempts[0].reviewed, false);
    assert.equal(report.attempts[0].verificationReport, null);
    assert.equal(report.artifacts.patch, null);
    assert.equal(await fixture.git(["status", "--porcelain=v1"]), "");
  });
});

test("progress cancellation at baseline prevents model generation and later stages", async () => {
  await withFixture(async fixture => {
    const controller = new AbortController();
    const progress: TaskProgress[] = [];
    let requests = 0;
    let reviews = 0;
    const report = await fixture.run(async () => { reviews++; return true; }, async () => {
      requests++;
      throw new Error("No model request should run after progress cancellation");
    }, controller.signal, event => { progress.push(event); controller.abort(); });
    assert.equal(report.status, "error");
    assert.equal(report.code, "OPERATION_CANCELLED");
    assert.deepEqual(progress, [{ stage: "baseline", attempt: 1 }]);
    assert.equal(requests, 0);
    assert.equal(reviews, 0);
    assert.equal(report.attempts[0].verificationReport, null);
  });
});

test("declining review reports reached stages without starting verification", async () => {
  await withFixture(async fixture => {
    const progress: TaskProgress[] = [];
    const report = await fixture.run(async () => false, async () => edit(0), undefined, event => progress.push(event));
    assert.equal(report.status, "awaiting_review");
    assert.deepEqual(progress, ["baseline", "localize", "generate", "review"].map(stage => ({ stage, attempt: 1 })));
    assert.equal(report.attempts[0].verificationReport, null);
    assert.ok(progress.every(event => Object.keys(event).sort().join(",") === "attempt,stage"));
  });
});

test("progress cancellation before verification leaves the candidate unverified", async () => {
  await withFixture(async fixture => {
    const controller = new AbortController();
    const progress: TaskProgress[] = [];
    const report = await fixture.run(async () => true, async () => edit(0), controller.signal, event => {
      progress.push(event);
      if (event.stage === "verify") controller.abort();
    });
    assert.equal(report.status, "error");
    assert.equal(report.code, "OPERATION_CANCELLED");
    assert.deepEqual(progress.map(event => event.stage), ["baseline", "localize", "generate", "review", "verify"]);
    assert.equal(report.attempts[0].verificationReport, null);
    assert.equal(report.artifacts.patch, null);
  });
});
