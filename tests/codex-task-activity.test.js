import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { inspectCodexTaskActivity } from "../src/core/codex-task-activity.js";

function fixture() {
  const codexDir = fs.mkdtempSync(path.join(os.tmpdir(), "switcher-task-activity-"));
  const sessionDir = path.join(codexDir, "sessions", "2026", "07", "11");
  fs.mkdirSync(sessionDir, { recursive: true });
  return { codexDir, rollout: path.join(sessionDir, "rollout-test.jsonl") };
}

function event(type) {
  return JSON.stringify({ type: "event_msg", payload: { type } });
}

test("keeps an unmatched task start busy until task completion is appended", () => {
  const { codexDir, rollout } = fixture();
  const cache = new Map();
  fs.writeFileSync(rollout, `${event("task_started")}\n`, "utf8");

  const started = inspectCodexTaskActivity(codexDir, cache);
  assert.equal(started.isBusy, true);
  assert.equal(started.reason, "active_task_lifecycle");

  fs.appendFileSync(rollout, `${event("task_complete")}\n`, "utf8");
  const completed = inspectCodexTaskActivity(codexDir, cache);
  assert.equal(completed.isBusy, false);
  assert.equal(completed.reason, "task_lifecycle_complete");
});

test("retains a partial record and consumes it after the next append", () => {
  const { codexDir, rollout } = fixture();
  const cache = new Map();
  const started = event("task_started");
  fs.writeFileSync(rollout, started.slice(0, -3), "utf8");

  assert.equal(inspectCodexTaskActivity(codexDir, cache).isUncertain, false);
  fs.appendFileSync(rollout, `${started.slice(-3)}\n`, "utf8");
  assert.equal(inspectCodexTaskActivity(codexDir, cache).isBusy, true);
});

test("treats a malformed complete lifecycle record as uncertain", () => {
  const { codexDir, rollout } = fixture();
  fs.writeFileSync(rollout, '{"type":"event_msg","payload":{"type":"task_started" BROKEN}\n', "utf8");

  const status = inspectCodexTaskActivity(codexDir, new Map());
  assert.equal(status.isBusy, true);
  assert.equal(status.isUncertain, true);
  assert.equal(status.reason, "task_lifecycle_uncertain");
});
