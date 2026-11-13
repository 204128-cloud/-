import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { loadTask, TaskInputError, type Task } from "../src/task.ts";

function validTask(): Task {
  return {
    id: "pagination-empty-001", repoPath: resolve(tmpdir(), "repopilot-local-repo"),
    baseCommit: "a".repeat(40), issue: "Empty input reports one page instead of zero.",
    reproduceScript: "test:reproduce", regressionScript: "test:regression",
    expectedFailure: "paginate returns zero pages for empty input", allowedPaths: ["src/paginate.ts"],
  };
}

async function withTask(value: unknown, verify: (file: string) => Promise<void>, raw = false) {
  const tempRoot = resolve(tmpdir());
  const directory = await mkdtemp(join(tempRoot, "repopilot-task-test-"));
  try {
    const file = join(directory, "task.json");
    await writeFile(file, raw ? String(value) : JSON.stringify(value), "utf8");
    await verify(file);
  } finally {
    assert.equal(dirname(resolve(directory)), tempRoot);
    await rm(directory, { recursive: true, force: true });
  }
}

function rejectsCode(code: string) {
  return (error: unknown) => error instanceof TaskInputError && error.code === code;
}

test("a complete task passes format validation without needing an existing repository", async () => {
  const task = validTask();
  await withTask(task, async file => assert.deepEqual(await loadTask(file), task));
});

test("the template commit placeholder is rejected", async () => {
  await assert.rejects(loadTask(fileURLToPath(new URL("../tasks/pagination-empty.template.json", import.meta.url))), rejectsCode("TASK_SCHEMA_INVALID"));
});

test("unknown fields, invalid script names and duplicate paths are rejected by the shared schema", async () => {
  for (const task of [
    { ...validTask(), apiKey: "YOUR_API_KEY_HERE" },
    { ...validTask(), reproduceScript: "test;unexpected" },
    { ...validTask(), allowedPaths: ["src/paginate.ts", "src/paginate.ts"] },
  ]) {
    await withTask(task, async file => assert.rejects(loadTask(file), rejectsCode("TASK_SCHEMA_INVALID")));
  }
});

test("relative and drive-relative repository paths are rejected", async () => {
  const paths = process.platform === "win32" ? ["local-repo", "D:local-repo", "\\local-repo"] : ["local-repo"];
  for (const repoPath of paths) {
    await withTask({ ...validTask(), repoPath }, async file => assert.rejects(loadTask(file), rejectsCode("TASK_REPO_PATH_INVALID")));
  }
});

test("source ranges reject traversal, aliases, globs, test files and configuration", async () => {
  for (const path of [
    "../src/paginate.ts", "/src/paginate.ts", "src/../paginate.ts", "src/./paginate.ts", "src//paginate.ts",
    "src\\paginate.ts", "src/*.ts", "src/paginate.ts:stream", "src/paginate.ts\n", "src /paginate.ts",
    "test/paginate.ts", "src/paginate.test.ts", "src/paginate.spec.ts", "src/__tests__/paginate.ts",
    "src/config.ts", "src/config/paginate.ts", "src/vitest.config.ts", "src/package.json", "src/folder /paginate.ts",
  ]) {
    await withTask({ ...validTask(), allowedPaths: [path] }, async file => assert.rejects(loadTask(file), rejectsCode("TASK_ALLOWED_PATH_INVALID")));
  }
});

test("Windows source identity is case insensitive", { skip: process.platform !== "win32" }, async () => {
  await withTask({ ...validTask(), allowedPaths: ["src/paginate.ts", "src/Paginate.ts"] }, async file => {
    await assert.rejects(loadTask(file), rejectsCode("TASK_ALLOWED_PATH_INVALID"));
  });
});

test("JSON and read failures never echo input content", async () => {
  const privateMarker = "PRIVATE_TEST_INPUT_NOT_A_CREDENTIAL";
  await withTask(`{${privateMarker}`, async file => {
    await assert.rejects(loadTask(file), error => {
      assert.ok(error instanceof TaskInputError);
      assert.equal(error.code, "TASK_JSON_INVALID");
      assert.ok(!error.message.includes(privateMarker));
      return true;
    });
  }, true);
  await assert.rejects(loadTask(join(tmpdir(), "repopilot-no-such-task", "task.json")), rejectsCode("TASK_READ_FAILED"));
});
