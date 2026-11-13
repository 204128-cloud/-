import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export type SessionReport = { status: string; reportPath: string; patchPath?: string };
export type SessionTurn = { user: string; assistant: string; hadImage: boolean; reports: SessionReport[] };
export type SessionSnapshot = { task: { id: string; sha256: string } | null; turns: SessionTurn[] };
export type SavedSession = SessionSnapshot & { version: 1; id: string; createdAt: string };
export type SessionSummary = { id: string; createdAt: string; taskId: string | null; turns: number };
type StoreOptions = { directory?: string; apiKey?: string };

const MAX_BYTES = 1024 * 1024;
const sessionId = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const defaultDirectory = fileURLToPath(new URL("../.repopilot/sessions/", import.meta.url));

export class SessionError extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(message); this.name = "SessionError"; this.code = code; }
}

function invalid(): never { throw new SessionError("SESSION_INVALID", "会话格式无效或文件已损坏。"); }
function tooLarge(): never { throw new SessionError("SESSION_TOO_LARGE", "会话超过保存或读取上限，未截断内容。"); }

function object(value: unknown, required: string[], optional: string[] = []): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  const record = value as Record<string, unknown>;
  if (required.some(key => !Object.hasOwn(record, key))
    || Object.keys(record).some(key => !required.includes(key) && !optional.includes(key))) invalid();
  return record;
}

function safeString(value: unknown, maxBytes: number, apiKey?: string, multiline = false): string {
  if (typeof value !== "string" || !value.trim()) invalid();
  if (Buffer.byteLength(value) > maxBytes) tooLarge();
  const controls = multiline ? /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]|\r(?!\n)/ : /[\x00-\x1f\x7f-\x9f]/;
  if (controls.test(value) || /\bsk-[A-Za-z0-9_-]{16,}\b/.test(value)
    || Boolean(apiKey && (value.includes(apiKey) || value.includes(JSON.stringify(apiKey).slice(1, -1))))) {
    throw new SessionError("SESSION_UNSAFE_CONTENT", "会话含控制字符或疑似凭据，未保存或恢复。");
  }
  return value;
}

export function validateSessionSnapshot(value: unknown, apiKey?: string): SessionSnapshot {
  const record = object(value, ["task", "turns"]);
  let task: SessionSnapshot["task"] = null;
  if (record.task !== null) {
    const metadata = object(record.task, ["id", "sha256"]);
    const id = safeString(metadata.id, 64, apiKey);
    const sha256 = safeString(metadata.sha256, 64, apiKey);
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id) || !/^[a-f0-9]{64}$/.test(sha256)) invalid();
    task = { id, sha256 };
  }
  if (!Array.isArray(record.turns) || record.turns.length === 0) invalid();
  if (record.turns.length > 200) tooLarge();
  const turns = record.turns.map(value => {
    const turn = object(value, ["user", "assistant", "hadImage", "reports"]);
    const user = safeString(turn.user, 8 * 1024, apiKey, true);
    const assistant = safeString(turn.assistant, 64 * 1024, apiKey, true);
    if (typeof turn.hadImage !== "boolean" || !Array.isArray(turn.reports) || turn.reports.length > 4) invalid();
    const reports = turn.reports.map(value => {
      const report = object(value, ["status", "reportPath"], ["patchPath"]);
      const status = safeString(report.status, 64, apiKey);
      if (!/^[a-z][a-z0-9_-]*$/.test(status)) invalid();
      const reportPath = safeString(report.reportPath, 4096, apiKey);
      const patchPath = report.patchPath === undefined ? undefined : safeString(report.patchPath, 4096, apiKey);
      return { status, reportPath, ...(patchPath === undefined ? {} : { patchPath }) };
    });
    return { user, assistant, hadImage: turn.hadImage, reports };
  });
  const snapshot = { task, turns };
  if (Buffer.byteLength(JSON.stringify(snapshot)) > MAX_BYTES) tooLarge();
  return snapshot;
}

function validateSaved(value: unknown, id: string, apiKey?: string): SavedSession {
  const saved = object(value, ["version", "id", "createdAt", "task", "turns"]);
  if (saved.version !== 1 || saved.id !== id || typeof saved.createdAt !== "string"
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(saved.createdAt)
    || !Number.isFinite(Date.parse(saved.createdAt)) || new Date(saved.createdAt).toISOString() !== saved.createdAt) invalid();
  return { version: 1, id, createdAt: saved.createdAt,
    ...validateSessionSnapshot({ task: saved.task, turns: saved.turns }, apiKey) };
}

async function checkDirectory(directory: string, missingAllowed = false): Promise<boolean> {
  try {
    if (!(await lstat(directory)).isDirectory()) throw new SessionError("SESSION_READ_FAILED", "会话目录不可用。");
    return true;
  } catch (error) {
    if (missingAllowed && (error as NodeJS.ErrnoException).code === "ENOENT") return false;
    if (error instanceof SessionError) throw error;
    throw new SessionError("SESSION_READ_FAILED", "无法读取本地会话目录。");
  }
}

export async function saveSession(snapshot: SessionSnapshot, options: StoreOptions = {}): Promise<SavedSession> {
  const valid = validateSessionSnapshot(snapshot, options.apiKey);
  const saved: SavedSession = { version: 1, id: randomUUID(), createdAt: new Date().toISOString(), ...valid };
  const content = JSON.stringify(saved, null, 2) + "\n";
  if (Buffer.byteLength(content) > MAX_BYTES) tooLarge();
  const directory = options.directory ?? defaultDirectory;
  try {
    await mkdir(directory, { recursive: true });
    await checkDirectory(directory);
    await writeFile(join(directory, saved.id + ".json"), content, { flag: "wx", mode: 0o600 });
    return saved;
  } catch (error) {
    if (error instanceof SessionError) throw error;
    throw new SessionError("SESSION_WRITE_FAILED", "无法保存会话，已有文件不会被覆盖。");
  }
}

export async function loadSession(id: string, options: StoreOptions = {}): Promise<SavedSession> {
  if (!sessionId.test(id)) throw new SessionError("SESSION_ID_INVALID", "请提供会话列表中的完整会话编号。");
  const directory = options.directory ?? defaultDirectory;
  await checkDirectory(directory);
  let bytes: Buffer;
  try {
    const path = join(directory, id + ".json");
    const before = await lstat(path);
    if (!before.isFile()) throw new SessionError("SESSION_READ_FAILED", "会话文件必须是常规文件。");
    const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0));
    try {
      const info = await file.stat();
      if (!info.isFile() || info.dev !== before.dev || info.ino !== before.ino) {
        throw new SessionError("SESSION_READ_FAILED", "会话文件在读取前发生变化。");
      }
      if (info.size > MAX_BYTES) tooLarge();
      const buffer = Buffer.allocUnsafe(MAX_BYTES + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await file.read(buffer, length, buffer.length - length, length);
        if (!bytesRead) break;
        length += bytesRead;
      }
      if (length > MAX_BYTES) tooLarge();
      bytes = buffer.subarray(0, length);
    } finally { await file.close(); }
  } catch (error) {
    if (error instanceof SessionError) throw error;
    throw new SessionError("SESSION_READ_FAILED", "无法读取指定会话。");
  }
  let value: unknown;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes)); }
  catch { invalid(); }
  return validateSaved(value, id, options.apiKey);
}

export async function listSessions(options: StoreOptions = {}): Promise<SessionSummary[]> {
  const directory = options.directory ?? defaultDirectory;
  if (!await checkDirectory(directory, true)) return [];
  let names: string[];
  try { names = await readdir(directory); }
  catch { throw new SessionError("SESSION_READ_FAILED", "无法列出本地会话。"); }
  const summaries: SessionSummary[] = [];
  for (const name of names) {
    if (!name.endsWith(".json") || !sessionId.test(name.slice(0, -5))) continue;
    const session = await loadSession(name.slice(0, -5), options);
    summaries.push({ id: session.id, createdAt: session.createdAt, taskId: session.task?.id ?? null, turns: session.turns.length });
  }
  return summaries.sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id));
}
