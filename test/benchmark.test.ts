import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { BenchmarkError, loadBenchmarkSuite, summarizeBenchmark, type BenchmarkRow } from "../src/benchmark.ts";
import type { Task } from "../src/task.ts";

const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const privateMarker = "SYNTHETIC_PRIVATE_BENCHMARK_INPUT_NOT_A_CREDENTIAL";
const hasCode = (code: string) => (error: unknown) => {
  assert.ok(error instanceof BenchmarkError);
  assert.equal(error.code, code);
  assert.equal(error.message.includes(privateMarker), false);
  assert.equal(error.stack?.includes(privateMarker), false);
  return true;
};

async function withSuite(run: (fixture: {
  suiteFile: string; taskFile: string; task: Task; entry: { path: string; sha256: string };
  writeSuite: (value: unknown, raw?: boolean) => Promise<void>;
}) => Promise<void>) {
  const temporaryRoot = await realpath(resolve(tmpdir()));
  const directory = await mkdtemp(join(temporaryRoot, "repopilot-benchmark-test-"));
  try {
    await mkdir(join(directory, "tasks"));
    await mkdir(join(directory, "suites"));
    const task: Task = {
      id: "benchmark-case", repoPath: join(directory, "unused-repository"), baseCommit: "a".repeat(40),
      issue: "Empty pagination should return zero pages.", reproduceScript: "test:reproduce", regressionScript: "test:regression",
      expectedFailure: "empty pagination", allowedPaths: ["src/paginate.ts"],
    };
    const taskFile = join(directory, "tasks/first.json");
    const bytes = JSON.stringify(task, null, 2) + "\n";
    await writeFile(taskFile, bytes);
    const entry = { path: "../tasks/first.json", sha256: hash(bytes) };
    const suiteFile = join(directory, "suites/smoke.json");
    const writeSuite = (value: unknown, raw = false) => writeFile(suiteFile, raw ? String(value) : JSON.stringify(value, null, 2) + "\n");
    await writeSuite({ id: "smoke-v1", tasks: [entry] });
    await run({ suiteFile, taskFile, task, entry, writeSuite });
  } finally {
    const absoluteDirectory = await realpath(directory);
    assert.equal(dirname(absoluteDirectory), temporaryRoot);
    await rm(absoluteDirectory, { recursive: true, force: true });
  }
}

test("benchmark suite pins raw task bytes and resolves paths relative to its own directory", async () => {
  await withSuite(async fixture => {
    const loaded = await loadBenchmarkSuite(fixture.suiteFile);
    assert.equal(loaded.id, "smoke-v1");
    assert.equal(loaded.suiteHash, hash(await readFile(fixture.suiteFile)));
    assert.deepEqual(loaded.tasks, [{ taskPath: await realpath(fixture.taskFile), taskHash: fixture.entry.sha256, task: fixture.task }]);
  });
});

test("malformed suites, unknown fields and empty task sets are rejected without echoing input", async () => {
  await withSuite(async fixture => {
    for (const value of [
      { id: "smoke-v1", tasks: [] },
      { id: "smoke-v1", tasks: [fixture.entry], unknown: privateMarker },
      { id: "smoke-v1", tasks: [{ ...fixture.entry, unknown: privateMarker }] },
      { id: "smoke-v1", tasks: [{ ...fixture.entry, sha256: "A".repeat(64) }] },
    ]) {
      await fixture.writeSuite(value);
      await assert.rejects(loadBenchmarkSuite(fixture.suiteFile), hasCode("BENCHMARK_SUITE_INVALID"));
    }
    await fixture.writeSuite(`{${privateMarker}`, true);
    await assert.rejects(loadBenchmarkSuite(fixture.suiteFile), hasCode("BENCHMARK_SUITE_INVALID"));
  });
});

test("suite task paths must be relative and nonempty", async () => {
  await withSuite(async fixture => {
    for (const path of [fixture.taskFile, "", " \t", "/absolute-task.json", "../tasks/first.json\n"]) {
      await fixture.writeSuite({ id: "smoke-v1", tasks: [{ ...fixture.entry, path }] });
      await assert.rejects(loadBenchmarkSuite(fixture.suiteFile), hasCode("BENCHMARK_SUITE_INVALID"));
    }
  });
});

test("changed raw task bytes invalidate a pinned suite even when the task still parses identically", async () => {
  await withSuite(async fixture => {
    await writeFile(fixture.taskFile, JSON.stringify(fixture.task));
    await assert.rejects(loadBenchmarkSuite(fixture.suiteFile), hasCode("BENCHMARK_TASK_HASH_MISMATCH"));
  });
});

test("a canonical task path cannot appear twice through relative aliases", async () => {
  await withSuite(async fixture => {
    await fixture.writeSuite({ id: "smoke-v1", tasks: [fixture.entry, { ...fixture.entry, path: "../tasks/../tasks/first.json" }] });
    await assert.rejects(loadBenchmarkSuite(fixture.suiteFile), hasCode("BENCHMARK_TASK_DUPLICATE"));
  });
});

test("different task files cannot reuse the same task id", async () => {
  await withSuite(async fixture => {
    const second = { ...fixture.task, issue: "Another description of the same task identity." };
    const content = JSON.stringify(second);
    await writeFile(join(dirname(fixture.taskFile), "second.json"), content);
    await fixture.writeSuite({ id: "smoke-v1", tasks: [fixture.entry, { path: "../tasks/second.json", sha256: hash(content) }] });
    await assert.rejects(loadBenchmarkSuite(fixture.suiteFile), hasCode("BENCHMARK_TASK_DUPLICATE"));
  });
});

test("matching hashes do not permit malformed tasks or expose their raw contents", async () => {
  await withSuite(async fixture => {
    for (const content of [JSON.stringify({ ...fixture.task, issue: privateMarker, baseCommit: "PLACEHOLDER" }), `{${privateMarker}`]) {
      await writeFile(fixture.taskFile, content);
      await fixture.writeSuite({ id: "smoke-v1", tasks: [{ ...fixture.entry, sha256: hash(content) }] });
      await assert.rejects(loadBenchmarkSuite(fixture.suiteFile), hasCode("BENCHMARK_TASK_INVALID"));
    }
  });
});

test("missing task files have a safe task-input error", async () => {
  await withSuite(async fixture => {
    await fixture.writeSuite({ id: "smoke-v1", tasks: [{ path: "../tasks/missing.json", sha256: "0".repeat(64) }] });
    await assert.rejects(loadBenchmarkSuite(fixture.suiteFile), hasCode("BENCHMARK_TASK_INVALID"));
  });
});

function row(taskId: string, single: BenchmarkRow["single"], feedback: BenchmarkRow["feedback"]): BenchmarkRow {
  return { taskId, taskPath: resolve(tmpdir(), `${taskId}.json`), taskHash: "a".repeat(64), baseCommit: "b".repeat(40),
    sourceFingerprint: "c".repeat(64), repairReport: resolve(tmpdir(), `${taskId}-repair.json`), single, feedback };
}

function outcome(status: NonNullable<BenchmarkRow["single"]>["status"], modelRequests: number, wallMs = 20, reviewWaitMs = 5) {
  return { status, modelRequests, wallMs, reviewWaitMs, activeMs: wallMs - reviewWaitMs, verificationReport: null };
}

test("paired summaries retain fixed task counts and do not add shared-prefix calls twice", () => {
  const summary = summarizeBenchmark([
    row("first", outcome("unresolved", 1, 20, 5), outcome("resolved", 2, 50, 10)),
    row("second", outcome("resolved", 1, 30, 10), outcome("resolved", 1, 30, 10)),
  ]);
  assert.equal(summary.plannedTasks, 2);
  assert.equal(summary.processedTasks, 2);
  assert.deepEqual(summary.single.statusCounts, { resolved: 1, unresolved: 1, not_reproduced: 0, awaiting_review: 0, error: 0, not_run: 0 });
  assert.deepEqual(summary.feedback.statusCounts, { resolved: 2, unresolved: 0, not_reproduced: 0, awaiting_review: 0, error: 0, not_run: 0 });
  assert.equal(summary.single.modelRequests, 2);
  assert.equal(summary.feedback.modelRequests, 3);
  assert.equal(summary.single.wallMs, 50);
  assert.equal(summary.single.reviewWaitMs, 15);
  assert.equal(summary.single.activeMs, 35);
  assert.equal(summary.feedback.wallMs, 80);
  assert.equal(summary.feedback.reviewWaitMs, 20);
  assert.equal(summary.feedback.activeMs, 60);
});

test("unrun and unreviewed tasks remain separate from failed repairs in the fixed denominator", () => {
  const summary = summarizeBenchmark([
    row("pending-review", outcome("awaiting_review", 1), outcome("awaiting_review", 1)),
    row("not-started", null, null),
  ]);
  assert.equal(summary.plannedTasks, 2);
  assert.equal(summary.processedTasks, 1);
  for (const strategy of [summary.single, summary.feedback]) {
    assert.equal(strategy.statusCounts.awaiting_review, 1);
    assert.equal(strategy.statusCounts.not_run, 1);
    assert.equal(strategy.statusCounts.unresolved, 0);
    assert.equal(strategy.statusCounts.error, 0);
    assert.equal(strategy.modelRequests, 1);
  }
});

test("infrastructure errors and tasks without reproduced failures have distinct result counts", () => {
  const summary = summarizeBenchmark([
    row("environment-error", { ...outcome("error", 0), code: "GIT_NOT_FOUND" }, { ...outcome("error", 0), code: "GIT_NOT_FOUND" }),
    row("already-passing", outcome("not_reproduced", 0), outcome("not_reproduced", 0)),
  ]);
  assert.equal(summary.plannedTasks, 2);
  assert.equal(summary.processedTasks, 2);
  for (const strategy of [summary.single, summary.feedback]) {
    assert.equal(strategy.statusCounts.error, 1);
    assert.equal(strategy.statusCounts.not_reproduced, 1);
    assert.equal(strategy.statusCounts.unresolved, 0);
    assert.equal(strategy.statusCounts.resolved, 0);
    assert.equal(strategy.modelRequests, 0);
  }
});
