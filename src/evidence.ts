import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, sep } from "node:path";

export type TestEvidence = {
  file: string;
  fullName: string;
  status: "passed" | "failed" | "skipped";
  assertionFailure: boolean;
};

export async function readEvidence(logPath: string, worktree: string, allowEmpty = false): Promise<TestEvidence[]> {
  try {
    if (!(await lstat(`${logPath}.writer`)).isFile()) throw new Error();
    const multipleWriters = await lstat(`${logPath}.multiple`).then(() => true, (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return false;
      throw error;
    });
    if (multipleWriters) throw new Error();
    const root = await realpath(worktree);
    const lines = (await readFile(logPath, "utf8")).trimEnd().split("\n");
    const result: TestEvidence[] = [];
    for (const [index, line] of lines.entries()) {
      const record: unknown = JSON.parse(line);
      if (!record || typeof record !== "object" || !("kind" in record)) throw new Error();
      if (index === lines.length - 1) {
        if (record.kind !== "complete" || !("count" in record) || record.count !== result.length || (!allowEmpty && result.length === 0)) throw new Error();
        continue;
      }
      if (record.kind !== "test" || !("file" in record) || typeof record.file !== "string" || !isAbsolute(record.file)
        || !("fullName" in record) || typeof record.fullName !== "string" || !record.fullName.trim()
        || !("status" in record) || !["passed", "failed", "skipped"].includes(String(record.status))
        || !("assertionFailure" in record) || typeof record.assertionFailure !== "boolean"
        || (record.status !== "failed" && record.assertionFailure)) throw new Error();
      const file = relative(root, await realpath(record.file));
      if (!file || isAbsolute(file) || file === ".." || file.startsWith(`..${sep}`)) throw new Error();
      result.push({ file: file.split(sep).join("/"), fullName: record.fullName,
        status: record.status as TestEvidence["status"], assertionFailure: record.assertionFailure });
    }
    return result;
  } catch {
    throw new Error("测试结构化证据缺失或无效。");
  }
}

export function evaluateBaseline(
  reproduce: TestEvidence[], regression: TestEvidence[], expectedFailure: string,
  reproduceExit: number | null, regressionExit: number | null,
): { baselineStatus: "ready" | "not_reproduced" | "error"; reason: string } {
  const error = (reason: string) => ({ baselineStatus: "error" as const, reason });
  if (!reproduce.length || !regression.length) return error("复现和回归集合均须实际执行至少一个测试。");
  if (reproduce.some(test => test.status === "skipped") || regression.some(test => test.status === "skipped")) {
    return error("测试存在跳过或待办用例，不能验收基准。");
  }
  if ([...reproduce, ...regression].some(test => test.status === "failed" && !test.assertionFailure)) {
    return error("测试包含非断言故障，不能视为缺陷复现。");
  }
  if (regressionExit !== 0 || regression.some(test => test.status !== "passed")) return error("基准回归集合未全部通过。");
  const failed = reproduce.some(test => test.status === "failed");
  if (reproduceExit !== (failed ? 1 : 0)) return error("复现退出码与结构化测试结果不一致。");
  const targets = reproduce.filter(test => test.fullName === expectedFailure);
  if (targets.length !== 1) return error("目标测试必须按完整名称唯一匹配，不能缺失或重名。");
  return targets[0].status === "failed"
    ? { baselineStatus: "ready", reason: "目标测试已断言失败，基准回归集合全部通过；尚未进行修复。" }
    : { baselineStatus: "not_reproduced", reason: "目标测试实际执行并通过，未复现约定缺陷。" };
}

export function evaluateVerification(
  beforeReproduce: TestEvidence[], beforeRegression: TestEvidence[],
  afterReproduce: TestEvidence[], afterRegression: TestEvidence[], expectedFailure: string,
  reproduceExit: number | null, regressionExit: number | null,
): { status: "resolved" | "unresolved" | "error"; reason: string } {
  const error = (reason: string) => ({ status: "error" as const, reason });
  const unresolved = (reason: string) => ({ status: "unresolved" as const, reason });
  const originalTarget = beforeReproduce.filter(test => test.fullName === expectedFailure);
  if (!beforeReproduce.length || !beforeRegression.length || originalTarget.length !== 1
    || originalTarget[0].status !== "failed" || !originalTarget[0].assertionFailure
    || beforeRegression.some(test => test.status !== "passed")
    || beforeReproduce.some(test => test.status === "skipped" || (test.status === "failed" && !test.assertionFailure))) {
    return error("基准测试证据不满足修复验收前提。");
  }
  for (const [tests, exitCode] of [[afterReproduce, reproduceExit], [afterRegression, regressionExit]] as const) {
    if (exitCode === null || !Number.isInteger(exitCode) || exitCode < 0
      || (tests.some(test => test.status === "failed") ? exitCode === 0 : exitCode !== 0)) {
      return error("修复后退出码缺失或与结构化测试结果不一致。");
    }
  }
  if (!afterReproduce.length || !afterRegression.length) return unresolved("修复后测试集合为空，不能认定修复成功。");
  if ([...afterReproduce, ...afterRegression].some(test => test.status !== "passed")) {
    return unresolved("修复后仍存在失败、跳过或待办用例。");
  }
  const target = afterReproduce.filter(test => test.fullName === expectedFailure);
  if (target.length !== 1 || target[0].file !== originalTarget[0].file) {
    return unresolved("修复后目标测试缺失、重名或文件身份改变。");
  }
  const counts = (tests: TestEvidence[]) => {
    const result = new Map<string, number>();
    for (const test of tests) {
      const identity = JSON.stringify([test.file, test.fullName]);
      result.set(identity, (result.get(identity) ?? 0) + 1);
    }
    return result;
  };
  for (const [before, after] of [[beforeReproduce, afterReproduce], [beforeRegression, afterRegression]]) {
    const actual = counts(after);
    if ([...counts(before)].some(([identity, count]) => actual.get(identity) !== count)) {
      return unresolved("原有测试的文件、完整名称或用例数量未保持不变。");
    }
  }
  return { status: "resolved", reason: "目标测试及原有测试均保留并通过，修复后两个测试集合全部通过。" };
}
