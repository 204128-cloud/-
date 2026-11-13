import assert from "node:assert/strict";
import test from "node:test";
import { truncateText } from "../src/truncate-text.js";

test("truncateText counts Unicode code points without splitting surrogate pairs", () => {
  assert.equal(truncateText("A😀BC", 3), "A😀…");
  assert.equal(truncateText("😀A", 2), "😀A");
  assert.equal(truncateText("😀AB", 2, ""), "😀A");
});
