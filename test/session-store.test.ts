import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import {
  listSessions, loadSession, saveSession, SessionError, validateSessionSnapshot, type SessionSnapshot,
} from "../src/session-store.ts";

const snapshot = (): SessionSnapshot => ({
  task: { id: "pagination-empty", sha256: "a".repeat(64) },
  turns: [{ user: "空数组的页数应该是多少？", assistant: "应该为 0。\n\t修复后须重新运行测试。", hadImage: true,
    reports: [{ status: "resolved", reportPath: "D:\\local\\report.json", patchPath: "D:\\local\\patch.diff" }] }],
});
const errorCode = (code: string) => (error: unknown) => error instanceof SessionError && error.code === code;

async function directory(t: TestContext) {
  const root = resolve(tmpdir());
  const folder = await mkdtemp(join(root, "repopilot-session-store-"));
  t.after(async () => {
    assert.equal(dirname(resolve(folder)), root);
    await rm(folder, { recursive: true, force: true });
  });
  return folder;
}

test("saves and restores complete text turns with task identity and report references", async t => {
  const folder = await directory(t);
  const saved = await saveSession(snapshot(), { directory: folder });
  assert.equal(saved.version, 1);
  assert.match(saved.id, /^[0-9a-f-]{36}$/);
  assert.equal(saved.createdAt, new Date(saved.createdAt).toISOString());
  const loaded = await loadSession(saved.id, { directory: folder });
  assert.deepEqual(loaded, saved);
  const text = await readFile(join(folder, saved.id + ".json"), "utf8");
  assert.equal(text.includes('"hadImage": true'), true);
  assert.equal(text.includes("base64"), false);
});

test("each explicit save creates a new immutable snapshot and summaries are newest first", async t => {
  const folder = await directory(t);
  const first = await saveSession(snapshot(), { directory: folder });
  const original = await readFile(join(folder, first.id + ".json"), "utf8");
  const newer = { ...snapshot(), task: null };
  const second = await saveSession(newer, { directory: folder });
  assert.notEqual(first.id, second.id);
  assert.equal(await readFile(join(folder, first.id + ".json"), "utf8"), original);
  await writeFile(join(folder, first.id + ".json"), JSON.stringify({ ...first, createdAt: "2026-01-01T00:00:00.000Z" }));
  const summaries = await listSessions({ directory: folder });
  assert.deepEqual(summaries.map(item => item.id), [second.id, first.id]);
  assert.deepEqual(summaries[0], { id: second.id, createdAt: second.createdAt, taskId: null, turns: 1 });
  assert.equal((await loadSession(first.id, { directory: folder })).turns[0].assistant, snapshot().turns[0].assistant);
  assert.equal(JSON.parse(original).id, first.id);
});

test("missing session directories list as empty and session ids cannot select arbitrary paths", async t => {
  const folder = await directory(t);
  assert.deepEqual(await listSessions({ directory: join(folder, "absent") }), []);
  for (const id of ["../secret", "candidate.json", "D:\\private\\session.json", "", "a".repeat(36)]) {
    await assert.rejects(loadSession(id, { directory: folder }), errorCode("SESSION_ID_INVALID"));
  }
});

test("rejects incomplete turns, foreign fields, image data and arbitrary tool arguments", () => {
  const good = snapshot();
  for (const value of [
    { ...good, extra: true }, { ...good, task: { ...good.task, repoPath: "D:\\private" } },
    { ...good, turns: [] }, { ...good, turns: [{ ...good.turns[0], assistant: "" }] },
    { ...good, turns: [{ ...good.turns[0], data: "aGVsbG8=" }] },
    { ...good, turns: [{ ...good.turns[0], reports: [{ status: "resolved", reportPath: "report.json", arguments: {} }] }] },
  ]) assert.throws(() => validateSessionSnapshot(value), errorCode("SESSION_INVALID"));
});

test("snapshot validation returns detached data rather than permitting later caller mutation", () => {
  const source = snapshot();
  const copy = validateSessionSnapshot(source);
  source.turns[0].user = "changed";
  source.turns[0].reports[0].reportPath = "changed.json";
  assert.equal(copy.turns[0].user, "空数组的页数应该是多少？");
  assert.equal(copy.turns[0].reports[0].reportPath, "D:\\local\\report.json");
});

test("rejects unsafe text and credentials without putting their content in errors or files", async t => {
  const folder = await directory(t);
  const fakeKey = "sk-LOCAL_FAKE_SESSION_TEST_ONLY";
  for (const text of [fakeKey, "clear\x1b[2J", "bell\x07", "overwrite\rhidden"]) {
    const value = snapshot(); value.turns[0].assistant = text;
    await assert.rejects(saveSession(value, { directory: folder, apiKey: fakeKey }), error => {
      assert.ok(error instanceof SessionError);
      assert.equal(error.code, "SESSION_UNSAFE_CONTENT");
      assert.equal(error.message.includes(text), false);
      assert.equal(error.stack?.includes(text), false);
      return true;
    });
  }
  const value = snapshot(); value.turns[0].reports[0].reportPath = fakeKey;
  assert.throws(() => validateSessionSnapshot(value, fakeKey), errorCode("SESSION_UNSAFE_CONTENT"));
  assert.deepEqual(await readdir(folder), []);
});

test("rejects oversized turns and complete documents instead of truncating their history", async t => {
  const folder = await directory(t);
  const tooLong = snapshot(); tooLong.turns[0].user = "a".repeat(8193);
  assert.throws(() => validateSessionSnapshot(tooLong), errorCode("SESSION_TOO_LARGE"));
  const many = snapshot(); many.turns = Array.from({ length: 201 }, () => snapshot().turns[0]);
  assert.throws(() => validateSessionSnapshot(many), errorCode("SESSION_TOO_LARGE"));
  const large = snapshot(); large.turns = Array.from({ length: 17 }, () => ({ user: "question", assistant: "a".repeat(65536), hadImage: false, reports: [] }));
  await assert.rejects(saveSession(large, { directory: folder }), errorCode("SESSION_TOO_LARGE"));
  assert.deepEqual(await readdir(folder), []);
});

test("rejects corrupt JSON, invalid UTF-8, oversized files and mismatched identities safely", async t => {
  const folder = await directory(t);
  const id = "11111111-1111-4111-8111-111111111111";
  const path = join(folder, id + ".json");
  for (const bytes of ["{not-json", Buffer.from([0xc3, 0x28])]) {
    await writeFile(path, bytes);
    await assert.rejects(loadSession(id, { directory: folder }), errorCode("SESSION_INVALID"));
  }
  await writeFile(path, Buffer.alloc(1024 * 1024 + 1));
  await assert.rejects(loadSession(id, { directory: folder }), errorCode("SESSION_TOO_LARGE"));
  await writeFile(path, JSON.stringify({ ...snapshot(), version: 1, id: "22222222-2222-4222-8222-222222222222", createdAt: new Date().toISOString() }));
  await assert.rejects(loadSession(id, { directory: folder }), errorCode("SESSION_INVALID"));
  await assert.rejects(listSessions({ directory: folder }), errorCode("SESSION_INVALID"));
});

test("refuses directory entries and missing files without exposing filesystem details", async t => {
  const folder = await directory(t);
  const id = "11111111-1111-4111-8111-111111111111";
  await assert.rejects(loadSession(id, { directory: folder }), error => {
    assert.ok(error instanceof SessionError);
    assert.equal(error.code, "SESSION_READ_FAILED");
    assert.equal(error.message.includes(folder), false);
    assert.equal(error.message.includes("ENOENT"), false);
    return true;
  });
  await mkdir(join(folder, id + ".json"));
  await assert.rejects(loadSession(id, { directory: folder }), errorCode("SESSION_READ_FAILED"));
});

test("validates external files again before restoring credentials or unknown image fields", async t => {
  const folder = await directory(t);
  const id = "11111111-1111-4111-8111-111111111111";
  const fakeKey = "sk-LOCAL_FAKE_RESTORE_TEST_ONLY";
  const record = { ...snapshot(), version: 1, id, createdAt: new Date().toISOString() };
  record.turns[0].user = fakeKey;
  await writeFile(join(folder, id + ".json"), JSON.stringify(record));
  await assert.rejects(loadSession(id, { directory: folder, apiKey: fakeKey }), errorCode("SESSION_UNSAFE_CONTENT"));
  await writeFile(join(folder, id + ".json"), JSON.stringify({ ...record, turns: snapshot().turns, image: "data:image/png;base64,aGVsbG8=" }));
  await assert.rejects(loadSession(id, { directory: folder }), errorCode("SESSION_INVALID"));
});
