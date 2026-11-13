import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { runTaskWizard } from "../src/task-wizard.ts";
import { TaskInputError, type Task } from "../src/task.ts";

const snapshot = {
  repoPath: resolve("sample-repo"), baseCommit: "a".repeat(40),
  scripts: ["test:reproduce", "test:regression"],
  sourcePaths: ["src/a.ts", "src/b.ts", "src/c.ts"],
};

function setup(answers: Array<string | undefined>) {
  const prompts: string[] = [];
  const output: string[] = [];
  const saved: Array<{ task: Task; path: string }> = [];
  const checked: string[] = [];
  return { prompts, output, saved, checked, dependencies: {
    ask: async (prompt: string) => { prompts.push(prompt); return answers.shift(); },
    write: (text: string) => { output.push(text); },
    inspect: async () => snapshot,
    build: async (_repo: typeof snapshot, input: Omit<Task, "repoPath" | "baseCommit">) => ({
      ...input, repoPath: snapshot.repoPath, baseCommit: snapshot.baseCommit,
    }),
    save: async (task: Task, path: string) => { saved.push({ task, path }); return resolve(path); },
    baseline: async (path: string) => {
      checked.push(path);
      return { baselineStatus: "ready" as const, reportPath: resolve("baseline.json") };
    },
  } };
}

const fields = ["custom-task", "Empty input returns the wrong count", "1", "1", "suite > expected zero", "1,3"];

test("creates a task from explicit selections and does not run precheck by default", async () => {
  const fixture = setup([...fields, "", "yes", ""]);
  const result = await runTaskWizard("selected-repository", fixture.dependencies);
  assert.equal(result.kind, "task_initialization");
  assert.equal(result.status, "created");
  assert.equal(result.precheck, null);
  assert.equal(fixture.saved.length, 1);
  assert.ok(fixture.saved[0].path.endsWith("custom-task.json"));
  assert.deepEqual(fixture.saved[0].task.allowedPaths, ["src/a.ts", "src/c.ts"]);
  assert.equal(fixture.saved[0].task.reproduceScript, "test:reproduce");
  assert.equal(fixture.saved[0].task.regressionScript, "test:regression");
  assert.equal(fixture.saved[0].task.expectedFailure, "suite > expected zero");
  assert.deepEqual(fixture.checked, []);
  assert.match(fixture.output.join("\n"), /未提交/);
  assert.match(fixture.prompts.join("\n"), /父名称 > 子名称/);
  assert.match(fixture.output.join("\n"), /baseline/);
  assert.match(fixture.output.join("\n"), /tui/);
});

test("declining the final task summary writes nothing and runs no scripts", async () => {
  const fixture = setup([...fields, "", "no"]);
  const result = await runTaskWizard("repository", fixture.dependencies);
  assert.equal(result.status, "cancelled");
  assert.equal(result.taskPath, null);
  assert.deepEqual(fixture.saved, []);
  assert.deepEqual(fixture.checked, []);
});

test("corrects invalid selections and never echoes credential input", async () => {
  const fakeKey = "sk-LOCAL_FAKE_WIZARD_TEST_ONLY";
  const fixture = setup([
    "bad id", "safe-id", "", fakeKey, "Valid issue", "0", "1", "2", "1", "", "suite > target",
    "all", "1,1", "1,3", "", "yes", "no",
  ]);
  const result = await runTaskWizard("repository", fixture.dependencies);
  assert.equal(result.status, "created");
  assert.equal(fixture.saved[0].task.issue, "Valid issue");
  assert.deepEqual(fixture.saved[0].task.allowedPaths, ["src/a.ts", "src/c.ts"]);
  assert.ok(!fixture.output.join("\n").includes(fakeKey));
  assert.ok(!JSON.stringify(result).includes(fakeKey));
  assert.ok(fixture.prompts.length > fields.length + 3);
});

test("runs precheck only after explicit yes and keeps a created task when precheck fails", async () => {
  const fixture = setup([...fields, "", "yes", "yes"]);
  let signal: AbortSignal | undefined;
  const result = await runTaskWizard("repository", { ...fixture.dependencies,
    baseline: async (path, operationSignal) => {
      fixture.checked.push(path); signal = operationSignal;
      return { baselineStatus: "error", reportPath: resolve("failed-baseline.json"), code: "TARGET_TEST_MISSING" };
    },
  });
  assert.equal(result.status, "created");
  assert.equal(result.precheck?.baselineStatus, "error");
  assert.equal(result.precheck?.code, "TARGET_TEST_MISSING");
  assert.equal(fixture.saved.length, 1);
  assert.equal(fixture.checked.length, 1);
  assert.ok(signal instanceof AbortSignal);
  assert.match(fixture.prompts.at(-1)!, /依赖.*测试.*不调用模型/);
});

test("an existing output file requires a different path and another explicit confirmation", async () => {
  const fixture = setup([...fields, "existing.json", "yes", "new-task.json", "yes", "no"]);
  let attempts = 0;
  const result = await runTaskWizard("repository", { ...fixture.dependencies,
    save: async (task, path) => {
      if (++attempts === 1) throw new TaskInputError("TASK_OUTPUT_EXISTS", "任务文件已存在，请选择其他路径。");
      fixture.saved.push({ task, path }); return resolve(path);
    },
  });
  assert.equal(result.status, "created");
  assert.equal(attempts, 2);
  assert.equal(fixture.saved[0].path, resolve("new-task.json"));
  assert.equal(fixture.prompts.filter(prompt => prompt.includes("输入 yes 保存")).length, 2);
});

test("an incomplete dialogue cancels before writing and missing repository arguments are prompted", async () => {
  const fixture = setup(["repository", undefined]);
  const result = await runTaskWizard(undefined, fixture.dependencies);
  assert.equal(result.status, "cancelled");
  assert.match(fixture.prompts[0], /仓库/);
  assert.deepEqual(fixture.saved, []);
});

test("uses a safe default id for a repository with a Chinese name", async () => {
  const fixture = setup(["", ...fields.slice(1), "", "yes", "no"]);
  const result = await runTaskWizard("repository", { ...fixture.dependencies,
    inspect: async () => ({ ...snapshot, repoPath: resolve("示例仓库") }),
  });
  assert.equal(result.status, "created");
  assert.equal(fixture.saved[0].task.id, "task-fix");
});

test("cancelling the optional baseline passes its signal and keeps the saved task", async () => {
  const fixture = setup([...fields, "", "yes", "yes"]);
  const controller = new AbortController();
  const result = await runTaskWizard("repository", { ...fixture.dependencies, signal: controller.signal,
    baseline: async (_path, operationSignal) => {
      controller.abort();
      assert.equal(operationSignal?.aborted, true);
      return { baselineStatus: "error", reportPath: resolve("cancelled-baseline.json"), code: "OPERATION_CANCELLED" };
    },
  });
  assert.equal(result.status, "created");
  assert.equal(fixture.saved.length, 1);
  assert.equal(result.precheck?.code, "OPERATION_CANCELLED");
});
