import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { createObservationState, setActiveAccount } from "../src/core/usage-observations.js";

const moduleUrl = new URL("../src/core/background-jobs.js", import.meta.url);
const moduleExists = fs.existsSync(moduleUrl);
const jobs = moduleExists ? await import(moduleUrl) : {};
const roots = [];

after(() => roots.forEach((root) => fs.rmSync(root, { recursive: true, force: true })));

test("background jobs module exists", () => {
  assert.equal(moduleExists, true);
});

test("report workers are serialized and expose explicit app-shutdown cleanup", () => {
  const source = fs.readFileSync(moduleUrl, "utf8");
  assert.match(source, /usageReportQueue/);
  assert.match(source, /usageReportQueue\.then/);
  assert.match(source, /activeWorkers/);
  assert.match(source, /shuttingDown/);
  assert.match(source, /export function stopBackgroundJobs\(\)/);
});

test("builds an indexed report in a worker without blocking a main-thread heartbeat", async () => {
  if (!jobs.buildUsageReportInWorker) return;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "switcher-report-worker-"));
  roots.push(root);
  const sessions = path.join(root, "sessions", "2026", "07", "15");
  fs.mkdirSync(sessions, { recursive: true });
  fs.writeFileSync(path.join(sessions, "rollout-worker.jsonl"), [
    JSON.stringify({ timestamp: "2026-07-15T01:00:00Z", type: "session_meta", payload: { id: "worker-session" } }),
    JSON.stringify({ timestamp: "2026-07-15T01:00:01Z", type: "event_msg", payload: { info: { last_token_usage: {
      input_tokens: 10, cached_input_tokens: 0, output_tokens: 2, reasoning_output_tokens: 0, total_tokens: 12
    } } } })
  ].join("\n") + "\n");
  const startMs = new Date("2026-07-15T00:00:00+08:00").getTime();
  const state = createObservationState();
  setActiveAccount(state, { accountId: "account-a", atMs: startMs, source: "test" });
  let heartbeat = false;
  setImmediate(() => { heartbeat = true; });

  const report = await jobs.buildUsageReportInWorker({
    mode: "daily",
    codexDir: root,
    cachePath: path.join(root, "usage-report-index.json"),
    state,
    accounts: [{ id: "account-a", emailMasked: "a***@test.invalid", planType: "test" }],
    startMs
  });

  assert.equal(heartbeat, true);
  assert.equal(report.accounts[0].totalTokens, 12);
  assert.equal(fs.existsSync(path.join(root, "usage-report-index.json")), true);
});

test("report worker owns observation-state reading instead of cloning it from the caller", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "switcher-report-state-worker-"));
  roots.push(root);
  fs.mkdirSync(path.join(root, "sessions"), { recursive: true });
  const observationPath = path.join(root, "usage-observations.json");
  fs.writeFileSync(observationPath, JSON.stringify(createObservationState()), "utf8");

  const report = await jobs.buildUsageReportInWorker({
    mode: "daily",
    codexDir: root,
    cachePath: path.join(root, "usage-report-index.json"),
    observationPath,
    accounts: [],
    startMs: new Date("2026-07-15T00:00:00").getTime(),
    nowMs: new Date("2026-07-15T12:00:00").getTime()
  });

  assert.equal(report.mode, "daily");
});

test("thread search and quota persistence run through background workers", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "switcher-thread-observation-worker-"));
  roots.push(root);
  fs.writeFileSync(path.join(root, "session_index.jsonl"), `${JSON.stringify({
    id: "thread-worker-search",
    thread_name: "Worker search result",
    updated_at: Date.now()
  })}\n`, "utf8");
  const observationPath = path.join(root, "usage-observations.json");
  const largeState = createObservationState();
  // Keep hourly bucket count and ordering against the second-resolution API fixed.
  const nowMs = Date.parse("2026-09-11T00:30:00.500Z");
  largeState.quotaSnapshots = Array.from({ length: 25_000 }, (_item, index) => ({
    accountId: "account-worker",
    fetchedAtMs: nowMs - index * 1_000,
    source: "test",
    fiveHour: { usedPercent: index % 100 }
  }));
  fs.writeFileSync(observationPath, JSON.stringify(largeState), "utf8");
  let heartbeat = false;
  setImmediate(() => { heartbeat = true; });

  const [threads] = await Promise.all([
    jobs.searchLocalCodexThreadsInWorker({ codexDir: root, query: "Worker search" }),
    jobs.persistQuotaObservationsInWorker({
      observationPath,
      nowMs,
      observations: [{
        accountId: "account-worker",
        usage: { fetchedAt: Math.floor(nowMs / 1000), fiveHour: { usedPercent: 10 } }
      }]
    })
  ]);

  assert.equal(heartbeat, true);
  assert.equal(threads[0].id, "thread-worker-search");
  const persisted = JSON.parse(fs.readFileSync(observationPath, "utf8")).quotaSnapshots;
  assert.equal(persisted.length, 10);
  assert.equal(persisted.some((item) => item.accountId === "account-worker" && item.fetchedAtMs === nowMs), true);
});

test("a 918-rollout thread rebuild keeps the main-thread heartbeat responsive", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "switcher-thread-worker-scale-"));
  roots.push(root);
  const rolloutDir = path.join(root, "sessions");
  fs.mkdirSync(rolloutDir, { recursive: true });
  fs.writeFileSync(path.join(root, ".codex-global-state.json"), "{}");
  const database = new DatabaseSync(path.join(root, "state_5.sqlite"));
  database.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, title TEXT, updated_at_ms INTEGER, rollout_path TEXT)");
  const insert = database.prepare("INSERT INTO threads (id, title, updated_at_ms, rollout_path) VALUES (?, ?, ?, ?)");
  database.exec("BEGIN");
  for (let index = 0; index < 918; index += 1) {
    const rolloutPath = path.join(rolloutDir, `rollout-${index}.jsonl`);
    fs.writeFileSync(rolloutPath, [
      JSON.stringify({ type: "session_meta", payload: { id: `thread-${index}` } }),
      JSON.stringify({ type: "event_msg", payload: { type: "task_complete" } })
    ].join("\n") + "\n");
    insert.run(`thread-${index}`, `Task ${index}`, index, rolloutPath);
  }
  database.exec("COMMIT");
  database.close();
  let heartbeat = false;
  setImmediate(() => { heartbeat = true; });

  const threads = await jobs.searchLocalCodexThreadsInWorker({ codexDir: root, revision: "fixture" });

  assert.equal(heartbeat, true);
  assert.equal(threads.length, 918);
});

test("builds a full lifecycle cache in a worker without blocking a main-thread heartbeat", async () => {
  assert.equal(typeof jobs.inspectCodexTaskActivityInWorker, "function");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "switcher-task-activity-worker-"));
  roots.push(root);
  const sessions = path.join(root, "sessions", "2026", "07", "15");
  fs.mkdirSync(sessions, { recursive: true });
  const startedAt = new Date(Date.now() - 20_000).toISOString();
  fs.writeFileSync(path.join(sessions, "rollout-active.jsonl"), [
    JSON.stringify({ type: "session_meta", payload: { id: "thread-worker-cold" } }),
    JSON.stringify({ type: "event_msg", timestamp: startedAt, payload: { type: "task_started" } })
  ].join("\n") + "\n");
  for (let index = 0; index < 8; index += 1) {
    fs.writeFileSync(path.join(sessions, `rollout-new-${index}.jsonl`), [
      JSON.stringify({ type: "session_meta", payload: { id: `thread-complete-${index}` } }),
      JSON.stringify({ type: "event_msg", payload: { type: "task_complete" } })
    ].join("\n") + "\n");
  }
  let heartbeat = false;
  setImmediate(() => { heartbeat = true; });

  const result = await jobs.inspectCodexTaskActivityInWorker({ codexDir: root });

  assert.equal(heartbeat, true);
  assert.ok(Array.isArray(result.cacheEntries));
  assert.ok(result.cacheEntries.some(([, state]) => state?.currentThreadId === "thread-worker-cold"));
});

test("creates and validates an encrypted conversation backup through the real worker", { skip: process.platform !== "win32" }, async () => {
  if (!jobs.createConversationBackupInWorker) return;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "switcher-backup-worker-"));
  roots.push(root);
  const codexDir = path.join(root, ".codex");
  const sessions = path.join(codexDir, "sessions", "2026", "07", "15");
  const backupRoot = path.join(root, "backup");
  fs.mkdirSync(sessions, { recursive: true });
  fs.writeFileSync(path.join(sessions, "rollout-worker.jsonl"), "synthetic worker backup\n", "utf8");

  const progress = [];
  const result = await jobs.createConversationBackupInWorker({
    codexDir,
    backupRoot,
    now: () => 1_784_064_000_000,
    onProgress: (value) => progress.push(value)
  });

  assert.equal(result.manifest.counts.activeSessions, 1);
  assert.equal(result.manifest.counts.archivedSessions, 0);
  assert.equal(fs.existsSync(result.manifestPath), true);
  assert.doesNotMatch(fs.readFileSync(result.manifestPath, "utf8"), /synthetic worker backup|rollout-worker/);
  assert.deepEqual(progress.map((value) => value.stage), [
    "discovering", "processing", "processing", "validating", "validating", "validating", "pruning", "completed"
  ]);
  for (const value of progress) {
    assert.deepEqual(Object.keys(value).sort(), Object.keys(value).filter((key) => [
      "processedBytes", "processedFiles", "stage", "totalBytes", "totalFiles"
    ].includes(key)).sort());
  }
});

test("conversation-backup progress validation rejects unknown or unsafe fields", () => {
  assert.deepEqual(jobs.normalizeConversationBackupProgress({
    stage: "processing",
    processedFiles: 1,
    totalFiles: 2,
    processedBytes: 10,
    totalBytes: 20
  }), {
    stage: "processing",
    processedFiles: 1,
    totalFiles: 2,
    processedBytes: 10,
    totalBytes: 20
  });
  assert.throws(() => jobs.normalizeConversationBackupProgress({ stage: "processing", filePath: "private.jsonl" }), /progress/i);
  assert.throws(() => jobs.normalizeConversationBackupProgress({ stage: "processing", processedFiles: -1 }), /progress/i);
});

test("recovery discovery and preview use workers with aggregate-only progress", () => {
  const source = fs.readFileSync(moduleUrl, "utf8");
  assert.match(source, /listCodexRecoveryBackupsInWorker/);
  assert.match(source, /"recovery-list",\s*\{\s*backupRoot:\s*options\.backupRoot,\s*full:\s*options\.full\s*\}/);
  assert.match(source, /revalidateQuarantinedConversationBackupInWorker/);
  assert.match(source, /previewCodexRecoveryInWorker/);
  assert.match(source, /normalizeRecoveryProgress/);
  assert.match(source, /recovery-list/);
  assert.match(source, /recovery-revalidate-quarantined-conversation/);
  assert.match(source, /recovery-preview/);
  assert.doesNotMatch(source, /normalizeRecoveryProgress[\s\S]*?(?:filePath|filename|conversationText|threadId)/);
  assert.deepEqual(jobs.normalizeRecoveryProgress({
    stage: "validating_backup", processedFiles: 1, totalFiles: 2, processedBytes: 10, totalBytes: 20
  }), {
    stage: "validating_backup", processedFiles: 1, totalFiles: 2, processedBytes: 10, totalBytes: 20
  });
  assert.deepEqual(jobs.normalizeRecoveryProgress({
    stage: "validating", processedFiles: 1, totalFiles: 2, processedBytes: 10, totalBytes: 20
  }), {
    stage: "validating", processedFiles: 1, totalFiles: 2, processedBytes: 10, totalBytes: 20
  });
  assert.throws(() => jobs.normalizeRecoveryProgress({ stage: "comparing_live", filePath: "private.jsonl" }), /progress/i);
});

test("conversation-backup cancellation stops active and queued backups without cancelling recovery work", { skip: process.platform !== "win32" }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "switcher-worker-cancel-"));
  roots.push(root);
  const codexDir = path.join(root, ".codex");
  const sessions = path.join(codexDir, "sessions", "2026", "07", "15");
  const backupRoot = path.join(root, "backup");
  fs.mkdirSync(sessions, { recursive: true });
  fs.writeFileSync(path.join(sessions, "large.jsonl"), Buffer.alloc(64 * 1024 * 1024, 7));

  const active = jobs.createConversationBackupInWorker({ codexDir, backupRoot, now: Date.now });
  const queued = jobs.createConversationBackupInWorker({ codexDir, backupRoot, now: Date.now });
  const recovery = jobs.listCodexRecoveryBackupsInWorker({ backupRoot });
  await new Promise((resolve) => setTimeout(resolve, 20));
  await jobs.cancelConversationBackupJobs();

  const backupResults = await Promise.allSettled([active, queued]);
  assert.deepEqual(backupResults.map((result) => result.status), ["rejected", "rejected"]);
  assert.deepEqual(await recovery, {
    completeRecoveryPoints: [],
    criticalGenerations: [],
    conversationGenerations: [],
    quarantinedConversationGenerations: [],
    unavailableConversationBackups: 0
  });
});

test("shutdown rejects one active and one queued report without starting another worker", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "switcher-worker-shutdown-"));
  roots.push(root);
  const sessions = path.join(root, "sessions", "2026", "07", "15");
  fs.mkdirSync(sessions, { recursive: true });
  fs.writeFileSync(path.join(sessions, "rollout-large.jsonl"), "{}\n".repeat(5_000_000), "utf8");
  const payload = {
    mode: "daily",
    codexDir: root,
    cachePath: path.join(root, "usage-report-index.json"),
    state: createObservationState(),
    accounts: [],
    startMs: new Date("2026-07-15T00:00:00").getTime()
  };

  const active = jobs.buildUsageReportInWorker(payload);
  const queued = jobs.buildUsageReportInWorker(payload);
  await new Promise((resolve) => setTimeout(resolve, 20));
  jobs.stopBackgroundJobs();
  const results = await Promise.allSettled([active, queued]);

  assert.deepEqual(results.map((result) => result.status), ["rejected", "rejected"]);
  assert.equal(fs.existsSync(payload.cachePath), false);
});
