import { constants, type Stats } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import { basename } from "node:path";
import type { ImageContent } from "@earendil-works/pi-ai";

export type ChatAttachment = { name: string; bytes: number; image: ImageContent };
export type ImageCommand = { action: "show" } | { action: "clear" } | { action: "attach"; path: string };

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from("89504e470d0a1a0a", "hex");
const JPEG_SIGNATURE = Buffer.from("ffd8ff", "hex");
const WINDOWS_DEVICE_NAME = /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³]|conin\$|conout\$) *(?:\.|$)/i;

export class ChatImageError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "ChatImageError";
    this.code = code;
  }
}

function validateLocalPath(path: string, apiKey?: string): void {
  const withoutDrive = path.replace(/^[a-z]:(?=[\\/])/i, "");
  if (!path.trim() || /^[\\/]{2}/.test(path) || /[:\x00-\x1f\x7f-\x9f]/.test(withoutDrive)
      || /\bsk-[A-Za-z0-9_-]{16,}\b/.test(path)
      || Boolean(apiKey && (path.includes(apiKey) || path.includes(JSON.stringify(apiKey).slice(1, -1)))) ||
      withoutDrive.split(/[\\/]/).some(segment => WINDOWS_DEVICE_NAME.test(segment))) {
    throw new ChatImageError("CHAT_IMAGE_PATH_INVALID", "请提供本地图片文件路径。");
  }
}

function validateImageFile(file: Stats): void {
  if (!file.isFile()) throw new ChatImageError("CHAT_IMAGE_NOT_FILE", "图片路径必须指向普通文件。");
  if (file.size > MAX_IMAGE_BYTES) throw new ChatImageError("CHAT_IMAGE_TOO_LARGE", "图片大小不能超过 5 MiB。");
}

function imageMimeType(bytes: Buffer): string {
  if (bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return "image/png";
  if (bytes.subarray(0, 3).equals(JPEG_SIGNATURE)) return "image/jpeg";
  if (bytes.toString("latin1", 0, 4) === "RIFF" && bytes.toString("latin1", 8, 12) === "WEBP") return "image/webp";
  throw new ChatImageError("CHAT_IMAGE_FORMAT_UNSUPPORTED", "仅支持 PNG、JPEG 和 WebP 图片。");
}

export function parseImageCommand(text: string): ImageCommand {
  const match = /^\/image(?:\s+(.*))?$/.exec(text.trim());
  const invalid = () => new ChatImageError("CHAT_IMAGE_COMMAND_INVALID", "用法：/image [本地路径] 或 /image clear。");
  if (!match) throw invalid();
  const argument = match[1]?.trim() ?? "";
  if (!argument) return { action: "show" };
  if (argument === "clear") return { action: "clear" };
  let path = argument;
  if (argument.startsWith('"') || argument.startsWith("'")) {
    if (argument.length < 2 || argument.at(-1) !== argument[0]) throw invalid();
    path = argument.slice(1, -1);
  }
  validateLocalPath(path);
  return { action: "attach", path };
}

export function parseImageInput(text: string): { path: string; prompt: string } | undefined {
  const input = text.trim();
  const quoted = /^(["'])(.*?)\1([\s\S]*)$/.exec(input);
  const plain = /^((?:[a-z]:[\\/]|\.{1,2}[\\/]).*?\.(?:png|jpe?g|webp))(?=\s|$)([\s\S]*)$/i.exec(input);
  const path = quoted?.[2] ?? plain?.[1];
  if (!path || !/^(?:[a-z]:[\\/]|\.{1,2}[\\/])/i.test(path) || !/\.(?:png|jpe?g|webp)$/i.test(path)) return;
  return { path, prompt: (quoted?.[3] ?? plain?.[2] ?? "").trim() };
}

export function formatImageAttachment(attachment: ChatAttachment): string {
  const format = { "image/png": "PNG", "image/jpeg": "JPEG", "image/webp": "WebP" }[attachment.image.mimeType] ?? "图片";
  const size = attachment.bytes < 1024 ? `${attachment.bytes} B` : attachment.bytes < 1024 * 1024
    ? `${(attachment.bytes / 1024).toFixed(1)} KiB` : `${(attachment.bytes / (1024 * 1024)).toFixed(1)} MiB`;
  return `${attachment.name} · ${format} · ${size}`;
}

export async function loadChatAttachment(path: string, apiKey?: string): Promise<ChatAttachment> {
  validateLocalPath(path, apiKey);
  try {
    const localPath = await realpath(path);
    validateLocalPath(localPath, apiKey);
    validateImageFile(await stat(localPath));
    const file = await open(localPath, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      validateImageFile(await file.stat());
      const buffer = Buffer.allocUnsafe(MAX_IMAGE_BYTES + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await file.read(buffer, length, buffer.length - length, length);
        if (bytesRead === 0) break;
        length += bytesRead;
      }
      if (length > MAX_IMAGE_BYTES) throw new ChatImageError("CHAT_IMAGE_TOO_LARGE", "图片大小不能超过 5 MiB。");
      const bytes = buffer.subarray(0, length);
      return { name: basename(path), bytes: length,
        image: { type: "image", mimeType: imageMimeType(bytes), data: bytes.toString("base64") } };
    } finally {
      await file.close();
    }
  } catch (error) {
    if (error instanceof ChatImageError) throw error;
    throw new ChatImageError("CHAT_IMAGE_READ_FAILED", "无法读取图片文件。");
  }
}

export async function loadChatImage(path: string): Promise<ImageContent> {
  return (await loadChatAttachment(path)).image;
}
