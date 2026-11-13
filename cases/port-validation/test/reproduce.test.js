import assert from "node:assert/strict";
import test from "node:test";
import { parsePort } from "../src/parse-port.js";

test("parsePort rejects non-decimal content instead of accepting a numeric prefix", () => {
  for (const value of ["3000ms", "80.5", "1e3", "0x50", "+80"]) {
    assert.throws(() => parsePort(value), RangeError, `Must reject ${value}`);
  }
});
