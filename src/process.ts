import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";

export type ProcessResult = {
  exitCode: number | null;
  timedOut: boolean;
  interrupted: boolean;
  executionError: boolean;
  spawnError?: "ENOENT" | "EACCES" | "EPERM" | "UNKNOWN";
  outputTruncated: boolean;
  durationMs: number;
  stdoutBytes: number;
  stderrBytes: number;
  stdout: string;
};

export function executionEnvironment(): NodeJS.ProcessEnv {
  const allowed = new Set([
    "PATH", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "TEMP", "TMP",
    "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "PROGRAMFILES",
    "PROGRAMFILES(X86)", "PROGRAMW6432", "SYSTEMDRIVE",
  ]);
  return {
    ...Object.fromEntries(Object.entries(process.env).filter(([name]) => allowed.has(name.toUpperCase()))),
    CI: "1", NO_COLOR: "1", npm_config_update_notifier: "false",
  };
}

async function terminateTree(child: ChildProcess) {
  if (!child.pid) return;
  if (process.platform === "win32") {
    await new Promise<void>(done => {
      const killer = spawn(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"),
        ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore", shell: false });
      const timer = setTimeout(() => killer.kill(), 5_000);
      killer.once("error", () => { clearTimeout(timer); child.kill("SIGKILL"); done(); });
      killer.once("close", code => {
        clearTimeout(timer);
        if (code !== 0) child.kill("SIGKILL");
        done();
      });
    });
  } else {
    try { process.kill(-child.pid, "SIGKILL"); }
    catch { child.kill("SIGKILL"); }
  }
}

export async function runProcess(
  executable: string, args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number; captureOutput?: boolean; signal?: AbortSignal },
): Promise<ProcessResult> {
  const started = Date.now();
  return new Promise(resolve => {
    const result: ProcessResult = {
      exitCode: null, timedOut: false, interrupted: false, executionError: false,
      outputTruncated: false, durationMs: 0, stdoutBytes: 0, stderrBytes: 0, stdout: "",
    };
    if (options.signal?.aborted) {
      result.interrupted = true;
      result.durationMs = Date.now() - started;
      resolve(result);
      return;
    }
    const chunks: Buffer[] = [];
    const child = spawn(executable, args, {
      cwd: options.cwd, env: options.env, shell: false, windowsHide: true,
      detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"],
    });
    let termination: Promise<void> | undefined;
    const stop = () => {
      termination ??= terminateTree(child).finally(() => { child.stdout?.destroy(); child.stderr?.destroy(); });
    };
    const interrupt = () => { result.interrupted = true; stop(); };
    options.signal?.addEventListener("abort", interrupt, { once: true });
    process.once("SIGINT", interrupt);
    process.once("SIGTERM", interrupt);
    const timer = setTimeout(() => { result.timedOut = true; stop(); }, options.timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => {
      result.stdoutBytes += chunk.length;
      if (options.captureOutput) {
        if (result.stdoutBytes <= 65_536) chunks.push(chunk);
        else { result.outputTruncated = true; stop(); }
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => { result.stderrBytes += chunk.length; });
    child.once("error", error => {
      result.executionError = true;
      const code = (error as NodeJS.ErrnoException).code;
      result.spawnError = code === "ENOENT" || code === "EACCES" || code === "EPERM" ? code : "UNKNOWN";
    });
    child.once("close", async code => {
      clearTimeout(timer);
      process.removeListener("SIGINT", interrupt);
      process.removeListener("SIGTERM", interrupt);
      options.signal?.removeEventListener("abort", interrupt);
      await termination;
      result.exitCode = result.timedOut || result.interrupted || result.executionError ? null : code;
      result.durationMs = Date.now() - started;
      result.stdout = Buffer.concat(chunks).toString("utf8");
      resolve(result);
    });
  });
}
