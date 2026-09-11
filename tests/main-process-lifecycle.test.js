import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  appendMainProcessLifecycleRecord,
  createMainProcessLifecycleRecord,
  MAIN_PROCESS_LIFECYCLE_MAX_BYTES,
  MAIN_PROCESS_LIFECYCLE_MAX_RECORDS
} from "../src/core/main-process-lifecycle.js";

test("lifecycle records keep a bounded, privacy-safe field contract", () => {
  const record = createMainProcessLifecycleRecord({
    event: "recoverable_error",
    phase: "ready",
    reasonCode: "C:\\Users\\private-user\\state.json https://proxy.invalid",
    pid: 42,
    version: "2.15.26",
    packaged: true,
    timestamp: "2026-08-28T00:00:00.000Z"
  });

  assert.deepEqual(Object.keys(record), [
    "timestamp",
    "pid",
    "version",
    "packaged",
    "event",
    "phase",
    "reasonCode"
  ]);
  assert.equal(record.timestamp, "2026-08-28T08:00:00.000+08:00");
  assert.equal(record.pid, 42);
  assert.equal(record.version, "2.15.26");
  assert.equal(record.packaged, true);
  assert.equal(record.event, "recoverable_error");
  assert.equal(record.phase, "ready");
  assert.equal(record.reasonCode, "unspecified");
  assert.doesNotMatch(JSON.stringify(record), /private-user|proxy\.invalid/);
});

test("lifecycle journal stays bounded when many events are recorded", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "secure-codex-switcher-lifecycle-"));
  const filePath = path.join(root, "main-process-lifecycle.jsonl");

  try {
    for (let index = 0; index < MAIN_PROCESS_LIFECYCLE_MAX_RECORDS + 80; index += 1) {
      appendMainProcessLifecycleRecord(
        filePath,
        createMainProcessLifecycleRecord({
          event: "recoverable_error",
          phase: "ready",
          reasonCode: "epipe",
          pid: index + 1,
          version: "2.15.26",
          packaged: true,
          timestamp: new Date(index * 1000)
        })
      );
    }

    const contents = fs.readFileSync(filePath, "utf8");
    const records = contents.trim().split(/\r?\n/).map((line) => JSON.parse(line));
    assert.ok(Buffer.byteLength(contents, "utf8") <= MAIN_PROCESS_LIFECYCLE_MAX_BYTES);
    assert.ok(records.length <= MAIN_PROCESS_LIFECYCLE_MAX_RECORDS);
    assert.equal(records.at(-1).pid, MAIN_PROCESS_LIFECYCLE_MAX_RECORDS + 80);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
