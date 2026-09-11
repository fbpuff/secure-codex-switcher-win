import assert from "node:assert/strict";
import test from "node:test";
import { createProgressEtaEstimator } from "../src/core/progress-eta.js";

test("ETA waits ten seconds, resets by stage, and expires after a stall", () => {
  const eta = createProgressEtaEstimator();
  const startedAt = 1_000_000;
  const processing = (processedBytes) => ({ stage: "processing", processedBytes, totalBytes: 120 });

  assert.equal(eta.update(processing(0), startedAt, startedAt), undefined);
  assert.equal(eta.update(processing(10), startedAt + 5_000, startedAt), undefined);
  assert.equal(eta.update(processing(20), startedAt + 10_000, startedAt), 1);
  assert.equal(eta.update({ stage: "validating", processedBytes: 10, totalBytes: 120 }, startedAt + 11_000, startedAt), undefined);
  assert.equal(eta.update({ stage: "validating", processedBytes: 30, totalBytes: 120 }, startedAt + 22_000, startedAt), 1);
  assert.equal(eta.update({ stage: "validating", processedBytes: 30, totalBytes: 120 }, startedAt + 38_000, startedAt), undefined);
});

test("ETA rejects indeterminate and completed stages", () => {
  const eta = createProgressEtaEstimator();
  assert.equal(eta.update({ stage: "discovering" }, 20_000, 0), undefined);
  assert.equal(eta.update({ stage: "completed", processedBytes: 10, totalBytes: 10 }, 20_000, 0), undefined);
});

test("ETA warmup starts when the ETA stage starts", () => {
  const eta = createProgressEtaEstimator();
  const progress = (processedBytes) => ({ stage: "validating_backup", processedBytes, totalBytes: 100 });
  eta.update(progress(10), 30_000, 0);
  assert.equal(eta.update(progress(20), 35_000, 0), undefined);
  assert.equal(eta.update(progress(40), 40_000, 0), 1);
});
