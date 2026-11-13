import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { findGitExecutable } from "../src/git.ts";
import { executionEnvironment, runProcess } from "../src/process.ts";
import type { Task } from "../src/task.ts";
import { verifyPatch } from "../src/verifier.ts";

const project = fileURLToPath(new URL("..", import.meta.url));
const parent = resolve(project, ".repopilot/verifier-tests");
const runsRoot = resolve(project, ".repopilot/runs");
type Result = Awaited<ReturnType<typeof verifyPatch>>;
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const source = (value = 0, mode = "normal") => `export const value = ${value};\nexport const mode = '${mode}';\n`;

function filePatch(path: string, before: string | undefined, after: string) {
  const lines = (text: string) => text.replace(/\n$/, "").split("\n");
  const previous = before === undefined ? [] : lines(before);
  const next = lines(after);
  return `diff --git a/${path} b/${path}\n${before === undefined ? "new file mode 100644\n" : ""}`
    + `--- ${before === undefined ? "/dev/null" : `a/${path}`}\n+++ b/${path}\n`
    + `@@ -${previous.length ? 1 : 0},${previous.length} +1,${next.length} @@\n`
    + previous.map(line => `-${line}\n`).join("") + next.map(line => `+${line}\n`).join("");
}

type Fixture = {
  directory: string; repo: string; taskPath: string; task: Task; files: Record<string, string>;
  git: (args: string[]) => Promise<string>;
  patch: (changes: Record<string, string>) => Promise<string>;
  run: (patch: string) => Promise<Result>;
};

async function withFixture(verify: (fixture: Fixture) => Promise<void>, initialValue = 1, multipleRegression = false) {
  const gitExecutable = await findGitExecutable(executionEnvironment());
  assert.ok(gitExecutable, "Private fixtures require an available Git executable.");
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(join(parent, "case-"));
  const repo = join(directory, "repo");
  const reports: Result[] = [];
  await mkdir(join(repo, "src"), { recursive: true });
  await mkdir(join(repo, "test"));
  const git = async (args: string[]) => {
    const result = await runProcess(gitExecutable, args, { cwd: repo, env: executionEnvironment(), timeoutMs: 15_000, captureOutput: true });
    assert.equal(result.exitCode, 0, "Private fixture Git command must succeed.");
    return result.stdout.trim();
  };
  try {
    const name = "repopilot-verifier-fixture";
    const files: Record<string, string> = {
      ".gitignore": "node_modules/\nignored.txt\n",
      "package.json": JSON.stringify({ name, version: "1.0.0", type: "module", scripts: {
        "test:reproduce": "node --test test/reproduce.test.ts",
        "test:regression": multipleRegression
          ? `node --test test/hidden-failure.test.ts ${process.platform === "win32" ? "&" : ";"} node --test test/regression.test.ts`
          : "node --test test/regression.test.ts",
      } }) + "\n",
      "package-lock.json": JSON.stringify({ name, version: "1.0.0", lockfileVersion: 3, requires: true, packages: { "": { name, version: "1.0.0" } } }) + "\n",
      "src/value.ts": source(initialValue),
      "test/reproduce.test.ts": `import test from 'node:test'; import assert from 'node:assert/strict'; import {value,mode} from '../src/value.ts';
if (mode !== 'zero') {
  if (mode === 'missing') test('different target',()=>assert.equal(typeof value,'number'));
  else test('target assertion',{skip:mode === 'skip'},()=>assert.equal(value,0));
}
`,
      "test/regression.test.ts": `import test from 'node:test'; import assert from 'node:assert/strict'; import {value,mode} from '../src/value.ts';
test('existing behavior',()=>assert.equal(typeof value,'number'));
if (mode !== 'drop-regression') test('existing second behavior',()=>assert.equal(typeof mode,'string'));
`,
    };
    if (multipleRegression) files["test/hidden-failure.test.ts"] = "import test from 'node:test'; import assert from 'node:assert/strict'; test('hidden failure',()=>assert.fail());\n";
    for (const [path, content] of Object.entries(files)) await writeFile(join(repo, path), content);
    await git(["init", "--initial-branch=main"]);
    await git(["config", "core.autocrlf", "false"]);
    await git(["add", "."]);
    await git(["-c", "user.name=RepoPilot Verifier Fixture", "-c", "user.email=fixture@localhost",
      "-c", `core.hooksPath=${join(directory, "no-hooks")}`, "commit", "--quiet", "-m", "Private verifier baseline"]);
    const task: Task = {
      id: "verifier-test", repoPath: repo, baseCommit: await git(["rev-parse", "HEAD"]), issue: "Value must be zero.",
      reproduceScript: "test:reproduce", regressionScript: "test:regression", expectedFailure: "target assertion", allowedPaths: ["src/value.ts"],
    };
    const taskPath = join(directory, "task.json");
    await writeFile(taskPath, JSON.stringify(task));
    let patchCount = 0;
    await verify({ directory, repo, taskPath, task, files, git,
      async patch(changes) {
        const path = join(directory, `candidate-${patchCount++}.diff`);
        await writeFile(path, Object.entries(changes).map(([file, after]) => filePatch(file, files[file], after)).join(""));
        return path;
      },
      async run(patch) {
        const result = await verifyPatch(taskPath, patch);
        reports.push(result);
        return result;
      },
    });
  } finally {
    for (const report of reports.reverse()) {
      const runDir = resolve(dirname(report.reportPath));
      assert.equal(dirname(runDir), runsRoot);
      for (const [worktree, expected] of [[report.artifacts.replayWorktree, "patch-replay"], [report.artifacts.worktree, "worktree"]]) {
        if (!worktree) continue;
        assert.equal(resolve(worktree), join(runDir, expected!));
        await git(["worktree", "remove", "--force", worktree]);
      }
      await rm(runDir, { recursive: true, force: true });
    }
    assert.equal(dirname(resolve(directory)), parent);
    await rm(directory, { recursive: true, force: true });
  }
}

const afterChecks = (result: Result) => result.checks.filter(check => check.phase.startsWith("after-"));

test("a legal fix is resolved with matching evidence, exported patch and replay", async () => {
  await withFixture(async fixture => {
    const patch = await fixture.patch({ "src/value.ts": source() });
    const result = await fixture.run(patch);
    assert.equal(result.status, "resolved", `${result.code ?? ""}: ${result.reason}`);
    assert.deepEqual(result.changedPaths, ["src/value.ts"]);
    assert.deepEqual(result.checks.filter(check => check.tests).map(check => [check.phase, check.exitCode]), [
      ["before-reproduce", 1], ["before-regression", 0], ["after-reproduce", 0], ["after-regression", 0],
    ]);
    assert.ok(result.checks.find(check => check.phase === "before-reproduce")?.tests?.[0].assertionFailure);
    assert.ok(afterChecks(result).every(check => check.snapshot === result.integrity.candidate && check.tests?.every(item => item.status === "passed")));
    assert.equal(result.integrity.stable, true);
    assert.equal(result.integrity.replayVerified, true);
    assert.notEqual(result.integrity.baseline, result.integrity.candidate);
    assert.equal(result.integrity.candidate, result.integrity.final);
    assert.ok(result.artifacts.patch && result.artifacts.inputPatch && result.artifacts.worktree && result.artifacts.replayWorktree);
    assert.equal(result.candidateHash, hash(await readFile(patch)));
    assert.equal(result.patchHash, hash(await readFile(result.artifacts.patch)));
    assert.deepEqual(await readFile(result.artifacts.inputPatch), await readFile(patch));
    const runDir = dirname(result.reportPath);
    const candidate = JSON.parse(await readFile(join(runDir, "logs/snapshot-candidate.json"), "utf8"));
    const replay = JSON.parse(await readFile(join(runDir, "logs/snapshot-replay.json"), "utf8"));
    assert.deepEqual(replay.files["src/value.ts"], candidate.files["src/value.ts"]);
    assert.equal(await readFile(join(result.artifacts.replayWorktree, "src/value.ts"), "utf8"), source());
    const saved = JSON.parse(await readFile(result.reportPath, "utf8"));
    assert.equal(saved.status, result.status);
    assert.equal(saved.patchHash, result.patchHash);
    assert.deepEqual(saved.integrity, result.integrity);
    assert.equal(await fixture.git(["rev-parse", "HEAD"]), fixture.task.baseCommit);
    assert.equal(await fixture.git(["status", "--porcelain=v1"]), "");
    assert.equal(await readFile(join(fixture.repo, "src/value.ts"), "utf8"), fixture.files["src/value.ts"]);
  });
});

test("a legal patch that leaves the target failing is unresolved", async () => {
  await withFixture(async fixture => {
    const result = await fixture.run(await fixture.patch({ "src/value.ts": source(2) }));
    assert.equal(result.status, "unresolved", result.reason);
    assert.equal(afterChecks(result)[0]?.exitCode, 1);
    assert.ok(afterChecks(result)[0]?.tests?.some(item => item.status === "failed"));
  });
});

test("test and package changes are rejected before candidate tests execute", async () => {
  for (const path of ["test/reproduce.test.ts", "package.json"]) {
    await withFixture(async fixture => {
      const result = await fixture.run(await fixture.patch({ "src/value.ts": source(), [path]: fixture.files[path] + "\n" }));
      assert.equal(result.status, "unresolved", result.reason);
      assert.equal(result.code, "PATCH_SCOPE_INVALID");
      assert.ok(result.changedPaths.includes(path));
      assert.equal(afterChecks(result).length, 0);
      assert.equal(result.artifacts.patch, null);
    });
  }
});

test("a correct fix carrying a Git-ignored new file is rejected", async () => {
  await withFixture(async fixture => {
    const result = await fixture.run(await fixture.patch({ "src/value.ts": source(), "ignored.txt": "Unapproved ignored file.\n" }));
    assert.equal(result.status, "unresolved", result.reason);
    assert.equal(result.code, "PATCH_SCOPE_INVALID");
    assert.ok(result.changedPaths.includes("ignored.txt"));
    assert.equal(afterChecks(result).length, 0);
    assert.equal(result.artifacts.patch, null);
  });
});

test("empty and non-applicable patches cannot claim a repair", async () => {
  for (const mode of ["empty", "invalid"] as const) {
    await withFixture(async fixture => {
      const path = join(fixture.directory, "bad.diff");
      await writeFile(path, mode === "empty" ? "" : filePatch("src/value.ts", source(99), source()));
      const result = await fixture.run(path);
      assert.equal(result.status, "unresolved", result.reason);
      assert.equal(result.code, mode === "empty" ? "PATCH_EMPTY" : "PATCH_INVALID");
      assert.equal(afterChecks(result).length, 0);
      assert.equal(result.artifacts.patch, null);
    });
  }
});

test("candidate syntax and import failures are unresolved rather than infrastructure success", async () => {
  for (const candidate of ["export const value = ;\nexport const mode = 'normal';\n", "import './missing.mjs';\n" + source()]) {
    await withFixture(async fixture => {
      const result = await fixture.run(await fixture.patch({ "src/value.ts": candidate }));
      assert.equal(result.status, "unresolved", `${result.code ?? ""}: ${result.reason}`);
      assert.ok(afterChecks(result).some(check => check.tests?.some(item => item.status === "failed" && !item.assertionFailure)));
    });
  }
});

test("source switches cannot hide the target, run zero cases or drop regression cases", async () => {
  for (const mode of ["skip", "zero", "missing", "drop-regression"]) {
    await withFixture(async fixture => {
      const result = await fixture.run(await fixture.patch({ "src/value.ts": source(0, mode) }));
      assert.equal(result.status, "unresolved", `${mode}: ${result.code ?? ""}: ${result.reason}`);
      assert.equal(afterChecks(result).length, 2);
      if (mode === "zero") assert.deepEqual(afterChecks(result)[0]?.tests, []);
      if (mode === "skip") assert.equal(afterChecks(result)[0]?.tests?.[0].status, "skipped");
    });
  }
});

test("an already passing baseline never reads or applies a candidate patch", async () => {
  await withFixture(async fixture => {
    const result = await fixture.run(join(fixture.directory, "does-not-exist.diff"));
    assert.equal(result.status, "not_reproduced", result.reason);
    assert.equal(result.artifacts.inputPatch, null);
    assert.equal(result.artifacts.patch, null);
    assert.equal(afterChecks(result).length, 0);
    assert.ok(result.checks.every(check => check.phase !== "patch-apply"));
  }, 0);
});

test("a candidate that changes its own source during testing loses its patch artifact", async () => {
  await withFixture(async fixture => {
    const mutation = "import {appendFileSync} from 'node:fs';\nappendFileSync(new URL('./value.ts',import.meta.url),'// changed during test\\n');\n";
    const result = await fixture.run(await fixture.patch({ "src/value.ts": mutation + source() }));
    assert.equal(result.status, "unresolved", result.reason);
    assert.equal(result.code, "SNAPSHOT_CHANGED");
    assert.equal(result.integrity.stable, false);
    assert.equal(result.artifacts.patch, null);
    assert.equal((await stat(join(dirname(result.reportPath), "patch.diff")).catch(() => undefined)), undefined);
  });
});

test("candidate changes to its private host task invalidate verification", async () => {
  await withFixture(async fixture => {
    const mutation = `import {appendFileSync} from 'node:fs';\nappendFileSync(${JSON.stringify(fixture.taskPath)},'\\n');\n`;
    const result = await fixture.run(await fixture.patch({ "src/value.ts": mutation + source() }));
    assert.equal(result.status, "error", result.reason);
    assert.equal(result.code, "HOST_CHANGED");
    assert.equal(result.artifacts.patch, null);
    assert.equal(result.integrity.stable, false);
  });
});

test("a multi-process baseline cannot hide a failing run behind its final passing process", async () => {
  await withFixture(async fixture => {
    const result = await fixture.run(await fixture.patch({ "src/value.ts": source() }));
    assert.equal(result.status, "error", result.reason);
    assert.equal(result.code, "EVIDENCE_INVALID");
    assert.equal(afterChecks(result).length, 0);
    assert.equal(result.artifacts.inputPatch, null);
    assert.equal(result.artifacts.patch, null);
  }, 1, true);
});
