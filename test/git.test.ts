import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { delimiter, dirname, join, relative, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { findGitExecutable } from "../src/git.ts";

const project = fileURLToPath(new URL("..", import.meta.url));
const filename = process.platform === "win32" ? "git.exe" : "git";

async function withFixture(verify: (directory: string, fakeGit: (directory: string) => Promise<string>) => Promise<void>) {
  const parent = resolve(project, ".repopilot", "git-tests");
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(join(parent, "case-"));
  const fakeGit = async (directory: string) => {
    await mkdir(directory, { recursive: true });
    const file = join(directory, filename);
    await writeFile(file, "Fake executable for lookup tests; never execute.\n");
    if (process.platform !== "win32") await chmod(file, 0o755);
    return file;
  };
  try { await verify(directory, fakeGit); }
  finally {
    assert.equal(dirname(resolve(directory)), parent);
    await rm(directory, { recursive: true, force: true });
  }
}

test("Git lookup follows PATH order and removes path-entry quotes", async () => {
  await withFixture(async (directory, fakeGit) => {
    const first = await fakeGit(join(directory, "first with spaces"));
    const second = await fakeGit(join(directory, "second"));
    const local = await fakeGit(join(directory, "local"));
    const env = { PATH: `"${dirname(first)}"${delimiter}"${dirname(second)}"` };
    assert.equal(await findGitExecutable(env, local), first);
  });
});

test("Windows duplicate PATH keys use the first key in lexicographic order", { skip: process.platform !== "win32" }, async () => {
  await withFixture(async (directory, fakeGit) => {
    const ignored = await fakeGit(join(directory, "ignored-path"));
    const local = await fakeGit(join(directory, "local"));
    const env = { Path: dirname(ignored), PATH: join(directory, "missing-path") };
    assert.equal(await findGitExecutable(env, local), local);
  });
});

test("Windows standard Git installations precede the project fallback", { skip: process.platform !== "win32" }, async () => {
  await withFixture(async (directory, fakeGit) => {
    const programFiles = join(directory, "Program Files");
    const installed = await fakeGit(join(programFiles, "Git", "cmd"));
    const local = await fakeGit(join(directory, "local"));
    assert.equal(await findGitExecutable({ ProgramFiles: programFiles }, local), installed);
    const appData = join(directory, "AppData", "Local");
    const userInstalled = await fakeGit(join(appData, "Programs", "Git", "cmd"));
    assert.equal(await findGitExecutable({ localappdata: appData }, local), userInstalled);
  });
});

test("a project-local Git works without PATH and missing Git returns undefined", async () => {
  await withFixture(async (directory, fakeGit) => {
    const local = await fakeGit(join(directory, "local"));
    assert.equal(await findGitExecutable({}, local), local);
    assert.equal(await findGitExecutable({}, join(directory, "missing-git")), undefined);
  });
});

test("relative and empty PATH entries and relative local fallbacks are ignored", async () => {
  await withFixture(async (directory, fakeGit) => {
    const relativeGit = await fakeGit(join(directory, "relative"));
    const relativeDirectory = relative(process.cwd(), dirname(relativeGit));
    assert.equal(await findGitExecutable({ PATH: `${delimiter}.${delimiter}${relativeDirectory}` }, join(directory, "missing")), undefined);
    assert.equal(await findGitExecutable({}, relative(process.cwd(), relativeGit)), undefined);
  });
});

test("a directory named as Git is not an executable candidate", async () => {
  await withFixture(async (directory, fakeGit) => {
    const candidateDirectory = join(directory, "path");
    await mkdir(join(candidateDirectory, filename), { recursive: true });
    const local = await fakeGit(join(directory, "local"));
    assert.equal(await findGitExecutable({ PATH: candidateDirectory }, local), local);
  });
});
