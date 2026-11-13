import assert from "node:assert/strict";
import test from "node:test";
import { paginate } from "../src/paginate.ts";

test("paginate returns the requested non-empty page", () => {
  assert.deepEqual(paginate([1, 2, 3, 4, 5], 2, 2), { items: [3, 4], totalPages: 3 });
});

test("paginate returns the last partial page", () => {
  assert.deepEqual(paginate([1, 2, 3, 4, 5], 3, 2), { items: [5], totalPages: 3 });
});

test("paginate returns an empty page beyond the end", () => {
  assert.deepEqual(paginate([1, 2, 3], 3, 2), { items: [], totalPages: 2 });
});

test("paginate accepts an exact page boundary without changing input", () => {
  const input = Object.freeze(["a", "b", "c", "d"]);
  assert.deepEqual(paginate(input, 1, 2), { items: ["a", "b"], totalPages: 2 });
  assert.deepEqual(input, ["a", "b", "c", "d"]);
});

test("paginate rejects invalid page numbers", () => {
  for (const page of [0, -1, 1.5, NaN, Infinity]) {
    assert.throws(() => paginate([1], page, 1), RangeError);
  }
});

test("paginate rejects invalid page sizes", () => {
  for (const pageSize of [0, -1, 1.5, NaN, Infinity]) {
    assert.throws(() => paginate([1], 1, pageSize), RangeError);
  }
});
