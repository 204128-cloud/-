import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { TestEvidence } from "../src/evidence.ts";
import { findGitExecutable } from "../src/git.ts";
import { locateTask } from "../src/localization.ts";
import { executionEnvironment, runProcess } from "../src/process.ts";
import { proposeRepair } from "../src/proposal.ts";
import type { Task } from "../src/task.ts";
import { verifyPatch } from "../src/verifier.ts";

const project = fileURLToPath(new URL("..", import.meta.url));
const parent = resolve(project, ".repopilot/proposal-tests");
const runsRoot = resolve(project, ".repopilot/runs");
const original = "export const value = 1;\n";
const repaired = "export const value = 0;\n";
const regressionMarker = "FIXTURE_PROTECTED_REGRESSION_SOURCE";
const targetMarker = "FIXTURE_PROTECTED_REPRODUCTION_SOURCE";
const unrelatedMarker = "FIXTURE_UNRELATED_SOURCE";
const validEdit = { path: "src/value.ts", before: original, after: repaired };

type Proposal = Awaited<ReturnType<typeof proposeRepair>>;
type Verification = Awaited<ReturnType<typeof verifyPatch>>;
type Location = Awaited<ReturnType<typeof locateTask>>;
type Fixture = {
  repo: string;
  task: Task;
  git: (args: string[]) => Promise<string>;
  propose: (request: (prompt: string) => Promise<unknown>) => Promise<Proposal>;
  locate: () => Promise<Location>;
  verify: (patch: string) => Promise<Verification>;
};

async function withFixture(use: (fixture: Fixture) => Promise<void>, startsPassing = false, attributes = "",
  options: { allowedPaths?: string[]; unrelated?: string; issue?: string } = {}) {
  const env = executionEnvironment();
  const executable = await findGitExecutable(env);
  assert.ok(executable, "Private proposal fixtures require Git.");
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(join(parent, "case-"));
  const repo = join(directory, "repo");
  const reports: Array<Proposal | Verification | Location> = [];
  const git = async (args: string[]) => {
    const result = await runProcess(executable, args, { cwd: repo, env, timeoutMs: 15_000, captureOutput: true });
    assert.equal(result.exitCode, 0, "Private fixture Git command must succeed.");
    return result.stdout.trim();
  };
  try {
    await mkdir(join(repo, "src"), { recursive: true });
    await mkdir(join(repo, "test"));
    const name = "repopilot-proposal-fixture";
    const pkg = { name, version: "1.0.0" };
    const files = {
      ".gitignore": "node_modules/\n",
      "package.json": JSON.stringify({ ...pkg, type: "module", scripts: {
        "test:reproduce": "node --test test/reproduce.test.ts", "test:regression": "node --test test/regression.test.ts",
      } }),
      "package-lock.json": JSON.stringify({ ...pkg, lockfileVersion: 3, requires: true, packages: { "": pkg } }),
      "src/value.ts": startsPassing ? repaired : original,
      "src/unrelated.ts": options.unrelated ?? `export const unrelated = '${unrelatedMarker}';\n`,
      "test/reproduce.test.ts": "import test from 'node:test'; import assert from 'node:assert/strict'; import {value} from '../src/value.ts';\n"
        + `test('target assertion',()=>assert.equal(value,0,'${targetMarker}'));\n`,
      "test/regression.test.ts": "import test from 'node:test'; import assert from 'node:assert/strict'; import {value} from '../src/value.ts';\n"
        + `test('existing behavior',()=>assert.equal(typeof value,'number','${regressionMarker}'));\n`,
    };
    for (const [path, content] of Object.entries(files)) await writeFile(join(repo, path), content);
    if (attributes) await writeFile(join(repo, ".gitattributes"), attributes);
    await git(["init", "--initial-branch=main"]);
    await git(["config", "core.autocrlf", "false"]);
    await git(["add", "."]);
    await git(["-c", "user.name=RepoPilot Proposal Fixture", "-c", "user.email=fixture@localhost",
      "-c", `core.hooksPath=${join(directory, "no-hooks")}`, "commit", "--quiet", "-m", "Private proposal baseline"]);
    const task: Task = {
      id: "proposal-test", repoPath: repo, baseCommit: await git(["rev-parse", "HEAD"]), issue: options.issue ?? "Value must be zero.",
      reproduceScript: "test:reproduce", regressionScript: "test:regression", expectedFailure: "target assertion", allowedPaths: options.allowedPaths ?? ["src/value.ts"],
    };
    const taskPath = join(directory, "task.json");
    await writeFile(taskPath, JSON.stringify(task));
    await use({ repo, task, git,
      async propose(request) {
        const report = await proposeRepair(taskPath, request);
        reports.push(report);
        return report;
      },
      async locate() {
        const report = await locateTask(taskPath);
        reports.push(report);
        return report;
      },
      async verify(patch) {
        const report = await verifyPatch(taskPath, patch);
        reports.push(report);
        return report;
      },
    });
  } finally {
    for (const report of reports.reverse()) {
      const runDir = await realpath(dirname(report.reportPath));
      assert.equal(dirname(runDir), await realpath(runsRoot));
      const worktrees = [[report.artifacts.worktree, "worktree"]] as Array<[string | null, string]>;
      if (report.kind === "patch_verification") worktrees.push([report.artifacts.replayWorktree, "patch-replay"]);
      for (const [path, expectedName] of worktrees.reverse()) {
        if (!path) continue;
        assert.equal(resolve(path), join(runDir, expectedName));
        assert.equal(await realpath(path), join(runDir, expectedName));
        await git(["worktree", "remove", "--force", path]);
      }
      await rm(runDir, { recursive: true, force: true });
    }
    const absoluteDirectory = await realpath(directory);
    assert.equal(dirname(absoluteDirectory), await realpath(parent));
    await rm(absoluteDirectory, { recursive: true, force: true });
  }
}

function promptPayload(prompt: string) {
  const firstBrace = prompt.indexOf("{");
  const lastBrace = prompt.lastIndexOf("}");
  assert.ok(firstBrace >= 0 && lastBrace > firstBrace, "Model request includes its JSON payload.");
  return JSON.parse(prompt.slice(firstBrace, lastBrace + 1)) as {
    issue: string; expectedFailure: string; sources: Array<{ path: string; content: string }>;
    reproduce: TestEvidence[]; regression: TestEvidence[];
  };
}

test("localization omits a large authorized distractor and the resulting proposal independently resolves", async () => {
  await withFixture(async fixture => {
    let requests = 0;
    let sentPrompt = "";
    const proposal = await fixture.propose(async prompt => {
      requests++;
      sentPrompt = prompt;
      return { edits: [validEdit] };
    });
    assert.equal(proposal.status, "proposed", `${proposal.code ?? ""} ${proposal.reason}`);
    assert.equal(requests, 1);
    const sent = promptPayload(sentPrompt);
    assert.equal(sent.issue, fixture.task.issue);
    assert.equal(sent.expectedFailure, fixture.task.expectedFailure);
    assert.deepEqual(sent.sources, [{ path: "src/value.ts", content: original }]);
    assert.ok(proposal.artifacts.location);
    const locationText = await readFile(proposal.artifacts.location, "utf8");
    const location = JSON.parse(locationText) as Location;
    assert.equal(location.status, "located");
    assert.equal(location.strategy, "lexical");
    assert.deepEqual(location.selectedPaths, ["src/value.ts"]);
    assert.equal(location.contextBytes, Buffer.byteLength(sentPrompt));
    assert.ok(location.contextBytes <= 32 * 1024);
    assert.ok(location.scanBytes > 32 * 1024);
    assert.equal(location.ranking.find(item => item.path === "src/unrelated.ts")?.selected, false);
    for (const text of [original.trim(), fixture.task.issue, targetMarker, regressionMarker, unrelatedMarker]) {
      assert.equal(locationText.includes(text), false, "Localization records metadata, not source or query content.");
    }
    assert.equal(Object.hasOwn(location, "prompt"), false);
    assert.equal(Object.hasOwn(location, "sources"), false);
    assert.equal(Object.hasOwn(location, "issue"), false);
    assert.equal(location.ranking.some(item => Object.hasOwn(item, "matchedTerms")), false);
    assert.deepEqual(sent.reproduce.map(({ file, fullName, status }) => ({ file, fullName, status })), [
      { file: "test/reproduce.test.ts", fullName: "target assertion", status: "failed" },
    ]);
    assert.deepEqual(sent.regression.map(({ file, fullName, status }) => ({ file, fullName, status })), [
      { file: "test/regression.test.ts", fullName: "existing behavior", status: "passed" },
    ]);
    assert.ok([targetMarker, regressionMarker, unrelatedMarker, fixture.repo].every(marker => !sentPrompt.includes(marker)));
    assert.deepEqual(proposal.changedPaths, ["src/value.ts"]);
    assert.ok(proposal.artifacts.patch);
    assert.ok((await stat(proposal.artifacts.patch)).size > 0);
    const verification = await fixture.verify(proposal.artifacts.patch);
    assert.equal(verification.status, "resolved", `${verification.code ?? ""} ${verification.reason}`);
    assert.notEqual(verification.artifacts.worktree, proposal.artifacts.worktree);
    assert.equal(await fixture.git(["rev-parse", "HEAD"]), fixture.task.baseCommit);
    assert.equal(await fixture.git(["status", "--porcelain=v1"]), "");
    assert.equal(await readFile(join(fixture.repo, "src/value.ts"), "utf8"), original);
  }, false, "", {
    allowedPaths: ["src/value.ts", "src/unrelated.ts"],
    unrelated: `export const unrelated = '${unrelatedMarker}${"x".repeat(40 * 1024)}';\n`,
  });
});

test("offline localization selects relevant source without changing the task or repository", async () => {
  await withFixture(async fixture => {
    const location = await fixture.locate();
    assert.equal(location.kind, "source_localization");
    assert.equal(location.status, "located", `${location.code ?? ""} ${location.reason}`);
    assert.deepEqual(location.selectedPaths, ["src/value.ts"]);
    assert.equal(location.baseCommit, fixture.task.baseCommit);
    assert.ok(location.artifacts.worktree);
    assert.equal(await readFile(join(location.artifacts.worktree, "src/value.ts"), "utf8"), original);
    assert.deepEqual(fixture.task.allowedPaths, ["src/value.ts", "src/unrelated.ts"]);
    assert.equal(await fixture.git(["rev-parse", "HEAD"]), fixture.task.baseCommit);
    assert.equal(await fixture.git(["status", "--porcelain=v1"]), "");
  }, false, "", { allowedPaths: ["src/value.ts", "src/unrelated.ts"] });
});

test("an authorized but unselected source edit rejects the entire proposal before writing", async () => {
  await withFixture(async fixture => {
    const proposal = await fixture.propose(async prompt => {
      assert.deepEqual(promptPayload(prompt).sources, [{ path: "src/value.ts", content: original }]);
      return { edits: [validEdit, {
        path: "src/unrelated.ts", before: "export const unrelated", after: "export const changed",
      }] };
    });
    assert.equal(proposal.status, "error");
    assert.equal(proposal.code, "INVALID_REPAIR_EDITS");
    assert.equal(proposal.artifacts.patch, null);
    assert.deepEqual(proposal.changedPaths, []);
    assert.ok(proposal.artifacts.worktree);
    assert.equal(await readFile(join(proposal.artifacts.worktree, "src/value.ts"), "utf8"), original);
    assert.equal(await readFile(join(proposal.artifacts.worktree, "src/unrelated.ts"), "utf8"), `export const unrelated = '${unrelatedMarker}';\n`);
    assert.equal(await fixture.git(["status", "--porcelain=v1"]), "");
  }, false, "", { allowedPaths: ["src/value.ts", "src/unrelated.ts"] });
});

test("multiple authorized files with no query match do not trigger a model request", async () => {
  await withFixture(async fixture => {
    let requests = 0;
    const proposal = await fixture.propose(async () => {
      requests++;
      return { edits: [validEdit] };
    });
    assert.equal(proposal.status, "error");
    assert.equal(proposal.code, "LOCATION_NO_MATCH");
    assert.equal(requests, 0);
    assert.equal(proposal.artifacts.patch, null);
    assert.deepEqual(proposal.changedPaths, []);
  }, false, "", { allowedPaths: ["src/value.ts", "src/unrelated.ts"], issue: "Calendar timezone conversion." });
});

test("an out-of-scope proposal is rejected before applying any edit in its list", async () => {
  await withFixture(async fixture => {
    const proposal = await fixture.propose(async () => ({ edits: [validEdit,
      { path: "test/reproduce.test.ts", before: "target assertion", after: "different assertion" },
    ] }));
    assert.equal(proposal.status, "error");
    assert.equal(proposal.artifacts.patch, null);
    assert.deepEqual(proposal.changedPaths, []);
    assert.ok(proposal.artifacts.worktree);
    assert.equal(await readFile(join(proposal.artifacts.worktree, "src/value.ts"), "utf8"), original);
    assert.equal(await fixture.git(["status", "--porcelain=v1"]), "");
  });
});

test("an already passing target does not request a model proposal", async () => {
  await withFixture(async fixture => {
    let requests = 0;
    const proposal = await fixture.propose(async () => {
      requests++;
      return { edits: [validEdit] };
    });
    assert.equal(proposal.status, "not_reproduced", proposal.reason);
    assert.equal(requests, 0);
    assert.equal(proposal.artifacts.patch, null);
    assert.deepEqual(proposal.changedPaths, []);
  }, true);
});

test("a Git filter on an allowed file blocks candidate generation before the model runs", async () => {
  await withFixture(async fixture => {
    let requests = 0;
    const proposal = await fixture.propose(async () => {
      requests++;
      return { edits: [validEdit] };
    });
    assert.equal(proposal.status, "error");
    assert.equal(proposal.code, "SOURCE_FILTER_UNSUPPORTED");
    assert.equal(requests, 0);
    assert.equal(proposal.artifacts.patch, null);
  }, false, "src/value.ts filter=custom-clean\n");
});
