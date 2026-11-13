import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { delimiter, isAbsolute, join, parse, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const localGit = fileURLToPath(new URL("../.repopilot/tools/git/cmd/git.exe", import.meta.url));

function absolute(path: string): boolean {
  return isAbsolute(path) && (process.platform !== "win32" || parse(path).root.length >= 3);
}

function environmentValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  if (process.platform !== "win32") return env[name];
  const key = Object.keys(env).sort().find(key => key.toUpperCase() === name);
  return key === undefined ? undefined : env[key];
}

export async function findGitExecutable(env: NodeJS.ProcessEnv, localGitPath = localGit): Promise<string | undefined> {
  const candidates: string[] = [];
  const executable = process.platform === "win32" ? "git.exe" : "git";
  for (const entry of (environmentValue(env, "PATH") ?? "").split(delimiter)) {
    const directory = entry.trim().replace(/^"(.*)"$/, "$1");
    if (absolute(directory)) candidates.push(join(directory, executable));
  }
  if (process.platform === "win32") {
    for (const key of ["PROGRAMFILES", "PROGRAMFILES(X86)", "PROGRAMW6432"]) {
      const directory = environmentValue(env, key);
      if (directory && absolute(directory)) candidates.push(join(directory, "Git", "cmd", "git.exe"));
    }
    const appData = environmentValue(env, "LOCALAPPDATA");
    if (appData && absolute(appData)) candidates.push(join(appData, "Programs", "Git", "cmd", "git.exe"));
  }
  if (absolute(localGitPath)) candidates.push(localGitPath);
  for (const candidate of candidates) {
    try {
      if (!(await stat(candidate)).isFile()) continue;
      await access(candidate, constants.X_OK);
      return resolve(candidate);
    } catch {
      // A missing or inaccessible candidate does not prevent trying the next location.
    }
  }
  return undefined;
}
