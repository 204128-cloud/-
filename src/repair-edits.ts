import { Type } from "typebox";
import { Check } from "typebox/schema";

const MAX_FRAGMENT_BYTES = 16 * 1024;
const MAX_CHANGED_BYTES = 64 * 1024;

export const REPAIR_EDITS_SCHEMA = Type.Object({
  edits: Type.Array(Type.Object({
    path: Type.String({ minLength: 1 }),
    before: Type.String({ minLength: 1, maxLength: MAX_FRAGMENT_BYTES }),
    after: Type.String({ maxLength: MAX_FRAGMENT_BYTES }),
  }, { additionalProperties: false }), { minItems: 1, maxItems: 16 }),
}, { additionalProperties: false });

export class RepairEditError extends Error {
  readonly code = "INVALID_REPAIR_EDITS";

  constructor() {
    super("候选编辑无效。请检查源码路径、唯一匹配片段和编辑大小。");
    this.name = "RepairEditError";
  }
}

export function applyRepairEdits(value: unknown, sources: ReadonlyMap<string, string>): Map<string, string> {
  if (!Check(REPAIR_EDITS_SCHEMA, value)) throw new RepairEditError();

  const changed = new Map<string, string>();
  let changedBytes = 0;
  for (const edit of value.edits) {
    const original = sources.get(edit.path);
    if (original === undefined || changed.has(edit.path) || original.includes("\0")) throw new RepairEditError();
    for (const fragment of [edit.before, edit.after]) {
      if (fragment.includes("\0") || !fragment.isWellFormed() || Buffer.byteLength(fragment) > MAX_FRAGMENT_BYTES) {
        throw new RepairEditError();
      }
    }

    const usesCrlf = original.includes("\r\n");
    const normalized = original.replaceAll("\r\n", "\n");
    if (normalized.includes("\r") || (usesCrlf && original.replaceAll("\r\n", "").includes("\n"))) {
      throw new RepairEditError();
    }
    const before = edit.before.replaceAll("\r\n", "\n");
    const after = edit.after.replaceAll("\r\n", "\n");
    if (before.includes("\r") || after.includes("\r") || before === after) throw new RepairEditError();

    const start = normalized.indexOf(before);
    if (start < 0 || normalized.indexOf(before, start + 1) !== -1) throw new RepairEditError();

    const replacement = normalized.slice(0, start) + after + normalized.slice(start + before.length);
    const next = usesCrlf ? replacement.replaceAll("\n", "\r\n") : replacement;
    changedBytes += Buffer.byteLength(next);
    if (changedBytes > MAX_CHANGED_BYTES) throw new RepairEditError();
    changed.set(edit.path, next);
  }
  return changed;
}
