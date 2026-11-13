import { readFile } from "node:fs/promises";
import { isAbsolute, parse } from "node:path";
import { Check, type XSchema } from "typebox/schema";

export type Task = {
  id: string;
  repoPath: string;
  baseCommit: string;
  issue: string;
  reproduceScript: string;
  regressionScript: string;
  expectedFailure: string;
  allowedPaths: string[];
};

export class TaskInputError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "TaskInputError";
    this.code = code;
  }
}

export function validSourcePath(path: string): boolean {
  if (/[\\\u0000-\u001f\u007f:*?"<>|]/.test(path)) return false;
  const segments = path.split("/");
  if (segments[0] !== "src" || segments.length < 2) return false;
  if (segments.some(segment => !segment || segment === "." || segment === ".." || /[. ]$/.test(segment))) return false;
  if (!/\.(?:ts|tsx|js|jsx|mjs|cjs|mts|cts)$/i.test(path)) return false;
  return !segments.some(segment => /(?:^|[._-])(?:tests?|specs?|configs?|fixtures?|scripts|mocks?)(?:[._-]|$)/i.test(segment));
}

export async function loadTask(taskFile: string): Promise<Task> {
  let content: string;
  try {
    content = await readFile(taskFile, "utf8");
  } catch {
    throw new TaskInputError("TASK_READ_FAILED", "无法读取任务文件。");
  }
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    throw new TaskInputError("TASK_JSON_INVALID", "任务文件不是有效 JSON。");
  }
  return validateTask(value);
}

export async function validateTask(value: unknown): Promise<Task> {
  let valid: boolean;
  try {
    const schema = JSON.parse(await readFile(new URL("../schemas/task.schema.json", import.meta.url), "utf8")) as XSchema;
    valid = Check(schema, value);
  } catch {
    throw new TaskInputError("TASK_SCHEMA_UNAVAILABLE", "无法加载任务格式约束。");
  }
  if (!valid) throw new TaskInputError("TASK_SCHEMA_INVALID", "任务字段不符合任务格式约束。");
  const task = value as Task;
  if (!isAbsolute(task.repoPath) || (process.platform === "win32" && parse(task.repoPath).root.length < 3)) {
    throw new TaskInputError("TASK_REPO_PATH_INVALID", "仓库路径必须是完整绝对路径。");
  }
  const paths = new Set<string>();
  for (const path of task.allowedPaths) {
    const identity = process.platform === "win32" ? path.toLowerCase() : path;
    if (!validSourcePath(path) || paths.has(identity)) {
      throw new TaskInputError("TASK_ALLOWED_PATH_INVALID", "允许修改范围必须是 src 下互不重复的具体 JS/TS 源码文件，不能包含测试、配置或越界路径。");
    }
    paths.add(identity);
  }
  return task;
}
