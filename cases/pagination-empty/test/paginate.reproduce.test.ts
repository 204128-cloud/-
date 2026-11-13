import assert from "node:assert/strict";
import test from "node:test";
import { paginate } from "../src/paginate.ts";

test("paginate returns zero pages for empty input", () => {
  assert.deepEqual(paginate([], 1, 10), { items: [], totalPages: 0 });
});
