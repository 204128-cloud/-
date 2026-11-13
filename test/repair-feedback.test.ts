import assert from "node:assert/strict";
import test from "node:test";
import type { TestEvidence } from "../src/evidence.ts";
import { LocalizationError } from "../src/localization.ts";
import { buildFeedbackPrompt, canRetryVerification } from "../src/repair.ts";
import type { VerificationReport } from "../src/verifier.ts";

const rawMarker = "PRIVATE_SYNTHETIC_REPORT_VALUE_NOT_A_CREDENTIAL";
const failed: TestEvidence = { file: "test/reproduce.test.ts", fullName: "empty pagination", status: "failed", assertionFailure: true };
const passed: TestEvidence = { file: "test/regression.test.ts", fullName: "existing pagination", status: "passed", assertionFailure: false };
const base = {
  issue: "Empty pagination should report zero pages.", expectedFailure: failed.fullName,
  reproduce: [failed], regression: [passed],
  sources: [{ path: "src/paginate.ts", content: "export const pages = 1;\n" }],
};
const candidate = "diff --git a/src/paginate.ts b/src/paginate.ts\n--- a/src/paginate.ts\n+++ b/src/paginate.ts\n@@ -1 +1 @@\n-export const pages = 1;\n+export const pages = 2;\n";

function check(phase: string, tests: TestEvidence[]): VerificationReport["checks"][number] {
  return {
    phase, script: "test:fixture", command: ["node", "--test"],
    exitCode: tests.some(item => item.status === "failed") ? 1 : 0,
    timedOut: false, interrupted: false, executionError: false, outputTruncated: false,
    durationMs: 1, stdoutBytes: 0, stderrBytes: 0, logPath: "fixture-log.json", tests: tests.map(item => ({ ...item })),
  };
}

function verification(): VerificationReport {
  return {
    kind: "patch_verification", taskId: "feedback-test", baseCommit: "a".repeat(40),
    status: "unresolved", reason: rawMarker, startedAt: "2026-11-10T00:00:00.000Z", finishedAt: "2026-11-10T00:00:01.000Z",
    changedPaths: ["src/paginate.ts"],
    checks: [check("before-reproduce", [failed]), check("before-regression", [passed]),
      check("after-reproduce", [failed]), check("after-regression", [passed])],
    integrity: { stable: true, replayVerified: true },
    artifacts: { baseline: rawMarker, worktree: rawMarker, replayWorktree: rawMarker, inputPatch: rawMarker, patch: rawMarker, logs: [rawMarker] },
  };
}

test("stable verified test failure can feed a retry, including a newly failing regression", () => {
  assert.equal(canRetryVerification(verification()), true);
  const regressionFailure = verification();
  regressionFailure.checks[2] = check("after-reproduce", [{ ...failed, status: "passed", assertionFailure: false }]);
  regressionFailure.checks[3] = check("after-regression", [{ ...passed, status: "failed", assertionFailure: true }]);
  assert.equal(canRetryVerification(regressionFailure), true);
});

test("resolved, unreproduced, execution errors and coded refusals never trigger a retry", () => {
  for (const status of ["resolved", "not_reproduced", "error"] as const) {
    assert.equal(canRetryVerification({ ...verification(), status }), false);
  }
  for (const code of ["PATCH_SCOPE_INVALID", "SNAPSHOT_CHANGED", "HEAD_CHANGED", "HOST_CHANGED", "EVIDENCE_INVALID", "COMMAND_TIMEOUT"]) {
    assert.equal(canRetryVerification({ ...verification(), code }), false);
  }
});

test("missing integrity, missing after-test evidence, skipped tests and zero actual failures stop retrying", () => {
  for (const integrity of [{ stable: false, replayVerified: true }, { stable: true, replayVerified: false }]) {
    assert.equal(canRetryVerification({ ...verification(), integrity }), false);
  }
  const cases = [
    verification().checks.filter(item => item.phase !== "after-reproduce"),
    verification().checks.filter(item => item.phase !== "after-regression"),
    [check("after-reproduce", []), check("after-regression", [passed])],
    [check("after-reproduce", [failed]), { ...check("after-regression", [passed]), tests: undefined }],
    [check("after-reproduce", [failed]), check("after-regression", [{ ...passed, status: "skipped" }])],
    [check("after-reproduce", [{ ...failed, status: "passed", assertionFailure: false }]), check("after-regression", [passed])],
  ];
  for (const checks of cases) assert.equal(canRetryVerification({ ...verification(), checks }), false);
});

test("feedback preserves the original task and full candidate, sending only whitelisted after-test evidence", () => {
  const report = verification();
  Object.assign(report.checks[2], { stdout: rawMarker, stderr: rawMarker, exception: rawMarker });
  Object.assign(report.checks[2].tests![0], { actual: rawMarker, expected: rawMarker, stack: rawMarker });
  const prompt = buildFeedbackPrompt(JSON.stringify(base), candidate, report);
  const result = JSON.parse(prompt);
  assert.deepEqual(result, {
    ...base,
    feedback: {
      previousCandidate: candidate,
      checks: [
        { phase: "after-reproduce", exitCode: 1, tests: [{ file: failed.file, fullName: failed.fullName, status: "failed", assertionFailure: true }] },
        { phase: "after-regression", exitCode: 0, tests: [{ file: passed.file, fullName: passed.fullName, status: "passed", assertionFailure: false }] },
      ],
    },
  });
  assert.equal(prompt.includes(rawMarker), false);
  assert.deepEqual(base.sources, [{ path: "src/paginate.ts", content: "export const pages = 1;\n" }]);
});

test("feedback accounts for JSON escaping and UTF-8 bytes across the complete prompt", () => {
  const escapedCandidate = "\\\"".repeat(10 * 1024);
  assert.ok(Buffer.byteLength(escapedCandidate) < 32 * 1024);
  assert.throws(() => buildFeedbackPrompt(JSON.stringify(base), escapedCandidate, verification()), error => {
    assert.ok(error instanceof LocalizationError);
    assert.equal(error.code, "CONTEXT_TOO_LARGE");
    assert.equal(error.message.includes(escapedCandidate), false);
    return true;
  });
  const unicodeBase = { ...base, issue: "空数组分页应返回零页。".repeat(1200) };
  assert.ok(JSON.stringify(unicodeBase).length < 32 * 1024);
  assert.throws(() => buildFeedbackPrompt(JSON.stringify(unicodeBase), candidate, verification()), error => error instanceof LocalizationError && error.code === "CONTEXT_TOO_LARGE");
});

test("a complete 32 KiB feedback prompt fits and one extra byte is rejected without truncation", () => {
  const minimum = buildFeedbackPrompt(JSON.stringify(base), "x", verification());
  const exactCandidate = "x" + "a".repeat(32 * 1024 - Buffer.byteLength(minimum));
  const exact = buildFeedbackPrompt(JSON.stringify(base), exactCandidate, verification());
  assert.equal(Buffer.byteLength(exact), 32 * 1024);
  assert.equal(JSON.parse(exact).feedback.previousCandidate, exactCandidate);
  assert.throws(() => buildFeedbackPrompt(JSON.stringify(base), exactCandidate + "a", verification()), error => error instanceof LocalizationError && error.code === "CONTEXT_TOO_LARGE");
});
