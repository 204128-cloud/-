import assert from "node:assert/strict";
import test from "node:test";
import { applyRepairEdits, RepairEditError } from "../src/repair-edits.ts";

const path = "src/value.ts";
const secondPath = "src/other.ts";

test("exact edits return only changed sources and leave the source map untouched", () => {
  const source = "export const value = 1;\n";
  const sources = new Map([[path, source], [secondPath, "export const other = 2;\n"], ["src/untouched.ts", "export {};\n"]]);
  const changed = applyRepairEdits({ edits: [
    { path, before: "value = 1", after: "value = 0" },
    { path: secondPath, before: " = 2", after: "" },
  ] }, sources);

  assert.deepEqual([...changed], [[path, "export const value = 0;\n"], [secondPath, "export const other;\n"]]);
  assert.equal(sources.get(path), source);
  assert.equal(sources.get(secondPath), "export const other = 2;\n");
});

test("LF fragments match a CRLF file while preserving its original line ending style", () => {
  const sources = new Map([[path, "first\r\nold\r\nlast\r\n"]]);
  const changed = applyRepairEdits({ edits: [{ path, before: "old\nlast", after: "new\r\nlast" }] }, sources);
  assert.equal(changed.get(path), "first\r\nnew\r\nlast\r\n");
});

test("malformed, ambiguous, or out-of-scope edits are rejected without exposing their text", () => {
  const sources = new Map([[path, "aaaa\nsecret-marker\n"], [secondPath, "export {};\n"]]);
  const valid = { path, before: "secret-marker", after: "replacement" };
  const invalid = [
    { edits: [] },
    { edits: [valid], shell: "secret-marker" },
    { edits: [{ ...valid, extra: "secret-marker" }] },
    { edits: [{ ...valid, path: "src/Value.ts" }] },
    { edits: [{ ...valid, path: "../src/value.ts" }] },
    { edits: [valid, { ...valid, before: "aaaa" }] },
    { edits: [{ ...valid, before: "aaa" }] },
    { edits: [{ ...valid, before: "missing fragment" }] },
    { edits: [{ ...valid, before: "" }] },
    { edits: [{ ...valid, after: valid.before }] },
    { edits: [{ ...valid, after: "invalid\0fragment" }] },
    { edits: [{ ...valid, after: "invalid\ud800fragment" }] },
    { edits: [{ ...valid, after: "多".repeat(6000) }] },
  ];
  for (const input of invalid) {
    assert.throws(() => applyRepairEdits(input, sources), error =>
      error instanceof RepairEditError && !error.message.includes("secret-marker"));
  }
  assert.equal(sources.get(path), "aaaa\nsecret-marker\n");
});

test("mixed line endings are rejected to avoid altering untouched lines", () => {
  const sources = new Map([[path, "first\r\nold\nlast\r\n"]]);
  assert.throws(() => applyRepairEdits({ edits: [{ path, before: "old", after: "new" }] }, sources), RepairEditError);
});

test("the aggregate changed source limit is applied across files", () => {
  const sources = new Map([[path, `old\n${"a".repeat(33_000)}`], [secondPath, `old\n${"b".repeat(33_000)}`]]);
  assert.throws(() => applyRepairEdits({ edits: [
    { path, before: "old", after: "new" },
    { path: secondPath, before: "old", after: "new" },
  ] }, sources), RepairEditError);
});
