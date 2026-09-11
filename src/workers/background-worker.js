import { parentPort, workerData } from "node:worker_threads";
import {
  codexLiveContentIdentity,
  createConversationBackup,
  listCodexRecoveryBackups,
  previewCodexRecovery,
  revalidateQuarantinedConversationBackup,
  recoverySelectionContentIdentity,
  resolveCodexRecoverySelection,
  resolveCompleteRecoveryPoint
} from "../core/codex-state-backup.js";
import { readIndexedRolloutUsageEvents } from "../core/report-usage-index.js";
import { inspectCodexTaskActivity } from "../core/codex-task-activity.js";
import { codexThreadIntegritySnapshot, searchLocalCodexThreads } from "../core/codex-thread-index.js";
import { getCodexThreadProjectionHealth } from "../core/codex-thread-projection.js";
import { runSwitcherStartupMaintenance } from "../core/switcher-backups.js";
import {
  appendQuotaSnapshot,
  buildDailyUsageReport,
  buildWindowUsageReport,
  buildWeeklyUsageReport,
  createObservationState,
  pruneObservationState,
  readObservationState,
  setActiveAccount,
  writeObservationState
} from "../core/usage-observations.js";

try {
  const value = workerData.task === "usage-report"
    ? buildUsageReport(workerData.payload)
    : workerData.task === "conversation-backup"
      ? await createConversationBackup({
          codexDir: workerData.payload.codexDir,
          backupRoot: workerData.payload.backupRoot,
          now: () => workerData.payload.nowMs,
          mode: workerData.payload.mode,
          checkpointId: workerData.payload.checkpointId,
          checkpointStartedAt: workerData.payload.checkpointStartedAt,
          onProgress: (value) => parentPort.postMessage({ type: "progress", value })
        })
      : workerData.task === "recovery-list"
        ? await listCodexRecoveryBackups({
            backupRoot: workerData.payload.backupRoot,
            full: workerData.payload.full,
            onProgress: (value) => parentPort.postMessage({ type: "progress", value })
          })
        : workerData.task === "recovery-revalidate-quarantined-conversation"
          ? await revalidateQuarantinedConversationBackup({
              backupRoot: workerData.payload.backupRoot,
              conversationId: workerData.payload.conversationId,
              onProgress: (value) => parentPort.postMessage({ type: "progress", value })
            })
        : workerData.task === "recovery-preview"
          ? await buildRecoveryPreview(workerData.payload)
        : workerData.task === "recovery-prepare"
          ? await buildRecoveryPrepare(workerData.payload)
        : workerData.task === "recovery-live-identity"
          ? await codexLiveContentIdentity(workerData.payload.liveCodexDir)
          : workerData.task === "task-activity-index"
            ? buildTaskActivityIndex(workerData.payload)
        : workerData.task === "thread-search"
            ? searchLocalCodexThreads(workerData.payload.codexDir, workerData.payload.query, {
              protectedActiveThreadIds: workerData.payload.protectedActiveThreadIds
            })
          : workerData.task === "account-switch-projection-health"
            ? getCodexThreadProjectionHealth(workerData.payload.codexDir)
          : workerData.task === "account-switch-stable-thread-state"
            ? captureStableThreadState(workerData.payload.codexDir)
          : workerData.task === "account-switch-thread-state"
            ? codexThreadIntegritySnapshot(workerData.payload.codexDir)
          : workerData.task === "observation-mutation"
            ? persistObservationMutation(workerData.payload)
          : workerData.task === "switcher-startup-maintenance"
            ? runSwitcherStartupMaintenance(workerData.payload)
       : throwUnsupportedTask(workerData.task);
  parentPort.postMessage({ type: "result", ok: true, value });
} catch (error) {
  parentPort.postMessage({
    type: "result",
    ok: false,
    error: { name: error?.name, message: error?.message, code: error?.code }
  });
}

function captureStableThreadState(codexDir) {
  const first = codexThreadIntegritySnapshot(codexDir);
  const second = codexThreadIntegritySnapshot(codexDir);
  if (!first?.revision || first.revision !== second?.revision) {
    const error = new Error("Local Codex thread state changed during stable capture");
    error.code = "CODEX_THREAD_STATE_UNSTABLE";
    throw error;
  }
  return second;
}

async function buildRecoveryPreview(payload) {
  const sources = payload.selection?.recoveryPointId
    ? await resolveCompleteRecoveryPoint({ backupRoot: payload.backupRoot, recoveryPointId: payload.selection.recoveryPointId })
    : await resolveCodexRecoverySelection({ backupRoot: payload.backupRoot, ...payload.selection });
  return previewCodexRecovery({
    ...sources,
    liveCodexDir: payload.liveCodexDir,
    onProgress: (value) => parentPort.postMessage({ type: "progress", value })
  });
}

async function buildRecoveryPrepare(payload) {
  const sources = payload.selection?.recoveryPointId
    ? await resolveCompleteRecoveryPoint({ backupRoot: payload.backupRoot, recoveryPointId: payload.selection.recoveryPointId })
    : await resolveCodexRecoverySelection({ backupRoot: payload.backupRoot, ...payload.selection });
  const preview = await previewCodexRecovery({ ...sources, liveCodexDir: payload.liveCodexDir });
  const selectedBackupIdentity = await recoverySelectionContentIdentity({ ...sources, validated: true });
  const liveIdentity = await codexLiveContentIdentity(payload.liveCodexDir);
  return { sources, preview, selectedBackupIdentity, liveIdentity };
}

function buildUsageReport(payload) {
  if (payload.mode === "window") {
    const tokenEvents = readIndexedRolloutUsageEvents({ codexDir: payload.codexDir, cachePath: payload.cachePath, startMs: payload.startMs, endMs: payload.endMs });
    const state = payload.state ?? pruneObservationState(readObservationState(payload.observationPath), payload.nowMs);
    return buildWindowUsageReport({ state, tokenEvents, accounts: payload.accounts, startMs: payload.startMs, endMs: payload.endMs });
  }
  const endMs = payload.mode === "weekly"
    ? payload.startMs + 7 * 24 * 60 * 60 * 1000
    : nextLocalDay(payload.startMs);
  const tokenEvents = readIndexedRolloutUsageEvents({
    codexDir: payload.codexDir,
    cachePath: payload.cachePath,
    startMs: payload.startMs,
    endMs
  });
  const state = payload.state
    ?? pruneObservationState(readObservationState(payload.observationPath), payload.nowMs);
  return payload.mode === "weekly"
    ? buildWeeklyUsageReport({ state, tokenEvents, accounts: payload.accounts, weekStartMs: payload.startMs })
    : buildDailyUsageReport({ state, tokenEvents, accounts: payload.accounts, dayStartMs: payload.startMs });
}

function persistObservationMutation(payload) {
  const state = payload.mutation === "clear"
    ? createObservationState()
    : readObservationState(payload.observationPath);
  if (payload.mutation === "quota") {
    for (const { accountId, usage } of payload.observations) {
      appendQuotaSnapshot(state, {
        accountId,
        fetchedAtMs: Number(usage.fetchedAt) * 1000,
        source: usage.source ?? "chatgpt_usage_api",
        fiveHour: usage.fiveHour,
        oneWeek: usage.oneWeek,
        explicitResetCause: usage.explicitResetCause
      });
    }
  } else if (payload.mutation === "active-account") {
    const open = [...state.intervals].reverse().find((item) => item.endMs === undefined);
    if (open?.accountId === payload.accountId || (!open && !payload.accountId)) return { persisted: 0 };
    setActiveAccount(state, { accountId: payload.accountId, atMs: payload.nowMs, source: payload.source });
  } else if (payload.mutation === "clear" && payload.accountId) {
    setActiveAccount(state, { accountId: payload.accountId, atMs: payload.nowMs, source: "history_reset" });
  }
  pruneObservationState(state, payload.nowMs);
  writeObservationState(payload.observationPath, state);
  return { persisted: payload.mutation === "quota" ? payload.observations.length : 1 };
}

function buildTaskActivityIndex(payload) {
  const cache = new Map();
  inspectCodexTaskActivity(payload.codexDir, cache, {
    nowMs: payload.nowMs,
    liveThreadIds: payload.liveThreadIds,
    officialHostState: payload.officialHostState,
    officialHostSnapshotRequestedAtMs: payload.officialHostSnapshotRequestedAtMs,
    latestOfficialAppServerStartMs: payload.latestOfficialAppServerStartMs
  });
  return {
    cacheEntries: [...cache.entries()].map(([cachePath, state]) => {
      const remainderLength = Buffer.isBuffer(state?.remainder) ? state.remainder.length : 0;
      const next = { ...state, offset: Math.max(0, Number(state?.offset) - remainderLength) };
      delete next.remainder;
      return [cachePath, next];
    })
  };
}

function nextLocalDay(startMs) {
  const date = new Date(startMs);
  date.setDate(date.getDate() + 1);
  return date.getTime();
}

function throwUnsupportedTask(task) {
  throw new Error(`Unsupported background task: ${task}`);
}
