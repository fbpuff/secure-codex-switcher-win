import assert from "node:assert/strict";
import test from "node:test";
import { autoSwitchQuietSecondsRemaining, decideAutoSwitchActivity } from "../src/core/activity-switching.js";

test("queues while a Codex chat process is active", () => {
  const decision = decideAutoSwitchActivity(
    { isBusy: true, reason: "active_chat_process", activeProcessCount: 1, activeThreadIds: ["busy"] },
    {},
    { nowMs: 1_000, quietMs: 90_000 }
  );

  assert.equal(decision.shouldQueue, true);
  assert.equal(decision.lastBusyAt, 1_000);
  assert.equal(decision.quietUntilMs, undefined);
  assert.equal(decision.activityKey, "threads:busy");
});

test("preserves the busy activity identity when the snapshot is unchanged", () => {
  const snapshot = { path: "rollout.jsonl", size: 100, mtimeMs: 1_000 };
  const first = decideAutoSwitchActivity(
    {
      isBusy: true,
      reason: "recent_session_activity",
      activeProcessCount: 0,
      lastActivityAt: 1_000,
      activitySnapshot: snapshot,
      activityKey: "rollout:rollout.jsonl:100:1000"
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
      activitySnapshot: snapshot,
      activityKey: "rollout:rollout.jsonl:100:1000"
    },
    {
      lastBusyAt: first.lastBusyAt,
      activityStatus: first.activityStatus,
      activityKey: first.activityKey,
      activityBusy: true
    },
    { nowMs: 25_000, quietMs: 90_000 }
  );

  assert.equal(first.shouldQueue, true);
  assert.equal(second.shouldQueue, true);
  assert.equal(second.lastBusyAt, 10_000);
  assert.equal(second.quietUntilMs, undefined);
  assert.equal(second.activityKey, first.activityKey);
});

test("starts one quiet period when a busy activity becomes idle", () => {
  const decision = decideAutoSwitchActivity(
    {
      isBusy: false,
      reason: "idle",
      activeProcessCount: 0,
      lastActivityAt: undefined,
      activityKey: "idle:rollout.jsonl:100:1000"
    },
    { lastBusyAt: 10_000, activityKey: "threads:busy", activityBusy: true },
    { nowMs: 80_000, quietMs: 90_000 }
  );

  assert.equal(decision.shouldQueue, true);
  assert.equal(decision.quietUntilMs, 170_000);
  assert.equal(decision.quietActivityKey, "idle:rollout.jsonl:100:1000");
});

test("starts the full quiet period after an orphaned task is confirmed ended", () => {
  const decision = decideAutoSwitchActivity(
    {
      isBusy: false,
      reason: "idle",
      activeProcessCount: 0,
      lastActivityAt: 10_000,
      activityKey: "idle:orphaned"
    },
    { lastBusyAt: 70_000, activityKey: "task:orphaned", activityBusy: true },
    { nowMs: 80_000, quietMs: 90_000 }
  );

  assert.equal(decision.quietStartedAtMs, 80_000);
  assert.equal(decision.quietUntilMs, 170_000);
});

test("keeps the quiet end stable across repeated idle polls", () => {
  const decision = decideAutoSwitchActivity(
    {
      isBusy: false,
      reason: "idle",
      activeProcessCount: 0,
      lastActivityAt: 1_000,
      activityKey: "idle:rollout.jsonl:100:1000"
    },
    {
      activityBusy: false,
      activityKey: "idle:rollout.jsonl:100:1000",
      quietActivityKey: "idle:rollout.jsonl:100:1000",
      quietUntilMs: 100_000
    },
    { nowMs: 80_000, quietMs: 90_000 }
  );

  assert.equal(decision.shouldQueue, true);
  assert.equal(decision.quietUntilMs, 100_000);
});

test("keeps the quiet end stable when only stale idle snapshot metadata changes", () => {
  const decision = decideAutoSwitchActivity(
    {
      isBusy: false,
      reason: "idle",
      activeProcessCount: 0,
      lastActivityAt: 2_000,
      activityKey: "idle:rollout-new.jsonl:200:2000"
    },
    {
      activityBusy: false,
      activityKey: "idle:rollout-old.jsonl:100:1000",
      quietActivityKey: "idle:rollout-old.jsonl:100:1000",
      quietStartedAtMs: 10_000,
      quietUntilMs: 100_000
    },
    { nowMs: 80_000, quietMs: 90_000 }
  );

  assert.equal(decision.shouldQueue, true);
  assert.equal(decision.quietStartedAtMs, 10_000);
  assert.equal(decision.quietUntilMs, 100_000);
});

test("allows auto-switch after a stable quiet period expires", () => {
  const decision = decideAutoSwitchActivity(
    {
      isBusy: false,
      reason: "idle",
      activeProcessCount: 0,
      lastActivityAt: 1_000,
      activityKey: "idle:rollout.jsonl:100:1000"
    },
    {
      activityBusy: false,
      activityKey: "idle:rollout.jsonl:100:1000",
      quietActivityKey: "idle:rollout.jsonl:100:1000",
      quietUntilMs: 100_000
    },
    { nowMs: 105_000, quietMs: 90_000 }
  );

  assert.equal(decision.shouldQueue, false);
});

test("active work extends a seeded manual inspection deadline", () => {
  const busy = decideAutoSwitchActivity(
    { isBusy: true, reason: "active_chat_process", activeThreadIds: ["busy"] },
    {
      reason: "manual-switch-inspection",
      activityBusy: false,
      quietStartedAtMs: 10_000,
      quietUntilMs: 100_000
    },
    { nowMs: 50_000, quietMs: 90_000 }
  );
  const idle = decideAutoSwitchActivity(
    { isBusy: false, reason: "idle", activityKey: "idle" },
    busy,
    { nowMs: 80_000, quietMs: 90_000 }
  );

  assert.equal(busy.shouldQueue, true);
  assert.equal(busy.quietUntilMs, undefined);
  assert.equal(idle.shouldQueue, true);
  assert.equal(idle.quietUntilMs, 170_000);
});

test("reports whole seconds remaining in the quiet period", () => {
  assert.equal(autoSwitchQuietSecondsRemaining({ quietUntilMs: 91_000 }, 1_001), 90);
  assert.equal(autoSwitchQuietSecondsRemaining({ quietUntilMs: 91_000 }, 90_999), 1);
  assert.equal(autoSwitchQuietSecondsRemaining({ quietUntilMs: 91_000 }, 91_000), 0);
});
