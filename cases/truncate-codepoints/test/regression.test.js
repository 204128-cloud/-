import assert from "node:assert/strict";
import test from "node:test";
import { truncateText } from "../src/truncate-text.js";

test("keeps fitting ASCII text unchanged", () => assert.equal(truncateText("abc", 3), "abc"));
test("counts the default suffix in the output limit", () => assert.equal(truncateText("abcdef", 5), "abcd…"));
test("supports a custom suffix", () => assert.equal(truncateText("abcdef", 5, "..."), "ab..."));
test("supports an empty suffix", () => assert.equal(truncateText("abcdef", 3, ""), "abc"));
test("returns empty text at a zero limit", () => {
  assert.equal(truncateText("abc", 0), ""); assert.equal(truncateText("", 0), "");
});
test("clips an oversized suffix by code points", () => {
  assert.equal(truncateText("abcdef", 2, "..."), "..");
  assert.equal(truncateText("abcdef", 3, "😀!"), "a😀!");
});
test("counts combining marks as separate code points", () => assert.equal(truncateText("e\u0301x", 2, ""), "e\u0301"));
test("rejects invalid argument types and limits", () => {
  for (const length of [-1, 1.5, NaN, Infinity, "3"]) assert.throws(() => truncateText("abc", length), RangeError);
  assert.throws(() => truncateText(null, 3), TypeError);
  assert.throws(() => truncateText("abc", 3, null), TypeError);
});
