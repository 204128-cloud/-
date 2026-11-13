import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { PiConnectionError } from "../src/pi.ts";
import { loadPatchReview } from "../src/patch-review.ts";
import type { CandidateReview } from "../src/repair.ts";

const hash = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const fakeKey = "sk-LOCAL_FAKE_PREVIEW_TEST_ONLY";

async function fixture(t: TestContext, content: string | Buffer) {
  const temporaryRoot = resolve(tmpdir());
  const directory = await mkdtemp(join(temporaryRoot, "repopilot-patch-review-"));
  t.after(async () => {
    assert.equal(dirname(resolve(directory)), temporaryRoot);
    await rm(directory, { recursive: true, force: true });
  });
  const patchPath = join(directory, "candidate.diff");
  await writeFile(patchPath, content);
  const candidate: CandidateReview = { attempt: 2, patchPath, candidateHash: hash(content), proposalReport: "proposal.json" };
  return { directory, candidate };
}

function rejectsCode(code: string, forbidden: string[] = []) {
  return (error: unknown) => {
    assert.ok(error instanceof PiConnectionError);
    assert.equal(error.code, code);
    for (const text of forbidden) {
      assert.equal(error.message.includes(text), false);
      assert.equal(error.stack?.includes(text), false);
    }
    return true;
  };
}

test("loads a complete hash-matched UTF-8 diff with its review identity", async t => {
  const diff = "diff --git a/src/demo.ts b/src/demo.ts\r\n--- a/src/demo.ts\r\n+++ b/src/demo.ts\r\n@@ -1 +1 @@\r\n-\treturn 1; // 原行为\r\n+\treturn 0; // 修复\r\n";
  const { candidate } = await fixture(t, diff);
  const preview = await loadPatchReview(candidate);
  assert.ok(preview.includes("第 2/3 轮候选"));
  assert.ok(preview.includes(candidate.patchPath));
  assert.ok(preview.includes(candidate.candidateHash));
  assert.ok(preview.endsWith(diff));
  assert.equal(preview.includes("\x1b"), false);
});

test("refuses changed patch bytes instead of presenting an outdated review hash", async t => {
  const { candidate } = await fixture(t, "original patch\n");
  await writeFile(candidate.patchPath, "changed patch\n");
  await assert.rejects(loadPatchReview(candidate), rejectsCode("PATCH_REVIEW_CHANGED", [candidate.patchPath, "changed patch"]));
});

test("accepts the full preview size limit and rejects a larger file without truncation", async t => {
  const content = "a".repeat(256 * 1024);
  const { candidate } = await fixture(t, content);
  assert.ok((await loadPatchReview(candidate)).endsWith(content));
  await writeFile(candidate.patchPath, content + "b");
  await assert.rejects(loadPatchReview({ ...candidate, candidateHash: hash(content + "b") }), rejectsCode("PATCH_REVIEW_TOO_LARGE"));
});

test("refuses non-files and unreadable candidates without echoing their paths", async t => {
  const { candidate, directory } = await fixture(t, "safe\n");
  await assert.rejects(loadPatchReview({ ...candidate, patchPath: directory }), rejectsCode("PATCH_REVIEW_NOT_FILE", [directory]));
  const missing = join(directory, "missing-private-candidate.diff");
  await assert.rejects(loadPatchReview({ ...candidate, patchPath: missing }), rejectsCode("PATCH_REVIEW_READ_FAILED", [missing, "ENOENT"]));
});

test("rejects invalid UTF-8 bytes rather than silently replacing candidate text", async t => {
  const { candidate } = await fixture(t, Buffer.from([0xc3, 0x28]));
  await assert.rejects(loadPatchReview(candidate), rejectsCode("PATCH_REVIEW_UTF8_INVALID"));
});

test("rejects terminal controls and lone carriage returns in the diff", async t => {
  const { candidate } = await fixture(t, "safe\n");
  for (const content of ["clear\x1b[2J", "bell\x07", "csi\x9b31m", "overwrite\rhidden", "backspace\b"]) {
    await writeFile(candidate.patchPath, content);
    await assert.rejects(loadPatchReview({ ...candidate, candidateHash: hash(content) }), rejectsCode("PATCH_REVIEW_UNSAFE_CONTENT", [content]));
  }
});

test("rejects credential-bearing content and unsafe review metadata", async t => {
  const { candidate } = await fixture(t, "safe\n");
  for (const content of [`+const key = '${fakeKey}';\n`, "+sk-LOCAL_FAKE_PATCH_REVIEW_FOREIGN\n"]) {
    await writeFile(candidate.patchPath, content);
    await assert.rejects(loadPatchReview({ ...candidate, candidateHash: hash(content) }, fakeKey), rejectsCode("PATCH_REVIEW_UNSAFE_CONTENT", [fakeKey, content]));
  }
  for (const patchPath of [`${candidate.patchPath}\nspoof`, `${candidate.patchPath}\x1b[2J`, `${candidate.patchPath}-${fakeKey}`]) {
    await assert.rejects(loadPatchReview({ ...candidate, patchPath }, fakeKey), rejectsCode("PATCH_REVIEW_UNSAFE_CONTENT", [patchPath, fakeKey]));
  }
  for (const invalid of [{ ...candidate, candidateHash: "bad-hash" }, { ...candidate, attempt: 0 }]) {
    await assert.rejects(loadPatchReview(invalid), rejectsCode("PATCH_REVIEW_INVALID_METADATA"));
  }
});
