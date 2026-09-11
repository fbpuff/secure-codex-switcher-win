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

function event(type, timestamp) {
  return JSON.stringify({ type: "event_msg", payload: { type }, ...(timestamp ? { timestamp } : {}) });
}

function sessionMeta(id, extra = {}) {
  return JSON.stringify({ type: "session_meta", payload: { id, ...extra } });
}

function writeRollout(codexDir, name, lines) {
  const sessionDir = path.join(codexDir, "sessions", "2026", "07", "13");
  fs.mkdirSync(sessionDir, { recursive: true });
  const filePath = path.join(sessionDir, name);
  fs.writeFileSync(filePath, `${lines.join("\n")}\n`, "utf8");
  return filePath;
}

function activeRollout(id) {
  return [sessionMeta(id), event("task_started")];
}

function completedRollout(id) {
  return [...activeRollout(id), event("task_complete")];
}

test("aggregates every concurrently active rollout thread", () => {
  const codexDir = fs.mkdtempSync(path.join(os.tmpdir(), "switcher-multi-task-"));
  writeRollout(codexDir, "rollout-a.jsonl", activeRollout("thread-a"));
  writeRollout(codexDir, "rollout-b.jsonl", activeRollout("thread-b"));

  const status = inspectCodexTaskActivity(codexDir, new Map());

  assert.equal(status.isBusy, true);
  assert.deepEqual(status.activeThreadIds, ["thread-a", "thread-b"]);
});

test("resolves privacy-safe readable task names from the local thread index", () => {
  const codexDir = fs.mkdtempSync(path.join(os.tmpdir(), "switcher-readable-task-"));
  fs.writeFileSync(
    path.join(codexDir, "session_index.jsonl"),
    `${JSON.stringify({ id: "thread-a", thread_name: "检查自动切换倒计时", updated_at: "2026-07-14T06:00:00.000Z" })}\n`,
    "utf8"
  );
  writeRollout(codexDir, "rollout-a.jsonl", activeRollout("thread-a"));

  const status = inspectCodexTaskActivity(codexDir, new Map());

  assert.deepEqual(status.activeTasks, [{
    id: "thread-a",
    displayName: "检查自动切换倒计时",
    nameSource: "thread_title",
    activityLevel: "unknown"
  }]);
});

test("sanitizes long local titles and returns an unnamed fallback without metadata", () => {
  const codexDir = fs.mkdtempSync(path.join(os.tmpdir(), "switcher-sanitized-task-"));
  fs.writeFileSync(
    path.join(codexDir, "session_index.jsonl"),
    `${JSON.stringify({ id: "thread-titled", thread_name: `  标题\n${"很长".repeat(50)}  ` })}\n`,
    "utf8"
  );
  writeRollout(codexDir, "rollout-titled.jsonl", activeRollout("thread-titled"));
  writeRollout(codexDir, "rollout-unnamed.jsonl", activeRollout("thread-unnamed"));

  const status = inspectCodexTaskActivity(codexDir, new Map());
  const titled = status.activeTasks.find((task) => task.id === "thread-titled");
  const unnamed = status.activeTasks.find((task) => task.id === "thread-unnamed");

  assert.equal(titled.displayName.length, 80);
  assert.doesNotMatch(titled.displayName, /[\r\n]/);
  assert.deepEqual(unnamed, { id: "thread-unnamed", displayName: "", nameSource: "unnamed", activityLevel: "unknown" });
});

test("falls back to workspace name and start time without reading message content", () => {
  const codexDir = fs.mkdtempSync(path.join(os.tmpdir(), "switcher-readable-fallback-"));
  writeRollout(codexDir, "rollout-a.jsonl", [
    sessionMeta("thread-a", {
      cwd: "D:\\Projects\\Switcher Demo",
      timestamp: "2026-07-14T06:07:00.000Z"
    }),
    JSON.stringify({ type: "user_message", payload: { message: "这是不应被读取成标题的正文" } }),
    event("task_started", "2026-07-14T06:07:01.000Z")
  ]);

  const status = inspectCodexTaskActivity(codexDir, new Map(), {
    nowMs: Date.parse("2026-07-14T06:07:02.000Z")
  });

  const expected = "Switcher Demo · 2026-07-14 14:07 北京时间";
  assert.equal(status.activeTasks[0].displayName, expected);
  assert.equal(status.activeTasks[0].nameSource, "workspace");
  assert.doesNotMatch(status.activeTasks[0].displayName, /不应被读取/);
});

test("deduplicates multiple active rollout files for one logical task", () => {
  const codexDir = fs.mkdtempSync(path.join(os.tmpdir(), "switcher-deduplicated-task-"));
  fs.writeFileSync(
    path.join(codexDir, "session_index.jsonl"),
    `${JSON.stringify({ id: "thread-shared", thread_name: "同一个任务" })}\n`,
    "utf8"
  );
  writeRollout(codexDir, "rollout-a.jsonl", activeRollout("thread-shared"));
  writeRollout(codexDir, "rollout-b.jsonl", activeRollout("thread-shared"));

  const status = inspectCodexTaskActivity(codexDir, new Map());

  assert.deepEqual(status.activeThreadIds, ["thread-shared"]);
  assert.equal(status.activeTasks.length, 1);
});

test("lets the newest rollout lifecycle supersede an older active duplicate", () => {
  const codexDir = fs.mkdtempSync(path.join(os.tmpdir(), "switcher-superseded-task-"));
  const older = writeRollout(codexDir, "rollout-older.jsonl", [
    sessionMeta("thread-shared"),
    event("task_started", "2026-07-14T06:00:00.000Z")
  ]);
  const newer = writeRollout(codexDir, "rollout-newer.jsonl", [
    sessionMeta("thread-shared"),
    event("task_started", "2026-07-14T06:01:00.000Z"),
    event("task_complete", "2026-07-14T06:02:00.000Z")
  ]);
  fs.utimesSync(older, new Date("2026-07-14T06:00:00.000Z"), new Date("2026-07-14T06:00:00.000Z"));
  fs.utimesSync(newer, new Date("2026-07-14T06:02:00.000Z"), new Date("2026-07-14T06:02:00.000Z"));

  const status = inspectCodexTaskActivity(codexDir, new Map(), {
    nowMs: Date.parse("2026-07-14T06:02:01.000Z")
  });

  assert.equal(status.isBusy, false);
  assert.deepEqual(status.activeTasks, []);
});

test("marks mixed active rollout IDs as incomplete when one thread is unknown", () => {
  const codexDir = fs.mkdtempSync(path.join(os.tmpdir(), "switcher-mixed-task-"));
  writeRollout(codexDir, "rollout-known.jsonl", activeRollout("thread-known"));
  writeRollout(codexDir, "rollout-unknown.jsonl", [event("task_started")]);

  const status = inspectCodexTaskActivity(codexDir, new Map());

  assert.equal(status.isBusy, true);
  assert.deepEqual(status.activeThreadIds, ["thread-known"]);
  assert.equal(status.threadIdUnavailable, true);
});

test("keeps the remaining active thread after one concurrent rollout completes", () => {
  const codexDir = fs.mkdtempSync(path.join(os.tmpdir(), "switcher-multi-task-"));
  const first = writeRollout(codexDir, "rollout-a.jsonl", activeRollout("thread-a"));
  const second = writeRollout(codexDir, "rollout-b.jsonl", activeRollout("thread-b"));
  const cache = new Map();

  assert.deepEqual(inspectCodexTaskActivity(codexDir, cache).activeThreadIds, ["thread-a", "thread-b"]);
  fs.appendFileSync(first, `${event("task_complete")}\n`, "utf8");

  const status = inspectCodexTaskActivity(codexDir, cache);

  assert.equal(status.isBusy, true);
  assert.deepEqual(status.activeThreadIds, ["thread-b"]);
  assert.equal(fs.existsSync(second), true);
});

test("keeps a cached active rollout when newer completed rollouts exceed the scan window", () => {
  const codexDir = fs.mkdtempSync(path.join(os.tmpdir(), "switcher-window-task-"));
  const activePath = writeRollout(codexDir, "rollout-active.jsonl", activeRollout("thread-old"));
  const cache = new Map();
  const baseMs = Date.now() - 20_000;
  fs.utimesSync(activePath, baseMs / 1000, baseMs / 1000);
  assert.deepEqual(inspectCodexTaskActivity(codexDir, cache).activeThreadIds, ["thread-old"]);

  for (let index = 0; index < 8; index += 1) {
    const filePath = writeRollout(codexDir, `rollout-new-${index}.jsonl`, completedRollout(`thread-complete-${index}`));
    const mtimeMs = baseMs + (index + 1) * 1_000;
    fs.utimesSync(filePath, mtimeMs / 1000, mtimeMs / 1000);
  }

  const status = inspectCodexTaskActivity(codexDir, cache);

  assert.equal(status.isBusy, true);
  assert.deepEqual(status.activeThreadIds, ["thread-old"]);
});

test("discovers an active rollout beyond the newest-file window on a cold scan", () => {
  const codexDir = fs.mkdtempSync(path.join(os.tmpdir(), "switcher-cold-scan-task-"));
  const activePath = writeRollout(codexDir, "rollout-active.jsonl", activeRollout("thread-cold"));
  const baseMs = Date.now() - 20_000;
  fs.utimesSync(activePath, baseMs / 1000, baseMs / 1000);

  for (let index = 0; index < 8; index += 1) {
    const filePath = writeRollout(codexDir, `rollout-new-${index}.jsonl`, completedRollout(`thread-complete-${index}`));
    const mtimeMs = baseMs + (index + 1) * 1_000;
    fs.utimesSync(filePath, mtimeMs / 1000, mtimeMs / 1000);
  }

  const status = inspectCodexTaskActivity(codexDir, new Map());

  assert.equal(status.isBusy, true);
  assert.deepEqual(status.activeThreadIds, ["thread-cold"]);
});

test("keeps an unmatched task start busy until task completion is appended", () => {
  const { codexDir, rollout } = fixture();
  const cache = new Map();
  fs.writeFileSync(rollout, `${sessionMeta("thread-active-1")}\n${event("task_started")}\n`, "utf8");

  const started = inspectCodexTaskActivity(codexDir, cache);
  assert.equal(started.isBusy, true);
  assert.equal(started.reason, "active_task_lifecycle");
  assert.deepEqual(started.activeThreadIds, ["thread-active-1"]);
  assert.ok(started.activityKey.includes("thread-active-1"));

  fs.appendFileSync(rollout, `${event("task_complete")}\n`, "utf8");
  const completed = inspectCodexTaskActivity(codexDir, cache);
  assert.equal(completed.isBusy, false);
  assert.equal(completed.reason, "task_lifecycle_complete");
});

test("ends an active rollout when the turn is aborted", () => {
  const codexDir = fs.mkdtempSync(path.join(os.tmpdir(), "switcher-aborted-task-"));
  writeRollout(codexDir, "rollout-aborted.jsonl", [
    ...activeRollout("thread-aborted"),
    event("turn_aborted")
  ]);

  const status = inspectCodexTaskActivity(codexDir, new Map());

  assert.equal(status.isBusy, false);
  assert.deepEqual(status.activeThreadIds, []);
});

test("does not revive a historical unmatched start when only mtime becomes recent", () => {
  const codexDir = fs.mkdtempSync(path.join(os.tmpdir(), "switcher-rewritten-task-"));
  const nowMs = Date.parse("2026-07-13T12:00:00.000Z");
  const oldTimestamp = new Date(nowMs - 25 * 60 * 60 * 1_000).toISOString();
  const rollout = writeRollout(codexDir, "rollout-rewritten.jsonl", [
    sessionMeta("thread-stale"),
    event("task_started", oldTimestamp)
  ]);
  fs.utimesSync(rollout, nowMs / 1_000, nowMs / 1_000);

  const status = inspectCodexTaskActivity(codexDir, new Map(), { nowMs });

  assert.equal(status.isBusy, false);
  assert.deepEqual(status.activeThreadIds, []);
});

test("keeps a historical unfinished rollout active on first scan when its validated process is alive", () => {
  const codexDir = fs.mkdtempSync(path.join(os.tmpdir(), "switcher-historical-live-task-"));
  const nowMs = Date.parse("2026-07-14T12:00:00.000Z");
  const activityMs = nowMs - 25 * 60 * 60 * 1_000;
  const rollout = writeRollout(codexDir, "rollout-historical-live.jsonl", [
    sessionMeta("thread-historical-live"),
    event("task_started", new Date(activityMs).toISOString())
  ]);
  fs.utimesSync(rollout, activityMs / 1_000, activityMs / 1_000);

  const status = inspectCodexTaskActivity(codexDir, new Map(), {
    nowMs,
    liveThreadIds: ["thread-historical-live"],
    orphanGraceMs: 30_000
  });

  assert.equal(status.isBusy, true);
  assert.equal(status.reason, "active_task_lifecycle");
  assert.deepEqual(status.activeThreadIds, ["thread-historical-live"]);
});

test("does not revive a historical unfinished rollout for an unknown live process", () => {
  const codexDir = fs.mkdtempSync(path.join(os.tmpdir(), "switcher-historical-unknown-task-"));
  const nowMs = Date.parse("2026-07-14T12:00:00.000Z");
  const activityMs = nowMs - 25 * 60 * 60 * 1_000;
  const rollout = writeRollout(codexDir, "rollout-historical-unknown.jsonl", [
    sessionMeta("thread-historical-unknown"),
    event("task_started", new Date(activityMs).toISOString())
  ]);
  fs.utimesSync(rollout, activityMs / 1_000, activityMs / 1_000);

  const status = inspectCodexTaskActivity(codexDir, new Map(), {
    nowMs,
    hasUnknownLiveProcess: true,
    orphanGraceMs: 30_000
  });

  assert.equal(status.isBusy, false);
  assert.deepEqual(status.activeThreadIds, []);
});

test("keeps a cold unmatched start active while official host evidence is unknown", () => {
  const codexDir = fs.mkdtempSync(path.join(os.tmpdir(), "switcher-cold-orphaned-task-"));
  const nowMs = Date.parse("2026-07-14T06:01:00.000Z");
  const activityMs = nowMs - 60_000;
  const rollout = writeRollout(codexDir, "rollout-cold-orphaned.jsonl", [
    sessionMeta("thread-cold-orphaned"),
    event("task_started", new Date(activityMs).toISOString())
  ]);
  fs.utimesSync(rollout, activityMs / 1_000, activityMs / 1_000);

  const status = inspectCodexTaskActivity(codexDir, new Map(), {
    nowMs,
    liveThreadIds: [],
    orphanGraceMs: 30_000
  });

  assert.equal(status.isBusy, true);
  assert.deepEqual(status.activeThreadIds, ["thread-cold-orphaned"]);
});

test("keeps a recent cold unmatched start within the orphan grace period", () => {
  const codexDir = fs.mkdtempSync(path.join(os.tmpdir(), "switcher-recent-cold-task-"));
  const nowMs = Date.parse("2026-07-14T06:00:10.000Z");
  const activityMs = nowMs - 10_000;
  const rollout = writeRollout(codexDir, "rollout-recent-cold.jsonl", [
    sessionMeta("thread-recent-cold"),
    event("task_started", new Date(activityMs).toISOString())
  ]);
  fs.utimesSync(rollout, activityMs / 1_000, activityMs / 1_000);

  const status = inspectCodexTaskActivity(codexDir, new Map(), {
    nowMs,
    liveThreadIds: [],
    orphanGraceMs: 30_000
  });

  assert.equal(status.isBusy, true);
  assert.deepEqual(status.activeThreadIds, ["thread-recent-cold"]);
});

test("keeps an unfinished lifecycle active through silent work on the current Codex host", () => {
  const codexDir = fs.mkdtempSync(path.join(os.tmpdir(), "switcher-silent-current-host-task-"));
  const nowMs = Date.parse("2026-07-14T06:01:00.000Z");
  const startedAtMs = nowMs - 60_000;
  const rollout = writeRollout(codexDir, "rollout-silent-current-host.jsonl", [
    sessionMeta("thread-silent-current-host"),
    event("task_started", new Date(startedAtMs).toISOString())
  ]);
  fs.utimesSync(rollout, startedAtMs / 1_000, startedAtMs / 1_000);

  const status = inspectCodexTaskActivity(codexDir, new Map(), {
    nowMs,
    liveThreadIds: [],
    officialHostState: "present",
    orphanGraceMs: 30_000
  });

  assert.equal(status.isBusy, true);
  assert.equal(status.reason, "active_task_lifecycle");
  assert.deepEqual(status.activeThreadIds, ["thread-silent-current-host"]);
});

test("retires an unfinished lifecycle after a newer verified Codex host epoch", () => {
  const codexDir = fs.mkdtempSync(path.join(os.tmpdir(), "switcher-superseded-host-task-"));
  const nowMs = Date.parse("2026-07-14T06:01:00.000Z");
  const startedAtMs = nowMs - 10_000;
  writeRollout(codexDir, "rollout-superseded-host.jsonl", [
    sessionMeta("thread-superseded-host"),
    event("task_started", new Date(startedAtMs).toISOString())
  ]);

  const status = inspectCodexTaskActivity(codexDir, new Map(), {
    nowMs,
    officialHostState: "present",
    latestOfficialAppServerStartMs: nowMs - 5_000,
    orphanGraceMs: 30_000
  });

  assert.equal(status.isBusy, false);
  assert.deepEqual(status.activeThreadIds, []);
});

test("retires an unfinished lifecycle after verified Codex host disappearance", () => {
  const codexDir = fs.mkdtempSync(path.join(os.tmpdir(), "switcher-absent-host-task-"));
  const nowMs = Date.parse("2026-07-14T06:01:00.000Z");
  const startedAtMs = nowMs - 10_000;
  writeRollout(codexDir, "rollout-absent-host.jsonl", [
    sessionMeta("thread-absent-host"),
    event("task_started", new Date(startedAtMs).toISOString())
  ]);

  const status = inspectCodexTaskActivity(codexDir, new Map(), {
    nowMs,
    officialHostState: "absent",
    officialHostSnapshotRequestedAtMs: nowMs,
    orphanGraceMs: 30_000
  });

  assert.equal(status.isBusy, false);
  assert.deepEqual(status.activeThreadIds, []);
});

test("keeps a lifecycle that began after an absent host snapshot was requested", () => {
  const codexDir = fs.mkdtempSync(path.join(os.tmpdir(), "switcher-after-absent-snapshot-task-"));
  const snapshotRequestedAtMs = Date.parse("2026-07-14T06:00:00.000Z");
  const startedAtMs = snapshotRequestedAtMs + 1_000;
  writeRollout(codexDir, "rollout-after-absent-snapshot.jsonl", [
    sessionMeta("thread-after-absent-snapshot"),
    event("task_started", new Date(startedAtMs).toISOString())
  ]);

  const status = inspectCodexTaskActivity(codexDir, new Map(), {
    nowMs: startedAtMs + 1_000,
    officialHostState: "absent",
    officialHostSnapshotRequestedAtMs: snapshotRequestedAtMs,
    orphanGraceMs: 30_000
  });

  assert.equal(status.isBusy, true);
  assert.deepEqual(status.activeThreadIds, ["thread-after-absent-snapshot"]);
});

test("keeps a cached lifecycle active after rollout growth falls silent", () => {
  const { codexDir, rollout } = fixture();
  const nowMs = Date.parse("2026-07-14T06:01:00.000Z");
  const activityMs = nowMs - 60_000;
  fs.writeFileSync(rollout, `${sessionMeta("thread-growing")}\n`, "utf8");
  fs.utimesSync(rollout, activityMs / 1_000, activityMs / 1_000);
  const cache = new Map();
  inspectCodexTaskActivity(codexDir, cache, { nowMs: activityMs, orphanGraceMs: 30_000 });

  fs.appendFileSync(rollout, `${event("task_started", new Date(activityMs).toISOString())}\n`, "utf8");
  const growing = inspectCodexTaskActivity(codexDir, cache, {
    nowMs,
    liveThreadIds: [],
    orphanGraceMs: 30_000
  });
  assert.equal(growing.isBusy, true);
  assert.equal(growing.reason, "active_task_lifecycle");
  assert.deepEqual(growing.activeThreadIds, ["thread-growing"]);

  const confirming = inspectCodexTaskActivity(codexDir, cache, {
    nowMs: nowMs + 10_000,
    liveThreadIds: [],
    orphanGraceMs: 30_000
  });
  assert.equal(confirming.isBusy, true);
  assert.equal(confirming.reason, "active_task_lifecycle");
});

test("keeps activity observed in the current cache beyond the cold recovery window", () => {
  const codexDir = fs.mkdtempSync(path.join(os.tmpdir(), "switcher-long-task-"));
  const nowMs = Date.parse("2026-07-13T12:00:00.000Z");
  writeRollout(codexDir, "rollout-long.jsonl", [
    sessionMeta("thread-long"),
    event("task_started", new Date(nowMs).toISOString())
  ]);
  const cache = new Map();

  assert.equal(inspectCodexTaskActivity(codexDir, cache, { nowMs }).isBusy, true);
  const status = inspectCodexTaskActivity(codexDir, cache, { nowMs: nowMs + 25 * 60 * 60 * 1_000 });

  assert.equal(status.isBusy, true);
  assert.deepEqual(status.activeThreadIds, ["thread-long"]);
});

test("retires an unmatched task after its process disappears and the official host is verified absent", () => {
  const codexDir = fs.mkdtempSync(path.join(os.tmpdir(), "switcher-orphaned-task-"));
  const nowMs = Date.parse("2026-07-14T06:00:00.000Z");
  writeRollout(codexDir, "rollout-orphaned.jsonl", [
    sessionMeta("thread-orphaned"),
    event("task_started", new Date(nowMs).toISOString())
  ]);
  const cache = new Map();

  assert.equal(inspectCodexTaskActivity(codexDir, cache, {
    nowMs,
    liveThreadIds: ["thread-orphaned"],
    orphanGraceMs: 30_000
  }).isBusy, true);

  const confirming = inspectCodexTaskActivity(codexDir, cache, {
    nowMs: nowMs + 10_000,
    liveThreadIds: [],
    officialHostState: "present"
  });
  assert.equal(confirming.isBusy, true);
  assert.equal(confirming.reason, "active_task_lifecycle");

  const status = inspectCodexTaskActivity(codexDir, cache, {
    nowMs: nowMs + 30_001,
    liveThreadIds: [],
    officialHostState: "absent"
  });

  assert.equal(status.isBusy, false);
  assert.deepEqual(status.activeThreadIds, []);
});

test("removes an active task on the first poll after its rollout is archived", () => {
  const codexDir = fs.mkdtempSync(path.join(os.tmpdir(), "switcher-archived-task-"));
  const rolloutPath = writeRollout(codexDir, "rollout-archived.jsonl", activeRollout("thread-archived"));
  const cache = new Map();
  assert.deepEqual(inspectCodexTaskActivity(codexDir, cache).activeThreadIds, ["thread-archived"]);

  const archiveDir = path.join(codexDir, "archived_sessions");
  fs.mkdirSync(archiveDir, { recursive: true });
  fs.renameSync(rolloutPath, path.join(archiveDir, path.basename(rolloutPath)));

  const status = inspectCodexTaskActivity(codexDir, cache);
  assert.equal(status.isBusy, false);
  assert.deepEqual(status.activeThreadIds, []);
  assert.equal(cache.has(rolloutPath), false);
});

test("keeps an unchanged long-running task while its validated process is alive", () => {
  const codexDir = fs.mkdtempSync(path.join(os.tmpdir(), "switcher-live-long-task-"));
  const nowMs = Date.parse("2026-07-14T06:00:00.000Z");
  writeRollout(codexDir, "rollout-live.jsonl", [
    sessionMeta("thread-live"),
    event("task_started", new Date(nowMs).toISOString())
  ]);
  const cache = new Map();
  inspectCodexTaskActivity(codexDir, cache, { nowMs, liveThreadIds: ["thread-live"], orphanGraceMs: 30_000 });

  const status = inspectCodexTaskActivity(codexDir, cache, {
    nowMs: nowMs + 60_000,
    liveThreadIds: ["thread-live"],
    orphanGraceMs: 30_000
  });

  assert.equal(status.isBusy, true);
  assert.deepEqual(status.activeThreadIds, ["thread-live"]);
});

test("reports only the current thread among completed aborted stale and active rollouts", () => {
  const codexDir = fs.mkdtempSync(path.join(os.tmpdir(), "switcher-mixed-lifecycle-task-"));
  const nowMs = Date.parse("2026-07-13T12:00:00.000Z");
  const oldTimestamp = new Date(nowMs - 25 * 60 * 60 * 1_000).toISOString();
  writeRollout(codexDir, "rollout-complete.jsonl", completedRollout("thread-complete"));
  writeRollout(codexDir, "rollout-aborted.jsonl", [...activeRollout("thread-aborted"), event("turn_aborted")]);
  writeRollout(codexDir, "rollout-stale.jsonl", [sessionMeta("thread-stale"), event("task_started", oldTimestamp)]);
  writeRollout(codexDir, "rollout-current.jsonl", [
    sessionMeta("thread-current"),
    event("task_started", new Date(nowMs).toISOString())
  ]);

  const status = inspectCodexTaskActivity(codexDir, new Map(), { nowMs });

  assert.equal(status.isBusy, true);
  assert.deepEqual(status.activeThreadIds, ["thread-current"]);
});

test("binds an active lifecycle only to the current session in a migrated rollout", () => {
  const codexDir = fs.mkdtempSync(path.join(os.tmpdir(), "switcher-migrated-session-task-"));
  writeRollout(codexDir, "rollout-migrated.jsonl", [
    sessionMeta("thread-historical"),
    event("task_started"),
    event("task_complete"),
    sessionMeta("thread-current"),
    event("task_started")
  ]);

  const status = inspectCodexTaskActivity(codexDir, new Map());

  assert.equal(status.isBusy, true);
  assert.deepEqual(status.activeThreadIds, ["thread-current"]);
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
  assert.deepEqual(status.activeThreadIds, []);
  assert.equal(status.threadIdUnavailable, true);
});
