import assert from "node:assert/strict";
import test from "node:test";
import { sortByPriority } from "../src/sort-by-priority.js";

test("equal-priority items retain their original input order", () => {
  const items = [
    { id: "z-high", priority: 2 }, { id: "m-low", priority: 1 },
    { id: "a-high", priority: 2 }, { id: "b-low", priority: 1 },
  ];
  assert.deepEqual(sortByPriority(items).map(item => item.id), ["z-high", "a-high", "m-low", "b-low"]);
});
