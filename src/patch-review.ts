import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { PiConnectionError } from "./pi.ts";
import type { CandidateReview } from "./repair.ts";

const MAX_PATCH_BYTES = 256 * 1024;

export async function loadPatchReview(candidate: CandidateReview, apiKey?: string): Promise<string> {
  const hasCredential = (text: string) => /\bsk-[A-Za-z0-9_-]{16,}\b/.test(text)
    || Boolean(apiKey && (text.includes(apiKey) || text.includes(JSON.stringify(apiKey).slice(1, -1))));
  if (!Number.isInteger(candidate.attempt) || candidate.attempt < 1 || candidate.attempt > 3
    || !/^[a-f0-9]{64}$/.test(candidate.candidateHash)) {
    throw new PiConnectionError("PATCH_REVIEW_INVALID_METADATA", "候选补丁的审阅信息无效，未进入确认。");
  }
  if (/[\x00-\x1f\x7f-\x9f]/.test(candidate.patchPath) || hasCredential(candidate.patchPath)) {
    throw new PiConnectionError("PATCH_REVIEW_UNSAFE_CONTENT", "候选补丁包含不适合直接展示的内容，未进入确认。");
  }
  let bytes: Buffer;
  try {
    if (!(await lstat(candidate.patchPath)).isFile()) {
      throw new PiConnectionError("PATCH_REVIEW_NOT_FILE", "候选补丁必须是普通文件，未进入确认。");
    }
    const file = await open(candidate.patchPath, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      const info = await file.stat();
      if (!info.isFile()) throw new PiConnectionError("PATCH_REVIEW_NOT_FILE", "候选补丁必须是普通文件，未进入确认。");
      if (info.size > MAX_PATCH_BYTES) throw new PiConnectionError("PATCH_REVIEW_TOO_LARGE", "候选补丁超过 256 KiB，无法完整展示，未进入确认。");
      const buffer = Buffer.allocUnsafe(MAX_PATCH_BYTES + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await file.read(buffer, length, buffer.length - length, length);
        if (bytesRead === 0) break;
        length += bytesRead;
      }
      if (length > MAX_PATCH_BYTES) throw new PiConnectionError("PATCH_REVIEW_TOO_LARGE", "候选补丁超过 256 KiB，无法完整展示，未进入确认。");
      bytes = buffer.subarray(0, length);
    } finally { await file.close(); }
  } catch (error) {
    if (error instanceof PiConnectionError) throw error;
    throw new PiConnectionError("PATCH_REVIEW_READ_FAILED", "无法读取候选补丁，未进入确认。");
  }
  if (createHash("sha256").update(bytes).digest("hex") !== candidate.candidateHash) {
    throw new PiConnectionError("PATCH_REVIEW_CHANGED", "候选补丁与审阅指纹不同，未进入确认。");
  }
  let diff: string;
  try { diff = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { throw new PiConnectionError("PATCH_REVIEW_UTF8_INVALID", "候选补丁不是有效的 UTF-8 文本，未进入确认。"); }
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]|\r(?!\n)/.test(diff) || hasCredential(diff)) {
    throw new PiConnectionError("PATCH_REVIEW_UNSAFE_CONTENT", "候选补丁包含不适合直接展示的内容，未进入确认。");
  }
  return `第 ${candidate.attempt}/3 轮候选\n补丁：${candidate.patchPath}\nSHA-256：${candidate.candidateHash}\n\n${diff}`;
}
