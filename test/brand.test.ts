import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { BrandHeaderComponent } from "../src/brand.ts";

const logo = {
  width: 2,
  height: 2,
  pixels: [[255, 0, 0, 0, 255, 0], [0, 0, 255, 255, 255, 255]],
};

test("centers the logo, welcome and self-introduction with task metadata", () => {
  const lines = new BrandHeaderComponent(logo, { model: "Qwen", taskId: "TEST-1" }).render(80, 24);
  assert.ok(lines.some(line => line.includes("\x1b[38;2;255;0;0m\x1b[48;2;0;0;255m▀")));
  assert.ok(lines.some(line => line.includes("欢迎使用 RepoPilot")));
  assert.ok(lines.some(line => line.includes("我是你的 AI 编程助手")));
  assert.ok(lines.some(line => line.includes("Qwen")));
  assert.ok(lines.some(line => line.includes("TEST-1")));
  assert.ok(lines.every(line => !line.includes("Enter 开始")));
  assert.equal(lines.length, 24);
  const content = lines.map(stripTerminalSequences);
  const first = content.findIndex(line => line.trim());
  const last = content.findLastIndex(line => line.trim());
  assert.ok(Math.abs(first - (lines.length - last - 1)) <= 1);
  for (const line of content.filter(line => line.trim())) {
    const left = line.length - line.trimStart().length;
    assert.ok(Math.abs(left - (80 - left - visibleWidth(line.trim()))) <= 1);
  }
});

test("uses the full 32-column logo when space permits and scales down for smaller viewports", async () => {
  const pixels = JSON.parse(await readFile(new URL("../assets/logo-terminal.json", import.meta.url), "utf8"));
  const component = new BrandHeaderComponent(pixels, { model: "Qwen" });
  const large = component.render(100, 40).filter(line => line.includes("▀"));
  assert.equal(large.length, 16);
  assert.ok(large.every(line => [...stripTerminalSequences(line).trim()].length === 32));
  const smaller = component.render(80, 19).filter(line => line.includes("▀"));
  assert.equal(smaller.length, 12);
  assert.ok(smaller.every(line => [...stripTerminalSequences(line).trim()].length === 24));
});

test("keeps the welcome within narrow or short viewport bounds", () => {
  const component = new BrandHeaderComponent(logo, { model: "Qwen" });
  assert.ok(component.render(20, 12).some(line => line.includes("RepoPilot")));
  for (const width of [0, 1, 4, 8, 9, 20, 31, 32, 80]) {
    for (const height of [0, 1, 3, 6, 12, 19, 40]) {
      const lines = component.render(width, height);
      assert.ok(lines.length <= height);
      for (const line of lines) assert.ok(visibleWidth(line) <= width);
    }
  }
  component.invalidate();
  assert.deepEqual(component.render(40, 12), new BrandHeaderComponent(logo, { model: "Qwen" }).render(40, 12));
});

test("rejects malformed pixel assets before they can inject terminal control sequences", () => {
  for (const malformed of [
    { ...logo, width: 33 },
    { ...logo, height: 3 },
    { ...logo, pixels: [[255, 0, 0]] },
    { ...logo, pixels: [[255, 0, 0, 0, 255, 0], [0, 0, 256, 255, 255, 255]] },
    { ...logo, pixels: [["\x1b[2J", 0, 0, 0, 255, 0], [0, 0, 255, 255, 255, 255]] },
  ]) assert.throws(() => new BrandHeaderComponent(malformed as typeof logo, { model: "Qwen" }), /Invalid brand logo/);
});
