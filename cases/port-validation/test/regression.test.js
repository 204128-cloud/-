import assert from "node:assert/strict";
import test from "node:test";
import { parsePort } from "../src/parse-port.js";

test("accepts an integer number", () => assert.equal(parsePort(3000), 3000));
test("accepts a complete decimal string", () => assert.equal(parsePort("8080"), 8080));
test("accepts surrounding whitespace", () => assert.equal(parsePort(" 443 \t"), 443));
test("accepts leading decimal zeros", () => assert.equal(parsePort("00080"), 80));
test("accepts both inclusive boundaries", () => {
  for (const port of [1, 65535]) {
    assert.equal(parsePort(port), port);
    assert.equal(parsePort(String(port)), port);
  }
});
test("rejects out-of-range and noninteger numbers", () => {
  for (const value of [-1, 0, 65536, 3.5, NaN, Infinity]) assert.throws(() => parsePort(value), RangeError);
});
test("rejects empty and whitespace-only strings", () => {
  for (const value of ["", "   "]) assert.throws(() => parsePort(value), RangeError);
});
test("rejects unsupported input types", () => {
  for (const value of [undefined, null, {}, [], true]) assert.throws(() => parsePort(value), TypeError);
});
