import assert from "node:assert/strict";
import test from "node:test";
import type { TestEvidence } from "../src/evidence.ts";
import { LocalizationError, selectContext } from "../src/localization.ts";

const evidence: { reproduce: TestEvidence[]; regression: TestEvidence[] } = {
  reproduce: [{ file: "test/reproduce.test.ts", fullName: "target behavior", status: "failed", assertionFailure: true }],
  regression: [{ file: "test/regression.test.ts", fullName: "existing behavior", status: "passed", assertionFailure: false }],
};

const hasCode = (code: string) => (error: unknown) => error instanceof LocalizationError && error.code === code;

test("localization sends complete relevant files and baseline evidence without unrelated source", () => {
  const source = "export const pagination = (items: unknown[]) => items.length;\n";
  const sources = new Map([
    ["src/clock.ts", "export const clock = 'UNRELATED_LOCALIZATION_SOURCE';\n"],
    ["src/pagination.ts", source],
  ]);
  const result = selectContext("pagination is incorrect", "pagination target", sources, evidence);
  assert.equal(result.strategy, "lexical");
  assert.deepEqual([...result.sources], [["src/pagination.ts", source]]);
  const sent = JSON.parse(result.prompt);
  assert.equal(sent.issue, "pagination is incorrect");
  assert.equal(sent.expectedFailure, "pagination target");
  assert.deepEqual(sent.sources, [{ path: "src/pagination.ts", content: source }]);
  assert.deepEqual(sent.reproduce, evidence.reproduce);
  assert.deepEqual(sent.regression, evidence.regression);
  assert.equal(result.prompt.includes("UNRELATED_LOCALIZATION_SOURCE"), false);
  assert.equal(result.ranking.find(item => item.path === "src/clock.ts")?.selected, false);
  assert.equal(sources.get("src/pagination.ts"), source);
});

test("path evidence outranks repeated content mentions", () => {
  const result = selectContext("pagination", "pagination", new Map([
    ["src/other.ts", "// pagination\n".repeat(100)],
    ["src/pagination.ts", "export {};\n"],
  ]), evidence);
  assert.equal(result.ranking[0].path, "src/pagination.ts");
  assert.ok(result.ranking[0].score > result.ranking[1].score);
  assert.ok(result.ranking[0].pathMatches > 0);
  assert.equal(result.ranking[0].contentMatches, 0);
});

test("repeating a query or a matching source word does not inflate its relevance score", () => {
  const once = selectContext("pagination", "pagination", new Map([["src/other.ts", "// pagination\n"]]), evidence);
  const repeated = selectContext("pagination pagination pagination", "pagination pagination", new Map([
    ["src/other.ts", "// pagination\n".repeat(100)],
  ]), evidence);
  assert.equal(repeated.ranking[0].score, once.ranking[0].score);
  assert.equal(repeated.ranking[0].contentMatches, once.ranking[0].contentMatches);
});

test("camelCase issue identifiers find a matching component in source", () => {
  const result = selectContext("calculateInvoiceTotal", "required behavior", new Map([
    ["src/cart.ts", "export const total = 1;\n"],
    ["src/clock.ts", "export const clock = 1;\n"],
  ]), evidence);
  assert.deepEqual([...result.sources.keys()], ["src/cart.ts"]);
});

test("Chinese issue text can match Chinese source identifiers", () => {
  const result = selectContext("订单金额", "金额应正确", new Map([
    ["src/cart.ts", "export const 订单金额 = 0;\n"],
    ["src/clock.ts", "export const 时间 = 1;\n"],
  ]), evidence);
  assert.deepEqual([...result.sources.keys()], ["src/cart.ts"]);
});

test("a large unrelated file counts toward scanning but stays outside model context", () => {
  const relevant = "export const pagination = 0;\n";
  const unrelated = "UNRELATED_LARGE_LOCALIZATION_SOURCE\n" + "x".repeat(80 * 1024);
  const result = selectContext("pagination", "pagination", new Map([
    ["src/unrelated.ts", unrelated], ["src/pagination.ts", relevant],
  ]), evidence);
  assert.deepEqual([...result.sources], [["src/pagination.ts", relevant]]);
  assert.equal(result.scanBytes, Buffer.byteLength(relevant) + Buffer.byteLength(unrelated));
  assert.equal(result.contextBytes, Buffer.byteLength(result.prompt));
  assert.ok(result.contextBytes < 32 * 1024);
  assert.equal(result.prompt.includes("UNRELATED_LARGE_LOCALIZATION_SOURCE"), false);
});

test("context accounting uses serialized UTF-8 bytes rather than source character count", () => {
  const source = "export const pagination = '世界';\n";
  const result = selectContext("pagination 金额", "pagination", new Map([["src/pagination.ts", source]]), evidence);
  assert.equal(result.contextBytes, Buffer.byteLength(result.prompt, "utf8"));
  assert.ok(result.contextBytes > result.prompt.length);
  assert.equal(result.ranking[0].bytes, Buffer.byteLength(source, "utf8"));
});

test("JSON escaping can exceed context budget even when raw source fits", () => {
  const source = "export const pagination = '" + "\\".repeat(12 * 1024) + "世界".repeat(1800) + "';\n";
  assert.ok(Buffer.byteLength(source) < 32 * 1024);
  assert.ok(Buffer.byteLength(JSON.stringify({ content: source })) > 32 * 1024);
  assert.throws(() => selectContext("pagination", "pagination", new Map([["src/pagination.ts", source]]), evidence), hasCode("CONTEXT_TOO_LARGE"));
});

test("baseline evidence also consumes the context budget", () => {
  const oversizedEvidence = {
    ...evidence,
    reproduce: [{ ...evidence.reproduce[0], fullName: "e".repeat(33 * 1024) }],
  };
  assert.throws(() => selectContext("pagination", "pagination", new Map([
    ["src/pagination.ts", "export const pagination = 0;\n"],
  ]), oversizedEvidence), hasCode("CONTEXT_TOO_LARGE"));
});

test("an oversized highest ranked file is not replaced by a weaker small match", () => {
  assert.throws(() => selectContext("pagination", "pagination", new Map([
    ["src/pagination.ts", "export const pagination = '" + "x".repeat(33 * 1024) + "';\n"],
    ["src/other.ts", "// pagination\n"],
  ]), evidence), hasCode("CONTEXT_TOO_LARGE"));
});

test("local scan budget includes unrelated authorized files", () => {
  assert.throws(() => selectContext("pagination", "pagination", new Map([
    ["src/pagination.ts", "export const pagination = 0;\n"],
    ["src/unrelated.ts", "x".repeat(1024 * 1024)],
  ]), evidence), hasCode("SCAN_TOO_LARGE"));
});

test("no lexical match in a multi-file task requires a clearer location hint", () => {
  assert.throws(() => selectContext("zebraquux", "zebraquux", new Map([
    ["src/clock.ts", "export const clock = 1;\n"],
    ["src/cart.ts", "export const cart = 1;\n"],
  ]), evidence), hasCode("LOCATION_NO_MATCH"));
});

test("a single authorized file remains usable without a lexical match", () => {
  const source = "export const clock = 1;\n";
  const result = selectContext("zebraquux", "zebraquux", new Map([["src/clock.ts", source]]), evidence);
  assert.equal(result.strategy, "single_file");
  assert.deepEqual([...result.sources], [["src/clock.ts", source]]);
  assert.equal(result.ranking[0].score, 0);
  assert.equal(result.ranking[0].selected, true);
});

test("equal ranks have stable path order and select at most three positive matches", () => {
  const entries: Array<[string, string]> = ["d", "b", "a", "c"].map(name => [
    `src/${name}.ts`, "export const zebraquux = 1;\n",
  ]);
  const first = selectContext("zebraquux", "zebraquux", new Map(entries), evidence);
  const reversed = selectContext("zebraquux", "zebraquux", new Map([...entries].reverse()), evidence);
  assert.deepEqual(first.ranking.map(item => item.path), ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts"]);
  assert.deepEqual([...first.sources.keys()], ["src/a.ts", "src/b.ts", "src/c.ts"]);
  assert.deepEqual(first.ranking, reversed.ranking);
  assert.equal(first.prompt, reversed.prompt);
  assert.equal(first.ranking.find(item => item.path === "src/d.ts")?.selected, false);
});
