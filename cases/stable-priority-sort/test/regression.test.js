import assert from "node:assert/strict";
import test from "node:test";
import { sortByPriority } from "../src/sort-by-priority.js";

test("sorts distinct priorities descending", () => {
  assert.deepEqual(sortByPriority([{ id: "a", priority: 1 }, { id: "b", priority: 3 }, { id: "c", priority: 2 }]).map(item => item.id), ["b", "c", "a"]);
});
test("does not reorder or mutate the input", () => {
  const items = [{ id: "low", priority: 1 }, { id: "high", priority: 2 }];
  const before = structuredClone(items);
  sortByPriority(items);
  assert.deepEqual(items, before);
});
test("preserves object identities", () => {
  const low = { id: "low", priority: 1 }, high = { id: "high", priority: 2 };
  const sorted = sortByPriority([low, high]);
  assert.equal(sorted[0], high); assert.equal(sorted[1], low);
});
test("handles empty input", () => assert.deepEqual(sortByPriority([]), []));
test("handles a singleton", () => {
  const item = { id: "only", priority: 1 };
  assert.deepEqual(sortByPriority([item]), [item]);
});
test("handles negative and zero priorities", () => {
  assert.deepEqual(sortByPriority([{ id: "a", priority: -3 }, { id: "b", priority: 0 }, { id: "c", priority: -1 }]).map(item => item.priority), [0, -1, -3]);
});
test("handles fractional priorities", () => {
  assert.deepEqual(sortByPriority([{ id: "a", priority: 0.1 }, { id: "b", priority: 0.9 }]).map(item => item.id), ["b", "a"]);
});
test("returns a new array and retains duplicate IDs", () => {
  const items = [{ id: "same", priority: 1 }, { id: "same", priority: 2 }];
  const sorted = sortByPriority(items);
  assert.notEqual(sorted, items); assert.equal(sorted.length, 2); assert.equal(sorted[0], items[1]);
});
