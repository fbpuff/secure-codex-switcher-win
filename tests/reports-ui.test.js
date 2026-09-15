import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { formatBeijingTime } from "../src/core/beijing-time.js";

const html = fs.readFileSync(new URL("../src/renderer/index.html", import.meta.url), "utf8");
const app = fs.readFileSync(new URL("../src/renderer/app.js", import.meta.url), "utf8").replaceAll("\r\n", "\n");
const css = fs.readFileSync(new URL("../src/renderer/styles.css", import.meta.url), "utf8");
const preload = fs.readFileSync(new URL("../src/preload.cjs", import.meta.url), "utf8");
const main = fs.readFileSync(new URL("../src/main.js", import.meta.url), "utf8");
const reportPresentation = fs.readFileSync(new URL("../src/core/report-presentation.js", import.meta.url), "utf8");

test("dedicated add-account action preserves the current saved login", () => {
  assert.match(html, /id="add-account"/);
  assert.match(preload, /beginAddAccount:\s*\(\)\s*=>\s*invoke\("accounts:beginAdd"\)/);
  assert.match(main, /"accounts:beginAdd":\s*\(\)\s*=>\s*accountService\.beginAddAccountResponsive\(\)/);
  assert.match(preload, /completeAddAccount:\s*\(preservedAccountId\)\s*=>\s*invoke\("accounts:completeAdd", preservedAccountId\)/);
  assert.match(main, /"accounts:completeAdd"[\s\S]*accountService\.completeAddAccount\(preservedAccountId\)/);
  assert.match(app, /#add-account[\s\S]*api\.beginAddAccount\(\)[\s\S]*watchForAddedAccount/);
  assert.match(app, /api\.completeAddAccount\(preservedAccountId\)/);
});

function rendererFunctionSource(start, end) {
  return app.slice(app.indexOf(start), app.indexOf(end));
}

function createUsageRefreshProgressHarness(initialPending) {
  let listener;
  let status = "pending-wait";
  const api = {
    onUsageRefreshProgress: (callback) => { listener = callback; }
  };
  const source = rendererFunctionSource("api.onUsageRefreshProgress?.", "\n\ninitialize();");
  new Function("api", "pendingAutoSwitch", "setStatus", "t", source)(
    api,
    initialPending,
    (message) => { status = message; },
    (key) => key
  );
  return {
    emit: (progress) => listener({ operationId: 1, progress }),
    getStatus: () => status
  };
}

function createDiagnosticsHarness(initialPending, nextPending, options = {}) {
  const activityDiagnostics = { hidden: true, open: false };
  const activityDiagnosticIds = { textContent: "" };
  const statusLine = { textContent: "" };
  const clearSource = rendererFunctionSource("function clearActivityDiagnostics()", "function setStatus(");
  const statusSource = rendererFunctionSource("function setStatus(", "function showActivityDiagnostics(");
  const showSource = rendererFunctionSource("function showActivityDiagnostics(", "function stopAndRun(");
  const evaluateSource = rendererFunctionSource("async function evaluateQuotaActions(", "function clearPendingAutoSwitch(");
  const fallbackSource = rendererFunctionSource("function withPendingAutoSwitchFallback(", "function renderQuotaWarning(");
  const timerSource = rendererFunctionSource("function startPendingAutoSwitchTimer()", "async function checkPendingAutoSwitch()");
  const loadSource = rendererFunctionSource("async function loadAccounts(", "function initializeAccountScrollTracking()");
  const syncSource = rendererFunctionSource("async function syncAutoSwitchTargetState(", "async function handleAutoSwitchEvaluation(");
  const handlerSource = rendererFunctionSource("async function handleAutoSwitchEvaluation(", "async function finishAutoSwitch(");
  const createHarness = new Function("dependencies", `
    const {
      activityDiagnostics, activityDiagnosticIds, statusLine, api,
      waitForAccountScrollIdle, captureAccountReadingContext,
      syncSettingsControls, renderAccountSurfaces, restoreAccountReadingContext,
      renderQuotaWarning, t, errorMessage,
      currentLanguage, formatBeijingTime, autoSwitchQuietSecondsRemaining, fallbackReasonLabel,
      currentView,
      setInterval, clearInterval,
      initialPending
    } = dependencies;
    let accounts = [];
    let pendingAutoSwitch = initialPending;
    let pendingAutoSwitchTimer;
    let pendingAutoSwitchDisplayTimer;
    let selectedAccountId;
    let accountLoadRequestId = 0;
    let autoSwitchInProgress = false;
    let settings = { autoSwitchTargetMode: "automatic" };
    const accountsEl = { querySelectorAll: () => [] };
    const pendingAutoSwitchIntervalMs = 15_000;
    function checkPendingAutoSwitch() {}
    function renderDetail() {}
    ${clearSource}
    ${statusSource}
    ${showSource}
    ${evaluateSource}
    ${fallbackSource}
    ${timerSource}
    ${loadSource}
    ${syncSource}
    ${handlerSource}
    startPendingAutoSwitchTimer();
    activityDiagnostics.open = true;
    return {
      loadAccounts,
      handleAutoSwitchEvaluation,
      getState: () => ({ accounts, pendingAutoSwitch })
    };
  `);
  const noOp = () => {};
  let apiPending = nextPending;
  let evaluationCount = 0;
  const api = {
    listAccounts: options.listAccounts ?? (async () => [{ id: "account-1", isCurrent: true }]),
    getAutoSwitchState: async () => ({ pending: apiPending }),
    evaluateAutoSwitch: async (reason) => {
      evaluationCount += 1;
      return options.evaluateAutoSwitch?.(reason, evaluationCount) ?? { status: "disabled" };
    },
    readSettings: async () => ({ autoSwitchTargetMode: "automatic" })
  };
  const harness = createHarness({
    activityDiagnostics,
    activityDiagnosticIds,
    statusLine,
    api,
    initialPending,
    waitForAccountScrollIdle: options.waitForAccountScrollIdle ?? (async () => {}),
    captureAccountReadingContext: () => ({}),
    syncSettingsControls: noOp,
    renderAccountSurfaces: noOp,
    restoreAccountReadingContext: noOp,
    renderQuotaWarning: noOp,
    t: (key, values = {}) => values.email
      ? `${key}:${values.email}`
      : values.reason
        ? `${key}:${values.reason}`
        : key,
    errorMessage: (error) => error.message,
    currentLanguage: () => "en",
    formatBeijingTime,
    autoSwitchQuietSecondsRemaining: () => 10,
    fallbackReasonLabel: (reason) => `fallback.${reason}`,
    currentView: "accounts",
    setInterval: () => ({}),
    clearInterval: noOp
  });
  return {
    ...harness,
    activityDiagnostics,
    activityDiagnosticIds,
    statusLine,
    getEvaluationCount: () => evaluationCount,
    setApiPending: (pending) => { apiPending = pending; }
  };
}

test("pending switch survives refresh completion before asynchronous evaluation resolves", async () => {
  const pending = { emailMasked: "fixture@example.invalid", activeThreadIds: ["fixture-thread"] };
  let release;
  let entered;
  const evaluating = new Promise((resolve) => { entered = resolve; });
  const result = new Promise((resolve) => { release = resolve; });
  const harness = createDiagnosticsHarness(pending, pending, {
    evaluateAutoSwitch: (_reason, count) => {
      if (count > 1) return { status: "idle" };
      entered();
      return result;
    }
  });
  const original = harness.statusLine.textContent;
  const loading = harness.loadAccounts("background refresh completed");
  await evaluating;
  try {
    assert.equal(harness.statusLine.textContent, original);
  } finally {
    release({ status: "queued", pending });
    await loading;
  }
  harness.setApiPending(undefined);
  await harness.loadAccounts("normal refresh completed");
  assert.equal(harness.statusLine.textContent, "normal refresh completed");
});

test("identical status does not replace text but still clears obsolete diagnostics", () => {
  let writes = 0;
  const statusLine = { get textContent() { return "same"; }, set textContent(value) { writes += 1; } };
  let clears = 0;
  const source = rendererFunctionSource("function setStatus(", "function showActivityDiagnostics(");
  const setStatus = new Function("statusLine", "clearActivityDiagnostics", `${source}; return setStatus;`)(statusLine, () => { clears += 1; });
  setStatus("same", { preserveActivityDiagnostics: true });
  assert.equal(writes, 0);
  assert.equal(clears, 0);
  setStatus("same");
  assert.equal(writes, 0);
  assert.equal(clears, 1);
  setStatus("changed");
  assert.equal(writes, 1);
});

test("quota polling ignores attempt timestamps while tracking quota freshness and errors", () => {
  const source = rendererFunctionSource("function currentQuotaSignature(", "async function syncCurrentQuotaDisplay(");
  const signature = new Function(`${source}; return currentQuotaSignature;`)();
  const current = { id: "fixture", isCurrent: true, usage: { fetchedAt: 100, fiveHour: { remainingPercent: 1 } }, usageRefreshAttemptedAt: 100 };
  assert.equal(signature([current]), signature([{ ...current, usageRefreshAttemptedAt: 101 }]));
  for (const changed of [
    { ...current, usage: { ...current.usage, fetchedAt: 101 } },
    { ...current, usage: { ...current.usage, fiveHour: { remainingPercent: 0 } } },
    { ...current, usageError: "unavailable" },
    { ...current, id: "other-fixture" }
  ]) assert.notEqual(signature([current]), signature([changed]));
});

function createFinishAutoSwitchHarness(autoResumeStatus) {
  const finishSource = rendererFunctionSource("async function finishAutoSwitch(", "async function refreshAccountUsage(");
  const createHarness = new Function("dependencies", `
    const { clearPendingAutoSwitch, loadAccounts, t, fallbackReasonLabel, switchLaunchMessage } = dependencies;
    let autoSwitchInProgress = false;
    let selectedAccountId;
    ${finishSource}
    return { finishAutoSwitch, getSelectedAccountId: () => selectedAccountId };
  `);
  const messages = [];
  const harness = createHarness({
    clearPendingAutoSwitch: () => {},
    loadAccounts: async (message) => { messages.push(message); },
    t: (key) => key,
    fallbackReasonLabel: (reason) => reason,
    switchLaunchMessage: () => "launch"
  });
  return {
    run: () => harness.finishAutoSwitch(
      { id: "target", emailMasked: "target@example.com" },
      { closedCodexProcesses: 1, autoResume: { status: autoResumeStatus } }
    ),
    getMessage: () => messages.at(-1),
    getSelectedAccountId: harness.getSelectedAccountId
  };
}

test("renderer action wrapper forwards DOM events to checkbox handlers", () => {
  assert.match(app, /function runAction\(fn\)\s*{\s*return async \(event\) =>/);
  assert.match(app, /await fn\(event\)/);
});

test("current quota presentation identifies Codex app-server and omits unavailable windows", () => {
  assert.match(app, /account\.usage\?\.source === "codex_app_server"/);
  assert.match(app, /quota\.fiveHour \? detailUsageCard/);
  assert.match(app, /quota\.oneWeek \? detailUsageCard/);
  assert.match(app, /Codex app-server/);
});

test("default HTTP-only mode only confirms a restart when the current account inherits it", () => {
  assert.match(app, /const currentAccount = accounts\.find\(\(account\) => account\.isCurrent\);/);
  assert.match(app, /if \(!currentAccount\?\.httpOnlyModeOverride && !confirm\(t\("confirm\.httpOnly"\)\)\)/);
});

test("queued auto-switch status distinguishes readable active tasks from quiet countdown", () => {
  assert.match(app, /status\.autoSwitchWaitingTasks/);
  assert.match(app, /status\.autoSwitchConfirmingTasks/);
  assert.match(app, /status\.autoSwitchQuietCountdown/);
  assert.match(app, /autoSwitchQuietSecondsRemaining/);
});

test("manual account switching requests and displays a 90-second inspection countdown", () => {
  assert.match(app, /const options = \{\s*manualInspection:\s*true,\s*resumeQuotaInterruptedTask:/);
  assert.match(app, /api\.switchAccount\(account\.id, options\)/);
  assert.match(app, /manualSwitchResume\.checked = true/);
  assert.match(app, /manualSwitchForce\.checked = false/);
  assert.match(app, /forceSwitch:\s*choice\.forceSwitch/);
  assert.match(html, /id="manual-switch-force"/);
  assert.match(app, /"modal.manualSwitchForce": "强制切换"/);
  assert.match(app, /"modal.manualSwitchForce": "Force switch"/);
  assert.match(app, /当前账号周期内所有可确认的未完成任务/);
  assert.match(app, /every verified unfinished task from the current account cycle/);
  assert.doesNotMatch(html, /存在唯一可安全恢复的任务时自动继续；手动切换不会触发/);
  assert.match(app, /pendingAutoSwitch\.reason\s*===\s*"manual-switch-inspection"/);
  assert.ok(app.split('"status.manualSwitchInspectionCountdown"').length >= 3);
});

test("queued auto-switch status keeps busy tasks without IDs out of quiet countdown", () => {
  assert.match(app, /status\.autoSwitchWaitingUnknownThreads/);
  assert.match(app, /status\.autoSwitchConfirmingRecentActivity/);
  const pendingRenderer = app.slice(app.indexOf("function renderPendingAutoSwitchStatus()"), app.indexOf("async function checkPendingAutoSwitch()"));
  assert.match(pendingRenderer, /activityReason === "recent_session_activity"/);
  assert.match(pendingRenderer, /status\.autoSwitchConfirmingRecentActivity/);
  assert.doesNotMatch(pendingRenderer, /\[[^\]]*recent_session_activity[^\]]*\]\.includes/);
  assert.match(app, /activeTasks\?\.length/);
  assert.match(app, /activityBusy|activityStatus\?\.isBusy/);
});

test("recent session activity renders one confirming phase instead of an unknown running task", () => {
  const pending = {
    emailMasked: "target@example.com",
    activityBusy: true,
    activityReason: "recent_session_activity",
    activeTasks: []
  };
  const harness = createDiagnosticsHarness(pending, pending);

  assert.equal(
    harness.statusLine.textContent,
    "status.autoSwitchConfirmingRecentActivity:target@example.com"
  );
});

test("queued manual fallback context survives every pending activity phase", () => {
  const cases = [
    {
      pending: { activeTasks: [{ displayName: "Task" }], taskAssociationConfidence: "verified" },
      status: "status.autoSwitchWaitingTasks"
    },
    { pending: { activityBusy: true, activityReason: "recent_session_activity" }, status: "status.autoSwitchConfirmingRecentActivity" },
    { pending: { activityBusy: true, activityReason: "active_chat_process" }, status: "status.autoSwitchWaitingUnknownThreads" },
    { pending: { activityBusy: false, activityReason: "idle" }, status: "status.autoSwitchQuietCountdown" }
  ];
  for (const item of cases) {
    const pending = {
      emailMasked: "fallback@example.com",
      activeTasks: [],
      fallback: { reason: "manual_target_unavailable" },
      ...item.pending
    };
    const harness = createDiagnosticsHarness(pending, pending);
    assert.equal(
      harness.statusLine.textContent,
      `status.autoSwitchFallbackContext:fallback.manual_target_unavailable ${item.status}:fallback@example.com`
    );
  }
  const warningRenderer = rendererFunctionSource("function renderQuotaWarning()", "function showQuotaWarning(");
  const fallbackRenderer = rendererFunctionSource("function withPendingAutoSwitchFallback(", "function renderQuotaWarning(");
  assert.match(warningRenderer, /withPendingAutoSwitchFallback/);
  assert.match(fallbackRenderer, /pendingAutoSwitch\?\.fallback\?\.reason/);
  assert.match(fallbackRenderer, /status\.autoSwitchFallbackContext/);
});

test("usage refresh progress cannot replace a pending auto-switch status", () => {
  const pendingHarness = createUsageRefreshProgressHarness({ accountId: "fallback-account" });
  pendingHarness.emit({ stage: "refreshing", completed: 1, total: 3 });
  assert.equal(pendingHarness.getStatus(), "pending-wait");
  pendingHarness.emit({ stage: "persisting", total: 3 });
  assert.equal(pendingHarness.getStatus(), "pending-wait");

  const idleHarness = createUsageRefreshProgressHarness(undefined);
  idleHarness.emit({ stage: "refreshing", completed: 1, total: 3 });
  assert.equal(idleHarness.getStatus(), "status.usageRefreshProgress");
  idleHarness.emit({ stage: "persisting", total: 3 });
  assert.equal(idleHarness.getStatus(), "status.usageRefreshPersisting");
});

test("queued auto-switch status includes every active task without an omitted count", () => {
  assert.doesNotMatch(app, /activeTasks\.slice\(0,\s*3\)/);
  assert.doesNotMatch(app, /omittedThreadCount/);
  assert.match(app, /activeTasks\.length/);
  assert.match(app, /threadIdUnavailable/);
});

test("task and session IDs are hidden in expandable diagnostics", () => {
  assert.match(html, /id="activity-diagnostics"/);
  assert.match(html, /id="activity-diagnostic-ids"/);
  assert.match(app, /activityDiagnostics\.hidden/);
  assert.match(app, /activityDiagnosticIds\.textContent/);
  assert.match(app, /filter\(Boolean\)\.join\("\\n"\)/);
  assert.match(app, /诊断详情（任务\/会话 ID）/);
  assert.match(app, /Diagnostic details \(task\/session IDs\)/);
  assert.doesNotMatch(app, /诊断详情（机器 ID）|Diagnostic details \(machine IDs\)/);
});

test("queued auto-switch refresh preserves an open activity diagnostic disclosure", () => {
  const pendingRenderer = app.slice(
    app.indexOf("function renderPendingAutoSwitchStatus()"),
    app.indexOf("async function checkPendingAutoSwitch()")
  );
  const activeTasksBranch = pendingRenderer.slice(
    pendingRenderer.indexOf("if (pendingAutoSwitch.activeTasks?.length)"),
    pendingRenderer.indexOf("pendingAutoSwitch.activityBusy")
  );
  assert.match(
    activeTasksBranch,
    /setStatus\([\s\S]*?preserveActivityDiagnostics:\s*true[\s\S]*?showActivityDiagnostics\(/
  );
  const busyActivityBranch = pendingRenderer.slice(
    pendingRenderer.indexOf("pendingAutoSwitch.activityBusy"),
    pendingRenderer.indexOf("const seconds = autoSwitchQuietSecondsRemaining")
  );
  assert.match(
    busyActivityBranch,
    /setStatus\([\s\S]*?preserveActivityDiagnostics:\s*true[\s\S]*?showActivityDiagnostics\(/
  );
  const quietCountdownBranch = pendingRenderer.slice(
    pendingRenderer.indexOf("const seconds = autoSwitchQuietSecondsRemaining")
  );
  assert.match(
    quietCountdownBranch,
    /setStatus\([\s\S]*?preserveActivityDiagnostics:\s*true[\s\S]*?showActivityDiagnostics\(/
  );
  const pendingCleanup = app.slice(
    app.indexOf("function clearPendingAutoSwitch("),
    app.indexOf("function startPendingAutoSwitchTimer()")
  );
  assert.match(pendingCleanup, /clearActivityDiagnostics\(\)/);
  const statusHelpers = app.slice(
    app.indexOf("function clearActivityDiagnostics()"),
    app.indexOf("function showActivityDiagnostics(")
  );
  assert.match(statusHelpers, /activityDiagnostics\.open\s*=\s*false/);
  assert.match(statusHelpers, /preserveActivityDiagnostics\s*=\s*false/);
  assert.match(statusHelpers, /if \(!preserveActivityDiagnostics\) clearActivityDiagnostics\(\)/);
  const diagnosticsRenderer = app.slice(
    app.indexOf("function showActivityDiagnostics("),
    app.indexOf("function stopAndRun(")
  );
  assert.match(diagnosticsRenderer, /if \(ids\.length === 0 && !registryWarning\)\s*{\s*clearActivityDiagnostics\(\)/);
  assert.doesNotMatch(diagnosticsRenderer, /activityDiagnostics\.open\s*=\s*false/);
});

test("repeated queued fallback results render the current pending activity status", async () => {
  const initialPending = {
    emailMasked: "fallback@example.com",
    activityBusy: true,
    activityReason: "recent_session_activity",
    activeTasks: [],
    fallback: { reason: "manual_target_unavailable" }
  };
  const updatedPending = {
    ...initialPending,
    activityReason: "active_registry_task",
    activeTasks: [{ displayName: "Current task" }],
    taskAssociationConfidence: "verified"
  };
  const harness = createDiagnosticsHarness(initialPending, initialPending);

  await harness.handleAutoSwitchEvaluation({
    status: "queued",
    target: { emailMasked: "fallback@example.com" },
    pending: updatedPending,
    fallback: updatedPending.fallback
  });

  assert.equal(
    harness.statusLine.textContent,
    "status.autoSwitchFallbackContext:fallback.manual_target_unavailable status.autoSwitchWaitingTasks:fallback@example.com"
  );
});

test("queued check errors preserve activity diagnostics while pending continues", () => {
  const queuedCheck = app.slice(
    app.indexOf("async function checkPendingAutoSwitch()"),
    app.indexOf("async function syncAutoSwitchTargetState()")
  );
  const catchBranch = queuedCheck.slice(
    queuedCheck.indexOf("catch (error)"),
    queuedCheck.indexOf("finally")
  );
  assert.match(
    catchBranch,
    /setStatus\(errorMessage\(error\),\s*{\s*preserveActivityDiagnostics:\s*true\s*}\)/
  );
});

test("loadAccounts binds expanded diagnostics to the latest pending state", async () => {
  const activePending = (id) => ({ emailMasked: "a@example.com", activeThreadIds: [id] });
  const updatedHarness = createDiagnosticsHarness(activePending("thread-A"), activePending("thread-B"));

  await updatedHarness.loadAccounts("refreshed");

  assert.equal(updatedHarness.activityDiagnostics.open, true);
  assert.equal(updatedHarness.activityDiagnosticIds.textContent, "thread-B");

  const noDiagnosticsHarness = createDiagnosticsHarness(activePending("thread-A"), { emailMasked: "b@example.com" });
  await noDiagnosticsHarness.loadAccounts("refreshed");
  assert.equal(noDiagnosticsHarness.activityDiagnostics.open, false);
  assert.equal(noDiagnosticsHarness.activityDiagnosticIds.textContent, "");

  const endedHarness = createDiagnosticsHarness(activePending("thread-A"), undefined);
  await endedHarness.loadAccounts("refreshed");
  assert.equal(endedHarness.activityDiagnostics.open, false);
  assert.equal(endedHarness.activityDiagnosticIds.textContent, "");
});

test("latest terminal pending clears old task IDs while keeping registry diagnostics visible", async () => {
  const activePending = { emailMasked: "a@example.com", activeThreadIds: ["thread-ended"] };
  const terminalPending = {
    emailMasked: "a@example.com",
    activeThreadIds: [],
    activeTasks: [],
    processRegistryState: "corrupt",
    processRegistryDiagnostic: { state: "corrupt", reason: "all_zero", lastWriteMs: 900_000 }
  };
  const harness = createDiagnosticsHarness(activePending, terminalPending);

  await harness.loadAccounts("refreshed");

  assert.equal(harness.activityDiagnostics.open, true);
  assert.doesNotMatch(harness.activityDiagnosticIds.textContent, /thread-ended/);
  assert.match(harness.activityDiagnosticIds.textContent, /status\.processRegistryCorrupt/);
  assert.match(harness.activityDiagnosticIds.textContent, /status\.processRegistryReasonAllZero/);
});

test("deferred loadAccounts reads pending after scrolling settles", async () => {
  const activePending = (id) => ({ emailMasked: "a@example.com", activeThreadIds: [id] });
  const pendingA = activePending("thread-A");
  const pendingB = activePending("thread-B");
  let resumeWait;
  let signalWaitStarted;
  const waitStarted = new Promise((resolve) => { signalWaitStarted = resolve; });
  const harness = createDiagnosticsHarness(activePending("thread-start"), pendingA, {
    waitForAccountScrollIdle: () => {
      signalWaitStarted();
      return new Promise((resolve) => { resumeWait = resolve; });
    }
  });

  const load = harness.loadAccounts("refreshed", { deferWhileScrolling: true });
  await waitStarted;
  harness.setApiPending(pendingB);
  await harness.handleAutoSwitchEvaluation({ status: "queued", pending: pendingB });
  resumeWait();
  await load;

  assert.equal(harness.activityDiagnostics.open, true);
  assert.equal(harness.activityDiagnosticIds.textContent, "thread-B");
});

test("superseded deferred loadAccounts cannot overwrite or reevaluate a newer load", async () => {
  const pendingB = { emailMasked: "b@example.com", activeThreadIds: ["thread-B"] };
  let accountRequestCount = 0;
  let resumeWait;
  let signalWaitStarted;
  const waitStarted = new Promise((resolve) => { signalWaitStarted = resolve; });
  const harness = createDiagnosticsHarness(pendingB, pendingB, {
    listAccounts: async () => [{
      id: ++accountRequestCount === 1 ? "account-A" : "account-B",
      isCurrent: true
    }],
    waitForAccountScrollIdle: () => {
      signalWaitStarted();
      return new Promise((resolve) => { resumeWait = resolve; });
    }
  });

  const oldLoad = harness.loadAccounts("old load", { deferWhileScrolling: true });
  await waitStarted;
  await harness.loadAccounts("new load");
  resumeWait();
  await oldLoad;

  assert.deepEqual({
    accountId: harness.getState().accounts[0].id,
    status: harness.statusLine.textContent,
    evaluations: harness.getEvaluationCount()
  }, {
    accountId: "account-B",
    status: "status.autoSwitchQuietCountdown:b@example.com",
    evaluations: 1
  });
  assert.equal(harness.activityDiagnosticIds.textContent, "thread-B");
});

test("superseded quota evaluation cannot overwrite a newer account load", async () => {
  const pendingA = { emailMasked: "a@example.com", activeThreadIds: ["thread-A"] };
  const pendingB = { emailMasked: "b@example.com", activeThreadIds: ["thread-B"] };
  let accountRequestCount = 0;
  let resolveOldEvaluation;
  let signalOldEvaluationStarted;
  const oldEvaluationStarted = new Promise((resolve) => { signalOldEvaluationStarted = resolve; });
  const harness = createDiagnosticsHarness(pendingA, pendingA, {
    listAccounts: async () => [{
      id: ++accountRequestCount === 1 ? "account-A" : "account-B",
      isCurrent: true
    }],
    evaluateAutoSwitch: (_reason, evaluationCount) => {
      if (evaluationCount > 1) return { status: "queued", pending: pendingB };
      signalOldEvaluationStarted();
      return new Promise((resolve) => { resolveOldEvaluation = resolve; });
    }
  });

  const oldLoad = harness.loadAccounts("old load");
  await oldEvaluationStarted;
  harness.setApiPending(pendingB);
  await harness.loadAccounts("new load");
  resolveOldEvaluation({ status: "queued", pending: pendingA });
  await oldLoad;

  assert.equal(harness.getState().pendingAutoSwitch, pendingB);
  assert.equal(harness.activityDiagnosticIds.textContent, "thread-B");
  assert.equal(harness.statusLine.textContent, "status.autoSwitchQuietCountdown:b@example.com");
});

test("failed queued evaluation clears diagnostics absent from the latest pending state", async () => {
  const activePending = { emailMasked: "a@example.com", activeThreadIds: ["thread-A"] };
  const harness = createDiagnosticsHarness(activePending, { emailMasked: "b@example.com" });

  await harness.handleAutoSwitchEvaluation({ status: "failed", error: "queued check failed" });

  assert.equal(harness.statusLine.textContent, "queued check failed");
  assert.equal(harness.activityDiagnostics.open, false);
  assert.equal(harness.activityDiagnosticIds.textContent, "");
});

test("not-ready evaluation without pending state stops timers and clears diagnostics", () => {
  const handler = app.slice(
    app.indexOf("async function handleAutoSwitchEvaluation("),
    app.indexOf('if (result.status === "queued")')
  );
  assert.match(
    handler,
    /result\?\.status === "not_ready" && !result\.pending[\s\S]*?clearPendingAutoSwitch\(\)[\s\S]*?return/
  );
});

test("corrupt registry UI distinguishes lifecycle inference from process association", () => {
  assert.ok(app.split('"status.processRegistryCorrupt"').length >= 3);
  assert.ok(app.split('"status.autoSwitchWaitingInferredTasks"').length >= 3);
  assert.ok(app.split('"status.autoSwitchConfirmingInferredTasks"').length >= 3);
  assert.match(app, /\["missing", "corrupt"\]\.includes\(processRegistryState\)/);
  assert.match(app, /taskAssociationConfidence !== "verified"/);
  assert.match(app, /task_lifecycle_confirming_end[\s\S]*status\.autoSwitchConfirmingInferredTasks/);
  assert.match(app, /status\.processRegistryCorrupt/);
});

test("lifecycle task wording treats PID only as diagnostics", () => {
  assert.match(app, /本机生命周期记录显示任务“\{tasks\}”仍活跃/);
  assert.match(app, /Local lifecycle records show task\(s\) “\{tasks\}” as active/);
  assert.match(app, /PID 仅作进程诊断，不作为线程身份/);
  assert.match(app, /PID is diagnostic only and is not a thread identity/);
  assert.doesNotMatch(app, /精确 PID 归属|exact PID ownership/);
  assert.doesNotMatch(app, /任务记录显示“\{tasks\}”仍活跃|Task records show “\{tasks\}” as active/);
});

test("registry-only task wording states direct activity without PID ownership", () => {
  const pending = {
    emailMasked: "a@example.com",
    activeThreadIds: ["registry-task"],
    activeTasks: [{ id: "registry-task", displayName: "Registry task" }],
    activityReason: "active_registry_task",
    taskEvidenceSource: "process_registry",
    taskAssociationConfidence: "unavailable",
    processRegistryState: "valid"
  };
  const harness = createDiagnosticsHarness(pending, pending);

  assert.equal(harness.statusLine.textContent, "status.autoSwitchWaitingRegistryTasks:a@example.com");
  assert.match(app, /Codex 实时登记显示任务“\{tasks\}”仍有逻辑活动/);
  assert.match(app, /The live Codex registry shows task\(s\) “\{tasks\}” as logically active/);
  assert.doesNotMatch(app, /精确 PID 归属|exact PID ownership/);
});

test("registry plus lifecycle wording preserves direct registry evidence without PID ownership", () => {
  const pending = {
    emailMasked: "a@example.com",
    activeThreadIds: ["registry-task", "lifecycle-task"],
    activeTasks: [
      { id: "registry-task", displayName: "Registry task" },
      { id: "lifecycle-task", displayName: "Lifecycle task" }
    ],
    activityReason: "active_registry_task",
    taskEvidenceSource: "mixed",
    taskAssociationConfidence: "unavailable",
    processRegistryState: "valid"
  };
  const harness = createDiagnosticsHarness(pending, pending);

  assert.equal(harness.statusLine.textContent, "status.autoSwitchWaitingRegistryAndInferredTasks:a@example.com");
  assert.match(app, /Codex 实时登记显示当前逻辑活动，其他任务来自生命周期记录/);
  assert.match(app, /The live Codex registry shows current logical activity while other tasks come from lifecycle records/);
});

test("mixed task evidence keeps PID out of the thread identity wording", () => {
  const pending = {
    emailMasked: "a@example.com",
    activeThreadIds: ["registry-task", "lifecycle-task"],
    activeTasks: [
      { id: "registry-task", displayName: "Registry task" },
      { id: "lifecycle-task", displayName: "Lifecycle task" }
    ],
    activityReason: "active_chat_process",
    taskEvidenceSource: "mixed",
    taskAssociationConfidence: "partial",
    processRegistryState: "valid"
  };
  const harness = createDiagnosticsHarness(pending, pending);

  assert.equal(harness.statusLine.textContent, "status.autoSwitchWaitingMixedTasks:a@example.com");
  assert.match(app, /一部分任务来自 Codex 实时登记，其他来自生命周期记录/);
  assert.match(app, /Some tasks come from the live Codex registry while others come from lifecycle records/);
  assert.doesNotMatch(app, /精确 PID 归属|exact PID ownership/);
});

test("activity diagnostics render bounded registry state reason and last-write time", () => {
  assert.match(app, /processRegistryDiagnostic/);
  assert.match(app, /status\.processRegistryReasonAllZero/);
  assert.match(app, /status\.processRegistryReasonMalformedJson/);
  assert.match(app, /status\.processRegistryReasonNotFound/);
  assert.match(app, /status\.processRegistryReasonUnreadable/);
  assert.match(app, /status\.processRegistryReasonUnstable/);
  assert.match(app, /原因：文件无法读取。/);
  assert.match(app, /Reason: the file cannot be read\./);
  assert.match(app, /原因：文件在读取期间发生变化。/);
  assert.match(app, /Reason: the file changed while it was being read\./);
  assert.match(app, /lastWriteMs/);
});

test("activity diagnostics state when the registry predates the current Codex app-server start", () => {
  assert.match(app, /进程登记早于当前 Codex app-server 启动/);
  assert.match(app, /The process registry predates the current Codex app-server start/);
  assert.match(app, /predatesAppServerStart/);
  assert.match(app, /latestOfficialAppServerStartMs/);
});

test("ignored registry rows are labelled as historical tool-task registrations", () => {
  assert.match(app, /已忽略 \{count\} 条历史工具任务登记/);
  assert.match(app, /Ignored \{count\} historical tool-task registration/);
  assert.doesNotMatch(app, /过期任务登记/);
});

test("unassociated official processes are described as bounded countdown diagnostics", () => {
  assert.ok(app.split('"status.autoSwitchQuietCountdownUnassociatedProcess"').length >= 3);
  assert.match(app, /activityReason === "unassociated_official_process"/);
  assert.match(app, /\["missing", "corrupt"\]\.includes\(processRegistryState\)/);
  assert.doesNotMatch(app, /\[[^\]]*"unassociated_official_process"[^\]]*\]\.includes\(pendingAutoSwitch\.activityReason\)/);
});

test("reports navigation appears between usage and settings", () => {
  const usageIndex = html.indexOf('id="usage-nav"');
  const reportsIndex = html.indexOf('id="reports-nav"');
  const settingsIndex = html.indexOf('id="settings-nav"');
  assert.ok(usageIndex >= 0 && reportsIndex > usageIndex && settingsIndex > reportsIndex);
  assert.match(html, /id="reports-view"/);
  assert.match(html, /data-i18n="nav\.reports"/);
});

test("weekly reports expose week and dimension filters plus transparent summaries", () => {
  for (const id of [
    "reports-week",
    "reports-account-filter",
    "reports-model-filter",
    "reports-effort-filter",
    "reports-confidence-filter",
    "reports-total-tokens",
    "reports-five-capacity",
    "reports-week-capacity",
    "reports-account-table",
    "reports-model-groups",
    "reports-reset-history"
  ]) assert.match(html, new RegExp(`id="${id}"`));
  assert.match(app, /function renderReportsView\(/);
  assert.match(app, /function refreshWeeklyReport\(/);
  assert.match(app, /local_observation/);
});

test("renderer IPC supports weekly report loading and private-history reset", () => {
  assert.match(preload, /getDailyUsageReport/);
  assert.match(preload, /getWeeklyUsageReport/);
  assert.match(preload, /clearUsageObservations/);
  assert.match(main, /reports:daily/);
  assert.match(main, /reports:weekly/);
  assert.match(main, /reports:clear/);
  assert.match(app, /confirm\(t\("confirm\.clearUsageObservations"\)\)/);
});

test("preload exposes path-free conversation backup and recovery preview actions", () => {
  assert.match(preload, /runConversationBackup:\s*\(\)\s*=>\s*invoke\("backup:conversations", \+\+conversationBackupOperationId\)/);
  assert.match(preload, /listCodexRecoveryBackups:\s*\(\{\s*full\s*=\s*true\s*\}\s*=\s*\{\}\)\s*=>\s*invoke\("backup:listCodexRecovery",\s*full,\s*\+\+recoveryOperationId\)/);
  assert.match(preload, /previewCodexRecovery:\s*\(selection\)\s*=>\s*invoke\("backup:previewCodexRecovery",\s*selection,\s*\+\+recoveryOperationId\)/);
  assert.match(preload, /onRecoveryProgress/);
});

test("settings provide explicit backup controls and aggregate-only recovery preview", () => {
  for (const id of [
    "settings-codex-backup",
    "settings-run-conversation-backup",
    "settings-critical-backup",
    "settings-conversation-backup",
    "settings-preview-recovery",
    "settings-recovery-preview"
  ]) assert.match(html, new RegExp(`id="${id}"`));
  assert.match(html, /id="settings-recovery-preview"[^>]*aria-live="polite"/);
  assert.match(app, /api\.listCodexRecoveryBackups\(\{\s*full\s*\}\)/);
  assert.match(app, /api\.runConversationBackup\(\)/);
  assert.match(app, /api\.previewCodexRecovery\(selection\)/);
  assert.match(app, /settingsRunConversationBackup\.disabled\s*=\s*true/);
  assert.match(app, /formatBeijingTime\(generation\.backupTime\)/);
  assert.match(app, /option\.value\s*=\s*generation\.generationId/);
  for (const field of ["backupTime", "projects", "assignments", "threads", "active", "archived", "missing", "conflicts"]) {
    assert.match(app, new RegExp(`preview(?:\\.counts|\\.effects)?\\.${field}|preview\\.${field}`), `${field} should be rendered from the preview`);
  }
  for (const key of [
    "settings.codexBackupTitle",
    "settings.runConversationBackup",
    "settings.previewRecovery",
    "settings.recoveryPreviewPrivacy",
    "settings.backupSucceeded",
    "settings.backupFailed"
  ]) assert.ok(app.split(`"${key}"`).length >= 3, `${key} should be bilingual and used`);
});

test("settings surface quarantined backups through an explicit path-free revalidation action", () => {
  for (const id of ["settings-quarantined-conversation-backup", "settings-revalidate-quarantined-conversation", "settings-refresh-recovery-backups"]) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(preload, /revalidateQuarantinedConversation/);
  assert.match(app, /quarantinedConversationGenerations/);
  assert.match(app, /api\.revalidateQuarantinedConversation\(/);
  assert.match(app, /api\.listCodexRecoveryBackups\(\{\s*full\s*\}\)/);
  assert.match(app, /if\s*\(\s*recoveryBackups\s*&&\s*!force/);
  const quarantinedSelect = app.slice(
    app.indexOf("function populateQuarantinedConversationBackupSelect("),
    app.indexOf("function backupOptionLabel(")
  );
  assert.doesNotMatch(quarantinedSelect, /(?:path|filename|blob|sha256)/i);
});

test("settings persist a safe recovery inventory across restarts without blanking refreshes", () => {
  assert.match(app, /RECOVERY_INVENTORY_MAX_AGE_MS\s*=\s*7\s*\*\s*24\s*\*\s*60\s*\*\s*60\s*\*\s*1_000/);
  assert.match(app, /localStorage\.getItem\(RECOVERY_INVENTORY_CACHE_KEY\)/);
  assert.match(app, /localStorage\.setItem\(RECOVERY_INVENTORY_CACHE_KEY/);
  assert.match(app, /recoveryBackups\s*=\s*cachedRecoveryInventory\.inventory/);
  assert.match(app, /recoveryBackupsListedAt\s*=\s*cachedRecoveryInventory\.listedAt/);
  assert.match(app, /recoveryBackupsFullValidatedAt\s*=\s*cachedRecoveryInventory\.fullValidatedAt/);
  const loader = app.match(/async function loadCodexRecoveryBackups[\s\S]*?\n\}/);
  assert.ok(loader, "recovery loader should remain identifiable");
  assert.match(loader[0], /if \(recoveryBackups\) renderRecoveryBackupOptions\(\)/);
  assert.match(loader[0], /if \(recoveryBackups && !force\) await loadSettings\(\)/);
  assert.match(loader[0], /recoveryBackupsListedAt >= latestConversationBackupAt/);
  assert.match(loader[0], /recoveryBackupsFullValidatedAt/);
  assert.match(loader[0], /api\.listCodexRecoveryBackups\(\{\s*full\s*\}\)/);
  assert.match(loader[0], /if\s*\(full\)\s*recoveryBackupsFullValidatedAt\s*=\s*completedAt/);
  assert.doesNotMatch(loader[0], /catch[\s\S]*recoveryBackups\s*=\s*undefined/);
  assert.match(app, /settingsRefreshRecoveryBackups\.addEventListener\("click",[\s\S]*?loadCodexRecoveryBackups\(\{\s*force:\s*true,\s*full:\s*true\s*\}\)/);
  assert.ok(app.split(/loadCodexRecoveryBackups\(\{\s*force:\s*true,\s*full:\s*false\s*\}\)/).length >= 3, "validated mutations should refresh metadata only");
  const explicitBackup = app.slice(app.indexOf("async function runExplicitConversationBackup()"), app.indexOf("api.onConversationBackupProgress("));
  assert.ok(
    explicitBackup.indexOf("await loadSettings()") < explicitBackup.indexOf("await loadCodexRecoveryBackups({ force: true, full: false })"),
    "a successful full backup should expose its new validation time before the metadata refresh"
  );
});

test("quarantined revalidation shows aggregate validation progress", () => {
  assert.match(app, /function revalidateSelectedQuarantinedConversation\(\) \{[\s\S]*?activeRecoveryGeneration = generation/);
  assert.match(app, /function revalidateSelectedQuarantinedConversation\(\) \{[\s\S]*?recoveryProgress = \{ stage: "discovering" \}/);
  assert.match(app, /validating: "settings\.recoveryStageValidating"/);
});

test("recovery-list completion uses recovery-specific wording", () => {
  const recoveryRenderer = app.match(/function renderRecoveryProgress\(\) \{[\s\S]*?\n\}\n\nfunction renderRecoveryBackupOptions/);
  assert.ok(recoveryRenderer, "recovery progress renderer should remain identifiable");
  assert.match(recoveryRenderer[0], /completed: "settings\.recoveryStageCompleted"/);
  assert.doesNotMatch(recoveryRenderer[0], /completed: "settings\.backupStageCompleted"/);
  assert.ok(app.split('"settings.recoveryStageCompleted"').length >= 3, "completion wording should be localized and used");
});

test("settings show accessible honest conversation-backup progress", () => {
  for (const id of ["settings-backup-progress", "settings-backup-progress-bar", "settings-backup-progress-detail"]) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(html, /id="settings-backup-progress-bar"[^>]*<|<progress[^>]*id="settings-backup-progress-bar"/);
  assert.match(app, /api\.onConversationBackupProgress\(/);
  assert.match(app, /removeAttribute\("value"\)/);
  assert.match(app, /progress\.processedBytes\s*\/\s*progress\.totalBytes/);
  assert.match(app, /if \(progress\?\.stage === "completed"\) return;/);
  assert.match(app, /result\?\.counts\?\.active/);
  assert.match(app, /conversationBackupStartedAt/);
  assert.match(app, /settings\.backupStageDiscovering/);
  assert.match(app, /settings\.backupStageProcessing/);
  assert.match(app, /settings\.backupStageValidating/);
  assert.match(app, /settings\.backupStagePruning/);
  assert.match(css, /\.settings-backup-progress/);
});

test("settings show complete recovery points, honest ETA, and only five recent critical backups by default", () => {
  for (const id of ["settings-complete-recovery-point", "settings-show-earlier-backups", "settings-recovery-progress-bar"]) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(app, /completeRecoveryPoints/);
  assert.match(app, /criticalGenerations\.slice\(0,\s*5\)/);
  assert.match(app, /settings\.showEarlierBackups/);
  assert.match(app, /estimatedRemaining/);
  assert.match(app, /onRecoveryProgress/);
  assert.match(app, /recoveryPointId/);
  assert.match(app, /api\.previewCodexRecovery\(\{[\s\S]*\.\.\.selection|api\.previewCodexRecovery\(selection\)/);
  assert.match(app, /settingsPreviewRecovery\.disabled\s*=\s*!hasRecoverySelection\(\)/);
  assert.match(app, /recoveryPreviewGeneration/);
  assert.match(app, /criticalCapturedAt/);
  assert.match(app, /conversationCapturedAt/);
});

test("recovery replacement is isolated in a preview-gated two-stage danger zone", () => {
  assert.match(html, /id="settings-recovery-danger"[^>]*class="settings-recovery-danger"/);
  assert.match(html, /id="settings-replace-recovery"[^>]*class="settings-replace-recovery danger"[^>]*disabled/);
  assert.match(html, /id="settings-replacement-status"[^>]*aria-live="polite"/);
  assert.match(preload, /prepareCodexReplacement:\s*\(selection\)\s*=>\s*invoke\("backup:prepareCodexReplacement",\s*selection\)/);
  assert.match(preload, /confirmCodexReplacement:\s*\(request\)\s*=>\s*invoke\("backup:confirmCodexReplacement",\s*request\)/);
  assert.match(app, /latestRecoverySelection\s*=\s*undefined/);
  assert.match(app, /function updateReplacementAvailability\(/);
  assert.match(app, /api\.prepareCodexReplacement\(selection\)/);
  assert.match(app, /if\s*\(!confirm\(t\("confirm\.replaceCodexRecovery"\)\)\)\s*{[\s\S]*?return;/);
  assert.match(app, /api\.confirmCodexReplacement\(\{\s*\.\.\.selection,\s*confirmationToken:\s*prepared\.confirmationToken\s*\}\)/);
  assert.match(app, /await loadCodexRecoveryBackups\(\)/);
  assert.doesNotMatch(app, /confirmationToken[^\n]*(?:textContent|innerHTML)/);
  assert.match(css, /\.settings-recovery-danger\s*{[^}]*border:[^;]*var\(--danger\)[^}]*background:[^;]*var\(--danger-soft\)/s);
  assert.match(css, /\.settings-replace-recovery\s*{[^}]*background:[^;]*var\(--danger\)/s);
});

test("renderer exposes one-time automatic-switch exclusion controls", () => {
  assert.match(preload, /setAutoSwitchExcluded/);
  assert.match(preload, /clearAutoSwitchExclusions/);
  assert.match(main, /autoSwitch:setExcluded/);
  assert.match(main, /autoSwitch:clearExclusions/);
  assert.match(html, /id="settings-auto-exclusions"/);
  assert.match(html, /id="settings-clear-auto-exclusions"/);
  assert.match(app, /t\("detail\.autoSwitchExcluded"\)/);
  assert.match(app, /settings\.autoSwitchExcluded/);
  assert.match(app, /toggleAutoSwitchExcluded/);
});

test("renderer exposes a persistent current-account hold distinct from exclusions", () => {
  assert.match(html, /id="quota-auto-switch-action"/);
  assert.match(app, /autoSwitchStayAccountId/);
  assert.match(app, /quota\.autoSwitchHeld/);
  assert.match(app, /actions\.holdCurrentAccount/);
  assert.match(app, /actions\.resumeAutoSwitch/);
  assert.match(app, /autoSwitchStayAccountId:\s*current\.id/);
  assert.match(app, /autoSwitchStayAccountId:\s*""/);
  assert.doesNotMatch(app, /autoSwitchEnabled:\s*false[^\n]*holdCurrentAccount/);
  assert.doesNotMatch(app, /autoSwitchExcludedAccountIds[^\n]*holdCurrentAccount/);
});

test("renderer exposes the default-off quota auto-resume setting and outcome contract", () => {
  assert.match(html, /id="settings-auto-resume-after-quota"[^>]*type="checkbox"/);
  assert.match(app, /autoResumeAfterQuotaSwitch:\s*false/);
  assert.match(app, /settingsAutoResumeAfterQuota/);
  assert.match(app, /updateSettings\(\{\s*autoResumeAfterQuotaSwitch:\s*settingsAutoResumeAfterQuota\.checked\s*\}\)/);
  assert.match(app, /settingsAutoResumeAfterQuota\.checked\s*=\s*Boolean\(settings\.autoResumeAfterQuotaSwitch\)/);
  assert.match(app, /const autoResume = switchResult\?\.autoResume/);
  for (const key of [
    "settings.autoResumeAfterQuotaSwitch",
    "settings.autoResumeAfterQuotaSwitchHelp",
    "status.autoResumeOn",
    "status.autoResumeOff",
    "status.autoResumeStarted",
    "status.autoResumeFailed",
    "status.autoResumeUncertain",
    "status.autoResumeSkipped"
  ]) {
    assert.ok(app.includes(`"${key}"`), `${key} should be defined or used`);
  }
  assert.match(html, /data-i18n="settings\.autoResumeAfterQuotaSwitch"/);
  assert.match(html, /data-i18n="settings\.autoResumeAfterQuotaSwitchHelp"/);
});

test("finishAutoSwitch renders honest automatic-resume outcomes without hiding switch success", async () => {
  const outcomes = [
    ["started", "status.autoResumeStarted"],
    ["failed", "status.autoResumeFailed"],
    ["uncertain", "status.autoResumeUncertain"],
    ["skipped", "status.autoResumeSkipped"]
  ];
  for (const [status, messageKey] of outcomes) {
    const harness = createFinishAutoSwitchHarness(status);
    await harness.run();
    assert.match(harness.getMessage(), /status\.autoSwitched/);
    assert.ok(harness.getMessage().includes(messageKey));
    assert.equal(harness.getSelectedAccountId(), "target");
  }
});

test("renderer keeps the current-account hold action visible at normal quota", () => {
  const renderer = app.slice(
    app.indexOf("function renderQuotaWarning()"),
    app.indexOf("function showQuotaWarning(")
  );
  assert.match(renderer, /if \(!current\)[\s\S]*?hideQuotaWarning\(\)/);
  assert.match(renderer, /showQuotaWarning\(\s*t\("quota\.autoSwitchAvailable"\),\s*"actions\.holdCurrentAccount",\s*"neutral"\s*\)/);
  assert.doesNotMatch(renderer, /if \(!canHold && !shouldWarn\)[\s\S]*?hideQuotaWarning\(\)/);
});

test("reports default to daily mode and retain weekly summaries", () => {
  assert.match(html, /id="reports-mode-daily"[^>]*aria-pressed="true"/);
  assert.match(html, /id="reports-mode-weekly"[^>]*aria-pressed="false"/);
  assert.match(html, /class="reports-mode-segmented"/);
  assert.match(app, /let reportMode = "daily"/);
  assert.match(app, /api\.getDailyUsageReport/);
  assert.match(app, /api\.getWeeklyUsageReport/);
  assert.match(app, /reports\.dailyTitle/);
  assert.match(app, /reports\.weeklyTitle/);
});

test("daily report maximum remains today after selecting an older date and switching modes", () => {
  assert.match(app, /function currentReportMaximum\(mode/);
  assert.match(app, /reportsWeekInput\.max = currentReportMaximum\(reportMode\)/);
  assert.doesNotMatch(app, /reportsWeekInput\.max = mode === "daily" \? reportDates\.daily : reportDates\.weekly/);
  assert.match(html, /id="reports-today"/);
});

test("today action is contained within the report date field", () => {
  assert.match(html, /class="reports-date-field"[\s\S]*?id="reports-week"[\s\S]*?id="reports-today"/);
  assert.match(css, /\.reports-date-field\s*{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s+auto;[^}]*border:\s*1px solid var\(--line\)/s);
  assert.doesNotMatch(css, /\.reports-date-control\s*{[^}]*grid-template-columns:/s);
});

test("detail help button is a compact centered circle", () => {
  assert.match(app, /class="help-circle-icon"[^>]*aria-hidden="true"[^>]*>\s*<use href="#help-circle-symbol"><\/use>/s);
  assert.doesNotMatch(app, /detail-score-help-glyph/);
  assert.match(css, /\.detail-score-help-button\s*{[^}]*width:\s*16px;[^}]*height:\s*16px;[^}]*padding:\s*0/s);
  assert.match(css, /\.help-circle-icon\s*{[^}]*display:\s*block;[^}]*width:\s*14px;[^}]*height:\s*14px/s);
  assert.match(css, /\.detail-score-help-button:focus-visible/);
});

test("account reports use intuitive metrics and secondary capacity evidence", () => {
  assert.doesNotMatch(html, /data-i18n="reports\.tokenRate"/);
  assert.doesNotMatch(html, /data-i18n="reports\.quotaRate"/);
  for (const key of ["reports.composition", "reports.share", "reports.sessions", "reports.averageSession", "reports.attributionConfidence", "reports.coverage", "reports.metricHelp"]) {
    assert.ok(app.split(`"${key}"`).length >= 3, `${key} should be bilingual and used`);
  }
  assert.match(html, /id="reports-capacity-details"/);
  assert.match(html, /class="reports-metric-help"/);
  assert.match(css, /min-height:\s*16px/);
  assert.match(css, /min-width:\s*16px/);
});

test("reports explain metrics and render non-overlapping token bars", () => {
  assert.match(app, /nonCachedInput\s*=\s*Math\.max\(0,\s*usage\.inputTokens\s*-\s*usage\.cachedInputTokens\)/);
  assert.match(app, /class="token-composition-bar"/);
  assert.match(app, /reset\.emailMasked/);
  assert.doesNotMatch(html, /reports\.rateHelp/);
  for (const key of ["reports.accountHelp", "reports.compositionHelp", "reports.modelHelp", "reports.capacityHelp", "reports.resetHelp", "reports.unattributedHelp"]) {
    assert.ok(app.split(`"${key}"`).length >= 3, `${key} should be bilingual and used`);
  }
  assert.ok((html.match(/class="reports-metric-help"/g) ?? []).length >= 5);
});

test("renderer removes Electron IPC wrapper from actionable errors", () => {
  assert.match(app, /Error invoking remote method/);
  assert.match(app, /replace\(/);
});

test("switch result distinguishes a verified restart from a fresh launch", () => {
  assert.match(app, /result\.verifiedCodexClosure/);
  assert.match(app, /status\.launchFresh/);
  assert.match(app, /status\.launchOk/);
});

test("token composition uses one viewport-safe interactive donut popover", () => {
  assert.match(html, /id="token-composition-popover"[^>]*role="dialog"/);
  assert.match(app, /token-composition-trigger/);
  assert.match(app, /positionTokenCompositionPopover/);
  assert.match(app, /conic-gradient/);
  assert.match(app, /compositionPinnedTrigger/);
  assert.match(app, /event\.key === "Escape"/);
  assert.match(css, /\.token-composition-popover\s*{[^}]*position:\s*fixed/s);
  assert.match(css, /\.token-composition-trigger\s*{[^}]*width:\s*110px/s);
  assert.doesNotMatch(app, /token-composition-legend/);
});

test("account report uses five centered groups without quota-change evidence or horizontal scrolling", () => {
  assert.equal((html.match(/<th class="report-account-group"/g) ?? []).length, 5);
  assert.match(html, /reports\.usageOverview/);
  assert.doesNotMatch(html, /reports\.quotaObservedChange/);
  assert.doesNotMatch(app, /formatQuotaLines/);
  assert.doesNotMatch(app, /class="report-quota-cell"/);
  assert.match(css, /\.reports-table-wrap\s*{[^}]*overflow-x:\s*hidden/s);
  assert.match(css, /\.report-account-group\s*{[^}]*text-align:\s*center/s);
  assert.match(css, /\.report-account-row\s*>\s*td\s*{[^}]*text-align:\s*center/s);
  assert.match(css, /@media \(max-width:\s*760px\)[\s\S]*\.report-account-row\s*{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/s);
});

test("report layout keeps expandable model evidence", () => {
  assert.match(app, /model-disclosure-button/);
  assert.match(app, /model-evidence-panel/);
  assert.match(app, /expandedModelDisclosure/);
});

test("usage charts share one date toolbar and identical seven-row geometry", () => {
  assert.equal((html.match(/class="usage-date-picker"/g) ?? []).length, 1);
  assert.match(html, /class="usage-chart-toolbar"/);
  assert.match(css, /\.usage-chart-series\s*{[^}]*grid-template-rows:\s*repeat\(7,\s*var\(--usage-chart-row-height\)\)/s);
  assert.match(css, /\.usage-hit-layout\s*{[^}]*gap:\s*6px/s);
  assert.match(css, /--usage-chart-row-height:\s*46px/);
  assert.match(css, /\.usage-bar-row\s*{[^}]*height:\s*var\(--usage-chart-row-height\)/s);
  assert.match(app, /class="usage-extrema-marker"/);
  assert.match(css, /\.usage-bar-value\s*{[^}]*grid-template-rows:/s);
  assert.doesNotMatch(css, /\.usage-bar-row\s*>\s*strong\s*em\s*{[^}]*position:\s*absolute/s);
});

test("desktop account rows preserve table-cell geometry and model controls stay centered", () => {
  assert.match(css, /\.reports-table\s*{[^}]*table-layout:\s*fixed/s);
  assert.doesNotMatch(css, /\.reports-table td:first-child\s*{[^}]*display:\s*grid/s);
  assert.doesNotMatch(css, /\.report-usage-overview\s*{[^}]*display:\s*grid/s);
  assert.match(css, /\.model-disclosure-button\s*{[^}]*display:\s*grid;[^}]*place-items:\s*center/s);
  assert.match(app, /class="report-model-account"[^>]*data-label=/);
});

test("account refresh captures and restores reading context", () => {
  assert.match(app, /function captureAccountReadingContext\(/);
  assert.match(app, /function restoreAccountReadingContext\(/);
  assert.match(app, /requestAnimationFrame/);
  assert.match(app, /listPanel\.scrollTop/);
  assert.match(app, /detailEl\.scrollTop/);
});

test("background account refresh prioritizes the current account before one broad refresh", () => {
  const refreshBody = rendererFunctionSource("async function refreshAllUsageInBackground()", "function startCurrentQuotaSyncTimer()");
  const broadRefreshAt = refreshBody.indexOf("await api.refreshAllUsage()");
  assert.ok(broadRefreshAt >= 0);
  assert.match(refreshBody, /await api\.refreshUsage\(currentAccount\.id, true\)/);
  assert.equal((refreshBody.match(/await loadAccounts\(/g) ?? []).length, 2);
  assert.match(refreshBody, /deferWhileScrolling:\s*true/);
  assert.match(app, /function markAccountScrollActive\(/);
  assert.match(app, /async function waitForAccountScrollIdle\(/);
  assert.match(app, /listPanel\.addEventListener\("scroll", markAccountScrollActive, \{ passive: true \}\)/);
  assert.match(app, /detailEl\.addEventListener\("scroll", markAccountScrollActive, \{ passive: true \}\)/);
});

test("switch result distinguishes a verified AppX launch recovery", () => {
  assert.match(app, /status\.launchRecovered/);
  assert.match(app, /result\?\.launchRecovered/);
});

test("background account refresh schedules the next interval only after completion", () => {
  const timerBody = app.match(/function startBackgroundRefreshTimer\(\)\s*{([\s\S]*?)\r?\n}/)?.[1] ?? "";
  const refreshBody = rendererFunctionSource("async function refreshAllUsageInBackground()", "function startCurrentQuotaSyncTimer()");
  assert.match(timerBody, /setTimeout/);
  assert.doesNotMatch(timerBody, /setInterval/);
  assert.match(refreshBody, /finally\s*{[\s\S]*startBackgroundRefreshTimer\(\)/);
});

test("returning to the visible main window immediately synchronizes the canonical current quota", () => {
  assert.match(app, /document\.addEventListener\("visibilitychange",/);
  assert.match(app, /if \(!document\.hidden\) void syncCurrentQuotaDisplay\(\)/);
});

test("quota warning and account detail use the shared availability projection", () => {
  assert.match(app, /quota\.availability === "execution_limited"/);
  assert.match(app, /quota\.availability === "exhausted"/);
  assert.match(app, /detail\.executionLimited/);
});

test("manual refresh disables only its own control and exposes privacy-safe aggregate progress", () => {
  assert.match(preload, /let usageRefreshOperationId = 0/);
  assert.match(preload, /invoke\("accounts:refreshAllUsage", \+\+usageRefreshOperationId\)/);
  assert.match(preload, /onUsageRefreshProgress/);
  assert.match(main, /Invalid usage refresh request/);
  assert.match(main, /accounts:refreshProgress/);
  assert.match(app, /refreshAllButton\.addEventListener\("click", runRefreshAction/);
  const helper = app.slice(app.indexOf("function runRefreshAction("), app.indexOf("function lowestRemaining("));
  assert.match(helper, /refreshAllButton\.disabled = true/);
  assert.match(helper, /refreshAllButton\.disabled = false/);
  assert.doesNotMatch(helper, /document\.body|accountsNav|threadsNav|usageNav|reportsNav|settingsNav/);
  assert.match(app, /status\.usageRefreshProgress/);
  assert.match(app, /status\.usageRefreshPersisting/);
});

test("pending automatic-switch polling is single-flight", () => {
  const body = rendererFunctionSource("async function checkPendingAutoSwitch()", "async function syncAutoSwitchTargetState(");
  assert.match(body, /pendingAutoSwitchCheckInProgress/);
  assert.match(body, /pendingAutoSwitchCheckInProgress\s*=\s*true/);
  assert.match(body, /finally\s*{[\s\S]*pendingAutoSwitchCheckInProgress\s*=\s*false/);
});

test("periodic account refresh only regenerates a current report while Reports is visible", () => {
  const refreshBody = rendererFunctionSource("async function refreshAllUsageInBackground()", "function startCurrentQuotaSyncTimer()");
  assert.match(refreshBody, /currentView === "reports"/);
  assert.match(refreshBody, /reportRangeIncludesToday/);
  assert.match(refreshBody, /refreshWeeklyReport\(\{ background: true \}\)/);
});

test("report cache freshness ignores current quota changes outside the selected range", () => {
  assert.match(app, /let reportDataRevision = 0/);
  assert.match(app, /function reportRangeIncludesToday\(/);
  assert.match(app, /!reportRangeIncludesToday\(mode, date\) \|\| entry\.dataRevision === reportDataRevision/);
});

test("startup does not generate an unrequested report", () => {
  const initializeBody = app.match(/async function initialize\(\)\s*{([\s\S]*?)\n}/)?.[1] ?? "";
  assert.doesNotMatch(initializeBody, /refreshWeeklyReport/);
});

test("cached background report updates stay visually silent and share one request per key", () => {
  assert.match(app, /const reportRequests = new Map\(\)/);
  assert.match(app, /reportRequests\.get\(key\)/);
  assert.match(app, /weeklyReportLoading = !background \|\| !cached/);
  assert.match(app, /dataRevision/);
  assert.match(app, /superseded[\s\S]*?void refreshWeeklyReport\(\{ background: true \}\)/);
});

test("global rendering skips report DOM work while Reports is hidden", () => {
  const renderBody = app.match(/function render\(\)\s*{([\s\S]*?)\n}/)?.[1] ?? "";
  assert.match(renderBody, /if \(currentView === "reports"\) renderReportsView\(\)/);
  const refreshBody = app.match(/async function refreshWeeklyReport\([\s\S]*?\n}\n\nfunction renderReportsView/)?.[0] ?? "";
  assert.doesNotMatch(refreshBody, /(^|\n)\s{2}renderReportsView\(\);/);
  const clearBody = app.match(/settingsClearObservations\.addEventListener[\s\S]*?\n}\)\);/)?.[0] ?? "";
  assert.doesNotMatch(clearBody, /renderReportsView/);
});

test("reports reuse the canonical account order once per visible render", () => {
  const renderBody = app.match(/function renderReportsView\(\)\s*{([\s\S]*?)\n}\n\nfunction setReportMode/)?.[1] ?? "";
  assert.match(app, /import \{ buildReportPresentation, orderReportAccounts \} from "\.\.\/core\/report-presentation\.js"/);
  assert.equal((renderBody.match(/orderReportAccounts\(/g) ?? []).length, 1);
  assert.equal((renderBody.match(/buildReportPresentation\(/g) ?? []).length, 1);
  assert.match(renderBody, /syncReportFilters\(report, orderedAccounts\)/);
  assert.match(renderBody, /const rows = presentation\.accounts/);
  assert.match(renderBody, /const modelRows = presentation\.modelRows/);
  assert.match(app, /account\.isCurrent[\s\S]*?t\("labels\.current"\)/);
  assert.match(app, /account\.hasUsage[\s\S]*?reports\.noUsageInRange/);
  assert.match(app, /"reports\.noUsageInRange": "本时段暂无记录"/);
  assert.match(app, /"reports\.noUsageInRange": "No records in this range"/);
});

test("report ordering stays a dependency-free in-memory presentation step", () => {
  assert.match(reportPresentation, /new Map\(/);
  assert.doesNotMatch(reportPresentation, /\.find\(/);
  assert.doesNotMatch(reportPresentation, /\bapi\b|window\.|worker|report-usage-index|node:fs/);
  const refreshBody = rendererFunctionSource("async function refreshAllUsageInBackground()", "function startCurrentQuotaSyncTimer()");
  assert.match(refreshBody, /currentView === "reports"/);
  assert.match(refreshBody, /reportRangeIncludesToday/);
});

test("account data updates do not rebuild usage or report views", () => {
  const loadBody = app.match(/async function loadAccounts\([^)]*\)\s*{([\s\S]*?)\r?\n}\r?\n\r?\nfunction captureAccountReadingContext/)?.[1] ?? "";
  assert.match(loadBody, /renderAccountSurfaces\(\)/);
  assert.doesNotMatch(loadBody, /\brender\(\)/);
  assert.doesNotMatch(loadBody, /renderUsageView|renderReportsView/);
});

test("reports keep cached content visible and expose refresh freshness", () => {
  assert.match(html, /id="reports-refresh-state"/);
  assert.match(app, /const reportCache = new Map\(\)/);
  assert.match(app, /function reportCacheKey\(/);
  assert.match(app, /function reportCacheIsFresh\(/);
  assert.match(app, /refreshWeeklyReport\(\{ background: true \}\)/);
  assert.doesNotMatch(app, /if \(weeklyReportLoading\) \{\s*reportsAccountTable\.innerHTML/s);
});

test("internal brand uses the packaged product icon and model disclosures keep icon geometry", () => {
  assert.doesNotMatch(html, />CS<\/span>/);
  assert.match(html, /<img class="brand-mark" src="\.\.\/\.\.\/build\/icon\.png"/);
  assert.doesNotMatch(css, /\.switch-brand-icon::before/);
  assert.match(css, /\.model-disclosure-button::before/);
  assert.doesNotMatch(app, /model-disclosure-button[^\n]*>⌄<\/button>/);
});

test("narrow layouts use a compact horizontal product rail", () => {
  assert.match(css, /@media \(max-width:\s*980px\)[\s\S]*\.rail\s*{[^}]*grid-template-columns:\s*auto minmax\(0,\s*1fr\)/s);
  assert.match(css, /@media \(max-width:\s*980px\)[\s\S]*\.nav-stack\s*{[^}]*grid-template-columns:\s*repeat\(5,/s);
  assert.match(css, /@media \(max-width:\s*980px\)[\s\S]*\.topbar\s*>\s*div:first-child\s*{[^}]*flex:\s*0 0 auto/s);
});

test("quota provenance and report states are bilingual", () => {
  for (const key of [
    "nav.reports",
    "reports.title",
    "reports.localOnly",
    "reports.observedEstimate",
    "reports.unattributed",
    "detail.quotaSource",
    "detail.quotaLastRefresh",
    "detail.quotaSnapshotAge"
  ]) assert.ok(app.split(`"${key}"`).length >= 3, `${key} should be defined twice and used`);
});

test("score help uses viewport-aware fixed placement and narrow single-column layout", () => {
  assert.match(app, /function positionScoreHelp\(/);
  assert.match(app, /Math\.min\(440/);
  assert.match(css, /\.score-help-popover\s*{[^}]*position:\s*fixed/s);
  assert.match(css, /grid-template-columns:\s*1fr/);
});
