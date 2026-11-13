import { open, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

type ReporterEvent = {
  type: string;
  data: {
    file?: string; name?: string; nesting?: number; skip?: boolean | string; todo?: boolean | string;
    details?: { type?: string; error?: unknown };
  };
};

function assertionFailure(error: unknown): boolean {
  const seen = new Set<object>();
  while (error && typeof error === "object" && !seen.has(error)) {
    seen.add(error);
    if ("code" in error && error.code === "ERR_ASSERTION") return true;
    error = "cause" in error ? error.cause : undefined;
  }
  return false;
}

export default async function* reporter(source: AsyncIterable<unknown>) {
  const evidencePath = process.env.REPOPILOT_EVIDENCE_PATH;
  let writerClaimed = false;
  if (evidencePath) {
    try {
      const writer = await open(`${evidencePath}.writer`, "wx");
      await writer.close();
      writerClaimed = true;
    } catch {
      await writeFile(`${evidencePath}.multiple`, "multiple writers\n", { flag: "wx" }).catch(() => {});
    }
  }
  if (!writerClaimed) yield JSON.stringify({ kind: "invalid" }) + "\n";
  const names = new Map<string, string[]>();
  let count = 0;
  let rootSummary = false;
  for await (const raw of source) {
    const event = raw as ReporterEvent;
    const data = event.data;
    if (event.type === "test:summary" && data.file === undefined) rootSummary = true;
    if (event.type === "test:interrupted") yield JSON.stringify({ kind: "invalid" }) + "\n";
    if (!["test:start", "test:pass", "test:fail"].includes(event.type)) continue;
    if (typeof data.file !== "string" || typeof data.name !== "string" || !Number.isInteger(data.nesting)) {
      yield JSON.stringify({ kind: "invalid" }) + "\n";
      continue;
    }
    const nesting = data.nesting!;
    const ancestors = names.get(data.file) ?? [];
    if (event.type === "test:start") {
      ancestors.length = nesting;
      ancestors.push(data.name);
      names.set(data.file, ancestors);
      continue;
    }
    const skipped = (data.skip !== undefined && data.skip !== false) || (data.todo !== undefined && data.todo !== false);
    const error = data.details?.error;
    const failureType = error && typeof error === "object" && "failureType" in error ? error.failureType : undefined;
    if (data.details?.type === "suite" && !skipped
      && (event.type === "test:pass" || failureType === "subtestsFailed")) continue;
    const fileWrapper = resolve(data.name) === resolve(data.file);
    if (fileWrapper && event.type === "test:pass" && !skipped) continue;
    const fullName = [...ancestors.slice(0, nesting), data.name].join(" > ");
    const failed = event.type === "test:fail";
    yield JSON.stringify({
      kind: "test", file: data.file, fullName,
      status: skipped ? "skipped" : failed ? "failed" : "passed",
      assertionFailure: failed && !fileWrapper && data.details?.type !== "suite" && assertionFailure(error),
    }) + "\n";
    count++;
  }
  if (rootSummary) yield JSON.stringify({ kind: "complete", count }) + "\n";
}

