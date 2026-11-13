import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const fixture = fileURLToPath(new URL("./launcher.fixture.ps1", import.meta.url));
async function runLauncher(args: string[], typedKey = "", existingKey = "") {
  const execution = promisify(execFile)("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", fixture, ...args], { timeout: 15_000, windowsHide: true, env: { ...process.env, REPOPILOT_TEST_TYPED_KEY: typedKey, REPOPILOT_TEST_EXISTING_KEY: existingKey } });
  execution.child.stdin?.end();
  const { stdout } = await execution;
  return JSON.parse(stdout) as { execution: { command: string; promptCalls: number; clipboardCalls: number; keyLoaded: boolean; offline: boolean }; keyRestored: boolean; offlineRestored: boolean };
}

test("Windows launcher defaults to smoke and loads the clipboard key after confirmation", async () => {
  const result = await runLauncher([]);
  assert.equal(result.execution.command, "smoke");
  assert.equal(result.execution.promptCalls, 1);
  assert.equal(result.execution.clipboardCalls, 1);
  assert.equal(result.execution.keyLoaded, true);
  assert.equal(result.execution.offline, true);
  assert.equal(result.keyRestored, true);
  assert.equal(result.offlineRestored, true);
});

test("Windows help does not prompt for a credential", async () => {
  const result = await runLauncher(["--help"]);
  assert.equal(result.execution.command, "--help");
  assert.equal(result.execution.promptCalls, 0);
  assert.equal(result.execution.clipboardCalls, 0);
  assert.equal(result.execution.keyLoaded, false);
  assert.equal(result.keyRestored, true);
  assert.equal(result.offlineRestored, true);
});

test("task initialization neither prompts for a model credential nor reads the clipboard", async () => {
  const result = await runLauncher(["task", "init", "repository"]);
  assert.equal(result.execution.command, "task");
  assert.equal(result.execution.promptCalls, 0);
  assert.equal(result.execution.clipboardCalls, 0);
  assert.equal(result.execution.keyLoaded, false);
  assert.equal(result.keyRestored, true);
});

test("Windows authentication diagnostic loads the clipboard key after confirmation", async () => {
  const result = await runLauncher(["auth-check"]);
  assert.equal(result.execution.command, "auth-check");
  assert.equal(result.execution.promptCalls, 1);
  assert.equal(result.execution.clipboardCalls, 1);
  assert.equal(result.execution.keyLoaded, true);
  assert.equal(result.keyRestored, true);
});


test("authentication diagnostic uses clipboard bytes rather than terminal input", async () => {
  const result = await runLauncher(["auth-check"], "sk-LOCAL_FAKE_ALTERED_TERMINAL_INPUT");
  assert.equal(result.execution.keyLoaded, true);
  assert.equal(result.execution.promptCalls, 1);
  assert.equal(result.keyRestored, true);
});

test("smoke uses the confirmed clipboard key rather than altered terminal input", async () => {
  const result = await runLauncher(["smoke"], "sk-LOCAL_FAKE_ALTERED_TERMINAL_INPUT");
  assert.equal(result.execution.keyLoaded, true);
  assert.equal(result.execution.promptCalls, 1);
  assert.equal(result.execution.clipboardCalls, 1);
  assert.equal(result.keyRestored, true);
});

test("smoke with an existing environment key neither prompts nor reads the clipboard", async () => {
  const result = await runLauncher(["smoke"], "", "sk-LOCAL_FAKE_LAUNCHER_TEST");
  assert.equal(result.execution.keyLoaded, true);
  assert.equal(result.execution.promptCalls, 0);
  assert.equal(result.execution.clipboardCalls, 0);
  assert.equal(result.keyRestored, true);
});

test("propose receives a confirmed key through the Windows launcher", async () => {
  const result = await runLauncher(["propose", "tasks/example.json"]);
  assert.equal(result.execution.command, "propose");
  assert.equal(result.execution.keyLoaded, true);
  assert.equal(result.execution.clipboardCalls, 1);
  assert.equal(result.keyRestored, true);
});

test("repair receives a confirmed key through the Windows launcher", async () => {
  const result = await runLauncher(["repair", "tasks/example.json"]);
  assert.equal(result.execution.command, "repair");
  assert.equal(result.execution.promptCalls, 1);
  assert.equal(result.execution.clipboardCalls, 1);
  assert.equal(result.execution.keyLoaded, true);
  assert.equal(result.keyRestored, true);
  assert.equal(result.offlineRestored, true);
});

test("repair with an existing key neither prompts nor reads the clipboard", async () => {
  const result = await runLauncher(["repair", "tasks/example.json"], "", "sk-LOCAL_FAKE_LAUNCHER_TEST");
  assert.equal(result.execution.command, "repair");
  assert.equal(result.execution.promptCalls, 0);
  assert.equal(result.execution.clipboardCalls, 0);
  assert.equal(result.execution.keyLoaded, true);
  assert.equal(result.keyRestored, true);
});

test("benchmark receives a confirmed key through the Windows launcher", async () => {
  const result = await runLauncher(["bench", "benchmarks/example.json"]);
  assert.equal(result.execution.command, "bench");
  assert.equal(result.execution.promptCalls, 1);
  assert.equal(result.execution.clipboardCalls, 1);
  assert.equal(result.execution.keyLoaded, true);
  assert.equal(result.keyRestored, true);
  assert.equal(result.offlineRestored, true);
});

test("benchmark with an existing key neither prompts nor reads the clipboard", async () => {
  const result = await runLauncher(["bench", "benchmarks/example.json"], "", "sk-LOCAL_FAKE_LAUNCHER_TEST");
  assert.equal(result.execution.command, "bench");
  assert.equal(result.execution.promptCalls, 0);
  assert.equal(result.execution.clipboardCalls, 0);
  assert.equal(result.execution.keyLoaded, true);
  assert.equal(result.keyRestored, true);
});

test("chat receives a confirmed key through the Windows launcher", async () => {
  const result = await runLauncher(["chat", "tasks/example.json"]);
  assert.equal(result.execution.command, "chat");
  assert.equal(result.execution.promptCalls, 1);
  assert.equal(result.execution.clipboardCalls, 1);
  assert.equal(result.execution.keyLoaded, true);
  assert.equal(result.keyRestored, true);
});

test("chat with an existing key neither prompts nor reads the clipboard", async () => {
  const result = await runLauncher(["chat"], "", "sk-LOCAL_FAKE_LAUNCHER_TEST");
  assert.equal(result.execution.keyLoaded, true);
  assert.equal(result.execution.promptCalls, 0);
  assert.equal(result.execution.clipboardCalls, 0);
  assert.equal(result.keyRestored, true);
});

test("tui receives a confirmed key through the Windows launcher", async () => {
  const result = await runLauncher(["tui", "tasks/example.json"]);
  assert.equal(result.execution.command, "tui");
  assert.equal(result.execution.promptCalls, 1);
  assert.equal(result.execution.clipboardCalls, 1);
  assert.equal(result.execution.keyLoaded, true);
  assert.equal(result.execution.offline, true);
  assert.equal(result.keyRestored, true);
  assert.equal(result.offlineRestored, true);
});

test("tui with an existing key neither prompts nor reads the clipboard", async () => {
  const result = await runLauncher(["tui"], "", "sk-LOCAL_FAKE_LAUNCHER_TEST");
  assert.equal(result.execution.command, "tui");
  assert.equal(result.execution.promptCalls, 0);
  assert.equal(result.execution.clipboardCalls, 0);
  assert.equal(result.execution.keyLoaded, true);
  assert.equal(result.keyRestored, true);
});
