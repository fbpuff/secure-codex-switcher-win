import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  EDGE_WINDOW_LIFECYCLE_MAX_BYTES,
  EDGE_WINDOW_LIFECYCLE_MAX_RECORDS,
  appendEdgeWindowLifecycleRecord,
  createEdgeWindowLifecycleRecord
} from "../src/core/edge-window-lifecycle.js";

test("edge lifecycle records are allowlisted and privacy-safe", () => {
  const record = createEdgeWindowLifecycleRecord({
    event: "renderer_error",
    surface: "panel",
    phase: "ready",
    reasonCode: "window-blur",
    side: "right",
    visible: true,
    destroyed: false,
    bounds: { x: 12, y: 34, width: 360, height: 400 },
    rendererState: "ready",
    recoveryAttempt: 2,
    errorCode: "window_error",
    message: "sensitive-message account-value"
  });

  assert.equal(record.event, "renderer_error");
  assert.equal(record.surface, "panel");
  assert.deepEqual(record.bounds, { x: 12, y: 34, width: 360, height: 400 });
  assert.equal(record.recoveryAttempt, 2);
  assert.equal("message" in record, false);
  assert.equal(JSON.stringify(record).includes("sensitive-message"), false);
  assert.equal(JSON.stringify(record).includes("account-value"), false);
  assert.equal(createEdgeWindowLifecycleRecord({ event: "not-allowlisted" }).event, "unknown");
});

test("edge lifecycle log retains only a bounded newest suffix", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "edge-window-lifecycle-"));
  const filePath = path.join(directory, "edge-window-lifecycle.jsonl");
  for (let index = 0; index < EDGE_WINDOW_LIFECYCLE_MAX_RECORDS + 40; index += 1) {
    assert.equal(appendEdgeWindowLifecycleRecord(filePath, createEdgeWindowLifecycleRecord({
      event: "move_settled",
      surface: "panel",
      reasonCode: "move_" + index,
      bounds: { x: index, y: index, width: 360, height: 400 }
    })), true);
  }
  const lines = fs.readFileSync(filePath, "utf8").trim().split(/\r?\n/);
  assert.ok(lines.length <= EDGE_WINDOW_LIFECYCLE_MAX_RECORDS);
  assert.ok(Buffer.byteLength(fs.readFileSync(filePath, "utf8"), "utf8") <= EDGE_WINDOW_LIFECYCLE_MAX_BYTES);
  assert.equal(JSON.parse(lines.at(-1)).reason, "move_551");
});
