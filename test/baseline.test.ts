import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runBaseline } from "../src/baseline.ts";
import { findGitExecutable } from "../src/git.ts";
import { executionEnvironment, runProcess } from "../src/process.ts";
import type { Task } from "../src/task.ts";

const project = fileURLToPath(new URL("..", import.meta.url));
const parent = join(project, ".repopilot", "baseline-tests");

async function fixture(mode: "broken" | "passing" | "regression-fails" | "changes-source", verify: (taskPath: string, task: Task) => Promise<void>) {
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(join(parent, "case-"));
  const repo = join(directory, "repo");
  await mkdir(join(repo, "src"), { recursive: true });
  await mkdir(join(repo, "test"));
  async function git(args: string[]) {
    const env = executionEnvironment();
    const executable = await findGitExecutable(env);
    assert.ok(executable, "Fixture needs Git");
    const result = await runProcess(executable, args, { cwd: repo, env, timeoutMs: 15_000, captureOutput: true });
    assert.equal(result.exitCode, 0, "Fixture Git command must succeed");
    return result.stdout.trim();
  }
  try {
    const name = "repopilot-baseline-fixture";
    await writeFile(join(repo, "package.json"), JSON.stringify({ name, version: "1.0.0", type: "module", scripts: {
      "test:reproduce": "node --test test/reproduce.test.ts", "test:regression": "node --test test/regression.test.ts",
    } }));
    await writeFile(join(repo, "package-lock.json"), JSON.stringify({ name, version: "1.0.0", lockfileVersion: 3, requires: true, packages: { "": { name, version: "1.0.0" } } }));
    await writeFile(join(repo, ".gitignore"), "node_modules/\n");
    await writeFile(join(repo, "src/value.ts"), `export const value = ${mode === "passing" ? 0 : 1};\n`);
    const mutation = mode === "changes-source" ? "import {appendFileSync} from 'node:fs'; appendFileSync(new URL('../src/value.ts',import.meta.url),'// modified by test\\n');" : "";
    await writeFile(join(repo, "test/reproduce.test.ts"), "import test from 'node:test'; import assert from 'node:assert/strict'; import {value} from '../src/value.ts'; " + mutation + " test('target assertion',()=>assert.equal(value,0));\n");
    await writeFile(join(repo, "test/regression.test.ts"), `import test from 'node:test'; import assert from 'node:assert/strict'; import {value} from '../src/value.ts'; test('existing behavior',()=>assert.equal(typeof value,'${mode === "regression-fails" ? "string" : "number"}'));\n`);
    await git(["init", "--initial-branch=main"]);
    await git(["add", "."]);
    await git(["-c", "user.name=RepoPilot Test Fixture", "-c", "user.email=fixture@localhost", "-c", "core.hooksPath=" + join(directory, "no-hooks"), "commit", "--quiet", "-m", "Baseline test fixture"]);
    const task: Task = {
      id: "baseline-test", repoPath: repo, baseCommit: await git(["rev-parse", "HEAD"]), issue: "Expected value is zero.",
      reproduceScript: "test:reproduce", regressionScript: "test:regression", expectedFailure: "target assertion", allowedPaths: ["src/value.ts"],
    };
    const taskPath = join(directory, "task.json");
    await writeFile(taskPath, JSON.stringify(task));
    await verify(taskPath, task);
  } finally {
    assert.equal(dirname(resolve(directory)), resolve(parent));
    await rm(directory, { recursive: true, force: true });
  }
}

async function checkedRun(taskPath: string, task: Task) {
  const result = await runBaseline(taskPath);
  const runDir = dirname(result.reportPath);
  assert.equal(dirname(resolve(runDir)), resolve(project, ".repopilot/runs"));
  return { result, async cleanup() {
    if (result.artifacts.worktree) {
      assert.equal(resolve(result.artifacts.worktree), resolve(runDir, "worktree"));
      const executable = await findGitExecutable(executionEnvironment());
      assert.ok(executable, "Fixture cleanup needs Git");
      const removal = await runProcess(executable, ["worktree", "remove", "--force", result.artifacts.worktree], {
        cwd: task.repoPath, env: executionEnvironment(), timeoutMs: 15_000,
      });
      assert.equal(removal.exitCode, 0);
    }
    await rm(runDir, { recursive: true, force: true });
  } };
}

test("baseline uses the committed version and preserves original uncommitted files", async () => {
  await fixture("broken", async (taskPath, task) => {
    const original = "export const value = 99; // local work\n";
    await writeFile(join(task.repoPath, "src/value.ts"), "export const value = 98; // staged work\n");
    const git = async (args: string[]) => {
      const env = executionEnvironment();
      const executable = await findGitExecutable(env);
      assert.ok(executable, "Fixture needs Git");
      const result = await runProcess(executable, args, { cwd: task.repoPath, env, timeoutMs: 15_000, captureOutput: true });
      assert.equal(result.exitCode, 0);
      return result.stdout;
    };
    await git(["add", "src/value.ts"]);
    const originalIndex = await git(["ls-files", "--stage"]);
    await writeFile(join(task.repoPath, "src/value.ts"), original);
    await writeFile(join(task.repoPath, "local-notes.txt"), "Keep my notes.");
    const { result, cleanup } = await checkedRun(taskPath, task);
    try {
      assert.equal(result.baselineStatus, "ready", result.reason);
      assert.equal(result.baseCommit, task.baseCommit);
      const tests = result.checks.filter(check => check.tests);
      assert.deepEqual(tests.map(check => [check.script, check.exitCode]), [["test:reproduce", 1], ["test:regression", 0]]);
      assert.equal(tests[0]?.tests?.[0]?.assertionFailure, true);
      assert.equal(tests[0]?.tests?.[0]?.file, "test/reproduce.test.ts");
      assert.equal(await readFile(join(task.repoPath, "src/value.ts"), "utf8"), original);
      assert.equal(await readFile(join(task.repoPath, "local-notes.txt"), "utf8"), "Keep my notes.");
      assert.equal(await git(["ls-files", "--stage"]), originalIndex);
      assert.equal((await git(["rev-parse", "HEAD"])).trim(), task.baseCommit);
      assert.equal((await readFile(join(result.artifacts.worktree!, "src/value.ts"), "utf8")).replaceAll("\r\n", "\n"), "export const value = 1;\n");
      assert.equal(result.artifacts.patch, null);
      assert.ok(result.artifacts.logs.length > 0);
    } finally { await cleanup(); }
  });
});

test("an already passing target is not reproduced", async () => {
  await fixture("passing", async (taskPath, task) => {
    const { result, cleanup } = await checkedRun(taskPath, task);
    try { assert.equal(result.baselineStatus, "not_reproduced"); }
    finally { await cleanup(); }
  });
});

test("a failing original regression set cannot become a ready baseline", async () => {
  await fixture("regression-fails", async (taskPath, task) => {
    const { result, cleanup } = await checkedRun(taskPath, task);
    try { assert.equal(result.baselineStatus, "error"); }
    finally { await cleanup(); }
  });
});

test("a nonexistent base commit produces an error without inventing a used commit", async () => {
  await fixture("broken", async (taskPath, task) => {
    await writeFile(taskPath, JSON.stringify({ ...task, baseCommit: "f".repeat(40) }));
    const { result, cleanup } = await checkedRun(taskPath, task);
    try {
      assert.equal(result.baselineStatus, "error");
      assert.equal(result.baseCommit, null);
      assert.equal(result.artifacts.worktree, null);
      assert.ok(result.checks.every(check => !check.tests));
    } finally { await cleanup(); }
  });
});

test("test side effects cannot silently change the committed baseline", async () => {
  await fixture("changes-source", async (taskPath, task) => {
    const { result, cleanup } = await checkedRun(taskPath, task);
    try {
      assert.equal(result.baselineStatus, "error");
      assert.equal(result.code, "BASELINE_CHANGED");
      assert.deepEqual(result.changedPaths, ["src/value.ts"]);
    } finally { await cleanup(); }
  });
});
