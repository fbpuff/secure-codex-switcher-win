import { Worker } from "node:worker_threads";

const workerUrl = new URL("../workers/background-worker.js", import.meta.url);
let usageReportQueue = Promise.resolve();
let backupStoreQueue = Promise.resolve();
let observationQueue = Promise.resolve();
const threadSearchRequests = new Map();
const activeWorkers = new Map();
let conversationBackupGeneration = 0;
let shuttingDown = false;

export function buildUsageReportInWorker(payload) {
  const operation = usageReportQueue.then(() => runBackgroundTask("usage-report", payload));
  usageReportQueue = operation.catch(() => {});
  return operation;
}

export function createConversationBackupInWorker(options) {
  return queueBackupStoreTask("conversation-backup", {
    codexDir: options.codexDir,
    backupRoot: options.backupRoot,
    nowMs: options.now(),
    mode: options.mode,
    checkpointId: options.checkpointId,
    checkpointStartedAt: options.checkpointStartedAt
  }, { onProgress: options.onProgress });
}

export function listCodexRecoveryBackupsInWorker(options) {
  return queueBackupStoreTask("recovery-list", {
    backupRoot: options.backupRoot,
    full: options.full
  }, { onProgress: options.onProgress });
}

export function revalidateQuarantinedConversationBackupInWorker(options) {
  return queueBackupStoreTask("recovery-revalidate-quarantined-conversation", {
    backupRoot: options.backupRoot,
    conversationId: options.conversationId
  }, { onProgress: options.onProgress });
}

export function previewCodexRecoveryInWorker(options) {
  return queueBackupStoreTask("recovery-preview", {
    backupRoot: options.backupRoot,
    liveCodexDir: options.liveCodexDir,
    selection: options.selection
  }, { onProgress: options.onProgress });
}

export function prepareCodexReplacementInWorker(options) {
  return queueBackupStoreTask("recovery-prepare", {
    backupRoot: options.backupRoot,
    liveCodexDir: options.liveCodexDir,
    selection: options.selection
  }, {});
}

export function getCodexStateIdentityInWorker(options) {
  return queueBackupStoreTask("recovery-live-identity", { liveCodexDir: options.liveCodexDir }, {});
}

export function inspectCodexTaskActivityInWorker(options) {
  return runBackgroundTask("task-activity-index", {
    codexDir: options.codexDir,
    nowMs: options.nowMs,
    liveThreadIds: options.liveThreadIds,
    officialHostState: options.officialHostState,
    officialHostSnapshotRequestedAtMs: options.officialHostSnapshotRequestedAtMs,
    latestOfficialAppServerStartMs: options.latestOfficialAppServerStartMs
  });
}

export function searchLocalCodexThreadsInWorker({ codexDir, revision = "", protectedActiveThreadIds = [] }) {
  const protectedIds = Array.isArray(protectedActiveThreadIds)
    ? [...new Set(protectedActiveThreadIds.filter((id) => typeof id === "string" && id))].sort()
    : [];
  const key = `${codexDir}\n${revision}\n${protectedIds.join("\n")}`;
  const existing = threadSearchRequests.get(key);
  if (existing) return existing;
  const operation = runBackgroundTask("thread-search", {
    codexDir,
    query: "",
    protectedActiveThreadIds: protectedIds
  }).finally(() => {
    if (threadSearchRequests.get(key) === operation) threadSearchRequests.delete(key);
  });
  threadSearchRequests.set(key, operation);
  return operation;
}

export function getCodexThreadProjectionHealthInWorker({ codexDir }) {
  return runBackgroundTask("account-switch-projection-health", { codexDir });
}

export function captureStableCodexThreadStateInWorker({ codexDir }) {
  return runBackgroundTask("account-switch-stable-thread-state", { codexDir });
}

export function getCodexThreadIntegritySnapshotInWorker({ codexDir }) {
  return runBackgroundTask("account-switch-thread-state", { codexDir });
}

export function persistQuotaObservationsInWorker(payload) {
  return queueObservationMutation({ ...payload, mutation: "quota" });
}

export function persistActiveAccountInWorker(payload) {
  return queueObservationMutation({ ...payload, mutation: "active-account" });
}

export function clearUsageObservationsInWorker(payload) {
  return queueObservationMutation({ ...payload, mutation: "clear" });
}

export function runStartupMaintenanceInWorker(payload) {
  return runBackgroundTask("switcher-startup-maintenance", payload);
}

function queueObservationMutation(payload) {
  const operation = observationQueue.then(() => runBackgroundTask("observation-mutation", payload));
  observationQueue = operation.catch(() => {});
  return operation;
}

function queueBackupStoreTask(task, payload, options) {
  const generation = task === "conversation-backup" ? conversationBackupGeneration : undefined;
  const operation = backupStoreQueue.then(() => {
    if (generation !== undefined && generation !== conversationBackupGeneration) {
      throw new Error("Conversation backup cancelled for account switching");
    }
    return runBackgroundTask(task, payload, options);
  });
  backupStoreQueue = operation.catch(() => {});
  return operation;
}

export function runBackgroundTask(task, payload, options = {}) {
  if (shuttingDown) return Promise.reject(new Error("Background jobs are shutting down"));
  return new Promise((resolve, reject) => {
    const worker = new Worker(workerUrl, { workerData: { task, payload } });
    activeWorkers.set(worker, task);
    let settled = false;
    worker.on("message", (message) => {
      if (message?.type === "progress") {
        try {
          options.onProgress?.(task === "conversation-backup"
            ? normalizeConversationBackupProgress(message.value)
            : normalizeRecoveryProgress(message.value));
        } catch {}
        return;
      }
      if (settled) return;
      settled = true;
      if (message?.ok) {
        resolve(message.value);
        return;
      }
      reject(workerError(message?.error));
    });
    worker.once("error", (error) => {
      settled = true;
      reject(error);
    });
    worker.once("exit", (code) => {
      activeWorkers.delete(worker);
      if (!settled) reject(new Error(`Background worker exited without a result (code ${code})`));
    });
  });
}

export async function cancelConversationBackupJobs() {
  conversationBackupGeneration += 1;
  const workers = [...activeWorkers.entries()]
    .filter(([, task]) => task === "conversation-backup")
    .map(([worker]) => worker);
  await Promise.allSettled(workers.map((worker) => worker.terminate()));
}

export function normalizeRecoveryProgress(value) {
  return normalizeAggregateProgress(value, ["discovering", "validating", "validating_backup", "comparing_live", "completed"], "recovery");
}

export function normalizeConversationBackupProgress(value) {
  return normalizeAggregateProgress(value, ["discovering", "processing", "validating", "pruning", "completed"], "conversation backup");
}

function normalizeAggregateProgress(value, stages, label) {
  const allowedKeys = new Set(["stage", "processedFiles", "totalFiles", "processedBytes", "totalBytes"]);
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !allowedKeys.has(key))) {
    throw new Error(`Invalid ${label} progress`);
  }
  if (!stages.includes(value.stage)) throw new Error(`Invalid ${label} progress stage`);
  if (value.stage === "discovering") {
    if (Object.keys(value).length !== 1) throw new Error(`Invalid ${label} progress fields`);
    return { stage: value.stage };
  }
  for (const key of ["processedFiles", "totalFiles", "processedBytes", "totalBytes"]) {
    if (!Number.isSafeInteger(value[key]) || value[key] < 0) throw new Error(`Invalid ${label} progress count`);
  }
  if (value.processedFiles > value.totalFiles || value.processedBytes > value.totalBytes) throw new Error(`Invalid ${label} progress range`);
  return {
    stage: value.stage,
    processedFiles: value.processedFiles,
    totalFiles: value.totalFiles,
    processedBytes: value.processedBytes,
    totalBytes: value.totalBytes
  };
}

export function stopBackgroundJobs() {
  shuttingDown = true;
  for (const worker of activeWorkers.keys()) void worker.terminate().catch(() => {});
  activeWorkers.clear();
}

function workerError(value = {}) {
  const error = new Error(value.message || "Background operation failed");
  error.name = value.name || "Error";
  if (value.code) error.code = value.code;
  return error;
}
