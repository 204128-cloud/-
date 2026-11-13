import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { evaluateBaseline, evaluateVerification, readEvidence, type TestEvidence } from "../src/evidence.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const reporter = new URL("../src/test-reporter.ts", import.meta.url).href;
const sample = (status: TestEvidence["status"], fullName = "target"): TestEvidence => ({
  file: "test/sample.test.mjs", fullName, status, assertionFailure: status === "failed",
});

async function withFixture(verify: (directory: string) => Promise<void>) {
  const parent = resolve(root, ".repopilot");
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(join(parent, "evidence-test-"));
  try { await verify(directory); }
  finally {
    assert.equal(dirname(resolve(directory)), parent);
    await rm(directory, { recursive: true, force: true });
  }
}

function fixtureEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "SystemRoot", "WINDIR", "TEMP", "TMP"]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return env;
}

async function executeFixture(directory: string, source: string) {
  const file = join(directory, "sample.test.mjs");
  const log = join(directory, "events.jsonl");
  await writeFile(file, source, "utf8");
  const env = fixtureEnvironment();
  env.REPOPILOT_EVIDENCE_PATH = log;
  const execution = promisify(execFile)(process.execPath, ["--test", `--test-reporter=${reporter}`, `--test-reporter-destination=${log}`, file], {
    cwd: directory, env, timeout: 20_000, windowsHide: true,
  });
  execution.child.stdin?.end();
  await execution.catch(error => { if (error.code !== 1) throw error; });
  return { file, log };
}

test("real reporter captures nested names, assertion causes and skips without raw output", async () => {
  await withFixture(async directory => {
    const marker = "PRIVATE_FAKE_ERROR_CONTENT";
    const { log } = await executeFixture(directory, `import {describe,it} from 'node:test'; import assert from 'node:assert/strict';
      describe('outer',()=>{it('passes',()=>{}); describe('inner',()=>it('target',()=>assert.equal(1,2,'${marker}'))); it.skip('skipped',()=>{});});
      console.log('${marker}');`);
    const evidence = await readEvidence(log, directory);
    assert.deepEqual(evidence.map(test => [test.fullName, test.status, test.assertionFailure]), [
      ["outer > passes", "passed", false], ["outer > inner > target", "failed", true], ["outer > skipped", "skipped", false],
    ]);
    assert.ok(evidence.every(test => test.file === "sample.test.mjs"));
    assert.ok(!(await readFile(log, "utf8")).includes(marker));
  });
});

test("npm scripts accept host-controlled reporter options without test-context inheritance", async () => {
  await withFixture(async directory => {
    const file = join(directory, "sample.test.mjs");
    const log = join(directory, "npm-events.jsonl");
    await writeFile(file, "import test from 'node:test'; test('npm target',()=>{});");
    await writeFile(join(directory, "package.json"), JSON.stringify({ private: true, scripts: { "test:probe": "node --test sample.test.mjs" } }));
    const env = fixtureEnvironment();
    env.REPOPILOT_EVIDENCE_PATH = log;
    env.NODE_OPTIONS = `--test-reporter=${reporter} --test-reporter-destination="${log.replaceAll("\\", "/")}"`;
    const npmCli = join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
    const execution = promisify(execFile)(process.execPath, [npmCli, "run", "--ignore-scripts", "test:probe"], {
      cwd: directory, env, timeout: 20_000, windowsHide: true,
    });
    execution.child.stdin?.end();
    await execution;
    assert.deepEqual(await readEvidence(log, directory), [{ file: "sample.test.mjs", fullName: "npm target", status: "passed", assertionFailure: false }]);
  });
});

test("npm relative-path empty files still report zero actual cases", async () => {
  await withFixture(async directory => {
    const log = join(directory, "npm-empty.jsonl");
    await writeFile(join(directory, "empty.test.mjs"), "");
    await writeFile(join(directory, "package.json"), JSON.stringify({ private: true, scripts: { "test:empty": "node --test empty.test.mjs" } }));
    const env = fixtureEnvironment();
    env.REPOPILOT_EVIDENCE_PATH = log;
    env.NODE_OPTIONS = `--test-reporter=${reporter} --test-reporter-destination="${log.replaceAll("\\", "/")}"`;
    const npmCli = join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
    const execution = promisify(execFile)(process.execPath, [npmCli, "run", "--ignore-scripts", "test:empty"], {
      cwd: directory, env, timeout: 20_000, windowsHide: true,
    });
    execution.child.stdin?.end();
    await execution;
    assert.deepEqual(await readEvidence(log, directory, true), []);
    await assert.rejects(readEvidence(log, directory));
  });
});

test("one npm test process can report multiple files through one exclusive writer", async () => {
  await withFixture(async directory => {
    const log = join(directory, "multi-file.jsonl");
    await writeFile(join(directory, "first.test.mjs"), "import test from 'node:test'; test('first pass',()=>{});");
    await writeFile(join(directory, "second.test.mjs"), "import test from 'node:test'; test('second pass',()=>{});");
    await writeFile(join(directory, "package.json"), JSON.stringify({ private: true, scripts: {
      "test:files": "node --test first.test.mjs second.test.mjs",
    } }));
    const env = fixtureEnvironment();
    env.REPOPILOT_EVIDENCE_PATH = log;
    env.NODE_OPTIONS = `--test-reporter=${reporter} --test-reporter-destination="${log.replaceAll("\\", "/")}"`;
    const npmCli = join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
    const execution = promisify(execFile)(process.execPath, [npmCli, "run", "--ignore-scripts", "test:files"], {
      cwd: directory, env, timeout: 20_000, windowsHide: true,
    });
    execution.child.stdin?.end();
    await execution;
    const evidence = await readEvidence(log, directory);
    assert.deepEqual(evidence.map(item => item.file).sort(), ["first.test.mjs", "second.test.mjs"]);
    assert.ok(evidence.every(item => item.status === "passed"));
    assert.equal((await stat(`${log}.multiple`).catch(() => undefined)), undefined);
  });
});

test("multiple node:test writers cannot overwrite a failed run with passing evidence", async () => {
  await withFixture(async directory => {
    const log = join(directory, "multiple.jsonl");
    const second = join(directory, "second.test.mjs");
    await writeFile(join(directory, "first.test.mjs"), "import test from 'node:test'; import assert from 'node:assert/strict'; test('first failure',()=>assert.fail());");
    await writeFile(second, "import test from 'node:test'; test('second pass',()=>{});");
    const separator = process.platform === "win32" ? "&" : ";";
    await writeFile(join(directory, "package.json"), JSON.stringify({ private: true, scripts: {
      "test:multiple": `node --test first.test.mjs ${separator} node --test second.test.mjs`,
    } }));
    const env = fixtureEnvironment();
    env.REPOPILOT_EVIDENCE_PATH = log;
    env.NODE_OPTIONS = `--test-reporter=${reporter} --test-reporter-destination="${log.replaceAll("\\", "/")}"`;
    const npmCli = join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
    const execution = promisify(execFile)(process.execPath, [npmCli, "run", "--ignore-scripts", "test:multiple"], {
      cwd: directory, env, timeout: 20_000, windowsHide: true,
    });
    execution.child.stdin?.end();
    await execution;
    assert.ok((await readFile(log, "utf8")).includes("second pass"));
    assert.ok((await stat(`${log}.writer`)).isFile());
    assert.ok((await stat(`${log}.multiple`)).isFile());
    await assert.rejects(readEvidence(log, directory));
    await writeFile(log, JSON.stringify({ kind: "test", file: second, fullName: "second pass", status: "passed", assertionFailure: false })
      + "\n" + JSON.stringify({ kind: "complete", count: 1 }));
    await assert.rejects(readEvidence(log, directory));
  });
});

test("otherwise valid evidence without its exclusive writer marker is rejected", async () => {
  await withFixture(async directory => {
    const { log } = await executeFixture(directory, "import test from 'node:test'; test('present',()=>{});");
    assert.equal((await readEvidence(log, directory)).length, 1);
    await rm(`${log}.writer`);
    await assert.rejects(readEvidence(log, directory));
  });
});

test("empty files, truncated evidence and external files cannot provide valid cases", async () => {
  await withFixture(async directory => {
    const { file, log } = await executeFixture(directory, "");
    await assert.rejects(readEvidence(log, directory));
    assert.deepEqual(await readEvidence(log, directory, true), []);
    const row = { kind: "test", file, fullName: "target", status: "passed", assertionFailure: false };
    await writeFile(log, JSON.stringify(row) + "\n");
    await assert.rejects(readEvidence(log, directory));
    await assert.rejects(readEvidence(log, directory, true));
    await writeFile(log, "");
    await assert.rejects(readEvidence(log, directory, true));
    await writeFile(log, JSON.stringify({ ...row, file: fileURLToPath(import.meta.url) }) + "\n" + JSON.stringify({ kind: "complete", count: 1 }));
    await assert.rejects(readEvidence(log, directory));
  });
});

test("verification accepts retained passing cases and additional passing identities", () => {
  const beforeReproduce = [sample("failed"), sample("passed", "companion")];
  const beforeRegression = [sample("passed", "existing"), sample("passed", "duplicate"), sample("passed", "duplicate")];
  const result = evaluateVerification(beforeReproduce, beforeRegression,
    [sample("passed"), sample("passed", "companion"), sample("passed", "new reproduction case")],
    [...beforeRegression, sample("passed", "new regression case")], "target", 0, 0);
  assert.equal(result.status, "resolved");
});

test("verification rejects missing, renamed, duplicated, skipped and failing candidate cases", () => {
  const beforeReproduce = [sample("failed"), sample("passed", "companion")];
  const beforeRegression = [sample("passed", "existing"), sample("passed", "another")];
  const afterReproduce = [sample("passed"), sample("passed", "companion")];
  const afterRegression = [...beforeRegression];
  const cases: Array<{ label: string; reproduce?: TestEvidence[]; regression?: TestEvidence[]; reproduceExit?: number; regressionExit?: number }> = [
    { label: "zero reproduction", reproduce: [] },
    { label: "zero regression", regression: [] },
    { label: "missing target", reproduce: [sample("passed", "companion")] },
    { label: "duplicate target", reproduce: [...afterReproduce, sample("passed")] },
    { label: "target moved to another file", reproduce: [{ ...sample("passed"), file: "test/other.test.mjs" }, sample("passed", "companion")] },
    { label: "missing reproduction companion", reproduce: [sample("passed")] },
    { label: "missing regression", regression: [sample("passed", "existing")] },
    { label: "renamed regression", regression: [sample("passed", "existing"), sample("passed", "renamed")] },
    { label: "skipped target", reproduce: [sample("skipped"), sample("passed", "companion")] },
    { label: "skipped regression", regression: [sample("skipped", "existing"), sample("passed", "another")] },
    { label: "failed target", reproduce: [sample("failed"), sample("passed", "companion")], reproduceExit: 1 },
    { label: "import failure", reproduce: [{ ...sample("failed"), assertionFailure: false }], reproduceExit: 1 },
    { label: "compile failure", regression: [{ ...sample("failed", "file load"), assertionFailure: false }], regressionExit: 1 },
    { label: "extra failed case", regression: [...afterRegression, sample("failed", "new failure")], regressionExit: 1 },
  ];
  for (const item of cases) {
    const result = evaluateVerification(beforeReproduce, beforeRegression, item.reproduce ?? afterReproduce,
      item.regression ?? afterRegression, "target", item.reproduceExit ?? 0, item.regressionExit ?? 0);
    assert.equal(result.status, "unresolved", item.label);
  }
});

test("verification preserves the count of each original identity", () => {
  const reproduce = [sample("passed")];
  const beforeRegression = [sample("passed", "duplicate"), sample("passed", "duplicate")];
  for (const count of [1, 3]) {
    const result = evaluateVerification([sample("failed")], beforeRegression, reproduce,
      Array.from({ length: count }, () => sample("passed", "duplicate")), "target", 0, 0);
    assert.equal(result.status, "unresolved");
  }
});

test("verification separates unreliable exit evidence from candidate failures", () => {
  const beforeReproduce = [sample("failed")];
  const beforeRegression = [sample("passed", "existing")];
  for (const [afterReproduce, reproduceExit, regressionExit] of [
    [[sample("passed")], null, 0], [[sample("passed")], 0, null],
    [[sample("failed")], 0, 0], [[sample("passed")], 1, 0],
    [[], 1, 0], [[sample("passed")], -1, 0],
  ] as Array<[TestEvidence[], number | null, number | null]>) {
    assert.equal(evaluateVerification(beforeReproduce, beforeRegression, afterReproduce, beforeRegression,
      "target", reproduceExit, regressionExit).status, "error");
  }
});

test("verification refuses an ambiguous or invalid baseline target", () => {
  const regression = [sample("passed", "existing")];
  for (const reproduce of [[], [sample("passed")], [sample("failed"), sample("failed")]]) {
    assert.equal(evaluateVerification(reproduce, regression, [sample("passed")], regression, "target", 0, 0).status, "error");
  }
});

test("import failures and suite hook failures are not assertion reproductions", async () => {
  for (const source of [
    "import './missing-module.mjs';",
    "import {describe,it,before} from 'node:test'; describe('broken',()=>{before(()=>{throw Error('fake hook failure')});it('target',()=>{});});",
  ]) {
    await withFixture(async directory => {
      const { log } = await executeFixture(directory, source);
      const evidence = await readEvidence(log, directory);
      assert.ok(evidence.some(test => test.status === "failed" && !test.assertionFailure));
      assert.equal(evaluateBaseline(evidence, [sample("passed", "regression")], "target", 1, 0).baselineStatus, "error");
    });
  }
});

test("baseline evaluation separates ready and not reproduced", () => {
  assert.equal(evaluateBaseline([sample("failed")], [sample("passed", "regression")], "target", 1, 0).baselineStatus, "ready");
  assert.equal(evaluateBaseline([sample("passed")], [sample("passed", "regression")], "target", 0, 0).baselineStatus, "not_reproduced");
});

test("baseline evaluation refuses missing, duplicate, skipped, empty and inconsistent evidence", () => {
  for (const [reproduce, regression, reproduceExit, regressionExit] of [
    [[], [sample("passed")], 0, 0], [[sample("failed")], [], 1, 0],
    [[sample("failed", "other")], [sample("passed")], 1, 0],
    [[sample("failed"), sample("failed")], [sample("passed")], 1, 0],
    [[sample("skipped")], [sample("passed")], 0, 0],
    [[sample("failed")], [sample("skipped")], 1, 0],
    [[sample("failed")], [sample("failed")], 1, 1],
    [[sample("failed")], [sample("passed")], 0, 0],
    [[sample("passed")], [sample("passed")], 1, 0],
    [[sample("failed")], [sample("passed")], null, 0],
  ] as Array<[TestEvidence[], TestEvidence[], number | null, number | null]>) {
    assert.equal(evaluateBaseline(reproduce, regression, "target", reproduceExit, regressionExit).baselineStatus, "error");
  }
});
