import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import test from "node:test";
import { executionEnvironment, runProcess } from "../src/process.ts";

test("a missing executable records a spawn error without inventing an exit code", async () => {
  const result = await runProcess(join(process.cwd(), `.missing-${randomUUID()}.exe`), [], {
    cwd: process.cwd(), env: executionEnvironment(), timeoutMs: 10_000,
  });
  assert.equal(result.executionError, true);
  assert.equal(result.spawnError, "ENOENT");
  assert.equal(result.exitCode, null);
  assert.equal(result.stdout, "");
});

test("task processes receive an environment allowlist without model credentials", async () => {
  const previous = process.env.DASHSCOPE_API_KEY;
  process.env.DASHSCOPE_API_KEY = "sk-LOCAL_FAKE_PROCESS_TEST";
  try {
    const result = await runProcess(process.execPath, ["-e", "process.stdout.write(String('DASHSCOPE_API_KEY' in process.env))"], {
      cwd: process.cwd(), env: executionEnvironment(), timeoutMs: 10_000, captureOutput: true,
    });
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, "false");
  } finally {
    if (previous === undefined) delete process.env.DASHSCOPE_API_KEY;
    else process.env.DASHSCOPE_API_KEY = previous;
  }
});

test("timeout terminates the command and its child process before returning", async () => {
  const program = "const {spawn}=require('node:child_process'); const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true}); console.log(child.pid); setInterval(()=>{},1000);";
  const result = await runProcess(process.execPath, ["-e", program], {
    cwd: process.cwd(), env: executionEnvironment(), timeoutMs: 1_500, captureOutput: true,
  });
  assert.equal(result.timedOut, true);
  assert.equal(result.exitCode, null);
  const pid = Number(result.stdout.trim());
  assert.ok(Number.isInteger(pid) && pid > 0);
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
});

test("returning after a parent exit leaves no pipe-holding child running", async () => {
  const program = "const {spawn}=require('node:child_process'); const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:['ignore','inherit','inherit'],windowsHide:true}); console.log(child.pid); setTimeout(()=>process.exit(0),200);";
  const result = await runProcess(process.execPath, ["-e", program], {
    cwd: process.cwd(), env: executionEnvironment(), timeoutMs: 1_500, captureOutput: true,
  });
  const pid = Number(result.stdout.trim());
  try {
    assert.equal(result.exitCode, result.timedOut ? null : 0);
    assert.ok(Number.isInteger(pid) && pid > 0);
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  } finally {
    if (Number.isInteger(pid) && pid > 0) { try { process.kill(pid, "SIGKILL"); } catch {} }
  }
});

test("a pre-aborted signal prevents spawning a command", async () => {
  const controller = new AbortController();
  controller.abort();
  const result = await runProcess(join(process.cwd(), `.missing-${randomUUID()}.exe`), [], {
    cwd: process.cwd(), env: executionEnvironment(), timeoutMs: 10_000, signal: controller.signal,
  });
  assert.equal(result.interrupted, true);
  assert.equal(result.executionError, false);
  assert.equal(result.exitCode, null);
});

test("an abort signal terminates the command and its child process before returning", async () => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1_500);
  const program = "const {spawn}=require('node:child_process'); const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true}); console.log(child.pid); setInterval(()=>{},1000);";
  try {
    const result = await runProcess(process.execPath, ["-e", program], {
      cwd: process.cwd(), env: executionEnvironment(), timeoutMs: 10_000, captureOutput: true, signal: controller.signal,
    });
    assert.equal(result.interrupted, true);
    assert.equal(result.timedOut, false);
    assert.equal(result.exitCode, null);
    const pid = Number(result.stdout.trim());
    assert.ok(Number.isInteger(pid) && pid > 0);
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  } finally {
    clearTimeout(timer);
  }
});
