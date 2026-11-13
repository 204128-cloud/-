import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { runBaseline } from "../src/baseline.ts";
import { locateTask } from "../src/localization.ts";
import { proposeRepair } from "../src/proposal.ts";
import { repairTask } from "../src/repair.ts";
import { verifyPatch } from "../src/verifier.ts";

test("pre-cancelled task operations preserve a cancellation report without starting models or review", async () => {
  const controller = new AbortController();
  controller.abort();
  let requests = 0;
  let reviews = 0;
  const request = async () => { requests++; return {}; };
  const review = async () => { reviews++; return true; };
  const task = resolve(".repopilot/nonexistent-cancelled-task.json");
  const reports = [
    await runBaseline(task, controller.signal),
    await locateTask(task, controller.signal),
    await proposeRepair(task, request, controller.signal),
    await repairTask(task, review, request, controller.signal),
    await verifyPatch(task, "nonexistent.diff", controller.signal),
  ];
  try {
    assert.equal(requests, 0);
    assert.equal(reviews, 0);
    for (const report of reports) {
      assert.equal(report.code, "OPERATION_CANCELLED");
      if ("patch" in report.artifacts) assert.equal(report.artifacts.patch, null);
    }
  } finally {
    for (const report of reports) {
      const runDir = dirname(report.reportPath);
      assert.equal(dirname(runDir), resolve(".repopilot/runs"));
      await rm(runDir, { recursive: true, force: true });
    }
  }
});
