import { createReadStream } from "node:fs";
import { lstat, readdir, readlink, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

type TreeEntry = { kind: "file" | "symlink" | "directory"; hash: string; mode: number };
export type TreeSnapshot = { files: Record<string, TreeEntry>; fingerprint: string };

export class IntegrityError extends Error {
  readonly code = "TREE_CAPTURE_FAILED";
  constructor() { super("无法完整读取工作副本，不能可靠验证文件完整性。"); }
}

export class LinkBoundaryError extends Error {
  readonly code = "LINK_BOUNDARY_INVALID";
  constructor() { super("工作副本包含越界、断开或循环的链接，不能可靠验证文件完整性。"); }
}

export async function assertContainedLinks(root: string): Promise<void> {
  try {
    const absoluteRoot = resolve(root);
    const rootInfo = await lstat(absoluteRoot);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new LinkBoundaryError();
    const canonicalRoot = await realpath(absoluteRoot);
    async function visit(path: string, relativePath: string) {
      const info = await lstat(path);
      if (info.isSymbolicLink()) {
        const target = await realpath(path);
        const targetPath = relative(canonicalRoot, target);
        if (targetPath === ".." || targetPath.startsWith(`..${sep}`) || isAbsolute(targetPath)) throw new LinkBoundaryError();
      } else if (info.isDirectory()) {
        if (relativePath === ".git") return;
        for (const name of await readdir(path)) await visit(join(path, name), relativePath === "." ? name : `${relativePath}/${name}`);
      } else if (!info.isFile()) {
        throw new LinkBoundaryError();
      }
    }
    await visit(canonicalRoot, ".");
  } catch {
    throw new LinkBoundaryError();
  }
}

function hashText(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

async function hashFile(path: string) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

export async function captureTree(root: string): Promise<TreeSnapshot> {
  const entries: Array<[string, TreeEntry]> = [];
  async function visit(path: string, relativePath: string) {
    const info = await lstat(path);
    const mode = info.mode & 0o7777;
    if (info.isSymbolicLink()) {
      entries.push([relativePath, { kind: "symlink", hash: hashText(await readlink(path)), mode }]);
    } else if (info.isFile()) {
      entries.push([relativePath, { kind: "file", hash: await hashFile(path), mode }]);
    } else if (info.isDirectory()) {
      entries.push([relativePath, { kind: "directory", hash: hashText("directory"), mode }]);
      if (relativePath === ".git") return;
      for (const name of (await readdir(path)).sort()) {
        await visit(join(path, name), relativePath === "." ? name : `${relativePath}/${name}`);
      }
    } else {
      throw new IntegrityError();
    }
  }
  try {
    const absoluteRoot = resolve(root);
    const info = await lstat(absoluteRoot);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new IntegrityError();
    await visit(absoluteRoot, ".");
    entries.sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
    return { files: Object.fromEntries(entries), fingerprint: hashText(JSON.stringify(entries)) };
  } catch {
    throw new IntegrityError();
  }
}

export function inspectCandidate(before: TreeSnapshot, after: TreeSnapshot, allowedPaths: string[]) {
  const paths = [...new Set([...Object.keys(before.files), ...Object.keys(after.files)])].sort();
  const changedPaths = paths.filter(path => {
    const original = Object.hasOwn(before.files, path) ? before.files[path] : undefined;
    const candidate = Object.hasOwn(after.files, path) ? after.files[path] : undefined;
    return !original || !candidate || original.kind !== candidate.kind || original.mode !== candidate.mode || original.hash !== candidate.hash;
  });
  if (changedPaths.length === 0) return { valid: false, changedPaths, reason: "候选补丁为空。" };
  const allowed = new Set(allowedPaths);
  for (const path of changedPaths) {
    const original = Object.hasOwn(before.files, path) ? before.files[path] : undefined;
    const candidate = Object.hasOwn(after.files, path) ? after.files[path] : undefined;
    if (!original || !candidate) return { valid: false, changedPaths, reason: "候选补丁新增或删除了文件或目录。" };
    if (original.kind !== "file" || candidate.kind !== "file") return { valid: false, changedPaths, reason: "候选补丁改变了链接、目录或文件类型。" };
    if (original.mode !== candidate.mode) return { valid: false, changedPaths, reason: "候选补丁改变了文件权限。" };
    if (!allowed.has(path)) return { valid: false, changedPaths, reason: "候选补丁修改了 allowedPaths 以外的受保护文件。" };
  }
  return { valid: true, changedPaths, reason: "候选补丁仅修改了允许的原有源码文件内容。" };
}
