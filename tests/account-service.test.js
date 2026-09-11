import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { createTestAccountService as createAccountService } from "./test-support.js";
import { extractAccessToken, extractAccountId, summarizeAuth } from "../src/core/auth-summary.js";
import { readCodexHttpOnlyStatus } from "../src/core/codex-config.js";
import { inspectCodexTaskActivity } from "../src/core/codex-task-activity.js";
import { protectString, unprotectString } from "../src/core/dpapi.js";
import {
  buildCodexDesktopContinuationScript,
  desktopContinuationFailureReason,
  normalizeDesktopDiscoveryDiagnostics,
  readCodexProcessRegistry
} from "../src/services/account-service.js";

const fixtureRoots = new Set();
test("blocked projection checks use async health and do not erase newer switch state", async () => {
  const { userData, codexDir } = makeFixture();
  let resolveHealth;
  let calls = 0;
  const service = createAccountService(userData, {
    codexDir,
    getCodexThreadProjectionHealth: () => { throw new Error("sync path forbidden"); },
    getCodexThreadProjectionHealthAsync: () => { calls++; return new Promise((resolve) => { resolveHealth = resolve; }); }
  });
  const blocked = { reasonCode: "codex_thread_projection_unhealthy", sourceAccountFingerprint: "test-source" };
  let state = { blocked };
  service.getAutoSwitchState = () => state;
  service.currentAuthFingerprint = () => "test-source";
  service.writeAutoSwitchState = (value) => { state = value; };
  const first = service.revalidateProjectionBlock(blocked);
  const second = service.revalidateProjectionBlock(blocked);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  state = { blocked: { ...blocked, reasonCode: "codex_thread_projection_unavailable" } };
  resolveHealth({ healthy: true, status: "healthy" });
  assert.equal(await first, false);
  assert.equal(await second, false);
  assert.equal(state.blocked.reasonCode, "codex_thread_projection_unavailable");
  const third = service.revalidateProjectionBlock(state.blocked);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 2);
  resolveHealth({ healthy: true, status: "healthy" });
  assert.equal(await third, true);
  assert.deepEqual(state, {});
});
test("new terminal evidence releases Desktop receipts without replaying old or protocol work", () => {
  const { userData, codexDir } = makeFixture();
  let nowMs = 100000;
  const service = createAccountService(userData, { codexDir, nowMs: () => nowMs });
  const decision = { status: "selected", candidateCount: 1, candidate: { threadId: "task", interruptedAtMs: 90000 } };
  const ticket = service.prepareAutoResumeAttempt(decision);
  service.finishAutoResumeTicket(ticket.attemptId, "launch_verified");
  service.finishAutoResumeTicket(ticket.attemptId, "turn_started");
  nowMs += 2000;
  service.reconcileDesktopResumeOutcomes([{ id: "task", turnState: "failed", lifecycleAtMs: 99000, resumeReason: "server_overloaded" }]);
  assert.equal(service.getAutoResumeState().stage, "turn_started");
  service.reconcileDesktopResumeOutcomes([{ id: "task", turnState: "failed", lifecycleAtMs: 101000, resumeReason: "server_overloaded" }]);
  assert.equal(service.getAutoResumeState().stage, "failed");
  assert.equal(service.getAutoResumeState().failureReason, "server_overloaded");
  const next = service.prepareAutoResumeAttempt({ status: "selected", candidateCount: 1,
    candidate: { threadId: "task", interruptedAtMs: 101000, reason: "server_overloaded" } });
  assert.equal(next.stage, "prepared");
  assert.equal(next.reason, "server_overloaded");
  assert.notEqual(next.attemptId, ticket.attemptId);
  service.finishAutoResumeTicket(next.attemptId, "launch_verified");
  service.finishAutoResumeTicket(next.attemptId, "turn_started");
  nowMs += 2000;
  service.reconcileDesktopResumeOutcomes([{ id: "task", turnState: "completed", lifecycleAtMs: 103000 }]);
  assert.equal(service.getAutoResumeState().stage, "completed");
});

test("terminal reconciliation leaves a protocol-owned running turn untouched", () => {
  const { userData, codexDir } = makeFixture();
  const service = createAccountService(userData, { codexDir, nowMs: () => 110000 });
  const state = { attemptId: "protocol", threadId: "task", interruptedAtMs: 90000,
    createdAtMs: 100000, updatedAtMs: 100000, stage: "turn_started", resumeMethod: "app_server_protocol_v1" };
  service.writeAutoResumeStateUnlocked(state);
  service.reconcileDesktopResumeOutcomes([{ id: "task", turnState: "failed", lifecycleAtMs: 105000 }]);
  assert.equal(service.getAutoResumeState().stage, "turn_started");
});

test("new active switch snapshot replaces a Desktop receipt immediately without replaying its old event", () => {
  const { userData, codexDir } = makeFixture();
  let nowMs = 100000;
  const service = createAccountService(userData, { codexDir, nowMs: () => nowMs });
  const ticket = service.prepareAutoResumeAttempt({ threadId: "task", interruptedAtMs: 90000 });
  service.finishAutoResumeTicket(ticket.attemptId, "launch_verified");
  service.finishAutoResumeTicket(ticket.attemptId, "turn_started");
  assert.equal(service.prepareAutoResumeAttempt({ threadId: "task", interruptedAtMs: 99000,
    reason: "switch_interrupted_active_thread" }).status, "needs_attention");
  nowMs += 1000;
  const next = service.prepareAutoResumeAttempt({ threadId: "task", interruptedAtMs: nowMs,
    reason: "switch_interrupted_active_thread" });
  assert.equal(next.stage, "prepared");
  assert.notEqual(next.attemptId, ticket.attemptId);
});
test("mixed failed and running Desktop receipts do not block a new switch", () => {
  const { userData, codexDir } = makeFixture();
  let nowMs = 100000;
  const service = createAccountService(userData, { codexDir, nowMs: () => nowMs });
  const queue = service.prepareAutoResumeQueue({ status: "selected", candidateCount: 2, candidates: [
    { threadId: "failed", interruptedAtMs: 90000 },
    { threadId: "running", interruptedAtMs: 91000 }
  ] });
  for (const item of queue.items) {
    service.finishAutoResumeQueueItem(queue.attemptId, item.threadId, "launch_verified");
    service.recordAutoResumeDesktopPhase(queue.attemptId, item.threadId, "invoke_started");
    service.finishAutoResumeQueueItem(queue.attemptId, item.threadId, "turn_started");
  }
  nowMs = 102000;
  service.reconcileDesktopResumeOutcomes([{ id: "failed", turnState: "failed", lifecycleAtMs: 101000, resumeReason: "server_overloaded" }]);
  const candidates = [
    { threadId: "failed", interruptedAtMs: 101000, reason: "server_overloaded" },
    { threadId: "running", interruptedAtMs: nowMs, reason: "switch_interrupted_active_thread" }
  ];
  const stale = service.prepareAutoResumeAttempt({ status: "selected", candidateCount: 2,
    candidates: [{ ...candidates[0], interruptedAtMs: 90000 }, candidates[1]] });
  assert.equal(stale.status, "needs_attention");
  const next = service.prepareAutoResumeAttempt({ status: "selected", candidateCount: 2, candidates });
  assert.equal(next.items.length, 2);
  assert.ok(next.items.every((item) => item.stage === "prepared"));
  assert.notEqual(next.attemptId, queue.attemptId);
});

test("terminal evidence before delayed prompt-consumed receipt is reconciled for tickets and queues", () => {
  for (const multi of [false, true]) {
    const { userData, codexDir } = makeFixture();
    let nowMs = 100000;
    const service = createAccountService(userData, { codexDir, nowMs: () => nowMs });
    const state = multi ? service.prepareAutoResumeQueue({ status: "selected", candidateCount: 2,
      candidates: [{ threadId: "task", interruptedAtMs: 90000 }, { threadId: "other", interruptedAtMs: 91000 }] })
      : service.prepareAutoResumeAttempt({ threadId: "task", interruptedAtMs: 90000 });
    const finish = (stage) => multi ? service.finishAutoResumeQueueItem(state.attemptId, "task", stage)
      : service.finishAutoResumeTicket(state.attemptId, stage);
    finish("launch_verified");
    service.recordAutoResumeDesktopPhase(state.attemptId, "task", "invoke_started");
    nowMs = 103000;
    assert.equal(service.recordAutoResumeDesktopPhase(state.attemptId, "task", "prompt_consumed").status, "prompt_consumed");
    finish("turn_started");
    service.reconcileDesktopResumeOutcomes([{ id: "task", turnState: "failed", lifecycleAtMs: 101000, resumeReason: "server_overloaded" }]);
    const latest = service.getAutoResumeState();
    assert.equal((multi ? latest.items[0] : latest).stage, "failed");
  }
});

test("automatic switch refreshes frozen candidates at the final switch boundary", async () => {
  const { userData, codexDir } = makeFixture();
  const service = createAccountService(userData, { codexDir, nowMs: () => 100000 });
  service.syncCurrentAuth = () => {};
  service.listAccounts = () => [{ id: "current", isCurrent: true, usage: { fiveHour: { usedPercent: 100 } } }];
  service.readSettings = () => ({ autoSwitchEnabled: true, autoResumeAfterQuotaSwitch: true });
  service.getAutoSwitchState = () => ({ pending: { accountId: "target", activityBusy: false, quietUntilMs: 90000,
    autoResumeDecision: { status: "selected", candidateCount: 1, candidate: { threadId: "now-completed", interruptedAtMs: 80000 } } } });
  service.resolveAutoSwitchTarget = async () => ({ mode: "automatic", target: { id: "target" } });
  service.getCodexActivityStatusForAutoSwitch = async () => ({ isBusy: false });
  let refreshes = 0;
  service.selectAutoResumeDecisionAsync = async () => { refreshes++; return { status: "none", candidateCount: 0 }; };
  service.completeAutoSwitch = async (_resolved, _reason, _pending, decision) => decision;
  assert.deepEqual(await service.evaluateAutoSwitch(), { status: "none", candidateCount: 0 });
  assert.equal(refreshes, 1);
});

test("restart preserves observed Desktop receipts and reconciles legacy observed receipts without sending", async () => {
  for (const multi of [false, true]) for (const legacy of [false, true]) {
    const { userData, codexDir } = makeFixture();
    let nowMs = 100000;
    const service = createAccountService(userData, { codexDir, nowMs: () => nowMs });
    const state = multi ? service.prepareAutoResumeQueue({ status: "selected", candidateCount: 2,
      candidates: [{ threadId: "task", interruptedAtMs: 90000 }, { threadId: "other", interruptedAtMs: 91000 }] })
      : service.prepareAutoResumeAttempt({ threadId: "task", interruptedAtMs: 90000 });
    for (const stage of ["launch_verified", "turn_started"]) {
      if (multi) service.finishAutoResumeQueueItem(state.attemptId, "task", stage);
      else service.finishAutoResumeTicket(state.attemptId, stage);
    }
    if (legacy) {
      const saved = service.getAutoResumeState();
      const observed = multi ? saved.items[0] : saved;
      observed.stage = "uncertain";
      observed.priorStage = "turn_started";
      service.writeAutoResumeStateUnlocked(saved);
    }
    nowMs = 103000;
    const restarted = createAccountService(userData, { codexDir, nowMs: () => nowMs,
      openCodexThread: () => { throw new Error("must not send on restart"); } });
    const restored = restarted.getAutoResumeState();
    assert.equal((multi ? restored.items[0] : restored).stage, "turn_started");
    assert.equal((multi ? restored.items[0] : restored).updatedAtMs, 100000);
    assert.deepEqual(await restarted.resumeInterruptedAutoResume(), { status: "skipped" });
    restarted.reconcileDesktopResumeOutcomes([{ id: "task", turnState: "failed", lifecycleAtMs: 102000, resumeReason: "server_overloaded" }]);
    const latest = restarted.getAutoResumeState();
    assert.equal((multi ? latest.items[0] : latest).stage, "failed");
  }
});

after(() => {
  for (const root of fixtureRoots) fs.rmSync(root, { recursive: true, force: true });
});

function makeTempRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "secure-codex-switcher-"));
  fixtureRoots.add(root);
  return root;
}

function makeFixture({ createCodexDir = true } = {}) {
  const root = makeTempRoot();
  const userData = path.join(root, "appdata");
  const codexDir = path.join(root, ".codex");
  if (createCodexDir) {
    fs.mkdirSync(codexDir, { recursive: true });
  }
  return { root, userData, codexDir };
}

test("test support isolates the default Codex directory from the real profile", () => {
  const root = makeTempRoot();
  const service = createAccountService(root);

  assert.equal(service.codexDir, path.join(root, ".codex-test"));
});

test("imports encrypted auth and switches with lightweight auth backup", { skip: process.platform !== "win32" }, async () => {
  const { userData, codexDir } = makeFixture();
  const initialAuth = {
    access_token: "a",
    refresh_token: "ra",
    account_id: "acct-a",
    plan_type: "plus"
  };
  fs.writeFileSync(path.join(codexDir, "auth.json"), JSON.stringify(initialAuth), "utf8");

  let closedCodexProcesses = 0;
  let launchedCodex = 0;
  let criticalSnapshots = 0;
  const switchOrder = [];
  const processCounts = [2, 0];
  const service = createAccountService(userData, {
    codexDir,
    verifyCodexClosure: true,
    countCodexProcesses: () => processCounts.shift() ?? 0,
    closeCodexProcesses: () => {
      closedCodexProcesses += 1;
      switchOrder.push("closed");
      return 2;
    },
    createCriticalCodexSnapshot: () => {
      criticalSnapshots += 1;
    },
    launchCodex: () => {
      launchedCodex += 1;
      switchOrder.push("launched");
      return true;
    }
  });
  const imported = service.importCurrentAuth();
  assert.equal(imported.accountId, "acct-a");
  assert.equal(imported.isCurrent, true);

  const storePath = path.join(userData, "accounts-store.json");
  const rawStore = fs.readFileSync(storePath, "utf8");
  assert.equal(rawStore.includes('"a"'), false);
  assert.equal(rawStore.includes('"ra"'), false);

  const storeWithStaleError = JSON.parse(rawStore);
  storeWithStaleError.accounts[0].usageError = "当前保存的账号登录态被用量接口拒绝（401）。";
  storeWithStaleError.accounts[0].status = "needs_login";
  fs.writeFileSync(storePath, JSON.stringify(storeWithStaleError), "utf8");

  fs.writeFileSync(path.join(codexDir, "auth.json"), JSON.stringify({ access_token: "other" }), "utf8");
  const switched = await service.switchAccountPrioritized(imported.id);
  assert.equal(switched.switchedTo.accountId, "acct-a");
  assert.equal(switched.closedCodexProcesses, 2);
  assert.equal(switched.verifiedCodexClosure, true);
  assert.equal(switched.targetUsageAuthExpired, true);
  assert.equal(switched.launchedCodex, true);
  assert.equal(closedCodexProcesses, 1);
  assert.equal(launchedCodex, 1);
  assert.match(switched.switchedTo.usageError, /账号仍可切换/);
  assert.equal(switched.switchedTo.status, "usage_auth_expired");
  assert.deepEqual(switchOrder, ["closed", "launched"]);
  assert.equal(criticalSnapshots, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(codexDir, "auth.json"), "utf8")), initialAuth);
  assert.equal(fs.existsSync(path.join(codexDir, "auth.json.bak")), false);

  const backupDir = path.join(userData, "codex-backups", "auth");
  const backups = fs.readdirSync(backupDir);
  assert.equal(backups.length, 1);
  assert.equal(backups[0].endsWith(".json.dpapi"), true);
  assert.equal(fs.readFileSync(path.join(backupDir, backups[0]), "utf8").includes("other"), false);
});

test("prioritized switching waits for conversation-backup cancellation before auth replacement and launch", { skip: process.platform !== "win32" }, async () => {
  const { userData, codexDir } = makeFixture();
  const targetAuth = { access_token: "target", account_id: "target" };
  const currentAuth = { access_token: "current", account_id: "current" };
  fs.writeFileSync(path.join(codexDir, "auth.json"), JSON.stringify(targetAuth), "utf8");
  let releaseCancellation;
  let launched = 0;
  const order = [];
  const service = createAccountService(userData, {
    codexDir,
    cancelConversationBackupJobs: () => new Promise((resolve) => {
      order.push("cancelling");
      releaseCancellation = () => {
        order.push("cancelled");
        resolve();
      };
    }),
    closeCodexProcesses: () => { order.push("closed"); return 1; },
    countCodexProcesses: () => 0,
    launchCodex: () => { launched += 1; order.push("launched"); return true; }
  });
  const target = service.importCurrentAuth();
  fs.writeFileSync(path.join(codexDir, "auth.json"), JSON.stringify(currentAuth), "utf8");

  const switching = service.switchAccountPrioritized(target.id);
  await Promise.resolve();
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(codexDir, "auth.json"), "utf8")), currentAuth);
  assert.equal(launched, 0);
  assert.deepEqual(order, ["cancelling"]);

  releaseCancellation();
  const result = await switching;
  assert.equal(result.switchedTo.accountId, "target");
  assert.deepEqual(order, ["cancelling", "cancelled", "closed", "launched"]);
});

test("account switching preserves a stable semantic thread snapshot", { skip: process.platform !== "win32" }, async () => {
  const { userData, codexDir } = makeFixture();
  const targetAuth = { access_token: "target", account_id: "target" };
  const currentAuth = { access_token: "current", account_id: "current" };
  fs.writeFileSync(path.join(codexDir, "auth.json"), JSON.stringify(targetAuth), "utf8");
  const snapshots = [];
  let launches = 0;
  const service = createAccountService(userData, {
    codexDir,
    closeCodexProcesses: () => 1,
    getCodexThreadIntegritySnapshot: () => {
      snapshots.push("read");
      return { revision: "same", threadCount: 2, activeCount: 1, archivedCount: 1 };
    },
    launchCodex: () => { launches += 1; return true; }
  });
  const target = service.importCurrentAuth();
  fs.writeFileSync(path.join(codexDir, "auth.json"), JSON.stringify(currentAuth), "utf8");

  await service.switchAccountPrioritized(target.id);

  assert.equal(snapshots.length, 3);
  assert.equal(launches, 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(codexDir, "auth.json"), "utf8")), targetAuth);
});

test("unstable thread metadata blocks switching before authentication changes", { skip: process.platform !== "win32" }, async () => {
  const { userData, codexDir } = makeFixture();
  const targetAuth = { access_token: "target", account_id: "target" };
  const currentAuth = { access_token: "current", account_id: "current" };
  fs.writeFileSync(path.join(codexDir, "auth.json"), JSON.stringify(targetAuth), "utf8");
  let reads = 0;
  let launches = 0;
  const service = createAccountService(userData, {
    codexDir,
    closeCodexProcesses: () => 1,
    getCodexThreadIntegritySnapshot: () => ({ revision: ++reads === 1 ? "before" : "changed" }),
    launchCodex: () => { launches += 1; return true; }
  });
  const target = service.importCurrentAuth();
  fs.writeFileSync(path.join(codexDir, "auth.json"), JSON.stringify(currentAuth), "utf8");

  await assert.rejects(() => service.switchAccountPrioritized(target.id), /对话状态无法稳定读取/);

  assert.equal(launches, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(codexDir, "auth.json"), "utf8")), currentAuth);
});

test("thread metadata mismatch restores exact prior authentication and does not launch", { skip: process.platform !== "win32" }, async () => {
  const { userData, codexDir } = makeFixture();
  const targetAuth = { access_token: "target", account_id: "target" };
  const currentAuthText = `${JSON.stringify({ access_token: "current", account_id: "current" }, null, 2)}\n`;
  fs.writeFileSync(path.join(codexDir, "auth.json"), JSON.stringify(targetAuth), "utf8");
  const revisions = ["stable", "stable", "mismatch"];
  let launches = 0;
  const service = createAccountService(userData, {
    codexDir,
    closeCodexProcesses: () => 1,
    getCodexThreadIntegritySnapshot: () => ({ revision: revisions.shift() }),
    launchCodex: () => { launches += 1; return true; }
  });
  const target = service.importCurrentAuth();
  fs.writeFileSync(path.join(codexDir, "auth.json"), currentAuthText, "utf8");

  await assert.rejects(() => service.switchAccountPrioritized(target.id), /对话状态完整性校验失败/);

  assert.equal(launches, 0);
  assert.equal(fs.readFileSync(path.join(codexDir, "auth.json"), "utf8"), currentAuthText);
});

test("prioritized switching holds its gate while packaged-app launch is retried and verified", { skip: process.platform !== "win32" }, async () => {
  const { userData, codexDir } = makeFixture();
  const targetAuth = { access_token: "target", account_id: "target" };
  const currentAuth = { access_token: "current", account_id: "current" };
  fs.writeFileSync(path.join(codexDir, "auth.json"), JSON.stringify(targetAuth), "utf8");
  let releaseFirstDelay;
  let signalFirstDelay;
  const firstDelay = new Promise((resolve) => { signalFirstDelay = resolve; });
  const delays = [];
  let launches = 0;
  const processCounts = [0, 0, 1];
  const service = createAccountService(userData, {
    codexDir,
    closeCodexProcesses: () => 1,
    countCodexProcessesAsync: async () => processCounts.shift() ?? 1,
    codexLaunchRetryDelaysMs: [2, 4],
    wait: (delayMs) => {
      delays.push(delayMs);
      if (delays.length > 1) return Promise.resolve();
      signalFirstDelay();
      return new Promise((resolve) => { releaseFirstDelay = resolve; });
    },
    launchCodex: () => {
      launches += 1;
      return launches > 1;
    }
  });
  const target = service.importCurrentAuth();
  fs.writeFileSync(path.join(codexDir, "auth.json"), JSON.stringify(currentAuth), "utf8");

  const switching = service.switchAccountPrioritized(target.id);
  await firstDelay;
  assert.deepEqual(await service.switchAccountPrioritized(target.id), { status: "switch_in_progress", retryable: true });
  assert.deepEqual(await service.evaluateAutoSwitch("background"), { status: "switching" });
  releaseFirstDelay();
  const result = await switching;

  assert.equal(result.launchedCodex, true);
  assert.equal(result.verifiedCodexLaunch, true);
  assert.equal(result.launchRecovered, true);
  assert.equal(launches, 2);
  assert.deepEqual(delays, [2, 4]);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(codexDir, "auth.json"), "utf8")), targetAuth);
});

test("prioritized switching never reports launch success without an official Codex process", { skip: process.platform !== "win32" }, async () => {
  const { userData, codexDir } = makeFixture();
  const targetAuth = { access_token: "target", account_id: "target" };
  fs.writeFileSync(path.join(codexDir, "auth.json"), JSON.stringify(targetAuth), "utf8");
  let launches = 0;
  const service = createAccountService(userData, {
    codexDir,
    closeCodexProcesses: () => 1,
    countCodexProcessesAsync: async () => 0,
    codexLaunchRetryDelaysMs: [0, 0],
    wait: async () => {},
    launchCodex: () => {
      launches += 1;
      return true;
    }
  });
  const target = service.importCurrentAuth();
  fs.writeFileSync(path.join(codexDir, "auth.json"), JSON.stringify({ access_token: "current", account_id: "current" }), "utf8");

  const result = await service.switchAccountPrioritized(target.id);

  assert.equal(result.launchedCodex, false);
  assert.equal(result.verifiedCodexLaunch, false);
  assert.equal(result.launchRecovered, false);
  assert.equal(launches, 2);
  assert.equal(service.switchInProgress, false);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(codexDir, "auth.json"), "utf8")), targetAuth);
});

test("backup cancellation failure leaves auth unchanged and releases the switch gate", { skip: process.platform !== "win32" }, async () => {
  const { userData, codexDir } = makeFixture();
  const targetAuth = { access_token: "target", account_id: "target" };
  const currentAuth = { access_token: "current", account_id: "current" };
  fs.writeFileSync(path.join(codexDir, "auth.json"), JSON.stringify(targetAuth), "utf8");
  let backups = 0;
  let launched = 0;
  const service = createAccountService(userData, {
    codexDir,
    cancelConversationBackupJobs: async () => { throw new Error("cancel failed"); },
    closeCodexProcesses: () => 1,
    countCodexProcesses: () => 0,
    getCodexActivityStatus: () => ({ isBusy: false }),
    launchCodex: () => { launched += 1; return true; },
    createConversationBackup: async () => { backups += 1; return { manifestPath: "after-failure" }; }
  });
  const target = service.importCurrentAuth();
  fs.writeFileSync(path.join(codexDir, "auth.json"), JSON.stringify(currentAuth), "utf8");

  await assert.rejects(() => service.switchAccountPrioritized(target.id), /cancel failed/);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(codexDir, "auth.json"), "utf8")), currentAuth);
  assert.equal(launched, 0);
  assert.equal((await service.runConversationBackup("daily-idle")).manifestPath, "after-failure");
  assert.equal(backups, 1);
});

test("switch diagnostics correlate failure without private exception text or logging interference", async () => {
  const { userData, codexDir } = makeFixture();
  const service = createAccountService(userData, { codexDir });
  const failure = Object.assign(new Error("private command and credential"), { code: "EACCES" });
  service.cancelConversationBackupJobs = async () => { throw failure; };
  const events = [];
  service.writeAutoSwitchEvent = (type, details) => events.push({ type, details });
  await assert.rejects(service.switchAccountPrioritized("unused"), (error) => error === failure);
  const phases = events.filter((event) => event.type === "switch_phase");
  const terminal = events.find((event) => event.type === "switch_finished");
  assert.deepEqual(phases.map((event) => event.details.phase), ["validating_projection", "preparing_continuation"]);
  assert.equal(terminal.details.outcome, "failed");
  assert.equal(terminal.details.phase, "preparing_continuation");
  assert.equal(terminal.details.errorCode, "EACCES");
  assert.equal(terminal.details.controllerPid, process.pid);
  assert.ok(terminal.details.attemptId);
  assert.ok(phases.every((event) => event.details.attemptId === terminal.details.attemptId));
  assert.equal(JSON.stringify(events).includes("private command"), false);
  assert.equal(service.switchInProgress, false);
  service.writeAutoSwitchEvent = () => { throw new Error("disk full"); };
  await assert.rejects(service.switchAccountPrioritized("unused"), (error) => error === failure);
  assert.equal(service.switchInProgress, false);
});

test("daily idle backup skips while prioritized switching is cancelling backup work", { skip: process.platform !== "win32" }, async () => {
  const { userData, codexDir } = makeFixture();
  const targetAuth = { access_token: "target", account_id: "target" };
  fs.writeFileSync(path.join(codexDir, "auth.json"), JSON.stringify(targetAuth), "utf8");
  let releaseCancellation;
  let backups = 0;
  const service = createAccountService(userData, {
    codexDir,
    cancelConversationBackupJobs: () => new Promise((resolve) => { releaseCancellation = resolve; }),
    closeCodexProcesses: () => 1,
    countCodexProcesses: () => 0,
    getCodexActivityStatus: () => ({ isBusy: false }),
    launchCodex: () => true,
    createConversationBackup: async () => { backups += 1; }
  });
  const target = service.importCurrentAuth();
  fs.writeFileSync(path.join(codexDir, "auth.json"), JSON.stringify({ access_token: "current", account_id: "current" }), "utf8");

  const switching = service.switchAccountPrioritized(target.id);
  await Promise.resolve();
  assert.deepEqual(await service.runConversationBackup("daily-idle"), { skipped: true, reason: "switch_in_progress" });
  assert.equal(backups, 0);
  releaseCancellation();
  await switching;
});

test("manual switch to an exhausted account preserves a full inspection countdown", { skip: process.platform !== "win32" }, async () => {
  const { userData, codexDir } = makeFixture();
  let nowMs = unixTestNow() * 1000;
  const service = createAccountService(userData, {
    codexDir,
    nowMs: () => nowMs,
    closeCodexProcesses: () => 0,
    launchCodex: () => false,
    getCodexActivityStatus: () => ({ isBusy: false, reason: "idle", activityKey: "idle" })
  });
  fs.writeFileSync(path.join(codexDir, "auth.json"), JSON.stringify({ access_token: "available", account_id: "acct-available" }), "utf8");
  const available = service.importCurrentAuth();
  fs.writeFileSync(path.join(codexDir, "auth.json"), JSON.stringify({ access_token: "exhausted", account_id: "acct-exhausted" }), "utf8");
  const exhausted = service.importCurrentAuth();
  const storePath = path.join(userData, "accounts-store.json");
  const store = JSON.parse(fs.readFileSync(storePath, "utf8"));
  for (const account of store.accounts) {
    account.status = "ready";
    const usedPercent = account.id === exhausted.id ? 100 : 20;
    account.usage = { fetchedAt: unixTestNow(), fiveHour: { usedPercent }, oneWeek: { usedPercent } };
  }
  fs.writeFileSync(storePath, JSON.stringify(store), "utf8");
  fs.writeFileSync(path.join(codexDir, "auth.json"), JSON.stringify({ access_token: "available", account_id: "acct-available" }), "utf8");
  service.updateSettings({ autoSwitchEnabled: true });

  await service.switchAccountPrioritized(exhausted.id, { manualInspection: true });

  const pending = service.getAutoSwitchState().pending;
  assert.equal(service.listAccounts().find((account) => account.isCurrent).id, exhausted.id);
  assert.equal(pending.accountId, available.id);
  assert.equal(pending.reason, "manual-switch-inspection");
  assert.equal(pending.quietUntilMs - pending.createdAtMs, 90_000);

  nowMs += 30_000;
  const waiting = await service.evaluateAutoSwitch("queued-check");
  assert.equal(waiting.status, "queued");
  assert.equal(waiting.pending.reason, "manual-switch-inspection");
  assert.equal(waiting.pending.quietUntilMs, pending.quietUntilMs);

  nowMs += 60_000;
  const switched = await service.evaluateAutoSwitch("queued-check");
  assert.equal(switched.status, "switched");
  assert.equal(switched.target.id, available.id);
  assert.deepEqual(service.getAutoSwitchState(), {});
});

test("manual inspection countdown is not created for available disabled or internal switches", { skip: process.platform !== "win32" }, async () => {
  const { userData, codexDir } = makeFixture();
  const service = createAccountService(userData, {
    codexDir,
    nowMs: () => unixTestNow() * 1000,
    closeCodexProcesses: () => 0,
    launchCodex: () => false
  });
  fs.writeFileSync(path.join(codexDir, "auth.json"), JSON.stringify({ access_token: "first", account_id: "acct-first" }), "utf8");
  const first = service.importCurrentAuth();
  fs.writeFileSync(path.join(codexDir, "auth.json"), JSON.stringify({ access_token: "second", account_id: "acct-second" }), "utf8");
  const second = service.importCurrentAuth();
  const storePath = path.join(userData, "accounts-store.json");
  const store = JSON.parse(fs.readFileSync(storePath, "utf8"));
  for (const account of store.accounts) {
    account.status = "ready";
    account.usage = { fetchedAt: unixTestNow(), fiveHour: { usedPercent: 20 }, oneWeek: { usedPercent: 20 } };
  }
  fs.writeFileSync(storePath, JSON.stringify(store), "utf8");
  fs.writeFileSync(path.join(codexDir, "auth.json"), JSON.stringify({ access_token: "first", account_id: "acct-first" }), "utf8");
  service.updateSettings({ autoSwitchEnabled: true });

  await service.switchAccountPrioritized(second.id, { manualInspection: true });
  assert.deepEqual(service.getAutoSwitchState(), {});

  const exhaustedStore = JSON.parse(fs.readFileSync(storePath, "utf8"));
  exhaustedStore.accounts.find((account) => account.id === first.id).usage.fiveHour.usedPercent = 100;
  fs.writeFileSync(storePath, JSON.stringify(exhaustedStore), "utf8");
  service.updateSettings({ autoSwitchEnabled: false });
  await service.switchAccountPrioritized(first.id, { manualInspection: true });
  assert.deepEqual(service.getAutoSwitchState(), {});

  service.updateSettings({ autoSwitchEnabled: true });
  await service.switchAccountPrioritized(second.id);
  assert.deepEqual(service.getAutoSwitchState(), {});
});

test("switching to the current account does not restart Codex", { skip: process.platform !== "win32" }, () => {
  const { userData, codexDir } = makeFixture();
  const auth = { access_token: "c", account_id: "acct-current" };
  fs.writeFileSync(path.join(codexDir, "auth.json"), JSON.stringify(auth), "utf8");

  let closedCodexProcesses = 0;
  let launchedCodex = 0;
  const service = createAccountService(userData, {
    codexDir,
    closeCodexProcesses: () => {
      closedCodexProcesses += 1;
      return 1;
    },
    launchCodex: () => {
      launchedCodex += 1;
      return true;
    }
  });
  const imported = service.importCurrentAuth();
  const switched = service.switchAccount(imported.id);

  assert.equal(switched.alreadyCurrent, true);
  assert.equal(switched.closedCodexProcesses, 0);
  assert.equal(switched.launchedCodex, false);
  assert.equal(closedCodexProcesses, 0);
  assert.equal(launchedCodex, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(codexDir, "auth.json"), "utf8")), auth);
});

test("cancels before auth replacement when official Codex remains after close", { skip: process.platform !== "win32" }, () => {
  const { userData, codexDir } = makeFixture();
  const currentAuth = { access_token: "current", account_id: "acct-current" };
  const targetAuth = { access_token: "target", account_id: "acct-target" };
  fs.writeFileSync(path.join(codexDir, "auth.json"), JSON.stringify(targetAuth), "utf8");
  const service = createAccountService(userData, {
    codexDir,
    verifyCodexClosure: true,
    countCodexProcesses: () => 1,
    closeCodexProcesses: () => 0,
    launchCodex: () => true
  });
  const target = service.importCurrentAuth();
  fs.writeFileSync(path.join(codexDir, "auth.json"), JSON.stringify(currentAuth), "utf8");
  assert.throws(() => service.switchAccount(target.id), /仍在运行/);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(codexDir, "auth.json"), "utf8")), currentAuth);
});

test("deferred auto switch does not close running Codex", { skip: process.platform !== "win32" }, () => {
  const { userData, codexDir } = makeFixture();
  const initialAuth = { access_token: "a", account_id: "acct-a" };
  const currentAuth = { access_token: "current", account_id: "acct-current" };
  fs.writeFileSync(path.join(codexDir, "auth.json"), JSON.stringify(initialAuth), "utf8");

  let closedCodexProcesses = 0;
  let launchedCodex = 0;
  const service = createAccountService(userData, {
    codexDir,
    countCodexProcesses: () => 3,
    closeCodexProcesses: () => {
      closedCodexProcesses += 1;
      return 3;
    },
    launchCodex: () => {
      launchedCodex += 1;
      return true;
    }
  });
  const imported = service.importCurrentAuth();
  fs.writeFileSync(path.join(codexDir, "auth.json"), JSON.stringify(currentAuth), "utf8");

  const result = service.switchAccount(imported.id, { deferIfCodexRunning: true });

  assert.equal(result.deferred, true);
  assert.equal(result.deferReason, "codex_running");
  assert.equal(result.runningCodexProcesses, 3);
  assert.equal(closedCodexProcesses, 0);
  assert.equal(launchedCodex, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(codexDir, "auth.json"), "utf8")), currentAuth);
});

test("counts official Codex processes without closing them", { skip: process.platform !== "win32" }, () => {
  const { userData } = makeFixture({ createCodexDir: false });
  let closedCodexProcesses = 0;
  const service = createAccountService(userData, {
    countCodexProcesses: () => 2,
    closeCodexProcesses: () => {
      closedCodexProcesses += 1;
      return 2;
    }
  });

  assert.equal(service.countOfficialCodexProcesses(), 2);
  assert.equal(closedCodexProcesses, 0);
});

test("blocks implicit real Codex process control in tests", { skip: process.platform !== "win32" }, () => {
  const { userData, codexDir } = makeFixture();
  fs.writeFileSync(path.join(codexDir, "auth.json"), JSON.stringify({ access_token: "current", account_id: "acct-current" }), "utf8");
  const service = createAccountService(userData, { codexDir });
  service.importCurrentAuth();
  fs.writeFileSync(path.join(codexDir, "auth.json"), JSON.stringify({ access_token: "target", account_id: "acct-target" }), "utf8");
  const target = service.importCurrentAuth();
  fs.writeFileSync(path.join(codexDir, "auth.json"), JSON.stringify({ access_token: "current", account_id: "acct-current" }), "utf8");

  assert.throws(() => service.switchAccount(target.id), /test isolation: real Codex process closure is disabled/);
});

test("detects active Codex chat processes", () => {
  const { userData, codexDir } = makeFixture();
  const processDir = path.join(codexDir, "process_manager");
  fs.mkdirSync(processDir, { recursive: true });
  fs.writeFileSync(
    path.join(processDir, "chat_processes.json"),
    JSON.stringify([
      { osPid: 111, conversationId: "busy" },
      { osPid: 222, conversationId: "done", updatedAtMs: 0 }
    ]),
    "utf8"
  );
  const service = createAccountService(userData, {
    codexDir,
    isProcessAlive: (pid) => pid === 111,
    getCodexProcessInfo: (pid) =>
      pid === 111
        ? { name: "Codex.exe", executablePath: "C:\\Program Files\\WindowsApps\\OpenAI.Codex_1.0.0.0_x64__2p2nqsd0c76g0\\app\\Codex.exe" }
        : { name: "node.exe", executablePath: "C:\\Tools\\node.exe" },
    nowMs: () => 1_000_000
  });

  const status = service.getCodexActivityStatus();

  assert.equal(status.isBusy, true);
  assert.equal(status.reason, "active_chat_process");
  assert.equal(status.activeProcessCount, 1);
  assert.deepEqual(status.activeThreadIds, ["busy"]);
  assert.equal(status.processRegistryDiagnostic.state, "valid");
  assert.equal(status.taskEvidenceSource, "process_registry");
  assert.equal(status.taskAssociationConfidence, "verified");
});

test("trusts live registry task identity without inventing PID ownership", () => {
  const { userData, codexDir } = makeFixture();
  const processDir = path.join(codexDir, "process_manager");
  fs.mkdirSync(processDir, { recursive: true });
  fs.writeFileSync(
    path.join(processDir, "chat_processes.json"),
    JSON.stringify([{ conversationId: "registry-thread", turnId: "turn-1", osPid: null, processId: null, updatedAtMs: 990_000 }]),
    "utf8"
  );
  fs.writeFileSync(
    path.join(codexDir, "session_index.jsonl"),
    `${JSON.stringify({ id: "registry-thread", thread_name: "实时 Registry 任务" })}\n`,
    "utf8"
  );
  const service = createAccountService(userData, { codexDir, nowMs: () => 1_000_000 });

  const status = service.getCodexActivityStatus();

  assert.equal(status.isBusy, true);
  assert.equal(status.reason, "active_registry_task");
  assert.equal(status.activeProcessCount, 0);
  assert.deepEqual(status.activeThreadIds, ["registry-thread"]);
  assert.deepEqual(status.activeTasks, [{
    id: "registry-thread",
    displayName: "实时 Registry 任务",
    nameSource: "thread_title"
  }]);
  assert.equal(status.processEvidenceSource, "none");
  assert.equal(status.taskEvidenceSource, "process_registry");
  assert.equal(status.taskAssociationConfidence, "unavailable");
  assert.equal(status.threadIdUnavailable, false);
});

test("deduplicates registry task identities and ignores rows without an identity", () => {
  const { userData, codexDir } = makeFixture();
  const processDir = path.join(codexDir, "process_manager");
  fs.mkdirSync(processDir, { recursive: true });
  fs.writeFileSync(
    path.join(processDir, "chat_processes.json"),
    JSON.stringify([
      { conversationId: " registry-thread ", osPid: null, updatedAtMs: 990_000 },
      { conversationId: "registry-thread", turnId: "ignored-turn", osPid: null, updatedAtMs: 990_000 },
      { conversationId: "", turnId: "turn-only", osPid: null, updatedAtMs: 990_000 },
      { command: "no identity", osPid: null }
    ]),
    "utf8"
  );
  const service = createAccountService(userData, { codexDir, nowMs: () => 1_000_000 });

  const status = service.getCodexActivityStatus();

  assert.deepEqual(status.activeThreadIds, ["registry-thread", "turn-only"]);
  assert.equal(status.activeProcessCount, 0);
  assert.equal(status.taskAssociationConfidence, "unavailable");
});

test("ignores stale registry identities without a live PID", () => {
  const { userData, codexDir } = makeFixture();
  const nowMs = 10_000_000;
  const staleAtMs = nowMs - 90 * 60_000;
  const processDir = path.join(codexDir, "process_manager");
  fs.mkdirSync(processDir, { recursive: true });
  fs.writeFileSync(path.join(processDir, "chat_processes.json"), JSON.stringify([
    { conversationId: "stale-null", osPid: null, processId: null, startedAtMs: staleAtMs, updatedAtMs: staleAtMs },
    { conversationId: "stale-dead", osPid: null, processId: "7001", startedAtMs: staleAtMs, updatedAtMs: staleAtMs }
  ]));
  const service = createAccountService(userData, {
    codexDir,
    nowMs: () => nowMs,
    isProcessAlive: () => false
  });

  const status = service.getCodexActivityStatus();

  assert.equal(status.isBusy, false);
  assert.deepEqual(status.activeThreadIds, []);
  assert.equal(status.processRegistryDiagnostic.ignoredStaleTaskCount, 2);
  assert.equal(status.processRegistryDiagnostic.oldestStaleEvidenceAtMs, staleAtMs);
});

test("keeps a stale registry identity only while its command PID is alive", () => {
  const { userData, codexDir } = makeFixture();
  const nowMs = 10_000_000;
  const staleAtMs = nowMs - 90 * 60_000;
  const processDir = path.join(codexDir, "process_manager");
  fs.mkdirSync(processDir, { recursive: true });
  fs.writeFileSync(path.join(processDir, "chat_processes.json"), JSON.stringify([
    { conversationId: "live-command", osPid: null, processId: "7001", startedAtMs: staleAtMs, updatedAtMs: staleAtMs },
    { conversationId: "dead-command", osPid: null, processId: "7002", startedAtMs: staleAtMs, updatedAtMs: staleAtMs }
  ]));
  const service = createAccountService(userData, {
    codexDir,
    nowMs: () => nowMs,
    isProcessAlive: (pid) => pid === 7001
  });

  const status = service.getCodexActivityStatus();

  assert.equal(status.isBusy, true);
  assert.equal(status.reason, "active_registry_task");
  assert.deepEqual(status.activeThreadIds, ["live-command"]);
  assert.equal(status.activeProcessCount, 0);
  assert.equal(status.processEvidenceSource, "none");
  assert.equal(status.taskAssociationConfidence, "unavailable");
  assert.equal(status.processRegistryDiagnostic.ignoredStaleTaskCount, 1);
});

test("aggregates active chat process and rollout thread identities", () => {
  const { userData, codexDir } = makeFixture();
  const processDir = path.join(codexDir, "process_manager");
  const sessionDir = path.join(codexDir, "sessions", "2026", "06", "13");
  fs.mkdirSync(processDir, { recursive: true });
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(
    path.join(processDir, "chat_processes.json"),
    JSON.stringify([{ osPid: 111, conversationId: "process-thread" }]),
    "utf8"
  );
  fs.writeFileSync(
    path.join(sessionDir, "rollout-thread.jsonl"),
    `${JSON.stringify({ type: "session_meta", payload: { id: "rollout-thread" } })}\n${JSON.stringify({ type: "event_msg", payload: { type: "task_started" } })}\n`,
    "utf8"
  );
  const service = createAccountService(userData, {
    codexDir,
    isProcessAlive: (pid) => pid === 111,
    getCodexProcessInfo: () => ({
      name: "Codex.exe",
      executablePath: "C:\\Program Files\\WindowsApps\\OpenAI.Codex_1.0.0.0_x64__2p2nqsd0c76g0\\app\\Codex.exe"
    }),
    nowMs: () => 1_000_000
  });

  const status = service.getCodexActivityStatus();

  assert.equal(status.isBusy, true);
  assert.equal(status.reason, "active_chat_process");
  assert.deepEqual(status.activeThreadIds, ["process-thread", "rollout-thread"]);
  assert.equal(status.threadIdUnavailable, false);
  assert.equal(status.taskEvidenceSource, "mixed");
  assert.equal(status.taskAssociationConfidence, "partial");
});

test("exposes readable active task names without replacing diagnostic IDs", () => {
  const { userData, codexDir } = makeFixture();
  const processDir = path.join(codexDir, "process_manager");
  fs.mkdirSync(processDir, { recursive: true });
  fs.writeFileSync(
    path.join(processDir, "chat_processes.json"),
    JSON.stringify([{ osPid: 111, conversationId: "thread-readable" }]),
    "utf8"
  );
  fs.writeFileSync(
    path.join(codexDir, "session_index.jsonl"),
    `${JSON.stringify({ id: "thread-readable", thread_name: "分析 Switcher 卡顿" })}\n`,
    "utf8"
  );
  const service = createAccountService(userData, {
    codexDir,
    isProcessAlive: () => true,
    getCodexProcessInfo: () => ({
      name: "Codex.exe",
      executablePath: "C:\\Program Files\\WindowsApps\\OpenAI.Codex_1.0.0.0_x64__2p2nqsd0c76g0\\app\\Codex.exe"
    }),
    nowMs: () => 1_000_000
  });

  const status = service.getCodexActivityStatus();

  assert.deepEqual(status.activeTasks, [{
    id: "thread-readable",
    displayName: "分析 Switcher 卡顿",
    nameSource: "thread_title"
  }]);
  assert.deepEqual(status.activeThreadIds, ["thread-readable"]);
});

test("searches local thread metadata through the fixed service Codex directory", async () => {
  const { userData, codexDir } = makeFixture();
  const calls = [];
  const service = createAccountService(userData, {
    codexDir,
    searchLocalCodexThreads: (...args) => {
      calls.push(args);
      return [{ id: "thread-a" }];
    }
  });

  assert.deepEqual(await service.searchLocalCodexThreads("needle"), [{ id: "thread-a" }]);
  assert.deepEqual(await service.searchLocalCodexThreads({ query: "attempt", codexDir: "C:\\not-allowed" }), [{ id: "thread-a" }]);
  assert.deepEqual(calls, [
    [codexDir, "needle", { protectedActiveThreadIds: [] }],
    [codexDir, "", { protectedActiveThreadIds: [] }]
  ]);
});

test("reuses one thread inventory per Codex metadata revision", async () => {
  const { userData, codexDir } = makeFixture();
  fs.writeFileSync(path.join(codexDir, ".codex-global-state.json"), "{}");
  const indexPath = path.join(codexDir, "session_index.jsonl");
  fs.writeFileSync(indexPath, [
    JSON.stringify({ id: "thread-alpha", thread_name: "Alpha task", updated_at: 2 }),
    JSON.stringify({ id: "thread-beta", thread_name: "Beta task", updated_at: 1 })
  ].join("\n") + "\n");
  const service = createAccountService(userData, { codexDir });

  assert.deepEqual((await service.searchLocalCodexThreads("Alpha")).map(({ id }) => id), ["thread-alpha"]);
  assert.deepEqual((await service.searchLocalCodexThreads("Beta")).map(({ id }) => id), ["thread-beta"]);

  fs.appendFileSync(indexPath, `${JSON.stringify({ id: "thread-gamma", thread_name: "Gamma task", updated_at: 3 })}\n`);
  assert.deepEqual((await service.searchLocalCodexThreads("Gamma")).map(({ id }) => id), ["thread-gamma"]);
});

test("pin-only changes remap the cached complete inventory without rereading rollout metadata", async () => {
  const { userData, codexDir } = makeFixture();
  const statePath = path.join(codexDir, ".codex-global-state.json");
  const rolloutPath = path.join(codexDir, "rollout-thread-pinned.jsonl");
  fs.writeFileSync(statePath, JSON.stringify({
    "electron-persisted-atom-state": { "unified-sidebar-pinned-order-v1": [] }
  }));
  fs.writeFileSync(rolloutPath, [
    JSON.stringify({ type: "session_meta", payload: { id: "thread-pinned" } }),
    JSON.stringify({ type: "event_msg", payload: { type: "task_complete" } })
  ].join("\n") + "\n");
  const database = new DatabaseSync(path.join(codexDir, "state_5.sqlite"));
  database.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, title TEXT, updated_at_ms INTEGER, rollout_path TEXT)");
  database.prepare("INSERT INTO threads (id, title, updated_at_ms, rollout_path) VALUES (?, ?, ?, ?)")
    .run("thread-pinned", "Pinned task", 1, rolloutPath);
  database.close();
  const service = createAccountService(userData, { codexDir });

  assert.equal((await service.searchLocalCodexThreads(""))[0].turnState, "completed");
  fs.rmSync(rolloutPath);
  fs.writeFileSync(statePath, JSON.stringify({
    "electron-persisted-atom-state": {
      "unified-sidebar-pinned-order-v1": ["codex:thread:local:thread-pinned"]
    }
  }));

  const [remapped] = await service.searchLocalCodexThreads("");
  assert.equal(remapped.pinnedIndex, 1);
  assert.equal(remapped.turnState, "completed");
});

test("reports malformed and all-zero process registries as corrupt evidence", () => {
  for (const content of ["{broken", Buffer.alloc(32)]) {
    const { userData, codexDir } = makeFixture();
    const processDir = path.join(codexDir, "process_manager");
    fs.mkdirSync(processDir, { recursive: true });
    fs.writeFileSync(path.join(processDir, "chat_processes.json"), content);
    const service = createAccountService(userData, {
      codexDir,
      isProcessAlive: () => false,
      nowMs: () => 1_000_000
    });

    const status = service.getCodexActivityStatus();

    assert.equal(status.processRegistryState, "corrupt");
  }
});

test("treats unassociated official processes as bounded diagnostics when the registry is all-zero", () => {
  const { userData, codexDir } = makeFixture();
  const processDir = path.join(codexDir, "process_manager");
  const registryPath = path.join(processDir, "chat_processes.json");
  const registryBytes = Buffer.alloc(137_242);
  fs.mkdirSync(processDir, { recursive: true });
  fs.writeFileSync(registryPath, registryBytes);
  const service = createAccountService(userData, {
    codexDir,
    countCodexProcesses: () => 10,
    nowMs: () => 1_000_000
  });

  const status = service.getCodexActivityStatus();

  assert.equal(status.isBusy, false);
  assert.equal(status.reason, "unassociated_official_process");
  assert.equal(status.activeProcessCount, 0);
  assert.equal(status.officialProcessCount, 10);
  assert.equal(status.processRegistryState, "corrupt");
  assert.equal(status.processEvidenceSource, "official_process_scan");
  assert.equal(status.taskEvidenceSource, "none");
  assert.equal(status.taskAssociationConfidence, "unavailable");
  assert.deepEqual(status.activeThreadIds, []);
  assert.deepEqual(status.activeTasks, []);
  assert.deepEqual(fs.readFileSync(registryPath), registryBytes);
});

test("marks lifecycle task names as inferred when registry association is unavailable", () => {
  const { userData, codexDir } = makeFixture();
  const processDir = path.join(codexDir, "process_manager");
  const sessionDir = path.join(codexDir, "sessions", "2026", "07", "15");
  fs.mkdirSync(processDir, { recursive: true });
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(path.join(processDir, "chat_processes.json"), Buffer.alloc(137_242));
  fs.writeFileSync(
    path.join(sessionDir, "rollout-inferred.jsonl"),
    `${JSON.stringify({ type: "session_meta", payload: { id: "thread-inferred" } })}\n${JSON.stringify({ type: "event_msg", payload: { type: "task_started" } })}\n`,
    "utf8"
  );
  fs.writeFileSync(
    path.join(codexDir, "session_index.jsonl"),
    `${JSON.stringify({ id: "thread-inferred", thread_name: "生命周期推断任务" })}\n`,
    "utf8"
  );
  const service = createAccountService(userData, {
    codexDir,
    countCodexProcesses: () => 2,
    nowMs: () => 1_000_000
  });

  const status = service.getCodexActivityStatus();

  assert.equal(status.isBusy, true);
  assert.equal(status.officialProcessCount, 2);
  assert.equal(status.processEvidenceSource, "official_process_scan");
  assert.equal(status.taskEvidenceSource, "lifecycle");
  assert.equal(status.taskAssociationConfidence, "unavailable");
  assert.equal(status.activeTasks[0].displayName, "生命周期推断任务");
});

test("inspects the official Codex host even when a valid registry has no live task PID", () => {
  const { userData, codexDir } = makeFixture();
  const nowMs = 1_000_000;
  const processDir = path.join(codexDir, "process_manager");
  const sessionDir = path.join(codexDir, "sessions", "2026", "07", "15");
  fs.mkdirSync(processDir, { recursive: true });
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(path.join(processDir, "chat_processes.json"), "[]", "utf8");
  const rolloutPath = path.join(sessionDir, "rollout-no-live-pid.jsonl");
  fs.writeFileSync(
    rolloutPath,
    `${JSON.stringify({ type: "session_meta", payload: { id: "thread-no-live-pid" } })}\n${JSON.stringify({ type: "event_msg", payload: { type: "task_started" }, timestamp: new Date(nowMs - 60_000).toISOString() })}\n`,
    "utf8"
  );
  fs.utimesSync(rolloutPath, new Date(nowMs - 60_000), new Date(nowMs - 60_000));
  let inspections = 0;
  const service = createAccountService(userData, {
    codexDir,
    nowMs: () => nowMs,
    inspectCodexProcesses: () => {
      inspections += 1;
      return { count: 2, appServerCount: 1, latestAppServerStartMs: nowMs - 120_000, inspected: true };
    }
  });

  const status = service.getCodexActivityStatus();

  assert.equal(inspections, 1);
  assert.equal(status.isBusy, true);
  assert.equal(status.reason, "active_task_lifecycle");
  assert.equal(status.officialProcessCount, 2);
  assert.equal(status.processEvidenceSource, "official_process_scan");
  assert.equal(status.processRegistryDiagnostic.latestOfficialAppServerStartMs, nowMs - 120_000);
  assert.deepEqual(status.activeThreadIds, ["thread-no-live-pid"]);
});

test("does not retire a silent lifecycle while multiple official app-server hosts coexist", () => {
  const { userData, codexDir } = makeFixture();
  const nowMs = 1_000_000;
  const processDir = path.join(codexDir, "process_manager");
  const sessionDir = path.join(codexDir, "sessions", "2026", "07", "15");
  fs.mkdirSync(processDir, { recursive: true });
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(path.join(processDir, "chat_processes.json"), "[]", "utf8");
  const rolloutPath = path.join(sessionDir, "rollout-concurrent-hosts.jsonl");
  fs.writeFileSync(
    rolloutPath,
    `${JSON.stringify({ type: "session_meta", payload: { id: "thread-concurrent-hosts" } })}\n${JSON.stringify({ type: "event_msg", payload: { type: "task_started" }, timestamp: new Date(nowMs - 60_000).toISOString() })}\n`,
    "utf8"
  );
  fs.utimesSync(rolloutPath, new Date(nowMs - 60_000), new Date(nowMs - 60_000));
  const service = createAccountService(userData, {
    codexDir,
    nowMs: () => nowMs,
    inspectCodexProcesses: () => ({
      count: 3,
      appServerCount: 2,
      latestAppServerStartMs: nowMs - 10_000,
      inspected: true
    })
  });

  const status = service.getCodexActivityStatus();

  assert.equal(status.isBusy, true);
  assert.equal(status.reason, "active_task_lifecycle");
  assert.deepEqual(status.activeThreadIds, ["thread-concurrent-hosts"]);
});

test("keeps a silent lifecycle active when official host inspection is unavailable", () => {
  const { userData, codexDir } = makeFixture();
  const nowMs = 1_000_000;
  const processDir = path.join(codexDir, "process_manager");
  const sessionDir = path.join(codexDir, "sessions", "2026", "07", "15");
  fs.mkdirSync(processDir, { recursive: true });
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(path.join(processDir, "chat_processes.json"), "[]", "utf8");
  const rolloutPath = path.join(sessionDir, "rollout-unknown-host.jsonl");
  fs.writeFileSync(
    rolloutPath,
    `${JSON.stringify({ type: "session_meta", payload: { id: "thread-unknown-host" } })}\n${JSON.stringify({ type: "event_msg", payload: { type: "task_started" }, timestamp: new Date(nowMs - 60_000).toISOString() })}\n`,
    "utf8"
  );
  fs.utimesSync(rolloutPath, new Date(nowMs - 60_000), new Date(nowMs - 60_000));
  const service = createAccountService(userData, {
    codexDir,
    nowMs: () => nowMs,
    inspectCodexProcesses: () => ({ count: 0, inspected: false })
  });

  const status = service.getCodexActivityStatus();

  assert.equal(status.isBusy, true);
  assert.equal(status.reason, "active_task_lifecycle");
  assert.deepEqual(status.activeThreadIds, ["thread-unknown-host"]);
});

test("preserves process-registry evidence in queued switch state", () => {
  const { userData, codexDir } = makeFixture();
  const service = createAccountService(userData, { codexDir });

  service.writeAutoSwitchState({
    pending: {
      accountId: "account-target",
      processRegistryState: "corrupt",
      processRegistryDiagnostic: { state: "corrupt", reason: "all_zero", lastWriteMs: 900_000 },
      officialProcessCount: 2,
      processEvidenceSource: "official_process_scan",
      taskEvidenceSource: "lifecycle",
      taskAssociationConfidence: "unavailable",
      activeTasks: [{ id: "thread-a", displayName: "可读任务", nameSource: "thread_title" }]
    }
  });

  const pending = service.getAutoSwitchState().pending;
  assert.equal(pending.processRegistryState, "corrupt");
  assert.deepEqual(pending.processRegistryDiagnostic, {
    state: "corrupt",
    reason: "all_zero",
    lastWriteMs: 900_000
  });
  assert.equal(pending.officialProcessCount, 2);
  assert.equal(pending.processEvidenceSource, "official_process_scan");
  assert.equal(pending.taskEvidenceSource, "lifecycle");
  assert.equal(pending.taskAssociationConfidence, "unavailable");
  assert.equal(pending.activeTasks[0].displayName, "可读任务");
});

test("preserves only the bounded unreadable reason in queued switch state", () => {
  const { userData, codexDir } = makeFixture();
  const service = createAccountService(userData, { codexDir });

  service.writeAutoSwitchState({
    pending: {
      accountId: "account-target",
      processRegistryState: "corrupt",
      processRegistryDiagnostic: {
        state: "corrupt",
        reason: "unreadable",
        privateError: "EACCES private registry path and account details"
      }
    }
  });

  assert.deepEqual(service.getAutoSwitchState().pending.processRegistryDiagnostic, {
    state: "corrupt",
    reason: "unreadable"
  });
});

test("preserves the bounded unstable reason in queued switch state", () => {
  const { userData, codexDir } = makeFixture();
  const service = createAccountService(userData, { codexDir });

  service.writeAutoSwitchState({
    pending: {
      accountId: "account-target",
      processRegistryState: "corrupt",
      processRegistryDiagnostic: {
        state: "corrupt",
        reason: "unstable",
        privateError: "private registry path and account details"
      }
    }
  });

  assert.deepEqual(service.getAutoSwitchState().pending.processRegistryDiagnostic, {
    state: "corrupt",
    reason: "unstable"
  });
});

test("ignores reused non-Codex chat process PIDs", () => {
  const { userData, codexDir } = makeFixture();
  const processDir = path.join(codexDir, "process_manager");
  fs.mkdirSync(processDir, { recursive: true });
  fs.writeFileSync(path.join(processDir, "chat_processes.json"), JSON.stringify([{ osPid: 111 }]), "utf8");
  const service = createAccountService(userData, {
    codexDir,
    isProcessAlive: (pid) => pid === 111,
    getCodexProcessInfo: () => ({ name: "node.exe", executablePath: "C:\\Tools\\node.exe" }),
    nowMs: () => 1_000_000
  });

  const status = service.getCodexActivityStatus();

  assert.equal(status.isBusy, false);
  assert.equal(status.reason, "idle");
  assert.equal(status.activeProcessCount, 0);
});

test("Threads activity indexing is conservative, coalesced, and reuses one official process snapshot", async () => {
  const { userData, codexDir } = makeFixture();
  const nowMs = Date.now();
  const processDir = path.join(codexDir, "process_manager");
  const sessionDir = path.join(codexDir, "sessions", "2026", "07", "15");
  fs.mkdirSync(processDir, { recursive: true });
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(path.join(processDir, "chat_processes.json"), JSON.stringify([
    { osPid: 111, conversationId: "registry-thread" }
  ]), "utf8");
  const activePath = path.join(sessionDir, "rollout-active.jsonl");
  fs.writeFileSync(activePath, [
    JSON.stringify({ type: "session_meta", payload: { id: "thread-worker-cold" } }),
    JSON.stringify({ type: "event_msg", timestamp: new Date(nowMs - 20_000).toISOString(), payload: { type: "task_started" } })
  ].join("\n") + "\n");
  fs.utimesSync(activePath, new Date(nowMs - 20_000), new Date(nowMs - 20_000));
  for (let index = 0; index < 8; index += 1) {
    const completePath = path.join(sessionDir, `rollout-new-${index}.jsonl`);
    fs.writeFileSync(completePath, [
      JSON.stringify({ type: "session_meta", payload: { id: `thread-complete-${index}` } }),
      JSON.stringify({ type: "event_msg", payload: { type: "task_complete" } })
    ].join("\n") + "\n");
    const mtimeMs = nowMs - 10_000 + index * 1_000;
    fs.utimesSync(completePath, new Date(mtimeMs), new Date(mtimeMs));
  }
  const coldCache = new Map();
  const coldStatus = inspectCodexTaskActivity(codexDir, coldCache, {
    nowMs,
    officialHostState: "present"
  });
  let releaseIndex;
  let indexCalls = 0;
  let fallbackProcessInfoCalls = 0;
  const service = createAccountService(userData, {
    codexDir,
    nowMs: () => nowMs,
    isProcessAlive: (pid) => pid === 111,
    inspectCodexProcessesForThreads: async () => ({
      count: 1,
      appServerCount: 1,
      latestAppServerStartMs: nowMs - 60_000,
      inspected: true,
      processIds: [111]
    }),
    getCodexProcessInfoForThreads: async () => {
      fallbackProcessInfoCalls += 1;
      return undefined;
    },
    indexCodexTaskActivity: () => {
      indexCalls += 1;
      return new Promise((resolve) => { releaseIndex = resolve; });
    }
  });

  const first = await service.getCodexActivityStatusForThreads();
  const second = await service.getCodexActivityStatusForThreads();

  assert.equal(first.isBusy, true);
  assert.equal(first.activityIndexing, true);
  assert.equal(indexCalls, 1);
  assert.equal(second.activityIndexing, true);
  assert.equal(fallbackProcessInfoCalls, 0);
  releaseIndex({ status: coldStatus, cacheEntries: [...coldCache] });
  await service.taskActivityIndexPromise;

  const completed = await service.getCodexActivityStatusForThreads();

  assert.equal(completed.activityIndexing, false);
  assert.deepEqual(completed.activeThreadIds, ["registry-thread", "thread-worker-cold"]);
  assert.equal(fallbackProcessInfoCalls, 0);
});

test("Threads activity starts indexing before a slow process snapshot and preserves a newer task", async () => {
  const { userData, codexDir } = makeFixture();
  const snapshotRequestedAtMs = Date.parse("2026-07-15T01:00:00.000Z");
  let nowMs = snapshotRequestedAtMs;
  const sessionDir = path.join(codexDir, "sessions", "2026", "07", "15");
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(path.join(sessionDir, "rollout-after-snapshot.jsonl"), [
    JSON.stringify({ type: "session_meta", payload: { id: "thread-after-snapshot" } }),
    JSON.stringify({
      type: "event_msg",
      timestamp: new Date(snapshotRequestedAtMs + 1_000).toISOString(),
      payload: { type: "task_started" }
    })
  ].join("\n") + "\n");
  let releaseSnapshot;
  let indexOptions;
  const service = createAccountService(userData, {
    codexDir,
    nowMs: () => nowMs,
    inspectCodexProcessesForThreads: () => new Promise((resolve) => { releaseSnapshot = resolve; }),
    indexCodexTaskActivity: (options) => {
      indexOptions = options;
      const cache = new Map();
      inspectCodexTaskActivity(codexDir, cache, options);
      return Promise.resolve({ cacheEntries: [...cache] });
    }
  });
  const firstRequest = service.getCodexActivityStatusForThreads();
  let timeoutId;
  const first = await Promise.race([
    firstRequest,
    new Promise((resolve) => { timeoutId = setTimeout(() => resolve(undefined), 100); })
  ]);
  clearTimeout(timeoutId);

  try {
    assert.ok(first);
    assert.equal(first.activityIndexing, true);
    assert.equal(indexOptions.officialHostState, "unknown");
    nowMs = snapshotRequestedAtMs + 2_000;
    releaseSnapshot({ count: 0, appServerCount: 0, inspected: true, processIds: [] });
    await service.getThreadsOfficialProcessSnapshot(nowMs);
    await service.taskActivityIndexPromise;

    const completed = await service.getCodexActivityStatusForThreads();

    assert.equal(completed.activityIndexing, false);
    assert.deepEqual(completed.activeThreadIds, ["thread-after-snapshot"]);
  } finally {
    releaseSnapshot?.({ count: 0, appServerCount: 0, inspected: true, processIds: [] });
    await firstRequest;
    await service.taskActivityIndexPromise;
  }
});

test("Threads process snapshot TTL starts after a slow inspection completes", async () => {
  const { userData, codexDir } = makeFixture();
  let nowMs = 0;
  let inspectionCalls = 0;
  let releaseFirstInspection;
  const snapshot = { count: 0, appServerCount: 0, inspected: true, processIds: [] };
  const service = createAccountService(userData, {
    codexDir,
    nowMs: () => nowMs,
    inspectCodexProcessesForThreads: () => {
      inspectionCalls += 1;
      return inspectionCalls === 1
        ? new Promise((resolve) => { releaseFirstInspection = resolve; })
        : Promise.resolve(snapshot);
    }
  });
  const firstInspection = service.getThreadsOfficialProcessSnapshot(nowMs);
  nowMs = 6_000;
  releaseFirstInspection(snapshot);
  await firstInspection;

  nowMs = 6_001;
  await service.getThreadsOfficialProcessSnapshot(nowMs);

  assert.equal(inspectionCalls, 1);
});

test("detects recent Codex session activity", () => {
  const { userData, codexDir } = makeFixture();
  const sessionDir = path.join(codexDir, "sessions", "2026", "06", "13");
  fs.mkdirSync(sessionDir, { recursive: true });
  const rolloutPath = path.join(sessionDir, "rollout-test.jsonl");
  fs.writeFileSync(rolloutPath, "{}", "utf8");
  fs.utimesSync(rolloutPath, new Date(990_000), new Date(990_000));
  const service = createAccountService(userData, {
    codexDir,
    isProcessAlive: () => false,
    nowMs: () => 1_000_000,
    activityWindowMs: 30_000
  });

  const status = service.getCodexActivityStatus();

  assert.equal(status.isBusy, true);
  assert.equal(status.reason, "recent_session_activity");
  assert.equal(status.activeProcessCount, 0);
  assert.ok(status.lastActivityAt >= 990_000);
  assert.equal(status.activitySnapshot.size, 2);
  assert.equal(status.activitySnapshot.path, rolloutPath);
});

test("keeps an unfinished rollout task busy beyond the file activity window with a validated process alive", () => {
  const { userData, codexDir } = makeFixture();
  const processDir = path.join(codexDir, "process_manager");
  const sessionDir = path.join(codexDir, "sessions", "2026", "06", "13");
  fs.mkdirSync(processDir, { recursive: true });
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(
    path.join(processDir, "chat_processes.json"),
    JSON.stringify([{ osPid: 111, conversationId: "thread-active-1" }]),
    "utf8"
  );
  const rolloutPath = path.join(sessionDir, "rollout-test.jsonl");
  fs.writeFileSync(
    rolloutPath,
    `${JSON.stringify({ type: "session_meta", payload: { id: "thread-active-1" } })}\n${JSON.stringify({ type: "event_msg", payload: { type: "task_started" } })}\n`,
    "utf8"
  );
  fs.utimesSync(rolloutPath, new Date(100_000), new Date(100_000));
  const service = createAccountService(userData, {
    codexDir,
    isProcessAlive: (pid) => pid === 111,
    getCodexProcessInfo: () => ({
      name: "Codex.exe",
      executablePath: "C:\\Program Files\\WindowsApps\\OpenAI.Codex_1.0.0.0_x64__2p2nqsd0c76g0\\app\\Codex.exe"
    }),
    nowMs: () => 1_000_000,
    activityWindowMs: 30_000
  });

  const status = service.getCodexActivityStatus();

  assert.equal(status.isBusy, true);
  assert.equal(status.reason, "active_chat_process");
  assert.deepEqual(status.activeThreadIds, ["thread-active-1"]);
});

test("exposes a bounded all-zero registry diagnostic with its last-write time", () => {
  const { userData, codexDir } = makeFixture();
  const processDir = path.join(codexDir, "process_manager");
  const registryPath = path.join(processDir, "chat_processes.json");
  fs.mkdirSync(processDir, { recursive: true });
  fs.writeFileSync(registryPath, Buffer.alloc(32));
  const registryMtimeMs = fs.statSync(registryPath).mtimeMs;
  const service = createAccountService(userData, { codexDir, nowMs: () => 1_000_000 });

  const status = service.getCodexActivityStatus();

  assert.deepEqual(status.processRegistryDiagnostic, {
    state: "corrupt",
    reason: "all_zero",
    lastWriteMs: registryMtimeMs
  });
});

test("reports an all-zero registry that predates the current official Codex app-server", () => {
  const { userData, codexDir } = makeFixture();
  const processDir = path.join(codexDir, "process_manager");
  const registryPath = path.join(processDir, "chat_processes.json");
  fs.mkdirSync(processDir, { recursive: true });
  fs.writeFileSync(registryPath, Buffer.alloc(32));
  fs.utimesSync(registryPath, 1, 1);
  const registryMtimeMs = fs.statSync(registryPath).mtimeMs;
  const service = createAccountService(userData, {
    codexDir,
    inspectCodexProcesses: () => ({ count: 2, appServerCount: 1, latestAppServerStartMs: 2_000 }),
    nowMs: () => 3_000
  });

  const status = service.getCodexActivityStatus();

  assert.deepEqual(status.processRegistryDiagnostic, {
    state: "corrupt",
    reason: "all_zero",
    lastWriteMs: registryMtimeMs,
    latestOfficialAppServerStartMs: 2_000,
    predatesAppServerStart: true
  });
  assert.equal(status.officialProcessCount, 2);
  assert.equal(status.taskAssociationConfidence, "unavailable");
  assert.deepEqual(status.activeThreadIds, []);
});

test("distinguishes a missing registry without inventing a last-write time", () => {
  const { userData, codexDir } = makeFixture();
  const service = createAccountService(userData, { codexDir, nowMs: () => 1_000_000 });

  const status = service.getCodexActivityStatus();

  assert.deepEqual(status.processRegistryDiagnostic, {
    state: "missing",
    reason: "not_found"
  });
});

test("does not infer registry age when no official app-server is running", () => {
  const { userData, codexDir } = makeFixture();
  const service = createAccountService(userData, {
    codexDir,
    inspectCodexProcesses: () => ({ count: 2, appServerCount: 0, latestAppServerStartMs: null }),
    nowMs: () => 1_000_000
  });

  const status = service.getCodexActivityStatus();

  assert.deepEqual(status.processRegistryDiagnostic, {
    state: "missing",
    reason: "not_found"
  });
  assert.equal(status.officialProcessCount, 2);
});

test("treats registry disappearance during stat or read as missing evidence", () => {
  const { userData, codexDir } = makeFixture();
  const processDir = path.join(codexDir, "process_manager");
  fs.mkdirSync(processDir, { recursive: true });
  fs.writeFileSync(path.join(processDir, "chat_processes.json"), "[]", "utf8");
  const disappeared = Object.assign(new Error("registry disappeared"), { code: "ENOENT" });
  const service = createAccountService(userData, {
    codexDir,
    readCodexProcessRegistry: () => { throw disappeared; },
    nowMs: () => 1_000_000
  });

  const status = service.getCodexActivityStatus();

  assert.deepEqual(status.processRegistryDiagnostic, {
    state: "missing",
    reason: "not_found"
  });
});

test("bounds unreadable registry errors without exposing private error text", () => {
  const { userData, codexDir } = makeFixture();
  const privateError = Object.assign(new Error("EACCES private registry path and account details"), { code: "EACCES" });
  const service = createAccountService(userData, {
    codexDir,
    readCodexProcessRegistry: () => { throw privateError; },
    nowMs: () => 1_000_000
  });

  const status = service.getCodexActivityStatus();

  assert.deepEqual(status.processRegistryDiagnostic, {
    state: "corrupt",
    reason: "unreadable"
  });
  assert.equal(JSON.stringify(status).includes(privateError.message), false);
});

test("rejects a process registry changed during one handle read and always closes the handle", () => {
  let statCalls = 0;
  let closed = false;
  const fsImpl = {
    openSync: () => 42,
    fstatSync: () => statCalls++ === 0
      ? { dev: 1, ino: 2, size: 2, mtimeMs: 100 }
      : { dev: 1, ino: 2, size: 3, mtimeMs: 200 },
    readFileSync: () => Buffer.from("[]"),
    closeSync: (fd) => { assert.equal(fd, 42); closed = true; }
  };

  assert.throws(
    () => readCodexProcessRegistry("registry.json", fsImpl),
    { code: "PROCESS_REGISTRY_UNSTABLE" }
  );
  assert.equal(closed, true);
});

test("does not compare app-server age against an unstable registry snapshot", () => {
  const { userData, codexDir } = makeFixture();
  const unstable = Object.assign(new Error("changed during read"), { code: "PROCESS_REGISTRY_UNSTABLE" });
  const service = createAccountService(userData, {
    codexDir,
    readCodexProcessRegistry: () => { throw unstable; },
    inspectCodexProcesses: () => ({ count: 2, appServerCount: 1, latestAppServerStartMs: 150 })
  });

  const status = service.getCodexActivityStatus();

  assert.deepEqual(status.processRegistryDiagnostic, {
    state: "corrupt",
    reason: "unstable",
    latestOfficialAppServerStartMs: 150
  });
  assert.equal(status.processRegistryDiagnostic.predatesAppServerStart, undefined);
});

test("reports malformed registry JSON with a bounded reason and last-write time", () => {
  const { userData, codexDir } = makeFixture();
  const processDir = path.join(codexDir, "process_manager");
  const registryPath = path.join(processDir, "chat_processes.json");
  fs.mkdirSync(processDir, { recursive: true });
  fs.writeFileSync(registryPath, "{private malformed content", "utf8");
  const registryMtimeMs = fs.statSync(registryPath).mtimeMs;
  const service = createAccountService(userData, { codexDir, nowMs: () => 1_000_000 });

  const status = service.getCodexActivityStatus();

  assert.deepEqual(status.processRegistryDiagnostic, {
    state: "corrupt",
    reason: "malformed_json",
    lastWriteMs: registryMtimeMs
  });
  assert.equal(JSON.stringify(status).includes("private malformed content"), false);
});

test("keeps recent lifecycle activity inside 30 seconds busy when no thread metadata exists", () => {
  const { userData, codexDir } = makeFixture();
  const sessionDir = path.join(codexDir, "sessions", "2026", "06", "13");
  fs.mkdirSync(sessionDir, { recursive: true });
  const rolloutPath = path.join(sessionDir, "rollout-test.jsonl");
  fs.writeFileSync(rolloutPath, `${JSON.stringify({ type: "event_msg", payload: { type: "task_started" } })}\n`, "utf8");
  fs.utimesSync(rolloutPath, new Date(990_000), new Date(990_000));
  const service = createAccountService(userData, {
    codexDir,
    isProcessAlive: () => false,
    nowMs: () => 1_000_000,
    activityWindowMs: 30_000
  });

  const status = service.getCodexActivityStatus();

  assert.equal(status.isBusy, true);
  assert.equal(status.threadIdUnavailable, true);
  assert.deepEqual(status.activeThreadIds, []);
});

test("treats stale Codex activity as idle", () => {
  const { userData, codexDir } = makeFixture();
  const processDir = path.join(codexDir, "process_manager");
  const sessionDir = path.join(codexDir, "sessions", "2026", "06", "13");
  fs.mkdirSync(processDir, { recursive: true });
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(path.join(processDir, "chat_processes.json"), JSON.stringify([{ osPid: 111 }]), "utf8");
  const rolloutPath = path.join(sessionDir, "rollout-test.jsonl");
  fs.writeFileSync(rolloutPath, "{}", "utf8");
  fs.utimesSync(rolloutPath, new Date(900_000), new Date(900_000));
  const service = createAccountService(userData, {
    codexDir,
    isProcessAlive: () => false,
    nowMs: () => 1_000_000,
    activityWindowMs: 30_000
  });

  const status = service.getCodexActivityStatus();

  assert.equal(status.isBusy, false);
  assert.equal(status.reason, "idle");
  assert.equal(status.activeProcessCount, 0);
  assert.equal(status.activitySnapshot.size, 2);
});

test("summarizes local rollout token usage by day week and month", () => {
  const { userData, codexDir } = makeFixture();
  const sessionDir = path.join(codexDir, "sessions", "2026", "06", "13");
  fs.mkdirSync(sessionDir, { recursive: true });
  const rolloutPath = path.join(sessionDir, "rollout-test.jsonl");
  const lines = [
    {
      timestamp: "2026-06-13T01:00:00.000Z",
      payload: {
        info: {
          last_token_usage: {
            input_tokens: 100,
            cached_input_tokens: 40,
            output_tokens: 20,
            reasoning_output_tokens: 5,
            total_tokens: 120
          }
        }
      }
    },
    {
      timestamp: "2026-06-10T01:00:00.000Z",
      payload: {
        info: {
          last_token_usage: {
            input_tokens: 10,
            output_tokens: 4,
            total_tokens: 14
          }
        }
      }
    },
    {
      timestamp: "2026-05-31T01:00:00.000Z",
      payload: {
        info: {
          last_token_usage: {
            input_tokens: 1000,
            output_tokens: 100,
            total_tokens: 1100
          }
        }
      }
    }
  ];
  fs.writeFileSync(rolloutPath, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`, "utf8");
  const service = createAccountService(userData, {
    codexDir,
    nowMs: () => Date.parse("2026-06-13T12:00:00.000Z")
  });

  const stats = service.getTokenUsageStats();

  assert.equal(stats.source, "local_rollout_last_token_usage");
  assert.equal(stats.countedEvents, 3);
  assert.equal(stats.totals.today.totalTokens, 120);
  assert.equal(stats.totals.today.inputTokens, 100);
  assert.equal(stats.totals.today.outputTokens, 20);
  assert.equal(stats.totals.today.reasoningOutputTokens, 5);
  assert.equal(stats.totals.sevenDays.totalTokens, 134);
  assert.equal(stats.totals.month.totalTokens, 134);
  assert.deepEqual(stats.dailySevenDays.map((day) => day.date), [
    "2026-06-07",
    "2026-06-08",
    "2026-06-09",
    "2026-06-10",
    "2026-06-11",
    "2026-06-12",
    "2026-06-13"
  ]);
  assert.equal(stats.dailySevenDays[3].totalTokens, 14);
  assert.equal(stats.dailySevenDays[6].totalTokens, 120);
});

test("summarizes local rollout token usage relative to a selected date", () => {
  const { userData, codexDir } = makeFixture();
  const sessionDir = path.join(codexDir, "sessions", "2026", "06", "13");
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(
    path.join(sessionDir, "rollout-test.jsonl"),
    `${[
      {
        timestamp: "2026-06-10T01:00:00.000Z",
        payload: { info: { last_token_usage: { input_tokens: 10, cached_input_tokens: 5, output_tokens: 2, total_tokens: 12 } } }
      },
      {
        timestamp: "2026-06-13T01:00:00.000Z",
        payload: { info: { last_token_usage: { input_tokens: 100, cached_input_tokens: 90, output_tokens: 20, total_tokens: 120 } } }
      }
    ].map((line) => JSON.stringify(line)).join("\n")}\n`,
    "utf8"
  );
  const service = createAccountService(userData, {
    codexDir,
    nowMs: () => Date.parse("2026-06-13T12:00:00.000Z")
  });

  const stats = service.getTokenUsageStats({ asOfDate: "2026-06-10" });

  assert.deepEqual(stats.dailySevenDays.map((day) => day.date), [
    "2026-06-04",
    "2026-06-05",
    "2026-06-06",
    "2026-06-07",
    "2026-06-08",
    "2026-06-09",
    "2026-06-10"
  ]);
  assert.equal(stats.totals.today.totalTokens, 12);
  assert.equal(stats.totals.sevenDays.totalTokens, 12);
  assert.equal(stats.totals.month.totalTokens, 12);
});

test("caches local rollout token usage and reads appended events incrementally", () => {
  const { userData, codexDir } = makeFixture();
  const sessionDir = path.join(codexDir, "sessions", "2026", "06", "13");
  const rolloutPath = path.join(sessionDir, "rollout-test.jsonl");
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(
    rolloutPath,
    `${JSON.stringify({
      timestamp: "2026-06-13T01:00:00.000Z",
      payload: { info: { last_token_usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } } }
    })}\n`,
    "utf8"
  );
  const service = createAccountService(userData, {
    codexDir,
    nowMs: () => Date.parse("2026-06-13T12:00:00.000Z")
  });

  const initialStats = service.getTokenUsageStats();

  assert.equal(initialStats.totals.today.totalTokens, 12);
  const cachePath = path.join(userData, "token-usage-cache.json");
  const initialCache = JSON.parse(fs.readFileSync(cachePath, "utf8"));
  assert.equal(Object.keys(initialCache.files).length, 1);
  assert.equal(initialCache.files[rolloutPath].days["2026-06-13"].totalTokens, 12);

  fs.appendFileSync(
    rolloutPath,
    `${JSON.stringify({
      timestamp: "2026-06-13T02:00:00.000Z",
      payload: { info: { last_token_usage: { input_tokens: 20, output_tokens: 4, total_tokens: 24 } } }
    })}\n`,
    "utf8"
  );

  const updatedStats = service.getTokenUsageStats();
  const updatedCache = JSON.parse(fs.readFileSync(cachePath, "utf8"));

  assert.equal(updatedStats.countedEvents, 2);
  assert.equal(updatedStats.totals.today.totalTokens, 36);
  assert.equal(updatedCache.files[rolloutPath].days["2026-06-13"].totalTokens, 36);
});

test("edge token usage is bounded by both the current account activation and official named window", async () => {
  const { userData, codexDir } = makeFixture();
  const nowMs = 1_000_000_000;
  const currentCycleStartMs = nowMs - (2 * 60 * 60 * 1_000);
  const calls = [];
  fs.mkdirSync(userData, { recursive: true });
  fs.writeFileSync(path.join(userData, "usage-observations.json"), JSON.stringify({
    version: 1,
    intervals: [
      { accountId: "account-a", startMs: nowMs - (12 * 60 * 60 * 1_000), endMs: nowMs - (10 * 60 * 60 * 1_000), source: "test" },
      { accountId: "account-b", startMs: nowMs - (10 * 60 * 60 * 1_000), endMs: currentCycleStartMs, source: "test" },
      { accountId: "account-a", startMs: currentCycleStartMs, source: "test" }
    ],
    quotaSnapshots: [],
    resetEvents: [],
    pendingResets: []
  }), "utf8");
  const service = createAccountService(userData, {
    codexDir,
    nowMs: () => nowMs,
    buildUsageReport: async (options) => {
      calls.push(options);
      return { accounts: [{ accountId: "account-a", totalTokens: 321 }] };
    }
  });
  const quota = {
    fiveHour: {
      resetAt: (nowMs + 60 * 60 * 1_000) / 1000,
      windowSeconds: 5 * 60 * 60
    },
    oneWeek: {
      resetAt: (nowMs + ((7 * 24 - 1) * 60 * 60 * 1_000)) / 1000,
      windowSeconds: 7 * 24 * 60 * 60
    }
  };

  assert.equal(await service.getEdgeTokenUsage("account-a", quota, "fiveHour"), 321);
  assert.equal(calls[0].startMs, currentCycleStartMs);
  assert.equal(await service.getEdgeTokenUsage("account-a", quota, "oneWeek"), 321);
  assert.equal(calls[1].startMs, nowMs - (60 * 60 * 1_000));

  assert.equal(await service.getEdgeTokenUsage("account-a", { fiveHour: { resetAt: quota.fiveHour.resetAt } }, "fiveHour"), undefined);
  assert.equal(calls.length, 2);

  fs.writeFileSync(path.join(userData, "usage-observations.json"), JSON.stringify({
    version: 1,
    intervals: [{ accountId: "account-b", startMs: currentCycleStartMs, source: "test" }],
    quotaSnapshots: [],
    resetEvents: [],
    pendingResets: []
  }), "utf8");
  assert.equal(await service.getEdgeTokenUsage("account-a", quota, "fiveHour"), undefined);
  assert.equal(calls.length, 2);
});

test("account switching still reopens Codex when HTTP-only config repair fails", { skip: process.platform !== "win32" }, () => {
  const { userData, codexDir } = makeFixture();
  fs.mkdirSync(userData, { recursive: true });
  fs.writeFileSync(path.join(codexDir, "auth.json"), JSON.stringify({ access_token: "a", account_id: "acct-a" }), "utf8");
  fs.writeFileSync(
    path.join(codexDir, "config.toml"),
    '[model_providers.secure_codex_switcher_http]\nwire_api = "responses"\n',
    "utf8"
  );
  fs.writeFileSync(path.join(userData, "settings.json"), JSON.stringify({ httpOnlyModeEnabled: true }), "utf8");

  let launchedCodex = 0;
  const service = createAccountService(userData, {
    codexDir,
    closeCodexProcesses: () => 1,
    launchCodex: () => {
      launchedCodex += 1;
      return true;
    }
  });
  const imported = service.importCurrentAuth();
  fs.writeFileSync(path.join(codexDir, "auth.json"), JSON.stringify({ access_token: "b", account_id: "acct-b" }), "utf8");

  const result = service.switchAccount(imported.id);

  assert.equal(result.launchedCodex, true);
  assert.equal(launchedCodex, 1);
  assert.match(result.transportWarning, /already defines model provider/);
});

test("switching accounts applies each account HTTP-only preference", { skip: process.platform !== "win32" }, () => {
  const { userData, codexDir } = makeFixture();

  fs.writeFileSync(path.join(codexDir, "auth.json"), JSON.stringify({ access_token: "a", account_id: "acct-a" }), "utf8");
  const service = createAccountService(userData, {
    codexDir,
    closeCodexProcesses: () => 0,
    launchCodex: () => false
  });
  const accountA = service.importCurrentAuth();
  service.setAccountHttpOnlyMode(accountA.id, true);
  assert.equal(readCodexHttpOnlyStatus(path.join(codexDir, "config.toml")).enabled, true);

  fs.writeFileSync(path.join(codexDir, "auth.json"), JSON.stringify({ access_token: "b", account_id: "acct-b" }), "utf8");
  const accountB = service.importCurrentAuth();
  service.setAccountHttpOnlyMode(accountB.id, false);
  assert.equal(readCodexHttpOnlyStatus(path.join(codexDir, "config.toml")).enabled, false);

  service.switchAccount(accountA.id);
  assert.equal(readCodexHttpOnlyStatus(path.join(codexDir, "config.toml")).enabled, true);

  service.switchAccount(accountB.id);
  assert.equal(readCodexHttpOnlyStatus(path.join(codexDir, "config.toml")).enabled, false);
  const accounts = service.listAccounts();
  assert.equal(accounts.find((account) => account.id === accountA.id)?.httpOnlyModeEnabled, true);
  assert.equal(accounts.find((account) => account.id === accountB.id)?.httpOnlyModeEnabled, false);
});

test("disable-GPU launch preference defaults off and accounts inherit or override it", { skip: process.platform !== "win32" }, () => {
  const { userData, codexDir } = makeFixture();
  fs.writeFileSync(path.join(codexDir, "auth.json"), JSON.stringify({ access_token: "a", account_id: "acct-a" }), "utf8");
  const service = createAccountService(userData, {
    codexDir,
    closeCodexProcesses: () => 0,
    launchCodex: () => false
  });
  const account = service.importCurrentAuth();

  assert.equal(service.readSettings().disableGpuModeEnabled, false);
  assert.equal(service.listAccounts()[0].disableGpuModeEnabled, false);
  assert.equal(service.listAccounts()[0].disableGpuModeOverride, false);

  service.setDisableGpuMode(true);
  assert.equal(service.listAccounts()[0].disableGpuModeEnabled, true);
  assert.equal(service.listAccounts()[0].disableGpuModeOverride, false);

  service.setAccountDisableGpuMode(account.id, false);
  assert.equal(service.listAccounts()[0].disableGpuModeEnabled, false);
  assert.equal(service.listAccounts()[0].disableGpuModeOverride, true);
});

test("account switching launches Codex with each target account disable-GPU preference", { skip: process.platform !== "win32" }, () => {
  const { userData, codexDir } = makeFixture();
  const authA = { access_token: "a", account_id: "acct-a" };
  const authB = { access_token: "b", account_id: "acct-b" };
  fs.writeFileSync(path.join(codexDir, "auth.json"), JSON.stringify(authA), "utf8");
  const launches = [];
  const service = createAccountService(userData, {
    codexDir,
    closeCodexProcesses: () => 0,
    launchCodex: (options) => {
      launches.push(options);
      return true;
    }
  });
  const accountA = service.importCurrentAuth();
  service.setAccountDisableGpuMode(accountA.id, true);
  fs.writeFileSync(path.join(codexDir, "auth.json"), JSON.stringify(authB), "utf8");
  const accountB = service.importCurrentAuth();
  service.setAccountDisableGpuMode(accountB.id, false);

  service.switchAccount(accountA.id);
  service.switchAccount(accountB.id);

  assert.deepEqual(launches, [{ disableGpu: true }, { disableGpu: false }]);
});

test("disable-GPU edits restart only the current account with its effective preference", { skip: process.platform !== "win32" }, () => {
  const { userData, codexDir } = makeFixture();
  const authA = { access_token: "a", account_id: "acct-a" };
  const authB = { access_token: "b", account_id: "acct-b" };
  fs.writeFileSync(path.join(codexDir, "auth.json"), JSON.stringify(authA), "utf8");
  let closes = 0;
  const launches = [];
  const service = createAccountService(userData, {
    codexDir,
    closeCodexProcesses: () => {
      closes += 1;
      return 1;
    },
    launchCodex: (options) => {
      launches.push(options);
      return true;
    }
  });
  const accountA = service.importCurrentAuth();
  fs.writeFileSync(path.join(codexDir, "auth.json"), JSON.stringify(authB), "utf8");
  const accountB = service.importCurrentAuth();
  fs.writeFileSync(path.join(codexDir, "auth.json"), JSON.stringify(authA), "utf8");

  const nonCurrent = service.setAccountDisableGpuMode(accountB.id, true);
  assert.equal(nonCurrent.closedCodexProcesses, 0);
  assert.equal(closes, 0);
  assert.deepEqual(launches, []);

  const current = service.setAccountDisableGpuMode(accountA.id, true);
  assert.equal(current.closedCodexProcesses, 1);
  assert.equal(current.launchedCodex, true);
  assert.equal(closes, 1);
  assert.deepEqual(launches, [{ disableGpu: true }]);
});

test("failed current-account disable-GPU relaunch rolls back the saved preference", { skip: process.platform !== "win32" }, () => {
  const { userData, codexDir } = makeFixture();
  fs.writeFileSync(path.join(codexDir, "auth.json"), JSON.stringify({ access_token: "a", account_id: "acct-a" }), "utf8");
  const launches = [];
  const service = createAccountService(userData, {
    codexDir,
    closeCodexProcesses: () => 1,
    launchCodex: (options) => {
      launches.push(options);
      return launches.length > 1;
    }
  });
  const account = service.importCurrentAuth();

  assert.throws(() => service.setAccountDisableGpuMode(account.id, true), /无法按新的 GPU 设置重新启动/);
  const unchanged = service.listAccounts()[0];
  assert.equal(unchanged.disableGpuModeEnabled, false);
  assert.equal(unchanged.disableGpuModeOverride, false);
  assert.deepEqual(launches, [{ disableGpu: true }, { disableGpu: false }]);
});

test("supports nested Codex tokens auth format", { skip: process.platform !== "win32" }, async () => {
  const { userData, codexDir } = makeFixture();
  const nestedAuth = {
    auth_mode: "chatgpt",
    OPENAI_API_KEY: null,
    tokens: {
      id_token: "id.b.sig",
      access_token: "b",
      refresh_token: "rb",
      account_id: "acct-b"
    },
    last_refresh: "2026-06-10T19:50:57.000Z"
  };
  fs.writeFileSync(path.join(codexDir, "auth.json"), JSON.stringify(nestedAuth), "utf8");

  const summary = summarizeAuth(nestedAuth);
  assert.equal(summary.accountId, "acct-b");
  assert.equal(summary.hasAccessToken, true);
  assert.equal(summary.hasRefreshToken, true);
  assert.equal(extractAccessToken(nestedAuth), "b");
  assert.equal(extractAccountId(nestedAuth), "acct-b");

  const service = createAccountService(userData, {
    codexDir,
    fetchImpl: async () =>
      new Response(
        JSON.stringify({
          plan_type: "plus",
          rate_limit: {
            primary_window: {
              used_percent: 20,
              limit_window_seconds: 18_000,
              reset_at: 1_800_000_000
            },
            secondary_window: {
              used_percent: 30,
              limit_window_seconds: 604_800,
              reset_at: 1_800_604_800
            }
          }
        }),
        { headers: { "content-type": "application/json" } }
      )
  });
  const imported = service.importCurrentAuth();
  assert.equal(imported.accountId, "acct-b");
  assert.equal(imported.isCurrent, true);
  assert.equal(imported.usageError, undefined);
  assert.equal(imported.planType, "unknown");
  const staleStore = service.readStore();
  staleStore.accounts[0].status = "usage_auth_expired";
  staleStore.accounts[0].usageError = "用量认证已过期（401），账号仍可切换";
  service.writeStore(staleStore);
  await service.refreshUsage(imported.id, true);
  const refreshed = service.listAccounts()[0];
  assert.equal(refreshed.planType, "plus");
  assert.equal(refreshed.status, "ready");
  assert.equal(refreshed.usageError, undefined);

  const rawStore = fs.readFileSync(path.join(userData, "accounts-store.json"), "utf8");
  assert.equal(rawStore.includes('"b"'), false);
  assert.equal(rawStore.includes('"rb"'), false);
});

test("fills missing legacy settings with safe defaults", { skip: process.platform !== "win32" }, () => {
  const root = makeTempRoot();
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(
    path.join(root, "settings.json"),
    JSON.stringify({
      autoSwitchEnabled: true,
      requireSwitchConfirmation: true,
      lowQuotaWarningEnabled: true
    }),
    "utf8"
  );

  const service = createAccountService(root);
  const settings = service.readSettings();
  assert.equal(settings.lowQuotaThresholdPercent, 15);
  assert.equal(settings.autoSwitchEnabled, true);
  assert.equal(settings.autoResumeAfterQuotaSwitch, false);
  assert.equal(settings.uiLanguage, "zh-CN");
  assert.equal(settings.closeBehavior, "ask");
  assert.equal(settings.themeMode, "system");
  assert.equal(settings.httpOnlyModeEnabled, false);
  assert.equal(settings.accountListPanePercent, 46);
  assert.equal(settings.usageRefreshIntervalMinutes, 5);
  assert.equal(settings.edgeWindowDocked, true);
  assert.equal(settings.edgeWindowX, 0);
  assert.equal(settings.edgeWindowAutoHide, false);

  const updated = service.updateSettings({
    uiLanguage: "en",
    closeBehavior: "minimize",
    themeMode: "dark",
    autoResumeAfterQuotaSwitch: true,
    accountListPanePercent: 20,
    usageRefreshIntervalMinutes: 0
  });
  assert.equal(updated.uiLanguage, "en");
  assert.equal(updated.closeBehavior, "minimize");
  assert.equal(updated.themeMode, "dark");
  assert.equal(updated.autoResumeAfterQuotaSwitch, true);
  assert.equal(updated.accountListPanePercent, 28);
  assert.equal(updated.usageRefreshIntervalMinutes, 1);
  assert.equal(service.readSettings().uiLanguage, "en");
  assert.equal(service.readSettings().autoResumeAfterQuotaSwitch, true);

  const tray = service.updateSettings({ closeBehavior: "tray", themeMode: "light", accountListPanePercent: 90, usageRefreshIntervalMinutes: 99 });
  assert.equal(tray.closeBehavior, "tray");
  assert.equal(tray.themeMode, "light");
  assert.equal(tray.accountListPanePercent, 68);
  assert.equal(tray.usageRefreshIntervalMinutes, 60);

  const clamped = service.updateSettings({ closeBehavior: "quit", themeMode: "light", accountListPanePercent: 90, usageRefreshIntervalMinutes: 99 });
  assert.equal(clamped.closeBehavior, "quit");
  assert.equal(clamped.themeMode, "light");
  assert.equal(clamped.accountListPanePercent, 68);
  assert.equal(clamped.usageRefreshIntervalMinutes, 60);

  const unchanged = service.updateSettings({ closeBehavior: "invalid", themeMode: "invalid", accountListPanePercent: 52, usageRefreshIntervalMinutes: 10 });
  assert.equal(unchanged.closeBehavior, "quit");
  assert.equal(unchanged.themeMode, "light");
  assert.equal(unchanged.accountListPanePercent, 52);
  assert.equal(unchanged.usageRefreshIntervalMinutes, 10);
  assert.equal(unchanged.autoSwitchTargetMode, "best");
  assert.equal(unchanged.manualAutoSwitchTargetAccountId, undefined);
});

test("stores manual auto-switch target preference", { skip: process.platform !== "win32" }, () => {
  const { userData, codexDir } = makeFixture();
  fs.writeFileSync(path.join(codexDir, "auth.json"), JSON.stringify({ access_token: "a", account_id: "acct-a" }), "utf8");
  const service = createAccountService(userData, { codexDir });
  const current = service.importCurrentAuth();
  fs.writeFileSync(path.join(codexDir, "auth.json"), JSON.stringify({ access_token: "b", account_id: "acct-b" }), "utf8");
  const target = service.importCurrentAuth();
  fs.writeFileSync(path.join(codexDir, "auth.json"), JSON.stringify({ access_token: "a", account_id: "acct-a" }), "utf8");

  const updated = service.setAutoSwitchTarget(target.id);

  assert.equal(updated.autoSwitchTargetMode, "manual");
  assert.equal(updated.manualAutoSwitchTargetAccountId, target.id);
  assert.deepEqual(service.readAutoSwitchTargetPreference(), {
    mode: "manual",
    accountId: target.id
  });

  const cleared = service.clearAutoSwitchTarget();
  assert.equal(cleared.autoSwitchTargetMode, "best");
  assert.equal(cleared.manualAutoSwitchTargetAccountId, undefined);
  assert.equal(service.listAccounts().some((account) => account.id === current.id), true);
});

test("rejects the current account as a manual auto-switch target", { skip: process.platform !== "win32" }, () => {
  const { userData, codexDir } = makeFixture();
  fs.writeFileSync(path.join(codexDir, "auth.json"), JSON.stringify({ access_token: "a", account_id: "acct-a" }), "utf8");
  const service = createAccountService(userData, { codexDir });
  const current = service.importCurrentAuth();

  assert.throws(() => service.setAutoSwitchTarget(current.id), /当前账号/);
  assert.deepEqual(service.readAutoSwitchTargetPreference(), { mode: "best", accountId: undefined });
});

test("stores and exposes one-time automatic-switch exclusions", { skip: process.platform !== "win32" }, () => {
  const { userData, codexDir } = makeFixture();
  const service = createAccountService(userData, { codexDir });
  fs.writeFileSync(path.join(codexDir, "auth.json"), JSON.stringify({ access_token: "current", account_id: "acct-current" }), "utf8");
  service.importCurrentAuth();
  fs.writeFileSync(path.join(codexDir, "auth.json"), JSON.stringify({ access_token: "target", account_id: "acct-target" }), "utf8");
  const target = service.importCurrentAuth();
  fs.writeFileSync(path.join(codexDir, "auth.json"), JSON.stringify({ access_token: "current", account_id: "acct-current" }), "utf8");

  const updated = service.setAutoSwitchExcluded(target.id, true);

  assert.deepEqual(updated.autoSwitchExcludedAccountIds, [target.id]);
  assert.equal(service.listAccounts().find((account) => account.id === target.id).isAutoSwitchExcluded, true);
  assert.deepEqual(service.readSettings().autoSwitchExcludedAccountIds, [target.id]);

  const cleared = service.setAutoSwitchExcluded(target.id, false);
  assert.deepEqual(cleared.autoSwitchExcludedAccountIds, []);
});

test("skips excluded accounts when selecting the best automatic candidate", { skip: process.platform !== "win32" }, () => {
  const { userData, codexDir } = makeFixture();
  const service = createAccountService(userData, { codexDir, nowMs: () => unixTestNow() * 1000 });
  fs.writeFileSync(path.join(codexDir, "auth.json"), JSON.stringify({ access_token: "current", account_id: "acct-current" }), "utf8");
  const current = service.importCurrentAuth();
  fs.writeFileSync(path.join(codexDir, "auth.json"), JSON.stringify({ access_token: "best", account_id: "acct-best" }), "utf8");
  const best = service.importCurrentAuth();
  fs.writeFileSync(path.join(codexDir, "auth.json"), JSON.stringify({ access_token: "alternate", account_id: "acct-alternate" }), "utf8");
  const alternate = service.importCurrentAuth();
  const storePath = path.join(userData, "accounts-store.json");
  const store = JSON.parse(fs.readFileSync(storePath, "utf8"));
  for (const account of store.accounts) {
    account.status = "ready";
    account.usage = account.id === best.id
      ? { fetchedAt: unixTestNow(), fiveHour: { usedPercent: 0 }, oneWeek: { usedPercent: 0 } }
      : account.id === alternate.id
        ? { fetchedAt: unixTestNow(), fiveHour: { usedPercent: 20 }, oneWeek: { usedPercent: 20 } }
        : { fetchedAt: unixTestNow(), fiveHour: { usedPercent: 40 }, oneWeek: { usedPercent: 40 } };
  }
  fs.writeFileSync(storePath, JSON.stringify(store), "utf8");
  fs.writeFileSync(path.join(codexDir, "auth.json"), JSON.stringify({ access_token: "current", account_id: "acct-current" }), "utf8");

  service.setAutoSwitchExcluded(best.id, true);

  assert.equal(service.pickBestAccount().account.id, alternate.id);
  assert.equal(service.listAccounts().find((account) => account.id === current.id).isCurrent, true);
});

test("resolves manual-target and exclusion conflicts in favor of the latest explicit action", { skip: process.platform !== "win32" }, () => {
  const { userData, codexDir } = makeFixture();
  const service = createAccountService(userData, { codexDir });
  fs.writeFileSync(path.join(codexDir, "auth.json"), JSON.stringify({ access_token: "current", account_id: "acct-current" }), "utf8");
  service.importCurrentAuth();
  fs.writeFileSync(path.join(codexDir, "auth.json"), JSON.stringify({ access_token: "target", account_id: "acct-target" }), "utf8");
  const target = service.importCurrentAuth();
  fs.writeFileSync(path.join(codexDir, "auth.json"), JSON.stringify({ access_token: "current", account_id: "acct-current" }), "utf8");

  service.setAutoSwitchTarget(target.id);
  const excluded = service.setAutoSwitchExcluded(target.id, true);
  assert.equal(excluded.autoSwitchTargetMode, "best");
  assert.deepEqual(excluded.autoSwitchExcludedAccountIds, [target.id]);

  const manual = service.setAutoSwitchTarget(target.id);
  assert.equal(manual.autoSwitchTargetMode, "manual");
  assert.deepEqual(manual.autoSwitchExcludedAccountIds, []);
});

test("normalizes and deduplicates automatic-switch exclusions", { skip: process.platform !== "win32" }, () => {
  const { userData, codexDir } = makeFixture();
  const service = createAccountService(userData, { codexDir });

  const settings = service.updateSettings({
    autoSwitchExcludedAccountIds: [" account-a ", "account-a", "", "   ", null, 42, "account-b"]
  });

  assert.deepEqual(settings.autoSwitchExcludedAccountIds, ["account-a", "account-b"]);
  assert.deepEqual(service.readSettings().autoSwitchExcludedAccountIds, ["account-a", "account-b"]);
});

test("revalidates a queued manual target after it becomes excluded", { skip: process.platform !== "win32" }, async () => {
  const { userData, codexDir } = makeFixture();
  const service = createAccountService(userData, {
    codexDir,
    nowMs: () => unixTestNow() * 1000,
    getCodexProcessInfo: () => ({
      name: "ChatGPT.exe",
      executablePath: "C:\\Program Files\\WindowsApps\\OpenAI.Codex_1.0.0.0_x64__2p2nqsd0c76g0\\app\\ChatGPT.exe"
    }),
    inspectCodexProcessesForThreads: async () => ({ count: 1, inspected: true, processIds: [42] }),
    isProcessAlive: (pid) => pid === 42
  });
  fs.mkdirSync(path.join(codexDir, "process_manager"), { recursive: true });
  fs.writeFileSync(path.join(codexDir, "process_manager", "chat_processes.json"), JSON.stringify([{ osPid: 42 }]), "utf8");
  fs.writeFileSync(path.join(codexDir, "auth.json"), JSON.stringify({ access_token: "current", account_id: "acct-current" }), "utf8");
  const current = service.importCurrentAuth();
  fs.writeFileSync(path.join(codexDir, "auth.json"), JSON.stringify({ access_token: "target", account_id: "acct-target" }), "utf8");
  const target = service.importCurrentAuth();
  fs.writeFileSync(path.join(codexDir, "auth.json"), JSON.stringify({ access_token: "fallback", account_id: "acct-fallback" }), "utf8");
  const fallback = service.importCurrentAuth();
  const storePath = path.join(userData, "accounts-store.json");
  const store = JSON.parse(fs.readFileSync(storePath, "utf8"));
  for (const account of store.accounts) {
    account.status = "ready";
    account.usage = account.id === current.id
      ? { fetchedAt: unixTestNow(), fiveHour: { usedPercent: 100 }, oneWeek: { usedPercent: 20 } }
      : { fetchedAt: unixTestNow(), fiveHour: { usedPercent: 20 }, oneWeek: { usedPercent: 20 } };
  }
  fs.writeFileSync(storePath, JSON.stringify(store), "utf8");
  fs.writeFileSync(path.join(codexDir, "auth.json"), JSON.stringify({ access_token: "current", account_id: "acct-current" }), "utf8");
  service.updateSettings({ autoSwitchEnabled: true });
  service.setAutoSwitchTarget(target.id);

  const first = await service.evaluateAutoSwitch("test");
  assert.equal(first.status, "queued");
  assert.equal(first.target.id, target.id);

  service.setAutoSwitchExcluded(target.id, true);
  const revalidated = await service.evaluateAutoSwitch("test");

  assert.equal(revalidated.status, "queued");
  assert.equal(revalidated.target.id, fallback.id);
  assert.equal(service.getAutoSwitchState().pending.accountId, fallback.id);
  assert.deepEqual(service.readSettings().autoSwitchExcludedAccountIds, [target.id]);
});

test("retains exclusions while automatic switching is queued", { skip: process.platform !== "win32" }, async () => {
  const { userData, codexDir } = makeFixture();
  const service = createAccountService(userData, {
    codexDir,
    nowMs: () => unixTestNow() * 1000,
    getCodexProcessInfo: () => ({
      name: "ChatGPT.exe",
      executablePath: "C:\\Program Files\\WindowsApps\\OpenAI.Codex_1.0.0.0_x64__2p2nqsd0c76g0\\app\\ChatGPT.exe"
    }),
    inspectCodexProcessesForThreads: async () => ({ count: 1, inspected: true, processIds: [42] }),
    isProcessAlive: (pid) => pid === 42
  });
  fs.mkdirSync(path.join(codexDir, "process_manager"), { recursive: true });
  fs.writeFileSync(path.join(codexDir, "process_manager", "chat_processes.json"), JSON.stringify([{ osPid: 42 }]), "utf8");
  fs.writeFileSync(path.join(codexDir, "auth.json"), JSON.stringify({ access_token: "current", account_id: "acct-current" }), "utf8");
  const current = service.importCurrentAuth();
  fs.writeFileSync(path.join(codexDir, "auth.json"), JSON.stringify({ access_token: "target", account_id: "acct-target" }), "utf8");
  const target = service.importCurrentAuth();
  fs.writeFileSync(path.join(codexDir, "auth.json"), JSON.stringify({ access_token: "skip", account_id: "acct-skip" }), "utf8");
  const skipped = service.importCurrentAuth();
  const storePath = path.join(userData, "accounts-store.json");
  const store = JSON.parse(fs.readFileSync(storePath, "utf8"));
  for (const account of store.accounts) {
    account.status = "ready";
    account.usage = account.id === current.id
      ? { fetchedAt: unixTestNow(), fiveHour: { usedPercent: 100 }, oneWeek: { usedPercent: 20 } }
      : { fetchedAt: unixTestNow(), fiveHour: { usedPercent: 20 }, oneWeek: { usedPercent: 20 } };
  }
  fs.writeFileSync(storePath, JSON.stringify(store), "utf8");
  fs.writeFileSync(path.join(codexDir, "auth.json"), JSON.stringify({ access_token: "current", account_id: "acct-current" }), "utf8");
  service.updateSettings({ autoSwitchEnabled: true });
  service.setAutoSwitchExcluded(skipped.id, true);

  const queued = await service.evaluateAutoSwitch("test");

  assert.equal(queued.status, "queued");
  assert.equal(queued.target.id, target.id);
  assert.deepEqual(service.readSettings().autoSwitchExcludedAccountIds, [skipped.id]);
});

test("clears exclusions only after a successful automatic switch", { skip: process.platform !== "win32" }, async () => {
  const { userData, codexDir } = makeFixture();
  let cancelledBackups = 0;
  const service = createAccountService(userData, {
    codexDir,
    nowMs: () => unixTestNow() * 1000,
    cancelConversationBackupJobs: async () => { cancelledBackups += 1; },
    closeCodexProcesses: () => 0,
    launchCodex: () => false
  });
  fs.writeFileSync(path.join(codexDir, "auth.json"), JSON.stringify({ access_token: "current", account_id: "acct-current" }), "utf8");
  const current = service.importCurrentAuth();
  fs.writeFileSync(path.join(codexDir, "auth.json"), JSON.stringify({ access_token: "target", account_id: "acct-target" }), "utf8");
  const target = service.importCurrentAuth();
  fs.writeFileSync(path.join(codexDir, "auth.json"), JSON.stringify({ access_token: "skip", account_id: "acct-skip" }), "utf8");
  const skipped = service.importCurrentAuth();
  const storePath = path.join(userData, "accounts-store.json");
  const store = JSON.parse(fs.readFileSync(storePath, "utf8"));
  for (const account of store.accounts) {
    account.status = "ready";
    account.usage = account.id === current.id
      ? { fetchedAt: unixTestNow(), fiveHour: { usedPercent: 100 }, oneWeek: { usedPercent: 20 } }
      : { fetchedAt: unixTestNow(), fiveHour: { usedPercent: 20 }, oneWeek: { usedPercent: 20 } };
  }
  fs.writeFileSync(storePath, JSON.stringify(store), "utf8");
  fs.writeFileSync(path.join(codexDir, "auth.json"), JSON.stringify({ access_token: "current", account_id: "acct-current" }), "utf8");
  service.updateSettings({ autoSwitchEnabled: true });
  service.setAutoSwitchExcluded(skipped.id, true);

  const switched = await service.evaluateAutoSwitch("test");

  assert.equal(switched.status, "switched");
  assert.equal(switched.target.id, target.id);
  assert.equal(cancelledBackups, 1);
  assert.deepEqual(service.readSettings().autoSwitchExcludedAccountIds, []);
});

test("starts one resume turn after a verified automatic quota switch and records completion", { skip: process.platform !== "win32" }, async () => {
  const { userData, codexDir } = makeFixture();
  const nowMs = unixTestNow() * 1000;
  let startCalls = 0;
  let resolveCompletion;
  const completion = new Promise((resolve) => { resolveCompletion = resolve; });
  const service = createAccountService(userData, {
    codexDir,
    resumeExecutorMode: "app-server",
    nowMs: () => nowMs,
    closeCodexProcesses: () => 1,
    launchCodexAsync: async () => true,
    countCodexProcessesAsync: async () => 1,
    codexLaunchRetryDelaysMs: [0],
    wait: async () => undefined,
    getCodexActivityStatus: () => ({
      isBusy: false,
      reason: "task_lifecycle_complete",
      activeThreadIds: [],
      activeTasks: [],
      officialProcessCount: 0,
      activityKey: "idle"
    }),
    selectQuotaInterruptedThread: () => ({
      status: "selected",
      candidateCount: 1,
      candidate: { threadId: "thread-limited", interruptedAtMs: nowMs - 1_000 }
    }),
    startCodexThreadResume: ({ threadId }) => {
      startCalls += 1;
      assert.equal(threadId, "thread-limited");
      return {
        started: Promise.resolve({ started: true, turnId: "turn-resumed" }),
        completion
      };
    }
  });
  fs.writeFileSync(path.join(codexDir, "auth.json"), JSON.stringify({ access_token: "current", account_id: "acct-current" }), "utf8");
  const current = service.importCurrentAuth();
  fs.writeFileSync(path.join(codexDir, "auth.json"), JSON.stringify({ access_token: "target", account_id: "acct-target" }), "utf8");
  const target = service.importCurrentAuth();
  const storePath = path.join(userData, "accounts-store.json");
  const store = JSON.parse(fs.readFileSync(storePath, "utf8"));
  for (const account of store.accounts) {
    account.status = "ready";
    account.usage = account.id === current.id
      ? { fetchedAt: unixTestNow(), fiveHour: { usedPercent: 100 }, oneWeek: { usedPercent: 20 } }
      : { fetchedAt: unixTestNow(), fiveHour: { usedPercent: 20 }, oneWeek: { usedPercent: 20 } };
  }
  fs.writeFileSync(storePath, JSON.stringify(store), "utf8");
  fs.writeFileSync(path.join(codexDir, "auth.json"), JSON.stringify({ access_token: "current", account_id: "acct-current" }), "utf8");
  service.updateSettings({ autoSwitchEnabled: true, autoResumeAfterQuotaSwitch: true });

  const switched = await service.evaluateAutoSwitch("quota-test");

  assert.equal(switched.status, "switched");
  assert.equal(switched.target.id, target.id);
  assert.equal(switched.result.verifiedCodexLaunch, undefined);
  assert.equal(switched.result.autoResume.status, "started");
  assert.equal(startCalls, 1);
  assert.equal(service.getAutoResumeState().stage, "turn_started");

  resolveCompletion({ status: "completed", turnId: "turn-resumed" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(service.getAutoResumeState().stage, "completed");
});

test("does not resume manual switches and never retries an uncertain automatic start", { skip: process.platform !== "win32" }, async () => {
  const { userData, codexDir } = makeFixture();
  const nowMs = unixTestNow() * 1000;
  let startCalls = 0;
  const uncertain = Object.assign(new Error("transport ended"), { uncertain: true });
  const service = createAccountService(userData, {
    codexDir,
    resumeExecutorMode: "app-server",
    nowMs: () => nowMs,
    closeCodexProcesses: () => 1,
    launchCodexAsync: async () => true,
    countCodexProcessesAsync: async () => 1,
    codexLaunchRetryDelaysMs: [0],
    wait: async () => undefined,
    getCodexActivityStatus: () => ({ isBusy: false, reason: "task_lifecycle_complete", activeThreadIds: [], activeTasks: [], officialProcessCount: 0, activityKey: "idle" }),
    selectQuotaInterruptedThread: () => ({
      status: "selected",
      candidateCount: 1,
      candidate: { threadId: "thread-limited", interruptedAtMs: nowMs - 1_000 }
    }),
    startCodexThreadResume: () => {
      startCalls += 1;
      return {
        started: Promise.resolve({ started: false, outcome: "uncertain", error: uncertain }),
        completion: Promise.resolve({ status: "uncertain" })
      };
    }
  });
  fs.writeFileSync(path.join(codexDir, "auth.json"), JSON.stringify({ access_token: "current", account_id: "acct-current" }), "utf8");
  const current = service.importCurrentAuth();
  fs.writeFileSync(path.join(codexDir, "auth.json"), JSON.stringify({ access_token: "target", account_id: "acct-target" }), "utf8");
  const target = service.importCurrentAuth();
  const storePath = path.join(userData, "accounts-store.json");
  const store = JSON.parse(fs.readFileSync(storePath, "utf8"));
  for (const account of store.accounts) {
    account.status = "ready";
    account.usage = account.id === current.id
      ? { fetchedAt: unixTestNow(), fiveHour: { usedPercent: 100 }, oneWeek: { usedPercent: 20 } }
      : { fetchedAt: unixTestNow(), fiveHour: { usedPercent: 20 }, oneWeek: { usedPercent: 20 } };
  }
  fs.writeFileSync(storePath, JSON.stringify(store), "utf8");
  fs.writeFileSync(path.join(codexDir, "auth.json"), JSON.stringify({ access_token: "current", account_id: "acct-current" }), "utf8");
  service.updateSettings({ autoSwitchEnabled: true, autoResumeAfterQuotaSwitch: true });

  const switched = await service.evaluateAutoSwitch("quota-test");
  assert.equal(switched.result.autoResume.status, "uncertain");
  assert.equal(service.getAutoResumeState().stage, "uncertain");
  assert.equal(startCalls, 1);

  await service.switchAccountPrioritized(current.id);
  assert.equal(startCalls, 1);
});

test("does not record a pre-invocation Desktop failure as started", { skip: process.platform !== "win32" }, async () => {
  const { userData, codexDir } = makeFixture();
  const nowMs = unixTestNow() * 1000;
  const operation = Promise.resolve(false);
  operation.failureReason = "composer_not_found";
  const service = createAccountService(userData, {
    codexDir,
    nowMs: () => nowMs,
    openCodexThread: () => operation
  });
  const ticket = service.prepareAutoResumeTicket({ threadId: "thread-limited", interruptedAtMs: nowMs - 1_000 });

  assert.deepEqual(await service.startPreparedAutoResume(ticket), { status: "failed" });
  assert.equal(service.getAutoResumeState().stage, "failed");
  assert.deepEqual(service.finishAutoResumeTicket(ticket.attemptId, "turn_started"), { status: "skipped" });
  assert.equal(service.getAutoResumeState().stage, "failed");
});

test("retains exclusions when no automatic target exists", { skip: process.platform !== "win32" }, async () => {
  const { userData, codexDir } = makeFixture();
  const service = createAccountService(userData, { codexDir, nowMs: () => unixTestNow() * 1000 });
  fs.writeFileSync(path.join(codexDir, "auth.json"), JSON.stringify({ access_token: "current", account_id: "acct-current" }), "utf8");
  const current = service.importCurrentAuth();
  fs.writeFileSync(path.join(codexDir, "auth.json"), JSON.stringify({ access_token: "target", account_id: "acct-target" }), "utf8");
  const target = service.importCurrentAuth();
  const storePath = path.join(userData, "accounts-store.json");
  const store = JSON.parse(fs.readFileSync(storePath, "utf8"));
  for (const account of store.accounts) {
    account.status = "ready";
    account.usage = account.id === current.id
      ? { fetchedAt: unixTestNow(), fiveHour: { usedPercent: 100 }, oneWeek: { usedPercent: 20 } }
      : { fetchedAt: unixTestNow(), fiveHour: { usedPercent: 20 }, oneWeek: { usedPercent: 20 } };
  }
  fs.writeFileSync(storePath, JSON.stringify(store), "utf8");
  fs.writeFileSync(path.join(codexDir, "auth.json"), JSON.stringify({ access_token: "current", account_id: "acct-current" }), "utf8");
  service.updateSettings({ autoSwitchEnabled: true });
  service.setAutoSwitchExcluded(target.id, true);

  const result = await service.evaluateAutoSwitch("test");

  assert.equal(result.status, "target_unavailable");
  assert.deepEqual(service.readSettings().autoSwitchExcludedAccountIds, [target.id]);
});

test("retains exclusions when the automatic switch fails", { skip: process.platform !== "win32" }, async () => {
  const { userData, codexDir } = makeFixture();
  const service = createAccountService(userData, {
    codexDir,
    nowMs: () => unixTestNow() * 1000,
    closeCodexProcesses: () => {
      throw new Error("simulated close failure");
    }
  });
  fs.writeFileSync(path.join(codexDir, "auth.json"), JSON.stringify({ access_token: "current", account_id: "acct-current" }), "utf8");
  const current = service.importCurrentAuth();
  fs.writeFileSync(path.join(codexDir, "auth.json"), JSON.stringify({ access_token: "target", account_id: "acct-target" }), "utf8");
  const target = service.importCurrentAuth();
  fs.writeFileSync(path.join(codexDir, "auth.json"), JSON.stringify({ access_token: "skip", account_id: "acct-skip" }), "utf8");
  const skipped = service.importCurrentAuth();
  const storePath = path.join(userData, "accounts-store.json");
  const store = JSON.parse(fs.readFileSync(storePath, "utf8"));
  for (const account of store.accounts) {
    account.status = "ready";
    account.usage = account.id === current.id
      ? { fetchedAt: unixTestNow(), fiveHour: { usedPercent: 100 }, oneWeek: { usedPercent: 20 } }
      : { fetchedAt: unixTestNow(), fiveHour: { usedPercent: 20 }, oneWeek: { usedPercent: 20 } };
  }
  fs.writeFileSync(storePath, JSON.stringify(store), "utf8");
  fs.writeFileSync(path.join(codexDir, "auth.json"), JSON.stringify({ access_token: "current", account_id: "acct-current" }), "utf8");
  service.updateSettings({ autoSwitchEnabled: true });
  service.setAutoSwitchExcluded(skipped.id, true);

  const result = await service.evaluateAutoSwitch("test");

  assert.equal(result.status, "failed");
  assert.equal(result.target.id, target.id);
  assert.deepEqual(service.readSettings().autoSwitchExcludedAccountIds, [skipped.id]);
});

test("clears manual auto-switch target when the target account is deleted", { skip: process.platform !== "win32" }, () => {
  const { userData, codexDir } = makeFixture();
  const service = createAccountService(userData, { codexDir });
  fs.writeFileSync(path.join(codexDir, "auth.json"), JSON.stringify({ access_token: "current", account_id: "acct-current" }), "utf8");
  service.importCurrentAuth();
  fs.writeFileSync(path.join(codexDir, "auth.json"), JSON.stringify({ access_token: "target", account_id: "acct-target" }), "utf8");
  const target = service.importCurrentAuth();
  fs.writeFileSync(path.join(codexDir, "auth.json"), JSON.stringify({ access_token: "current", account_id: "acct-current" }), "utf8");
  service.setAutoSwitchTarget(target.id);

  service.deleteAccount(target.id);

  assert.deepEqual(service.readAutoSwitchTargetPreference(), { mode: "best", accountId: undefined });
});

test("clears deleted account IDs from automatic-switch exclusions", { skip: process.platform !== "win32" }, () => {
  const { userData, codexDir } = makeFixture();
  const service = createAccountService(userData, { codexDir });
  fs.writeFileSync(path.join(codexDir, "auth.json"), JSON.stringify({ access_token: "current", account_id: "acct-current" }), "utf8");
  const current = service.importCurrentAuth();
  fs.writeFileSync(path.join(codexDir, "auth.json"), JSON.stringify({ access_token: "target", account_id: "acct-target" }), "utf8");
  const target = service.importCurrentAuth();
  fs.writeFileSync(path.join(codexDir, "auth.json"), JSON.stringify({ access_token: "current", account_id: "acct-current" }), "utf8");
  service.setAutoSwitchExcluded(target.id, true);

  service.deleteAccount(target.id);

  assert.deepEqual(service.readSettings().autoSwitchExcludedAccountIds, []);
  assert.equal(service.listAccounts().some((account) => account.id === current.id), true);
});

test("orders current account then manual target then scored accounts", { skip: process.platform !== "win32" }, () => {
  const { userData, codexDir } = makeFixture();
  const service = createAccountService(userData, { codexDir });
  fs.writeFileSync(path.join(codexDir, "auth.json"), JSON.stringify({ access_token: "current", account_id: "acct-current" }), "utf8");
  const current = service.importCurrentAuth();
  fs.writeFileSync(path.join(codexDir, "auth.json"), JSON.stringify({ access_token: "target", account_id: "acct-target" }), "utf8");
  const target = service.importCurrentAuth();
  fs.writeFileSync(path.join(codexDir, "auth.json"), JSON.stringify({ access_token: "best", account_id: "acct-best" }), "utf8");
  const best = service.importCurrentAuth();
  fs.writeFileSync(path.join(codexDir, "auth.json"), JSON.stringify({ access_token: "low", account_id: "acct-low" }), "utf8");
  const low = service.importCurrentAuth();

  const storePath = path.join(userData, "accounts-store.json");
  const store = JSON.parse(fs.readFileSync(storePath, "utf8"));
  for (const account of store.accounts) {
    account.status = "ready";
    account.usage = account.id === best.id
      ? { fetchedAt: unixTestNow(), fiveHour: { usedPercent: 0 }, oneWeek: { usedPercent: 0 } }
      : { fetchedAt: unixTestNow(), fiveHour: { usedPercent: 50 }, oneWeek: { usedPercent: 50 } };
  }
  fs.writeFileSync(storePath, JSON.stringify(store), "utf8");
  fs.writeFileSync(path.join(codexDir, "auth.json"), JSON.stringify({ access_token: "current", account_id: "acct-current" }), "utf8");
  service.updateSettings({ autoSwitchEnabled: true });
  service.setAutoSwitchTarget(target.id);

  const ordered = service.listAccounts().map((account) => account.id);

  assert.deepEqual(ordered, [current.id, target.id, best.id, low.id]);
});

test("orders one-time excluded accounts after non-excluded accounts", { skip: process.platform !== "win32" }, () => {
  const { userData, codexDir } = makeFixture();
  const service = createAccountService(userData, { codexDir, nowMs: () => unixTestNow() * 1000 });
  fs.writeFileSync(path.join(codexDir, "auth.json"), JSON.stringify({ access_token: "current", account_id: "acct-current" }), "utf8");
  const current = service.importCurrentAuth();
  fs.writeFileSync(path.join(codexDir, "auth.json"), JSON.stringify({ access_token: "excluded-best", account_id: "acct-excluded-best" }), "utf8");
  const excludedBest = service.importCurrentAuth();
  fs.writeFileSync(path.join(codexDir, "auth.json"), JSON.stringify({ access_token: "normal", account_id: "acct-normal" }), "utf8");
  const normal = service.importCurrentAuth();
  fs.writeFileSync(path.join(codexDir, "auth.json"), JSON.stringify({ access_token: "excluded-low", account_id: "acct-excluded-low" }), "utf8");
  const excludedLow = service.importCurrentAuth();

  const storePath = path.join(userData, "accounts-store.json");
  const store = JSON.parse(fs.readFileSync(storePath, "utf8"));
  const usedPercentById = new Map([
    [current.id, 50],
    [excludedBest.id, 0],
    [normal.id, 20],
    [excludedLow.id, 40]
  ]);
  for (const account of store.accounts) {
    account.status = "ready";
    const usedPercent = usedPercentById.get(account.id);
    account.usage = {
      fetchedAt: unixTestNow(),
      fiveHour: { usedPercent },
      oneWeek: { usedPercent }
    };
  }
  fs.writeFileSync(storePath, JSON.stringify(store), "utf8");
  fs.writeFileSync(path.join(codexDir, "auth.json"), JSON.stringify({ access_token: "current", account_id: "acct-current" }), "utf8");
  service.setAutoSwitchExcluded(excludedBest.id, true);
  service.setAutoSwitchExcluded(excludedLow.id, true);

  assert.deepEqual(service.listAccounts().map((account) => account.id), [
    current.id,
    normal.id,
    excludedBest.id,
    excludedLow.id
  ]);
});

test("falls back to the best account when the manual target is stale", { skip: process.platform !== "win32" }, async () => {
  const { userData, codexDir } = makeFixture();
  const service = createAccountService(userData, {
    codexDir,
    nowMs: () => unixTestNow() * 1000,
    getCodexProcessInfo: () => ({
      name: "Codex.exe",
      executablePath: "C:\\Program Files\\WindowsApps\\OpenAI.Codex_1.0.0.0_x64__2p2nqsd0c76g0\\app\\Codex.exe"
    }),
    inspectCodexProcessesForThreads: async () => ({ count: 1, inspected: true, processIds: [42] }),
    isProcessAlive: (pid) => pid === 42
  });
  fs.mkdirSync(path.join(codexDir, "process_manager"), { recursive: true });
  fs.writeFileSync(path.join(codexDir, "process_manager", "chat_processes.json"), JSON.stringify([{ osPid: 42 }]), "utf8");
  fs.writeFileSync(path.join(codexDir, "auth.json"), JSON.stringify({ access_token: "current", account_id: "acct-current" }), "utf8");
  const current = service.importCurrentAuth();
  fs.writeFileSync(path.join(codexDir, "auth.json"), JSON.stringify({ access_token: "target", account_id: "acct-target" }), "utf8");
  const target = service.importCurrentAuth();
  fs.writeFileSync(path.join(codexDir, "auth.json"), JSON.stringify({ access_token: "best", account_id: "acct-best" }), "utf8");
  const best = service.importCurrentAuth();

  const storePath = path.join(userData, "accounts-store.json");
  const store = JSON.parse(fs.readFileSync(storePath, "utf8"));
  for (const account of store.accounts) {
    account.status = "ready";
    account.usage = account.id === current.id
      ? { fetchedAt: unixTestNow(), fiveHour: { usedPercent: 100 }, oneWeek: { usedPercent: 20 } }
      : { fetchedAt: unixTestNow(), fiveHour: { usedPercent: 20 }, oneWeek: { usedPercent: 20 } };
  }
  const staleTarget = store.accounts.find((account) => account.id === target.id);
  staleTarget.usage.fetchedAt = unixTestNow() - 9999;
  fs.writeFileSync(storePath, JSON.stringify(store), "utf8");
  fs.writeFileSync(path.join(codexDir, "auth.json"), JSON.stringify({ access_token: "current", account_id: "acct-current" }), "utf8");
  service.updateSettings({ autoSwitchEnabled: true });
  service.setAutoSwitchTarget(target.id);

  const first = await service.evaluateAutoSwitch("test");
  const second = await service.evaluateAutoSwitch("queued-check");

  assert.equal(first.status, "queued");
  assert.equal(second.status, "queued");
  assert.equal(first.target?.id, best.id);
  assert.equal(second.target?.id, best.id);
  assert.equal(first.fallback?.requestedTargetId, target.id);
  assert.equal(first.fallback?.reason, "manual_target_unavailable");
  assert.deepEqual(service.readAutoSwitchTargetPreference(), { mode: "best", accountId: undefined });
  assert.equal(service.getAutoSwitchState().pending?.accountId, best.id);
  const diagnostics = fs.readFileSync(path.join(userData, "auto-switch-events.jsonl"), "utf8");
  const fallbackEvents = diagnostics
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
    .filter((event) => event.type === "manual_target_fallback");
  assert.equal(fallbackEvents.length, 1);
  assert.doesNotMatch(diagnostics, /access_token|refresh_token|Bearer /i);
});

test("falls back when the manual target encrypted record is unreadable", { skip: process.platform !== "win32" }, async () => {
  const { userData, codexDir } = makeFixture();
  const service = createAccountService(userData, {
    codexDir,
    nowMs: () => unixTestNow() * 1000,
    closeCodexProcesses: () => 0,
    launchCodex: () => false
  });
  fs.writeFileSync(path.join(codexDir, "auth.json"), JSON.stringify({ access_token: "current", account_id: "acct-current" }), "utf8");
  const current = service.importCurrentAuth();
  fs.writeFileSync(path.join(codexDir, "auth.json"), JSON.stringify({ access_token: "target", account_id: "acct-target" }), "utf8");
  const target = service.importCurrentAuth();
  fs.writeFileSync(path.join(codexDir, "auth.json"), JSON.stringify({ access_token: "alt", account_id: "acct-fallback" }), "utf8");
  const fallback = service.importCurrentAuth();

  const storePath = path.join(userData, "accounts-store.json");
  const store = JSON.parse(fs.readFileSync(storePath, "utf8"));
  for (const account of store.accounts) {
    account.usage = account.id === current.id
      ? { fetchedAt: unixTestNow(), fiveHour: { usedPercent: 100 }, oneWeek: { usedPercent: 20 } }
      : { fetchedAt: unixTestNow(), fiveHour: { usedPercent: 20 }, oneWeek: { usedPercent: 20 } };
  }
  store.accounts.find((account) => account.id === target.id).encryptedAuth = "unreadable";
  fs.writeFileSync(storePath, JSON.stringify(store), "utf8");
  fs.writeFileSync(path.join(codexDir, "auth.json"), JSON.stringify({ access_token: "current", account_id: "acct-current" }), "utf8");
  service.updateSettings({ autoSwitchEnabled: true });
  service.setAutoSwitchTarget(target.id);

  const result = await service.evaluateAutoSwitch("test");

  assert.equal(result.status, "switched");
  assert.equal(result.target?.id, fallback.id);
  assert.equal(result.fallback?.reason, "manual_target_unreadable");
  assert.deepEqual(service.readAutoSwitchTargetPreference(), { mode: "best", accountId: undefined });
});

test("persists queued auto-switch state and cancels when current usage recovers", { skip: process.platform !== "win32" }, async () => {
  const { userData, codexDir } = makeFixture();
  const service = createAccountService(userData, {
    codexDir,
    nowMs: () => unixTestNow() * 1000,
    getCodexProcessInfo: () => ({ name: "Codex.exe", executablePath: "C:\\Program Files\\WindowsApps\\OpenAI.Codex_1.0.0.0_x64__2p2nqsd0c76g0\\app\\Codex.exe" }),
    inspectCodexProcessesForThreads: async () => ({ count: 1, inspected: true, processIds: [42] }),
    isProcessAlive: (pid) => pid === 42
  });
  fs.mkdirSync(path.join(codexDir, "process_manager"), { recursive: true });
  fs.writeFileSync(path.join(codexDir, "process_manager", "chat_processes.json"), JSON.stringify([{ osPid: 42 }]), "utf8");
  fs.writeFileSync(path.join(codexDir, "auth.json"), JSON.stringify({ access_token: "current", account_id: "acct-current" }), "utf8");
  const current = service.importCurrentAuth();
  fs.writeFileSync(path.join(codexDir, "auth.json"), JSON.stringify({ access_token: "target", account_id: "acct-target" }), "utf8");
  const target = service.importCurrentAuth();
  const storePath = path.join(userData, "accounts-store.json");
  const store = JSON.parse(fs.readFileSync(storePath, "utf8"));
  for (const account of store.accounts) {
    account.status = "ready";
    account.usage = account.id === current.id
      ? { fetchedAt: unixTestNow(), fiveHour: { usedPercent: 100 }, oneWeek: { usedPercent: 20 } }
      : { fetchedAt: unixTestNow(), fiveHour: { usedPercent: 20 }, oneWeek: { usedPercent: 20 } };
  }
  fs.writeFileSync(storePath, JSON.stringify(store), "utf8");
  fs.writeFileSync(path.join(codexDir, "auth.json"), JSON.stringify({ access_token: "current", account_id: "acct-current" }), "utf8");
  service.updateSettings({ autoSwitchEnabled: true });
  service.setAutoSwitchTarget(target.id);

  const queued = await service.evaluateAutoSwitch("test");

  assert.equal(queued.status, "queued");
  assert.equal(service.getAutoSwitchState().pending.accountId, target.id);
  assert.equal(service.getAutoSwitchState().pending.mode, "manual");
  assert.deepEqual(service.readAutoSwitchTargetPreference(), { mode: "best", accountId: undefined });

  const recovered = JSON.parse(fs.readFileSync(storePath, "utf8"));
  recovered.accounts.find((account) => account.id === current.id).usage.fiveHour.usedPercent = 10;
  fs.writeFileSync(storePath, JSON.stringify(recovered), "utf8");
  const cancelled = await service.evaluateAutoSwitch("test");

  assert.equal(cancelled.status, "cancelled");
  assert.equal(service.getAutoSwitchState().pending, undefined);
});

test("holds the current account across quota recovery and restart until a successful manual switch", { skip: process.platform !== "win32" }, async () => {
  const { userData, codexDir } = makeFixture();
  const options = {
    codexDir,
    nowMs: () => unixTestNow() * 1000,
    closeCodexProcesses: () => 0,
    launchCodex: () => false
  };
  const service = createAccountService(userData, options);
  fs.writeFileSync(path.join(codexDir, "auth.json"), JSON.stringify({ access_token: "current", account_id: "acct-current" }), "utf8");
  const current = service.importCurrentAuth();
  fs.writeFileSync(path.join(codexDir, "auth.json"), JSON.stringify({ access_token: "target", account_id: "acct-target" }), "utf8");
  const target = service.importCurrentAuth();
  const storePath = path.join(userData, "accounts-store.json");
  const store = JSON.parse(fs.readFileSync(storePath, "utf8"));
  for (const account of store.accounts) {
    account.status = "ready";
    account.usage = account.id === current.id
      ? { fetchedAt: unixTestNow(), fiveHour: { usedPercent: 100 }, oneWeek: { usedPercent: 20 } }
      : { fetchedAt: unixTestNow(), fiveHour: { usedPercent: 20 }, oneWeek: { usedPercent: 20 } };
  }
  fs.writeFileSync(storePath, JSON.stringify(store), "utf8");
  fs.writeFileSync(path.join(codexDir, "auth.json"), JSON.stringify({ access_token: "current", account_id: "acct-current" }), "utf8");
  service.updateSettings({
    autoSwitchEnabled: true,
    autoSwitchExcludedAccountIds: [target.id],
    autoSwitchStayAccountId: current.id
  });
  service.writeAutoSwitchState({ pending: { accountId: target.id, activityBusy: true } });

  assert.equal((await service.evaluateAutoSwitch("test")).status, "held");
  assert.equal(service.getAutoSwitchState().pending, undefined);
  assert.equal(service.readSettings().autoSwitchStayAccountId, current.id);
  assert.equal(service.readSettings().autoSwitchEnabled, true);
  assert.deepEqual(service.readSettings().autoSwitchExcludedAccountIds, [target.id]);

  const recovered = JSON.parse(fs.readFileSync(storePath, "utf8"));
  recovered.accounts.find((account) => account.id === current.id).usage.fiveHour.usedPercent = 10;
  fs.writeFileSync(storePath, JSON.stringify(recovered), "utf8");
  assert.equal((await createAccountService(userData, options).evaluateAutoSwitch("after-restart")).status, "held");
  assert.equal(service.readSettings().autoSwitchStayAccountId, current.id);

  service.switchAccount(target.id);
  assert.equal(service.readSettings().autoSwitchStayAccountId, undefined);
});

test("retains the current-account hold when manual switching fails", { skip: process.platform !== "win32" }, () => {
  const { userData, codexDir } = makeFixture();
  const service = createAccountService(userData, {
    codexDir,
    closeCodexProcesses: () => { throw new Error("close failed"); },
    launchCodex: () => false
  });
  fs.writeFileSync(path.join(codexDir, "auth.json"), JSON.stringify({ access_token: "current", account_id: "acct-current" }), "utf8");
  const current = service.importCurrentAuth();
  fs.writeFileSync(path.join(codexDir, "auth.json"), JSON.stringify({ access_token: "target", account_id: "acct-target" }), "utf8");
  const target = service.importCurrentAuth();
  fs.writeFileSync(path.join(codexDir, "auth.json"), JSON.stringify({ access_token: "current", account_id: "acct-current" }), "utf8");
  service.updateSettings({ autoSwitchStayAccountId: current.id });

  assert.throws(() => service.switchAccount(target.id), /close failed/);
  assert.equal(service.readSettings().autoSwitchStayAccountId, current.id);
});

test("replaces stale task rows across active idle and renewed activity decisions", { skip: process.platform !== "win32" }, async () => {
  const { userData, codexDir } = makeFixture();
  let nowMs = unixTestNow() * 1000;
  let activityStatus = {
    isBusy: true,
    reason: "active_task_lifecycle",
    activeProcessCount: 1,
    officialProcessCount: 1,
    activeThreadIds: ["thread-old"],
    activeTasks: [{ id: "thread-old", displayName: "旧任务", nameSource: "thread_title" }],
    threadIdUnavailable: false,
    processRegistryState: "corrupt",
    processEvidenceSource: "official_process_scan",
    taskEvidenceSource: "lifecycle",
    taskAssociationConfidence: "unavailable",
    activityKey: "task:thread-old"
  };
  const service = createAccountService(userData, {
    codexDir,
    nowMs: () => nowMs,
    getCodexActivityStatus: () => activityStatus
  });
  fs.writeFileSync(path.join(codexDir, "auth.json"), JSON.stringify({ access_token: "current", account_id: "acct-current" }), "utf8");
  const current = service.importCurrentAuth();
  fs.writeFileSync(path.join(codexDir, "auth.json"), JSON.stringify({ access_token: "target", account_id: "acct-target" }), "utf8");
  const target = service.importCurrentAuth();
  const storePath = path.join(userData, "accounts-store.json");
  const store = JSON.parse(fs.readFileSync(storePath, "utf8"));
  for (const account of store.accounts) {
    account.status = "ready";
    account.usage = account.id === current.id
      ? { fetchedAt: unixTestNow(), fiveHour: { usedPercent: 100 }, oneWeek: { usedPercent: 20 } }
      : { fetchedAt: unixTestNow(), fiveHour: { usedPercent: 20 }, oneWeek: { usedPercent: 20 } };
  }
  fs.writeFileSync(storePath, JSON.stringify(store), "utf8");
  fs.writeFileSync(path.join(codexDir, "auth.json"), JSON.stringify({ access_token: "current", account_id: "acct-current" }), "utf8");
  service.updateSettings({ autoSwitchEnabled: true });
  service.setAutoSwitchTarget(target.id);

  assert.equal((await service.evaluateAutoSwitch("test")).status, "queued");
  assert.deepEqual(service.getAutoSwitchState().pending.activeThreadIds, ["thread-old"]);

  nowMs += 31_000;
  activityStatus = {
    isBusy: false,
    reason: "unassociated_official_process",
    activeProcessCount: 0,
    officialProcessCount: 10,
    activeThreadIds: [],
    activeTasks: [],
    threadIdUnavailable: false,
    processRegistryState: "corrupt",
    processEvidenceSource: "official_process_scan",
    taskEvidenceSource: "none",
    taskAssociationConfidence: "unavailable",
    activityKey: "idle"
  };
  assert.equal((await service.evaluateAutoSwitch("test")).status, "queued");
  const quiet = service.getAutoSwitchState().pending;
  assert.deepEqual(quiet.activeThreadIds, []);
  assert.deepEqual(quiet.activeTasks, []);
  assert.equal(quiet.activityBusy, false);
  assert.equal(quiet.quietUntilMs, nowMs + 90_000);

  nowMs += 15_000;
  assert.equal((await service.evaluateAutoSwitch("test")).status, "queued");
  assert.equal(service.getAutoSwitchState().pending.quietUntilMs, quiet.quietUntilMs);

  activityStatus = { ...activityStatus, officialProcessCount: 11 };
  nowMs += 15_000;
  assert.equal((await service.evaluateAutoSwitch("test")).status, "queued");
  assert.equal(service.getAutoSwitchState().pending.quietUntilMs, quiet.quietUntilMs);

  activityStatus = {
    ...activityStatus,
    isBusy: true,
    reason: "active_task_lifecycle",
    activeProcessCount: 1,
    officialProcessCount: 1,
    activeThreadIds: ["thread-new"],
    activeTasks: [{ id: "thread-new", displayName: "新任务", nameSource: "thread_title" }],
    taskEvidenceSource: "lifecycle",
    taskAssociationConfidence: "unavailable",
    activityKey: "task:thread-new"
  };
  assert.equal((await service.evaluateAutoSwitch("test")).status, "queued");
  const renewed = service.getAutoSwitchState().pending;
  assert.deepEqual(renewed.activeThreadIds, ["thread-new"]);
  assert.equal(renewed.activeTasks[0].displayName, "新任务");
  assert.equal(renewed.quietUntilMs, undefined);
});

test("registry disappearance cannot throw evaluation or retain an old pending task", { skip: process.platform !== "win32" }, async () => {
  const { userData, codexDir } = makeFixture();
  const nowMs = unixTestNow() * 1000;
  const processDir = path.join(codexDir, "process_manager");
  fs.mkdirSync(processDir, { recursive: true });
  fs.writeFileSync(path.join(processDir, "chat_processes.json"), "[]", "utf8");
  const service = createAccountService(userData, {
    codexDir,
    nowMs: () => nowMs,
    inspectCodexProcessesForThreads: async () => ({ count: 0, inspected: true, processIds: [] }),
    readCodexProcessRegistry: () => { throw Object.assign(new Error("gone"), { code: "ENOENT" }); }
  });
  fs.writeFileSync(path.join(codexDir, "auth.json"), JSON.stringify({ access_token: "current", account_id: "acct-current" }), "utf8");
  const current = service.importCurrentAuth();
  fs.writeFileSync(path.join(codexDir, "auth.json"), JSON.stringify({ access_token: "target", account_id: "acct-target" }), "utf8");
  const target = service.importCurrentAuth();
  const storePath = path.join(userData, "accounts-store.json");
  const store = JSON.parse(fs.readFileSync(storePath, "utf8"));
  for (const account of store.accounts) {
    account.status = "ready";
    account.usage = account.id === current.id
      ? { fetchedAt: unixTestNow(), fiveHour: { usedPercent: 100 }, oneWeek: { usedPercent: 20 } }
      : { fetchedAt: unixTestNow(), fiveHour: { usedPercent: 20 }, oneWeek: { usedPercent: 20 } };
  }
  fs.writeFileSync(storePath, JSON.stringify(store), "utf8");
  fs.writeFileSync(path.join(codexDir, "auth.json"), JSON.stringify({ access_token: "current", account_id: "acct-current" }), "utf8");
  service.updateSettings({ autoSwitchEnabled: true });
  service.writeAutoSwitchState({
    pending: {
      accountId: target.id,
      mode: "manual",
      activityBusy: true,
      activityKey: "task:thread-old",
      activeThreadIds: ["thread-old"],
      activeTasks: [{ id: "thread-old", displayName: "Old task", nameSource: "thread_title" }]
    }
  });

  const result = await service.evaluateAutoSwitch("queued-check");

  assert.equal(result.status, "queued");
  assert.deepEqual(result.pending.activeThreadIds, []);
  assert.deepEqual(result.pending.activeTasks, []);
  assert.deepEqual(result.pending.processRegistryDiagnostic, { state: "missing", reason: "not_found" });
});

test("migrates plaintext auth backups to DPAPI encrypted files", { skip: process.platform !== "win32" }, () => {
  const { userData, codexDir } = makeFixture();
  const backupDir = path.join(codexDir, "secure-switcher-backups");
  fs.mkdirSync(backupDir, { recursive: true });
  fs.writeFileSync(path.join(backupDir, "auth.old.json"), JSON.stringify({ access_token: "p" }), "utf8");

  createAccountService(userData, { codexDir });

  const migratedBackupDir = path.join(userData, "codex-backups", "auth");
  const backups = fs.readdirSync(migratedBackupDir);
  assert.deepEqual(backups, ["auth.old.json.dpapi"]);
  assert.equal(fs.readFileSync(path.join(migratedBackupDir, backups[0]), "utf8").includes('"p"'), false);
  assert.equal(fs.existsSync(backupDir), false);
});

test("automatically syncs refreshed current auth into encrypted storage", { skip: process.platform !== "win32" }, () => {
  const { userData, codexDir } = makeFixture();
  const oldAuth = { access_token: "old", refresh_token: "oldr", account_id: "acct-sync" };
  const refreshedAuth = { access_token: "new", refresh_token: "newr", account_id: "acct-sync" };
  fs.writeFileSync(path.join(codexDir, "auth.json"), JSON.stringify(oldAuth), "utf8");

  const service = createAccountService(userData, { codexDir });
  const imported = service.importCurrentAuth();
  const store = service.readStore();
  store.accounts[0].status = "usage_auth_expired";
  store.accounts[0].usageError = "old auth rejected";
  service.writeStore(store);
  fs.writeFileSync(path.join(codexDir, "auth.json"), JSON.stringify(refreshedAuth), "utf8");

  const synced = service.listAccounts()[0];
  assert.equal(synced.id, imported.id);
  assert.equal(synced.status, "ready");
  assert.equal(synced.usageError, undefined);
  assert.deepEqual(service.decryptAccountAuth(service.readStore().accounts[0]), refreshedAuth);
  const rawStore = fs.readFileSync(path.join(userData, "accounts-store.json"), "utf8");
  assert.equal(rawStore.includes('"new"'), false);
  assert.equal(rawStore.includes('"newr"'), false);
});

test("syncs current auth before delete decisions", { skip: process.platform !== "win32" }, () => {
  const { userData, codexDir } = makeFixture();
  const oldAuth = { access_token: "old", refresh_token: "oldr", account_id: "acct-delete-sync" };
  const refreshedAuth = { access_token: "new", refresh_token: "newr", account_id: "acct-delete-sync" };
  fs.writeFileSync(path.join(codexDir, "auth.json"), JSON.stringify(oldAuth), "utf8");

  let closedCodexProcesses = 0;
  const service = createAccountService(userData, {
    codexDir,
    closeCodexProcesses: () => {
      closedCodexProcesses += 1;
      return 1;
    },
    launchCodex: () => false
  });
  const current = service.importCurrentAuth();
  fs.writeFileSync(path.join(codexDir, "auth.json"), JSON.stringify(refreshedAuth), "utf8");

  const deleted = service.deleteAccount(current.id, { mode: "login_new" });
  assert.equal(deleted.loginNew, true);
  assert.equal(closedCodexProcesses, 1);
  assert.equal(fs.existsSync(path.join(codexDir, "auth.json")), false);
});

test("marks 401 as expired usage authentication but keeps 403 as usage failure", { skip: process.platform !== "win32" }, async () => {
  const { userData, codexDir } = makeFixture();
  fs.writeFileSync(path.join(codexDir, "auth.json"), JSON.stringify({ access_token: "access", account_id: "acct-status" }), "utf8");

  const service = createAccountService(userData, {
    codexDir,
    fetchImpl: async () => new Response("", { status: 403 })
  });
  const imported = service.importCurrentAuth();
  await assert.rejects(() => service.refreshUsage(imported.id, true), /403/);
  assert.equal(service.listAccounts()[0].status, "usage_failed");

  service.fetchImpl = async () => new Response("", { status: 401 });
  await assert.rejects(() => service.refreshUsage(imported.id, true), /401/);
  const expired = service.listAccounts()[0];
  assert.equal(expired.status, "usage_auth_expired");
  assert.match(expired.usageError, /账号仍可切换/);
});

test("skips background retries for expired usage authentication until a forced refresh", { skip: process.platform !== "win32" }, async () => {
  const { userData, codexDir } = makeFixture();
  fs.writeFileSync(path.join(codexDir, "auth.json"), JSON.stringify({ access_token: "access", account_id: "acct-backoff" }), "utf8");

  let fetchCalls = 0;
  const service = createAccountService(userData, {
    codexDir,
    fetchImpl: async () => {
      fetchCalls += 1;
      return new Response("", { status: 401 });
    }
  });
  const imported = service.importCurrentAuth();
  await assert.rejects(() => service.refreshUsage(imported.id, true), /401/);
  const failedRequestCalls = fetchCalls;
  assert.equal(failedRequestCalls, 2);

  await assert.doesNotReject(() => service.refreshUsage(imported.id, false));
  assert.equal(fetchCalls, failedRequestCalls);
  assert.equal(service.listAccounts()[0].status, "usage_auth_expired");

  service.fetchImpl = async () => {
    fetchCalls += 1;
    return new Response("{}", { headers: { "content-type": "application/json" } });
  };
  await service.refreshUsage(imported.id, true);
  assert.equal(fetchCalls, failedRequestCalls + 1);
  assert.equal(service.listAccounts()[0].status, "ready");
});

test("usage refresh does not overwrite accounts added while the request is pending", { skip: process.platform !== "win32" }, async () => {
  const { userData, codexDir } = makeFixture();
  fs.writeFileSync(path.join(codexDir, "auth.json"), JSON.stringify({ access_token: "a", account_id: "acct-a" }), "utf8");

  let finishFetch;
  let signalFetchStarted;
  const fetchStarted = new Promise((resolve) => { signalFetchStarted = resolve; });
  const service = createAccountService(userData, {
    codexDir,
    fetchImpl: async () => new Promise((resolve) => {
      finishFetch = resolve;
      signalFetchStarted();
    })
  });
  const first = service.importCurrentAuth();
  const pendingRefresh = service.refreshUsage(first.id, true);
  await fetchStarted;

  fs.writeFileSync(path.join(codexDir, "auth.json"), JSON.stringify({ access_token: "b", account_id: "acct-b" }), "utf8");
  service.importCurrentAuth();
  finishFetch(new Response(JSON.stringify({
    rate_limit: {
      primary_window: { used_percent: 10, limit_window_seconds: 18_000, reset_at: 1_800_000_000 }
    }
  }), { headers: { "content-type": "application/json" } }));
  await pendingRefresh;

  assert.equal(service.listAccounts().length, 2);
});

test("refreshes the current account before other saved accounts", { skip: process.platform !== "win32" }, async () => {
  const { userData, codexDir } = makeFixture();
  const requestedAccounts = [];
  fs.writeFileSync(path.join(codexDir, "auth.json"), JSON.stringify({ access_token: "a", account_id: "acct-a" }), "utf8");
  const service = createAccountService(userData, {
    codexDir,
    fetchImpl: async (_url, init) => {
      requestedAccounts.push(init.headers["ChatGPT-Account-Id"]);
      return new Response(JSON.stringify({
        rate_limit: {
          primary_window: { used_percent: 10, limit_window_seconds: 18_000, reset_at: 1_800_000_000 },
          secondary_window: { used_percent: 20, limit_window_seconds: 604_800, reset_at: 1_800_604_800 }
        }
      }), { headers: { "content-type": "application/json" } });
    }
  });
  service.importCurrentAuth();
  fs.writeFileSync(path.join(codexDir, "auth.json"), JSON.stringify({ access_token: "b", account_id: "acct-b" }), "utf8");
  service.importCurrentAuth();

  await service.refreshAllUsage();

  assert.deepEqual(requestedAccounts, ["acct-b", "acct-a"]);
});

test("overlapping broad usage refreshes share one in-flight operation", { skip: process.platform !== "win32" }, async () => {
  const { userData, codexDir } = makeFixture();
  fs.writeFileSync(path.join(codexDir, "auth.json"), JSON.stringify({ access_token: "a", account_id: "acct-a" }), "utf8");
  let fetchCalls = 0;
  let releaseFetch;
  let signalFetchStarted;
  const fetchStarted = new Promise((resolve) => { signalFetchStarted = resolve; });
  const service = createAccountService(userData, {
    codexDir,
    fetchImpl: async () => {
      fetchCalls += 1;
      signalFetchStarted();
      await new Promise((resolve) => { releaseFetch = resolve; });
      return new Response(JSON.stringify({
        rate_limit: { primary_window: { used_percent: 10, limit_window_seconds: 18_000, reset_at: 1_800_000_000 } }
      }), { headers: { "content-type": "application/json" } });
    }
  });
  service.importCurrentAuth();
  const firstProgress = [];
  const overlappingProgress = [];

  const first = service.refreshAllUsage({ onProgress: (value) => firstProgress.push(value) });
  const overlapping = service.refreshAllUsage({ onProgress: (value) => overlappingProgress.push(value) });
  await fetchStarted;
  assert.equal(fetchCalls, 1);
  releaseFetch();
  assert.deepEqual(await overlapping, await first);
  assert.deepEqual(firstProgress.at(-1), { stage: "completed", completed: 1, total: 1 });
  assert.deepEqual(overlappingProgress.at(-1), { stage: "completed", completed: 1, total: 1 });
  assert.doesNotMatch(JSON.stringify(firstProgress), /acct-a|accountId|thread|path|token/i);

  await service.refreshAllUsage();
  assert.equal(fetchCalls, 1);
});

test("failed broad refreshes still finish aggregate progress without exposing account identity", { skip: process.platform !== "win32" }, async () => {
  const { userData, codexDir } = makeFixture();
  fs.writeFileSync(path.join(codexDir, "auth.json"), JSON.stringify({ access_token: "a", account_id: "acct-private" }), "utf8");
  const service = createAccountService(userData, {
    codexDir,
    fetchImpl: async () => {
      throw new Error("synthetic network failure");
    }
  });
  service.importCurrentAuth();
  const progress = [];

  const results = await service.refreshAllUsage({ onProgress: (value) => progress.push(value) });

  assert.equal(results[0].ok, false);
  assert.deepEqual(progress.at(-1), { stage: "completed", completed: 1, total: 1 });
  assert.doesNotMatch(JSON.stringify(progress), /acct-private|accountId|network failure/i);
});

test("recurring usage refresh awaits asynchronous DPAPI authentication", { skip: process.platform !== "win32" }, async () => {
  const { userData, codexDir } = makeFixture();
  const auth = { access_token: "async-access", account_id: "acct-async" };
  fs.writeFileSync(path.join(codexDir, "auth.json"), JSON.stringify(auth), "utf8");
  let releaseDecrypt;
  let decryptCalls = 0;
  let fetchCalls = 0;
  const service = createAccountService(userData, {
    codexDir,
    unprotectStringAsync: async () => {
      decryptCalls += 1;
      await new Promise((resolve) => { releaseDecrypt = resolve; });
      return JSON.stringify(auth);
    },
    fetchImpl: async () => {
      fetchCalls += 1;
      return new Response(JSON.stringify({
        rate_limit: {
          primary_window: { used_percent: 10, limit_window_seconds: 18_000, reset_at: 1_800_000_000 }
        }
      }), { headers: { "content-type": "application/json" } });
    }
  });
  const account = service.importCurrentAuth();

  const refresh = service.refreshUsage(account.id, true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(decryptCalls, 1);
  assert.equal(fetchCalls, 0);

  releaseDecrypt();
  await refresh;
  assert.equal(fetchCalls, 1);
});

test("automatic target readability caches only an unchanged ciphertext", { skip: process.platform !== "win32" }, async () => {
  const { userData, codexDir } = makeFixture();
  const currentAuth = { access_token: "current", account_id: "acct-current" };
  const targetAuth = { access_token: "target", account_id: "acct-target" };
  let decryptCalls = 0;
  let failNextDecrypt = false;
  const service = createAccountService(userData, {
    codexDir,
    nowMs: () => unixTestNow() * 1000,
    unprotectStringAsync: async () => {
      decryptCalls += 1;
      if (failNextDecrypt) {
        failNextDecrypt = false;
        throw new Error("transient DPAPI failure");
      }
      return JSON.stringify(targetAuth);
    },
    getCodexActivityStatus: () => ({
      isBusy: true,
      reason: "active_task_lifecycle",
      activityKey: "task:active"
    })
  });
  fs.writeFileSync(path.join(codexDir, "auth.json"), JSON.stringify(currentAuth), "utf8");
  const current = service.importCurrentAuth();
  fs.writeFileSync(path.join(codexDir, "auth.json"), JSON.stringify(targetAuth), "utf8");
  const target = service.importCurrentAuth();
  const storePath = path.join(userData, "accounts-store.json");
  const store = JSON.parse(fs.readFileSync(storePath, "utf8"));
  for (const account of store.accounts) {
    account.status = "ready";
    account.usage = account.id === current.id
      ? { fetchedAt: unixTestNow(), fiveHour: { usedPercent: 100 }, oneWeek: { usedPercent: 20 } }
      : { fetchedAt: unixTestNow(), fiveHour: { usedPercent: 20 }, oneWeek: { usedPercent: 20 } };
  }
  fs.writeFileSync(storePath, JSON.stringify(store), "utf8");
  fs.writeFileSync(path.join(codexDir, "auth.json"), JSON.stringify(currentAuth), "utf8");
  service.updateSettings({ autoSwitchEnabled: true });

  assert.equal((await service.evaluateAutoSwitch("first")).status, "queued");
  assert.equal((await service.evaluateAutoSwitch("second")).status, "queued");
  assert.equal(decryptCalls, 1);

  const changedStore = JSON.parse(fs.readFileSync(storePath, "utf8"));
  changedStore.accounts.find((account) => account.id === target.id).encryptedAuth = protectString(JSON.stringify({
    ...targetAuth,
    access_token: "target-replaced"
  }));
  fs.writeFileSync(storePath, JSON.stringify(changedStore), "utf8");

  failNextDecrypt = true;
  assert.equal((await service.evaluateAutoSwitch("third")).status, "target_unavailable");
  assert.equal(decryptCalls, 2);
  assert.equal((await service.evaluateAutoSwitch("fourth")).status, "queued");
  assert.equal((await service.evaluateAutoSwitch("fifth")).status, "queued");
  assert.equal(decryptCalls, 3);
});

test("repeated account-list reads reuse a displayed remark until its ciphertext changes", { skip: process.platform !== "win32" }, () => {
  const { userData, codexDir } = makeFixture();
  const auth = { access_token: "remark", account_id: "acct-remark" };
  let decryptCalls = 0;
  const service = createAccountService(userData, {
    codexDir,
    unprotectString: (value) => {
      decryptCalls += 1;
      return value === "remark-a" ? "first remark" : "second remark";
    }
  });
  fs.writeFileSync(path.join(codexDir, "auth.json"), JSON.stringify(auth), "utf8");
  const account = service.importCurrentAuth();
  const storePath = path.join(userData, "accounts-store.json");
  const store = JSON.parse(fs.readFileSync(storePath, "utf8"));
  store.accounts[0].encryptedRemark = "remark-a";
  fs.writeFileSync(storePath, JSON.stringify(store), "utf8");

  assert.equal(service.listAccounts()[0].remark, "first remark");
  assert.equal(service.listAccounts()[0].remark, "first remark");
  assert.equal(decryptCalls, 1);

  const changedStore = JSON.parse(fs.readFileSync(storePath, "utf8"));
  changedStore.accounts.find((item) => item.id === account.id).encryptedRemark = "remark-b";
  fs.writeFileSync(storePath, JSON.stringify(changedStore), "utf8");
  assert.equal(service.listAccounts()[0].remark, "second remark");
  assert.equal(decryptCalls, 2);
});

test("automatic switching uses the asynchronous conservative activity path", { skip: process.platform !== "win32" }, async () => {
  const { userData, codexDir } = makeFixture();
  const currentAuth = { access_token: "current", account_id: "acct-current" };
  const targetAuth = { access_token: "target", account_id: "acct-target" };
  let asyncInspections = 0;
  const service = createAccountService(userData, {
    codexDir,
    nowMs: () => unixTestNow() * 1000,
    unprotectStringAsync: async () => JSON.stringify(targetAuth),
    inspectCodexProcesses: () => {
      throw new Error("synchronous activity inspection must not run");
    },
    inspectCodexProcessesForThreads: async () => {
      asyncInspections += 1;
      return { count: 1, inspected: true, processIds: [42] };
    },
    indexCodexTaskActivity: async () => ({ cacheEntries: [] })
  });
  fs.writeFileSync(path.join(codexDir, "auth.json"), JSON.stringify(currentAuth), "utf8");
  const current = service.importCurrentAuth();
  fs.writeFileSync(path.join(codexDir, "auth.json"), JSON.stringify(targetAuth), "utf8");
  service.importCurrentAuth();
  const storePath = path.join(userData, "accounts-store.json");
  fs.mkdirSync(path.join(codexDir, "process_manager"), { recursive: true });
  fs.writeFileSync(path.join(codexDir, "process_manager", "chat_processes.json"), JSON.stringify([{
    osPid: 42,
    conversationId: "thread-async",
    updatedAtMs: unixTestNow() * 1000
  }]), "utf8");
  const store = JSON.parse(fs.readFileSync(storePath, "utf8"));
  for (const account of store.accounts) {
    account.status = "ready";
    account.usage = account.id === current.id
      ? { fetchedAt: unixTestNow(), fiveHour: { usedPercent: 100 }, oneWeek: { usedPercent: 20 } }
      : { fetchedAt: unixTestNow(), fiveHour: { usedPercent: 20 }, oneWeek: { usedPercent: 20 } };
  }
  fs.writeFileSync(storePath, JSON.stringify(store), "utf8");
  fs.writeFileSync(path.join(codexDir, "auth.json"), JSON.stringify(currentAuth), "utf8");
  service.updateSettings({ autoSwitchEnabled: true });

  const result = await service.evaluateAutoSwitch("test");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(result.status, "queued");
  assert.equal(asyncInspections, 1);
});

test("consecutive equivalent auto-switch diagnostics are coalesced", () => {
  const { userData } = makeFixture();
  const service = createAccountService(userData, { nowMs: () => unixTestNow() * 1000 });

  service.writeAutoSwitchEvent("queued", { reason: "queued-check", activityReason: "active_task_lifecycle" });
  service.writeAutoSwitchEvent("queued", { reason: "queued-check", activityReason: "active_task_lifecycle" });
  service.writeAutoSwitchEvent("queued", { reason: "queued-check", activityReason: "recent_session_activity" });

  const rows = fs.readFileSync(path.join(userData, "auto-switch-events.jsonl"), "utf8").trim().split("\n");
  assert.equal(rows.length, 2);
});

test("does not save a current account transport preference when Codex cannot close", { skip: process.platform !== "win32" }, () => {
  const { userData, codexDir } = makeFixture();
  fs.writeFileSync(path.join(codexDir, "auth.json"), JSON.stringify({ access_token: "a", account_id: "acct-a" }), "utf8");
  const service = createAccountService(userData, {
    codexDir,
    closeCodexProcesses: () => {
      throw new Error("cannot close Codex");
    }
  });
  const account = service.importCurrentAuth();

  assert.throws(() => service.setAccountHttpOnlyMode(account.id, true), /cannot close Codex/);

  const unchanged = service.listAccounts()[0];
  assert.equal(unchanged.httpOnlyModeEnabled, false);
  assert.equal(unchanged.httpOnlyModeOverride, false);
});

test("desktop continuation verification ignores only trailing rollout line endings", () => {
  const script = buildCodexDesktopContinuationScript("01234567-89ab-cdef-0123-456789abcdef");

  assert.match(script, /\.TrimEnd\(\[char\[\]\]"`r`n"\)/);
  assert.match(script, /\[StringComparison\]::Ordinal/);
  assert.match(script, /\[System\.IO\.File\]::Open\(\$path, \[System\.IO\.FileMode\]::Open, \[System\.IO\.FileAccess\]::Read, \[System\.IO\.FileShare\]::ReadWrite -bor \[System\.IO\.FileShare\]::Delete\)/);
  assert.match(script, /\$stream\.Seek\(\$offset, \[System\.IO\.SeekOrigin\]::Begin\)/);
  assert.match(script, /\$maxBytes = 2097152/);
  assert.doesNotMatch(script, /Get-Content -LiteralPath \$rollout\.FullName -Encoding UTF8 -Tail 256/);
  assert.match(script, /\[DateTimeOffset\]::Parse\(\[string\]\$entry\.timestamp\)\.UtcDateTime -lt \$startedAtUtc/);
  assert.doesNotMatch(script, /\.Trim\(\)/);
  assert.doesNotMatch(script, /\$content\.text -ceq \$expectedPrompt/);
});

test("desktop continuation reads a large active rollout within a fixed bound", { skip: process.platform !== "win32" }, () => {
  const root = makeTempRoot();
  const rollout = path.join(root, "large-active-rollout.jsonl");
  const handle = fs.openSync(rollout, "w+");
  try {
    fs.ftruncateSync(handle, 96 * 1024 * 1024);
    fs.writeSync(handle, "\n{\"probe\":true}\n", 96 * 1024 * 1024, "utf8");
    const generated = buildCodexDesktopContinuationScript("01234567-89ab-cdef-0123-456789abcdef");
    const helperStart = generated.indexOf("function Read-ContinuationTailLines");
    const helperEnd = generated.indexOf("function Test-ContinuationTurnStarted", helperStart);
    const encodedPath = Buffer.from(rollout, "utf8").toString("base64");
    const probe = [
      generated.slice(helperStart, helperEnd),
      `$path = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedPath}'))`,
      "$lines = @(Read-ContinuationTailLines $path)",
      "if (-not ($lines | Where-Object { $_ -eq '{\"probe\":true}' })) { throw 'bounded tail probe was not found' }"
    ].join("\n");
    const startedAt = Date.now();
    execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", probe], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 5_000
    });
    assert.ok(Date.now() - startedAt < 5_000);
  } finally {
    fs.closeSync(handle);
  }
});

test("desktop continuation invokes the actual submit button instead of injecting Enter", () => {
  const script = buildCodexDesktopContinuationScript("01234567-89ab-cdef-0123-456789abcdef");

  assert.match(script, /\[System\.Windows\.Automation\.AutomationElement\]::IsValuePatternAvailableProperty/);
  assert.match(script, /\[System\.Windows\.Automation\.InvokePattern\]::Pattern/);
  assert.doesNotMatch(script, /LegacyIAccessiblePattern/);
  assert.match(script, /\$walker = \[System\.Windows\.Automation\.TreeWalker\]::ControlViewWalker/);
  assert.match(script, /\$scope = \$walker\.GetParent\(\$scope\)/);
  assert.match(script, /\$scope\.Current\.ControlType -eq \[System\.Windows\.Automation\.ControlType\]::Window/);
  assert.match(script, /\$identity -match '\(\?i:send\|submit\|发送\|提交\)'/);
  assert.match(script, /if \(\$semantic -eq 0 -and -not \$rightEdgeFallback\) \{ continue \}/);
  assert.match(script, /if \(\$semanticSubmit\) \{ return \$semanticSubmit \}/);
  assert.match(script, /return \$fallbackSubmit/);
  assert.doesNotMatch(script, /if \(\$centerX -gt \$composerBounds\.Right\) \{ continue \}/);
  assert.match(script, /\$submit\.Invoke\.Invoke\(\)/);
  assert.match(script, /\$submit\.Element\.TryGetClickablePoint/);
  assert.match(script, /\$composerBounds\.Right - 96/);
  assert.match(script, /voice\|dictat\|microphone\|语音\|听写/);
  assert.match(script, /Test-ContinuationPromptValue/);
  assert.match(script, /Test-ContinuationPromptValue \$focusedValue \$prompt/);
  assert.doesNotMatch(script, /SendKeys|SendWait\('\{ENTER\}'\)/);
});

test("desktop continuation revalidates one visible submit control immediately before invocation", () => {
  const script = buildCodexDesktopContinuationScript("01234567-89ab-cdef-0123-456789abcdef");
  const focusIndex = script.indexOf("Write-ContinuationPhase 'focus_verified'");
  const refreshIndex = script.indexOf("$submit = Find-ContinuationSubmit $composer $elementProcessId", focusIndex);
  const invokeIndex = script.indexOf("Write-ContinuationPhase 'invoke_started'");

  assert.match(script, /-not \$control\.Current\.IsEnabled -or \$control\.Current\.IsOffscreen -or \$control\.Current\.ProcessId -ne \$processId/);
  assert.ok(focusIndex >= 0 && refreshIndex > focusIndex && invokeIndex > refreshIndex);
  assert.match(script.slice(refreshIndex, invokeIndex), /if \(-not \$submit\) \{ throw 'Codex continuation submit control was not found\.' \}/);
  assert.equal((script.match(/\$submit\.Invoke\.Invoke\(\)/g) || []).length, 1);
  assert.doesNotMatch(script, /DoDefaultAction/);
});

test("desktop continuation performs one independent fallback only after proving the primary action had no effect", () => {
  const script = buildCodexDesktopContinuationScript("01234567-89ab-cdef-0123-456789abcdef");
  const invokeIndex = script.indexOf("Write-ContinuationPhase 'invoke_started'");
  const noEffectIndex = script.indexOf("Write-ContinuationPhase 'invoke_no_effect'");
  const fallbackIndex = script.indexOf("Write-ContinuationPhase 'fallback_invoke_started'");
  const fallbackRefreshIndex = script.indexOf("$fallbackSubmit = Find-ContinuationSubmit $composer $elementProcessId", noEffectIndex);
  const rolloutGate = "if (Test-ContinuationTurnStarted $rollouts $continuationStartedAtUtc $prompt) { Write-Output 'turn_started'; exit 0 }";

  assert.ok(invokeIndex >= 0 && noEffectIndex > invokeIndex && fallbackRefreshIndex > noEffectIndex && fallbackIndex > fallbackRefreshIndex);
  assert.ok(script.indexOf(rolloutGate, noEffectIndex) < fallbackIndex);
  assert.match(script.slice(noEffectIndex, fallbackIndex), /Test-ContinuationPromptValue \$focusedValue \$prompt/);
  assert.match(script, /\$primaryAction -eq 'invoke' -and \$fallbackSubmit\.Element\.TryGetClickablePoint/);
  assert.match(script, /Element = \$control/);
  assert.doesNotMatch(script, /LegacyIAccessiblePattern/);
  assert.match(script, /\$fallbackSubmit\.Element\.TryGetClickablePoint/);
  assert.match(script, /\[CodexForegroundWindow\]::ClickAt/);
  assert.equal((script.match(/Write-ContinuationPhase 'fallback_invoke_started'/g) || []).length, 1);
  assert.doesNotMatch(script, /SendKeys|SendWait\('\{ENTER\}'\)/);
});

test("desktop continuation bounds each queue item before and after submit invocation", () => {
  const script = buildCodexDesktopContinuationScript("01234567-89ab-cdef-0123-456789abcdef");

  assert.match(script, /\$discoveryDeadline = \[DateTime\]::UtcNow\.AddSeconds\(10\)/);
  assert.match(script, /\$verificationDeadline = \[DateTime\]::UtcNow\.AddSeconds\(45\)/);
});

test("desktop continuation does not misreport a post-invocation draft as composer discovery failure", () => {
  const error = new Error("Codex continuation composer was not found.");

  assert.equal(
    desktopContinuationFailureReason(
      error,
      "Codex continuation composer was not found. Codex continuation prompt was not consumed.",
      true
    ),
    "prompt_not_consumed"
  );
});

test("desktop continuation does not classify generated command text as a failure", () => {
  const error = new Error("generated command contains prompt was not consumed marker");
  assert.equal(desktopContinuationFailureReason(error, "", true), "submission_error");
});

test("isolated submission verifier accepts delayed evidence after composer becomes unreadable", { skip: process.platform !== "win32" }, () => {
  const generated = buildCodexDesktopContinuationScript("01234567-89ab-cdef-0123-456789abcdef");
  const start = generated.indexOf("function Wait-ContinuationSubmission(");
  const end = generated.indexOf("\n$uri =", start);
  const verifier = generated.slice(start, end).replace("AddSeconds(45)", "AddSeconds(1)");
  const script = `$ErrorActionPreference = 'Stop'
${verifier}
$script:checks = 0
function Test-ContinuationTurnStarted { $script:checks++; return ($script:checks -ge 3) }
function Get-ContinuationComposerValue { throw 'stale test control' }
function Write-ContinuationPhase {}
function Test-ContinuationPromptValue { return $false }
$result = Wait-ContinuationSubmission $null @() ([DateTime]::UtcNow) 'test'
if ($result -ne 'turn_started') { throw 'Delayed evidence rejected' }
function Test-ContinuationTurnStarted { return $false }
$result = Wait-ContinuationSubmission $null @() ([DateTime]::UtcNow) 'test'
if ($result -ne 'turn_not_observed') { throw 'Unreadable control incorrectly permits retry' }
'delayed_verification_passed'`;
  assert.match(execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { encoding: "utf8", windowsHide: true, timeout: 10_000 }), /delayed_verification_passed/);
});

test("desktop continuation waits for the exact composer and its structural submit control together", () => {
  const script = buildCodexDesktopContinuationScript("01234567-89ab-cdef-0123-456789abcdef");

  assert.match(script, /\$submit = Find-ContinuationSubmit \$composer \$elementProcessId/);
  assert.match(script, /while \(\(-not \$composer -or -not \$submit\) -and \[DateTime\]::UtcNow -lt \$discoveryDeadline\)/);
  assert.match(script, /Codex continuation composer was not found/);
  assert.match(script, /Codex continuation submit control was not found/);
  assert.doesNotMatch(script, /composer or submit button was not found/);
});

test("desktop continuation accepts deep-link auto-submission before composer discovery", () => {
  const script = buildCodexDesktopContinuationScript("01234567-89ab-cdef-0123-456789abcdef");
  const durableGate = "if (Test-ContinuationTurnStarted $rollouts $continuationStartedAtUtc $prompt) { Write-Output 'turn_started'; exit 0 }";
  const launchIndex = script.indexOf("Start-Process -FilePath $uri");
  const firstGateIndex = script.indexOf(durableGate, launchIndex);
  const submitDiscoveryIndex = script.indexOf("$submit = Find-ContinuationSubmit $composer $composer.Current.ProcessId");
  const composerFailureIndex = script.indexOf("if (-not $composer) { throw 'Codex continuation composer was not found.' }");
  const finalPreFailureGateIndex = script.lastIndexOf(durableGate, composerFailureIndex);

  assert.ok(launchIndex >= 0 && firstGateIndex > launchIndex);
  assert.ok(firstGateIndex < submitDiscoveryIndex);
  assert.ok(finalPreFailureGateIndex > firstGateIndex && finalPreFailureGateIndex < composerFailureIndex);
});

test("desktop continuation retry checks durable evidence before reopening the deep link", () => {
  const script = buildCodexDesktopContinuationScript("01234567-89ab-cdef-0123-456789abcdef", {
    evidenceStartedAtMs: Date.UTC(2026, 8, 4, 1, 2, 3)
  });
  const durableGate = "if (Test-ContinuationTurnStarted $rollouts $continuationStartedAtUtc $prompt) { Write-Output 'turn_started'; exit 0 }";
  const firstGateIndex = script.indexOf(durableGate);
  const launchIndex = script.indexOf("Start-Process -FilePath $uri");

  assert.ok(firstGateIndex >= 0 && firstGateIndex < launchIndex);
  assert.match(script, /2026-09-04T01:02:03\.000Z/);
});

test("desktop continuation restores the exact Codex window and returns the previous foreground window", () => {
  const script = buildCodexDesktopContinuationScript("01234567-89ab-cdef-0123-456789abcdef");

  assert.match(script, /public static extern bool IsIconic\(IntPtr hWnd\)/);
  assert.match(script, /public static extern bool ShowWindowAsync\(IntPtr hWnd, int nCmdShow\)/);
  assert.match(script, /\$previousForeground = \[CodexForegroundWindow\]::GetForegroundWindow\(\)/);
  assert.match(script, /if \(\[CodexForegroundWindow\]::IsIconic\(\$windowHandle\)\) \{/);
  assert.match(script, /\[CodexForegroundWindow\]::ShowWindowAsync\(\$windowHandle, 9\)/);
  assert.match(script, /Restore-ContinuationForeground \$previousForeground \$windowHandle/);
  assert.match(script, /GetCursorPos/);
  assert.match(script, /SetCursorPos/);
  assert.match(script, /Restore-ContinuationCursor/);
  assert.doesNotMatch(script, /SendKeys/);
});

test("desktop continuation emits bounded phases around the irreversible submit boundary", () => {
  const script = buildCodexDesktopContinuationScript("01234567-89ab-cdef-0123-456789abcdef");
  const phases = [
    "deep_link_opened",
    "window_scan_started",
    "window_scan_completed",
    "composer_scan_started",
    "composer_scan_completed",
    "window_restored",
    "composer_found",
    "submit_found",
    "focus_verified",
    "invoke_started",
    "invoke_no_effect",
    "fallback_invoke_started"
  ];

  let previous = -1;
  for (const phase of phases) {
    const index = script.indexOf(`Write-ContinuationPhase '${phase}'`);
    assert.ok(index > previous, `${phase} phase must follow the preceding phase`);
    previous = index;
  }
  assert.match(script, /Write-ContinuationPhase 'prompt_consumed'/);
  assert.match(script, /\[Console\]::Out\.Flush\(\)/);
});

test("desktop continuation persists phases and treats an invoked but unverified submission as uncertain", async () => {
  const { userData, codexDir } = makeFixture();
  const nowMs = unixTestNow() * 1000;
  let phaseCallback;
  const operation = Promise.resolve(false);
  operation.failureReason = "submission_timeout";
  const service = createAccountService(userData, {
    codexDir,
    nowMs: () => nowMs,
    openCodexThread: (_threadId, options) => {
      phaseCallback = options.onPhase;
      phaseCallback("deep_link_opened");
      phaseCallback("focus_verified");
      phaseCallback("invoke_started");
      return operation;
    }
  });
  const ticket = service.prepareAutoResumeTicket({ threadId: "thread-limited", interruptedAtMs: nowMs - 1_000 });

  assert.deepEqual(await service.startPreparedAutoResume(ticket), { status: "uncertain" });
  assert.equal(typeof phaseCallback, "function");
  assert.deepEqual(
    {
      stage: service.getAutoResumeState().stage,
      desktopPhase: service.getAutoResumeState().desktopPhase,
      submitInvoked: service.getAutoResumeState().submitInvoked === true,
      failureReason: service.getAutoResumeState().failureReason
    },
    {
      stage: "uncertain",
      desktopPhase: "invoke_started",
      submitInvoked: true,
      failureReason: "submission_timeout"
    }
  );
});

test("desktop continuation treats a proven primary no-effect as failed when no fallback was attempted", async () => {
  const { userData, codexDir } = makeFixture();
  const nowMs = unixTestNow() * 1000;
  const operation = Promise.resolve(false);
  operation.failureReason = "prompt_not_consumed";
  const service = createAccountService(userData, {
    codexDir,
    nowMs: () => nowMs,
    openCodexThread: (_threadId, options) => {
      options.onPhase("invoke_started");
      options.onPhase("invoke_no_effect");
      return operation;
    }
  });
  const ticket = service.prepareAutoResumeTicket({ threadId: "thread-limited", interruptedAtMs: nowMs - 1_000 });

  assert.deepEqual(await service.startPreparedAutoResume(ticket), { status: "failed" });
  assert.deepEqual(
    {
      stage: service.getAutoResumeState().stage,
      desktopPhase: service.getAutoResumeState().desktopPhase,
      submitInvoked: service.getAutoResumeState().submitInvoked === true,
      failureReason: service.getAutoResumeState().failureReason
    },
    {
      stage: "failed",
      desktopPhase: "invoke_no_effect",
      submitInvoked: true,
      failureReason: "prompt_not_consumed"
    }
  );
});

test("persisted resume method matches the configured executor", () => {
  const desktopFixture = makeFixture();
  const desktop = createAccountService(desktopFixture.userData, {
    codexDir: desktopFixture.codexDir,
    nowMs: () => unixTestNow() * 1000
  });
  const desktopTicket = desktop.prepareAutoResumeTicket({
    threadId: "thread-desktop",
    interruptedAtMs: unixTestNow() * 1000 - 1_000
  });

  const serverFixture = makeFixture();
  const server = createAccountService(serverFixture.userData, {
    codexDir: serverFixture.codexDir,
    nowMs: () => unixTestNow() * 1000,
    resumeExecutorMode: "app-server"
  });
  const serverTicket = server.prepareAutoResumeTicket({
    threadId: "thread-server",
    interruptedAtMs: unixTestNow() * 1000 - 1_000
  });

  assert.equal(desktopTicket.resumeMethod, "desktop_ui_automation_v1");
  assert.equal(serverTicket.resumeMethod, "app_server_protocol_v1");
});

test("desktop continuation retains pre-invocation phase evidence in its final failure", async () => {
  const { userData, codexDir } = makeFixture();
  const nowMs = unixTestNow() * 1000;
  const operation = Promise.resolve(false);
  operation.failureReason = "foreground_changed";
  const service = createAccountService(userData, {
    codexDir,
    nowMs: () => nowMs,
    openCodexThread: (_threadId, { onPhase }) => {
      onPhase("deep_link_opened");
      onPhase("window_restored");
      return operation;
    }
  });
  const ticket = service.prepareAutoResumeTicket({ threadId: "thread-limited", interruptedAtMs: nowMs - 1_000 });

  assert.deepEqual(await service.startPreparedAutoResume(ticket), { status: "failed" });
  assert.deepEqual(
    {
      stage: service.getAutoResumeState().stage,
      desktopPhase: service.getAutoResumeState().desktopPhase,
      submitInvoked: service.getAutoResumeState().submitInvoked === true,
      failureReason: service.getAutoResumeState().failureReason
    },
    {
      stage: "failed",
      desktopPhase: "window_restored",
      submitInvoked: false,
      failureReason: "foreground_changed"
    }
  );
});

test("generated desktop PowerShell parses and every managed UI Automation type exists", { skip: process.platform !== "win32" }, () => {
  const generated = buildCodexDesktopContinuationScript("01234567-89ab-cdef-0123-456789abcdef");
  const check = [
    "$ErrorActionPreference = 'Stop'",
    "$ProgressPreference = 'SilentlyContinue'",
    "Add-Type -AssemblyName UIAutomationClient",
    "Add-Type -AssemblyName UIAutomationTypes",
    "$text = [Console]::In.ReadToEnd()",
    "$tokens = $null; $errors = $null",
    "$ast = [System.Management.Automation.Language.Parser]::ParseInput($text, [ref]$tokens, [ref]$errors)",
    "if ($errors.Count) { throw ($errors | Out-String) }",
    "$typeNodes = $ast.FindAll({ param($node) $node -is [System.Management.Automation.Language.TypeExpressionAst] -and $node.TypeName.FullName.StartsWith('System.Windows.Automation.') }, $true)",
    "foreach ($node in $typeNodes) { if (-not $node.TypeName.GetReflectionType()) { throw ('Missing UIA type: ' + $node.TypeName.FullName) } }",
    "Write-Output 'types_and_syntax_passed'"
  ].join("\n");
  assert.match(execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", check], { input: generated, encoding: "utf8", windowsHide: true, timeout: 10_000 }), /types_and_syntax_passed/);
});

test("desktop accessible composer helper handles Value Text and rejects readonly controls", { skip: process.platform !== "win32" }, () => {
  const generated = buildCodexDesktopContinuationScript("01234567-89ab-cdef-0123-456789abcdef");
  const helpers = generated.slice(generated.indexOf("function Add-ContinuationReadDiagnostic"), generated.indexOf("function Test-ContinuationTurnStarted"));
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$ProgressPreference = 'SilentlyContinue'",
    "Add-Type -AssemblyName UIAutomationClient",
    "Add-Type -AssemblyName UIAutomationTypes",
    helpers,
    "function New-FakeComposer($kind, $text, $readonly = $false) {",
    "  $range = [pscustomobject]@{ Text = $text; ReadOnly = $readonly }",
    "  $range | Add-Member ScriptMethod GetText { param($limit); return $this.Text }",
    "  $range | Add-Member ScriptMethod GetAttributeValue { param($attribute); return $this.ReadOnly }",
    "  $pattern = [pscustomobject]@{ Current = [pscustomobject]@{ Value = $text; IsReadOnly = $readonly; Role = 42; State = $(if ($readonly) { 64 } else { 0 }) }; DocumentRange = $range }",
    "  $control = [pscustomobject]@{ Kind = $kind; Pattern = $pattern; Current = [pscustomobject]@{ IsKeyboardFocusable = $true; ControlType = [System.Windows.Automation.ControlType]::Edit } }",
    "  $control | Add-Member ScriptMethod TryGetCurrentPattern { param($id, $result); if ($id.ProgrammaticName -eq ($this.Kind + 'PatternIdentifiers.Pattern')) { $result.Value = $this.Pattern; return $true }; return $false }",
    "  return $control",
    "}",
    "foreach ($kind in @('Value', 'Text')) {",
    "  $control = New-FakeComposer $kind 'continue'",
    "  if ((Get-ContinuationComposerValue $control) -cne 'continue') { throw ('read failed: ' + $kind) }",
    "  $empty = New-FakeComposer $kind ''",
    "  if ($null -eq (Get-ContinuationComposerValue $empty)) { throw ('empty value lost: ' + $kind) }",
    "  $readonly = New-FakeComposer $kind 'continue' $true",
    "  if ($null -ne (Get-ContinuationComposerValue $readonly)) { throw ('readonly admitted: ' + $kind) }",
    "  $control.Current.IsKeyboardFocusable = $false",
    "  if ($null -ne (Get-ContinuationComposerValue $control)) { throw ('noneditable admitted: ' + $kind) }",
    "}",
    "$unknown = New-FakeComposer 'Text' 'continue' 'unsupported'",
    "$diagnostics = @{}",
    "if ($null -ne (Get-ContinuationComposerValue $unknown $diagnostics) -or $diagnostics.readonlyUnknown -ne 1) { throw 'unknown readonly gate failed' }",
    "$unknown.Current.IsKeyboardFocusable = $false",
    "if ($null -ne (Get-ContinuationComposerValue $unknown $diagnostics) -or $diagnostics.notFocusable -ne 1) { throw 'focus diagnostic failed' }",
    "$ownerCache = @{}",
    "function Get-CimInstance { param($ClassName, $Filter, $ErrorAction); return [pscustomobject]@{ ExecutablePath = 'C:\\fake\\Codex.exe'; ParentProcessId = 1 } }",
    "if (-not (Test-ContinuationProcessOwner 2 1 'C:\\fake\\Codex.exe')) { throw 'child rejected' }",
    "$ownerCache = @{}",
    "if (Test-ContinuationProcessOwner 2 1 'C:\\other\\Codex.exe') { throw 'foreign executable admitted' }",
    "Write-Output 'isolated_helpers_passed'"
  ].join("\n");
  assert.match(execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { encoding: "utf8", windowsHide: true, timeout: 10_000 }), /isolated_helpers_passed/);
});

test("desktop discovery diagnostics allow only bounded numeric counters", () => {
  const generated = buildCodexDesktopContinuationScript("01234567-89ab-cdef-0123-456789abcdef");
  assert.ok(generated.indexOf('Wait-ContinuationAccessibility $desktop') < generated.indexOf('Start-Process -FilePath $uri'));
  assert.match(generated, /function Wait-ContinuationAccessibility/);
  assert.match(generated, /warmupReady/);
  const rejectionCounters = { notFocusable: 1, valueReadonly: 2, unsupportedControlType: 3, textReadonly: 4, readonlyUnknown: 5, patternUnavailable: 6, valueReadErrors: 7, textReadErrors: 8, propertyReadErrors: 9 };
  assert.deepEqual(normalizeDesktopDiscoveryDiagnostics({ ...rejectionCounters, rawError: 'private', controlName: 'private' }), rejectionCounters);
  assert.deepEqual(normalizeDesktopDiscoveryDiagnostics({ windows: 2, controls: 4, errors: 1, value: "private draft", token: "secret", mismatched: -1 }), { windows: 2, controls: 4, errors: 1 });
  assert.deepEqual(normalizeDesktopDiscoveryDiagnostics(null), {});
});

test("desktop composer discovery restores first and shares accessible text reading with verification", () => {
  const script = buildCodexDesktopContinuationScript("01234567-89ab-cdef-0123-456789abcdef");
  assert.ok(script.indexOf("ShowWindowAsync($windowHandle, 9)") < script.indexOf("Write-ContinuationPhase 'composer_scan_started'"));
  assert.match(script, /function Get-ContinuationComposerValue/);
  assert.match(script, /TextPattern\]::Pattern/);
  assert.match(script, /IsReadOnlyAttribute/);
  assert.match(script, /DocumentRange.GetText\(4096\)/);
  assert.match(script, /Get-ContinuationComposerValue \$focusedComposer/);
  assert.match(script, /Get-ContinuationComposerValue \$composer/);
  assert.match(script, /diagnostic:/);
  assert.match(script, /Test-ContinuationProcessOwner/);
  assert.doesNotMatch(script, /\$focusedValuePattern/);
});

for (const failureReason of ["composer_not_found", "submit_not_found", "foreground_changed"]) {
  test(`desktop continuation retries ${failureReason} only before invocation`, async () => {
    for (const invoked of [false, true]) {
      const { userData, codexDir } = makeFixture();
      let attempts = 0;
      const evidence = [];
      const service = createAccountService(userData, {
        codexDir, autoResumeDesktopRetryDelaysMs: [0], wait: async () => {},
        openCodexThread: (_id, { onPhase, evidenceStartedAtMs }) => {
          attempts++;
          evidence.push(evidenceStartedAtMs);
          onPhase(invoked ? "invoke_started" : "composer_scan_completed");
          const operation = Promise.resolve(false);
          operation.failureReason = failureReason;
          return operation;
        }
      });
      const ticket = service.prepareAutoResumeTicket({ threadId: "thread-limited", interruptedAtMs: Date.now() - 1000 });
      await service.startPreparedAutoResume(ticket);
      assert.equal(attempts, invoked ? 1 : 2);
      assert.equal(new Set(evidence).size, 1);
    }
  });
}

test("foreground recovery restores only the exact unsent interruption for tickets and queues", () => {
  for (const multi of [false, true]) for (const invoked of [false, true]) {
    const { userData, codexDir } = makeFixture();
    const service = createAccountService(userData, { codexDir });
    const candidates = [{ threadId: "task-a", interruptedAtMs: Date.now() - 2000 },
      { threadId: "task-b", interruptedAtMs: Date.now() - 1000 }];
    const decision = multi ? { status: "selected", candidates, candidateCount: 2 } : candidates[0];
    const state = service.prepareAutoResumeAttempt(decision);
    const finish = (stage) => multi
      ? service.finishAutoResumeQueueItem(state.attemptId, "task-a", stage, { failureReason: "foreground_changed" })
      : service.finishAutoResumeTicket(state.attemptId, stage, { failureReason: "foreground_changed" });
    finish("launch_verified");
    service.recordAutoResumeDesktopPhase(state.attemptId, "task-a", invoked ? "invoke_started" : "submit_found");
    finish("failed");
    const restored = service.prepareAutoResumeAttempt(decision);
    const item = multi ? restored.items[0] : restored;
    assert.equal(item?.stage, invoked ? (multi ? "failed" : undefined) : "prepared");
    if (!invoked) {
      assert.equal(restored.attemptId, state.attemptId);
      assert.equal(item.interruptedAtMs, candidates[0].interruptedAtMs);
      assert.equal(item.failureReason, undefined);
    }
  }
});

test("foreground recovery never resets cancelled completed uncertain or invoked items", () => {
  for (const multi of [false, true]) for (const statePatch of [
    { stage: "failed", failureReason: "task_cancelled" },
    { stage: "failed", failureReason: "submission_error" },
    { stage: "completed" }, { stage: "uncertain" },
    { stage: "failed", submitInvoked: true, desktopPhase: "invoke_no_effect" },
    { stage: "failed", desktopPhase: "invoke_started" }
  ]) {
    const { userData, codexDir } = makeFixture();
    const service = createAccountService(userData, { codexDir });
    const candidates = ["task-a", "task-b"].map((threadId) => ({ threadId, interruptedAtMs: Date.now() - 1000 }));
    const decision = multi ? { status: "selected", candidates, candidateCount: 2 } : candidates[0];
    const state = service.prepareAutoResumeAttempt(decision);
    const failure = { stage: "failed", failureReason: "foreground_changed", desktopPhase: "submit_found", submitInvoked: false, ...statePatch };
    service.writeAutoResumeState(multi ? { ...state, items: state.items.map((item) => ({ ...item, ...failure })) }
      : { ...state, ...failure });
    const before = service.getAutoResumeState();
    service.prepareAutoResumeAttempt(decision);
    assert.deepEqual(service.getAutoResumeState(), before);
  }
});

test("foreground retry lets all three queue items start", async () => {
  const { userData, codexDir } = makeFixture();
  const opened = [];
  const service = createAccountService(userData, {
    codexDir, autoResumeDesktopRetryDelaysMs: [0], wait: async () => {},
    openCodexThread: (threadId, { onPhase }) => {
      opened.push(threadId);
      onPhase("submit_found");
      const operation = Promise.resolve(opened.length !== 1);
      operation.failureReason = "foreground_changed";
      return operation;
    }
  });
  const queue = service.prepareAutoResumeQueue({ status: "selected", candidateCount: 3,
    candidates: ["task-a", "task-b", "task-c"].map((threadId) => ({ threadId, interruptedAtMs: Date.now() - 1000 })) });
  const result = await service.startPreparedAutoResumeQueue(queue);
  assert.deepEqual(opened, ["task-a", "task-a", "task-b", "task-c"]);
  assert.equal(result.started, 3);
});

test("desktop continuation retries one stalled pre-invocation process and then fails honestly", async () => {
  const { userData, codexDir } = makeFixture();
  const nowMs = unixTestNow() * 1000;
  const waits = [];
  const evidenceStarts = [];
  let attempts = 0;
  const service = createAccountService(userData, {
    codexDir,
    nowMs: () => nowMs,
    autoResumeDesktopRetryDelaysMs: [25],
    wait: async (delayMs) => waits.push(delayMs),
    openCodexThread: (_threadId, { onPhase, evidenceStartedAtMs }) => {
      attempts += 1;
      evidenceStarts.push(evidenceStartedAtMs);
      onPhase("deep_link_opened");
      const operation = Promise.resolve(false);
      operation.failureReason = "submission_timeout";
      operation.processOutcome = { source: "timeout" };
      return operation;
    }
  });
  const ticket = service.prepareAutoResumeTicket({ threadId: "thread-limited", interruptedAtMs: nowMs - 1_000 });

  assert.deepEqual(await service.startPreparedAutoResume(ticket), { status: "failed" });
  assert.equal(attempts, 2);
  assert.deepEqual(waits, [25]);
  assert.equal(Number.isFinite(evidenceStarts[0]), true);
  assert.deepEqual(evidenceStarts, [evidenceStarts[0], evidenceStarts[0]]);
  assert.equal(service.getAutoResumeState().stage, "failed");
  assert.equal(service.getAutoResumeState().failureReason, "submission_timeout");

  const events = fs.readFileSync(path.join(userData, "auto-switch-events.jsonl"), "utf8")
    .trim().split(/\r?\n/).map((line) => JSON.parse(line));
  const retry = events.find(({ type }) => type === "continuation_desktop_retry");
  assert.deepEqual(retry.details, {
    attempt: 2,
    lastPhase: "deep_link_opened",
    processOutcome: { source: "timeout" },
    reason: "submission_timeout"
  });
});

test("startup returns an interrupted pre-invocation Desktop attempt to prepared", () => {
  const { userData, codexDir } = makeFixture();
  const nowMs = unixTestNow() * 1000;
  const service = createAccountService(userData, { codexDir, nowMs: () => nowMs });
  const ticket = service.prepareAutoResumeTicket({ threadId: "thread-limited", interruptedAtMs: nowMs - 1_000 });
  service.finishAutoResumeTicket(ticket.attemptId, "launch_verified");
  service.recordAutoResumeDesktopPhase(ticket.attemptId, ticket.threadId, "window_restored");

  const restarted = createAccountService(userData, { codexDir, nowMs: () => nowMs + 1_000 });
  assert.deepEqual(
    {
      stage: restarted.getAutoResumeState().stage,
      priorStage: restarted.getAutoResumeState().priorStage,
      desktopPhase: restarted.getAutoResumeState().desktopPhase,
      submitInvoked: restarted.getAutoResumeState().submitInvoked === true
    },
    { stage: "prepared", priorStage: "launch_verified", desktopPhase: "window_restored", submitInvoked: false }
  );
});

test("startup resumes a recent pre-invocation Desktop attempt after Codex is available", async () => {
  const { userData, codexDir } = makeFixture();
  let nowMs = unixTestNow() * 1000;
  const service = createAccountService(userData, { codexDir, nowMs: () => nowMs });
  const ticket = service.prepareAutoResumeTicket({ threadId: "thread-limited", interruptedAtMs: nowMs - 1_000 });
  service.finishAutoResumeTicket(ticket.attemptId, "launch_verified");
  service.recordAutoResumeDesktopPhase(ticket.attemptId, ticket.threadId, "deep_link_opened");

  nowMs += 1_000;
  let opened = 0;
  const restarted = createAccountService(userData, {
    codexDir,
    nowMs: () => nowMs,
    codexLaunchRetryDelaysMs: [],
    countCodexDesktopProcessesAsync: async () => 1,
    openCodexThread: async () => {
      opened += 1;
      return true;
    }
  });

  assert.deepEqual(await restarted.resumeInterruptedAutoResume(), { status: "started" });
  assert.equal(opened, 1);
  assert.equal(restarted.getAutoResumeState().stage, "turn_started");
});

test("startup migrates a 2.18.5 mislabeled Desktop phase before safe recovery", async () => {
  const { userData, codexDir } = makeFixture();
  let nowMs = unixTestNow() * 1000;
  const service = createAccountService(userData, { codexDir, nowMs: () => nowMs });
  const ticket = service.prepareAutoResumeTicket({ threadId: "thread-limited", interruptedAtMs: nowMs - 1_000 });
  service.finishAutoResumeTicket(ticket.attemptId, "launch_verified");
  service.recordAutoResumeDesktopPhase(ticket.attemptId, ticket.threadId, "deep_link_opened");
  fs.writeFileSync(
    path.join(userData, "auto-resume-state.json"),
    JSON.stringify({ ...service.getAutoResumeState(), resumeMethod: "app_server_protocol_v1" }),
    "utf8"
  );

  nowMs += 1_000;
  const restarted = createAccountService(userData, {
    codexDir,
    nowMs: () => nowMs,
    codexLaunchRetryDelaysMs: [],
    countCodexDesktopProcessesAsync: async () => 1,
    openCodexThread: async () => true
  });

  assert.equal(restarted.getAutoResumeState().resumeMethod, "desktop_ui_automation_v1");
  assert.deepEqual(await restarted.resumeInterruptedAutoResume(), { status: "started" });
});

test("startup never converts a real app-server state without Desktop phase evidence", async () => {
  const { userData, codexDir } = makeFixture();
  let nowMs = unixTestNow() * 1000;
  const service = createAccountService(userData, {
    codexDir,
    nowMs: () => nowMs,
    resumeExecutorMode: "app-server"
  });
  const ticket = service.prepareAutoResumeTicket({ threadId: "thread-server", interruptedAtMs: nowMs - 1_000 });
  service.finishAutoResumeTicket(ticket.attemptId, "launch_verified");

  nowMs += 1_000;
  let opened = 0;
  const restarted = createAccountService(userData, {
    codexDir,
    nowMs: () => nowMs,
    codexLaunchRetryDelaysMs: [],
    countCodexDesktopProcessesAsync: async () => 1,
    openCodexThread: async () => {
      opened += 1;
      return true;
    }
  });

  assert.equal(restarted.getAutoResumeState().resumeMethod, "app_server_protocol_v1");
  assert.deepEqual(await restarted.resumeInterruptedAutoResume(), { status: "skipped" });
  assert.equal(opened, 0);
});

test("startup single-ticket recovery blocks account switching until continuation settles", async () => {
  const { userData, codexDir } = makeFixture();
  let nowMs = unixTestNow() * 1000;
  const service = createAccountService(userData, { codexDir, nowMs: () => nowMs });
  const ticket = service.prepareAutoResumeTicket({ threadId: "thread-limited", interruptedAtMs: nowMs - 1_000 });
  service.finishAutoResumeTicket(ticket.attemptId, "launch_verified");
  service.recordAutoResumeDesktopPhase(ticket.attemptId, ticket.threadId, "deep_link_opened");

  nowMs += 1_000;
  let releaseContinuation;
  const continuation = new Promise((resolve) => { releaseContinuation = resolve; });
  const restarted = createAccountService(userData, {
    codexDir,
    nowMs: () => nowMs,
    codexLaunchRetryDelaysMs: [],
    countCodexDesktopProcessesAsync: async () => 1,
    openCodexThread: () => continuation
  });

  const recovery = restarted.resumeInterruptedAutoResume();
  await new Promise((resolve) => setImmediate(resolve));
  const switchResult = await restarted.switchAccountPrioritized("another-account");
  assert.equal(switchResult.status, "continuation_in_progress");

  releaseContinuation(true);
  assert.deepEqual(await recovery, { status: "started" });
});

test("startup never submits an ordinary prepared ticket or an expired recovery", async () => {
  const { userData, codexDir } = makeFixture();
  let nowMs = unixTestNow() * 1000;
  let opened = 0;
  const service = createAccountService(userData, {
    codexDir,
    nowMs: () => nowMs,
    codexLaunchRetryDelaysMs: [],
    countCodexDesktopProcessesAsync: async () => 1,
    openCodexThread: async () => {
      opened += 1;
      return true;
    }
  });
  const ticket = service.prepareAutoResumeTicket({ threadId: "thread-limited", interruptedAtMs: nowMs - 1_000 });

  assert.deepEqual(await service.resumeInterruptedAutoResume(), { status: "skipped" });
  assert.equal(opened, 0);

  service.finishAutoResumeTicket(ticket.attemptId, "launch_verified");
  service.recordAutoResumeDesktopPhase(ticket.attemptId, ticket.threadId, "deep_link_opened");
  nowMs += 10 * 60_000 + 1;
  const restarted = createAccountService(userData, {
    codexDir,
    nowMs: () => nowMs,
    codexLaunchRetryDelaysMs: [],
    countCodexDesktopProcessesAsync: async () => 1,
    openCodexThread: async () => {
      opened += 1;
      return true;
    }
  });

  assert.deepEqual(await restarted.resumeInterruptedAutoResume(), { status: "failed" });
  assert.equal(opened, 0);
  assert.equal(restarted.getAutoResumeState().failureReason, "recovery_expired");
});

test("startup resumes every remaining prepared queue item after a safe pre-invocation interruption", async () => {
  const { userData, codexDir } = makeFixture();
  let nowMs = unixTestNow() * 1000;
  const service = createAccountService(userData, { codexDir, nowMs: () => nowMs });
  const queue = service.prepareAutoResumeQueue({
    status: "selected",
    candidateCount: 2,
    candidates: [
      { threadId: "thread-a", interruptedAtMs: nowMs - 2_000 },
      { threadId: "thread-b", interruptedAtMs: nowMs - 1_000 }
    ]
  });
  service.finishAutoResumeQueueItem(queue.attemptId, "thread-a", "launch_verified");
  service.recordAutoResumeDesktopPhase(queue.attemptId, "thread-a", "deep_link_opened");

  nowMs += 1_000;
  const opened = [];
  const restarted = createAccountService(userData, {
    codexDir,
    nowMs: () => nowMs,
    codexLaunchRetryDelaysMs: [],
    countCodexDesktopProcessesAsync: async () => 1,
    openCodexThread: async (threadId) => {
      opened.push(threadId);
      return true;
    }
  });

  const result = await restarted.resumeInterruptedAutoResume();
  assert.deepEqual(opened, ["thread-a", "thread-b"]);
  assert.equal(result.status, "multi_complete");
  assert.equal(result.started, 2);
});

test("startup preserves uncertainty after Desktop submit invocation begins", () => {
  const { userData, codexDir } = makeFixture();
  const nowMs = unixTestNow() * 1000;
  const service = createAccountService(userData, { codexDir, nowMs: () => nowMs });
  const ticket = service.prepareAutoResumeTicket({ threadId: "thread-limited", interruptedAtMs: nowMs - 1_000 });
  service.finishAutoResumeTicket(ticket.attemptId, "launch_verified");
  service.recordAutoResumeDesktopPhase(ticket.attemptId, ticket.threadId, "invoke_started");

  const restarted = createAccountService(userData, { codexDir, nowMs: () => nowMs + 1_000 });
  assert.deepEqual(
    {
      stage: restarted.getAutoResumeState().stage,
      priorStage: restarted.getAutoResumeState().priorStage,
      desktopPhase: restarted.getAutoResumeState().desktopPhase,
      submitInvoked: restarted.getAutoResumeState().submitInvoked === true
    },
    { stage: "uncertain", priorStage: "launch_verified", desktopPhase: "invoke_started", submitInvoked: true }
  );
  assert.deepEqual(
    restarted.prepareAutoResumeTicket({ threadId: ticket.threadId, interruptedAtMs: ticket.interruptedAtMs }),
    undefined
  );
});

test("startup safely recovers after the primary submit action was durably proven ineffective", async () => {
  const { userData, codexDir } = makeFixture();
  const nowMs = unixTestNow() * 1000;
  const service = createAccountService(userData, { codexDir, nowMs: () => nowMs });
  const ticket = service.prepareAutoResumeTicket({ threadId: "thread-limited", interruptedAtMs: nowMs - 1_000 });
  service.finishAutoResumeTicket(ticket.attemptId, "launch_verified");
  service.recordAutoResumeDesktopPhase(ticket.attemptId, ticket.threadId, "invoke_started");
  service.recordAutoResumeDesktopPhase(ticket.attemptId, ticket.threadId, "invoke_no_effect");

  const opened = [];
  const restarted = createAccountService(userData, {
    codexDir,
    nowMs: () => nowMs + 1_000,
    codexLaunchRetryDelaysMs: [],
    countCodexDesktopProcessesAsync: async () => 1,
    openCodexThread: async (threadId) => {
      opened.push(threadId);
      return true;
    }
  });

  assert.equal(restarted.getAutoResumeState().stage, "prepared");
  assert.equal(restarted.getAutoResumeState().priorStage, "launch_verified");
  assert.equal(restarted.getAutoResumeState().desktopPhase, "invoke_no_effect");
  assert.deepEqual(await restarted.resumeInterruptedAutoResume(), { status: "started" });
  assert.deepEqual(opened, ["thread-limited"]);
});

test("startup never retries after the fallback submit boundary begins", () => {
  const { userData, codexDir } = makeFixture();
  const nowMs = unixTestNow() * 1000;
  const service = createAccountService(userData, { codexDir, nowMs: () => nowMs });
  const ticket = service.prepareAutoResumeTicket({ threadId: "thread-limited", interruptedAtMs: nowMs - 1_000 });
  service.finishAutoResumeTicket(ticket.attemptId, "launch_verified");
  service.recordAutoResumeDesktopPhase(ticket.attemptId, ticket.threadId, "invoke_started");
  service.recordAutoResumeDesktopPhase(ticket.attemptId, ticket.threadId, "invoke_no_effect");
  service.recordAutoResumeDesktopPhase(ticket.attemptId, ticket.threadId, "fallback_invoke_started");

  const restarted = createAccountService(userData, { codexDir, nowMs: () => nowMs + 1_000 });
  assert.equal(restarted.getAutoResumeState().stage, "uncertain");
  assert.equal(restarted.getAutoResumeState().desktopPhase, "fallback_invoke_started");
  assert.deepEqual(
    restarted.prepareAutoResumeTicket({ threadId: ticket.threadId, interruptedAtMs: ticket.interruptedAtMs }),
    undefined
  );
});

test("desktop continuation persists and logs a bounded submission failure reason", async () => {
  const { userData, codexDir } = makeFixture();
  const nowMs = unixTestNow() * 1000;
  const operation = Promise.resolve(false);
  operation.failureReason = "submit_not_found";
  const service = createAccountService(userData, {
    codexDir,
    nowMs: () => nowMs,
    openCodexThread: () => operation
  });
  const ticket = service.prepareAutoResumeTicket({ threadId: "thread-limited", interruptedAtMs: nowMs - 1_000 });

  assert.deepEqual(await service.startPreparedAutoResume(ticket), { status: "failed" });
  assert.equal(service.getAutoResumeState().failureReason, "submit_not_found");
  const event = fs.readFileSync(path.join(userData, "auto-switch-events.jsonl"), "utf8")
    .trim().split(/\r?\n/).map((line) => JSON.parse(line))
    .find(({ type }) => type === "continuation_ticket_finished");
  assert.deepEqual(event.details, {
    threadId: "thread-limited",
    stage: "failed",
    reason: "submit_not_found"
  });
});

test("desktop continuation queue records one bounded result event per candidate", async () => {
  const { userData, codexDir } = makeFixture();
  const nowMs = unixTestNow() * 1000;
  const outcomes = [true, false];
  const service = createAccountService(userData, {
    codexDir,
    nowMs: () => nowMs,
    openCodexThread: async () => outcomes.shift()
  });
  const queue = service.prepareAutoResumeQueue({
    status: "selected",
    candidateCount: 2,
    candidates: [
      { threadId: "thread-a", interruptedAtMs: nowMs - 2_000 },
      { threadId: "thread-b", interruptedAtMs: nowMs - 1_000 }
    ]
  });

  const result = await service.startPreparedAutoResumeQueue(queue);
  const events = fs.readFileSync(path.join(userData, "auto-switch-events.jsonl"), "utf8")
    .trim().split(/\r?\n/).map((line) => JSON.parse(line))
    .filter((event) => event.type === "continuation_queue_item_finished");

  assert.equal(result.total, 2);
  assert.equal(result.started, 1);
  assert.equal(result.failed, 1);
  assert.equal(result.status, "multi_complete");
  assert.deepEqual(events.map(({ details }) => details), [
    { threadId: "thread-a", stage: "started", reason: "turn_observed" },
    { threadId: "thread-b", stage: "failed", reason: "turn_not_observed" }
  ]);
});

test("one exact candidate reuses its prepared queue item without retrying an uncertain sibling", async () => {
  const { userData, codexDir } = makeFixture();
  const nowMs = unixTestNow() * 1000;
  const opened = [];
  const service = createAccountService(userData, {
    codexDir,
    nowMs: () => nowMs,
    openCodexThread: async (threadId) => {
      opened.push(threadId);
      return true;
    }
  });
  const queue = service.prepareAutoResumeQueue({
    status: "selected",
    candidateCount: 2,
    candidates: [
      { threadId: "thread-prepared", interruptedAtMs: nowMs - 2_000 },
      { threadId: "thread-uncertain", interruptedAtMs: nowMs - 1_000 }
    ]
  });
  service.finishAutoResumeQueueItem(queue.attemptId, "thread-uncertain", "launch_verified");
  service.recordAutoResumeDesktopPhase(queue.attemptId, "thread-uncertain", "invoke_started");
  service.finishAutoResumeQueueItem(queue.attemptId, "thread-uncertain", "uncertain", {
    failureReason: "submission_timeout"
  });

  const reused = service.prepareAutoResumeAttempt({
    status: "selected",
    candidateCount: 1,
    candidate: { threadId: "thread-prepared", interruptedAtMs: nowMs - 2_000 }
  });

  assert.equal(reused.attemptId, queue.attemptId);
  assert.deepEqual(reused.items.map(({ threadId, stage, submitInvoked }) => ({
    threadId,
    stage,
    submitInvoked: submitInvoked === true
  })), [
    { threadId: "thread-prepared", stage: "prepared", submitInvoked: false },
    { threadId: "thread-uncertain", stage: "uncertain", submitInvoked: true }
  ]);

  await service.startPreparedAutoResumeQueue(reused);

  assert.deepEqual(opened, ["thread-prepared"]);
  assert.equal(service.getAutoResumeState().items[1].stage, "uncertain");
  assert.equal(service.getAutoResumeState().items[1].submitInvoked, true);
});

test("the exact 2.18.7 retained-prompt queue is retried on the next switch", async () => {
  const { userData, codexDir } = makeFixture();
  const nowMs = unixTestNow() * 1000;
  const opened = [];
  const service = createAccountService(userData, {
    codexDir,
    nowMs: () => nowMs,
    openCodexThread: async (threadId) => {
      opened.push(threadId);
      return true;
    }
  });
  const decision = {
    status: "selected",
    candidateCount: 2,
    candidates: [
      { threadId: "thread-a", interruptedAtMs: nowMs - 2_000 },
      { threadId: "thread-b", interruptedAtMs: nowMs - 1_000 }
    ]
  };
  const queue = service.prepareAutoResumeQueue(decision);
  for (const item of queue.items) {
    service.finishAutoResumeQueueItem(queue.attemptId, item.threadId, "launch_verified");
    service.recordAutoResumeDesktopPhase(queue.attemptId, item.threadId, "invoke_started");
    service.finishAutoResumeQueueItem(queue.attemptId, item.threadId, "uncertain", {
      failureReason: "prompt_not_consumed"
    });
  }

  const reused = service.prepareAutoResumeQueue(decision);

  assert.equal(reused.attemptId, queue.attemptId);
  assert.deepEqual(reused.items.map(({ stage, desktopPhase, failureReason, submitInvoked }) => ({
    stage,
    desktopPhase,
    failureReason,
    submitInvoked: submitInvoked === true
  })), [
    { stage: "prepared", desktopPhase: undefined, failureReason: undefined, submitInvoked: false },
    { stage: "prepared", desktopPhase: undefined, failureReason: undefined, submitInvoked: false }
  ]);

  const result = await service.startPreparedAutoResumeQueue(reused);
  assert.deepEqual(opened, ["thread-a", "thread-b"]);
  assert.equal(result.started, 2);
});

test("the exact 2.18.7 retained-prompt single ticket is retried on the next switch", () => {
  const { userData, codexDir } = makeFixture();
  const nowMs = unixTestNow() * 1000;
  const service = createAccountService(userData, { codexDir, nowMs: () => nowMs });
  const ticket = service.prepareAutoResumeTicket({ threadId: "thread-a", interruptedAtMs: nowMs - 1_000 });
  service.finishAutoResumeTicket(ticket.attemptId, "launch_verified");
  service.recordAutoResumeDesktopPhase(ticket.attemptId, ticket.threadId, "invoke_started");
  service.finishAutoResumeTicket(ticket.attemptId, "uncertain", { failureReason: "prompt_not_consumed" });

  const reused = service.prepareAutoResumeTicket({
    threadId: ticket.threadId,
    interruptedAtMs: ticket.interruptedAtMs
  });

  assert.equal(reused.attemptId, ticket.attemptId);
  assert.equal(reused.stage, "prepared");
  assert.equal(reused.priorStage, undefined);
  assert.equal(reused.desktopPhase, undefined);
  assert.equal(reused.failureReason, undefined);
  assert.equal(reused.submitInvoked, undefined);
});

test("one candidate fails closed when an existing queue has another prepared sibling", () => {
  const { userData, codexDir } = makeFixture();
  const nowMs = unixTestNow() * 1000;
  const service = createAccountService(userData, { codexDir, nowMs: () => nowMs });
  const queue = service.prepareAutoResumeQueue({
    status: "selected",
    candidateCount: 2,
    candidates: [
      { threadId: "thread-selected", interruptedAtMs: nowMs - 2_000 },
      { threadId: "thread-unmatched", interruptedAtMs: nowMs - 1_000 }
    ]
  });

  const result = service.prepareAutoResumeAttempt({
    status: "selected",
    candidateCount: 1,
    candidate: { threadId: "thread-selected", interruptedAtMs: nowMs - 2_000 }
  });

  assert.deepEqual(result, { status: "needs_attention", candidateCount: 1 });
  assert.deepEqual(service.getAutoResumeState(), queue);
});

test("newer interruptions supersede stale Desktop started receipts without replaying old work", () => {
  for (const method of ['desktop_ui_automation_v1', 'app_server_protocol_v1']) {
    const { userData, codexDir } = makeFixture();
    let nowMs = unixTestNow() * 1000;
    const service = createAccountService(userData, { codexDir, nowMs: () => nowMs });
    const decision = { status: 'selected', candidateCount: 1, candidate: { threadId: 'old-task', interruptedAtMs: nowMs - 1000 } };
    const ticket = service.prepareAutoResumeAttempt(decision);
    service.finishAutoResumeTicket(ticket.attemptId, 'launch_verified');
    service.finishAutoResumeTicket(ticket.attemptId, 'turn_started');
    const state = service.getAutoResumeState();
    service.writeAutoResumeState({ ...state, resumeMethod: method });
    nowMs += 11 * 60 * 1000;
    service.prepareAutoResumeAttempt(decision);
    assert.equal(service.getAutoResumeState().attemptId, ticket.attemptId);
    const replacement = service.prepareAutoResumeAttempt({ ...decision, candidate: { threadId: 'new-task', interruptedAtMs: nowMs - 1000 } });
    if (method === 'desktop_ui_automation_v1') assert.equal(replacement.stage, 'prepared');
    else assert.equal(replacement.status, 'needs_attention');
  }
});

test("newer interruptions supersede stale Desktop started queue receipts", () => {
  const { userData, codexDir } = makeFixture();
  let nowMs = unixTestNow() * 1000;
  const service = createAccountService(userData, { codexDir, nowMs: () => nowMs });
  const queue = service.prepareAutoResumeQueue({ status: 'selected', candidateCount: 2, candidates: [
    { threadId: 'old-a', interruptedAtMs: nowMs - 2000 },
    { threadId: 'old-b', interruptedAtMs: nowMs - 1000 }
  ] });
  for (const item of queue.items) {
    service.finishAutoResumeQueueItem(queue.attemptId, item.threadId, 'launch_verified');
    service.finishAutoResumeQueueItem(queue.attemptId, item.threadId, 'turn_started');
  }
  nowMs += 11 * 60 * 1000;
  const replacement = service.prepareAutoResumeAttempt({ status: 'selected', candidateCount: 1,
    candidate: { threadId: 'new-task', interruptedAtMs: nowMs - 1000 } });
  assert.equal(replacement.stage, 'prepared');
  assert.notEqual(replacement.attemptId, queue.attemptId);
});

test("strictly newer interruptions supersede a stale prepared and uncertain queue", async () => {
  const { userData, codexDir } = makeFixture();
  let nowMs = unixTestNow() * 1000;
  const opened = [];
  const service = createAccountService(userData, {
    codexDir,
    nowMs: () => nowMs,
    openCodexThread: async (threadId) => {
      opened.push(threadId);
      return true;
    }
  });
  const oldQueue = service.prepareAutoResumeQueue({
    status: "selected",
    candidateCount: 2,
    candidates: [
      { threadId: "thread-old-prepared", interruptedAtMs: nowMs - 2_000 },
      { threadId: "thread-old-uncertain", interruptedAtMs: nowMs - 1_000 }
    ]
  });
  service.finishAutoResumeQueueItem(oldQueue.attemptId, "thread-old-uncertain", "launch_verified");
  service.recordAutoResumeDesktopPhase(oldQueue.attemptId, "thread-old-uncertain", "invoke_started");
  service.finishAutoResumeQueueItem(oldQueue.attemptId, "thread-old-uncertain", "uncertain", {
    failureReason: "submission_timeout"
  });
  const oldUpdatedAtMs = service.getAutoResumeState().updatedAtMs;
  nowMs += 11 * 60 * 1_000;

  const replacement = service.prepareAutoResumeAttempt({
    status: "selected",
    candidateCount: 2,
    candidates: [
      { threadId: "thread-new-first", interruptedAtMs: nowMs - 2_000 },
      { threadId: "thread-new-second", interruptedAtMs: nowMs - 1_000 }
    ]
  });

  assert.notEqual(replacement.attemptId, oldQueue.attemptId);
  assert.ok(replacement.createdAtMs > oldUpdatedAtMs);
  assert.deepEqual(replacement.items.map(({ threadId, stage }) => ({ threadId, stage })), [
    { threadId: "thread-new-first", stage: "prepared" },
    { threadId: "thread-new-second", stage: "prepared" }
  ]);
  await service.startPreparedAutoResumeQueue(replacement);
  assert.deepEqual(opened, ["thread-new-first", "thread-new-second"]);
});

test("a stale mixed queue still blocks candidates that are not all strictly newer", () => {
  const { userData, codexDir } = makeFixture();
  let nowMs = unixTestNow() * 1000;
  const service = createAccountService(userData, { codexDir, nowMs: () => nowMs });
  const oldQueue = service.prepareAutoResumeQueue({
    status: "selected",
    candidateCount: 2,
    candidates: [
      { threadId: "thread-old-prepared", interruptedAtMs: nowMs - 2_000 },
      { threadId: "thread-old-uncertain", interruptedAtMs: nowMs - 1_000 }
    ]
  });
  service.finishAutoResumeQueueItem(oldQueue.attemptId, "thread-old-uncertain", "launch_verified");
  service.recordAutoResumeDesktopPhase(oldQueue.attemptId, "thread-old-uncertain", "invoke_started");
  service.finishAutoResumeQueueItem(oldQueue.attemptId, "thread-old-uncertain", "uncertain", {
    failureReason: "submission_timeout"
  });
  const oldUpdatedAtMs = service.getAutoResumeState().updatedAtMs;
  nowMs += 11 * 60 * 1_000;

  const result = service.prepareAutoResumeAttempt({
    status: "selected",
    candidateCount: 2,
    candidates: [
      { threadId: "thread-new", interruptedAtMs: nowMs - 1_000 },
      { threadId: "thread-not-newer", interruptedAtMs: oldUpdatedAtMs }
    ]
  });

  assert.deepEqual(result, { status: "needs_attention", candidateCount: 2 });
  assert.equal(service.getAutoResumeState().attemptId, oldQueue.attemptId);
});

test("continuation progress derives discovery and verification countdowns from persisted deadlines", () => {
  const { userData, codexDir } = makeFixture();
  let nowMs = unixTestNow() * 1000;
  const service = createAccountService(userData, { codexDir, nowMs: () => nowMs });
  const queue = service.prepareAutoResumeQueue({
    status: "selected",
    candidateCount: 3,
    candidates: [
      { threadId: "thread-current", interruptedAtMs: nowMs - 3_000 },
      { threadId: "thread-next", interruptedAtMs: nowMs - 2_000 },
      { threadId: "thread-last", interruptedAtMs: nowMs - 1_000 }
    ]
  });
  service.finishAutoResumeQueueItem(queue.attemptId, "thread-current", "launch_verified");
  service.recordAutoResumeDesktopPhase(queue.attemptId, "thread-current", "deep_link_opened");
  nowMs += 3_000;

  const discovery = service.getAutoResumeStatus();
  assert.deepEqual({
    status: discovery.status,
    total: discovery.total,
    pending: discovery.pending,
    currentIndex: discovery.currentIndex,
    currentStage: discovery.currentStage,
    desktopPhase: discovery.desktopPhase,
    phaseRemainingSeconds: discovery.phaseRemainingSeconds,
    queueRemainingUpperBoundSeconds: discovery.queueRemainingUpperBoundSeconds
  }, {
    status: "multi_pending",
    total: 3,
    pending: 3,
    currentIndex: 1,
    currentStage: "launch_verified",
    desktopPhase: "deep_link_opened",
    phaseRemainingSeconds: 7,
    queueRemainingUpperBoundSeconds: 247
  });
  assert.doesNotMatch(JSON.stringify(discovery), /thread-current|thread-next|thread-last/);

  service.recordAutoResumeDesktopPhase(queue.attemptId, "thread-current", "invoke_started");
  nowMs += 2_000;
  const verification = service.getAutoResumeStatus();
  assert.equal(verification.phaseRemainingSeconds, 43);
  assert.equal(verification.queueRemainingUpperBoundSeconds, 283);

  service.recordAutoResumeDesktopPhase(queue.attemptId, "thread-current", "fallback_invoke_started");
  nowMs += 1_000;
  const fallbackVerification = service.getAutoResumeStatus();
  assert.equal(fallbackVerification.phaseRemainingSeconds, 44);
  assert.equal(fallbackVerification.queueRemainingUpperBoundSeconds, 284);
});

test("automatic and manual switching share one continuation preparation function", () => {
  const source = fs.readFileSync(new URL("../src/services/account-service.js", import.meta.url), "utf8");
  assert.ok((source.match(/this\.prepareAutoResumeAttempt\(/g) ?? []).length >= 2);
});

test("scopes resume discovery to the persisted current-account interval", async () => {
  const { userData, codexDir } = makeFixture();
  const nowMs = unixTestNow() * 1000;
  const captured = [];
  const service = createAccountService(userData, {
    codexDir,
    nowMs: () => nowMs,
    writeObservationState: () => {},
    selectQuotaInterruptedThread: (options) => {
      captured.push(options);
      return { status: "none", candidateCount: 0 };
    }
  });
  fs.writeFileSync(path.join(codexDir, "auth.json"), JSON.stringify({ access_token: "current", account_id: "acct-current" }), "utf8");
  const current = service.importCurrentAuth();
  const cycleStartedAtMs = nowMs - (8 * 60 * 60 * 1_000);
  const observationPath = path.join(userData, "usage-observations.json");
  fs.writeFileSync(observationPath, JSON.stringify({
    version: 1,
    intervals: [{ accountId: current.id, startMs: cycleStartedAtMs, source: "test" }],
    quotaSnapshots: [],
    resetEvents: [],
    pendingResets: []
  }), "utf8");

  service.selectAutoResumeDecision({ isBusy: false, activeThreadIds: [] });
  assert.equal(captured.at(-1).minInterruptedAtMs, cycleStartedAtMs);
  assert.equal(captured.at(-1).lookbackMs, nowMs - cycleStartedAtMs);
  assert.equal(captured.at(-1).selectAllCandidates, true);

  await service.selectAutoResumeDecisionAsync({ isBusy: false, activeThreadIds: [] });
  assert.equal(captured.at(-1).minInterruptedAtMs, cycleStartedAtMs);
  assert.equal(captured.at(-1).lookbackMs, nowMs - cycleStartedAtMs);

  await service.refreshQuotaInterruptionEvidence();
  assert.equal(captured.at(-1).minInterruptedAtMs, cycleStartedAtMs);
  assert.equal(captured.at(-1).selectAllCandidates, true);

  fs.writeFileSync(observationPath, JSON.stringify({
    version: 1,
    intervals: [{ accountId: "different-account", startMs: cycleStartedAtMs, source: "test" }],
    quotaSnapshots: [],
    resetEvents: [],
    pendingResets: []
  }), "utf8");
  service.selectAutoResumeDecision({ isBusy: false, activeThreadIds: [] });
  assert.equal(captured.at(-1).minInterruptedAtMs, nowMs);
});

test("projects quota exhaustion from a multi-task interruption decision", () => {
  const { userData, codexDir } = makeFixture();
  const nowMs = unixTestNow() * 1000;
  const service = createAccountService(userData, { codexDir, nowMs: () => nowMs, writeObservationState: () => {} });
  fs.writeFileSync(path.join(codexDir, "auth.json"), JSON.stringify({ access_token: "current", account_id: "acct-current" }), "utf8");
  const current = service.importCurrentAuth();
  fs.writeFileSync(path.join(userData, "usage-observations.json"), JSON.stringify({
    version: 1,
    intervals: [{ accountId: current.id, startMs: nowMs - 60 * 60 * 1_000, source: "test" }],
    quotaSnapshots: [],
    resetEvents: [],
    pendingResets: []
  }), "utf8");
  service.quotaInterruptionEvidenceCache = {
    checkedAtMs: nowMs,
    expiresAtMs: nowMs + 5_000,
    decision: {
      status: "selected",
      candidateCount: 2,
      candidates: [
        { threadId: "thread-a", interruptedAtMs: nowMs - 2_000 },
        { threadId: "thread-b", interruptedAtMs: nowMs - 1_000 }
      ]
    }
  };
  const usage = {
    fetchedAt: nowMs / 1_000,
    fiveHour: {
      usedPercent: 70,
      remainingPercent: 30,
      resetAt: (nowMs + 60 * 60 * 1_000) / 1_000,
      windowSeconds: 5 * 60 * 60
    }
  };

  const projected = service.usageWithCodexExhaustionEvidence({ id: current.id, usage });

  assert.equal(projected.fiveHour.usedPercent, 70);
  assert.equal(projected.fiveHour.remainingPercent, 30);
  assert.equal(projected.executionLimited, true);
  assert.equal(projected.executionLimitWindow, "fiveHour");
  assert.equal(projected.executionLimitSource, "codex_usage_limit_exceeded");
});

test("projects execution limits only from quota-limited continuation candidates", () => {
  const { userData, codexDir } = makeFixture();
  const nowMs = unixTestNow() * 1000;
  const service = createAccountService(userData, { codexDir, nowMs: () => nowMs, writeObservationState: () => {} });
  fs.writeFileSync(path.join(codexDir, "auth.json"), JSON.stringify({ access_token: "current", account_id: "acct-current" }), "utf8");
  const current = service.importCurrentAuth();
  const cycleStartedAtMs = nowMs - 60 * 60 * 1_000;
  fs.writeFileSync(path.join(userData, "usage-observations.json"), JSON.stringify({
    version: 1,
    intervals: [{ accountId: current.id, startMs: cycleStartedAtMs, source: "test" }],
    quotaSnapshots: [],
    resetEvents: [],
    pendingResets: []
  }), "utf8");
  const usage = {
    fetchedAt: nowMs / 1_000,
    fiveHour: {
      usedPercent: 43,
      remainingPercent: 57,
      resetAt: (nowMs + 60 * 60 * 1_000) / 1_000,
      windowSeconds: 5 * 60 * 60
    },
    oneWeek: {
      usedPercent: 23,
      remainingPercent: 77,
      resetAt: (nowMs + 24 * 60 * 60 * 1_000) / 1_000,
      windowSeconds: 7 * 24 * 60 * 60
    }
  };
  service.quotaInterruptionEvidenceCache = {
    checkedAtMs: nowMs,
    expiresAtMs: nowMs + 5_000,
    decision: {
      status: "selected",
      candidateCount: 3,
      candidates: [
        { threadId: "thread-active", interruptedAtMs: nowMs - 1_000, reason: "switch_interrupted_active_thread" },
        { threadId: "thread-overloaded", interruptedAtMs: nowMs - 2_000, reason: "server_overloaded" },
        { threadId: "thread-failed", interruptedAtMs: nowMs - 3_000, reason: "task_failed" }
      ]
    }
  };

  assert.equal(service.usageWithCodexExhaustionEvidence({ id: current.id, usage }), usage);

  service.quotaInterruptionEvidenceCache.decision.candidates.push({
    threadId: "thread-limited",
    interruptedAtMs: nowMs - 4_000,
    reason: "usage_limit_exceeded"
  });
  const projected = service.usageWithCodexExhaustionEvidence({ id: current.id, usage });
  assert.equal(projected.executionLimited, true);
  assert.equal(projected.executionLimitSource, "codex_usage_limit_exceeded");
  assert.equal(projected.executionLimitedAtMs, nowMs - 4_000);

  service.quotaInterruptionEvidenceCache.decision.candidates = [{
    threadId: "thread-old-limit",
    interruptedAtMs: cycleStartedAtMs - 1,
    reason: "usage_limit_exceeded"
  }];
  assert.equal(service.usageWithCodexExhaustionEvidence({ id: current.id, usage }), usage);
});

test("active continuation evidence cannot enter the quota automatic-switch path", async () => {
  const { userData, codexDir } = makeFixture();
  const nowMs = unixTestNow() * 1000;
  const activeDecision = {
    status: "selected",
    candidateCount: 1,
    candidate: {
      threadId: "thread-active",
      interruptedAtMs: nowMs - 1_000,
      reason: "switch_interrupted_active_thread"
    }
  };
  const service = createAccountService(userData, {
    codexDir,
    nowMs: () => nowMs,
    writeObservationState: () => {},
    selectQuotaInterruptedThread: () => activeDecision
  });
  fs.writeFileSync(path.join(codexDir, "auth.json"), JSON.stringify({ access_token: "current", account_id: "acct-current" }), "utf8");
  const current = service.importCurrentAuth();
  fs.writeFileSync(path.join(userData, "usage-observations.json"), JSON.stringify({
    version: 1,
    intervals: [{ accountId: current.id, startMs: nowMs - 60 * 60 * 1_000, source: "test" }],
    quotaSnapshots: [],
    resetEvents: [],
    pendingResets: []
  }), "utf8");
  const storePath = path.join(userData, "accounts-store.json");
  const store = JSON.parse(fs.readFileSync(storePath, "utf8"));
  store.accounts[0].status = "ready";
  store.accounts[0].usage = {
    fetchedAt: nowMs / 1_000,
    fiveHour: {
      usedPercent: 43,
      remainingPercent: 57,
      resetAt: (nowMs + 60 * 60 * 1_000) / 1_000,
      windowSeconds: 5 * 60 * 60
    },
    oneWeek: {
      usedPercent: 23,
      remainingPercent: 77,
      resetAt: (nowMs + 24 * 60 * 60 * 1_000) / 1_000,
      windowSeconds: 7 * 24 * 60 * 60
    }
  };
  fs.writeFileSync(storePath, JSON.stringify(store), "utf8");
  service.updateSettings({ autoSwitchEnabled: true });

  const result = await service.evaluateAutoSwitch("test");

  assert.deepEqual(result, { status: "idle", reason: "current_available" });
  assert.equal(service.listAccounts().find((account) => account.isCurrent).usage.executionLimited, undefined);
});

test("same-account confirmation and startup reconciliation preserve the account cycle", () => {
  const { userData, codexDir } = makeFixture();
  const nowMs = unixTestNow() * 1000;
  const service = createAccountService(userData, { codexDir, nowMs: () => nowMs, writeObservationState: () => {} });
  fs.writeFileSync(path.join(codexDir, "auth.json"), JSON.stringify({ access_token: "current", account_id: "acct-current" }), "utf8");
  const current = service.importCurrentAuth();
  const observationPath = path.join(userData, "usage-observations.json");
  const original = JSON.parse(fs.readFileSync(observationPath, "utf8"));
  const startedAtMs = original.intervals.at(-1).startMs;

  service.recordActiveAccount(current.id, "current_confirmed");
  const reloaded = createAccountService(userData, { codexDir, nowMs: () => nowMs + 60_000, writeObservationState: () => {} });
  reloaded.reconcileActiveAccount("startup");

  const state = JSON.parse(fs.readFileSync(observationPath, "utf8"));
  assert.equal(state.intervals.length, 1);
  assert.equal(state.intervals[0].accountId, current.id);
  assert.equal(state.intervals[0].startMs, startedAtMs);
  assert.equal(state.intervals[0].endMs, undefined);
});

test("manual continuation selects every quota interruption from the frozen source cycle", async () => {
  const { userData, codexDir } = makeFixture();
  const nowMs = unixTestNow() * 1000;
  const expected = {
    status: "selected",
    candidateCount: 2,
    candidates: [
      { threadId: "thread-newer", interruptedAtMs: nowMs - 1_000 },
      { threadId: "thread-older", interruptedAtMs: nowMs - 2_000 }
    ]
  };
  const service = createAccountService(userData, {
    codexDir,
    nowMs: () => nowMs,
    writeObservationState: () => {},
    getCodexActivityStatus: () => ({ isBusy: false, activeThreadIds: [] }),
    selectQuotaInterruptedThread: () => expected
  });
  fs.writeFileSync(path.join(codexDir, "auth.json"), JSON.stringify({ access_token: "source", account_id: "acct-source" }), "utf8");
  service.importCurrentAuth();
  fs.writeFileSync(path.join(codexDir, "auth.json"), JSON.stringify({ access_token: "target", account_id: "acct-target" }), "utf8");
  const target = service.importCurrentAuth();
  fs.writeFileSync(path.join(codexDir, "auth.json"), JSON.stringify({ access_token: "source", account_id: "acct-source" }), "utf8");

  assert.deepEqual(await service.selectManualResumeDecision(target.id), expected);
});

test("a switch-frozen continuation queue crosses the account-cycle boundary only once", async () => {
  const { userData, codexDir } = makeFixture();
  const nowMs = unixTestNow() * 1000;
  const opened = [];
  const service = createAccountService(userData, {
    codexDir,
    nowMs: () => nowMs,
    writeObservationState: () => {},
    openCodexThread: async (threadId) => {
      opened.push(threadId);
      return true;
    }
  });
  const queue = service.prepareAutoResumeQueue({
    status: "selected",
    candidateCount: 2,
    candidates: [
      { threadId: "thread-a", interruptedAtMs: nowMs - 2_000 },
      { threadId: "thread-b", interruptedAtMs: nowMs - 1_000 }
    ]
  });
  service.recordActiveAccount("target-cycle", "switch");

  await service.startPreparedAutoResumeQueue(queue);
  await service.startPreparedAutoResumeQueue(queue);

  assert.deepEqual(opened, ["thread-a", "thread-b"]);
  assert.equal(service.getAutoResumeStatus().status, "multi_complete");
});

test("startup does not make an observed continuation queue look newly active", () => {
  const { userData, codexDir } = makeFixture();
  let nowMs = unixTestNow() * 1000;
  const service = createAccountService(userData, { codexDir, nowMs: () => nowMs });
  const queue = service.prepareAutoResumeQueue({
    status: "selected",
    candidateCount: 2,
    candidates: [
      { threadId: "thread-old", interruptedAtMs: nowMs - 2_000 },
      { threadId: "thread-failed", interruptedAtMs: nowMs - 1_000 }
    ]
  });
  service.finishAutoResumeQueueItem(queue.attemptId, "thread-old", "launch_verified");
  service.finishAutoResumeQueueItem(queue.attemptId, "thread-old", "turn_started");
  service.finishAutoResumeQueueItem(queue.attemptId, "thread-failed", "failed");
  const observedAtMs = service.getAutoResumeState().updatedAtMs;

  nowMs += 30 * 60_000;
  const restarted = createAccountService(userData, { codexDir, nowMs: () => nowMs });
  assert.equal(restarted.getAutoResumeState().updatedAtMs, observedAtMs);

  const ticket = restarted.prepareAutoResumeTicket({
    threadId: "thread-new-cycle",
    interruptedAtMs: nowMs - 1_000
  });
  assert.equal(ticket.threadId, "thread-new-cycle");
  assert.equal(ticket.stage, "prepared");
});

test("deferred and failed switches do not invent an account cycle", () => {
  const { userData, codexDir } = makeFixture();
  const nowMs = unixTestNow() * 1000;
  const service = createAccountService(userData, {
    codexDir,
    nowMs: () => nowMs,
    writeObservationState: () => {},
    verifyCodexClosure: true,
    countCodexProcesses: () => 1,
    closeCodexProcesses: () => 0,
    launchCodex: () => true
  });
  fs.writeFileSync(path.join(codexDir, "auth.json"), JSON.stringify({ access_token: "source", account_id: "acct-source" }), "utf8");
  const source = service.importCurrentAuth();
  fs.writeFileSync(path.join(codexDir, "auth.json"), JSON.stringify({ access_token: "target", account_id: "acct-target" }), "utf8");
  const target = service.importCurrentAuth();
  fs.writeFileSync(path.join(codexDir, "auth.json"), JSON.stringify({ access_token: "source", account_id: "acct-source" }), "utf8");
  service.recordActiveAccount(source.id, "test_source_restored");
  const observationPath = path.join(userData, "usage-observations.json");
  const before = fs.readFileSync(observationPath, "utf8");

  const deferred = service.switchAccount(target.id, { deferIfCodexRunning: true });
  assert.equal(deferred.deferred, true);
  assert.equal(fs.readFileSync(observationPath, "utf8"), before);

  assert.throws(() => service.switchAccount(target.id), /仍在运行/);
  assert.equal(fs.readFileSync(observationPath, "utf8"), before);
});

test("persists completed-thread read markers globally and reloads them", () => {
  const { userData } = makeFixture({ createCodexDir: false });
  const service = createAccountService(userData);
  service.markCompletedThreadRead("thread-1");
  service.markCompletedThreadRead("thread-1");
  service.markCompletedThreadRead("thread-2");
  service.updateSettings({
    edgeWindowDocked: false,
    edgeWindowX: 731,
    edgeWindowY: 244,
    edgeWindowWidth: 512,
    edgeWindowHeight: 603,
    edgeWindowAutoHide: true
  });

  assert.deepEqual(service.getDismissedCompletedThreadIds(), ["thread-1", "thread-2"]);
  const reloaded = createAccountService(userData);
  assert.deepEqual(reloaded.getDismissedCompletedThreadIds(), ["thread-1", "thread-2"]);
  assert.equal(reloaded.readSettings().edgeWindowDocked, false);
  assert.equal(reloaded.readSettings().edgeWindowX, 731);
  assert.equal(reloaded.readSettings().edgeWindowY, 244);
  assert.equal(reloaded.readSettings().edgeWindowWidth, 512);
  assert.equal(reloaded.readSettings().edgeWindowHeight, 603);
  assert.equal(reloaded.readSettings().edgeWindowAutoHide, true);
});

test("migrates per-account completed-thread markers by union", () => {
  const { userData } = makeFixture({ createCodexDir: false });
  fs.mkdirSync(userData, { recursive: true });
  fs.writeFileSync(path.join(userData, "settings.json"), JSON.stringify({
    edgeCompletedReadByAccount: {
      "account-a": ["thread-1", "thread-2"],
      "account-b": ["thread-1", "thread-3"]
    }
  }), "utf8");

  assert.deepEqual(createAccountService(userData).getDismissedCompletedThreadIds(), ["thread-1", "thread-2", "thread-3"]);
});

test("uses canonical current-account Codex rate limits for display without changing stored switching quota", () => {
  const { userData, codexDir } = makeFixture();
  const nowMs = Date.parse("2026-08-29T05:01:00Z");
  const service = createAccountService(userData, { codexDir, nowMs: () => nowMs });
  fs.writeFileSync(path.join(codexDir, "auth.json"), JSON.stringify({ access_token: "current", account_id: "acct-current" }), "utf8");
  const current = service.importCurrentAuth();
  const storePath = path.join(userData, "accounts-store.json");
  const store = JSON.parse(fs.readFileSync(storePath, "utf8"));
  store.accounts[0].usage = {
    fetchedAt: nowMs / 1000,
    source: "chatgpt_usage_api",
    fiveHour: { usedPercent: 50, remainingPercent: 50, resetAt: nowMs / 1000 + 18_000, windowSeconds: 18_000 },
    oneWeek: { usedPercent: 60, remainingPercent: 40, resetAt: nowMs / 1000 + 604_800, windowSeconds: 604_800 }
  };
  fs.writeFileSync(storePath, JSON.stringify(store), "utf8");
  const sessions = path.join(codexDir, "sessions", "2026", "08", "29");
  fs.mkdirSync(sessions, { recursive: true });
  fs.writeFileSync(path.join(userData, "usage-observations.json"), JSON.stringify({
    version: 1,
    intervals: [{ accountId: current.id, startMs: nowMs, source: "test" }],
    quotaSnapshots: [],
    resetEvents: [],
    pendingResets: []
  }));
  fs.writeFileSync(path.join(sessions, "rollout-current.jsonl"), JSON.stringify({
    timestamp: "2026-08-29T05:01:00Z",
    type: "event_msg",
    payload: { type: "token_count", info: {}, rate_limits: {
      limit_id: "codex",
      primary: { used_percent: 30, window_minutes: 300, resets_at: nowMs / 1000 + 18_000 },
      secondary: { used_percent: 12, window_minutes: 10_080, resets_at: nowMs / 1000 + 604_800 }
    } }
  }) + "\n");

  const displayed = service.currentCodexDisplayUsage({
    id: current.id,
    usage: {
      ...store.accounts[0].usage,
      executionLimited: true,
      executionLimitWindow: "fiveHour",
      executionLimitSource: "codex_usage_limit_exceeded",
      executionLimitedAtMs: nowMs
    }
  });

  assert.equal(displayed.source, "codex_app_server");
  assert.equal(displayed.oneWeek.remainingPercent, 88);
  assert.equal(displayed.executionLimited, true);
  assert.equal(displayed.executionLimitWindow, "fiveHour");
  const cleared = service.currentCodexDisplayUsage({
    id: current.id,
    usage: {
      ...store.accounts[0].usage,
      executionLimited: true,
      executionLimitWindow: "fiveHour",
      executionLimitSource: "codex_usage_limit_exceeded",
      executionLimitedAtMs: nowMs - 18_000_001
    }
  });
  assert.equal(cleared.executionLimited, undefined);
  assert.equal(JSON.parse(fs.readFileSync(storePath, "utf8")).accounts[0].usage.source, "chatgpt_usage_api");
});

test("keeps a newer usage API snapshot when the attributed Codex snapshot is older", () => {
  const { userData, codexDir } = makeFixture();
  const nowMs = Date.parse("2026-08-29T05:01:00Z");
  const service = createAccountService(userData, { codexDir, nowMs: () => nowMs });
  fs.writeFileSync(path.join(codexDir, "auth.json"), JSON.stringify({ access_token: "current", account_id: "acct-current" }), "utf8");
  const current = service.importCurrentAuth();
  fs.writeFileSync(path.join(userData, "usage-observations.json"), JSON.stringify({
    version: 1,
    intervals: [{ accountId: current.id, startMs: nowMs - 120_000, source: "test" }],
    quotaSnapshots: [],
    resetEvents: [],
    pendingResets: []
  }));
  const usage = {
    fetchedAt: nowMs / 1000,
    source: "chatgpt_usage_api",
    fiveHour: { usedPercent: 50, remainingPercent: 50, resetAt: nowMs / 1000 + 18_000, windowSeconds: 18_000 },
    oneWeek: { usedPercent: 60, remainingPercent: 40, resetAt: nowMs / 1000 + 604_800, windowSeconds: 604_800 }
  };
  service.codexRateLimitsCache = {
    usage: {
      fetchedAt: nowMs / 1000 - 60,
      source: "codex_app_server",
      limitId: "codex",
      fiveHour: { usedPercent: 98, remainingPercent: 2, resetAt: nowMs / 1000 + 18_000, windowSeconds: 18_000 },
      oneWeek: { usedPercent: 80, remainingPercent: 20, resetAt: nowMs / 1000 + 604_800, windowSeconds: 604_800 }
    },
    expiresAtMs: nowMs + 1_000
  };

  const displayed = service.currentCodexDisplayUsage({ id: current.id, usage });

  assert.equal(displayed.source, "chatgpt_usage_api");
  assert.equal(displayed.fiveHour.remainingPercent, 50);
  assert.equal(displayed.oneWeek.remainingPercent, 40);
});

test("keeps attributed usage API quota when the latest Codex limit is special", () => {
  const { userData, codexDir } = makeFixture();
  const nowMs = Date.parse("2026-08-29T05:01:00Z");
  const service = createAccountService(userData, { codexDir, nowMs: () => nowMs });
  fs.writeFileSync(path.join(codexDir, "auth.json"), JSON.stringify({ access_token: "current", account_id: "acct-current" }), "utf8");
  const current = service.importCurrentAuth();
  const storePath = path.join(userData, "accounts-store.json");
  const store = JSON.parse(fs.readFileSync(storePath, "utf8"));
  store.accounts[0].usage = {
    fetchedAt: nowMs / 1000,
    source: "chatgpt_usage_api",
    fiveHour: { usedPercent: 86, remainingPercent: 14, resetAt: nowMs / 1000 + 18_000, windowSeconds: 18_000 },
    oneWeek: { usedPercent: 72, remainingPercent: 28, resetAt: nowMs / 1000 + 604_800, windowSeconds: 604_800 }
  };
  fs.writeFileSync(storePath, JSON.stringify(store), "utf8");
  const sessions = path.join(codexDir, "sessions", "2026", "08", "29");
  fs.mkdirSync(sessions, { recursive: true });
  fs.writeFileSync(path.join(userData, "usage-observations.json"), JSON.stringify({
    version: 1,
    intervals: [{ accountId: current.id, startMs: nowMs, source: "test" }],
    quotaSnapshots: [],
    resetEvents: [],
    pendingResets: []
  }));
  fs.writeFileSync(path.join(sessions, "rollout-current.jsonl"), JSON.stringify({
    timestamp: "2026-08-29T05:01:00Z",
    type: "event_msg",
    payload: { type: "token_count", info: {}, rate_limits: {
      limit_id: "base_model_inference",
      limit_name: "gpt-reserve",
      primary: { used_percent: 0, window_minutes: 10_080, resets_at: nowMs / 1000 + 604_800 }
    } }
  }) + "\n");

  const displayed = service.currentCodexDisplayUsage({ id: current.id, usage: store.accounts[0].usage });

  assert.equal(displayed.source, "chatgpt_usage_api");
  assert.equal(displayed.fiveHour.remainingPercent, 14);
  assert.equal(displayed.oneWeek.remainingPercent, 28);
});

test("changing the default HTTP-only mode does not restart Codex when the current account overrides it", { skip: process.platform !== "win32" }, () => {
  const { userData, codexDir } = makeFixture();
  fs.writeFileSync(path.join(codexDir, "auth.json"), JSON.stringify({ access_token: "a", account_id: "acct-a" }), "utf8");
  let closedCodexProcesses = 0;
  let launchedCodex = 0;
  const service = createAccountService(userData, {
    codexDir,
    closeCodexProcesses: () => {
      closedCodexProcesses += 1;
      return 1;
    },
    launchCodex: () => {
      launchedCodex += 1;
      return true;
    }
  });
  service.importCurrentAuth();
  const storePath = path.join(userData, "accounts-store.json");
  const store = JSON.parse(fs.readFileSync(storePath, "utf8"));
  store.accounts[0].httpOnlyModeEnabled = false;
  fs.writeFileSync(storePath, JSON.stringify(store), "utf8");

  const result = service.setHttpOnlyMode(true);

  assert.equal(result.settings.httpOnlyModeEnabled, true);
  assert.equal(service.readSettings().httpOnlyModeEnabled, true);
  assert.equal(readCodexHttpOnlyStatus(path.join(codexDir, "config.toml")).enabled, false);
  assert.equal(closedCodexProcesses, 0);
  assert.equal(launchedCodex, 0);
});

test("changing the inherited default HTTP-only mode still restarts Codex and applies the transport", { skip: process.platform !== "win32" }, () => {
  const { userData, codexDir } = makeFixture();
  fs.writeFileSync(path.join(codexDir, "auth.json"), JSON.stringify({ access_token: "a", account_id: "acct-a" }), "utf8");
  let closedCodexProcesses = 0;
  let launchedCodex = 0;
  const service = createAccountService(userData, {
    codexDir,
    closeCodexProcesses: () => {
      closedCodexProcesses += 1;
      return 1;
    },
    launchCodex: () => {
      launchedCodex += 1;
      return true;
    }
  });
  service.importCurrentAuth();

  const result = service.setHttpOnlyMode(true);

  assert.equal(result.settings.httpOnlyModeEnabled, true);
  assert.equal(readCodexHttpOnlyStatus(path.join(codexDir, "config.toml")).enabled, true);
  assert.equal(closedCodexProcesses, 1);
  assert.equal(launchedCodex, 1);
});

test("deleting a non-current account does not close or launch Codex", { skip: process.platform !== "win32" }, () => {
  const { userData, codexDir } = makeFixture();
  fs.writeFileSync(path.join(codexDir, "auth.json"), JSON.stringify({ access_token: "current", account_id: "acct-current" }), "utf8");

  let closedCodexProcesses = 0;
  let launchedCodex = 0;
  const service = createAccountService(userData, {
    codexDir,
    closeCodexProcesses: () => {
      closedCodexProcesses += 1;
      return 1;
    },
    launchCodex: () => {
      launchedCodex += 1;
      return true;
    }
  });
  const current = service.importCurrentAuth();
  fs.writeFileSync(path.join(codexDir, "auth.json"), JSON.stringify({ access_token: "other", account_id: "acct-other" }), "utf8");
  const other = service.importCurrentAuth();
  fs.writeFileSync(path.join(codexDir, "auth.json"), JSON.stringify({ access_token: "current", account_id: "acct-current" }), "utf8");

  const deleted = service.deleteAccount(other.id);
  assert.equal(deleted.deleted, true);
  assert.equal(deleted.closedCodexProcesses, 0);
  assert.equal(deleted.launchedCodex, false);
  assert.equal(closedCodexProcesses, 0);
  assert.equal(launchedCodex, 0);
  assert.deepEqual(service.listAccounts().map((account) => account.id), [current.id]);
});

test("deleting current account requires replacement and switches to it", { skip: process.platform !== "win32" }, () => {
  const { userData, codexDir } = makeFixture();
  const currentAuth = { access_token: "current", account_id: "acct-current" };
  const replacementAuth = { access_token: "replacement", account_id: "acct-replacement" };
  fs.writeFileSync(path.join(codexDir, "auth.json"), JSON.stringify(currentAuth), "utf8");

  let closedCodexProcesses = 0;
  let launchedCodex = 0;
  let launchOptions;
  const service = createAccountService(userData, {
    codexDir,
    closeCodexProcesses: () => {
      closedCodexProcesses += 1;
      return 3;
    },
    launchCodex: (options) => {
      launchedCodex += 1;
      launchOptions = options;
      return true;
    }
  });
  const current = service.importCurrentAuth();
  fs.writeFileSync(path.join(codexDir, "auth.json"), JSON.stringify(replacementAuth), "utf8");
  const replacement = service.importCurrentAuth();
  fs.writeFileSync(path.join(codexDir, "auth.json"), JSON.stringify(currentAuth), "utf8");
  service.setAccountDisableGpuMode(replacement.id, true);

  assert.throws(() => service.deleteAccount(current.id), /必须选择另一个账号/);
  const deleted = service.deleteAccount(current.id, replacement.id);
  assert.equal(deleted.deleted, true);
  assert.equal(deleted.closedCodexProcesses, 3);
  assert.equal(deleted.launchedCodex, true);
  assert.equal(closedCodexProcesses, 1);
  assert.equal(launchedCodex, 1);
  assert.deepEqual(launchOptions, { disableGpu: true });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(codexDir, "auth.json"), "utf8")), replacementAuth);
  assert.deepEqual(service.listAccounts().map((account) => account.id), [replacement.id]);
});

test("deleting current account can clear auth and launch new login", { skip: process.platform !== "win32" }, () => {
  const { userData, codexDir } = makeFixture();
  const currentAuth = { access_token: "current", account_id: "acct-current" };
  fs.writeFileSync(path.join(codexDir, "auth.json"), JSON.stringify(currentAuth), "utf8");

  let closedCodexProcesses = 0;
  let launchedCodex = 0;
  let launchOptions;
  const service = createAccountService(userData, {
    codexDir,
    closeCodexProcesses: () => {
      closedCodexProcesses += 1;
      return 2;
    },
    launchCodex: (options) => {
      launchedCodex += 1;
      launchOptions = options;
      return true;
    }
  });
  const current = service.importCurrentAuth();
  fs.writeFileSync(path.join(userData, "settings.json"), JSON.stringify({ disableGpuModeEnabled: true }), "utf8");
  const deleted = service.deleteAccount(current.id, { mode: "login_new" });

  assert.equal(deleted.deleted, true);
  assert.equal(deleted.loginNew, true);
  assert.equal(deleted.closedCodexProcesses, 2);
  assert.equal(deleted.launchedCodex, true);
  assert.equal(closedCodexProcesses, 1);
  assert.equal(launchedCodex, 1);
  assert.deepEqual(launchOptions, { disableGpu: true });
  assert.equal(fs.existsSync(path.join(codexDir, "auth.json")), false);
  assert.deepEqual(service.listAccounts(), []);

  const backupDir = path.join(userData, "codex-backups", "auth");
  const backups = fs.readdirSync(backupDir);
  assert.equal(backups.length, 1);
  assert.equal(backups[0].endsWith(".json.dpapi"), true);
  assert.equal(fs.readFileSync(path.join(backupDir, backups[0]), "utf8").includes("current"), false);
});

test("sync and responsive switches capture stable thread state before closing Codex", { skip: process.platform !== "win32" }, async () => {
  for (const responsive of [false, true]) {
    const { userData, codexDir } = makeFixture();
    const targetAuth = { access_token: `target-${responsive}`, account_id: `target-${responsive}` };
    const currentAuth = { access_token: `current-${responsive}`, account_id: `current-${responsive}` };
    fs.writeFileSync(path.join(codexDir, "auth.json"), JSON.stringify(targetAuth), "utf8");
    let closed = 0;
    const service = createAccountService(userData, {
      codexDir,
      closeCodexProcesses: () => { closed += 1; return 1; },
      closeCodexProcessesAsync: async () => { closed += 1; return 1; },
      getCodexThreadIntegritySnapshot: () => ({ revision: "stable" }),
      captureStableCodexThreadStateAsync: async () => {
        throw new Error("Local Codex thread state changed during stable capture");
      }
    });
    const target = service.importCurrentAuth();
    fs.writeFileSync(path.join(codexDir, "auth.json"), JSON.stringify(currentAuth), "utf8");

    if (responsive) {
      await assert.rejects(() => service.switchAccountResponsive(target.id), /stable capture|对话状态/i);
    } else {
      let capture = 0;
      service.getCodexThreadIntegritySnapshot = () => ({ revision: ++capture === 1 ? "before" : "changed" });
      assert.throws(() => service.switchAccount(target.id), /stable capture|对话状态/i);
    }
    assert.equal(closed, 0, responsive ? "responsive" : "sync");
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(codexDir, "auth.json"), "utf8")), currentAuth);
  }
});

test("starts a new login without deleting the current saved account", { skip: process.platform !== "win32" }, () => {
  const { userData, codexDir } = makeFixture();
  const currentAuth = { access_token: "current", refresh_token: "refresh", account_id: "acct-current" };
  fs.writeFileSync(path.join(codexDir, "auth.json"), JSON.stringify(currentAuth), "utf8");
  const order = [];
  const service = createAccountService(userData, {
    codexDir,
    closeCodexProcesses: () => { order.push("closed"); return 2; },
    launchCodex: () => { order.push("launched"); return true; },
    getCodexThreadIntegritySnapshot: () => ({ revision: "stable" })
  });

  const result = service.beginAddAccount();

  assert.equal(result.loginNew, true);
  assert.equal(result.deleted, false);
  assert.equal(result.preservedAccount.accountId, "acct-current");
  assert.equal(fs.existsSync(path.join(codexDir, "auth.json")), false);
  assert.deepEqual(service.listAccounts().map((account) => account.id), [result.preservedAccount.id]);
  assert.deepEqual(order, ["closed", "launched"]);
  const rawStore = fs.readFileSync(path.join(userData, "accounts-store.json"), "utf8");
  assert.equal(rawStore.includes('"access_token"'), false);
  assert.equal(rawStore.includes('"refresh_token"'), false);
});

test("new-account flow validates stable thread state before closing Codex", { skip: process.platform !== "win32" }, () => {
  const { userData, codexDir } = makeFixture();
  const currentAuth = { access_token: "current", account_id: "acct-current" };
  fs.writeFileSync(path.join(codexDir, "auth.json"), JSON.stringify(currentAuth), "utf8");
  let closed = 0;
  let capture = 0;
  const service = createAccountService(userData, {
    codexDir,
    closeCodexProcesses: () => { closed += 1; return 1; },
    getCodexThreadIntegritySnapshot: () => ({ revision: ++capture === 1 ? "before" : "changed" })
  });

  assert.throws(() => service.beginAddAccount(), /stable capture|对话状态|thread state/i);
  assert.equal(closed, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(codexDir, "auth.json"), "utf8")), currentAuth);
});

test("new-account flow fails closed when thread validation and auth restoration both fail", { skip: process.platform !== "win32" }, () => {
  const { userData, codexDir } = makeFixture();
  const currentAuth = { access_token: "current", account_id: "acct-current" };
  fs.writeFileSync(path.join(codexDir, "auth.json"), JSON.stringify(currentAuth), "utf8");
  const revisions = ["stable", "stable", "changed"];
  let launches = 0;
  const service = createAccountService(userData, {
    codexDir,
    closeCodexProcesses: () => 1,
    launchCodex: () => { launches += 1; return true; },
    getCodexThreadIntegritySnapshot: () => ({ revision: revisions.shift() }),
    restoreAuthText: () => { throw new Error("simulated restore failure"); }
  });

  assert.throws(
    () => service.beginAddAccount(),
    /原账号认证恢复失败.*不要继续添加或切换账号/
  );
  assert.equal(launches, 0);
  assert.equal(fs.existsSync(path.join(codexDir, "auth.json")), false);
  assert.equal(service.listAccounts().length, 1);
});

test("cancels switch and delete when Codex cannot be fully closed", { skip: process.platform !== "win32" }, () => {
  const { userData, codexDir } = makeFixture();
  const initialAuth = { access_token: "c", account_id: "acct-c" };
  const otherAuth = { access_token: "o", account_id: "other" };
  fs.writeFileSync(path.join(codexDir, "auth.json"), JSON.stringify(initialAuth), "utf8");

  const service = createAccountService(userData, {
    codexDir,
    closeCodexProcesses: () => {
      throw new Error("still running");
    }
  });
  const imported = service.importCurrentAuth();
  fs.writeFileSync(path.join(codexDir, "auth.json"), JSON.stringify({ access_token: "r", account_id: "replacement" }), "utf8");
  const replacement = service.importCurrentAuth();
  fs.writeFileSync(path.join(codexDir, "auth.json"), JSON.stringify(otherAuth), "utf8");

  assert.throws(() => service.switchAccount(imported.id), /still running/);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(codexDir, "auth.json"), "utf8")), otherAuth);
  fs.writeFileSync(path.join(codexDir, "auth.json"), JSON.stringify(initialAuth), "utf8");
  assert.throws(() => service.deleteAccount(imported.id, replacement.id), /still running/);
  assert.throws(() => service.deleteAccount(imported.id, { mode: "login_new" }), /still running/);
  assert.equal(service.listAccounts().length, 2);
});

test("delete-current modes re-count Codex and abort before snapshot or auth mutation", { skip: process.platform !== "win32" }, () => {
  for (const mode of ["replacement", "login_new"]) {
    const { userData, codexDir } = makeFixture();
    const currentAuth = { access_token: `current-${mode}`, account_id: `current-${mode}` };
    fs.writeFileSync(path.join(codexDir, "auth.json"), JSON.stringify(currentAuth), "utf8");
    let snapshots = 0;
    let launches = 0;
    const service = createAccountService(userData, {
      codexDir,
      verifyCodexClosure: true,
      countCodexProcesses: () => 1,
      closeCodexProcesses: () => 1,
      createCriticalCodexSnapshot: () => { snapshots += 1; },
      launchCodex: () => { launches += 1; }
    });
    const current = service.importCurrentAuth();
    let replacement;
    if (mode === "replacement") {
      fs.writeFileSync(path.join(codexDir, "auth.json"), JSON.stringify({ access_token: "replacement", account_id: "replacement" }), "utf8");
      replacement = service.importCurrentAuth();
      fs.writeFileSync(path.join(codexDir, "auth.json"), JSON.stringify(currentAuth), "utf8");
    }
    assert.throws(
      () => service.deleteAccount(current.id, mode === "replacement" ? replacement.id : { mode: "login_new" }),
      /仍在运行/
    );
    assert.equal(snapshots, 0);
    assert.equal(launches, 0);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(codexDir, "auth.json"), "utf8")), currentAuth);
  }
});

test("runs conversation backups only for controlled reasons and persists successful timestamps", { skip: process.platform !== "win32" }, async () => {
  const { userData, codexDir } = makeFixture();
  const calls = [];
  const service = createAccountService(userData, {
    codexDir,
    nowMs: () => 1_800_000_000_000,
    createConversationBackup: async (options) => {
      calls.push(options);
      return { manifestPath: "fixture-manifest" };
    }
  });

  await assert.rejects(() => service.runConversationBackup("account-switch"), /Unsupported conversation backup reason/);
  const explicit = await service.runConversationBackup("explicit");
  const recovery = await service.runConversationBackup("recovery-maintenance");

  assert.equal(explicit.manifestPath, "fixture-manifest");
  assert.equal(recovery.manifestPath, "fixture-manifest");
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map(({ codexDir: root, backupRoot }) => ({ root, backupRoot })), [
    { root: codexDir, backupRoot: path.join(userData, "codex-backups") },
    { root: codexDir, backupRoot: path.join(userData, "codex-backups") }
  ]);
  assert.equal(service.readSettings().lastConversationBackupSucceededAtMs, 1_800_000_000_000);
});

test("daily idle conversation backup requires a full idle gate and a 24-hour interval", { skip: process.platform !== "win32" }, async () => {
  const cases = [
    { name: "official Codex is running", processCount: 1, activity: { isBusy: false }, state: {}, expected: "codex_running" },
    { name: "a task is active", processCount: 0, activity: { isBusy: true }, state: {}, expected: "task_active" },
    { name: "an account switch is queued", processCount: 0, activity: { isBusy: false }, state: { pending: { accountId: "queued" } }, expected: "switch_queued" },
    { name: "the last success is recent", processCount: 0, activity: { isBusy: false }, state: {}, lastSuccess: 1_799_999_999_999, expected: "not_due" }
  ];

  for (const item of cases) {
    const { userData, codexDir } = makeFixture();
    let backups = 0;
    const service = createAccountService(userData, {
      codexDir,
      nowMs: () => 1_800_000_000_000,
      countCodexProcesses: () => item.processCount,
      getCodexActivityStatus: () => item.activity,
      createConversationBackup: async () => { backups += 1; }
    });
    if (item.state.pending) service.writeAutoSwitchState(item.state);
    if (item.lastSuccess) {
      fs.writeFileSync(path.join(userData, "settings.json"), JSON.stringify({ lastConversationBackupSucceededAtMs: item.lastSuccess }), "utf8");
    }

    const result = await service.runConversationBackup("daily-idle");

    assert.deepEqual(result, { skipped: true, reason: item.expected }, item.name);
    assert.equal(backups, 0, item.name);
  }

  const { userData, codexDir } = makeFixture();
  let backups = 0;
  const due = createAccountService(userData, {
    codexDir,
    nowMs: () => 1_800_000_000_000,
    countCodexProcesses: () => 0,
    getCodexActivityStatus: () => ({ isBusy: false }),
    createConversationBackup: async () => {
      backups += 1;
      return { manifestPath: "daily-manifest" };
    }
  });
  fs.writeFileSync(
    path.join(userData, "settings.json"),
    JSON.stringify({ lastConversationBackupSucceededAtMs: 1_800_000_000_000 - 24 * 60 * 60 * 1000 }),
    "utf8"
  );

  assert.equal((await due.runConversationBackup("daily-idle")).manifestPath, "daily-manifest");
  assert.equal(backups, 1);
});

test("failed conversation backups do not advance the successful timestamp", { skip: process.platform !== "win32" }, async () => {
  const { userData, codexDir } = makeFixture();
  const service = createAccountService(userData, {
    codexDir,
    nowMs: () => 1_800_000_000_000,
    createConversationBackup: async () => { throw new Error("backup failed"); }
  });
  fs.writeFileSync(
    path.join(userData, "settings.json"),
    JSON.stringify({ lastConversationBackupSucceededAtMs: 1_700_000_000_000 }),
    "utf8"
  );

  await assert.rejects(() => service.runConversationBackup("explicit"), /backup failed/);
  assert.equal(service.readSettings().lastConversationBackupSucceededAtMs, 1_700_000_000_000);
});

test("daily maintenance separates incremental and weekly full verification clocks", async () => {
  const { userData, codexDir } = makeFixture();
  const now = 1_800_000_000_000;
  const modes = [];
  const service = createAccountService(userData, {
    codexDir,
    nowMs: () => now,
    countCodexProcesses: () => 0,
    getCodexActivityStatus: () => ({ isBusy: false }),
    createCriticalCodexSnapshot: () => ({ generationDir: "critical", manifest: { createdAt: new Date(now).toISOString(), counts: {} } }),
    createConversationBackup: async ({ mode }) => {
      modes.push(mode);
      return { manifestPath: "conversation", manifest: { createdAt: new Date(now).toISOString(), counts: { activeSessions: 0, archivedSessions: 0 } } };
    },
    createCompleteRecoveryPoint: () => ({ recoveryPointId: "R".repeat(43) })
  });
  fs.writeFileSync(path.join(userData, "settings.json"), JSON.stringify({
    lastConversationIncrementalSucceededAtMs: now - 24 * 60 * 60 * 1000,
    lastConversationFullVerificationSucceededAtMs: now - 2 * 24 * 60 * 60 * 1000
  }));

  await service.runConversationBackup("daily-idle");
  assert.deepEqual(modes, ["incremental"]);
  let settings = service.readSettings();
  assert.equal(settings.lastConversationIncrementalSucceededAtMs, now);
  assert.equal(settings.lastConversationFullVerificationSucceededAtMs, now - 2 * 24 * 60 * 60 * 1000);

  fs.writeFileSync(path.join(userData, "settings.json"), JSON.stringify({
    lastConversationIncrementalSucceededAtMs: now - 24 * 60 * 60 * 1000,
    lastConversationFullVerificationSucceededAtMs: now - 7 * 24 * 60 * 60 * 1000
  }));
  await service.runConversationBackup("daily-idle");
  assert.deepEqual(modes, ["incremental", "full"]);
  settings = service.readSettings();
  assert.equal(settings.lastConversationFullVerificationSucceededAtMs, now);
});

test("ordinary settings updates preserve both conversation backup clocks", () => {
  const { userData, codexDir } = makeFixture();
  const service = createAccountService(userData, { codexDir });
  fs.writeFileSync(path.join(userData, "settings.json"), JSON.stringify({
    lastConversationBackupSucceededAtMs: 1_700_000_000_000,
    lastConversationIncrementalSucceededAtMs: 1_700_000_001_000,
    lastConversationFullVerificationSucceededAtMs: 1_700_000_002_000
  }), "utf8");

  service.updateSettings({ themeMode: "dark" });

  assert.equal(service.readSettings().lastConversationIncrementalSucceededAtMs, 1_700_000_001_000);
  assert.equal(service.readSettings().lastConversationFullVerificationSucceededAtMs, 1_700_000_002_000);
});

test("explicit complete backup refuses while Codex is running without closing it", async () => {
  const { userData, codexDir } = makeFixture();
  let closed = 0;
  let snapshots = 0;
  const service = createAccountService(userData, {
    codexDir,
    countCodexProcesses: () => 1,
    closeCodexProcesses: () => { closed += 1; },
    createCriticalCodexSnapshot: () => { snapshots += 1; }
  });

  await assert.rejects(() => service.runConversationBackup("explicit"), /close.*codex|关闭.*codex/i);
  assert.equal(closed, 0);
  assert.equal(snapshots, 0);
});

test("overlapping conversation backups share one in-flight operation and clear it after failure", async () => {
  const { userData, codexDir } = makeFixture();
  let calls = 0;
  let release;
  const service = createAccountService(userData, {
    codexDir,
    createConversationBackup: () => {
      calls += 1;
      return new Promise((resolve, reject) => { release = calls === 1 ? reject : resolve; });
    }
  });
  const first = service.runConversationBackup("explicit");
  const overlapping = service.runConversationBackup("daily-idle");
  assert.equal(calls, 1);
  release(new Error("first failed"));
  await assert.rejects(first, /first failed/);
  await assert.rejects(overlapping, /first failed/);

  const retry = service.runConversationBackup("explicit");
  assert.equal(calls, 2);
  release({ manifestPath: "retry" });
  assert.equal((await retry).manifestPath, "retry");
});

test("explicit full backup waits for an in-flight daily incremental backup", async () => {
  const { userData, codexDir } = makeFixture();
  const modes = [];
  let releaseIncremental;
  const service = createAccountService(userData, {
    codexDir,
    countCodexProcesses: () => 0,
    getCodexActivityStatus: () => ({ isBusy: false }),
    createCriticalCodexSnapshot: () => ({ generationDir: "critical", manifest: { createdAt: new Date().toISOString(), counts: {} } }),
    createConversationBackup: async ({ mode }) => {
      modes.push(mode);
      if (mode === "incremental") await new Promise((resolve) => { releaseIncremental = resolve; });
      return { manifestPath: mode, manifest: { createdAt: new Date().toISOString(), counts: { activeSessions: 0, archivedSessions: 0 } } };
    },
    createCompleteRecoveryPoint: () => ({ recoveryPointId: "R".repeat(43) })
  });
  fs.writeFileSync(path.join(userData, "settings.json"), JSON.stringify({
    lastConversationIncrementalSucceededAtMs: Date.now() - 24 * 60 * 60 * 1000,
    lastConversationFullVerificationSucceededAtMs: Date.now()
  }));

  const daily = service.runConversationBackup("daily-idle");
  while (!releaseIncremental) await new Promise((resolve) => setImmediate(resolve));
  const explicit = service.runConversationBackup("explicit");
  assert.deepEqual(modes, ["incremental"]);
  releaseIncremental();
  await daily;
  await explicit;
  assert.deepEqual(modes, ["incremental", "full"]);
});

test("overlapping conversation-backup callers share progress from one operation", async () => {
  const { userData, codexDir } = makeFixture();
  let calls = 0;
  let release;
  let emit;
  const service = createAccountService(userData, {
    codexDir,
    createConversationBackup: ({ onProgress }) => {
      calls += 1;
      emit = onProgress;
      return new Promise((resolve) => { release = resolve; });
    }
  });
  const firstProgress = [];
  const secondProgress = [];
  const first = service.runConversationBackup("explicit", { onProgress: (value) => firstProgress.push(value) });
  await Promise.resolve();
  assert.equal(typeof emit, "function");
  emit({ stage: "discovering" });
  const overlapping = service.runConversationBackup("daily-idle", { onProgress: (value) => secondProgress.push(value) });
  emit({ stage: "processing", processedFiles: 1, totalFiles: 2, processedBytes: 10, totalBytes: 20 });
  release({ manifestPath: "shared" });

  assert.deepEqual(await Promise.all([first, overlapping]), [{ manifestPath: "shared" }, { manifestPath: "shared" }]);
  assert.equal(calls, 1);
  assert.deepEqual(firstProgress.map((value) => value.stage), ["discovering", "processing"]);
  assert.deepEqual(secondProgress.map((value) => value.stage), ["discovering", "processing"]);
});

test("conversation-backup progress is normalized before listeners receive it", async () => {
  const { userData, codexDir } = makeFixture();
  const received = [];
  const service = createAccountService(userData, {
    codexDir,
    createConversationBackup: async ({ onProgress }) => {
      onProgress({ stage: "processing", filePath: "private.jsonl" });
      onProgress({ stage: "discovering" });
      return { manifestPath: "safe" };
    }
  });

  await service.runConversationBackup("explicit", { onProgress: (value) => received.push(value) });

  assert.deepEqual(received, [{ stage: "discovering" }]);
});

test("ordinary account switching and deletion never run a full conversation backup", { skip: process.platform !== "win32" }, () => {
  const { userData, codexDir } = makeFixture();
  const currentAuth = { access_token: "current", account_id: "current" };
  fs.writeFileSync(path.join(codexDir, "auth.json"), JSON.stringify(currentAuth), "utf8");
  let conversationBackups = 0;
  const service = createAccountService(userData, {
    codexDir,
    closeCodexProcesses: () => 1,
    countCodexProcesses: () => 0,
    launchCodex: () => false,
    createCriticalCodexSnapshot: () => undefined,
    createConversationBackup: async () => { conversationBackups += 1; }
  });
  const current = service.importCurrentAuth();
  fs.writeFileSync(path.join(codexDir, "auth.json"), JSON.stringify({ access_token: "other", account_id: "other" }), "utf8");
  const other = service.importCurrentAuth();
  fs.writeFileSync(path.join(codexDir, "auth.json"), JSON.stringify(currentAuth), "utf8");

  service.switchAccount(other.id);
  service.deleteAccount(current.id);

  assert.equal(conversationBackups, 0);
});

test("concurrent reports for the same mode and date share one background operation", async () => {
  const { userData, codexDir } = makeFixture();
  let calls = 0;
  const releases = new Map();
  const service = createAccountService(userData, {
    codexDir,
    buildUsageReport: ({ mode }) => {
      calls += 1;
      return new Promise((resolve) => { releases.set(mode, resolve); });
    }
  });

  const first = service.getDailyUsageReport({ date: "2026-07-15" });
  const duplicate = service.getDailyUsageReport({ date: "2026-07-15" });
  const other = service.getWeeklyUsageReport({ weekStart: "2026-07-13" });
  assert.equal(calls, 2);
  releases.get("daily")({ mode: "daily" });
  releases.get("weekly")({ mode: "weekly" });
  assert.deepEqual(await Promise.all([first, duplicate, other]), [
    { mode: "daily" }, { mode: "daily" }, { mode: "weekly" }
  ]);
  assert.equal(calls, 2);
});

test("keeps ten encrypted recovery generations without usage-only duplicates", { skip: process.platform !== "win32" }, () => {
  const { userData, codexDir } = makeFixture();
  fs.writeFileSync(path.join(codexDir, "auth.json"), JSON.stringify({ access_token: "snapshot-secret", account_id: "acct-snapshot" }), "utf8");
  const service = createAccountService(userData, { codexDir });
  service.importCurrentAuth();
  const snapshotDir = path.join(userData, "recovery-snapshots");
  const initial = fs.readdirSync(snapshotDir);
  assert.equal(initial.length, 1);
  assert.equal(fs.readFileSync(path.join(snapshotDir, initial[0]), "utf8").includes("snapshot-secret"), false);

  const storePath = path.join(userData, "accounts-store.json");
  const usageOnly = JSON.parse(fs.readFileSync(storePath, "utf8"));
  usageOnly.accounts[0].usage = { fetchedAt: 1, fiveHour: { usedPercent: 10 } };
  usageOnly.accounts[0].usageError = "temporary failure";
  usageOnly.accounts[0].usageRefreshAttemptedAt = 2;
  usageOnly.accounts[0].status = "usage_failed";
  usageOnly.accounts[0].updatedAt += 1;
  service.writeStore(usageOnly);
  assert.equal(fs.readdirSync(snapshotDir).length, 1);

  for (let threshold = 1; threshold <= 11; threshold += 1) {
    service.updateSettings({ lowQuotaThresholdPercent: threshold });
  }
  assert.equal(fs.readdirSync(snapshotDir).length, 10);
});

test("recovers account and settings state from the newest valid encrypted snapshot", { skip: process.platform !== "win32" }, () => {
  const { userData, codexDir } = makeFixture();
  fs.writeFileSync(path.join(codexDir, "auth.json"), JSON.stringify({ access_token: "recover", account_id: "acct-recover" }), "utf8");
  const service = createAccountService(userData, { codexDir });
  service.importCurrentAuth();
  service.updateSettings({ lowQuotaThresholdPercent: 23 });

  for (const name of ["accounts-store.json", "accounts-store.json.bak", "settings.json", "settings.json.bak"]) {
    const target = path.join(userData, name);
    if (fs.existsSync(target)) fs.writeFileSync(target, Buffer.alloc(Math.max(1, fs.statSync(target).size)));
  }
  fs.writeFileSync(path.join(userData, "recovery-snapshots", "switcher-state.9999999999999.invalid.json.dpapi"), "invalid", "utf8");

  const recovered = createAccountService(userData, { codexDir });

  assert.equal(recovered.listAccounts().length, 1);
  assert.equal(recovered.readSettings().lowQuotaThresholdPercent, 23);
  assert.equal(fs.readdirSync(userData).some((name) => name.startsWith("accounts-store.json.corrupt-")), true);
});

test("migrates valid legacy auth backups to userData without overwriting a collision", { skip: process.platform !== "win32" }, () => {
  const { userData, codexDir } = makeFixture();
  const legacyDir = path.join(codexDir, "secure-switcher-backups");
  const destinationDir = path.join(userData, "codex-backups", "auth");
  const name = "auth.2026-07-14T00-00-00-000Z.json.dpapi";
  fs.mkdirSync(legacyDir, { recursive: true });
  fs.mkdirSync(destinationDir, { recursive: true });
  fs.writeFileSync(path.join(legacyDir, name), protectString(JSON.stringify({ access_token: "legacy" })), "utf8");
  fs.writeFileSync(path.join(destinationDir, name), protectString(JSON.stringify({ access_token: "existing" })), "utf8");

  createAccountService(userData, { codexDir });

  assert.equal(fs.existsSync(legacyDir), false);
  const backups = fs.readdirSync(destinationDir);
  assert.equal(backups.length, 2);
  assert.deepEqual(
    backups.map((backup) => JSON.parse(unprotectString(fs.readFileSync(path.join(destinationDir, backup), "utf8"))).access_token).sort(),
    ["existing", "legacy"]
  );
});

test("keeps an invalid legacy DPAPI backup on C and fails closed", { skip: process.platform !== "win32" }, () => {
  const { userData, codexDir } = makeFixture();
  const legacyDir = path.join(codexDir, "secure-switcher-backups");
  const invalid = path.join(legacyDir, "auth.invalid.json.dpapi");
  fs.mkdirSync(legacyDir, { recursive: true });
  fs.writeFileSync(invalid, "not-dpapi", "utf8");

  assert.throws(() => createAccountService(userData, { codexDir }), /legacy Switcher backup/i);
  assert.equal(fs.existsSync(invalid), true);
});

test("lists recovery summaries and previews only a controlled ID selection", async () => {
  const { userData, codexDir } = makeFixture();
  const criticalId = "A".repeat(43);
  const conversationId = "B".repeat(43);
  const calls = [];
  const summaries = {
    criticalGenerations: [{ generationId: criticalId, backupTime: "2023-11-14T22:13:20.000Z", counts: { projects: 1, assignments: 2, threads: 3 } }],
    conversationGenerations: [{ generationId: conversationId, backupTime: "2023-11-14T22:13:21.000Z", counts: { active: 4, archived: 5 } }]
  };
  const service = createAccountService(userData, {
    codexDir,
    listCodexRecoveryBackups: async (options) => {
      calls.push(["list", options]);
      return summaries;
    },
    resolveCodexRecoverySelection: async (options) => {
      calls.push(["resolve", options]);
      return { criticalGenerationDir: "internal-critical", conversationManifestPath: "internal-conversation" };
    },
    previewCodexRecovery: async (options) => {
      calls.push(["preview", options]);
      return {
        valid: true,
        backupTime: "2023-11-14T22:13:20.000Z",
        counts: { projects: 1, assignments: 2, threads: 3, activeSessions: 4, archivedSessions: 5, uiState: 99 },
        effects: { missing: 6, conflicts: 7 }
      };
    }
  });

  assert.deepEqual(await service.listCodexRecoveryBackups({ full: false }), summaries);
  assert.deepEqual(
    await service.previewCodexRecoveryById({ criticalId, conversationId }),
    {
      backupTime: "2023-11-14T22:13:20.000Z",
      counts: { projects: 1, assignments: 2, threads: 3, active: 4, archived: 5 },
      effects: { missing: 6, conflicts: 7 }
    }
  );
  assert.deepEqual(calls, [
    ["list", { backupRoot: path.join(userData, "codex-backups"), full: false }],
    ["resolve", { backupRoot: path.join(userData, "codex-backups"), criticalId, conversationId }],
    ["preview", { criticalGenerationDir: "internal-critical", conversationManifestPath: "internal-conversation", liveCodexDir: codexDir }]
  ]);
  await assert.rejects(
    () => service.previewCodexRecoveryById({ criticalId, conversationId, criticalPath: "C:\\private" }),
    /only recovery generation ids/i
  );
});

test("replacement prepare closes Codex and refuses to snapshot while a process remains", async () => {
  const { userData, codexDir } = makeFixture();
  let snapshots = 0;
  const service = createAccountService(userData, {
    codexDir,
    closeCodexProcesses: () => 1,
    countCodexProcesses: () => 1,
    createCriticalCodexSnapshot: () => { snapshots += 1; }
  });

  await assert.rejects(
    () => service.prepareCodexReplacement({ criticalId: "A".repeat(43), conversationId: "B".repeat(43) }),
    /仍在运行/
  );
  assert.equal(snapshots, 0);
});

test("replacement prepare binds an opaque expiring token to a fresh snapshot", async () => {
  const { userData, codexDir } = makeFixture();
  const selection = { criticalId: "A".repeat(43), conversationId: "B".repeat(43) };
  const order = [];
  const service = createAccountService(userData, {
    codexDir,
    nowMs: () => 1_800_000_000_000,
    closeCodexProcesses: () => { order.push("close"); return 1; },
    countCodexProcesses: () => { order.push("count"); return 0; },
    getCodexStateIdentity: () => "live-identity",
    getRecoverySelectionIdentity: async () => "selected-identity",
    resolveCodexRecoverySelection: async () => {
      order.push("resolve");
      return { criticalGenerationDir: "selected-critical", conversationManifestPath: "selected-conversation" };
    },
    previewCodexRecovery: async () => { order.push("preview"); return { valid: true }; },
    createCriticalCodexSnapshot: () => { order.push("snapshot"); return { generationDir: "fresh-snapshot" }; },
    getCriticalSnapshotIdentity: () => "fresh-snapshot-identity"
  });

  const prepared = await service.prepareCodexReplacement(selection);

  assert.match(prepared.confirmationToken, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(prepared.expiresAtMs, 1_800_000_300_000);
  assert.deepEqual(Object.keys(prepared).sort(), ["confirmationToken", "expiresAtMs"]);
  assert.deepEqual(order, ["close", "count", "resolve", "preview", "snapshot"]);
});

test("replacement prepare uses the serialized recovery worker instead of main-thread validation", async () => {
  const { userData, codexDir } = makeFixture();
  const selection = { criticalId: "A".repeat(43), conversationId: "B".repeat(43) };
  const sources = { criticalGenerationDir: "selected-critical", conversationManifestPath: "selected-conversation" };
  const calls = [];
  const service = createAccountService(userData, {
    codexDir,
    closeCodexProcesses: () => 1,
    countCodexProcesses: () => 0,
    prepareCodexReplacementInWorker: async (request) => {
      calls.push(["prepare-worker", request.selection]);
      return { sources, preview: { valid: true }, selectedBackupIdentity: "selected-identity", liveIdentity: "live-identity" };
    },
    getCodexStateIdentityInWorker: async () => { calls.push(["live-worker"]); return "live-identity"; },
    resolveCodexRecoverySelection: () => { throw new Error("main resolve used"); },
    previewCodexRecovery: () => { throw new Error("main preview used"); },
    getRecoverySelectionIdentity: () => { throw new Error("main identity used"); },
    getCodexStateIdentity: () => { throw new Error("main live identity used"); },
    createCriticalCodexSnapshot: () => { calls.push(["snapshot"]); return { generationDir: "fresh-snapshot" }; },
    getCriticalSnapshotIdentity: () => "fresh-snapshot-identity"
  });

  const prepared = await service.prepareCodexReplacement(selection);

  assert.match(prepared.confirmationToken, /^[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(calls, [["prepare-worker", selection], ["snapshot"], ["live-worker"]]);
});

test("replacement confirm revalidates the bound context and consumes its token", async () => {
  const { userData, codexDir } = makeFixture();
  const selection = { criticalId: "A".repeat(43), conversationId: "B".repeat(43) };
  const sources = { criticalGenerationDir: "selected-critical", conversationManifestPath: "selected-conversation" };
  let now = 1_800_000_000_000;
  let restores = 0;
  const service = createAccountService(userData, {
    codexDir,
    nowMs: () => now,
    closeCodexProcesses: () => 1,
    countCodexProcesses: () => 0,
    getCodexStateIdentity: () => "live-identity",
    getRecoverySelectionIdentity: async () => "selected-identity",
    resolveCodexRecoverySelection: async () => sources,
    previewCodexRecovery: async () => ({ valid: true }),
    createCriticalCodexSnapshot: () => ({ generationDir: "fresh-snapshot" }),
    getCriticalSnapshotIdentity: () => "fresh-snapshot-identity",
    restoreCodexBackup: async (options) => {
      restores += 1;
      assert.equal(typeof options.assertBeforeCommit, "function");
      await options.assertBeforeCommit();
      const { assertBeforeCommit, ...restoreOptions } = options;
      assert.deepEqual(restoreOptions, {
        authorization: { authorized: true, mode: "replace" },
        ...sources,
        liveCodexDir: codexDir
      });
      return { mode: "replace", restoredConversationFiles: 2 };
    }
  });
  const prepared = await service.prepareCodexReplacement(selection);
  now += 1;

  assert.deepEqual(
    await service.confirmCodexReplacement({ ...selection, confirmationToken: prepared.confirmationToken }),
    { mode: "replace", restoredConversationFiles: 2 }
  );
  await assert.rejects(
    () => service.confirmCodexReplacement({ ...selection, confirmationToken: prepared.confirmationToken }),
    /invalid or already used/i
  );
  assert.equal(restores, 1);
});

test("replacement confirmation rejects expiry, changed selection, running Codex, and changed state", async () => {
  const selection = { criticalId: "A".repeat(43), conversationId: "B".repeat(43) };
  const cases = [
    { name: "expired", mutate: (state) => { state.now += 300_001; }, expected: /expired/i },
    { name: "selection", request: { criticalId: "C".repeat(43) }, expected: /selection changed/i },
    { name: "running", confirmCount: 1, expected: /仍在运行/ },
    { name: "selected backup", confirmSelectionIdentity: "changed-selection", expected: /context changed/i },
    { name: "live state", confirmIdentity: "changed-live", expected: /context changed/i },
    { name: "snapshot", confirmSnapshotIdentity: "changed-snapshot", expected: /context changed/i }
  ];
  for (const item of cases) {
    const { userData, codexDir } = makeFixture();
    const state = { now: 1_800_000_000_000, selectionIdentities: ["selected", item.confirmSelectionIdentity ?? "selected"], identities: ["live", "live", item.confirmIdentity ?? "live"], snapshotIdentities: ["snapshot", item.confirmSnapshotIdentity ?? "snapshot"], counts: [0, item.confirmCount ?? 0] };
    let restores = 0;
    const service = createAccountService(userData, {
      codexDir,
      nowMs: () => state.now,
      closeCodexProcesses: () => 1,
      countCodexProcesses: () => state.counts.shift() ?? 0,
      getCodexStateIdentity: () => state.identities.shift(),
      getRecoverySelectionIdentity: async () => state.selectionIdentities.shift(),
      resolveCodexRecoverySelection: async () => ({ criticalGenerationDir: "critical", conversationManifestPath: "conversation" }),
      previewCodexRecovery: async () => ({ valid: true }),
      createCriticalCodexSnapshot: () => ({ generationDir: "snapshot" }),
      getCriticalSnapshotIdentity: () => state.snapshotIdentities.shift(),
      restoreCodexBackup: async () => { restores += 1; }
    });
    const prepared = await service.prepareCodexReplacement(selection);
    item.mutate?.(state);
    await assert.rejects(
      () => service.confirmCodexReplacement({ ...selection, ...item.request, confirmationToken: prepared.confirmationToken }),
      item.expected,
      item.name
    );
    assert.equal(restores, 0, item.name);
  }
});

test("replacement commit gate rejects a restarted Codex or late live-state change", async () => {
  for (const item of [
    { name: "process restarted", counts: [0, 0, 1], identities: ["live", "live", "live"] },
    { name: "state changed", counts: [0, 0, 0], identities: ["live", "live", "live", "changed"] }
  ]) {
    const { userData, codexDir } = makeFixture();
    const selection = { criticalId: "A".repeat(43), conversationId: "B".repeat(43) };
    const service = createAccountService(userData, {
      codexDir,
      closeCodexProcesses: () => 1,
      countCodexProcesses: () => item.counts.shift() ?? 0,
      getCodexStateIdentity: async () => item.identities.shift(),
      getRecoverySelectionIdentity: async () => "selected",
      resolveCodexRecoverySelection: async () => ({ criticalGenerationDir: "critical", conversationManifestPath: "conversation" }),
      previewCodexRecovery: async () => ({ valid: true }),
      createCriticalCodexSnapshot: () => ({ generationDir: "snapshot" }),
      getCriticalSnapshotIdentity: () => "snapshot",
      restoreCodexBackup: async ({ assertBeforeCommit }) => assertBeforeCommit()
    });
    const prepared = await service.prepareCodexReplacement(selection);
    await assert.rejects(
      () => service.confirmCodexReplacement({ ...selection, confirmationToken: prepared.confirmationToken }),
      /仍在运行|changed before replacement commit/i,
      item.name
    );
  }
});

test("daily backup process eligibility is asynchronous", async () => {
  const { userData, codexDir } = makeFixture();
  let heartbeat = false;
  const service = createAccountService(userData, {
    codexDir,
    countCodexProcesses: () => {
      throw new Error("synchronous process count must not run");
    },
    countCodexProcessesAsync: async () => {
      await new Promise((resolve) => setImmediate(resolve));
      return 1;
    }
  });
  setImmediate(() => { heartbeat = true; });

  assert.deepEqual(await service.runConversationBackup("daily-idle"), { skipped: true, reason: "codex_running" });
  assert.equal(heartbeat, true);
});

test("persists a protected account remark, preserves it on re-import, and clears it", { skip: process.platform !== "win32" }, () => {
  const { userData, codexDir } = makeFixture();
  fs.writeFileSync(
    path.join(codexDir, "auth.json"),
    JSON.stringify({ access_token: "remark-token", account_id: "remark-account" }),
    "utf8"
  );
  const service = createAccountService(userData, { codexDir });
  const imported = service.importCurrentAuth();

  const saved = service.setAccountRemark(imported.id, "  论文   😀   写作账号  ");
  assert.equal(saved.remark, "论文 😀 写作账号");

  const storePath = path.join(userData, "accounts-store.json");
  const rawStore = fs.readFileSync(storePath, "utf8");
  const stored = JSON.parse(rawStore).accounts[0];
  assert.equal(rawStore.includes("论文 😀 写作账号"), false);
  assert.equal(unprotectString(stored.encryptedRemark), "论文 😀 写作账号");
  assert.equal(service.listAccounts().find((account) => account.id === imported.id).remark, "论文 😀 写作账号");

  assert.equal(service.importCurrentAuth().remark, "论文 😀 写作账号");
  assert.throws(() => service.setAccountRemark(imported.id, "x".repeat(81)), /80/);

  const cleared = service.setAccountRemark(imported.id, " \n ");
  assert.equal(cleared.remark, undefined);
  assert.equal(Object.hasOwn(JSON.parse(fs.readFileSync(storePath, "utf8")).accounts[0], "encryptedRemark"), false);
});

test("rejects a replacement character before protecting an account remark", { skip: process.platform !== "win32" }, () => {
  const { userData, codexDir } = makeFixture();
  fs.writeFileSync(
    path.join(codexDir, "auth.json"),
    JSON.stringify({ access_token: "remark-token", account_id: "remark-account" }),
    "utf8"
  );
  const service = createAccountService(userData, { codexDir });
  const imported = service.importCurrentAuth();

  assert.throws(
    () => service.setAccountRemark(imported.id, `有效${String.fromCharCode(0xfffd)}备注`),
    /无法识别/
  );
  assert.equal(Object.hasOwn(JSON.parse(fs.readFileSync(path.join(userData, "accounts-store.json"), "utf8")).accounts[0], "encryptedRemark"), false);
});

test("rejects an unpaired UTF-16 surrogate before protecting an account remark", { skip: process.platform !== "win32" }, () => {
  const { userData, codexDir } = makeFixture();
  fs.writeFileSync(
    path.join(codexDir, "auth.json"),
    JSON.stringify({ access_token: "remark-token", account_id: "remark-account" }),
    "utf8"
  );
  const service = createAccountService(userData, { codexDir });
  const imported = service.importCurrentAuth();

  assert.throws(
    () => service.setAccountRemark(imported.id, `有效${String.fromCharCode(0xd800)}备注`),
    /无法识别/
  );
  assert.equal(Object.hasOwn(JSON.parse(fs.readFileSync(path.join(userData, "accounts-store.json"), "utf8")).accounts[0], "encryptedRemark"), false);
});

function unixTestNow() {
  return 2_000_000_000;
}


test("ordinary switching stays blocked while continuation is active", async () => {
  const service = createAccountService(makeTempRoot());
  service.manualResumePromise = new Promise(() => {});

  const result = await service.switchAccountPrioritized("missing", { manualInspection: true });

  assert.equal(result.status, "continuation_in_progress");
  assert.equal(result.retryable, true);
});

test("explicit force switching cancels a cancellable continuation before entering the guarded transaction", async () => {
  let clearedTimer;
  const service = createAccountService(makeTempRoot(), {
    clearTimeout: (timer) => {
      clearedTimer = timer;
      clearTimeout(timer);
    }
  });
  let release;
  let cancelled = false;
  const continuation = new Promise((resolve) => { release = resolve; });
  service.protocolResumePromise = continuation;
  service.cancelActiveProtocolResume = () => {
    cancelled = true;
    service.protocolResumePromise = undefined;
    release({ status: "uncertain" });
  };

  await assert.rejects(() => service.switchAccountPrioritized("missing", {
    manualInspection: true,
    forceSwitch: true,
    forceProjectionSwitch: true
  }));

  assert.equal(cancelled, true);
  assert.notEqual(clearedTimer, undefined);
  assert.equal(service.switchInProgress, false);
});

test("force switching does not race a non-cancellable desktop continuation", async () => {
  const service = createAccountService(makeTempRoot());
  service.manualResumePromise = Promise.resolve({ status: "pending" });

  const result = await service.switchAccountPrioritized("missing", {
    manualInspection: true,
    forceSwitch: true
  });

  assert.equal(result.status, "continuation_in_progress");
  assert.equal(result.forceBlocked, true);
  assert.equal(result.reason, "desktop_continuation_not_cancellable");
});
