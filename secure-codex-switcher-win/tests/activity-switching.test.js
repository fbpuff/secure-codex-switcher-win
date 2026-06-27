import assert from "node:assert/strict";
import test from "node:test";
import { decideAutoSwitchActivity } from "../src/core/activity-switching.js";

test("queues while a Codex chat process is active", () => {
  const decision = decideAutoSwitchActivity(
    { isBusy: true, reason: "active_chat_process", activeProcessCount: 1 },
    {},
    { nowMs: 1_000, quietMs: 90_000 }
  );

  assert.equal(decision.shouldQueue, true);
  assert.equal(decision.lastBusyAt, 1_000);
  assert.equal(decision.quietUntilMs, 91_000);
});

test("queues recent session activity even when the activity snapshot is unchanged", () => {
  const snapshot = { path: "rollout.jsonl", size: 100, mtimeMs: 1_000 };
  const first = decideAutoSwitchActivity(
    {
      isBusy: true,
      reason: "recent_session_activity",
      activeProcessCount: 0,
      lastActivityAt: 1_000,
      activitySnapshot: snapshot
    },
    {},
    { nowMs: 10_000, quietMs: 90_000 }
  );
  const second = decideAutoSwitchActivity(
    {
      isBusy: true,
      reason: "recent_session_activity",
      activeProcessCount: 0,
      lastActivityAt: 1_000,
      activitySnapshot: snapshot
    },
    { lastBusyAt: first.lastBusyAt, activityStatus: first.activityStatus },
    { nowMs: 25_000, quietMs: 90_000 }
  );

  assert.equal(first.shouldQueue, true);
  assert.equal(second.shouldQueue, true);
  assert.equal(second.quietUntilMs, 115_000);
});

test("queues idle status until the quiet period has elapsed", () => {
  const decision = decideAutoSwitchActivity(
    {
      isBusy: false,
      reason: "idle",
      activeProcessCount: 0,
      lastActivityAt: 1_000
    },
    { lastBusyAt: 10_000 },
    { nowMs: 80_000, quietMs: 90_000 }
  );

  assert.equal(decision.shouldQueue, true);
  assert.equal(decision.quietUntilMs, 100_000);
});

test("allows auto-switch after a continuous quiet period", () => {
  const decision = decideAutoSwitchActivity(
    {
      isBusy: false,
      reason: "idle",
      activeProcessCount: 0,
      lastActivityAt: 1_000
    },
    { lastBusyAt: 10_000 },
    { nowMs: 105_000, quietMs: 90_000 }
  );

  assert.equal(decision.shouldQueue, false);
});
