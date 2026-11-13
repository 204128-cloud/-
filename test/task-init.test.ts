import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { findGitExecutable } from "../src/git.ts";
import { executionEnvironment, runProcess } from "../src/process.ts";
import { loadTask, TaskInputError } from "../src/task.ts";
import { buildTask, inspectTaskRepository, saveTask } from "../src/task-init.ts";

async function fixture(t: TestContext, options: { lock?: boolean; sources?: boolean; commit?: boolean } = {}) {
  const parent = resolve(tmpdir());
  const directory = await mkdtemp(join(parent, "repopilot-task-init-"));
  const repo = join(directory, "repository");
  await mkdir(join(repo, "src"), { recursive: true });
  const env = executionEnvironment();
  const executable = await findGitExecutable(env);
  assert.ok(executable);
  async function git(args: string[]) {
    const result = await runProcess(executable!, args, { cwd: repo, env, timeoutMs: 15_000, captureOutput: true });
    assert.equal(result.exitCode, 0, "Fixture Git command must succeed");
    return result.stdout.trim();
  }
  await git(["init", "--initial-branch=main"]);
  await writeFile(join(repo, "package.json"), JSON.stringify({ name: "task-fixture", scripts: {
    "test:reproduce": "node --test test/target.test.ts", "test:regression": "node --test test/existing.test.ts",
    "bad;script": "do not offer", "build": "node -e 0",
  } }));
  if (options.lock !== false) await writeFile(join(repo, "package-lock.json"), "{}");
  if (options.sources !== false) {
    await writeFile(join(repo, "src/value.ts"), "export const value = 1;\n");
    await writeFile(join(repo, "src/value.test.ts"), "// not an authorized source\n");
    await writeFile(join(repo, "src/config.ts"), "// not an authorized source\n");
  }
  if (options.commit !== false) {
    await git(["add", "."]);
    await git(["-c", "user.name=RepoPilot Test Fixture", "-c", "user.email=fixture@localhost", "-c",
      `core.hooksPath=${join(directory, "no-hooks")}`, "commit", "--quiet", "-m", "Task init fixture"]);
  }
  t.after(async () => { assert.equal(dirname(resolve(directory)), parent); await rm(directory, { recursive: true, force: true }); });
  return { directory, repo, git };
}

const input = () => ({ id: "empty-input", issue: "Empty input should return zero.", reproduceScript: "test:reproduce",
  regressionScript: "test:regression", expectedFailure: "returns zero for empty input", allowedPaths: ["src/value.ts"] });
const errorCode = (code: string) => (error: unknown) => error instanceof TaskInputError && error.code === code;

test("repository inspection uses one committed snapshot and ignores dirty scripts and new files", async t => {
  const f = await fixture(t);
  const head = await f.git(["rev-parse", "HEAD"]);
  await writeFile(join(f.repo, "package.json"), JSON.stringify({ scripts: { "uncommitted": "node -e 1" } }));
  await writeFile(join(f.repo, "src/uncommitted.ts"), "export const value = 99;\n");
  const snapshot = await inspectTaskRepository(join(f.repo, "src"));
  assert.equal(snapshot.repoPath, await realpath(f.repo));
  assert.equal(snapshot.baseCommit, head);
  assert.deepEqual(snapshot.scripts, ["build", "test:regression", "test:reproduce"]);
  assert.deepEqual(snapshot.sourcePaths, ["src/value.ts"]);
  assert.ok((await f.git(["status", "--porcelain=v1"])).includes("uncommitted.ts"));
});

test("builds only explicitly selected scripts and sources into a loadable non-overwriting task", async t => {
  const f = await fixture(t);
  const snapshot = await inspectTaskRepository(f.repo);
  const task = await buildTask(snapshot, input());
  const output = join(f.directory, "tasks", "new-task.json");
  assert.equal(await saveTask(task, output), output);
  assert.deepEqual(await loadTask(output), task);
  const before = await readFile(output, "utf8");
  await assert.rejects(saveTask({ ...task, issue: "Another issue" }, output), errorCode("TASK_OUTPUT_EXISTS"));
  assert.equal(await readFile(output, "utf8"), before);
  assert.equal(await f.git(["status", "--porcelain=v1"]), "");
});

test("rejects missing or repeated script names and unauthorized or duplicate source selections", async t => {
  const f = await fixture(t);
  const snapshot = await inspectTaskRepository(f.repo);
  for (const invalid of [
    { ...input(), reproduceScript: "missing" },
    { ...input(), regressionScript: "test:reproduce" },
    { ...input(), allowedPaths: ["src/uncommitted.ts"] },
    { ...input(), allowedPaths: ["src/value.test.ts"] },
    { ...input(), allowedPaths: [] },
    { ...input(), allowedPaths: ["src/value.ts", "src/value.ts"] },
  ]) await assert.rejects(buildTask(snapshot, invalid), error => error instanceof TaskInputError);
});

test("rejects non-repositories, unborn HEAD, missing committed lockfiles and absent eligible sources", async t => {
  const noCommit = await fixture(t, { commit: false });
  await assert.rejects(inspectTaskRepository(noCommit.repo), errorCode("TASK_INIT_COMMIT_REQUIRED"));
  const noLock = await fixture(t, { lock: false });
  await assert.rejects(inspectTaskRepository(noLock.repo), errorCode("TASK_INIT_LOCKFILE_REQUIRED"));
  const noSources = await fixture(t, { sources: false });
  await assert.rejects(inspectTaskRepository(noSources.repo), errorCode("TASK_INIT_NO_SOURCES"));
  await assert.rejects(inspectTaskRepository(noSources.directory), errorCode("TASK_INIT_NOT_REPOSITORY"));
});

test("blocks credentials before task content or sensitive output paths can be saved", async t => {
  const f = await fixture(t);
  const snapshot = await inspectTaskRepository(f.repo);
  const marker = "sk-LOCAL_FAKE_TASK_INIT_ONLY";
  await assert.rejects(buildTask(snapshot, { ...input(), issue: marker }), error => {
    assert.ok(error instanceof TaskInputError);
    assert.equal(error.code, "TASK_INIT_UNSAFE_CONTENT");
    assert.ok(!error.message.includes(marker));
    return true;
  });
  const task = await buildTask(snapshot, input());
  await assert.rejects(saveTask({ ...task, expectedFailure: marker }, join(f.directory, "unsafe.json")), errorCode("TASK_INIT_UNSAFE_CONTENT"));
  await assert.rejects(saveTask(task, join(f.directory, marker + ".json")), errorCode("TASK_INIT_UNSAFE_CONTENT"));
});

test("a pre-cancelled inspection does not inspect a repository", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(inspectTaskRepository("nonexistent-repository", controller.signal), errorCode("TASK_INIT_CANCELLED"));
});
