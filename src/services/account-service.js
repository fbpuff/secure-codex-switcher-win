import crypto from "node:crypto";
import { beijingTimestamp, beijingDayStart } from "../core/beijing-time.js";
import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { protectString, protectStringAsync, unprotectString, unprotectStringAsync } from "../core/dpapi.js";
import { extractAccessToken, extractAccountId, summarizeAuth } from "../core/auth-summary.js";
import { fetchUsageSnapshot, USAGE_AUTH_EXPIRED_MESSAGE } from "../core/usage.js";
import { getTokenUsageStats } from "../core/token-usage-stats.js";
import {
  accountAt,
  appendQuotaSnapshot,
  createObservationState,
  pruneObservationState,
  readObservationState,
  setActiveAccount,
  startOfPreviousLocalWeek,
  writeObservationState
} from "../core/usage-observations.js";
import {
  buildUsageReportInWorker,
  cancelConversationBackupJobs,
  captureStableCodexThreadStateInWorker,
  clearUsageObservationsInWorker,
  createConversationBackupInWorker,
  listCodexRecoveryBackupsInWorker,
  normalizeConversationBackupProgress,
  prepareCodexReplacementInWorker,
  revalidateQuarantinedConversationBackupInWorker,
  runStartupMaintenanceInWorker,
  getCodexStateIdentityInWorker,
  getCodexThreadIntegritySnapshotInWorker,
  getCodexThreadProjectionHealthInWorker,
  inspectCodexTaskActivityInWorker,
  persistActiveAccountInWorker,
  persistQuotaObservationsInWorker,
  previewCodexRecoveryInWorker,
  searchLocalCodexThreadsInWorker
} from "../core/background-jobs.js";
import { compareAccountsByScore, pickBestAccount as pickBest, pickRecoveryAccount, remainingScore } from "../core/ranking.js";
import { DEFAULT_AUTO_SWITCH_QUIET_MS, decideAutoSwitchActivity } from "../core/activity-switching.js";
import { atomicWriteJson, atomicWriteText, latestMatchingFiles, readJsonIfExists } from "../core/file-io.js";
import { loadLatestValidRecoverySnapshot, saveRecoverySnapshot } from "../core/recovery-snapshots.js";
import { migrateLegacySwitcherBackups, migratePlaintextAuthBackups } from "../core/switcher-backups.js";
import { isOfficialCodexProcess, officialCodexProcessScript } from "../core/official-codex-process.js";
import {
  HTTP_ONLY_PROVIDER_ID,
  ensureCodexHttpOnlyMode,
  readCodexBaseProvider,
  readCodexHttpOnlyStatus,
  setCodexHttpOnlyMode
} from "../core/codex-config.js";
import { migrateCodexHistoryProvider, revertCodexHistoryProvider } from "../core/codex-history.js";
import { inspectCodexTaskActivity, resolveTaskDisplayNames } from "../core/codex-task-activity.js";
import {
  codexThreadIntegritySnapshot,
  codexThreadSidebarStateRevision,
  codexThreadStateRevisions,
  filterLocalCodexThreads,
  remapLocalCodexThreadSidebarState,
  selectQuotaInterruptedThread,
  selectQuotaInterruptedThreadFromThreads
} from "../core/codex-thread-index.js";
import { getCodexThreadProjectionHealth } from "../core/codex-thread-projection.js";
import { startCodexThreadResume } from "../core/codex-app-server-client.js";
import { readLatestCodexRateLimits } from "../core/codex-rate-limits.js";
import {
  codexLiveContentIdentity,
  createCompleteRecoveryPoint,
  criticalSnapshotContentIdentity,
  createCriticalCodexSnapshot,
  listCodexRecoveryBackups,
  previewCodexRecovery,
  recoverySelectionContentIdentity,
  resolveCompleteRecoveryPoint,
  resolveCodexRecoverySelection,
  restoreCodexBackup
} from "../core/codex-state-backup.js";

const CONVERSATION_BACKUP_INTERVAL_MS = 24 * 60 * 60 * 1000;
const CONVERSATION_FULL_VERIFICATION_INTERVAL_MS = 7 * CONVERSATION_BACKUP_INTERVAL_MS;
const CONVERSATION_BACKUP_REASONS = new Set(["explicit", "daily-idle", "recovery-maintenance"]);
const RESTORE_CONFIRMATION_TTL_MS = 5 * 60 * 1000;
const THREADS_PROCESS_SNAPSHOT_TTL_MS = 5_000;
const TASK_ACTIVITY_INDEX_RETRY_MS = 15_000;
const CODEX_LAUNCH_RETRY_DELAYS_MS = Object.freeze([2_000, 4_000, 8_000, 10_000, 10_000, 10_000]);
const DSH_CODEX_HOME_NAME = "codex-home-0.147";
const DSH_AUTH_SYNC_SCRIPT_NAME = "Sync-DshCodexAuth.ps1";
const DSH_AUTH_SYNC_RETRY_DELAYS_MS = Object.freeze([5_000, 15_000, 30_000, 60_000]);
const DSH_AUTH_SYNC_POLL_INTERVAL_MS = 30_000;
const AUTO_RESUME_USAGE_LIMIT_LOOKBACK_MS = 15 * 60 * 1_000;
// The short window is for discovery. Once quota exhaustion is known, allow the
// switch transaction enough time to quiet and close Codex without losing the
// captured interruption.
const AUTO_RESUME_CAPTURE_LOOKBACK_MS = 6 * 60 * 60 * 1_000;
const QUOTA_INTERRUPTION_EVIDENCE_CACHE_MS = 5_000;
const AUTO_RESUME_METHOD = "app_server_protocol_v1";
const AUTO_RESUME_DESKTOP_METHOD = "desktop_ui_automation_v1";
const AUTO_RESUME_METHODS = new Set([AUTO_RESUME_METHOD, AUTO_RESUME_DESKTOP_METHOD]);
const AUTO_RESUME_PROMPT = "继续完成额度切换前尚未完成的任务；先检查当前项目状态，只继续未完成部分。";
const AUTO_RESUME_STAGES = new Set(["prepared", "launch_verified", "waiting_for_desktop", "turn_started", "completed", "failed", "uncertain"]);
const AUTO_RESUME_DESKTOP_PHASES = new Set([
  "deep_link_opened", "window_scan_started", "window_scan_completed", "composer_scan_started", "composer_scan_completed",
  "window_restored", "composer_found", "submit_found", "focus_verified", "invoke_started", "invoke_no_effect",
  "fallback_invoke_started", "prompt_consumed"
]);
const AUTO_RESUME_DESKTOP_DISCOVERY_PHASES = new Set([
  "deep_link_opened", "window_scan_started", "window_scan_completed", "composer_scan_started", "composer_scan_completed"
]);
const AUTO_RESUME_FAILURE_REASONS = new Set([
  "server_overloaded", "task_failed", "usage_limit_exceeded", "task_cancelled",
  "composer_or_submit_not_found", "composer_not_found", "submit_not_found", "prompt_not_consumed", "turn_not_observed",
  "foreground_changed", "composer_focus_failed", "submission_timeout", "submission_error", "desktop_unavailable", "recovery_expired"
]);
const AUTO_RESUME_ACTIVE_STAGES = new Set(["prepared", "launch_verified", "waiting_for_desktop", "turn_started", "uncertain"]);
const AUTO_RESUME_CLAIM_LOCK_TTL_MS = 30_000;
const AUTO_RESUME_SUPERSEDE_AFTER_MS = 10 * 60 * 1_000;
const AUTO_RESUME_DESKTOP_DISCOVERY_MS = 10_000;
const AUTO_RESUME_DESKTOP_VERIFICATION_MS = 45_000;
const AUTO_RESUME_DESKTOP_PROCESS_MS = 120_000;
const AUTO_RESUME_DESKTOP_RETRY_DELAYS_MS = Object.freeze([1_500]);
const PROTOCOL_PROCESS_CLOSE_WAIT_MS = 10_000;
const AUTO_RESUME_TRANSITIONS = Object.freeze({
  prepared: new Set(["launch_verified", "failed"]),
  launch_verified: new Set(["waiting_for_desktop", "turn_started", "failed", "uncertain"]),
  waiting_for_desktop: new Set(["launch_verified", "failed", "uncertain"]),
  turn_started: new Set(["completed", "failed", "uncertain"])
});
const PROJECTION_BLOCK_CODES = new Set([
  "codex_thread_projection_unavailable",
  "codex_thread_projection_unhealthy"
]);
const PROJECTION_COUNT_KEYS = [
  "stateDatabases",
  "readableStateDatabases",
  "unreadableStateDatabases",
  "unsupportedStateSchemas",
  "duplicatePaginatedThreadIds",
  "invalidThreadIds",
  "paginatedThreads",
  "historyDatabaseCandidates",
  "missingHistoryDatabases",
  "unreadableHistoryDatabases",
  "unsupportedSchemas",
  "projectionRows",
  "duplicateProjectionRows",
  "checkedThreads",
  "ignoredArchivedTombstones",
  "missingRollouts",
  "duplicateRollouts",
  "missingProjectionRows",
  "unreadableRollouts",
  "invalidNumbers",
  "mismatchedOffsets",
  "historyIntegrityFailures"
];
const THREADS_OFFICIAL_PROCESS = Object.freeze({
  name: "Codex.exe",
  executablePath: "C:\\AppData\\Local\\OpenAI\\Codex\\Codex.exe"
});

export function createAccountService(userDataPath, options = {}) {
  return new AccountService(userDataPath, options);
}

class AccountService {
  constructor(userDataPath, options = {}) {
    this.userDataPath = userDataPath;
    this.codexDir = options.codexDir ?? path.join(os.homedir(), ".codex");
    this.fetchImpl = options.fetchImpl;
    this.closeCodexProcesses = options.closeCodexProcesses ?? closeOfficialCodexProcesses;
    this.closeCodexProcessesAsync = options.closeCodexProcessesAsync
      ?? (options.closeCodexProcesses ? async () => this.closeCodexProcesses() : closeOfficialCodexProcessesAsync);
    this.launchCodex = options.launchCodex ?? launchOfficialCodex;
    this.launchCodexAsync = options.launchCodexAsync
      ?? (options.launchCodex ? async (launchOptions) => this.launchCodex(launchOptions) : launchOfficialCodexAsync);
    this.resumeExecutorMode = options.resumeExecutorMode === "app-server" ? "app-server" : "desktop";
    this.autoResumeMethod = this.resumeExecutorMode === "app-server" ? AUTO_RESUME_METHOD : AUTO_RESUME_DESKTOP_METHOD;
    this.autoResumeDesktopRetryDelaysMs = options.autoResumeDesktopRetryDelaysMs ?? AUTO_RESUME_DESKTOP_RETRY_DELAYS_MS;
    this.startCodexThreadResume = options.startCodexThreadResume ?? startCodexThreadResume;
    this.countCodexProcesses = options.countCodexProcesses ?? countOfficialCodexProcesses;
    this.inspectCodexProcesses = options.inspectCodexProcesses
      ?? (options.countCodexProcesses ? () => ({ count: this.countCodexProcesses() }) : inspectOfficialCodexProcesses);
    this.inspectCodexProcessesForThreads = options.inspectCodexProcessesForThreads
      ?? (options.inspectCodexProcesses ? async () => this.inspectCodexProcesses() : inspectOfficialCodexProcessesAsync);
    this.verifyCodexClosure = options.verifyCodexClosure ?? !options.closeCodexProcesses;
    this.isProcessAlive = options.isProcessAlive ?? isProcessAlive;
    this.getCodexProcessInfo = options.getCodexProcessInfo ?? getProcessInfo;
    this.readCodexProcessRegistry = options.readCodexProcessRegistry ?? readCodexProcessRegistry;
    this.unprotectString = options.unprotectString ?? unprotectString;
    this.unprotectStringAsync = options.unprotectStringAsync ?? unprotectStringAsync;
    this.protectStringAsync = options.protectStringAsync ?? protectStringAsync;
    this.restoreAuthText = options.restoreAuthText ?? atomicWriteText;
    this.nowMs = options.nowMs ?? (() => Date.now());
    this.wait = options.wait ?? ((delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)));
    this.codexLaunchRetryDelaysMs = options.codexLaunchRetryDelaysMs ?? CODEX_LAUNCH_RETRY_DELAYS_MS;
    this.writeObservationState = options.writeObservationState ?? writeObservationState;
    this.persistQuotaObservations = options.persistQuotaObservations
      ?? (options.writeObservationState ? undefined : persistQuotaObservationsInWorker);
    this.persistActiveAccount = options.persistActiveAccount
      ?? (options.writeObservationState ? undefined : persistActiveAccountInWorker);
    this.clearObservations = options.clearUsageObservations
      ?? (options.writeObservationState ? undefined : clearUsageObservationsInWorker);
    this.createCriticalCodexSnapshot = options.createCriticalCodexSnapshot ?? createCriticalCodexSnapshot;
    this.createConversationBackup = options.createConversationBackup ?? createConversationBackupInWorker;
    this.cancelConversationBackupJobs = options.cancelConversationBackupJobs ?? cancelConversationBackupJobs;
    this.createCompleteRecoveryPoint = options.createCompleteRecoveryPoint ?? createCompleteRecoveryPoint;
    this.buildUsageReport = options.buildUsageReport ?? buildUsageReportInWorker;
    this.listCodexRecoveryBackupsImpl = options.listCodexRecoveryBackups ?? listCodexRecoveryBackupsInWorker;
    this.revalidateQuarantinedConversationBackupImpl = options.revalidateQuarantinedConversationBackup ?? revalidateQuarantinedConversationBackupInWorker;
    this.previewCodexRecovery = options.previewCodexRecovery ?? previewCodexRecovery;
    this.previewCodexRecoveryWorker = options.previewCodexRecoveryInWorker ?? (options.previewCodexRecovery ? undefined : previewCodexRecoveryInWorker);
    this.prepareCodexReplacementWorker = options.prepareCodexReplacementInWorker ?? (options.previewCodexRecovery ? undefined : prepareCodexReplacementInWorker);
    this.getCodexStateIdentityWorker = options.getCodexStateIdentityInWorker ?? (options.getCodexStateIdentity ? undefined : getCodexStateIdentityInWorker);
    this.resolveCodexRecoverySelection = options.resolveCodexRecoverySelection ?? resolveCodexRecoverySelection;
    this.resolveCompleteRecoveryPoint = options.resolveCompleteRecoveryPoint ?? resolveCompleteRecoveryPoint;
    this.restoreCodexBackup = options.restoreCodexBackup ?? restoreCodexBackup;
    this.getCodexStateIdentity = options.getCodexStateIdentity ?? (() => codexLiveContentIdentity(this.codexDir));
    this.getCodexThreadIntegritySnapshot = options.getCodexThreadIntegritySnapshot
      ?? (() => codexThreadIntegritySnapshot(this.codexDir));
    this.getCodexThreadIntegritySnapshotAsync = options.getCodexThreadIntegritySnapshotAsync
      ?? (options.getCodexThreadIntegritySnapshot
        ? async () => this.getCodexThreadIntegritySnapshot()
        : async () => getCodexThreadIntegritySnapshotInWorker({ codexDir: this.codexDir }));
    this.captureStableCodexThreadStateAsyncImpl = options.captureStableCodexThreadStateAsync
      ?? (options.getCodexThreadIntegritySnapshot
        ? async () => {
            const first = this.getCodexThreadIntegritySnapshot();
            const second = this.getCodexThreadIntegritySnapshot();
            if (!first?.revision || first.revision !== second?.revision) {
              const error = new Error("Local Codex thread state changed during stable capture");
              error.code = "CODEX_THREAD_STATE_UNSTABLE";
              throw error;
            }
            return second;
          }
        : async () => captureStableCodexThreadStateInWorker({ codexDir: this.codexDir }));
    this.getCodexThreadProjectionHealth = options.getCodexThreadProjectionHealth
      ?? (() => getCodexThreadProjectionHealth(this.codexDir));
    this.getCodexThreadProjectionHealthAsync = options.getCodexThreadProjectionHealthAsync
      ?? (options.getCodexThreadProjectionHealth
        ? async () => this.getCodexThreadProjectionHealth()
        : async () => getCodexThreadProjectionHealthInWorker({ codexDir: this.codexDir }));
    this.getCriticalSnapshotIdentity = options.getCriticalSnapshotIdentity ?? criticalSnapshotContentIdentity;
    this.getRecoverySelectionIdentity = options.getRecoverySelectionIdentity ?? recoverySelectionContentIdentity;
    this.dshAuthSyncUsesDefaultCodexHome = !options.syncDshCodexAuth
      ? samePath(this.codexDir, path.join(os.homedir(), ".codex"))
      : true;
    this.syncDshCodexAuth = options.syncDshCodexAuth ?? ((request) => syncDshCodexAuthWithPowerShell(request));
    this.syncDshCodexAuthAsync = options.syncDshCodexAuthAsync
      ?? (options.syncDshCodexAuth
        ? async (request) => this.syncDshCodexAuth(request)
        : syncDshCodexAuthWithPowerShellAsync);
    this.dshAuthSyncManaged = !options.syncDshCodexAuth || options.enableDshAuthSyncStartup === true || Boolean(options.dshRoot);
    this.dshAuthSyncRetryDelaysMs = options.dshAuthSyncRetryDelaysMs ?? DSH_AUTH_SYNC_RETRY_DELAYS_MS;
    this.setTimeout = options.setTimeout ?? setTimeout;
    this.clearTimeout = options.clearTimeout ?? clearTimeout;
    this.setInterval = options.setInterval ?? setInterval;
    this.clearInterval = options.clearInterval ?? clearInterval;
    this.dshAuthSyncTimer = undefined;
    this.dshAuthSyncPollTimer = undefined;
    this.dshAuthSyncAttemptPromise = undefined;
    this.dshAuthSyncFileWatcher = false;
    this.dshAuthSyncPollIntervalMs = options.dshAuthSyncPollIntervalMs ?? DSH_AUTH_SYNC_POLL_INTERVAL_MS;
    this.dshAuthSyncState = { status: "unknown", unresolvedDrift: false };
    this.dshAuthSyncStartupEnabled = this.dshAuthSyncManaged && options.enableDshAuthSyncStartup === true;
    this.dshAuthSyncWatchFileEnabled = options.watchDshAuthFile !== false;
    this.restoreConfirmations = new Map();
    this.getCodexActivityStatusOverride = options.getCodexActivityStatus;
    this.searchLocalCodexThreadsImpl = options.searchLocalCodexThreads;
    this.searchLocalCodexThreadsInWorker = options.searchLocalCodexThreadsInWorker ?? searchLocalCodexThreadsInWorker;
    this.selectQuotaInterruptedThread = options.selectQuotaInterruptedThread
      ?? ((selectionOptions) => selectQuotaInterruptedThread(this.codexDir, selectionOptions));
    this.selectQuotaInterruptedThreadAsync = options.selectQuotaInterruptedThread
      ? async (selectionOptions) => this.selectQuotaInterruptedThread(selectionOptions)
      : async (selectionOptions) => selectQuotaInterruptedThreadFromThreads(
          await this.searchLocalCodexThreads(""),
          selectionOptions
        );
    this.openCodexThread = options.openCodexThread ?? submitOfficialCodexContinuation;
    this.indexCodexTaskActivity = options.indexCodexTaskActivity ?? inspectCodexTaskActivityInWorker;
    this.activityWindowMs = options.activityWindowMs ?? 30_000;
    this.taskActivityCache = new Map();
    this.authReadabilityCache = new Map();
    this.accountRemarkCache = new Map();
    this.lastAutoSwitchDiagnosticSignature = undefined;
    this.taskActivityIndexPromise = undefined;
    this.taskActivityIndexInitialized = false;
    this.taskActivityIndexRetryAtMs = 0;
    this.protectedActiveThreadIds = new Set();
    this.threadsProcessSnapshot = undefined;
    this.threadsProcessSnapshotPromise = undefined;
    this.codexAuthPath = path.join(this.codexDir, "auth.json");
    this.codexConfigPath = path.join(this.codexDir, "config.toml");
    const dshRoot = options.dshRoot ?? path.join(os.homedir(), ".dsh");
    this.dshAuthSyncRequest = {
      scriptPath: path.join(dshRoot, "scripts", DSH_AUTH_SYNC_SCRIPT_NAME),
      sourceAuthPath: this.codexAuthPath,
      targetDirectory: path.join(dshRoot, DSH_CODEX_HOME_NAME),
      verifyNoActiveDshCodex: true
    };
    this.storePath = path.join(userDataPath, "accounts-store.json");
    this.settingsPath = path.join(userDataPath, "settings.json");
    this.autoSwitchStatePath = path.join(userDataPath, "auto-switch-state.json");
    this.autoSwitchEventsPath = path.join(userDataPath, "auto-switch-events.jsonl");
    this.autoResumeStatePath = path.join(userDataPath, "auto-resume-state.json");
    this.tokenUsageCachePath = path.join(userDataPath, "token-usage-cache.json");
    this.reportUsageIndexPath = path.join(userDataPath, "usage-report-index.json");
    this.usageObservationsPath = path.join(userDataPath, "usage-observations.json");
    this.recoverySnapshotsPath = path.join(userDataPath, "recovery-snapshots");
    this.backupRoot = path.join(userDataPath, "codex-backups");
    this.authBackupPath = path.join(this.backupRoot, "auth");
    this.historyStorage = {
      manifestPath: path.join(this.backupRoot, "http-history.json"),
      backupDir: path.join(this.backupRoot, "history")
    };
    this.reportRequests = new Map();
    this.conversationBackupProgressListeners = new Set();
    this.conversationBackupProgress = undefined;
    this.usageRefreshProgressListeners = new Set();
    this.usageRefreshProgress = undefined;
    this.switchInProgress = false;
    this.manualResumePromise = undefined;
    this.autoResumeQueuePromise = undefined;
    this.protocolResumePromise = undefined;
    this.cancelActiveProtocolResume = undefined;
    this.cancelActiveManualResume = undefined;
    this.autoSwitchCompletionInProgress = false;
    this.refreshAllUsagePromise = undefined;
    this.threadSearchCache = undefined;
    this.quotaInterruptionEvidenceCache = undefined;
    this.codexRateLimitsCache = undefined;
    this.countCodexProcessesAsync = options.countCodexProcessesAsync
      ?? (options.countCodexProcesses
        ? async () => this.countCodexProcesses()
        : async () => (await inspectOfficialCodexProcessesAsync()).count);
    this.countCodexDesktopProcessesAsync = options.countCodexDesktopProcessesAsync
      ?? (options.countCodexProcessesAsync
        ? options.countCodexProcessesAsync
        : async () => (await inspectOfficialCodexDesktopProcessesAsync()).count);
    fs.mkdirSync(userDataPath, { recursive: true });
    this.abandonInterruptedAutoResume();
    this.startupMaintenancePromise = undefined;
    if (options.deferStartupMaintenance === true) {
      // The packaged UI must paint before non-critical backup maintenance.
    } else {
      this.runStartupMaintenanceSync();
    }
    if (this.dshAuthSyncStartupEnabled) {
      const inspectAsync = () => this.inspectDshCodexAuthOnStartupAsync().catch(() => {});
      const timer = this.setTimeout(inspectAsync, 0);
      timer?.unref?.();
      this.dshAuthSyncPollTimer = this.setInterval(inspectAsync, this.dshAuthSyncPollIntervalMs);
      this.dshAuthSyncPollTimer?.unref?.();
      try {
        if (!this.dshAuthSyncWatchFileEnabled) return;
        fs.watchFile(this.codexAuthPath, { interval: 5_000 }, inspectAsync);
        this.dshAuthSyncFileWatcher = true;
      } catch {}
    }
  }

  listAccounts() {
    this.syncCurrentAuth();
    const store = this.readStore();
    const currentFingerprint = this.currentAuthFingerprint();
    const settings = this.readSettings();
    const now = Math.floor(this.nowMs() / 1000);
    const manualTargetId = settings.autoSwitchTargetMode === "manual" ? settings.manualAutoSwitchTargetAccountId : undefined;
    const excludedIds = new Set(settings.autoSwitchExcludedAccountIds);
    return store.accounts
      .map((account) => ({
        ...this.publicAccount(account, currentFingerprint, { projectQuotaEvidence: true }),
        isAutoSwitchExcluded: excludedIds.has(account.id)
      }))
      .sort((left, right) => {
        if (left.isCurrent !== right.isCurrent) {
          return left.isCurrent ? -1 : 1;
        }
        const leftIsManualTarget = Boolean(manualTargetId && left.id === manualTargetId && !left.isCurrent);
        const rightIsManualTarget = Boolean(manualTargetId && right.id === manualTargetId && !right.isCurrent);
        if (leftIsManualTarget !== rightIsManualTarget) {
          return leftIsManualTarget ? -1 : 1;
        }
        if (left.isAutoSwitchExcluded !== right.isAutoSwitchExcluded) {
          return left.isAutoSwitchExcluded ? 1 : -1;
        }
        return compareAccountsByScore(left, right, now);
      });
  }

  async listAccountsWithQuotaEvidence(options = {}) {
    let accounts = this.listAccounts();
    if (options.refreshInterruptionEvidence !== false && !isQuotaExhaustedPublic(accounts.find((account) => account.isCurrent))) {
      await this.refreshQuotaInterruptionEvidence();
      accounts = this.listAccounts();
    }
    return accounts.map((account) => account.isCurrent
      ? { ...account, usage: this.currentCodexDisplayUsage(account) }
      : account);
  }

  currentCodexDisplayUsage(account) {
    const nowMs = this.nowMs();
    if (!this.codexRateLimitsCache || this.codexRateLimitsCache.expiresAtMs <= nowMs) {
      this.codexRateLimitsCache = {
        usage: readLatestCodexRateLimits(this.codexDir),
        expiresAtMs: nowMs + 1_000
      };
    }
    const usage = this.codexRateLimitsCache.usage;
    if (!usage || usage.limitId !== "codex") return account.usage;
    const observations = readObservationState(this.usageObservationsPath);
    if (accountAt(observations, usage.fetchedAt * 1000) !== account.id) return account.usage;
    if (Number(account.usage?.fetchedAt) > usage.fetchedAt) return account.usage;
    if (!executionLimitAppliesToUsage(account.usage, usage)) return usage;
    return {
      ...usage,
      executionLimited: true,
      executionLimitWindow: account.usage.executionLimitWindow,
      executionLimitSource: account.usage.executionLimitSource,
      executionLimitedAtMs: account.usage.executionLimitedAtMs
    };
  }

  importCurrentAuth() {
    if (!fs.existsSync(this.codexAuthPath)) {
      throw new Error(`请先在终端运行 Codex 并完成登录，未找到：${this.codexAuthPath}`);
    }
    const authJson = JSON.parse(fs.readFileSync(this.codexAuthPath, "utf8"));
    const summary = summarizeAuth(authJson);
    if (!summary.hasAccessToken && !summary.hasRefreshToken) {
      throw new Error("当前是 API key 模式或未完成 ChatGPT 登录，请用 Codex 登录 ChatGPT 模式后再导入。");
    }

    const store = this.readStore();
    const encryptedAuth = protectString(JSON.stringify(authJson));
    const fingerprint = authFingerprint(authJson);
    const now = unixNow();
    const existing = store.accounts.find((account) => account.fingerprint === fingerprint || account.accountId === summary.accountId);
    const next = {
      id: existing?.id ?? crypto.randomUUID(),
      accountId: summary.accountId,
      emailMasked: summary.emailMasked,
      planType: summary.planType,
      encryptedAuth,
      encryptedRemark: existing?.encryptedRemark,
      disableGpuModeEnabled: existing?.disableGpuModeEnabled,
      fingerprint,
      usage: existing?.usage,
      usageError: undefined,
      status: "ready",
      createdAt: existing?.createdAt ?? now,
      updatedAt: now
    };

    store.accounts = existing ? store.accounts.map((account) => (account.id === existing.id ? next : account)) : [...store.accounts, next];
    this.writeStore(store);
    this.recordActiveAccount(next.id, "import");
    return this.publicAccount(next, fingerprint);
  }

  beginAddAccount() {
    const preservedAccount = this.importCurrentAuth();
    this.assertCodexThreadProjectionHealthy();
    const threadState = this.captureStableCodexThreadState();
    const previousAuthText = fs.readFileSync(this.codexAuthPath, "utf8");
    const closedCodexProcesses = this.closeCodexProcesses();
    const remainingCodexProcesses = this.verifyCodexClosure ? this.countCodexProcesses() : 0;
    if (remainingCodexProcesses > 0) {
      throw new Error("ChatGPT Codex 仍在运行，已取消添加新账号，当前登录保持不变。请完全退出 ChatGPT Codex 后重试。");
    }
    fs.mkdirSync(this.codexDir, { recursive: true });
    this.backupCriticalCodexState();
    this.backupCurrentAuth();
    fs.rmSync(this.codexAuthPath, { force: true });
    try {
      this.assertCodexThreadStateUnchanged(threadState);
    } catch (error) {
      try {
        this.restoreAuthText(this.codexAuthPath, previousAuthText);
      } catch (restoreError) {
        throw new Error("本地对话状态完整性校验失败，且原账号认证恢复失败。为避免扩大影响，未重新打开 Codex；已保存的原账号仍保留在 Switcher 中，请不要继续添加或切换账号。", { cause: restoreError });
      }
      throw error;
    }
    this.recordActiveAccount(undefined, "login_new");
    const transportWarning = this.ensurePreferredTransport();
    const launchedCodex = this.launchCodexWithPreference();
    return {
      deleted: false,
      loginNew: true,
      preservedAccount,
      authPath: this.codexAuthPath,
      closedCodexProcesses,
      launchedCodex,
      transportWarning
    };
  }

  async beginAddAccountResponsive() {
    const preservedAccount = this.importCurrentAuth();
    await this.assertCodexThreadProjectionHealthyAsync();
    const threadState = await this.captureStableCodexThreadStateAsync();
    const previousAuthText = fs.readFileSync(this.codexAuthPath, "utf8");
    const closedCodexProcesses = await this.closeCodexProcessesAsync();
    const remainingCodexProcesses = this.verifyCodexClosure ? await this.countCodexProcessesAsync() : 0;
    if (remainingCodexProcesses > 0) {
      throw new Error("ChatGPT Codex 仍在运行，已取消添加新账号，当前登录保持不变。请完全退出 ChatGPT Codex 后重试。");
    }
    fs.mkdirSync(this.codexDir, { recursive: true });
    this.backupCriticalCodexState();
    await this.backupCurrentAuthAsync();
    fs.rmSync(this.codexAuthPath, { force: true });
    try {
      await this.assertCodexThreadStateUnchangedAsync(threadState);
    } catch (error) {
      try {
        this.restoreAuthText(this.codexAuthPath, previousAuthText);
      } catch (restoreError) {
        throw new Error("本地对话状态完整性校验失败，且原账号认证恢复失败。为避免扩大影响，未重新打开 Codex；已保存的原账号仍保留在 Switcher 中，请不要继续添加或切换账号。", { cause: restoreError });
      }
      throw error;
    }
    this.recordActiveAccount(undefined, "login_new");
    const transportWarning = this.ensurePreferredTransport();
    const launchedCodex = await this.launchCodexWithPreferenceAsync();
    return { deleted: false, loginNew: true, preservedAccount, closedCodexProcesses, launchedCodex, transportWarning };
  }

  completeAddAccount(preservedAccountId) {
    if (!fs.existsSync(this.codexAuthPath)) return { status: "waiting" };
    let authJson;
    try {
      authJson = JSON.parse(fs.readFileSync(this.codexAuthPath, "utf8"));
    } catch {
      return { status: "waiting" };
    }
    const summary = summarizeAuth(authJson);
    if (!summary.hasAccessToken && !summary.hasRefreshToken) return { status: "waiting" };
    const preserved = this.readStore().accounts.find((account) => account.id === preservedAccountId);
    const fingerprint = authFingerprint(authJson);
    if (preserved && (preserved.fingerprint === fingerprint || preserved.accountId === summary.accountId)) {
      return { status: "waiting" };
    }
    return { status: "imported", account: this.importCurrentAuth() };
  }

  async refreshUsage(accountId, force = false, options = {}) {
    this.syncCurrentAuth();
    const store = this.readStore();
    const account = this.findAccount(store, accountId);
    const now = Math.floor(this.nowMs() / 1000);

    try {
      const fetched = await this.fetchUsageForAccount(account, now, force);
      if (fetched.skipped) return fetched.usage;
      const usage = fetched.usage;
      const latestStore = this.readStore();
      const latestAccount = latestStore.accounts.find((item) => item.id === accountId);
      const effectiveUsage = stabilizeQuotaUsage(latestAccount?.usage, usage);
      if (latestAccount) {
        latestAccount.usage = effectiveUsage;
        latestAccount.planType = usage.planType ?? latestAccount.planType;
        latestAccount.usageError = undefined;
        latestAccount.usageRefreshAttemptedAt = now;
        latestAccount.status = "ready";
        latestAccount.updatedAt = now;
        this.writeStore(latestStore);
      }
      if (options.observations) {
        options.observations.push({ accountId, usage });
      } else {
        await this.recordQuotaObservation(accountId, usage);
      }
      return effectiveUsage;
    } catch (error) {
      const message = redactError(error);
      const latestStore = this.readStore();
      const latestAccount = latestStore.accounts.find((item) => item.id === accountId);
      if (latestAccount) {
        latestAccount.usageError = message;
        latestAccount.usageRefreshAttemptedAt = now;
        latestAccount.status = isUsageAuthFailure(error) ? "usage_auth_expired" : "usage_failed";
        latestAccount.updatedAt = now;
        this.writeStore(latestStore);
      }
      throw new Error(message);
    }
  }

  runStartupMaintenance() {
    if (this.startupMaintenancePromise) return this.startupMaintenancePromise;
    const operation = runStartupMaintenanceInWorker({
      codexDir: this.codexDir,
      backupRoot: this.backupRoot,
      authBackupPath: this.authBackupPath,
      recoverySnapshotsPath: this.recoverySnapshotsPath,
      store: this.readStore(),
      settings: this.readSettings()
    }).then(() => {
      this.reconcileActiveAccount("startup");
    });
    const tracked = operation.finally(() => {
      if (this.startupMaintenancePromise === tracked) this.startupMaintenancePromise = undefined;
    });
    this.startupMaintenancePromise = tracked;
    return this.startupMaintenancePromise;
  }

  runStartupMaintenanceSync() {
    migratePlaintextAuthBackups(path.join(this.codexDir, "secure-switcher-backups"));
    migrateLegacySwitcherBackups(this.codexDir, this.backupRoot);
    migratePlaintextAuthBackups(this.authBackupPath);
    this.reconcileActiveAccount("startup");
    this.ensureRecoverySnapshot(this.readStore(), this.readSettings());
  }

  async fetchUsageForAccount(account, now, force = false) {
    if (!force && account.status === "usage_auth_expired") {
      return { skipped: true, skipReason: "usage_auth_expired", usage: account.usage };
    }
    if (!force && account.status === "ready" && !account.usageError && account.usage?.fetchedAt && now - account.usage.fetchedAt < 60) {
      return { skipped: true, skipReason: "fresh_cache", usage: account.usage };
    }

    const authJson = await this.decryptAccountAuthAsync(account);
    const accessToken = extractAccessToken(authJson);
    const upstreamAccountId = extractAccountId(authJson, account.accountId);
    const usage = await fetchUsageSnapshot({
      accessToken,
      accountId: upstreamAccountId,
      fetchImpl: this.fetchImpl ?? fetch,
      now: () => now
    });
    return { skipped: false, usage };
  }

  async refreshAllUsage(options = {}) {
    const listener = typeof options.onProgress === "function" ? options.onProgress : undefined;
    if (listener) {
      this.usageRefreshProgressListeners.add(listener);
      if (this.usageRefreshProgress) this.notifyUsageRefreshProgressListener(listener, this.usageRefreshProgress);
    }
    if (!this.refreshAllUsagePromise) {
      const operation = this.refreshAllUsageOnce();
      this.refreshAllUsagePromise = operation;
      void operation.finally(() => {
        if (this.refreshAllUsagePromise === operation) {
          this.refreshAllUsagePromise = undefined;
          this.usageRefreshProgress = undefined;
        }
      }).catch(() => {});
    }
    try {
      return await this.refreshAllUsagePromise;
    } finally {
      if (listener) this.usageRefreshProgressListeners.delete(listener);
    }
  }

  async refreshAllUsageOnce() {
    this.syncCurrentAuth();
    const results = [];
    const resultMetadata = [];
    const observations = [];
    const currentFingerprint = this.currentAuthFingerprint();
    const accounts = this.readStore().accounts.sort(
      (left, right) => Number(right.fingerprint === currentFingerprint) - Number(left.fingerprint === currentFingerprint)
    );
    this.notifyUsageRefreshProgress({ stage: "refreshing", completed: 0, total: accounts.length });
    const accountSnapshots = accounts.map((account) => ({
      id: account.id,
      fingerprint: account.fingerprint,
      encryptedAuth: account.encryptedAuth,
      account
    }));
    const now = Math.floor(this.nowMs() / 1000);
    let nextIndex = 1;
    let completed = 0;
    const refreshSnapshot = async (index) => {
      const snapshot = accountSnapshots[index];
      try {
        const fetched = await this.fetchUsageForAccount(snapshot.account, now, false);
        const skipped = Boolean(fetched.skipped);
        results[index] = {
          id: snapshot.id,
          ok: true,
          usage: fetched.usage,
          attempted: !skipped,
          skipped,
          skipReason: skipped ? fetched.skipReason : undefined
        };
        resultMetadata[index] = { attempted: !skipped };
      } catch (error) {
        results[index] = {
          id: snapshot.id,
          ok: false,
          attempted: true,
          skipped: false,
          error: redactError(error)
        };
        resultMetadata[index] = { attempted: true, authFailure: isUsageAuthFailure(error) };
      }
      completed += 1;
      this.notifyUsageRefreshProgress({ stage: "refreshing", completed, total: accountSnapshots.length });
    };
    if (accountSnapshots.length > 0) await refreshSnapshot(0);
    const workerCount = Math.min(3, Math.max(0, accountSnapshots.length - 1));
    const worker = async () => {
      while (true) {
        const index = nextIndex;
        nextIndex += 1;
        if (index >= accountSnapshots.length) return;
        await refreshSnapshot(index);
      }
    };
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
    this.notifyUsageRefreshProgress({ stage: "persisting", completed: results.length, total: accounts.length });

    const latestStore = this.readStore();
    let storeChanged = false;
    for (let index = 0; index < accountSnapshots.length; index += 1) {
      const snapshot = accountSnapshots[index];
      const result = results[index];
      const metadata = resultMetadata[index];
      const latestAccount = latestStore.accounts.find((item) => item.id === snapshot.id);
      if (
        !latestAccount
        || latestAccount.fingerprint !== snapshot.fingerprint
        || latestAccount.encryptedAuth !== snapshot.encryptedAuth
      ) {
        continue;
      }
      if (!metadata?.attempted) continue;
      if (result.ok) {
        latestAccount.usage = stabilizeQuotaUsage(latestAccount.usage, result.usage);
        latestAccount.planType = result.usage.planType ?? latestAccount.planType;
        latestAccount.usageError = undefined;
        latestAccount.usageRefreshAttemptedAt = now;
        latestAccount.status = "ready";
        latestAccount.updatedAt = now;
        observations.push({ accountId: snapshot.id, usage: result.usage });
      } else {
        latestAccount.usageError = result.error;
        latestAccount.usageRefreshAttemptedAt = now;
        latestAccount.status = metadata.authFailure ? "usage_auth_expired" : "usage_failed";
        latestAccount.updatedAt = now;
      }
      storeChanged = true;
    }
    if (storeChanged) this.writeStore(latestStore);
    await this.recordQuotaObservations(observations);
    this.notifyUsageRefreshProgress({ stage: "completed", completed: results.length, total: accounts.length });
    return results;
  }

  notifyUsageRefreshProgress(value) {
    const progress = {
      stage: ["refreshing", "persisting", "completed"].includes(value?.stage) ? value.stage : "refreshing",
      completed: Math.max(0, Number(value?.completed) || 0),
      total: Math.max(0, Number(value?.total) || 0)
    };
    this.usageRefreshProgress = progress;
    for (const listener of this.usageRefreshProgressListeners) this.notifyUsageRefreshProgressListener(listener, progress);
  }

  notifyUsageRefreshProgressListener(listener, value) {
    try {
      listener(value);
    } catch {}
  }

  switchAccount(accountId, options = {}) {
    this.syncCurrentAuth();
    const store = this.readStore();
    const account = this.findAccount(store, accountId);
    const authJson = this.decryptAccountAuth(account);
    const fingerprint = authFingerprint(authJson);
    const targetUsageAuthExpired = account.status === "usage_auth_expired";
    if (this.currentAuthFingerprint() === fingerprint) {
      this.recordActiveAccount(account.id, "current_confirmed");
      const dshAuthSync = this.syncDshCodexAuthAfterSwitch();
      return {
        switchedTo: this.publicAccount(account, fingerprint),
        authPath: this.codexAuthPath,
        closedCodexProcesses: 0,
        launchedCodex: false,
        alreadyCurrent: true,
        dshAuthSync
      };
    }
    if (options.deferIfCodexRunning) {
      const runningCodexProcesses = this.countCodexProcesses();
      if (runningCodexProcesses > 0) {
        return {
          switchedTo: this.publicAccount(account, this.currentAuthFingerprint()),
          authPath: this.codexAuthPath,
          closedCodexProcesses: 0,
          launchedCodex: false,
          deferred: true,
          deferReason: "codex_running",
          runningCodexProcesses
        };
      }
    }
    const manualProjectionOverride = options.manualInspection === true && options.forceProjectionSwitch === true;
    if (!manualProjectionOverride) this.assertCodexThreadProjectionHealthy();
    const threadState = this.captureStableCodexThreadState();
    const runningCodexProcesses = this.verifyCodexClosure ? this.countCodexProcesses() : 0;
    const closedCodexProcesses = this.closeCodexProcesses();
    const remainingCodexProcesses = this.verifyCodexClosure ? this.countCodexProcesses() : 0;
    if (remainingCodexProcesses > 0) {
      throw new Error("ChatGPT Codex 仍在运行，已取消本次切换以避免只替换认证文件。请完全退出 ChatGPT Codex 后重试。");
    }
    const previousAuthText = fs.readFileSync(this.codexAuthPath, "utf8");
    fs.mkdirSync(this.codexDir, { recursive: true });
    this.backupCurrentAuth();
    atomicWriteJson(this.codexAuthPath, authJson, { backup: false });
    try {
      this.assertCodexThreadStateUnchanged(threadState);
    } catch (error) {
      try {
        atomicWriteText(this.codexAuthPath, previousAuthText);
      } catch (restoreError) {
        throw new Error("本地对话状态完整性校验失败，且原账号认证恢复失败。为避免扩大影响，未重新打开 Codex；请不要继续切换账号。", { cause: restoreError });
      }
      throw error;
    }
    this.recordActiveAccount(account.id, "switch");
    this.updateSettings({ autoSwitchStayAccountId: "" });
    const transportWarning = this.ensurePreferredTransport(account);
    const dshAuthSync = this.syncDshCodexAuthAfterSwitch();
    const launchedCodex = options.deferCodexLaunch
      ? false
      : this.launchCodexWithPreference(account, {
          forceRendererAccessibility: options.forceRendererAccessibility === true
        });
    return {
      switchedTo: this.publicAccount(account, fingerprint),
      authPath: this.codexAuthPath,
      closedCodexProcesses,
      verifiedCodexClosure: runningCodexProcesses > 0 && remainingCodexProcesses === 0,
      targetUsageAuthExpired,
      launchedCodex,
      transportWarning,
      dshAuthSync
    };
  }

  async switchAccountResponsive(accountId, options = {}) {
    await this.syncCurrentAuthAsync();
    const store = this.readStore();
    const account = this.findAccount(store, accountId);
    const authJson = await this.decryptAccountAuthAsync(account);
    const fingerprint = authFingerprint(authJson);
    const targetUsageAuthExpired = account.status === "usage_auth_expired";
    if (this.currentAuthFingerprint() === fingerprint) {
      this.recordActiveAccount(account.id, "current_confirmed");
      const dshAuthSync = await this.syncDshCodexAuthAfterSwitchAsync();
      return {
        switchedTo: this.publicAccount(account, fingerprint),
        authPath: this.codexAuthPath,
        closedCodexProcesses: 0,
        launchedCodex: false,
        alreadyCurrent: true,
        dshAuthSync
      };
    }
    if (options.deferIfCodexRunning) {
      const runningCodexProcesses = await this.countCodexProcessesAsync();
      if (runningCodexProcesses > 0) {
        return {
          switchedTo: this.publicAccount(account, this.currentAuthFingerprint()),
          authPath: this.codexAuthPath,
          closedCodexProcesses: 0,
          launchedCodex: false,
          deferred: true,
          deferReason: "codex_running",
          runningCodexProcesses
        };
      }
    }
    const manualProjectionOverride = options.manualInspection === true && options.forceProjectionSwitch === true;
    if (!manualProjectionOverride && options.projectionValidated !== true) await this.assertCodexThreadProjectionHealthyAsync();
    const threadState = await this.captureStableCodexThreadStateAsync();
    const runningCodexProcesses = this.verifyCodexClosure ? await this.countCodexProcessesAsync() : 0;
    const closedCodexProcesses = await this.closeCodexProcessesAsync();
    const remainingCodexProcesses = this.verifyCodexClosure ? await this.countCodexProcessesAsync() : 0;
    if (remainingCodexProcesses > 0) {
      throw new Error("ChatGPT Codex 仍在运行，已取消本次切换以避免只替换认证文件。请完全退出 ChatGPT Codex 后重试。");
    }
    const previousAuthText = fs.readFileSync(this.codexAuthPath, "utf8");
    fs.mkdirSync(this.codexDir, { recursive: true });
    await this.backupCurrentAuthAsync();
    atomicWriteJson(this.codexAuthPath, authJson, { backup: false });
    try {
      await this.assertCodexThreadStateUnchangedAsync(threadState);
    } catch (error) {
      try {
        atomicWriteText(this.codexAuthPath, previousAuthText);
      } catch (restoreError) {
        throw new Error("本地对话状态完整性校验失败，且原账号认证恢复失败。为避免扩大影响，未重新打开 Codex；请不要继续切换账号。", { cause: restoreError });
      }
      throw error;
    }
    this.recordActiveAccount(account.id, "switch");
    this.updateSettings({ autoSwitchStayAccountId: "" });
    const transportWarning = this.ensurePreferredTransport(account);
    const dshAuthSync = await this.syncDshCodexAuthAfterSwitchAsync();
    const launchedCodex = options.deferCodexLaunch
      ? false
      : await this.launchCodexWithPreferenceAsync(account, {
          forceRendererAccessibility: options.forceRendererAccessibility === true
        });
    return {
      switchedTo: this.publicAccount(account, fingerprint),
      authPath: this.codexAuthPath,
      closedCodexProcesses,
      verifiedCodexClosure: runningCodexProcesses > 0 && remainingCodexProcesses === 0,
      targetUsageAuthExpired,
      launchedCodex,
      transportWarning,
      dshAuthSync
    };
  }

  async switchAccountPrioritized(accountId, options = {}) {
    if (this.manualResumePromise || this.autoResumeQueuePromise || this.protocolResumePromise) {
      if (options.manualInspection === true && options.forceSwitch === true) {
        const forced = await this.prepareForcedSwitch();
        if (forced.status !== "ready") return forced;
      } else {
        return {
          status: "continuation_in_progress",
          retryable: true,
          continuation: this.getAutoResumeStatus()
        };
      }
    }
    if (this.switchInProgress) return { status: "switch_in_progress", retryable: true };
    this.switchInProgress = true;
    let manualResumeTicket;
    let manualResumeQueue;
    const startedAtMs = this.nowMs();
    const switchAttemptId = crypto.randomUUID();
    let lastSwitchPhase = "starting";
    let switchOutcome = "failed";
    let switchErrorCode;
    const reportSwitchDiagnostic = (type, details = {}) => {
      try {
        this.writeAutoSwitchEvent(type, {
          attemptId: switchAttemptId,
          controllerPid: process.pid,
          mode: options.manualInspection === true ? "manual" : "automatic",
          phase: lastSwitchPhase,
          elapsedMs: Math.max(0, this.nowMs() - startedAtMs),
          ...details
        });
      } catch {} // Diagnostic storage failure must not prevent account switching.
    };
    const reportProgress = (phase) => {
      lastSwitchPhase = phase;
      const progress = { phase, elapsedMs: Math.max(0, this.nowMs() - startedAtMs) };
      try { options.onProgress?.(progress); } catch {}
      reportSwitchDiagnostic("switch_phase");
      if (options.manualInspection === true) reportSwitchDiagnostic("manual_switch_phase");
    };
    try {
      reportProgress("validating_projection");
      if (options.manualInspection === true && options.forceProjectionSwitch !== true) {
        try {
          await this.assertCodexThreadProjectionHealthyAsync();
        } catch (error) {
          const projectionBlock = projectionBlockFromError(error);
          if (projectionBlock) {
            switchOutcome = "projection_blocked";
            return { status: "projection_blocked", retryable: false, ...projectionBlock };
          }
          throw error;
        }
      }
      reportProgress("preparing_continuation");
      await this.cancelConversationBackupJobs();
      const source = this.listAccounts().find((account) => account.isCurrent);
      if (options.manualInspection && options.resumeQuotaInterruptedTask === true && !isQuotaExhaustedPublic(source)) {
        await this.refreshQuotaInterruptionEvidence();
      }
      const manualResumeDecision = options.manualInspection && options.resumeQuotaInterruptedTask === true
        ? await this.selectManualResumeDecision(accountId)
        : undefined;
      const forceRendererAccessibility = Boolean(
        // Continuation decisions are independent of account-switch verification.
        manualResumeDecision?.status === "selected" || options.forceRendererAccessibility
      );
      if (options.manualInspection) reportSwitchDiagnostic("manual_resume_decision", {
        status: manualResumeDecision?.status ?? "disabled", candidateCount: manualResumeDecision?.candidateCount ?? 0
      });
      const recoverLaunch = this.codexLaunchRetryDelaysMs.length > 0;
      reportProgress("switching_auth");
      const result = await this.switchAccountResponsive(accountId, {
        ...options,
        projectionValidated: options.manualInspection === true && options.forceProjectionSwitch !== true,
        deferCodexLaunch: recoverLaunch || options.resumeBeforeDesktopLaunch === true,
        forceRendererAccessibility
      });
      if (!result.alreadyCurrent && options.resumeBeforeDesktopLaunch === true) {
        result.autoResume = options.resumeQueue
          ? await this.beginProtocolResumeQueue(options.resumeQueue)
          : await this.beginProtocolResumeTicket(options.resumeTicket);
      } else if (!result.alreadyCurrent && recoverLaunch) {
        reportProgress("launching_codex");
        Object.assign(result, await this.verifyPrioritizedCodexLaunch({ forceRendererAccessibility }));
      }
      reportProgress("verifying_target");
      await this.syncCurrentAuthAsync();
      result.verifiedTargetAccount = this.listAccounts().some((item) => item.isCurrent && item.id === accountId);
      result.verifiedAccountSwitch = result.verifiedTargetAccount === true
        && (result.alreadyCurrent === true || result.verifiedCodexLaunch === true);
      if (options.manualInspection) {
        this.clearAutoSwitchState();
        try {
          await this.queueManualSwitchInspection(accountId);
        } catch {
          result.manualInspectionQueued = false;
        }
      }
      if (manualResumeDecision) {
        const preparedManualResume = manualResumeDecision.status === "selected"
          ? this.prepareAutoResumeAttempt(manualResumeDecision)
          : undefined;
        manualResumeQueue = isAutoResumeQueue(preparedManualResume) ? preparedManualResume : undefined;
        reportSwitchDiagnostic("manual_resume_preparation", {
          status: preparedManualResume?.status ?? (preparedManualResume ? "prepared" : "skipped"),
          candidateCount: manualResumeDecision.candidateCount ?? 0
        });
        manualResumeTicket = isAutoResumeTicket(preparedManualResume) ? preparedManualResume : undefined;
        result.manualResume = manualResumeQueue
          ? this.beginPreparedAutoResumeQueue(manualResumeQueue)
          : isAutoResumeOutcome(preparedManualResume)
            ? preparedManualResume
            : this.completeManualResume(manualResumeDecision, manualResumeTicket, result);
      }
      reportProgress("completed");
      switchOutcome = result.verifiedAccountSwitch === true ? "verified" : "unverified";
      return result;
    } catch (error) {
      switchErrorCode = ["EACCES", "EPERM", "ENOENT", "ETIMEDOUT", "ECONNREFUSED", "ENOSPC"].includes(error?.code)
        ? error.code : "unclassified";
      const projectionBlock = projectionBlockFromError(error);
      if (options.manualInspection === true && options.forceProjectionSwitch !== true && projectionBlock) {
        switchOutcome = "projection_blocked";
        return { status: "projection_blocked", retryable: false, ...projectionBlock };
      }
      if (manualResumeTicket) this.finishAutoResumeTicket(manualResumeTicket.attemptId, "failed");
      if (manualResumeQueue) this.failAutoResumeQueue(manualResumeQueue.attemptId);
      throw error;
    } finally {
      this.switchInProgress = false;
      reportSwitchDiagnostic("switch_finished", { outcome: switchOutcome, errorCode: switchErrorCode });
    }
  }

  async selectManualResumeDecision(accountId) {
    const accounts = this.listAccounts();
    const source = accounts.find((account) => account.isCurrent);
    const target = accounts.find((account) => account.id === accountId);
    if (!source) return { status: "ineligible", reason: "source_not_available" };
    if (!target || target.isCurrent) {
      if (!isQuotaExhaustedPublic(source)) {
        return { status: "ineligible", reason: "source_not_exhausted" };
      }
      return { status: "ineligible", reason: "target_current_or_missing" };
    }
    const activityStatus = await this.getCodexActivityStatusForAutoSwitch();
    const decision = await this.selectAutoResumeDecisionAsync(activityStatus, { lookbackMs: AUTO_RESUME_CAPTURE_LOOKBACK_MS });
    if (decision.status === "none") {
      if (!isQuotaExhaustedPublic(source)) {
        return { status: "ineligible", reason: "source_not_exhausted" };
      }
      return decision;
    }
    return decision;
  }

  completeManualResume(decision, ticket, switchResult) {
    if (decision.status === "none") return { status: "skipped_no_candidate" };
    if (decision.status === "ambiguous") {
      return { status: "skipped_multiple_candidates", candidateCount: decision.candidateCount };
    }
    if (decision.status === "ineligible") return { status: `skipped_${decision.reason}` };
    if (!ticket) {
      return pendingAutoResumeCandidateOutcome(decision, this.getAutoResumeState())
        ?? { status: "skipped_previous_attempt" };
    }
    if (switchResult.alreadyCurrent) {
      this.finishAutoResumeTicket(ticket.attemptId, "failed");
      return { status: "skipped_already_current" };
    }
    if (switchResult.verifiedCodexLaunch !== true) {
      return this.finishAutoResumeTicket(ticket.attemptId, "failed");
    }
    const operation = this.startPreparedAutoResume(ticket);
    this.manualResumePromise = operation;
    void operation
      .catch(() => this.finishAutoResumeTicket(ticket.attemptId, "failed"))
      .finally(() => {
        if (this.manualResumePromise === operation) this.manualResumePromise = undefined;
      });
    return { status: "pending" };
  }

  async prepareForcedSwitch() {
    const continuation = this.protocolResumePromise || this.manualResumePromise || this.autoResumeQueuePromise;
    const cancel = this.protocolResumePromise ? this.cancelActiveProtocolResume : this.cancelActiveManualResume;
    if (!continuation || typeof cancel !== "function") {
      return {
        status: "continuation_in_progress",
        retryable: true,
        forceBlocked: true,
        reason: "desktop_continuation_not_cancellable",
        continuation: this.getAutoResumeStatus()
      };
    }
    this.writeAutoSwitchEvent("continuation_force_cancel_requested", { reason: "manual_force_switch" });
    this.abandonInterruptedAutoResume();
    try { cancel(); } catch {}
    let timer;
    try {
      await Promise.race([
        Promise.resolve(continuation).catch(() => {}),
        new Promise((resolve) => { timer = this.setTimeout(resolve, PROTOCOL_PROCESS_CLOSE_WAIT_MS); })
      ]);
    } finally {
      if (timer !== undefined) this.clearTimeout(timer);
    }
    if (this.protocolResumePromise || this.manualResumePromise || this.autoResumeQueuePromise) {
      return {
        status: "continuation_in_progress",
        retryable: true,
        forceBlocked: true,
        reason: "continuation_cancel_pending",
        continuation: this.getAutoResumeStatus()
      };
    }
    return { status: "ready" };
  }

  async queueManualSwitchInspection(accountId) {
    const settings = this.readSettings();
    const current = this.listAccounts().find((account) => account.isCurrent);
    if (!settings.autoSwitchEnabled || current?.id !== accountId || !isQuotaExhaustedPublic(current)) return;

    const resolved = await this.resolveAutoSwitchTarget(current.id);
    if (!resolved.target || resolved.unavailableReason) return;

    const nowMs = this.nowMs();
    const pending = {
      accountId: resolved.target.id,
      emailMasked: resolved.target.emailMasked,
      mode: resolved.mode,
      reason: "manual-switch-inspection",
      createdAtMs: nowMs,
      updatedAtMs: nowMs,
      activityKey: "manual-switch-inspection",
      activityBusy: false,
      quietStartedAtMs: nowMs,
      quietActivityKey: "manual-switch-inspection",
      quietUntilMs: nowMs + DEFAULT_AUTO_SWITCH_QUIET_MS,
      fallback: resolved.fallback
    };
    this.writeAutoSwitchState({ pending });
    this.writeAutoSwitchEvent("queued", {
      mode: resolved.mode,
      accountId: resolved.target.id,
      reason: pending.reason
    });
  }

  deleteAccount(accountId, replacementAccountIdOrOptions) {
    this.syncCurrentAuth();
    const deleteOptions = normalizeDeleteOptions(replacementAccountIdOrOptions);
    const store = this.readStore();
    const account = this.findAccount(store, accountId);
    const currentFingerprint = this.currentAuthFingerprint();
    const isCurrent = Boolean(currentFingerprint && account.fingerprint === currentFingerprint);

    if (!isCurrent) {
      store.accounts = store.accounts.filter((item) => item.id !== accountId);
      this.writeStore(store);
      this.clearDeletedAccountReferences(accountId);
      return { deleted: true, closedCodexProcesses: 0, launchedCodex: false };
    }

    if (deleteOptions.mode === "login_new") {
      this.assertCodexThreadProjectionHealthy();
      const closedCodexProcesses = this.closeCodexProcesses();
      const remainingCodexProcesses = this.verifyCodexClosure ? this.countCodexProcesses() : 0;
      if (remainingCodexProcesses > 0) {
        throw new Error("ChatGPT Codex 仍在运行，已取消删除当前账号以避免修改认证文件。请完全退出 ChatGPT Codex 后重试。");
      }
      fs.mkdirSync(this.codexDir, { recursive: true });
      this.backupCriticalCodexState();
      this.backupCurrentAuth();
      fs.rmSync(this.codexAuthPath, { force: true });
      store.accounts = store.accounts.filter((item) => item.id !== accountId);
      this.writeStore(store);
      this.recordActiveAccount(undefined, "login_new");
      this.clearDeletedAccountReferences(accountId);
      const transportWarning = this.ensurePreferredTransport();
      const launchedCodex = this.launchCodexWithPreference();
      return {
        deleted: true,
        loginNew: true,
        authPath: this.codexAuthPath,
        closedCodexProcesses,
        launchedCodex,
        transportWarning
      };
    }

    const replacementAccountId = deleteOptions.replacementAccountId;
    if (!replacementAccountId || replacementAccountId === accountId) {
      throw new Error("删除当前账号前必须选择另一个账号用于切换。");
    }
    const replacement = this.findAccount(store, replacementAccountId);
    const replacementAuth = this.decryptAccountAuth(replacement);
    this.assertCodexThreadProjectionHealthy();
    const closedCodexProcesses = this.closeCodexProcesses();
    const remainingCodexProcesses = this.verifyCodexClosure ? this.countCodexProcesses() : 0;
    if (remainingCodexProcesses > 0) {
      throw new Error("ChatGPT Codex 仍在运行，已取消删除当前账号以避免修改认证文件。请完全退出 ChatGPT Codex 后重试。");
    }
    fs.mkdirSync(this.codexDir, { recursive: true });
    this.backupCriticalCodexState();
    this.backupCurrentAuth();
    atomicWriteJson(this.codexAuthPath, replacementAuth, { backup: false });
    store.accounts = store.accounts.filter((account) => account.id !== accountId);
    const replacementInStore = store.accounts.find((item) => item.id === replacementAccountId);
    if (replacementInStore) {
      replacementInStore.usageError = undefined;
      replacementInStore.status = "ready";
      replacementInStore.updatedAt = unixNow();
    }
    this.writeStore(store);
    this.recordActiveAccount(replacementAccountId, "replacement_switch");
    this.clearDeletedAccountReferences(accountId);
    const transportWarning = this.ensurePreferredTransport(replacementInStore ?? replacement);
    const dshAuthSync = this.syncDshCodexAuthAfterSwitch();
    const launchedCodex = this.launchCodexWithPreference(replacementInStore ?? replacement);
    return {
      deleted: true,
      switchedTo: this.publicAccount(replacementInStore ?? replacement, authFingerprint(replacementAuth)),
      closedCodexProcesses,
      launchedCodex,
      transportWarning,
      dshAuthSync
    };
  }

  pickBestAccount() {
    const now = Math.floor(this.nowMs() / 1000);
    const accounts = this.listAccounts().filter((account) => !account.isAutoSwitchExcluded);
    const best = pickBest(accounts, now);
    const recovery = best ? undefined : pickRecoveryAccount(accounts, now);
    return best
      ? { account: best, score: remainingScore(best, now), mode: "immediate" }
      : { account: undefined, score: 0, mode: recovery ? "recovery" : "none", recovery };
  }

  countOfficialCodexProcesses() {
    return this.countCodexProcesses();
  }

  getCodexActivityStatus() {
    if (this.getCodexActivityStatusOverride) return this.getCodexActivityStatusOverride();
    return getCodexActivityStatus({
      codexDir: this.codexDir,
      isProcessAlive: this.isProcessAlive,
      getProcessInfo: this.getCodexProcessInfo,
      nowMs: this.nowMs(),
      activityWindowMs: this.activityWindowMs,
      taskActivityCache: this.taskActivityCache,
      inspectOfficialProcesses: this.inspectCodexProcesses,
      readProcessRegistry: this.readCodexProcessRegistry
    });
  }

  async searchLocalCodexThreads(query = "") {
    const safeQuery = typeof query === "string" ? query : "";
    const protectedActiveThreadIds = normalizeThreadIds(this.protectedActiveThreadIds);
    const protectedActiveRevision = protectedActiveThreadIds.join("\n");
    if (this.searchLocalCodexThreadsImpl) {
      const threads = await this.searchLocalCodexThreadsImpl(this.codexDir, safeQuery, { protectedActiveThreadIds });
      this.reconcileDesktopResumeOutcomes(threads);
      return threads;
    }
    const revisions = codexThreadStateRevisions(this.codexDir);
    if (!this.threadSearchCache
      || this.threadSearchCache.inventoryRevision !== revisions.inventoryRevision
      || this.threadSearchCache.protectedActiveRevision !== protectedActiveRevision) {
      const operation = this.searchLocalCodexThreadsInWorker({
        codexDir: this.codexDir,
        revision: revisions.inventoryRevision,
        protectedActiveThreadIds
      });
      this.threadSearchCache = { ...revisions, protectedActiveRevision, operation };
      operation.catch(() => {
        if (this.threadSearchCache?.operation === operation) this.threadSearchCache = undefined;
      });
    } else if (this.threadSearchCache.sidebarRevision !== revisions.sidebarRevision) {
      const operation = this.threadSearchCache.operation
        .then((threads) => remapLocalCodexThreadSidebarState(this.codexDir, threads));
      this.threadSearchCache = { ...revisions, protectedActiveRevision, operation };
      operation.catch(() => {
        if (this.threadSearchCache?.operation === operation) this.threadSearchCache = undefined;
      });
    }
    const threads = await this.threadSearchCache.operation;
    this.reconcileDesktopResumeOutcomes(threads);
    return filterLocalCodexThreads(threads, safeQuery);
  }

  reconcileDesktopResumeOutcomes(threads) {
    const state = this.getAutoResumeState();
    if (state.resumeMethod !== AUTO_RESUME_DESKTOP_METHOD || !Array.isArray(threads)) return;
    for (const item of state.items ?? [state]) {
      if (item.stage !== "turn_started") continue;
      const thread = threads.find(({ id }) => id === item.threadId);
      if (!thread || !Number.isFinite(thread.lifecycleAtMs)
        || thread.lifecycleAtMs <= (item.submissionStartedAtMs ?? item.phaseStartedAtMs ?? item.updatedAtMs)
        || thread.lifecycleAtMs > this.nowMs()) continue;
      if (!["completed", "failed", "usage_limited", "interrupted"].includes(thread.turnState)) continue;
      const stage = thread.turnState === "completed" ? "completed" : "failed";
      const failureReason = thread.turnState === "usage_limited" ? "usage_limit_exceeded"
        : thread.turnState === "interrupted" ? "task_cancelled" : thread.resumeReason ?? "task_failed";
      const result = state.items
        ? this.finishAutoResumeQueueItem(state.attemptId, item.threadId, stage, { failureReason })
        : this.finishAutoResumeTicket(state.attemptId, stage, { failureReason });
      if (result.status === stage) {
        try { this.writeAutoSwitchEvent("continuation_execution_finished", {
          stage, reason: stage === "completed" ? "completed" : failureReason,
          eventAtMs: thread.lifecycleAtMs
        }); } catch {}
      }
    }
  }

  getCodexThreadSidebarStateRevision() {
    return codexThreadSidebarStateRevision(this.codexDir);
  }

  readAutoSwitchTargetPreference() {
    const settings = this.readSettings();
    return {
      mode: settings.autoSwitchTargetMode,
      accountId: settings.manualAutoSwitchTargetAccountId
    };
  }

  setAutoSwitchTarget(accountId) {
    this.syncCurrentAuth();
    const store = this.readStore();
    const account = this.findAccount(store, accountId);
    if (account.fingerprint === this.currentAuthFingerprint()) {
      throw new Error("当前账号不能设为下一个自动切换目标。");
    }
    const settings = this.readSettings();
    return this.updateSettings({
      autoSwitchTargetMode: "manual",
      manualAutoSwitchTargetAccountId: accountId,
      autoSwitchExcludedAccountIds: settings.autoSwitchExcludedAccountIds.filter((id) => id !== accountId)
    });
  }

  clearAutoSwitchTarget() {
    return this.updateSettings({
      autoSwitchTargetMode: "best",
      manualAutoSwitchTargetAccountId: undefined
    });
  }

  setAutoSwitchExcluded(accountId, excluded = true) {
    this.syncCurrentAuth();
    const store = this.readStore();
    this.findAccount(store, accountId);
    const settings = this.readSettings();
    const excludedIds = new Set(settings.autoSwitchExcludedAccountIds);
    if (excluded) {
      excludedIds.add(accountId);
      return this.updateSettings({
        autoSwitchTargetMode:
          settings.autoSwitchTargetMode === "manual" && settings.manualAutoSwitchTargetAccountId === accountId
            ? "best"
            : settings.autoSwitchTargetMode,
        autoSwitchExcludedAccountIds: [...excludedIds]
      });
    }
    excludedIds.delete(accountId);
    return this.updateSettings({ autoSwitchExcludedAccountIds: [...excludedIds] });
  }

  clearAutoSwitchExclusions() {
    return this.updateSettings({ autoSwitchExcludedAccountIds: [] });
  }

  getAutoSwitchState(options = {}) {
    const state = normalizeAutoSwitchState(readJsonIfExists(this.autoSwitchStatePath, {}));
    if (options.includePrivate || !state.blocked) return state;
    const { sourceAccountFingerprint: _sourceAccountFingerprint, ...blocked } = state.blocked;
    return { ...state, blocked };
  }

  writeAutoSwitchState(state) {
    const next = normalizeAutoSwitchState(state);
    atomicWriteJson(this.autoSwitchStatePath, next);
    return next;
  }

  clearAutoSwitchState() {
    return this.writeAutoSwitchState({});
  }

  async revalidateProjectionBlock(blocked, pending) {
    if (!PROJECTION_BLOCK_CODES.has(blocked?.reasonCode)) return false;
    if (this.projectionRevalidationPromise) return this.projectionRevalidationPromise;
    const expectedState = JSON.stringify(this.getAutoSwitchState({ includePrivate: true }));
    const fingerprint = this.currentAuthFingerprint();
    this.projectionRevalidationPromise = (async () => {
      let health;
      try {
        health = await this.inspectProjectionHealthAsync("blocked_revalidation");
      } catch {
        return false;
      }
      if (health?.healthy !== true || !["healthy", "not_applicable"].includes(health?.status)) {
        return false;
      }
      try {
        if (fingerprint !== this.currentAuthFingerprint()
          || expectedState !== JSON.stringify(this.getAutoSwitchState({ includePrivate: true }))) return false;
        this.writeAutoSwitchState(pending ? { pending } : {});
        return true;
      } catch {
        return false;
      }
    })();
    try { return await this.projectionRevalidationPromise; }
    finally { this.projectionRevalidationPromise = undefined; }
  }

  async evaluateAutoSwitch(reason = "auto") {
    if (this.switchInProgress) return { status: "switching" };
    if (this.manualResumePromise || this.protocolResumePromise) {
      return { status: "continuation_in_progress", continuation: this.getAutoResumeStatus() };
    }
    this.syncCurrentAuth();
    const unprojectedCurrent = this.listAccounts().find((account) => account.isCurrent);
    if (unprojectedCurrent && !isQuotaExhaustedPublic(unprojectedCurrent)) {
      await this.refreshQuotaInterruptionEvidence();
    }
    const settings = this.readSettings();
    const current = this.listAccounts().find((account) => account.isCurrent);
    const autoSwitchState = this.getAutoSwitchState({ includePrivate: true });
    const pending = autoSwitchState.pending;
    const blocked = autoSwitchState.blocked;

    if (!settings.autoSwitchEnabled) {
      this.writeAutoSwitchEvent("disabled", { reason });
      return { status: "disabled" };
    }
    if (!current) {
      this.clearAutoSwitchState();
      this.writeAutoSwitchEvent("not_ready", { reason: "current_unavailable" });
      return { status: "not_ready", reason: "current_unavailable" };
    }
    if (settings.autoSwitchStayAccountId === current.id) {
      if (pending) this.clearAutoSwitchState();
      return { status: "held", account: current };
    }
    if (settings.autoSwitchStayAccountId) {
      this.updateSettings({ autoSwitchStayAccountId: "" });
    }
    if (!isQuotaExhaustedPublic(current)) {
      if (pending || blocked) {
        this.clearAutoSwitchState();
        this.writeAutoSwitchEvent("cancelled", { reason: "current_recovered", accountId: pending?.accountId });
        return { status: "cancelled", reason: "current_recovered" };
      }
      return { status: "idle", reason: "current_available" };
    }
    if (blocked) {
      if (blocked.sourceAccountFingerprint !== this.currentAuthFingerprint()) {
        this.clearAutoSwitchState();
      } else if (!await this.revalidateProjectionBlock(blocked, pending)) {
        return {
          status: "blocked",
          retryable: false,
          reasonCode: blocked.reasonCode,
          projection: blocked.projection
        };
      } else {
        // The async check yielded: read fresh account, settings and pending state.
        return this.evaluateAutoSwitch(reason);
      }
    }

    const resolved = await (pending?.mode === "manual"
      ? this.resolvePendingManualTarget(pending, current.id)
      : this.resolveAutoSwitchTarget(current.id));
    if (resolved.mode === "manual" && settings.autoSwitchTargetMode === "manual") {
      this.clearAutoSwitchTarget();
    }
    if (!resolved.target || resolved.unavailableReason) {
      this.clearAutoSwitchState();
      this.writeAutoSwitchEvent("target_unavailable", {
        mode: resolved.mode,
        accountId: resolved.target?.id,
        reason: resolved.unavailableReason ?? "no_target"
      });
      return {
        status: "target_unavailable",
        mode: resolved.mode,
        target: resolved.target,
        reason: resolved.unavailableReason ?? "no_target"
      };
    }

    const unchangedPendingFallback = pending?.accountId === resolved.target.id
      && pending.fallback?.requestedTargetId === resolved.fallback?.requestedTargetId
      && pending.fallback?.reason === resolved.fallback?.reason;
    if (resolved.fallback && !unchangedPendingFallback) {
      this.writeAutoSwitchEvent("manual_target_fallback", {
        mode: resolved.mode,
        accountId: resolved.target.id,
        requestedTargetId: resolved.fallback.requestedTargetId,
        reason: resolved.fallback.reason
      });
    }

    const activityStatus = await this.getCodexActivityStatusForAutoSwitch();
    const decision = decideAutoSwitchActivity(activityStatus, pending, { nowMs: this.nowMs() });
    if (decision.shouldQueue) {
      const autoResumeDecision = settings.autoResumeAfterQuotaSwitch
        ? pending?.autoResumeDecision ?? await this.selectAutoResumeDecisionAsync(activityStatus, {
          lookbackMs: isQuotaExhaustedPublic(current) ? AUTO_RESUME_CAPTURE_LOOKBACK_MS : AUTO_RESUME_USAGE_LIMIT_LOOKBACK_MS
        })
        : undefined;
      const nextPending = {
        accountId: resolved.target.id,
        emailMasked: resolved.target.emailMasked,
        mode: resolved.mode,
        reason: pending?.reason ?? reason,
        createdAtMs: pending?.createdAtMs ?? this.nowMs(),
        updatedAtMs: this.nowMs(),
        lastBusyAt: decision.lastBusyAt,
        activityKey: decision.activityKey,
        activityBusy: decision.activityBusy,
        quietStartedAtMs: decision.quietStartedAtMs,
        quietActivityKey: decision.quietActivityKey,
        quietUntilMs: decision.quietUntilMs,
        activityReason: activityStatus.reason,
        activeTasks: activityStatus.activeTasks,
        activeThreadIds: activityStatus.activeThreadIds,
        threadIdUnavailable: activityStatus.threadIdUnavailable,
        processRegistryState: activityStatus.processRegistryState,
        processRegistryDiagnostic: activityStatus.processRegistryDiagnostic,
        officialProcessCount: activityStatus.officialProcessCount,
        processEvidenceSource: activityStatus.processEvidenceSource,
        taskEvidenceSource: activityStatus.taskEvidenceSource,
        taskAssociationConfidence: activityStatus.taskAssociationConfidence,
        fallback: resolved.fallback,
        autoResumeDecision
      };
      this.writeAutoSwitchState({ pending: nextPending });
      if (!pending?.autoResumeDecision && autoResumeDecision) {
        this.writeAutoSwitchEvent("resume_decision_captured", {
          status: autoResumeDecision.status,
          candidateCount: autoResumeDecision.candidateCount ?? 0
        });
      }
      this.writeAutoSwitchEvent("queued", {
        mode: resolved.mode,
        accountId: resolved.target.id,
        reason,
        activityReason: activityStatus.reason
      });
      return { status: "queued", target: resolved.target, pending: nextPending, activityStatus, fallback: resolved.fallback };
    }

    const autoResumeDecision = settings.autoResumeAfterQuotaSwitch
      ? await this.selectAutoResumeDecisionAsync(activityStatus, {
        lookbackMs: isQuotaExhaustedPublic(current) ? AUTO_RESUME_CAPTURE_LOOKBACK_MS : AUTO_RESUME_USAGE_LIMIT_LOOKBACK_MS
      })
      : undefined;
    return this.completeAutoSwitch(resolved, reason, pending, autoResumeDecision);
  }

  selectAutoResumeDecision(activityStatus) {
    if (activityStatus?.threadIdUnavailable === true) {
      return { status: "none", candidateCount: 0 };
    }
    const nowMs = this.nowMs();
    const selectionWindow = this.quotaInterruptionSelectionWindow(nowMs, AUTO_RESUME_USAGE_LIMIT_LOOKBACK_MS);
    const preferredThreadIds = normalizeThreadIds(activityStatus?.activeThreadIds);
    return normalizeAutoResumeDecision(this.selectQuotaInterruptedThread({
      nowMs,
      ...selectionWindow,
      preferredThreadIds,
      allowSwitchInterruptedActiveThread: activityStatus?.isBusy === true && preferredThreadIds.length > 0,
      selectAllCandidates: true
    })) ?? { status: "none", candidateCount: 0 };
  }

  async selectAutoResumeDecisionAsync(activityStatus, options = {}) {
    const nowMs = this.nowMs();
    const requestedLookbackMs = Number.isFinite(options.lookbackMs) && options.lookbackMs >= AUTO_RESUME_USAGE_LIMIT_LOOKBACK_MS
      ? options.lookbackMs
      : AUTO_RESUME_USAGE_LIMIT_LOOKBACK_MS;
    const selectionWindow = this.quotaInterruptionSelectionWindow(nowMs, requestedLookbackMs);
    const preferredThreadIds = normalizeThreadIds(activityStatus?.activeThreadIds);
    try {
      return normalizeAutoResumeDecision(await this.selectQuotaInterruptedThreadAsync({
        nowMs,
        ...selectionWindow,
        preferredThreadIds,
        allowSwitchInterruptedActiveThread: activityStatus?.isBusy === true && preferredThreadIds.length > 0,
        selectAllCandidates: true
      })) ?? { status: "none", candidateCount: 0 };
    } catch {
      return { status: "none", candidateCount: 0 };
    }
  }

  async completeAutoSwitch(resolved, reason, pending, resumeDecision) {
    if (this.switchInProgress || this.autoSwitchCompletionInProgress) return { status: "switching" };
    this.autoSwitchCompletionInProgress = true;
    let normalizedResumeDecision;
    let resumeTicket;
    let resumeQueue;
    let resumePreparationOutcome;
    try {
      normalizedResumeDecision = normalizeAutoResumeDecision(resumeDecision);
      const preparedResume = normalizedResumeDecision?.status === "selected"
        ? this.prepareAutoResumeAttempt(normalizedResumeDecision)
        : undefined;
      resumeQueue = isAutoResumeQueue(preparedResume) ? preparedResume : undefined;
      resumeTicket = isAutoResumeTicket(preparedResume) ? preparedResume : undefined;
      resumePreparationOutcome = !resumeQueue && !resumeTicket ? preparedResume : undefined;
      const protocolResume = this.resumeExecutorMode === "app-server" && Boolean(resumeTicket || resumeQueue);
      const result = await this.switchAccountPrioritized(resolved.target.id, {
        forceRendererAccessibility: Boolean(resumeTicket || resumeQueue),
        resumeBeforeDesktopLaunch: protocolResume,
        resumeTicket,
        resumeQueue
      });
      if (result?.status === "continuation_in_progress" || result?.status === "switch_in_progress") {
        if (resumeTicket) this.finishAutoResumeTicket(resumeTicket.attemptId, "failed");
        if (resumeQueue) this.failAutoResumeQueue(resumeQueue.attemptId);
        return result;
      }
      this.clearAutoSwitchState();
      this.clearAutoSwitchExclusions();
      if (protocolResume) {
        result.autoResume ??= { status: "failed" };
      } else if (normalizedResumeDecision?.status === "none") {
        result.autoResume = { status: "skipped_no_candidate" };
      } else if (normalizedResumeDecision?.status === "ambiguous") {
        result.autoResume = {
          status: "skipped_multiple_candidates",
          candidateCount: normalizedResumeDecision.candidateCount
        };
      } else if (normalizedResumeDecision?.status === "selected" && !resumeTicket) {
        result.autoResume = resumeQueue
          ? result.verifiedCodexLaunch
            ? this.beginPreparedAutoResumeQueue(resumeQueue)
            : this.failAutoResumeQueue(resumeQueue.attemptId)
          : resumePreparationOutcome
            ?? pendingAutoResumeCandidateOutcome(normalizedResumeDecision, this.getAutoResumeState())
            ?? { status: "skipped" };
      } else if (resumeTicket) {
        result.autoResume = result.verifiedCodexLaunch
          ? await this.startPreparedAutoResume(resumeTicket)
          : this.finishAutoResumeTicket(resumeTicket.attemptId, "failed");
      }
      this.writeAutoSwitchEvent("switched", {
        mode: resolved.mode,
        accountId: resolved.target.id,
        closedCodexProcesses: result.closedCodexProcesses ?? 0,
        dshAuthSync: result.dshAuthSync?.status ?? "unknown",
        dshAuthSyncReason: result.dshAuthSync?.reason,
        autoResumeStatus: result.autoResume?.status,
        autoResumeCandidateCount: normalizedResumeDecision?.candidateCount ?? 0
      });
      return { status: "switched", target: resolved.target, result, fallback: resolved.fallback };
    } catch (error) {
      if (resumeTicket) this.finishAutoResumeTicket(resumeTicket.attemptId, "failed");
      if (resumeQueue) this.failAutoResumeQueue(resumeQueue.attemptId);
      const projectionBlock = projectionBlockFromError(error);
      if (projectionBlock) {
        this.writeAutoSwitchState({
          blocked: {
            ...projectionBlock,
            sourceAccountFingerprint: this.currentAuthFingerprint(),
            createdAtMs: this.nowMs()
          }
        });
        this.writeAutoSwitchEvent("switch_blocked", {
          mode: resolved.mode,
          reasonCode: projectionBlock.reasonCode,
          projection: projectionBlock.projection
        });
        return {
          status: "failed",
          retryable: false,
          ...projectionBlock
        };
      }
      const failed = {
        accountId: resolved.target.id,
        emailMasked: resolved.target.emailMasked,
        mode: resolved.mode,
        reason,
        createdAtMs: pending?.createdAtMs ?? this.nowMs(),
        updatedAtMs: this.nowMs(),
        fallback: resolved.fallback,
        autoResumeDecision: pending?.autoResumeDecision,
        lastError: redactError(error)
      };
      this.writeAutoSwitchState({ pending: failed });
      this.writeAutoSwitchEvent("switch_failed", {
        mode: resolved.mode,
        accountId: resolved.target.id,
        error: failed.lastError
      });
      return { status: "failed", target: resolved.target, error: failed.lastError, fallback: resolved.fallback };
    } finally {
      this.autoSwitchCompletionInProgress = false;
    }
  }

  async resolveAutoSwitchTarget(currentAccountId) {
    const allAccounts = this.listAccounts();
    const settings = this.readSettings();
    const excludedIds = new Set(settings.autoSwitchExcludedAccountIds);
    const accounts = allAccounts.filter((account) => account.id !== currentAccountId && !excludedIds.has(account.id));
    const now = Math.floor(this.nowMs() / 1000);
    if (settings.autoSwitchTargetMode === "manual" && settings.manualAutoSwitchTargetAccountId) {
      const requestedTarget = allAccounts.find((account) => account.id === settings.manualAutoSwitchTargetAccountId);
      const target = accounts.find((account) => account.id === settings.manualAutoSwitchTargetAccountId);
      const unavailableReason = !requestedTarget
        ? "manual_target_missing"
        : requestedTarget.id === currentAccountId
          ? "manual_target_current"
        : excludedIds.has(requestedTarget.id)
          ? "manual_target_excluded"
        : !isUsableAutoSwitchTarget(target, now)
          ? "manual_target_unavailable"
          : !await this.canReadAccountAuth(target.id)
            ? "manual_target_unreadable"
            : undefined;
      if (!unavailableReason) {
        return { mode: "manual", target };
      }
      const fallback = pickBest(await this.readableAccounts(accounts.filter((account) => account.id !== target?.id)), now);
      return fallback
        ? {
            mode: "manual",
            target: fallback,
            fallback: { requestedTargetId: settings.manualAutoSwitchTargetAccountId, reason: unavailableReason }
          }
        : { mode: "manual", target, unavailableReason };
    }
    return { mode: "best", target: pickBest(await this.readableAccounts(accounts), now) };
  }

  async resolvePendingManualTarget(pending, currentAccountId) {
    const now = Math.floor(this.nowMs() / 1000);
    const target = this.listAccounts().find((account) => account.id === pending.accountId && account.id !== currentAccountId);
    if (target && !target.isAutoSwitchExcluded && isUsableAutoSwitchTarget(target, now) && await this.canReadAccountAuth(target.id)) {
      return { mode: "manual", target, fallback: pending.fallback };
    }
    return this.resolveAutoSwitchTarget(currentAccountId);
  }

  async readableAccounts(accounts) {
    const readable = [];
    for (const account of accounts) {
      if (await this.canReadAccountAuth(account.id)) readable.push(account);
    }
    return readable;
  }

  async canReadAccountAuth(accountId) {
    const account = this.readStore().accounts.find((item) => item.id === accountId);
    if (!account) {
      return false;
    }
    const cached = this.authReadabilityCache.get(accountId);
    if (cached?.encryptedAuth === account.encryptedAuth) return cached.readable;
    let readable = false;
    try {
      await this.decryptAccountAuthAsync(account);
      readable = true;
    } catch {}
    if (readable) {
      this.authReadabilityCache.set(accountId, { encryptedAuth: account.encryptedAuth, readable: true });
    } else {
      this.authReadabilityCache.delete(accountId);
    }
    return readable;
  }

  getTokenUsageStats(options = {}) {
    return getTokenUsageStats({
      codexDir: this.codexDir,
      nowMs: selectedStatsNowMs(options?.asOfDate, this.nowMs()),
      cachePath: this.tokenUsageCachePath
    });
  }

  getWeeklyUsageReport(options = {}) {
    const weekStartMs = parseLocalDateStart(options?.weekStart) ?? startOfPreviousLocalWeek(this.nowMs());
    return this.getUsageReport("weekly", weekStartMs);
  }

  getDailyUsageReport(options = {}) {
    const dayStartMs = parseLocalDateStart(options?.date) ?? beijingDayStart(this.nowMs());
    return this.getUsageReport("daily", dayStartMs);
  }

  getUsageReport(mode, startMs, endMs) {
    const key = `${mode}:${startMs}:${endMs ?? ""}`;
    if (this.reportRequests.has(key)) return this.reportRequests.get(key);
    const source = this.buildUsageReport({
      mode,
      codexDir: this.codexDir,
      cachePath: this.reportUsageIndexPath,
      observationPath: this.usageObservationsPath,
      accounts: this.listAccounts(),
      startMs,
      ...(endMs === undefined ? {} : { endMs }),
      nowMs: this.nowMs()
    });
    const operation = Promise.resolve(source).finally(() => {
      if (this.reportRequests.get(key) === operation) this.reportRequests.delete(key);
    });
    this.reportRequests.set(key, operation);
    return operation;
  }

  async getEdgeTokenUsage(accountId, quota = {}, windowName) {
    if (!accountId || !["fiveHour", "oneWeek"].includes(windowName)) return undefined;
    const nowMs = this.nowMs();
    const window = quota?.[windowName];
    const resetAtSeconds = Number(window?.resetAt);
    const windowSeconds = Number(window?.windowSeconds);
    const currentCycleStartMs = this.currentAccountCycleStartMs(accountId, nowMs);
    if (!Number.isFinite(resetAtSeconds) || !Number.isFinite(windowSeconds) || windowSeconds <= 0 || currentCycleStartMs === undefined) {
      return undefined;
    }
    const startMs = Math.max(resetAtSeconds * 1000 - windowSeconds * 1000, currentCycleStartMs);
    if (!Number.isFinite(startMs) || startMs >= nowMs) return undefined;
    const report = await this.getUsageReport("window", startMs, nowMs);
    return report.accounts?.find((item) => item.accountId === accountId)?.totalTokens;
  }

  async clearUsageObservations() {
    const current = this.currentSavedAccountId();
    if (this.clearObservations) {
      await this.clearObservations({
        observationPath: this.usageObservationsPath,
        accountId: current,
        nowMs: this.nowMs()
      });
      return { cleared: true };
    }
    const state = createObservationState();
    if (current) {
      setActiveAccount(state, { accountId: current, atMs: this.nowMs(), source: "history_reset" });
    }
    writeObservationState(this.usageObservationsPath, state);
    return { cleared: true };
  }

  async runConversationBackup(reason, options = {}) {
    if (!CONVERSATION_BACKUP_REASONS.has(reason)) {
      throw new Error(`Unsupported conversation backup reason: ${reason}`);
    }
    if (this.switchInProgress) {
      if (reason === "daily-idle") return { skipped: true, reason: "switch_in_progress" };
      const error = new Error("Account switching is in progress");
      error.code = "SWITCH_IN_PROGRESS";
      throw error;
    }
    if (reason === "explicit" && this.conversationBackupPromise && this.conversationBackupReason === "daily-idle") {
      try {
        await this.conversationBackupPromise;
      } catch {}
      return this.runConversationBackup(reason, options);
    }
    const listener = typeof options.onProgress === "function" ? options.onProgress : undefined;
    if (listener) {
      this.conversationBackupProgressListeners.add(listener);
      if (this.conversationBackupProgress) this.notifyConversationBackupProgressListener(listener, this.conversationBackupProgress);
    }
    if (!this.conversationBackupPromise) {
      const operation = this.runConversationBackupOnce(reason);
      this.conversationBackupPromise = operation;
      this.conversationBackupReason = reason;
      void operation.finally(() => {
        if (this.conversationBackupPromise === operation) {
          this.conversationBackupPromise = undefined;
          this.conversationBackupReason = undefined;
          this.conversationBackupProgress = undefined;
        }
      }).catch(() => {});
    }
    try {
      return await this.conversationBackupPromise;
    } finally {
      if (listener) this.conversationBackupProgressListeners.delete(listener);
    }
  }

  notifyConversationBackupProgress(value) {
    let progress;
    try {
      progress = normalizeConversationBackupProgress(value);
    } catch {
      return;
    }
    this.conversationBackupProgress = progress;
    for (const listener of this.conversationBackupProgressListeners) this.notifyConversationBackupProgressListener(listener, progress);
  }

  notifyConversationBackupProgressListener(listener, value) {
    try {
      listener(value);
    } catch {}
  }

  async runConversationBackupOnce(reason) {
    if (reason === "explicit" && this.countOfficialCodexProcesses() > 0) {
      const error = new Error("请完全关闭 ChatGPT Codex 后再创建完整恢复点。");
      error.code = "CODEX_RUNNING";
      throw error;
    }
    if (reason === "daily-idle") {
      if (await this.countCodexProcessesAsync() > 0) return { skipped: true, reason: "codex_running" };
      if (this.getCodexActivityStatus().isBusy) return { skipped: true, reason: "task_active" };
      if (this.getAutoSwitchState().pending) return { skipped: true, reason: "switch_queued" };
      const lastSuccess = this.readSettings().lastConversationIncrementalSucceededAtMs;
      if (lastSuccess && this.nowMs() - lastSuccess < CONVERSATION_BACKUP_INTERVAL_MS) {
        return { skipped: true, reason: "not_due" };
      }
    }
    const settings = this.readSettings();
    const mode = reason === "daily-idle" && settings.lastConversationFullVerificationSucceededAtMs &&
      this.nowMs() - settings.lastConversationFullVerificationSucceededAtMs < CONVERSATION_FULL_VERIFICATION_INTERVAL_MS
      ? "incremental"
      : "full";
    const checkpointStartedAt = this.nowMs();
    const checkpointId = crypto.randomBytes(32).toString("base64url");
    const critical = this.createCriticalCodexSnapshot({
      codexDir: this.codexDir,
      backupRoot: this.backupRoot,
      now: this.nowMs,
      checkpointId,
      checkpointStartedAt
    });
    const result = await this.createConversationBackup({
      codexDir: this.codexDir,
      backupRoot: this.backupRoot,
      now: this.nowMs,
      mode,
      checkpointId,
      checkpointStartedAt,
      onProgress: (value) => this.notifyConversationBackupProgress(value)
    });
    const point = critical?.manifest && result?.manifest
      ? this.createCompleteRecoveryPoint({
          backupRoot: this.backupRoot,
          checkpointId,
          checkpointStartedAt,
          critical,
          conversations: result
        })
      : undefined;
    this.writeSettings(normalizeSettings({
      ...settings,
      lastConversationBackupSucceededAtMs: this.nowMs(),
      lastConversationIncrementalSucceededAtMs: this.nowMs(),
      lastConversationFullVerificationSucceededAtMs: mode === "full"
        ? this.nowMs()
        : settings.lastConversationFullVerificationSucceededAtMs
    }));
    return { ...result, ...(point ? { recoveryPointId: point.recoveryPointId } : {}) };
  }

  listCodexRecoveryBackups(options = {}) {
    return this.listCodexRecoveryBackupsImpl({
      backupRoot: this.backupRoot,
      full: options.full !== false,
      ...(typeof options.onProgress === "function" ? { onProgress: options.onProgress } : {})
    });
  }

  async getCodexActivityStatusForThreads() {
    if (this.getCodexActivityStatusOverride) {
      const status = await this.getCodexActivityStatusOverride();
      this.rememberProtectedActiveThreadIds(status);
      return status;
    }
    const threadSidebarStateRevision = codexThreadSidebarStateRevision(this.codexDir);
    const nowMs = this.nowMs();
    if (this.taskActivityCache.size > 0) this.taskActivityIndexInitialized = true;
    if (!this.taskActivityIndexInitialized && !this.taskActivityIndexPromise) {
      void this.getThreadsOfficialProcessSnapshot(nowMs);
      this.startTaskActivityIndex({
        nowMs,
        liveThreadIds: [],
        officialHostState: "unknown"
      });
      const status = { ...taskActivityIndexingStatus(), threadSidebarStateRevision };
      this.rememberProtectedActiveThreadIds(status);
      return status;
    }
    const officialProcessSnapshot = await this.getThreadsOfficialProcessSnapshot(nowMs);
    const processInfo = officialProcessInfoResolver(officialProcessSnapshot);
    const processRegistry = activeChatProcesses(
      this.codexDir,
      this.isProcessAlive,
      processInfo,
      this.readCodexProcessRegistry,
      nowMs,
      this.activityWindowMs
    );
    const taskOptions = taskActivityOptions(processRegistry, officialProcessSnapshot, nowMs);
    let taskActivity;
    if (!this.taskActivityIndexInitialized) {
      this.startTaskActivityIndex(taskOptions);
      taskActivity = taskActivityIndexingStatus();
    } else {
      taskActivity = inspectCodexTaskActivity(this.codexDir, this.taskActivityCache, taskOptions);
    }
    const status = {
      ...getCodexActivityStatus({
        codexDir: this.codexDir,
        isProcessAlive: this.isProcessAlive,
        getProcessInfo: processInfo,
        nowMs,
        activityWindowMs: this.activityWindowMs,
        taskActivityCache: this.taskActivityCache,
        inspectOfficialProcesses: () => officialProcessSnapshot,
        readProcessRegistry: this.readCodexProcessRegistry,
        processRegistryOverride: processRegistry,
        taskActivityOverride: taskActivity,
        latestActivityOverride: taskActivity.activitySnapshot
      }),
      threadSidebarStateRevision
    };
    this.rememberProtectedActiveThreadIds(status);
    return status;
  }

  async getCodexActivityStatusForAutoSwitch() {
    let status = await this.getCodexActivityStatusForThreads();
    if (status?.activityIndexing && this.taskActivityIndexPromise) {
      await this.taskActivityIndexPromise;
      status = await this.getCodexActivityStatusForThreads();
    }
    return status;
  }

  getThreadsOfficialProcessSnapshot(nowMs) {
    if (this.threadsProcessSnapshot && nowMs - this.threadsProcessSnapshot.atMs < THREADS_PROCESS_SNAPSHOT_TTL_MS) {
      return Promise.resolve(this.threadsProcessSnapshot.value);
    }
    if (this.threadsProcessSnapshotPromise) return this.threadsProcessSnapshotPromise;
    const officialHostSnapshotRequestedAtMs = nowMs;
    const operation = Promise.resolve(this.inspectCodexProcessesForThreads())
      .then(normalizeOfficialProcessSnapshot)
      .catch(() => ({ count: 0, appServerCount: 0, inspected: false, processIds: [] }))
      .then((value) => {
        const snapshot = { ...value, officialHostSnapshotRequestedAtMs };
        this.threadsProcessSnapshot = { atMs: this.nowMs(), value: snapshot };
        return snapshot;
      });
    this.threadsProcessSnapshotPromise = operation.finally(() => {
      this.threadsProcessSnapshotPromise = undefined;
    });
    return this.threadsProcessSnapshotPromise;
  }

  startTaskActivityIndex(options) {
    if (this.taskActivityIndexInitialized || this.taskActivityIndexPromise || this.nowMs() < this.taskActivityIndexRetryAtMs) return;
    const operation = Promise.resolve(this.indexCodexTaskActivity({
      codexDir: this.codexDir,
      ...options
    })).then((result) => {
      this.taskActivityCache = restoreTaskActivityCache(result?.cacheEntries, this.codexDir);
      this.taskActivityIndexInitialized = true;
    }).catch(() => {
      this.taskActivityIndexRetryAtMs = this.nowMs() + TASK_ACTIVITY_INDEX_RETRY_MS;
    });
    this.taskActivityIndexPromise = operation.finally(() => {
      this.taskActivityIndexPromise = undefined;
    });
  }

  rememberProtectedActiveThreadIds(status) {
    const activeThreadIds = status?.taskActivity?.activeThreadIds;
    this.protectedActiveThreadIds = new Set(normalizeThreadIds(activeThreadIds));
  }

  revalidateQuarantinedConversationBackup(conversationId, options = {}) {
    if (typeof conversationId !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(conversationId)) {
      throw new Error("Invalid recovery generation ID");
    }
    return this.revalidateQuarantinedConversationBackupImpl({
      backupRoot: this.backupRoot,
      conversationId,
      ...(typeof options.onProgress === "function" ? { onProgress: options.onProgress } : {})
    });
  }

  async previewCodexRecoveryById(selection, options = {}) {
    assertRecoverySelection(selection, "Recovery preview");
    let preview;
    if (this.previewCodexRecoveryWorker) {
      preview = await this.previewCodexRecoveryWorker({
        backupRoot: this.backupRoot,
        selection,
        liveCodexDir: this.codexDir,
        onProgress: options.onProgress
      });
    } else {
      const sources = await this.resolveCodexRecoverySelection({ backupRoot: this.backupRoot, ...selection });
      preview = await this.previewCodexRecovery({
        ...sources,
        liveCodexDir: this.codexDir,
        ...(typeof options.onProgress === "function" ? { onProgress: options.onProgress } : {})
      });
    }
    return {
      backupTime: preview.backupTime,
      counts: {
        projects: preview.counts.projects,
        assignments: preview.counts.assignments,
        threads: preview.counts.threads,
        active: preview.counts.activeSessions,
        archived: preview.counts.archivedSessions
      },
      effects: { missing: preview.effects.missing, conflicts: preview.effects.conflicts }
    };
  }

  async prepareCodexReplacement(selection) {
    assertRecoverySelection(selection, "Replacement prepare");
    this.closeCodexProcesses();
    if (this.countCodexProcesses() > 0) {
      throw new Error("ChatGPT Codex 仍在运行，已取消替换恢复。");
    }
    let sources;
    let preview;
    let selectedBackupIdentity;
    let liveIdentity;
    if (this.prepareCodexReplacementWorker) {
      ({ sources, preview, selectedBackupIdentity, liveIdentity } = await this.prepareCodexReplacementWorker({
        backupRoot: this.backupRoot,
        liveCodexDir: this.codexDir,
        selection
      }));
    } else {
      sources = await this.resolveRecoverySelection(selection);
      preview = await this.previewCodexRecovery({ ...sources, liveCodexDir: this.codexDir });
      selectedBackupIdentity = await this.getRecoverySelectionIdentity(sources);
      liveIdentity = await this.getCodexStateIdentity();
    }
    if (preview?.valid !== true) throw new Error("A valid recovery preview is required");
    const snapshot = this.backupCriticalCodexState();
    if (!snapshot?.generationDir) throw new Error("A fresh validated pre-restore snapshot is required");
    const preRestoreSnapshotIdentity = this.getCriticalSnapshotIdentity(snapshot.generationDir);
    const currentLiveIdentity = this.getCodexStateIdentityWorker
      ? await this.getCodexStateIdentityWorker({ liveCodexDir: this.codexDir })
      : await this.getCodexStateIdentity();
    if (currentLiveIdentity !== liveIdentity) throw new Error("Live Codex state changed during replacement preparation");
    const confirmationToken = crypto.randomBytes(32).toString("base64url");
    const expiresAtMs = this.nowMs() + RESTORE_CONFIRMATION_TTL_MS;
    this.restoreConfirmations.set(confirmationToken, {
      ...selection,
      ...sources,
      selectedBackupIdentity,
      liveIdentity,
      preRestoreSnapshotDir: snapshot.generationDir,
      preRestoreSnapshotIdentity,
      expiresAtMs
    });
    return { confirmationToken, expiresAtMs };
  }

  async confirmCodexReplacement(request) {
    const keys = request && typeof request === "object" && !Array.isArray(request) ? Object.keys(request).sort() : [];
    const completePoint = keys.length === 2 && keys[0] === "confirmationToken" && keys[1] === "recoveryPointId";
    const independent = keys.length === 3 && keys[0] === "confirmationToken" && keys[1] === "conversationId" && keys[2] === "criticalId";
    if (!completePoint && !independent) {
      throw new Error("Replacement confirmation accepts only recovery generation IDs and a confirmation token");
    }
    const selection = completePoint
      ? { recoveryPointId: request.recoveryPointId }
      : { criticalId: request.criticalId, conversationId: request.conversationId };
    assertRecoverySelection(selection, "Replacement confirmation");
    const confirmation = this.restoreConfirmations.get(request.confirmationToken);
    if (!confirmation) throw new Error("Replacement confirmation token is invalid or already used");
    this.restoreConfirmations.delete(request.confirmationToken);
    if (this.nowMs() > confirmation.expiresAtMs) throw new Error("Replacement confirmation token expired");
    if (JSON.stringify(selection) !== JSON.stringify(Object.fromEntries(Object.keys(selection).map((key) => [key, confirmation[key]])))) {
      throw new Error("Replacement selection changed after preparation");
    }
    if (this.countCodexProcesses() > 0) throw new Error("ChatGPT Codex 仍在运行，已取消替换恢复。");
    const sources = await this.resolveRecoverySelection(selection);
    const selectedBackupIdentity = await this.getRecoverySelectionIdentity(sources);
    if (
      sources.criticalGenerationDir !== confirmation.criticalGenerationDir ||
      sources.conversationManifestPath !== confirmation.conversationManifestPath ||
      selectedBackupIdentity !== confirmation.selectedBackupIdentity ||
      await this.getCodexStateIdentity() !== confirmation.liveIdentity ||
      this.getCriticalSnapshotIdentity(confirmation.preRestoreSnapshotDir) !== confirmation.preRestoreSnapshotIdentity
    ) {
      throw new Error("Replacement context changed after preparation");
    }
    return this.restoreCodexBackup({
      authorization: { authorized: true, mode: "replace" },
      ...sources,
      liveCodexDir: this.codexDir,
      assertBeforeCommit: async () => {
        if (this.countCodexProcesses() > 0) throw new Error("ChatGPT Codex 仍在运行，已取消替换恢复。");
        if (await this.getCodexStateIdentity() !== confirmation.liveIdentity) {
          throw new Error("Live Codex state changed before replacement commit");
        }
      }
    });
  }

  resolveRecoverySelection(selection) {
    return selection.recoveryPointId
      ? this.resolveCompleteRecoveryPoint({ backupRoot: this.backupRoot, recoveryPointId: selection.recoveryPointId })
      : this.resolveCodexRecoverySelection({ backupRoot: this.backupRoot, ...selection });
  }

  syncCurrentAuth() {
    if (!fs.existsSync(this.codexAuthPath)) {
      return { synced: false };
    }

    let authJson;
    try {
      authJson = JSON.parse(fs.readFileSync(this.codexAuthPath, "utf8"));
    } catch {
      return { synced: false };
    }

    const summary = summarizeAuth(authJson);
    if (!summary.hasAccessToken && !summary.hasRefreshToken) {
      return { synced: false };
    }

    const store = this.readStore();
    const account = store.accounts.find((item) => item.accountId === summary.accountId);
    if (!account) {
      return { synced: false };
    }

    const fingerprint = authFingerprint(authJson);
    if (account.fingerprint === fingerprint) {
      this.recordActiveAccount(account.id, "auth_confirmed");
      return { synced: false, accountId: account.id };
    }

    account.encryptedAuth = protectString(JSON.stringify(authJson));
    account.fingerprint = fingerprint;
    account.emailMasked = summary.emailMasked;
    account.planType = summary.planType === "unknown" ? account.planType : summary.planType;
    account.usageError = undefined;
    account.status = "ready";
    account.updatedAt = unixNow();
    this.writeStore(store);
    this.recordActiveAccount(account.id, "auth_refreshed");
    return { synced: true, accountId: account.id };
  }

  async syncCurrentAuthAsync() {
    if (!fs.existsSync(this.codexAuthPath)) return { synced: false };
    let authJson;
    try {
      authJson = JSON.parse(fs.readFileSync(this.codexAuthPath, "utf8"));
    } catch {
      return { synced: false };
    }
    const summary = summarizeAuth(authJson);
    if (!summary.hasAccessToken && !summary.hasRefreshToken) return { synced: false };
    const store = this.readStore();
    const account = store.accounts.find((item) => item.accountId === summary.accountId);
    if (!account) return { synced: false };
    const fingerprint = authFingerprint(authJson);
    if (account.fingerprint === fingerprint) {
      this.recordActiveAccount(account.id, "auth_confirmed");
      return { synced: false, accountId: account.id };
    }
    account.encryptedAuth = await this.protectStringAsync(JSON.stringify(authJson));
    account.fingerprint = fingerprint;
    account.emailMasked = summary.emailMasked;
    account.planType = summary.planType === "unknown" ? account.planType : summary.planType;
    account.usageError = undefined;
    account.status = "ready";
    account.updatedAt = unixNow();
    this.writeStore(store);
    this.recordActiveAccount(account.id, "auth_refreshed");
    return { synced: true, accountId: account.id };
  }

  readSettings() {
    try {
      return normalizeSettings(readJsonIfExists(this.settingsPath, {}));
    } catch (error) {
      if (!this.restoreRecoverySnapshot()) throw error;
      return normalizeSettings(readJsonIfExists(this.settingsPath, {}));
    }
  }

  updateSettings(patch) {
    const current = this.readSettings();
    const next = normalizeSettings({
      autoSwitchEnabled: typeof patch?.autoSwitchEnabled === "boolean" ? patch.autoSwitchEnabled : current.autoSwitchEnabled,
      autoResumeAfterQuotaSwitch:
        typeof patch?.autoResumeAfterQuotaSwitch === "boolean"
          ? patch.autoResumeAfterQuotaSwitch
          : current.autoResumeAfterQuotaSwitch,
      requireSwitchConfirmation:
        typeof patch?.requireSwitchConfirmation === "boolean" ? patch.requireSwitchConfirmation : current.requireSwitchConfirmation,
      lowQuotaWarningEnabled:
        typeof patch?.lowQuotaWarningEnabled === "boolean" ? patch.lowQuotaWarningEnabled : current.lowQuotaWarningEnabled,
      lowQuotaThresholdPercent:
        Number.isFinite(patch?.lowQuotaThresholdPercent)
          ? Math.max(1, Math.min(50, Number(patch.lowQuotaThresholdPercent)))
          : current.lowQuotaThresholdPercent,
      uiLanguage: patch?.uiLanguage === "en" || patch?.uiLanguage === "zh-CN" ? patch.uiLanguage : current.uiLanguage,
      closeBehavior: isCloseBehavior(patch?.closeBehavior) ? patch.closeBehavior : current.closeBehavior,
      themeMode: isThemeMode(patch?.themeMode) ? patch.themeMode : current.themeMode,
      edgeWindowEnabled:
        typeof patch?.edgeWindowEnabled === "boolean" ? patch.edgeWindowEnabled : current.edgeWindowEnabled,
      edgeWindowDocked:
        typeof patch?.edgeWindowDocked === "boolean" ? patch.edgeWindowDocked : current.edgeWindowDocked,
      edgeWindowX: Number.isFinite(patch?.edgeWindowX) ? Math.round(patch.edgeWindowX) : current.edgeWindowX,
      edgeWindowDockSide:
        patch?.edgeWindowDockSide === "left" || patch?.edgeWindowDockSide === "right"
          ? patch.edgeWindowDockSide
          : current.edgeWindowDockSide,
      edgeWindowDisplayId:
        typeof patch?.edgeWindowDisplayId === "string" ? patch.edgeWindowDisplayId : current.edgeWindowDisplayId,
      edgeWindowY: Number.isFinite(patch?.edgeWindowY) ? Math.round(patch.edgeWindowY) : current.edgeWindowY,
      edgeWindowWidth: Number.isFinite(patch?.edgeWindowWidth) ? Math.max(1, Math.round(patch.edgeWindowWidth)) : current.edgeWindowWidth,
      edgeWindowHeight: Number.isFinite(patch?.edgeWindowHeight) ? Math.max(1, Math.round(patch.edgeWindowHeight)) : current.edgeWindowHeight,
      edgeWindowAutoHide:
        typeof patch?.edgeWindowAutoHide === "boolean" ? patch.edgeWindowAutoHide : current.edgeWindowAutoHide,
      edgeWindowPinned:
        typeof patch?.edgeWindowPinned === "boolean" ? patch.edgeWindowPinned : current.edgeWindowPinned,
      autoSwitchTargetMode: isAutoSwitchTargetMode(patch?.autoSwitchTargetMode)
        ? patch.autoSwitchTargetMode
        : current.autoSwitchTargetMode,
      manualAutoSwitchTargetAccountId:
        typeof patch?.manualAutoSwitchTargetAccountId === "string"
          ? patch.manualAutoSwitchTargetAccountId
          : current.manualAutoSwitchTargetAccountId,
      autoSwitchStayAccountId:
        typeof patch?.autoSwitchStayAccountId === "string"
          ? patch.autoSwitchStayAccountId
          : current.autoSwitchStayAccountId,
      autoSwitchExcludedAccountIds: Array.isArray(patch?.autoSwitchExcludedAccountIds)
        ? patch.autoSwitchExcludedAccountIds
        : current.autoSwitchExcludedAccountIds,
      httpOnlyModeEnabled: current.httpOnlyModeEnabled,
      disableGpuModeEnabled: current.disableGpuModeEnabled,
      accountListPanePercent:
        Number.isFinite(patch?.accountListPanePercent)
          ? Math.round(Math.max(28, Math.min(68, Number(patch.accountListPanePercent))))
          : current.accountListPanePercent,
      usageRefreshIntervalMinutes:
        Number.isFinite(patch?.usageRefreshIntervalMinutes)
          ? Math.round(Math.max(1, Math.min(60, Number(patch.usageRefreshIntervalMinutes))))
          : current.usageRefreshIntervalMinutes,
      lastConversationBackupSucceededAtMs: current.lastConversationBackupSucceededAtMs,
      lastConversationIncrementalSucceededAtMs: current.lastConversationIncrementalSucceededAtMs,
      lastConversationFullVerificationSucceededAtMs: current.lastConversationFullVerificationSucceededAtMs,
      edgeCompletedReadThreadIds: Array.isArray(patch?.edgeCompletedReadThreadIds)
        ? patch.edgeCompletedReadThreadIds
        : current.edgeCompletedReadThreadIds
    });
    this.writeSettings(next);
    return next;
  }

  setHttpOnlyMode(enabled) {
    const current = this.readSettings();
    const nextEnabled = Boolean(enabled);
    const currentFingerprint = this.currentAuthFingerprint();
    const currentAccount = currentFingerprint
      ? this.readStore().accounts.find((account) => account.fingerprint === currentFingerprint)
      : undefined;
    if (typeof currentAccount?.httpOnlyModeEnabled === "boolean") {
      const settings = current.httpOnlyModeEnabled === nextEnabled
        ? current
        : normalizeSettings({ ...current, httpOnlyModeEnabled: nextEnabled });
      if (settings !== current) this.writeSettings(settings);
      return {
        settings,
        closedCodexProcesses: 0,
        launchedCodex: false,
        migration: { changedRollouts: 0, changedThreads: 0 }
      };
    }
    if (current.httpOnlyModeEnabled === nextEnabled) {
      if (nextEnabled) {
        const baseProvider = readCodexBaseProvider(this.codexConfigPath);
        const closedCodexProcesses = this.closeCodexProcesses();
        try {
          const migration = migrateCodexHistoryProvider(this.codexDir, HTTP_ONLY_PROVIDER_ID, baseProvider, this.historyStorage);
          ensureCodexHttpOnlyMode(this.codexConfigPath);
          const launchedCodex = closedCodexProcesses > 0 ? this.launchCodexWithPreference() : false;
          return { settings: current, closedCodexProcesses, launchedCodex, migration };
        } catch (error) {
          if (closedCodexProcesses > 0) {
            this.launchCodexWithPreference();
          }
          throw error;
        }
      }
      return {
        settings: current,
        closedCodexProcesses: 0,
        launchedCodex: false,
        migration: { changedRollouts: 0, changedThreads: 0 }
      };
    }

    const baseProvider = readCodexBaseProvider(this.codexConfigPath);
    const closedCodexProcesses = this.closeCodexProcesses();
    try {
      let migration;
      if (nextEnabled) {
        migration = migrateCodexHistoryProvider(this.codexDir, HTTP_ONLY_PROVIDER_ID, baseProvider, this.historyStorage);
        try {
          setCodexHttpOnlyMode(this.codexConfigPath, true);
        } catch (error) {
          revertCodexHistoryProvider(this.codexDir, baseProvider, this.historyStorage);
          throw error;
        }
      } else {
        migration = revertCodexHistoryProvider(this.codexDir, baseProvider, this.historyStorage);
        try {
          setCodexHttpOnlyMode(this.codexConfigPath, false);
        } catch (error) {
          migrateCodexHistoryProvider(this.codexDir, HTTP_ONLY_PROVIDER_ID, baseProvider, this.historyStorage);
          throw error;
        }
      }

      const settings = normalizeSettings({ ...current, httpOnlyModeEnabled: nextEnabled });
      this.writeSettings(settings);
      const launchedCodex = closedCodexProcesses > 0 ? this.launchCodexWithPreference() : false;
      return { settings, closedCodexProcesses, launchedCodex, migration };
    } catch (error) {
      if (closedCodexProcesses > 0) {
        this.launchCodexWithPreference();
      }
      throw error;
    }
  }

  setAccountHttpOnlyMode(accountId, enabled) {
    this.syncCurrentAuth();
    const store = this.readStore();
    const account = this.findAccount(store, accountId);
    const previousHttpOnlyMode = account.httpOnlyModeEnabled;
    account.httpOnlyModeEnabled = Boolean(enabled);
    account.updatedAt = unixNow();
    this.writeStore(store);

    const currentFingerprint = this.currentAuthFingerprint();
    if (!currentFingerprint || account.fingerprint !== currentFingerprint) {
      return {
        account: this.publicAccount(account, currentFingerprint),
        closedCodexProcesses: 0,
        launchedCodex: false,
        migration: { changedRollouts: 0, changedThreads: 0 }
      };
    }

    let closedCodexProcesses = 0;
    try {
      closedCodexProcesses = this.closeCodexProcesses();
      const migration = this.applyTransportModeWithHistory(Boolean(enabled));
      const launchedCodex = closedCodexProcesses > 0 ? this.launchCodexWithPreference(account) : false;
      return {
        account: this.publicAccount(account, currentFingerprint),
        closedCodexProcesses,
        launchedCodex,
        migration
      };
    } catch (error) {
      const rollbackStore = this.readStore();
      const rollbackAccount = rollbackStore.accounts.find((item) => item.id === accountId);
      if (rollbackAccount) {
        if (typeof previousHttpOnlyMode === "boolean") {
          rollbackAccount.httpOnlyModeEnabled = previousHttpOnlyMode;
        } else {
          delete rollbackAccount.httpOnlyModeEnabled;
        }
        rollbackAccount.updatedAt = unixNow();
        this.writeStore(rollbackStore);
      }
      if (closedCodexProcesses > 0) {
        this.launchCodexWithPreference(rollbackAccount);
      }
      throw error;
    }
  }

  getDismissedCompletedThreadIds() {
    return this.readSettings().edgeCompletedReadThreadIds;
  }

  markCompletedThreadRead(threadId) {
    if (typeof threadId !== "string" || !threadId.trim()) {
      throw new Error("Invalid completed thread read marker");
    }
    const settings = this.readSettings();
    const edgeCompletedReadThreadIds = normalizeThreadIds([...settings.edgeCompletedReadThreadIds, threadId]);
    this.updateSettings({ edgeCompletedReadThreadIds });
    return { threadId: threadId.trim() };
  }

  getAutoResumeState() {
    return normalizeAutoResumeState(readJsonIfExists(this.autoResumeStatePath, {}));
  }

  getAutoResumeStatus() {
    const state = this.getAutoResumeState();
    return state.items
      ? summarizeAutoResumeQueue(state, this.nowMs())
      : summarizeAutoResumeTicket(state, this.nowMs());
  }

  writeAutoResumeState(state) {
    const next = normalizeAutoResumeState(state);
    return this.withAutoResumeStateClaimLock(
      () => this.writeAutoResumeStateUnlocked(next),
      this.getAutoResumeState()
    );
  }

  writeAutoResumeStateUnlocked(state) {
    const next = normalizeAutoResumeState(state);
    atomicWriteJson(this.autoResumeStatePath, next);
    return next;
  }

  withAutoResumeStateClaimLock(callback, fallback) {
    const lockPath = `${this.autoResumeStatePath}.lock`;
    const lockToken = crypto.randomUUID();
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    let handle;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        handle = fs.openSync(lockPath, "wx", 0o600);
        break;
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
        let stale = false;
        try {
          stale = Date.now() - fs.statSync(lockPath).mtimeMs > AUTO_RESUME_CLAIM_LOCK_TTL_MS;
        } catch {
          continue;
        }
        if (!stale) return fallback;
        const stalePath = `${lockPath}.stale-${process.pid}-${Date.now()}`;
        try {
          fs.renameSync(lockPath, stalePath);
          fs.rmSync(stalePath, { force: true });
        } catch {
          return fallback;
        }
      }
    }
    if (handle === undefined) return fallback;
    try {
      fs.writeFileSync(handle, JSON.stringify({ token: lockToken, pid: process.pid, createdAtMs: Date.now() }), "utf8");
      return callback();
    } finally {
      try {
        fs.closeSync(handle);
      } catch {}
      try {
        const currentLock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
        if (currentLock?.token === lockToken) fs.rmSync(lockPath, { force: true });
      } catch {}
    }
  }

  abandonInterruptedAutoResume() {
    return this.withAutoResumeStateClaimLock(() => {
      const current = this.getAutoResumeState();
      if (current.items) {
        const nowMs = this.nowMs();
        const resumeMethod = current.resumeMethod === AUTO_RESUME_DESKTOP_METHOD
          || (this.resumeExecutorMode === "desktop" && current.items.some(({ desktopPhase }) => Boolean(desktopPhase)))
          ? AUTO_RESUME_DESKTOP_METHOD
          : current.resumeMethod;
        const hasRecoverableItem = current.items.some((item) => ["launch_verified", "waiting_for_desktop"].includes(item.stage) && !autoResumeSubmissionMayHaveOccurred(item));
        const items = current.items.map((item) => resumeMethod === AUTO_RESUME_DESKTOP_METHOD && isObservedDesktopReceipt(item)
          ? restoreObservedDesktopReceipt(item)
          : ["launch_verified", "waiting_for_desktop"].includes(item.stage)
          ? autoResumeSubmissionMayHaveOccurred(item)
            ? { ...item, priorStage: item.stage, stage: "uncertain", updatedAtMs: nowMs }
            : { ...item, priorStage: item.stage, stage: "prepared", updatedAtMs: nowMs }
          : item.stage === "turn_started"
            ? { ...item, priorStage: "turn_started", stage: "uncertain" }
            : item);
        if (items.some((item, index) => item !== current.items[index])) {
          this.writeAutoResumeStateUnlocked({
            ...current,
            resumeMethod,
            items,
            updatedAtMs: hasRecoverableItem ? nowMs : current.updatedAtMs
          });
        }
        return;
      }
      if (["launch_verified", "waiting_for_desktop"].includes(current.stage)) {
        const resumeMethod = current.resumeMethod === AUTO_RESUME_DESKTOP_METHOD
          || (this.resumeExecutorMode === "desktop" && current.desktopPhase)
          ? AUTO_RESUME_DESKTOP_METHOD
          : current.resumeMethod;
        this.writeAutoResumeStateUnlocked({
          ...current,
          resumeMethod,
          priorStage: current.stage,
          stage: autoResumeSubmissionMayHaveOccurred(current) ? "uncertain" : "prepared",
          updatedAtMs: this.nowMs()
        });
      } else if (current.resumeMethod === AUTO_RESUME_DESKTOP_METHOD && isObservedDesktopReceipt(current)) {
        const restored = restoreObservedDesktopReceipt(current);
        if (restored !== current) this.writeAutoResumeStateUnlocked(restored);
      } else if (current.stage === "turn_started") {
        this.writeAutoResumeStateUnlocked({
          ...current,
          priorStage: "turn_started",
          stage: "uncertain"
        });
      }
    });
  }

  async resumeInterruptedAutoResume() {
    if (this.resumeExecutorMode !== "desktop") return { status: "skipped" };
    if (this.protocolResumePromise || this.manualResumePromise || this.autoResumeQueuePromise) return { status: "skipped" };
    const state = this.getAutoResumeState();
    const recoverable = state.resumeMethod === AUTO_RESUME_DESKTOP_METHOD && (state.items
      ? state.items.some((item) => item.stage === "prepared" && ["launch_verified", "waiting_for_desktop"].includes(item.priorStage))
      : state.stage === "prepared" && ["launch_verified", "waiting_for_desktop"].includes(state.priorStage));
    if (!recoverable) return { status: "skipped" };

    const failPrepared = (failureReason) => {
      if (state.items) {
        for (const item of state.items) {
          if (item.stage === "prepared") {
            this.finishAutoResumeQueueItem(state.attemptId, item.threadId, "failed", { failureReason });
          }
        }
        return summarizeAutoResumeQueue(this.getAutoResumeState());
      }
      return this.finishAutoResumeTicket(state.attemptId, "failed", { failureReason });
    };

    if (this.nowMs() - state.createdAtMs > AUTO_RESUME_SUPERSEDE_AFTER_MS) {
      const result = failPrepared("recovery_expired");
      this.writeAutoSwitchEvent("continuation_recovery_finished", { status: "failed", reason: "recovery_expired" });
      return result;
    }

    let desktopProcesses = 0;
    for (let attemptIndex = 0; ; attemptIndex += 1) {
      try { desktopProcesses = await this.countCodexDesktopProcessesAsync(); } catch { desktopProcesses = 0; }
      if (desktopProcesses > 0) break;
      const delayMs = Number(this.codexLaunchRetryDelaysMs[attemptIndex]);
      if (!Number.isFinite(delayMs)) {
        const result = failPrepared("desktop_unavailable");
        this.writeAutoSwitchEvent("continuation_recovery_finished", { status: "failed", reason: "desktop_unavailable" });
        return result;
      }
      this.writeAutoSwitchEvent("continuation_recovery_waiting", { attempt: attemptIndex + 1, delayMs: Math.max(0, delayMs) });
      await this.wait(Math.max(0, delayMs));
    }

    this.writeAutoSwitchEvent("continuation_recovery_started", {
      itemCount: state.items ? state.items.filter(({ stage }) => stage === "prepared").length : 1
    });
    if (state.items) return this.startPreparedAutoResumeQueue(state);
    const operation = this.startPreparedAutoResume(state);
    this.manualResumePromise = operation;
    try {
      return await operation;
    } finally {
      if (this.manualResumePromise === operation) this.manualResumePromise = undefined;
    }
  }

  prepareAutoResumeTicket(candidate) {
    const decision = normalizeAutoResumeDecision(candidate);
    const selectedCandidate = decision?.status === "selected" ? decision.candidate : undefined;
    const threadId = normalizeTicketText(selectedCandidate?.threadId);
    const interruptedAtMs = finiteTime(selectedCandidate?.interruptedAtMs);
    const reason = normalizeResumeReason(selectedCandidate?.reason);
    if (!threadId || !interruptedAtMs) return undefined;
    const current = this.getAutoResumeState();
    return this.withAutoResumeStateClaimLock(() => {
      const latest = this.getAutoResumeState();
      const sameInterruption = latest.threadId === threadId && latest.interruptedAtMs === interruptedAtMs;
      if (sameInterruption) {
        if (["prepared", "waiting_for_desktop"].includes(latest.stage)) return latest;
        if (latest.resumeMethod === AUTO_RESUME_DESKTOP_METHOD && latest.stage === "failed"
          && isUnsentForegroundFailure(latest, latest.failureReason)) {
          return this.writeAutoResumeStateUnlocked(resetRetainedPromptItem(latest, this.nowMs()));
        }
        if (latest.resumeMethod === AUTO_RESUME_DESKTOP_METHOD && isLegacyRetainedPromptNoEffect(latest)) {
          return this.writeAutoResumeStateUnlocked(resetRetainedPromptItem(latest, this.nowMs()));
        }
        if (
          latest.stage === "uncertain"
          && AUTO_RESUME_METHODS.has(latest.resumeMethod)
          && latest.priorStage === "prepared"
        ) {
          return this.writeAutoResumeStateUnlocked({
            ...latest,
            stage: "prepared",
            updatedAtMs: this.nowMs()
          });
        }
        if (
          latest.stage === "uncertain"
          && AUTO_RESUME_METHODS.has(latest.resumeMethod)
          && !latest.priorStage
          && !latest.turnId
          && this.hasSkippedLegacyResumeEvidence(latest)
        ) {
          return this.writeAutoResumeStateUnlocked({
            ...latest,
            priorStage: "prepared",
            stage: "prepared",
            updatedAtMs: this.nowMs()
          });
        }
        if (
          (latest.stage === "turn_started" && latest.turnId)
          || (latest.stage === "uncertain" && latest.turnId && latest.priorStage !== "prepared")
          || (latest.stage === "uncertain" && latest.priorStage === "turn_started")
        ) {
          return { status: "needs_attention", candidateCount: 1 };
        }
        return undefined;
      }
      if (hasActiveAutoResumeAttempt(latest)
        && !canSupersedeStaleAutoResumeAttempt(latest, decision, this.nowMs())) {
        return autoResumeConflictOutcome(decision, latest);
      }
      const nowMs = this.nowMs();
      return this.writeAutoResumeStateUnlocked({
        attemptId: crypto.randomUUID(),
        threadId,
        interruptedAtMs,
        reason,
        resumeMethod: this.autoResumeMethod,
        stage: "prepared",
        createdAtMs: nowMs,
        updatedAtMs: nowMs
      });
    }, hasActiveAutoResumeAttempt(current)
      && !canSupersedeStaleAutoResumeAttempt(current, decision, this.nowMs())
      ? autoResumeConflictOutcome(decision, current)
      : undefined);
  }

  prepareAutoResumeAttempt(decision) {
    const normalized = normalizeAutoResumeDecision(decision);
    if (normalized?.status !== "selected") return undefined;
    const preparedQueue = this.prepareAutoResumeQueue(normalized);
    return preparedQueue ?? this.prepareAutoResumeTicket(normalized);
  }

  prepareAutoResumeQueue(decision) {
    const normalized = normalizeAutoResumeDecision(decision);
    const candidates = autoResumeDecisionCandidates(normalized);
    if (!candidates.length) return undefined;
    const current = this.getAutoResumeState();
    return this.withAutoResumeStateClaimLock(() => {
      const latest = this.getAutoResumeState();
      if (candidates.length === 1 && !latest.items) return undefined;
      const sameQueue = latest.items?.length === candidates.length
        && latest.items.every((item, index) => item.threadId === candidates[index].threadId
          && item.interruptedAtMs === candidates[index].interruptedAtMs);
      if (sameQueue) {
        const nowMs = this.nowMs();
        let changed = false;
        const items = latest.items.map((item) => {
          if (latest.resumeMethod === AUTO_RESUME_DESKTOP_METHOD && item.stage === "failed"
            && isUnsentForegroundFailure(item, item.failureReason)) {
            changed = true;
            return resetRetainedPromptItem(item, nowMs);
          }
          if (latest.resumeMethod === AUTO_RESUME_DESKTOP_METHOD && isLegacyRetainedPromptNoEffect(item)) {
            changed = true;
            return resetRetainedPromptItem(item, nowMs);
          }
          if (item.stage !== "uncertain" || item.priorStage !== "prepared") return item;
          changed = true;
          return {
            ...item,
            stage: "prepared",
            updatedAtMs: nowMs
          };
        });
        return changed ? this.writeAutoResumeStateUnlocked({ ...latest, items, updatedAtMs: nowMs }) : latest;
      }
      if (isReusablePreparedAutoResumeQueue(latest, candidates)) return latest;
      if (hasActiveAutoResumeAttempt(latest)
        && !canSupersedeStaleAutoResumeAttempt(latest, normalized, this.nowMs())) {
        return autoResumeConflictOutcome(normalized, latest);
      }
      if (candidates.length < 2) return undefined;
      const nowMs = this.nowMs();
      return this.writeAutoResumeStateUnlocked({
        attemptId: crypto.randomUUID(),
        resumeMethod: this.autoResumeMethod,
        items: candidates.map((candidate) => ({
          threadId: candidate.threadId,
          interruptedAtMs: candidate.interruptedAtMs,
          reason: normalizeResumeReason(candidate.reason),
          stage: "prepared",
          updatedAtMs: nowMs
        })),
        createdAtMs: nowMs,
        updatedAtMs: nowMs
      });
    }, isReusablePreparedAutoResumeQueue(current, candidates)
      ? current
      : hasActiveAutoResumeAttempt(current)
        && !canSupersedeStaleAutoResumeAttempt(current, normalized, this.nowMs())
        ? autoResumeConflictOutcome(normalized, current)
        : undefined);
  }

  finishAutoResumeQueueItem(attemptId, threadId, stage, metadata = {}) {
    return this.withAutoResumeStateClaimLock(() => {
      const current = this.getAutoResumeState();
      if (!current.items || current.attemptId !== attemptId || !AUTO_RESUME_STAGES.has(stage)) return { status: "skipped" };
      const index = current.items.findIndex((item) => item.threadId === threadId);
      const item = current.items[index];
      if (!item || !AUTO_RESUME_TRANSITIONS[item.stage]?.has(stage)) return { status: "skipped" };
      const nowMs = this.nowMs();
      const turnId = stage === "turn_started" ? normalizeTicketText(metadata?.turnId) : undefined;
      const failureReason = ["failed", "uncertain", "waiting_for_desktop"].includes(stage)
        && AUTO_RESUME_FAILURE_REASONS.has(metadata?.failureReason)
        ? metadata.failureReason
        : undefined;
      const items = current.items.map((value, itemIndex) => itemIndex === index
        ? {
            ...value,
            ...(turnId ? { turnId } : {}),
            ...(failureReason ? { failureReason } : {}),
            stage,
            updatedAtMs: nowMs
          }
        : value);
      this.writeAutoResumeStateUnlocked({ ...current, items, updatedAtMs: nowMs });
      return { status: stage === "turn_started" ? "started" : stage };
    }, { status: "skipped" });
  }

  recordAutoResumeDesktopPhase(attemptId, threadId, phase) {
    if (!AUTO_RESUME_DESKTOP_PHASES.has(phase)) return { status: "skipped" };
    const result = this.withAutoResumeStateClaimLock(() => {
      const current = this.getAutoResumeState();
      if (!attemptId || current.attemptId !== attemptId) return { status: "skipped" };
      const submitInvoked = ["invoke_started", "invoke_no_effect", "fallback_invoke_started", "prompt_consumed"].includes(phase);
      const nowMs = this.nowMs();
      if (current.items) {
        const index = current.items.findIndex((item) => item.threadId === threadId);
        const item = current.items[index];
        if (!item || !["launch_verified", "waiting_for_desktop"].includes(item.stage)) return { status: "skipped" };
        const items = current.items.map((value, itemIndex) => {
          if (itemIndex !== index) return value;
          const next = {
            ...value,
            desktopPhase: phase,
            phaseStartedAtMs: nowMs,
            ...(phase === "invoke_started" || phase === "fallback_invoke_started"
              ? { submissionStartedAtMs: nowMs } : {}),
            submitInvoked: value.submitInvoked === true || submitInvoked,
            updatedAtMs: nowMs
          };
          const phaseDeadlineAtMs = autoResumePhaseDeadlineAtMs(phase, nowMs, value.phaseDeadlineAtMs);
          if (phaseDeadlineAtMs) next.phaseDeadlineAtMs = phaseDeadlineAtMs;
          else delete next.phaseDeadlineAtMs;
          return next;
        });
        this.writeAutoResumeStateUnlocked({ ...current, items, updatedAtMs: nowMs });
      } else {
        if (current.threadId !== threadId || !["launch_verified", "waiting_for_desktop"].includes(current.stage)) return { status: "skipped" };
        const next = {
          ...current,
          desktopPhase: phase,
          phaseStartedAtMs: nowMs,
          ...(phase === "invoke_started" || phase === "fallback_invoke_started"
            ? { submissionStartedAtMs: nowMs } : {}),
          submitInvoked: current.submitInvoked === true || submitInvoked,
          updatedAtMs: nowMs
        };
        const phaseDeadlineAtMs = autoResumePhaseDeadlineAtMs(phase, nowMs, current.phaseDeadlineAtMs);
        if (phaseDeadlineAtMs) next.phaseDeadlineAtMs = phaseDeadlineAtMs;
        else delete next.phaseDeadlineAtMs;
        this.writeAutoResumeStateUnlocked(next);
      }
      return { status: phase };
    }, { status: "skipped" });
    if (result.status === phase) this.writeAutoSwitchEvent("continuation_desktop_phase", { threadId, phase });
    return result;
  }

  async runDesktopContinuation(threadId, onPhase, readState, recoveredEvidenceStartedAtMs) {
    const evidenceStartedAtMs = finiteTime(recoveredEvidenceStartedAtMs) ?? this.nowMs();
    let currentOperation;
    let cancelled = false;
    const cancel = () => {
      cancelled = true;
      try { currentOperation?.cancel?.(); } catch {}
    };
    this.cancelActiveManualResume = cancel;
    try {
      for (let attemptIndex = 0; ; attemptIndex += 1) {
        let observed = false;
        let reason = "submission_error";
        try {
          currentOperation = undefined;
          currentOperation = this.openCodexThread(threadId, {
            onPhase, evidenceStartedAtMs,
            onDiagnostic: (details) => this.writeAutoSwitchEvent("continuation_desktop_discovery", {
              threadId, ...normalizeDesktopDiscoveryDiagnostics(details)
            })
          });
          observed = await currentOperation === true;
          reason = observed ? "turn_observed" : currentOperation?.failureReason ?? "turn_not_observed";
        } catch {
          reason = currentOperation?.failureReason ?? "submission_error";
        }
        const state = readState();
        const submitInvoked = state?.submitInvoked === true;
        const submitUncertain = autoResumeSubmissionMayHaveOccurred(state);
        const retryDelayMs = Number(this.autoResumeDesktopRetryDelaysMs[attemptIndex]);
        if (!observed && !submitUncertain && !cancelled
          && (["submission_timeout", "composer_not_found", "submit_not_found"].includes(reason)
            || isUnsentForegroundFailure(state, reason)) && Number.isFinite(retryDelayMs)) {
          this.writeAutoSwitchEvent("continuation_desktop_retry", {
            attempt: attemptIndex + 2,
            reason,
            lastPhase: state?.desktopPhase ?? "none",
            ...(currentOperation?.processOutcome ? { processOutcome: currentOperation.processOutcome } : {})
          });
          await this.wait(Math.max(0, retryDelayMs));
          continue;
        }
        return {
          observed,
          reason,
          submitInvoked,
          submitUncertain,
          lastPhase: state?.desktopPhase,
          processOutcome: currentOperation?.processOutcome
        };
      }
    } finally {
      if (this.cancelActiveManualResume === cancel) this.cancelActiveManualResume = undefined;
    }
  }

  failAutoResumeQueue(attemptId) {
    const current = this.getAutoResumeState();
    if (!current.items || current.attemptId !== attemptId) return { status: "skipped" };
    for (const item of current.items) {
      if (item.stage === "prepared") this.finishAutoResumeQueueItem(attemptId, item.threadId, "failed");
    }
    return summarizeAutoResumeQueue(this.getAutoResumeState());
  }

  async startPreparedAutoResumeQueue(queue) {
    if (this.autoResumeQueuePromise) {
      return skippedAutoResumeQueue(queue?.items?.length ?? 0);
    }
    const operation = this.runPreparedAutoResumeQueue(queue);
    this.autoResumeQueuePromise = operation;
    try {
      return await operation;
    } finally {
      if (this.autoResumeQueuePromise === operation) this.autoResumeQueuePromise = undefined;
    }
  }

  beginPreparedAutoResumeQueue(queue) {
    const pending = summarizeAutoResumeQueue(queue);
    const operation = this.startPreparedAutoResumeQueue(queue);
    void operation.catch(() => this.failAutoResumeQueue(queue?.attemptId));
    return pending;
  }

  async runPreparedAutoResumeQueue(queue) {
    if (!queue?.attemptId || !Array.isArray(queue.items)) return skippedAutoResumeQueue(0);
    for (const item of queue.items) {
      const claimed = this.finishAutoResumeQueueItem(queue.attemptId, item.threadId, "launch_verified");
      if (claimed.status !== "launch_verified") continue;
      try {
        const outcome = await this.runDesktopContinuation(
          item.threadId,
          (phase) => this.recordAutoResumeDesktopPhase(queue.attemptId, item.threadId, phase),
          () => this.getAutoResumeState().items?.find(({ threadId }) => threadId === item.threadId),
          item.priorStage ? item.phaseStartedAtMs : undefined
        );
        const stage = outcome.observed ? "turn_started" : outcome.submitUncertain ? "uncertain" : "failed";
        const reason = outcome.reason;
        const result = this.finishAutoResumeQueueItem(queue.attemptId, item.threadId, stage, { failureReason: reason });
        this.writeAutoSwitchEvent("continuation_queue_item_finished", {
          threadId: item.threadId,
          stage: result.status,
          reason,
          ...(outcome.lastPhase ? { lastPhase: outcome.lastPhase } : {}),
          ...(outcome.processOutcome ? { processOutcome: outcome.processOutcome } : {})
        });
      } catch {
        const currentItem = this.getAutoResumeState().items?.find(({ threadId }) => threadId === item.threadId);
        const stage = autoResumeSubmissionMayHaveOccurred(currentItem) ? "uncertain" : "failed";
        const result = this.finishAutoResumeQueueItem(queue.attemptId, item.threadId, stage, { failureReason: "submission_error" });
        this.writeAutoSwitchEvent("continuation_queue_item_finished", {
          threadId: item.threadId,
          stage: result.status,
          reason: "submission_error"
        });
      }
    }
    const current = this.getAutoResumeState();
    return current.attemptId === queue.attemptId
      ? summarizeAutoResumeQueue(current)
      : skippedAutoResumeQueue(queue.items.length);
  }

  finishAutoResumeTicket(attemptId, stage, metadata = {}) {
    return this.withAutoResumeStateClaimLock(() => {
      const current = this.getAutoResumeState();
      const allowedStages = AUTO_RESUME_TRANSITIONS[current.stage];
      if (!attemptId || current.attemptId !== attemptId || !AUTO_RESUME_STAGES.has(stage) || !allowedStages?.has(stage)) {
        return { status: "skipped" };
      }
      const turnId = stage === "turn_started" ? normalizeTicketText(metadata?.turnId) : undefined;
      const failureReason = ["failed", "uncertain", "waiting_for_desktop"].includes(stage)
        && AUTO_RESUME_FAILURE_REASONS.has(metadata?.failureReason)
        ? metadata.failureReason
        : undefined;
      this.writeAutoResumeStateUnlocked({
        ...current,
        ...(turnId ? { turnId } : {}),
        ...(failureReason ? { failureReason } : {}),
        stage,
        updatedAtMs: this.nowMs()
      });
      return { status: stage === "turn_started" ? "started" : stage };
    }, { status: "skipped" });
  }

  async startPreparedAutoResume(ticket) {
    const launchVerified = this.finishAutoResumeTicket(ticket.attemptId, "launch_verified");
    if (launchVerified.status !== "launch_verified") return launchVerified;
    try {
      const outcome = await this.runDesktopContinuation(
        ticket.threadId,
        (phase) => this.recordAutoResumeDesktopPhase(ticket.attemptId, ticket.threadId, phase),
        () => this.getAutoResumeState(),
        ticket.priorStage ? ticket.phaseStartedAtMs : undefined
      );
      const stage = outcome.observed ? "turn_started" : outcome.submitUncertain ? "uncertain" : "failed";
      const result = this.finishAutoResumeTicket(ticket.attemptId, stage, { failureReason: outcome.reason });
      this.writeAutoSwitchEvent("continuation_ticket_finished", {
        threadId: ticket.threadId,
        stage: result.status,
        reason: outcome.reason,
        ...(outcome.lastPhase ? { lastPhase: outcome.lastPhase } : {}),
        ...(outcome.processOutcome ? { processOutcome: outcome.processOutcome } : {})
      });
      return result;
    } catch {
      const stage = autoResumeSubmissionMayHaveOccurred(this.getAutoResumeState()) ? "uncertain" : "failed";
      const result = this.finishAutoResumeTicket(ticket.attemptId, stage, { failureReason: "submission_error" });
      this.writeAutoSwitchEvent("continuation_ticket_finished", { threadId: ticket.threadId, stage: result.status, reason: "submission_error" });
      return result;
    }
  }

  async runProtocolResumeTicket(ticket) {
    const claimed = this.finishAutoResumeTicket(ticket?.attemptId, "launch_verified");
    if (claimed.status !== "launch_verified") return { status: "skipped" };
    let operation;
    try {
      operation = this.startCodexThreadResume({
        threadId: ticket.threadId,
        codexDir: this.codexDir,
        continuationText: AUTO_RESUME_PROMPT
      });
      const started = await operation.started;
      if (started?.started !== true) {
        const terminal = protocolStartFailureStage(started);
        this.finishAutoResumeTicket(ticket.attemptId, terminal);
        return { status: terminal };
      }
      const turnId = normalizeTicketText(started.turnId);
      if (!turnId) {
        this.finishAutoResumeTicket(ticket.attemptId, "failed");
        return { status: "failed" };
      }
      this.finishAutoResumeTicket(ticket.attemptId, "turn_started", { turnId });
      const completed = await operation.completion;
      const terminal = completed?.status === "completed" ? "completed" : completed?.status === "uncertain" ? "uncertain" : "failed";
      this.finishAutoResumeTicket(ticket.attemptId, terminal);
      return { status: terminal, completionStatus: terminal, turnId };
    } catch {
      this.finishAutoResumeTicket(ticket.attemptId, "failed");
      return { status: "failed" };
    }
  }

  async beginProtocolResumeTicket(ticket) {
    const claimed = this.finishAutoResumeTicket(ticket?.attemptId, "launch_verified");
    if (claimed.status !== "launch_verified") return { status: "skipped" };
    let operation;
    try {
      operation = this.startCodexThreadResume({
        threadId: ticket.threadId,
        codexDir: this.codexDir,
        continuationText: AUTO_RESUME_PROMPT
      });
      const started = await operation.started;
      const turnId = normalizeTicketText(started?.turnId);
      if (started?.started !== true || !turnId) {
        const terminal = protocolStartFailureStage(started);
        this.finishAutoResumeTicket(ticket.attemptId, terminal);
        if (await this.waitForProtocolProcessClose(operation.closed)) {
          await this.verifyPrioritizedCodexLaunch({ forceRendererAccessibility: false });
        }
        return { status: terminal };
      }
      this.finishAutoResumeTicket(ticket.attemptId, "turn_started", { turnId });
      this.cancelActiveProtocolResume = operation.cancel;
      const background = this.finishProtocolResumeInBackground({
        completion: operation.completion,
        closed: operation.closed,
        finish: (terminal) => this.finishAutoResumeTicket(ticket.attemptId, terminal)
      });
      this.protocolResumePromise = background;
      void background.finally(() => {
        if (this.protocolResumePromise === background) this.protocolResumePromise = undefined;
        if (this.cancelActiveProtocolResume === operation.cancel) this.cancelActiveProtocolResume = undefined;
      }).catch(() => {});
      return { status: "started", turnId };
    } catch {
      this.finishAutoResumeTicket(ticket?.attemptId, "failed");
      if (!operation || await this.waitForProtocolProcessClose(operation.closed)) {
        await this.verifyPrioritizedCodexLaunch({ forceRendererAccessibility: false });
      }
      return { status: "failed" };
    }
  }

  async finishProtocolResumeInBackground({ completion, closed, finish }) {
    const stopOwnershipMonitor = this.startProtocolOwnershipMonitor();
    let terminal = "failed";
    try {
      const completed = await completion;
      terminal = completed?.status === "completed" ? "completed" : completed?.status === "uncertain" ? "uncertain" : "failed";
    } catch {
    } finally {
      stopOwnershipMonitor();
    }
    finish(terminal);
    const protocolClosed = await this.waitForProtocolProcessClose(closed);
    const launch = protocolClosed
      ? await this.verifyPrioritizedCodexLaunch({ forceRendererAccessibility: false })
      : { launchedCodex: false, verifiedCodexLaunch: false };
    this.writeAutoSwitchEvent("continuation_finished", {
      completionStatus: terminal,
      verifiedCodexLaunch: launch.verifiedCodexLaunch === true
    });
    return { status: terminal, ...launch };
  }

  startProtocolOwnershipMonitor() {
    let checking = false;
    let recorded = false;
    const inspect = async () => {
      if (checking || recorded) return;
      checking = true;
      try {
        if (await this.countCodexDesktopProcessesAsync() > 0) {
          recorded = true;
          this.writeAutoSwitchEvent("continuation_ownership_conflict", {
            reason: "codex_desktop_opened_during_switcher_app_server_continuation"
          });
          this.cancelActiveProtocolResume?.();
        }
      } catch {
      } finally {
        checking = false;
      }
    };
    const timer = this.setInterval(inspect, 2_000);
    timer?.unref?.();
    return () => this.clearInterval(timer);
  }

  async waitForProtocolProcessClose(closed) {
    if (!closed || typeof closed.then !== "function") return true;
    let timer;
    try {
      return await Promise.race([
        Promise.resolve(closed).then(() => true, () => false),
        new Promise((resolve) => { timer = this.setTimeout(() => resolve(false), PROTOCOL_PROCESS_CLOSE_WAIT_MS); })
      ]);
    } finally {
      if (timer !== undefined) this.clearTimeout(timer);
    }
  }

  async beginProtocolResumeQueue(queue) {
    if (!queue?.attemptId || !Array.isArray(queue.items)) return skippedAutoResumeQueue(0);
    let resolveStarted;
    let startedSettled = false;
    const firstStarted = new Promise((resolve) => { resolveStarted = resolve; });
    const operation = this.runProtocolResumeQueue(queue, (turnId) => {
      if (startedSettled) return;
      startedSettled = true;
      resolveStarted({ ...summarizeAutoResumeQueue(this.getAutoResumeState()), firstTurnId: turnId });
    });
    const background = (async () => {
      const stopOwnershipMonitor = this.startProtocolOwnershipMonitor();
      let result;
      try {
        result = await operation;
        if (!startedSettled) {
          startedSettled = true;
          resolveStarted(result);
        }
      } finally {
        stopOwnershipMonitor();
      }
      const launch = result.protocolClosed === false
        ? { launchedCodex: false, verifiedCodexLaunch: false }
        : await this.verifyPrioritizedCodexLaunch({ forceRendererAccessibility: false });
      this.writeAutoSwitchEvent("continuation_finished", {
        completionStatus: result.status,
        verifiedCodexLaunch: launch.verifiedCodexLaunch === true
      });
      return { ...result, ...launch };
    })();
    this.protocolResumePromise = background;
    void background.finally(() => {
      if (this.protocolResumePromise === background) this.protocolResumePromise = undefined;
    }).catch(() => {});
    return firstStarted;
  }

  async runProtocolResumeQueue(queue, onStarted) {
    if (!queue?.attemptId || !Array.isArray(queue.items)) return skippedAutoResumeQueue(0);
    let protocolClosed = true;
    for (const item of queue.items) {
      const claimed = this.finishAutoResumeQueueItem(queue.attemptId, item.threadId, "launch_verified");
      if (claimed.status !== "launch_verified") continue;
      let operation;
      try {
        operation = this.startCodexThreadResume({ threadId: item.threadId, codexDir: this.codexDir, continuationText: AUTO_RESUME_PROMPT });
        this.cancelActiveProtocolResume = operation.cancel;
        const started = await operation.started;
        if (started?.started !== true) {
          this.finishAutoResumeQueueItem(queue.attemptId, item.threadId, protocolStartFailureStage(started));
          continue;
        }
        const turnId = normalizeTicketText(started.turnId);
        if (!turnId) {
          this.finishAutoResumeQueueItem(queue.attemptId, item.threadId, "failed");
          continue;
        }
        this.finishAutoResumeQueueItem(queue.attemptId, item.threadId, "turn_started", { turnId });
        onStarted?.(turnId);
        const completed = await operation.completion;
        this.finishAutoResumeQueueItem(queue.attemptId, item.threadId, completed?.status === "completed" ? "completed" : completed?.status === "uncertain" ? "uncertain" : "failed");
      } catch {
        this.finishAutoResumeQueueItem(queue.attemptId, item.threadId, "failed");
      } finally {
        if (this.cancelActiveProtocolResume === operation?.cancel) this.cancelActiveProtocolResume = undefined;
        if (!await this.waitForProtocolProcessClose(operation?.closed)) {
          protocolClosed = false;
          this.failAutoResumeQueue(queue.attemptId);
          break;
        }
      }
    }
    return { ...summarizeAutoResumeQueue(this.getAutoResumeState()), protocolClosed };
  }

  setAccountRemark(accountId, remark) {
    this.syncCurrentAuth();
    const store = this.readStore();
    const account = this.findAccount(store, accountId);
    const normalizedRemark = normalizeAccountRemark(remark);
    if (normalizedRemark) {
      account.encryptedRemark = protectString(normalizedRemark);
    } else {
      delete account.encryptedRemark;
    }
    account.updatedAt = unixNow();
    this.writeStore(store);
    return this.publicAccount(account, this.currentAuthFingerprint());
  }

  ensurePreferredTransport(account) {
    const enabled = this.resolveHttpOnlyMode(account);
    try {
      this.applyTransportMode(enabled);
      return undefined;
    } catch (error) {
      return redactError(error);
    }
  }

  resolveHttpOnlyMode(account) {
    if (typeof account?.httpOnlyModeEnabled === "boolean") {
      return account.httpOnlyModeEnabled;
    }
    return this.readSettings().httpOnlyModeEnabled;
  }

  setDisableGpuMode(enabled) {
    const current = this.readSettings();
    const nextEnabled = Boolean(enabled);
    if (current.disableGpuModeEnabled === nextEnabled) {
      return { settings: current, closedCodexProcesses: 0, launchedCodex: false };
    }
    const currentAccount = this.currentStoredAccount();
    const previousEffective = this.resolveDisableGpuMode(currentAccount);
    const nextSettings = normalizeSettings({ ...current, disableGpuModeEnabled: nextEnabled });
    const nextEffective = typeof currentAccount?.disableGpuModeEnabled === "boolean"
      ? currentAccount.disableGpuModeEnabled
      : nextEnabled;
    if (previousEffective === nextEffective) {
      this.writeSettings(nextSettings);
      return { settings: nextSettings, closedCodexProcesses: 0, launchedCodex: false };
    }

    let closedCodexProcesses = 0;
    try {
      closedCodexProcesses = this.closeCodexProcesses();
      this.writeSettings(nextSettings);
      const launchedCodex = closedCodexProcesses > 0
        ? this.launchCodex({ disableGpu: nextEffective })
        : false;
      if (closedCodexProcesses > 0 && !launchedCodex) {
        throw new Error("无法按新的 GPU 设置重新启动 Codex。");
      }
      return { settings: nextSettings, closedCodexProcesses, launchedCodex };
    } catch (error) {
      this.writeSettings(current);
      if (closedCodexProcesses > 0) this.launchCodex({ disableGpu: previousEffective });
      throw error;
    }
  }

  setAccountDisableGpuMode(accountId, enabled) {
    this.syncCurrentAuth();
    const store = this.readStore();
    const account = this.findAccount(store, accountId);
    const previousValue = account.disableGpuModeEnabled;
    const currentFingerprint = this.currentAuthFingerprint();
    const isCurrent = Boolean(currentFingerprint && account.fingerprint === currentFingerprint);
    if (!isCurrent) {
      account.disableGpuModeEnabled = Boolean(enabled);
      account.updatedAt = unixNow();
      this.writeStore(store);
      return {
        account: this.publicAccount(account, currentFingerprint),
        closedCodexProcesses: 0,
        launchedCodex: false
      };
    }

    let closedCodexProcesses = 0;
    try {
      closedCodexProcesses = this.closeCodexProcesses();
      account.disableGpuModeEnabled = Boolean(enabled);
      account.updatedAt = unixNow();
      this.writeStore(store);
      const launchedCodex = closedCodexProcesses > 0
        ? this.launchCodex({ disableGpu: Boolean(enabled) })
        : false;
      if (closedCodexProcesses > 0 && !launchedCodex) {
        throw new Error("无法按新的 GPU 设置重新启动 Codex。");
      }
      return {
        account: this.publicAccount(account, currentFingerprint),
        closedCodexProcesses,
        launchedCodex
      };
    } catch (error) {
      const rollbackStore = this.readStore();
      const rollbackAccount = rollbackStore.accounts.find((item) => item.id === accountId);
      if (rollbackAccount) {
        if (typeof previousValue === "boolean") {
          rollbackAccount.disableGpuModeEnabled = previousValue;
        } else {
          delete rollbackAccount.disableGpuModeEnabled;
        }
        rollbackAccount.updatedAt = unixNow();
        this.writeStore(rollbackStore);
      }
      if (closedCodexProcesses > 0) {
        this.launchCodex({ disableGpu: this.resolveDisableGpuMode(rollbackAccount) });
      }
      throw error;
    }
  }

  resolveDisableGpuMode(account) {
    if (typeof account?.disableGpuModeEnabled === "boolean") {
      return account.disableGpuModeEnabled;
    }
    return this.readSettings().disableGpuModeEnabled;
  }

  currentStoredAccount() {
    const fingerprint = this.currentAuthFingerprint();
    return fingerprint ? this.readStore().accounts.find((account) => account.fingerprint === fingerprint) : undefined;
  }

  launchCodexWithPreference(account = this.currentStoredAccount(), options = {}) {
    return this.launchCodex({
      disableGpu: this.resolveDisableGpuMode(account),
      ...(options.forceRendererAccessibility === true ? { forceRendererAccessibility: true } : {})
    });
  }

  syncDshCodexAuthAfterSwitch() {
    if (!this.dshAuthSyncManaged) {
      try {
        const result = this.syncDshCodexAuth(this.dshAuthSyncRequest);
        return result && typeof result === "object" && typeof result.status === "string" ? result : { status: "synced" };
      } catch {
        return { status: "failed", retryable: true };
      }
    }
    this.cancelDshAuthSyncRetry();
    return this.runDshAuthSyncAttempt(1);
  }

  async syncDshCodexAuthAfterSwitchAsync() {
    if (!this.dshAuthSyncManaged) {
      try {
        const result = await this.syncDshCodexAuthAsync(this.dshAuthSyncRequest);
        return result && typeof result === "object" && typeof result.status === "string" ? result : { status: "synced" };
      } catch {
        return { status: "failed", retryable: true };
      }
    }
    this.cancelDshAuthSyncRetry();
    return this.runDshAuthSyncAttemptAsync(1);
  }

  inspectDshCodexAuthOnStartup() {
    if (this.dshAuthSyncState.status !== "unknown" && !this.dshAuthSyncHasDrift()) return this.getDshAuthSyncState();
    return this.runDshAuthSyncAttempt(1);
  }

  inspectDshCodexAuthOnStartupAsync() {
    if (this.dshAuthSyncState.status !== "unknown" && !this.dshAuthSyncHasDrift()) {
      return Promise.resolve(this.getDshAuthSyncState());
    }
    if (this.dshAuthSyncAttemptPromise) return this.dshAuthSyncAttemptPromise;
    const attempt = this.runDshAuthSyncAttemptAsync(1);
    const tracked = attempt.finally(() => {
      if (this.dshAuthSyncAttemptPromise === tracked) this.dshAuthSyncAttemptPromise = undefined;
    });
    this.dshAuthSyncAttemptPromise = tracked;
    return tracked;
  }

  dshAuthSyncHasDrift() {
    const sourceHash = sha256RegularFile(this.dshAuthSyncRequest.sourceAuthPath);
    const targetHash = sha256RegularFile(path.join(this.dshAuthSyncRequest.targetDirectory, "auth.json"));
    return Boolean(sourceHash && sourceHash !== targetHash);
  }

  getDshAuthSyncState() {
    if (this.dshAuthSyncStartupEnabled && this.dshAuthSyncState.status === "unknown") {
      void this.inspectDshCodexAuthOnStartupAsync().catch(() => {});
    }
    return { ...this.dshAuthSyncState };
  }

  runDshAuthSyncAttempt(attempt, expectedSourceHash) {
    if (!this.dshAuthSyncUsesDefaultCodexHome) {
      return this.setDshAuthSyncState({ status: "skipped", reason: "non_default_codex_home", unresolvedDrift: false });
    }
    const request = this.dshAuthSyncRequest;
    const targetAuthPath = path.join(request.targetDirectory, "auth.json");
    if (!isRegularFilePath(request.scriptPath)) {
      return this.setDshAuthSyncState({ status: "failed", reason: "script_missing", unresolvedDrift: true });
    }
    if (!isDirectoryPath(request.targetDirectory)) {
      return this.setDshAuthSyncState({ status: "failed", reason: "target_missing", unresolvedDrift: true });
    }
    const sourceHash = sha256RegularFile(request.sourceAuthPath);
    if (!sourceHash) {
      return this.setDshAuthSyncState({ status: "failed", reason: "source_missing", unresolvedDrift: true });
    }
    if (expectedSourceHash && expectedSourceHash !== sourceHash) attempt = 1;
    const targetHash = sha256RegularFile(targetAuthPath);
    if (targetHash === sourceHash) {
      this.cancelDshAuthSyncRetry();
      return this.setDshAuthSyncState({ status: attempt > 1 ? "synced" : "in_sync", attempts: attempt, unresolvedDrift: false });
    }

    let result;
    try {
      result = this.syncDshCodexAuth(request);
    } catch {
      result = { status: "failed", reason: "process_error", retryable: true };
    }
    const safeResult = normalizeDshAuthSyncResult(result);
    const verifiedTargetHash = sha256RegularFile(targetAuthPath);
    if (["synced", "in_sync"].includes(safeResult.status) && verifiedTargetHash === sourceHash) {
      this.cancelDshAuthSyncRetry();
      return this.setDshAuthSyncState({ status: safeResult.status, attempts: attempt, unresolvedDrift: false });
    }
    const reason = safeResult.status === "synced" || safeResult.status === "in_sync"
      ? "hash_mismatch"
      : safeResult.reason;
    if (safeResult.retryable === true && ["busy", "timeout", "process_error"].includes(reason)) {
      return this.scheduleDshAuthSyncRetry(sourceHash, attempt, reason);
    }
    return this.setDshAuthSyncState({ status: "failed", reason, attempts: attempt, unresolvedDrift: true });
  }

  async runDshAuthSyncAttemptAsync(attempt, expectedSourceHash) {
    if (!this.dshAuthSyncUsesDefaultCodexHome) {
      return this.setDshAuthSyncState({ status: "skipped", reason: "non_default_codex_home", unresolvedDrift: false });
    }
    const request = this.dshAuthSyncRequest;
    const targetAuthPath = path.join(request.targetDirectory, "auth.json");
    if (!isRegularFilePath(request.scriptPath)) {
      return this.setDshAuthSyncState({ status: "failed", reason: "script_missing", unresolvedDrift: true });
    }
    if (!isDirectoryPath(request.targetDirectory)) {
      return this.setDshAuthSyncState({ status: "failed", reason: "target_missing", unresolvedDrift: true });
    }
    const sourceHash = sha256RegularFile(request.sourceAuthPath);
    if (!sourceHash) return this.setDshAuthSyncState({ status: "failed", reason: "source_missing", unresolvedDrift: true });
    if (expectedSourceHash && expectedSourceHash !== sourceHash) attempt = 1;
    const targetHash = sha256RegularFile(targetAuthPath);
    if (targetHash === sourceHash) {
      this.cancelDshAuthSyncRetry();
      return this.setDshAuthSyncState({ status: attempt > 1 ? "synced" : "in_sync", attempts: attempt, unresolvedDrift: false });
    }
    let result;
    try {
      result = await this.syncDshCodexAuthAsync(request);
    } catch {
      result = { status: "failed", reason: "process_error", retryable: true };
    }
    const safeResult = normalizeDshAuthSyncResult(result);
    const verifiedTargetHash = sha256RegularFile(targetAuthPath);
    if (["synced", "in_sync"].includes(safeResult.status) && verifiedTargetHash === sourceHash) {
      this.cancelDshAuthSyncRetry();
      return this.setDshAuthSyncState({ status: safeResult.status, attempts: attempt, unresolvedDrift: false });
    }
    const reason = safeResult.status === "synced" || safeResult.status === "in_sync" ? "hash_mismatch" : safeResult.reason;
    if (safeResult.retryable === true && ["busy", "timeout", "process_error"].includes(reason)) {
      return this.scheduleDshAuthSyncRetry(sourceHash, attempt, reason, this.runDshAuthSyncAttemptAsync.bind(this));
    }
    return this.setDshAuthSyncState({ status: "failed", reason, attempts: attempt, unresolvedDrift: true });
  }

  scheduleDshAuthSyncRetry(sourceHash, attempt, reason, runAttempt = this.runDshAuthSyncAttempt.bind(this)) {
    // A busy DSH is an expected transient while a subagent drains. Keep it
    // pending and retry at the normal background poll cadence even after the
    // short retry backoff is exhausted; otherwise a long-running task leaves
    // a stale auth copy that looks like a login failure.
    const configuredDelayMs = this.dshAuthSyncRetryDelaysMs[attempt - 1];
    const delayMs = reason === "busy" && !Number.isFinite(configuredDelayMs)
      ? this.dshAuthSyncPollIntervalMs
      : configuredDelayMs;
    if (!Number.isFinite(delayMs)) {
      return this.setDshAuthSyncState({ status: "failed", reason, attempts: attempt, unresolvedDrift: true });
    }
    this.cancelDshAuthSyncRetry();
    const state = this.setDshAuthSyncState({
      status: reason === "busy" ? "pending_busy" : "pending_retry",
      reason,
      attempts: attempt,
      nextRetryAtMs: this.nowMs() + delayMs,
      unresolvedDrift: true
    });
    this.dshAuthSyncTimer = this.setTimeout(() => {
      this.dshAuthSyncTimer = undefined;
      void Promise.resolve(runAttempt(attempt + 1, sourceHash)).catch(() => {});
    }, delayMs);
    this.dshAuthSyncTimer?.unref?.();
    return state;
  }

  cancelDshAuthSyncRetry() {
    if (this.dshAuthSyncTimer !== undefined) this.clearTimeout(this.dshAuthSyncTimer);
    this.dshAuthSyncTimer = undefined;
  }

  disposeDshAuthSync() {
    this.cancelDshAuthSyncRetry();
    if (this.dshAuthSyncPollTimer !== undefined) this.clearInterval(this.dshAuthSyncPollTimer);
    this.dshAuthSyncPollTimer = undefined;
    if (this.dshAuthSyncFileWatcher) fs.unwatchFile(this.codexAuthPath);
    this.dshAuthSyncFileWatcher = false;
  }

  setDshAuthSyncState(state) {
    this.dshAuthSyncState = { ...state };
    return { ...this.dshAuthSyncState };
  }

  captureStableCodexThreadState() {
    let first;
    let second;
    try {
      first = this.getCodexThreadIntegritySnapshot();
      second = this.getCodexThreadIntegritySnapshot();
    } catch {
      throw new Error("本地对话状态无法读取，已取消账号切换，认证未更改。");
    }
    if (!first?.revision || first.revision !== second?.revision) {
      throw new Error("本地对话状态无法稳定读取，已取消账号切换，认证未更改。");
    }
    return second;
  }

  async captureStableCodexThreadStateAsync() {
    try {
      return await this.captureStableCodexThreadStateAsyncImpl();
    } catch (error) {
      if (error?.code === "CODEX_THREAD_STATE_UNSTABLE") {
        throw new Error("本地对话状态无法稳定读取，已取消账号切换，认证未更改。");
      }
      throw new Error("本地对话状态无法读取，已取消账号切换，认证未更改。");
    }
  }

  assertCodexThreadProjectionHealthy() {
    let health;
    try {
      health = this.getCodexThreadProjectionHealth();
    } catch {
      throw projectionBlockError(
        "codex_thread_projection_unavailable",
        { status: "unavailable", counts: {} },
        "本地 Codex 对话投影状态无法安全校验，已取消账号切换；当前认证、配置和 Codex 进程均未更改。"
      );
    }
    if (health?.healthy !== true || !["healthy", "not_applicable"].includes(health?.status)) {
      const projection = normalizeProjectionDiagnostic(health, "unhealthy");
      const integrityFailures = projection.counts.historyIntegrityFailures ?? 0;
      const detail = integrityFailures > 0
        ? `检测到 ${integrityFailures} 项 SQLite 完整性检查失败`
        : projectionBlockDetail(projection.counts);
      throw projectionBlockError(
        "codex_thread_projection_unhealthy",
        projection,
        `本地 Codex 对话投影状态不一致，已阻止账号切换且不会自动重试；${detail}，当前认证、配置和 Codex 进程均未更改。`
      );
    }
  }

  async assertCodexThreadProjectionHealthyAsync() {
    let health;
    try {
      health = await this.inspectProjectionHealthAsync("switch_validation");
    } catch {
      throw projectionBlockError(
        "codex_thread_projection_unavailable",
        { status: "unavailable", counts: {} },
        "本地 Codex 对话投影状态无法安全校验，已取消账号切换；当前认证、配置和 Codex 进程均未更改。"
      );
    }
    if (health?.healthy !== true || !["healthy", "not_applicable"].includes(health?.status)) {
      const projection = normalizeProjectionDiagnostic(health, "unhealthy");
      const detail = projection.counts.historyIntegrityFailures > 0
        ? `检测到 ${projection.counts.historyIntegrityFailures} 个投影数据库完整性检查失败`
        : projectionBlockDetail(projection.counts);
      throw projectionBlockError(
        "codex_thread_projection_unhealthy",
        projection,
        `本地 Codex 对话投影状态不一致，已阻止账号切换且不会自动重试；${detail}，当前认证、配置和 Codex 进程均未更改。`
      );
    }
  }

  async inspectProjectionHealthAsync(reason) {
    const started = performance.now();
    let health;
    try {
      health = await this.getCodexThreadProjectionHealthAsync();
      return health;
    } finally {
      const timings = {};
      for (const key of ["stateMs", "integrityMs", "projectionMs", "rolloutMs", "totalMs"]) {
        if (Number.isFinite(health?.timings?.[key])) timings[key] = Math.max(0, Math.round(health.timings[key]));
      }
      try {
        this.writeAutoSwitchEvent("projection_check_finished", {
          reason, elapsedMs: Math.round(performance.now() - started),
          status: health?.healthy === true ? "healthy" : health ? "unhealthy" : "unavailable", timings
        });
      } catch {}
    }
  }

  assertCodexThreadStateUnchanged(expected) {
    let current;
    try {
      current = this.getCodexThreadIntegritySnapshot();
    } catch {
      throw new Error("本地对话状态完整性校验失败，已恢复原账号认证，未重新打开 Codex。");
    }
    if (!current?.revision || current.revision !== expected.revision) {
      throw new Error("本地对话状态完整性校验失败，已恢复原账号认证，未重新打开 Codex。");
    }
  }

  async assertCodexThreadStateUnchangedAsync(expected) {
    let current;
    try {
      current = await this.getCodexThreadIntegritySnapshotAsync();
    } catch {
      throw new Error("本地对话状态完整性校验失败，已恢复原账号认证，未重新打开 Codex。");
    }
    if (!current?.revision || current.revision !== expected.revision) {
      throw new Error("本地对话状态完整性校验失败，已恢复原账号认证，未重新打开 Codex。");
    }
  }

  launchCodexWithPreferenceAsync(account = this.currentStoredAccount(), options = {}) {
    return this.launchCodexAsync({
      disableGpu: this.resolveDisableGpuMode(account),
      ...(options.forceRendererAccessibility === true ? { forceRendererAccessibility: true } : {})
    });
  }

  async verifyPrioritizedCodexLaunch(options = {}) {
    let launchAttempts = 0;
    try {
      if (await this.countCodexDesktopProcessesAsync() > 0) {
        return { launchedCodex: true, verifiedCodexLaunch: true, launchRecovered: false };
      }
    } catch {}
    for (const delayMs of this.codexLaunchRetryDelaysMs) {
      try {
        await this.launchCodexWithPreferenceAsync(undefined, options);
      } catch {}
      launchAttempts += 1;
      await this.wait(delayMs);
      try {
        if (await this.countCodexDesktopProcessesAsync() > 0) {
          return { launchedCodex: true, verifiedCodexLaunch: true, launchRecovered: launchAttempts > 1 };
        }
      } catch {}
    }
    return { launchedCodex: false, verifiedCodexLaunch: false, launchRecovered: false };
  }

  applyTransportMode(enabled) {
    if (enabled) {
      if (readCodexHttpOnlyStatus(this.codexConfigPath).enabled) {
        ensureCodexHttpOnlyMode(this.codexConfigPath);
        return { changedRollouts: 0, changedThreads: 0 };
      }
      setCodexHttpOnlyMode(this.codexConfigPath, true);
      return { changedRollouts: 0, changedThreads: 0 };
    }

    if (!readCodexHttpOnlyStatus(this.codexConfigPath).enabled) {
      return { changedRollouts: 0, changedThreads: 0 };
    }
    setCodexHttpOnlyMode(this.codexConfigPath, false);
    return { changedRollouts: 0, changedThreads: 0 };
  }

  applyTransportModeWithHistory(enabled) {
    if (enabled) {
      if (readCodexHttpOnlyStatus(this.codexConfigPath).enabled) {
        ensureCodexHttpOnlyMode(this.codexConfigPath);
        return { changedRollouts: 0, changedThreads: 0 };
      }
      const baseProvider = readCodexBaseProvider(this.codexConfigPath);
      const migration = migrateCodexHistoryProvider(this.codexDir, HTTP_ONLY_PROVIDER_ID, baseProvider, this.historyStorage);
      try {
        setCodexHttpOnlyMode(this.codexConfigPath, true);
      } catch (error) {
        revertCodexHistoryProvider(this.codexDir, baseProvider, this.historyStorage);
        throw error;
      }
      return migration;
    }

    if (!readCodexHttpOnlyStatus(this.codexConfigPath).enabled) {
      return { changedRollouts: 0, changedThreads: 0 };
    }
    const baseProvider = readCodexBaseProvider(this.codexConfigPath);
    const migration = revertCodexHistoryProvider(this.codexDir, baseProvider, this.historyStorage);
    try {
      setCodexHttpOnlyMode(this.codexConfigPath, false);
    } catch (error) {
      migrateCodexHistoryProvider(this.codexDir, HTTP_ONLY_PROVIDER_ID, baseProvider, this.historyStorage);
      throw error;
    }
    return migration;
  }

  readStore() {
    try {
      return normalizeStoredAccountStatuses(readJsonIfExists(this.storePath, { version: 1, accounts: [] }));
    } catch (error) {
      if (!this.restoreRecoverySnapshot()) throw error;
      return normalizeStoredAccountStatuses(readJsonIfExists(this.storePath, { version: 1, accounts: [] }));
    }
  }

  writeStore(store) {
    atomicWriteJson(this.storePath, store);
    this.ensureRecoverySnapshot(store, this.readSettings());
  }

  writeSettings(settings) {
    atomicWriteJson(this.settingsPath, settings);
    this.ensureRecoverySnapshot(this.readStore(), settings);
  }

  ensureRecoverySnapshot(store, settings) {
    if (this.restoringRecoverySnapshot) return;
    saveRecoverySnapshot(this.recoverySnapshotsPath, store, normalizeSettings(settings));
  }

  restoreRecoverySnapshot() {
    if (this.restoringRecoverySnapshot) return false;
    const snapshot = loadLatestValidRecoverySnapshot(this.recoverySnapshotsPath);
    if (!snapshot) return false;

    this.restoringRecoverySnapshot = true;
    try {
      this.isolateCorruptState(this.storePath);
      this.isolateCorruptState(this.settingsPath);
      atomicWriteJson(this.storePath, snapshot.store, { backup: false });
      atomicWriteJson(this.settingsPath, normalizeSettings(snapshot.settings), { backup: false });
      return true;
    } finally {
      this.restoringRecoverySnapshot = false;
    }
  }

  isolateCorruptState(filePath) {
    const stamp = Date.now();
    for (const candidate of [filePath, `${filePath}.bak`]) {
      if (fs.existsSync(candidate)) fs.renameSync(candidate, `${candidate}.corrupt-${stamp}`);
    }
  }

  reconcileActiveAccount(source) {
    const accountId = this.currentSavedAccountId();
    if (accountId) this.recordActiveAccount(accountId, source);
  }

  currentSavedAccountId() {
    const fingerprint = this.currentAuthFingerprint();
    if (!fingerprint) return undefined;
    return this.readStore().accounts.find((account) => account.fingerprint === fingerprint)?.id;
  }

  currentAccountCycleStartMs(accountId, nowMs = this.nowMs()) {
    if (!accountId) return undefined;
    const state = readObservationState(this.usageObservationsPath);
    const open = [...state.intervals].reverse().find((item) => item.endMs === undefined);
    const startMs = open?.accountId === accountId ? finiteTime(open.startMs) : undefined;
    return startMs !== undefined && startMs <= nowMs ? startMs : undefined;
  }

  quotaInterruptionSelectionWindow(nowMs, requestedLookbackMs) {
    const openStartedAtMs = this.currentAccountCycleStartMs(this.currentSavedAccountId(), nowMs);
    const minInterruptedAtMs = openStartedAtMs !== undefined && openStartedAtMs <= nowMs
      ? openStartedAtMs
      : nowMs;
    return {
      includeUnfinished: true,
      lookbackMs: Math.max(requestedLookbackMs, nowMs - minInterruptedAtMs),
      minInterruptedAtMs
    };
  }

  recordActiveAccount(accountId, source) {
    if (this.persistActiveAccount) {
      const operation = this.persistActiveAccount({
        observationPath: this.usageObservationsPath,
        accountId,
        source,
        nowMs: this.nowMs()
      });
      void operation.catch(() => {});
      return operation;
    }
    const state = readObservationState(this.usageObservationsPath);
    const open = [...state.intervals].reverse().find((item) => item.endMs === undefined);
    if (open?.accountId === accountId || (!open && !accountId)) return;
    setActiveAccount(state, { accountId, atMs: this.nowMs(), source });
    pruneObservationState(state, this.nowMs());
    writeObservationState(this.usageObservationsPath, state);
  }

  recordQuotaObservation(accountId, usage) {
    return this.recordQuotaObservations([{ accountId, usage }]);
  }

  recordQuotaObservations(observations) {
    if (observations.length === 0) return;
    if (this.persistQuotaObservations) {
      return this.persistQuotaObservations({
        observationPath: this.usageObservationsPath,
        observations,
        nowMs: this.nowMs()
      });
    }
    const state = readObservationState(this.usageObservationsPath);
    for (const { accountId, usage } of observations) {
      appendQuotaSnapshot(state, {
        accountId,
        fetchedAtMs: Number(usage.fetchedAt) * 1000,
        source: usage.source ?? "chatgpt_usage_api",
        fiveHour: usage.fiveHour,
        oneWeek: usage.oneWeek,
        explicitResetCause: usage.explicitResetCause
      });
    }
    pruneObservationState(state, this.nowMs());
    this.writeObservationState(this.usageObservationsPath, state);
  }

  writeAutoSwitchEvent(type, details = {}) {
    const safeDetails = redactDiagnosticValue(details);
    const signature = JSON.stringify({ type, details: safeDetails });
    if (signature === this.lastAutoSwitchDiagnosticSignature) return;
    this.lastAutoSwitchDiagnosticSignature = signature;
    const event = redactDiagnosticValue({
      timestamp: beijingTimestamp(this.nowMs()),
      type,
      details: safeDetails
    });
    fs.mkdirSync(path.dirname(this.autoSwitchEventsPath), { recursive: true });
    fs.appendFileSync(this.autoSwitchEventsPath, `${JSON.stringify(event)}\n`, "utf8");
    pruneTextFile(this.autoSwitchEventsPath, 256 * 1024);
  }

  hasSkippedLegacyResumeEvidence(state) {
    if (!finiteTime(state?.updatedAtMs)) return false;
    try {
      const lines = fs.readFileSync(this.autoSwitchEventsPath, "utf8").split(/\r?\n/).filter(Boolean);
      return lines.some((line) => {
        let event;
        try {
          event = JSON.parse(line);
        } catch {
          return false;
        }
        const timestampMs = Date.parse(event?.timestamp);
        return event?.type === "switched"
          && Number.isFinite(timestampMs)
          && timestampMs >= state.updatedAtMs
          && event?.details?.autoResumeStatus === "skipped"
          && Number(event?.details?.autoResumeCandidateCount) > 0;
      });
    } catch {
      return false;
    }
  }

  clearDeletedAccountReferences(accountId) {
    const settings = this.readSettings();
    const patch = {};
    if (settings.manualAutoSwitchTargetAccountId === accountId) {
      patch.autoSwitchTargetMode = "best";
    }
    if (settings.autoSwitchExcludedAccountIds.includes(accountId)) {
      patch.autoSwitchExcludedAccountIds = settings.autoSwitchExcludedAccountIds.filter((id) => id !== accountId);
    }
    if (settings.autoSwitchStayAccountId === accountId) {
      patch.autoSwitchStayAccountId = "";
    }
    if (Object.keys(patch).length > 0) {
      this.updateSettings(patch);
    }
    const state = this.getAutoSwitchState();
    if (state.pending?.accountId === accountId) {
      this.clearAutoSwitchState();
    }
  }

  findAccount(store, id) {
    const account = store.accounts.find((item) => item.id === id);
    if (!account) {
      throw new Error("Account not found.");
    }
    return account;
  }

  decryptAccountAuth(account) {
    return JSON.parse(this.unprotectString(account.encryptedAuth));
  }

  async decryptAccountAuthAsync(account) {
    return JSON.parse(await this.unprotectStringAsync(account.encryptedAuth));
  }

  accountRemark(account) {
    if (typeof account.encryptedRemark !== "string" || !account.encryptedRemark) {
      this.accountRemarkCache.delete(account.id);
      return undefined;
    }
    const cached = this.accountRemarkCache.get(account.id);
    if (cached?.encryptedRemark === account.encryptedRemark) return cached.remark;
    const remark = this.unprotectString(account.encryptedRemark);
    this.accountRemarkCache.set(account.id, { encryptedRemark: account.encryptedRemark, remark });
    return remark;
  }

  publicAccount(account, currentFingerprint, options = {}) {
    const isCurrent = Boolean(currentFingerprint && account.fingerprint === currentFingerprint);
    return {
      id: account.id,
      accountId: account.accountId,
      emailMasked: account.emailMasked,
      remark: this.accountRemark(account),
      planType: account.planType,
      usage: isCurrent && options.projectQuotaEvidence === true
        ? this.usageWithCodexExhaustionEvidence(account)
        : account.usage,
      usageError: account.usageError,
      usageRefreshAttemptedAt: account.usageRefreshAttemptedAt,
      status: account.status,
      httpOnlyModeEnabled: this.resolveHttpOnlyMode(account),
      httpOnlyModeOverride: typeof account.httpOnlyModeEnabled === "boolean",
      disableGpuModeEnabled: this.resolveDisableGpuMode(account),
      disableGpuModeOverride: typeof account.disableGpuModeEnabled === "boolean",
      isCurrent,
      createdAt: account.createdAt,
      updatedAt: account.updatedAt
    };
  }

  usageWithCodexExhaustionEvidence(account) {
    if (!account?.usage || typeof account.usage !== "object") return account?.usage;
    if (isQuotaExhaustedUsage(account?.usage)) return account.usage;
    const cached = this.quotaInterruptionEvidenceCache;
    const nowMs = this.nowMs();
    const decision = cached && cached.checkedAtMs <= nowMs && nowMs < cached.expiresAtMs
      ? cached.decision
      : undefined;
    const observationState = readObservationState(this.usageObservationsPath);
    const decisionCandidates = decision?.status === "selected"
      ? decision.candidates ?? [decision.candidate]
      : [];
    const interruptedAtMs = Math.max(...decisionCandidates
      .filter((candidate) => normalizeResumeReason(candidate?.reason) === "usage_limit_exceeded")
      .map((candidate) => finiteTime(candidate?.interruptedAtMs))
      .filter((timestamp) => timestamp !== undefined && accountAt(observationState, timestamp) === account.id));
    if (!Number.isFinite(interruptedAtMs)) return account?.usage;
    return projectUsageLimitExhaustion(account?.usage, interruptedAtMs, nowMs);
  }

  async refreshQuotaInterruptionEvidence(options = {}) {
    const nowMs = this.nowMs();
    const requestedLookbackMs = Number.isFinite(options.lookbackMs) && options.lookbackMs >= AUTO_RESUME_USAGE_LIMIT_LOOKBACK_MS
      ? options.lookbackMs
      : AUTO_RESUME_USAGE_LIMIT_LOOKBACK_MS;
    const selectionWindow = this.quotaInterruptionSelectionWindow(nowMs, requestedLookbackMs);
    const cached = this.quotaInterruptionEvidenceCache;
    if (cached
      && cached.checkedAtMs <= nowMs
      && nowMs < cached.expiresAtMs
      && cached.lookbackMs >= selectionWindow.lookbackMs
      && cached.minInterruptedAtMs === selectionWindow.minInterruptedAtMs) return cached.decision;
    let decision;
    try {
      decision = normalizeAutoResumeDecision(await this.selectQuotaInterruptedThreadAsync({
        nowMs,
        ...selectionWindow,
        selectAllCandidates: true
      })) ?? { status: "none", candidateCount: 0 };
    } catch {
      decision = { status: "none", candidateCount: 0 };
    }
    this.quotaInterruptionEvidenceCache = {
      checkedAtMs: nowMs,
      expiresAtMs: nowMs + QUOTA_INTERRUPTION_EVIDENCE_CACHE_MS,
      lookbackMs: selectionWindow.lookbackMs,
      minInterruptedAtMs: selectionWindow.minInterruptedAtMs,
      decision
    };
    return decision;
  }

  currentAuthFingerprint() {
    try {
      if (!fs.existsSync(this.codexAuthPath)) {
        return undefined;
      }
      return authFingerprint(JSON.parse(fs.readFileSync(this.codexAuthPath, "utf8")));
    } catch {
      return undefined;
    }
  }

  backupCriticalCodexState() {
    return this.createCriticalCodexSnapshot({
      codexDir: this.codexDir,
      backupRoot: this.backupRoot,
      now: this.nowMs
    });
  }

  backupCurrentAuth() {
    if (!fs.existsSync(this.codexAuthPath)) {
      return;
    }
    const backupDir = this.authBackupPath;
    fs.mkdirSync(backupDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const encryptedBackup = protectString(fs.readFileSync(this.codexAuthPath, "utf8"));
    atomicWriteText(path.join(backupDir, `auth.${stamp}.json.dpapi`), `${encryptedBackup}\n`);
    this.pruneBackups(backupDir);
  }

  async backupCurrentAuthAsync() {
    if (!fs.existsSync(this.codexAuthPath)) return;
    const backupDir = this.authBackupPath;
    fs.mkdirSync(backupDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const encryptedBackup = await this.protectStringAsync(fs.readFileSync(this.codexAuthPath, "utf8"));
    atomicWriteText(path.join(backupDir, `auth.${stamp}.json.dpapi`), `${encryptedBackup}\n`);
    this.pruneBackups(backupDir);
  }

  migratePlaintextBackups(backupDir) {
    migratePlaintextAuthBackups(backupDir);
  }

  pruneBackups(backupDir) {
    const backups = fs
      .readdirSync(backupDir)
      .filter((name) => name.startsWith("auth.") && name.endsWith(".json.dpapi"))
      .sort();
    for (const extra of backups.slice(0, Math.max(0, backups.length - 3))) {
      fs.rmSync(path.join(backupDir, extra), { force: true });
    }
  }
}

function normalizeSettings(value) {
  const threshold = Number(value?.lowQuotaThresholdPercent);
  const refreshInterval = Number(value?.usageRefreshIntervalMinutes);
  const targetMode = value?.autoSwitchTargetMode === "manual" ? "manual" : "best";
  const manualTargetId =
    targetMode === "manual" && typeof value?.manualAutoSwitchTargetAccountId === "string" && value.manualAutoSwitchTargetAccountId
      ? value.manualAutoSwitchTargetAccountId
      : undefined;
  return {
    autoSwitchEnabled: typeof value?.autoSwitchEnabled === "boolean" ? value.autoSwitchEnabled : false,
    autoResumeAfterQuotaSwitch:
      typeof value?.autoResumeAfterQuotaSwitch === "boolean" ? value.autoResumeAfterQuotaSwitch : false,
    requireSwitchConfirmation: typeof value?.requireSwitchConfirmation === "boolean" ? value.requireSwitchConfirmation : true,
    lowQuotaWarningEnabled: typeof value?.lowQuotaWarningEnabled === "boolean" ? value.lowQuotaWarningEnabled : true,
    lowQuotaThresholdPercent: Number.isFinite(threshold) ? Math.max(1, Math.min(50, threshold)) : 15,
    uiLanguage: value?.uiLanguage === "en" ? "en" : "zh-CN",
    closeBehavior: isCloseBehavior(value?.closeBehavior) ? value.closeBehavior : "ask",
    themeMode: isThemeMode(value?.themeMode) ? value.themeMode : "system",
    edgeWindowEnabled: typeof value?.edgeWindowEnabled === "boolean" ? value.edgeWindowEnabled : false,
    edgeWindowDocked: typeof value?.edgeWindowDocked === "boolean" ? value.edgeWindowDocked : true,
    edgeWindowX: Number.isFinite(Number(value?.edgeWindowX)) ? Math.round(Number(value.edgeWindowX)) : 0,
    edgeWindowDockSide: value?.edgeWindowDockSide === "left" ? "left" : "right",
    edgeWindowDisplayId: typeof value?.edgeWindowDisplayId === "string" ? value.edgeWindowDisplayId : "",
    edgeWindowY: Number.isFinite(Number(value?.edgeWindowY)) ? Math.round(Number(value.edgeWindowY)) : 160,
    edgeWindowWidth: Number.isFinite(Number(value?.edgeWindowWidth)) ? Math.max(1, Math.round(Number(value.edgeWindowWidth))) : 420,
    edgeWindowHeight: Number.isFinite(Number(value?.edgeWindowHeight)) ? Math.max(1, Math.round(Number(value.edgeWindowHeight))) : 470,
    edgeWindowAutoHide: typeof value?.edgeWindowAutoHide === "boolean" ? value.edgeWindowAutoHide : false,
    edgeWindowPinned: typeof value?.edgeWindowPinned === "boolean" ? value.edgeWindowPinned : false,
    autoSwitchTargetMode: targetMode,
    manualAutoSwitchTargetAccountId: manualTargetId,
    autoSwitchStayAccountId: typeof value?.autoSwitchStayAccountId === "string" && value.autoSwitchStayAccountId.trim()
      ? value.autoSwitchStayAccountId.trim()
      : undefined,
    autoSwitchExcludedAccountIds: normalizeExcludedAccountIds(value?.autoSwitchExcludedAccountIds),
    httpOnlyModeEnabled: typeof value?.httpOnlyModeEnabled === "boolean" ? value.httpOnlyModeEnabled : false,
    disableGpuModeEnabled: typeof value?.disableGpuModeEnabled === "boolean" ? value.disableGpuModeEnabled : false,
    accountListPanePercent: Number.isFinite(Number(value?.accountListPanePercent))
      ? Math.round(Math.max(28, Math.min(68, Number(value.accountListPanePercent))))
      : 46,
    usageRefreshIntervalMinutes: Number.isFinite(refreshInterval) ? Math.round(Math.max(1, Math.min(60, refreshInterval))) : 5,
    lastConversationBackupSucceededAtMs: finiteTime(value?.lastConversationBackupSucceededAtMs),
    lastConversationIncrementalSucceededAtMs: finiteTime(value?.lastConversationIncrementalSucceededAtMs ?? value?.lastConversationBackupSucceededAtMs),
    lastConversationFullVerificationSucceededAtMs: finiteTime(value?.lastConversationFullVerificationSucceededAtMs ?? value?.lastConversationBackupSucceededAtMs),
    edgeCompletedReadThreadIds: normalizeThreadIds([
      ...(Array.isArray(value?.edgeCompletedReadThreadIds) ? value.edgeCompletedReadThreadIds : []),
      ...Object.values(normalizeCompletedReadByAccount(value?.edgeCompletedReadByAccount)).flat()
    ])
  };
}

function normalizeAccountRemark(value) {
  if (typeof value !== "string") {
    throw new Error("账号备注必须是文本。");
  }
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.includes("\uFFFD") || hasUnpairedUtf16Surrogate(normalized)) {
    throw new Error("账号备注包含无法识别的字符，请删除后重新输入。");
  }
  if (normalized.length > 80) {
    throw new Error("账号备注最多 80 个字符。");
  }
  return normalized || undefined;
}

function hasUnpairedUtf16Surrogate(value) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function finiteTime(value) {
  return Number.isFinite(Number(value)) ? Number(value) : undefined;
}

function normalizeExcludedAccountIds(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return [...new Set(value.filter((id) => typeof id === "string" && id.trim()).map((id) => id.trim()))];
}

function normalizeThreadIds(value) {
  const values = value instanceof Set ? [...value] : Array.isArray(value) ? value : [];
  return [...new Set(values
    .filter((id) => typeof id === "string")
    .map((id) => id.trim())
    .filter((id) => id && id.length <= 200))].sort();
}

function normalizeCompletedReadByAccount(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result = {};
  for (const [accountId, threadIds] of Object.entries(value)) {
    if (typeof accountId === "string" && accountId && Array.isArray(threadIds)) {
      result[accountId] = normalizeThreadIds(threadIds);
    }
  }
  return result;
}

function parseLocalDateStart(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const parsed = new Date(`${value}T00:00:00+08:00`).getTime();
  return Number.isFinite(parsed) ? parsed : undefined;
}

function isCloseBehavior(value) {
  return value === "ask" || value === "minimize" || value === "tray" || value === "quit";
}

function isThemeMode(value) {
  return value === "system" || value === "light" || value === "dark";
}

function isAutoSwitchTargetMode(value) {
  return value === "best" || value === "manual";
}

function normalizeAutoSwitchState(value) {
  if (!value || typeof value !== "object") {
    return {};
  }
  const blocked = normalizeProjectionBlock(value.blocked);
  if (!value.pending || typeof value.pending !== "object") {
    return blocked ? { blocked } : {};
  }
  const accountId = typeof value.pending.accountId === "string" ? value.pending.accountId : undefined;
  if (!accountId) {
    return blocked ? { blocked } : {};
  }
  return {
    pending: {
      accountId,
      emailMasked: typeof value.pending.emailMasked === "string" ? value.pending.emailMasked : undefined,
      mode: isAutoSwitchTargetMode(value.pending.mode) ? value.pending.mode : "best",
      reason: typeof value.pending.reason === "string" ? value.pending.reason : "auto",
      createdAtMs: Number.isFinite(value.pending.createdAtMs) ? value.pending.createdAtMs : undefined,
      updatedAtMs: Number.isFinite(value.pending.updatedAtMs) ? value.pending.updatedAtMs : undefined,
      lastBusyAt: Number.isFinite(value.pending.lastBusyAt) ? value.pending.lastBusyAt : undefined,
      activityKey: typeof value.pending.activityKey === "string" ? value.pending.activityKey : undefined,
      activityBusy: typeof value.pending.activityBusy === "boolean" ? value.pending.activityBusy : undefined,
      quietStartedAtMs: Number.isFinite(value.pending.quietStartedAtMs) ? value.pending.quietStartedAtMs : undefined,
      quietActivityKey: typeof value.pending.quietActivityKey === "string" ? value.pending.quietActivityKey : undefined,
      quietUntilMs: Number.isFinite(value.pending.quietUntilMs) ? value.pending.quietUntilMs : undefined,
      activityReason: typeof value.pending.activityReason === "string" ? value.pending.activityReason : undefined,
      activeTasks: normalizeActiveTasks(value.pending.activeTasks),
      activeThreadIds: Array.isArray(value.pending.activeThreadIds)
        ? value.pending.activeThreadIds.filter((id) => typeof id === "string" && id)
        : [],
      threadIdUnavailable: value.pending.threadIdUnavailable === true,
      processRegistryState: ["valid", "missing", "corrupt"].includes(value.pending.processRegistryState)
        ? value.pending.processRegistryState
        : undefined,
      processRegistryDiagnostic: normalizeProcessRegistryDiagnostic(value.pending.processRegistryDiagnostic),
      officialProcessCount: Number.isInteger(value.pending.officialProcessCount) && value.pending.officialProcessCount >= 0
        ? value.pending.officialProcessCount
        : undefined,
      processEvidenceSource: ["process_registry", "official_process_scan", "none"].includes(value.pending.processEvidenceSource)
        ? value.pending.processEvidenceSource
        : undefined,
      taskEvidenceSource: ["process_registry", "lifecycle", "mixed", "recent_rollout", "none"].includes(value.pending.taskEvidenceSource)
        ? value.pending.taskEvidenceSource
        : undefined,
      taskAssociationConfidence: ["verified", "partial", "unavailable", "none"].includes(value.pending.taskAssociationConfidence)
        ? value.pending.taskAssociationConfidence
        : undefined,
      fallback: normalizeFallback(value.pending.fallback),
      autoResumeDecision: normalizeAutoResumeDecision(value.pending.autoResumeDecision),
      lastError: typeof value.pending.lastError === "string" ? value.pending.lastError : undefined
    },
    ...(blocked ? { blocked } : {})
  };
}

function normalizeProjectionBlock(value) {
  if (!value || typeof value !== "object" || !PROJECTION_BLOCK_CODES.has(value.reasonCode)) return undefined;
  const sourceAccountFingerprint = typeof value.sourceAccountFingerprint === "string"
    ? value.sourceAccountFingerprint
    : "";
  if (!sourceAccountFingerprint) return undefined;
  return {
    reasonCode: value.reasonCode,
    projection: normalizeProjectionDiagnostic(value.projection, value.reasonCode.endsWith("unavailable") ? "unavailable" : "unhealthy"),
    sourceAccountFingerprint,
    createdAtMs: Number.isFinite(value.createdAtMs) ? value.createdAtMs : undefined
  };
}

function normalizeProjectionDiagnostic(value, fallbackStatus = "unhealthy") {
  const counts = {};
  for (const key of PROJECTION_COUNT_KEYS) {
    const count = value?.counts?.[key];
    if (Number.isSafeInteger(count) && count >= 0) counts[key] = count;
  }
  return {
    status: ["unhealthy", "unavailable"].includes(value?.status) ? value.status : fallbackStatus,
    counts
  };
}

function projectionBlockError(code, projection, message) {
  const error = new Error(message);
  error.code = code;
  error.projection = normalizeProjectionDiagnostic(projection, code.endsWith("unavailable") ? "unavailable" : "unhealthy");
  return error;
}

function projectionBlockDetail(counts) {
  const labels = [
    ["missingProjectionRows", "缺少投影记录"],
    ["missingRollouts", "缺少绑定记录"],
    ["unreadableRollouts", "绑定记录无法读取"],
    ["duplicateProjectionRows", "投影记录重复"],
    ["duplicatePaginatedThreadIds", "分页线程标识重复"],
    ["duplicateRollouts", "绑定记录重复"],
    ["invalidThreadIds", "线程标识无效"],
    ["invalidNumbers", "投影数值无效"],
    ["unsupportedStateSchemas", "状态结构不受支持"],
    ["unsupportedSchemas", "投影结构不受支持"],
    ["missingHistoryDatabases", "缺少投影数据库"],
    ["unreadableStateDatabases", "状态数据库无法读取"],
    ["unreadableHistoryDatabases", "投影数据库无法读取"]
  ];
  const [key, label] = labels.find(([candidate]) => (counts?.[candidate] ?? 0) > 0) ?? [];
  return key ? `检测到 ${counts[key]} 项${label}` : "检测到投影结构或绑定检查失败";
}

function projectionBlockFromError(error) {
  if (!PROJECTION_BLOCK_CODES.has(error?.code)) return undefined;
  return {
    reasonCode: error.code,
    projection: normalizeProjectionDiagnostic(error.projection, error.code.endsWith("unavailable") ? "unavailable" : "unhealthy")
  };
}

function normalizeAutoResumeDecision(value) {
  if (!value || typeof value !== "object") return undefined;
  if (value.status === "none") return { status: "none", candidateCount: 0 };
  if (value.status === "ambiguous") {
    const candidateCount = Number(value.candidateCount);
    return Number.isSafeInteger(candidateCount) && candidateCount > 1
      ? { status: "ambiguous", candidateCount }
      : undefined;
  }
  if (value.status === "selected" && Array.isArray(value.candidates)) {
    const candidates = value.candidates.map(normalizeAutoResumeCandidate).filter(Boolean);
    const uniqueCandidates = candidates.filter((candidate, index) =>
      candidates.findIndex((other) => other.threadId === candidate.threadId) === index);
    const candidateCount = Number(value.candidateCount);
    return uniqueCandidates.length > 1
      && Number.isSafeInteger(candidateCount)
      && candidateCount === uniqueCandidates.length
      ? { status: "selected", candidateCount, candidates: uniqueCandidates }
      : undefined;
  }
  const candidate = value.status === "selected" ? value.candidate : value;
  const normalizedCandidate = normalizeAutoResumeCandidate(candidate);
  return normalizedCandidate
    ? {
        status: "selected",
        candidateCount: 1,
        candidate: normalizedCandidate
      }
    : undefined;
}

function pendingAutoResumeCandidateOutcome(decision, state) {
  if (decision?.status !== "selected" || state?.stage !== "uncertain") return undefined;
  const candidate = normalizeAutoResumeCandidate(decision.candidate);
  const candidateCount = Number(decision.candidateCount);
  if (!candidate || !Number.isSafeInteger(candidateCount) || candidateCount < 1) return undefined;
  return candidate.threadId === state.threadId && candidate.interruptedAtMs === state.interruptedAtMs
    ? { status: "candidate_pending_verification", candidateCount }
    : undefined;
}

function hasActiveAutoResumeAttempt(state) {
  if (Array.isArray(state?.items)) return state.items.some(({ stage }) => AUTO_RESUME_ACTIVE_STAGES.has(stage));
  return AUTO_RESUME_ACTIVE_STAGES.has(state?.stage);
}

function isObservedDesktopReceipt(item) {
  return item.stage === "turn_started"
    || (item.stage === "uncertain" && item.priorStage === "turn_started" && !item.failureReason);
}

function restoreObservedDesktopReceipt(item) {
  if (item.stage === "turn_started") return item;
  // Older releases downgraded an observed Desktop receipt on restart. Restore
  // only its observation, never submission permission or a fresh timestamp.
  const { priorStage: _priorStage, ...rest } = item;
  return { ...rest, stage: "turn_started" };
}

function canSupersedeStaleAutoResumeAttempt(state, decision, nowMs) {
  const updatedAtMs = finiteTime(state?.updatedAtMs);
  if (!updatedAtMs) return false;
  const activeItems = (Array.isArray(state?.items) ? state.items : [state])
    .filter((item) => AUTO_RESUME_ACTIVE_STAGES.has(item?.stage));
  // A Desktop receipt is not an owned running executor. Keep the age/new-event
  // gates below; never reinterpret this as permission to replay its old event.
  if (activeItems.length === 0 || activeItems.some((item) =>
    item.stage !== "prepared" && item.stage !== "uncertain"
    && !(item.stage === "turn_started" && (item.resumeMethod ?? state.resumeMethod) === AUTO_RESUME_DESKTOP_METHOD)
  )) return false;
  const normalized = normalizeAutoResumeDecision(decision);
  const candidates = normalized?.candidates ?? (normalized?.candidate ? [normalized.candidate] : []);
  const freshActiveSwitch = activeItems.every((item) => item.stage === "turn_started"
    && (item.resumeMethod ?? state.resumeMethod) === AUTO_RESUME_DESKTOP_METHOD)
    && candidates.length > 0 && candidates.every((candidate) => {
      const prior = (state.items ?? [state]).find((item) => item.threadId === candidate.threadId);
      // Reconciliation updates receipt time after the actual terminal event.
      // A failed sibling must compare against its original interruption, not
      // that later bookkeeping write; uncertain/owned work stays protected.
      const reason = normalizeResumeReason(candidate.reason);
      if (prior?.stage === "failed" && prior.failureReason === reason
        && ["server_overloaded", "task_failed", "usage_limit_exceeded"].includes(reason)) {
        return candidate.interruptedAtMs > Math.max(prior.interruptedAtMs,
          prior.submissionStartedAtMs ?? prior.phaseStartedAtMs ?? 0);
      }
      return ["switch_interrupted_active_thread", "server_overloaded", "task_failed"].includes(candidate.reason)
        && candidate.interruptedAtMs > (prior?.updatedAtMs ?? updatedAtMs);
    });
  if (freshActiveSwitch) return true;
  if (nowMs - updatedAtMs < AUTO_RESUME_SUPERSEDE_AFTER_MS) return false;
  return candidates.length > 0
    && candidates.every(({ interruptedAtMs }) => Number(interruptedAtMs) > updatedAtMs);
}

function autoResumeConflictOutcome(decision, state) {
  const candidateCount = Number(decision?.candidateCount);
  const existingCount = Array.isArray(state?.items) ? state.items.length : state?.threadId ? 1 : 0;
  return {
    status: "needs_attention",
    candidateCount: Number.isSafeInteger(candidateCount) && candidateCount > 0 ? candidateCount : existingCount
  };
}

function autoResumeDecisionCandidates(decision) {
  const normalized = normalizeAutoResumeDecision(decision);
  if (normalized?.status !== "selected") return [];
  return normalized.candidates ?? (normalized.candidate ? [normalized.candidate] : []);
}

function isReusablePreparedAutoResumeQueue(state, candidates) {
  if (!Array.isArray(state?.items) || !Array.isArray(candidates) || candidates.length === 0) return false;
  if (state.items.some(({ stage }) => stage !== "prepared"
    && !["turn_started", "completed", "failed", "uncertain"].includes(stage))) return false;
  const prepared = state.items.filter(({ stage }) => stage === "prepared");
  if (prepared.length !== candidates.length) return false;
  return candidates.every((candidate) => prepared.some((item) =>
    item.threadId === candidate.threadId && item.interruptedAtMs === candidate.interruptedAtMs));
}

function autoResumePhaseDeadlineAtMs(phase, nowMs, previousDeadlineAtMs) {
  if (phase === "deep_link_opened") return nowMs + AUTO_RESUME_DESKTOP_DISCOVERY_MS;
  if (AUTO_RESUME_DESKTOP_DISCOVERY_PHASES.has(phase)) return finiteTime(previousDeadlineAtMs);
  if (phase === "invoke_started" || phase === "fallback_invoke_started") return nowMs + AUTO_RESUME_DESKTOP_VERIFICATION_MS;
  if (phase === "prompt_consumed") return finiteTime(previousDeadlineAtMs);
  return undefined;
}

function autoResumeSubmissionMayHaveOccurred(value) {
  return value?.submitInvoked === true && value?.desktopPhase !== "invoke_no_effect";
}

function isUnsentForegroundFailure(value, reason) {
  return reason === "foreground_changed"
    && value?.submitInvoked !== true
    && !autoResumeSubmissionMayHaveOccurred(value)
    && !value?.turnId
    && AUTO_RESUME_DESKTOP_PHASES.has(value?.desktopPhase)
    && !["invoke_started", "invoke_no_effect", "fallback_invoke_started", "prompt_consumed"].includes(value.desktopPhase);
}

function isLegacyRetainedPromptNoEffect(value) {
  return value?.stage === "uncertain"
    && value?.desktopPhase === "invoke_started"
    && value?.failureReason === "prompt_not_consumed"
    && value?.submitInvoked === true
    && !value?.turnId;
}

function resetRetainedPromptItem(value, nowMs) {
  const {
    desktopPhase: _desktopPhase,
    failureReason: _failureReason,
    phaseDeadlineAtMs: _phaseDeadlineAtMs,
    phaseStartedAtMs: _phaseStartedAtMs,
    submissionStartedAtMs: _submissionStartedAtMs,
    priorStage: _priorStage,
    submitInvoked: _submitInvoked,
    turnId: _turnId,
    ...rest
  } = value;
  return { ...rest, stage: "prepared", updatedAtMs: nowMs };
}

function isAutoResumeTicket(value) {
  return Boolean(value?.attemptId && value?.threadId && !Array.isArray(value?.items));
}

function isAutoResumeQueue(value) {
  return Boolean(value?.attemptId && Array.isArray(value?.items));
}

function isAutoResumeOutcome(value) {
  return value?.status === "candidate_pending_verification" || value?.status === "needs_attention";
}

function normalizeResumeReason(reason) {
  return ["switch_interrupted_active_thread", "server_overloaded", "task_failed"].includes(reason)
    ? reason : "usage_limit_exceeded";
}

function normalizeAutoResumeCandidate(value) {
  const threadId = normalizeTicketText(value?.threadId);
  const interruptedAtMs = finiteTime(value?.interruptedAtMs);
  if (!threadId || !Number.isFinite(interruptedAtMs) || interruptedAtMs <= 0) return undefined;
  return {
    threadId,
    interruptedAtMs,
    ...(normalizeResumeReason(value?.reason) !== "usage_limit_exceeded" ? { reason: normalizeResumeReason(value.reason) } : {})
  };
}

function normalizeProcessRegistryDiagnostic(value) {
  if (!value || !["valid", "missing", "corrupt"].includes(value.state)) return undefined;
  return {
    state: value.state,
    ...(["not_found", "all_zero", "malformed_json", "unreadable", "unstable"].includes(value.reason) ? { reason: value.reason } : {}),
    ...(Number.isFinite(value.lastWriteMs) && value.lastWriteMs >= 0 ? { lastWriteMs: value.lastWriteMs } : {}),
    ...(Number.isFinite(value.latestOfficialAppServerStartMs) && value.latestOfficialAppServerStartMs >= 0
      ? { latestOfficialAppServerStartMs: value.latestOfficialAppServerStartMs }
      : {}),
    ...(value.predatesAppServerStart === true ? { predatesAppServerStart: true } : {}),
    ...(Number.isInteger(value.ignoredStaleTaskCount) && value.ignoredStaleTaskCount > 0
      ? { ignoredStaleTaskCount: value.ignoredStaleTaskCount }
      : {}),
    ...(Number.isFinite(value.oldestStaleEvidenceAtMs) && value.oldestStaleEvidenceAtMs >= 0
      ? { oldestStaleEvidenceAtMs: value.oldestStaleEvidenceAtMs }
      : {})
  };
}

function normalizeFallback(value) {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const requestedTargetId = typeof value.requestedTargetId === "string" ? value.requestedTargetId : undefined;
  const reason = typeof value.reason === "string" ? value.reason : undefined;
  return requestedTargetId && reason ? { requestedTargetId, reason } : undefined;
}

function normalizeActiveTasks(value) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((task) => {
    const id = typeof task?.id === "string" ? task.id.trim().slice(0, 200) : "";
    const displayName = typeof task?.displayName === "string" ? task.displayName.trim().slice(0, 80) : "";
    const nameSource = ["thread_title", "workspace", "unnamed"].includes(task?.nameSource) ? task.nameSource : "unnamed";
    return id ? [{ id, displayName, nameSource }] : [];
  });
}

function selectedStatsNowMs(asOfDate, currentNowMs) {
  if (typeof asOfDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(asOfDate)) {
    return currentNowMs;
  }
  const selectedStart = Date.parse(`${asOfDate}T00:00:00+08:00`);
  if (!Number.isFinite(selectedStart)) {
    return currentNowMs;
  }
  const selectedEnd = selectedStart + 24 * 60 * 60 * 1000 - 1;
  const currentStart = beijingDayStart(currentNowMs);
  if (selectedStart >= currentStart) {
    return currentNowMs;
  }
  return selectedEnd;
}

function normalizeDeleteOptions(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    if (value.mode === "login_new") {
      return { mode: "login_new" };
    }
    return {
      mode: "switch",
      replacementAccountId: value.replacementAccountId ?? value.accountId ?? value.id
    };
  }
  return { mode: "switch", replacementAccountId: value };
}

function authFingerprint(authJson) {
  return crypto.createHash("sha256").update(JSON.stringify(authJson)).digest("hex");
}

export function stabilizeQuotaUsage(previousUsage, nextUsage) {
  if (!nextUsage || typeof nextUsage !== "object") return nextUsage;
  return {
    ...nextUsage,
    fiveHour: stabilizeQuotaWindow(previousUsage?.fiveHour, nextUsage.fiveHour),
    oneWeek: stabilizeQuotaWindow(previousUsage?.oneWeek, nextUsage.oneWeek)
  };
}

function stabilizeQuotaWindow(previousWindow, nextWindow) {
  if (!nextWindow || typeof nextWindow !== "object") {
    return Number(previousWindow?.usedPercent) >= 100
      ? { ...previousWindow, usedPercent: 100, remainingPercent: 0, exhaustionLatched: true }
      : nextWindow;
  }
  const sameDuration = Number.isFinite(previousWindow?.windowSeconds)
    && previousWindow.windowSeconds === nextWindow.windowSeconds;
  const previousResetAt = Number(previousWindow?.resetAt);
  const nextResetAt = Number(nextWindow.resetAt);
  const resetAdvanced = Number.isFinite(previousResetAt)
    && Number.isFinite(nextResetAt)
    && nextResetAt > previousResetAt;
  const wasExhausted = Number(previousWindow?.usedPercent) >= 100;
  const regressedBelowExhausted = Number(nextWindow.usedPercent) < 100;
  if (!sameDuration || !wasExhausted || !regressedBelowExhausted || resetAdvanced) return nextWindow;
  return {
    ...nextWindow,
    usedPercent: 100,
    remainingPercent: 0,
    exhaustionLatched: true
  };
}

function redactError(error) {
  return String(error instanceof Error ? error.message : error).replace(/Bearer\s+[A-Za-z0-9._-]+/g, "Bearer [redacted]");
}

function redactDiagnosticValue(value) {
  if (typeof value === "string") {
    return value
      .replace(/Bearer\s+[A-Za-z0-9._-]+/g, "Bearer [redacted]")
      .replace(/"?(access|refresh|id)_token"?\s*[:=]\s*"?[^",}\s]+/gi, "$1_token=[redacted]")
      .replace(/sk-[A-Za-z0-9_-]+/g, "sk-[redacted]");
  }
  if (Array.isArray(value)) {
    return value.map(redactDiagnosticValue);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => {
        if (/token|secret|api.?key|auth|conversation/i.test(key)) {
          return [key, "[redacted]"];
        }
        return [key, redactDiagnosticValue(item)];
      })
    );
  }
  return value;
}

function pruneTextFile(filePath, maxBytes) {
  try {
    const stat = fs.statSync(filePath);
    if (stat.size <= maxBytes) {
      return;
    }
    const keepBytes = Math.floor(maxBytes / 2);
    const fd = fs.openSync(filePath, "r");
    const buffer = Buffer.alloc(keepBytes);
    fs.readSync(fd, buffer, 0, keepBytes, Math.max(0, stat.size - keepBytes));
    fs.closeSync(fd);
    const text = buffer.toString("utf8");
    atomicWriteText(filePath, text.slice(text.indexOf("\n") + 1));
  } catch {
    // Diagnostics must never block account switching.
  }
}

function isUsageAuthFailure(error) {
  return /401|Unauthorized|登录态被用量接口拒绝/i.test(redactError(error));
}

function normalizeStoredAccountStatuses(store) {
  for (const account of store.accounts ?? []) {
    if (account.status !== "needs_login") continue;
    account.status = "usage_auth_expired";
    if (/登录态被用量接口拒绝|login state needs refresh/i.test(account.usageError ?? "")) {
      account.usageError = USAGE_AUTH_EXPIRED_MESSAGE;
    }
  }
  return store;
}

function closeOfficialCodexProcesses() {
  if (process.platform !== "win32") {
    return 0;
  }
  const script = officialCodexProcessScript({ mode: "close", currentPid: process.pid });
  try {
    const output = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 10_000
    }).trim();
    return Number.parseInt(output, 10) || 0;
  } catch {
    throw new Error("无法完全关闭 ChatGPT Codex，已取消本次切换或删除。请手动退出 ChatGPT Codex 后重试。");
  }
}

function countOfficialCodexProcesses() {
  if (process.platform !== "win32") {
    return 0;
  }
  const script = officialCodexProcessScript({ mode: "count", currentPid: process.pid });
  try {
    const output = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 10_000
    }).trim();
    return Number.parseInt(output, 10) || 0;
  } catch {
    return 0;
  }
}

function inspectOfficialCodexProcesses() {
  if (process.platform !== "win32") return { count: 0, inspected: false };
  const script = officialCodexProcessScript({ mode: "inspect", currentPid: process.pid });
  try {
    const value = JSON.parse(execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 10_000
    }));
    return normalizeOfficialProcessSnapshot({ ...value, inspected: true });
  } catch {
    return { count: 0, inspected: false };
  }
}

function closeOfficialCodexProcessesAsync() {
  if (process.platform !== "win32") return Promise.resolve(0);
  const script = officialCodexProcessScript({ mode: "close", currentPid: process.pid });
  return new Promise((resolve, reject) => {
    execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 10_000
    }, (error, stdout) => {
      if (error) {
        reject(new Error("无法完全关闭 ChatGPT Codex，已取消本次切换或删除。请手动退出 ChatGPT Codex 后重试。"));
        return;
      }
      resolve(Number.parseInt(stdout.trim(), 10) || 0);
    });
  });
}

function inspectOfficialCodexProcessesAsync() {
  if (process.platform !== "win32") return Promise.resolve({ count: 0, inspected: false, processIds: [] });
  const script = officialCodexProcessScript({ mode: "inspect", currentPid: process.pid });
  return new Promise((resolve) => {
    execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 10_000
    }, (error, stdout) => {
      if (error) {
        resolve({ count: 0, inspected: false, processIds: [] });
        return;
      }
      try {
        resolve(normalizeOfficialProcessSnapshot({ ...JSON.parse(stdout), inspected: true }));
      } catch {
        resolve({ count: 0, inspected: false, processIds: [] });
      }
    });
  });
}

function inspectOfficialCodexDesktopProcessesAsync() {
  if (process.platform !== "win32") return Promise.resolve({ count: 0, inspected: false, processIds: [] });
  const script = officialCodexProcessScript({ mode: "inspect", currentPid: process.pid, desktopOnly: true });
  return new Promise((resolve) => {
    execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 10_000
    }, (error, stdout) => {
      if (error) {
        resolve({ count: 0, inspected: false, processIds: [] });
        return;
      }
      try {
        resolve(normalizeOfficialProcessSnapshot({ ...JSON.parse(stdout), inspected: true }));
      } catch {
        resolve({ count: 0, inspected: false, processIds: [] });
      }
    });
  });
}

function normalizeOfficialProcessSnapshot(value) {
  const latestAppServerStartMs = value?.latestAppServerStartMs == null
    ? undefined
    : Number(value.latestAppServerStartMs);
  const processIds = [...new Set(Array.isArray(value?.processIds)
    ? value.processIds.map((pid) => Number(pid)).filter((pid) => Number.isSafeInteger(pid) && pid > 0)
    : [])].sort((left, right) => left - right);
  return {
    count: Math.max(0, Number(value?.count) || 0),
    hostCount: Math.max(0, Number(value?.hostCount) || 0),
    appServerCount: Math.max(0, Number(value?.appServerCount) || 0),
    inspected: value?.inspected === true,
    processIds,
    ...(Number.isFinite(latestAppServerStartMs) ? { latestAppServerStartMs } : {})
  };
}

function normalizeAutoResumeState(value) {
  const attemptId = normalizeTicketText(value?.attemptId);
  const createdAtMs = finiteTime(value?.createdAtMs);
  const updatedAtMs = finiteTime(value?.updatedAtMs);
  const turnId = normalizeTicketText(value?.turnId);
  const resumeMethod = AUTO_RESUME_METHODS.has(value?.resumeMethod) ? value.resumeMethod : undefined;
  if (attemptId && createdAtMs && updatedAtMs && resumeMethod && Array.isArray(value?.items)) {
    const items = value.items.map(normalizeAutoResumeQueueItem).filter(Boolean);
    if (items.length !== value.items.length || items.length < 2) return {};
    const uniqueThreadIds = new Set(items.map(({ threadId }) => threadId));
    if (uniqueThreadIds.size !== items.length) return {};
    return { attemptId, resumeMethod, items, createdAtMs, updatedAtMs };
  }
  const threadId = normalizeTicketText(value?.threadId);
  const interruptedAtMs = finiteTime(value?.interruptedAtMs);
  const stage = ["prepared", "launch_verified", "thread_opened", "turn_started"].includes(value?.stage) && !resumeMethod
    ? "uncertain"
    : AUTO_RESUME_STAGES.has(value?.stage) ? value.stage : undefined;
  const priorStage = (stage === "uncertain" && ["prepared", "launch_verified", "waiting_for_desktop", "turn_started"].includes(value?.priorStage))
    || (stage === "prepared" && ["launch_verified", "waiting_for_desktop"].includes(value?.priorStage))
    ? value.priorStage
    : undefined;
  const failureReason = ["failed", "uncertain", "waiting_for_desktop"].includes(stage)
    && AUTO_RESUME_FAILURE_REASONS.has(value?.failureReason)
    ? value.failureReason
    : undefined;
  const desktopPhase = AUTO_RESUME_DESKTOP_PHASES.has(value?.desktopPhase) ? value.desktopPhase : undefined;
  const phaseStartedAtMs = desktopPhase ? finiteTime(value?.phaseStartedAtMs) : undefined;
  const phaseDeadlineAtMs = phaseStartedAtMs ? finiteTime(value?.phaseDeadlineAtMs) : undefined;
  const submitInvoked = value?.submitInvoked === true;
  if (!attemptId || !threadId || !interruptedAtMs || !createdAtMs || !updatedAtMs || !stage) return {};
  return {
    attemptId,
    threadId,
    interruptedAtMs,
    reason: normalizeResumeReason(value?.reason),
    ...(resumeMethod ? { resumeMethod } : {}),
    ...(turnId ? { turnId } : {}),
    ...(failureReason ? { failureReason } : {}),
    ...(desktopPhase ? { desktopPhase } : {}),
    ...(phaseStartedAtMs ? { phaseStartedAtMs } : {}),
    ...(submitInvoked && finiteTime(value.submissionStartedAtMs) ? { submissionStartedAtMs: finiteTime(value.submissionStartedAtMs) } : {}),
    ...(phaseDeadlineAtMs ? { phaseDeadlineAtMs } : {}),
    ...(submitInvoked ? { submitInvoked: true } : {}),
    stage,
    ...(priorStage ? { priorStage } : {}),
    createdAtMs,
    updatedAtMs
  };
}

function protocolStartFailureStage(started) {
  return started?.outcome === "uncertain" ? "uncertain" : "failed";
}

function normalizeAutoResumeQueueItem(value) {
  const threadId = normalizeTicketText(value?.threadId);
  const interruptedAtMs = finiteTime(value?.interruptedAtMs);
  const updatedAtMs = finiteTime(value?.updatedAtMs);
  const turnId = normalizeTicketText(value?.turnId);
  const stage = AUTO_RESUME_STAGES.has(value?.stage) ? value.stage : undefined;
  const priorStage = (stage === "uncertain" && ["prepared", "launch_verified", "waiting_for_desktop", "turn_started"].includes(value?.priorStage))
    || (stage === "prepared" && ["launch_verified", "waiting_for_desktop"].includes(value?.priorStage))
    ? value.priorStage
    : undefined;
  const failureReason = ["failed", "uncertain", "waiting_for_desktop"].includes(stage)
    && AUTO_RESUME_FAILURE_REASONS.has(value?.failureReason)
    ? value.failureReason
    : undefined;
  const desktopPhase = AUTO_RESUME_DESKTOP_PHASES.has(value?.desktopPhase) ? value.desktopPhase : undefined;
  const phaseStartedAtMs = desktopPhase ? finiteTime(value?.phaseStartedAtMs) : undefined;
  const phaseDeadlineAtMs = phaseStartedAtMs ? finiteTime(value?.phaseDeadlineAtMs) : undefined;
  const submitInvoked = value?.submitInvoked === true;
  if (!threadId || !interruptedAtMs || !updatedAtMs || !stage) return undefined;
  return {
    threadId,
    interruptedAtMs,
    reason: normalizeResumeReason(value?.reason),
    ...(turnId ? { turnId } : {}),
    ...(failureReason ? { failureReason } : {}),
    ...(desktopPhase ? { desktopPhase } : {}),
    ...(phaseStartedAtMs ? { phaseStartedAtMs } : {}),
    ...(submitInvoked && finiteTime(value.submissionStartedAtMs) ? { submissionStartedAtMs: finiteTime(value.submissionStartedAtMs) } : {}),
    ...(phaseDeadlineAtMs ? { phaseDeadlineAtMs } : {}),
    ...(submitInvoked ? { submitInvoked: true } : {}),
    stage,
    ...(priorStage ? { priorStage } : {}),
    updatedAtMs
  };
}

function summarizeAutoResumeQueue(queue, nowMs = Date.now()) {
  const items = Array.isArray(queue?.items) ? queue.items : [];
  const total = items.length;
  const started = items.filter(({ stage }) => ["turn_started", "completed"].includes(stage)).length;
  const failed = items.filter(({ stage }) => stage === "failed").length;
  const uncertain = items.filter(({ stage }) => stage === "uncertain").length;
  const skipped = items.filter(({ stage }) => stage === "skipped").length;
  const pending = items.filter(({ stage }) => ["prepared", "launch_verified", "waiting_for_desktop"].includes(stage)).length;
  return {
    status: pending > 0 ? "multi_pending" : "multi_complete",
    total,
    started,
    failed,
    uncertain,
    skipped,
    pending,
    ...summarizeAutoResumeProgress(items, nowMs)
  };
}

function summarizeAutoResumeTicket(ticket, nowMs = Date.now()) {
  const stage = AUTO_RESUME_STAGES.has(ticket?.stage) ? ticket.stage : undefined;
  if (!stage || !ticket?.threadId) return { status: stage ?? "none" };
  return {
    status: stage,
    total: 1,
    started: ["turn_started", "completed"].includes(stage) ? 1 : 0,
    failed: stage === "failed" ? 1 : 0,
    uncertain: stage === "uncertain" ? 1 : 0,
    skipped: 0,
    pending: ["prepared", "launch_verified", "waiting_for_desktop"].includes(stage) ? 1 : 0,
    ...summarizeAutoResumeProgress([ticket], nowMs)
  };
}

function summarizeAutoResumeProgress(items, nowMs) {
  let currentIndex = items.findIndex(({ stage }) => stage === "launch_verified");
  if (currentIndex < 0) currentIndex = items.findIndex(({ stage }) => stage === "prepared");
  if (currentIndex < 0) currentIndex = items.findIndex(({ stage }) => stage === "waiting_for_desktop");
  if (currentIndex < 0) return {};
  const current = items[currentIndex];
  const desktopPhase = current.stage === "launch_verified" ? current.desktopPhase : undefined;
  const phaseStartedAtMs = desktopPhase ? finiteTime(current.phaseStartedAtMs) : undefined;
  const phaseDeadlineAtMs = phaseStartedAtMs ? finiteTime(current.phaseDeadlineAtMs) : undefined;
  const elapsedSeconds = phaseStartedAtMs
    ? Math.max(0, Math.floor((nowMs - phaseStartedAtMs) / 1_000))
    : Math.max(0, Math.floor((nowMs - current.updatedAtMs) / 1_000));
  const phaseRemainingSeconds = phaseDeadlineAtMs
    ? Math.max(0, Math.ceil((phaseDeadlineAtMs - nowMs) / 1_000))
    : undefined;
  const laterPrepared = items.slice(currentIndex + 1).filter(({ stage }) => stage === "prepared").length;
  const currentBoundSeconds = phaseRemainingSeconds
    ?? (current.stage === "prepared" ? AUTO_RESUME_DESKTOP_PROCESS_MS / 1_000 : undefined);
  const queueRemainingUpperBoundSeconds = Number.isFinite(currentBoundSeconds)
    ? currentBoundSeconds + laterPrepared * (AUTO_RESUME_DESKTOP_PROCESS_MS / 1_000)
    : undefined;
  return {
    currentIndex: currentIndex + 1,
    currentStage: current.stage,
    ...(desktopPhase ? { desktopPhase } : {}),
    ...(phaseStartedAtMs ? { phaseStartedAtMs } : {}),
    ...(phaseDeadlineAtMs ? { phaseDeadlineAtMs } : {}),
    elapsedSeconds,
    ...(Number.isFinite(phaseRemainingSeconds) ? { phaseRemainingSeconds } : {}),
    ...(Number.isFinite(queueRemainingUpperBoundSeconds) ? { queueRemainingUpperBoundSeconds } : {})
  };
}

function skippedAutoResumeQueue(total) {
  return { status: "multi_complete", total, started: 0, failed: 0, uncertain: 0, skipped: total };
}

function normalizeTicketText(value) {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 200) : undefined;
}

function officialProcessInfoResolver(snapshot) {
  const officialIds = new Set(snapshot?.inspected === true ? snapshot.processIds : []);
  return (pid) => officialIds.has(Number(pid)) ? THREADS_OFFICIAL_PROCESS : undefined;
}

function taskActivityOptions(processRegistry, officialProcessSnapshot, nowMs) {
  const activeProcesses = Array.isArray(processRegistry?.processes) ? processRegistry.processes : [];
  const registeredThreadIds = Array.isArray(processRegistry?.registeredThreadIds) ? processRegistry.registeredThreadIds : [];
  const inspectedOfficialProcessCount = Math.max(0, Number(
    officialProcessSnapshot?.hostCount ?? officialProcessSnapshot?.count
  ) || 0);
  const appServerCount = Math.max(0, Number(officialProcessSnapshot?.appServerCount) || 0);
  const inspectedAppServerStartMs = officialProcessSnapshot?.latestAppServerStartMs == null
    ? undefined
    : Number(officialProcessSnapshot.latestAppServerStartMs);
  const officialHostSnapshotRequestedAtMs = Number(officialProcessSnapshot?.officialHostSnapshotRequestedAtMs);
  const officialProcessCount = Math.max(activeProcesses.length, inspectedOfficialProcessCount);
  return {
    nowMs,
    liveThreadIds: [...new Set([
      ...activeProcesses.map((item) => item.threadId).filter(Boolean),
      ...registeredThreadIds
    ])],
    officialHostState: officialProcessCount > 0
      ? "present"
      : officialProcessSnapshot?.inspected === true ? "absent" : "unknown",
    ...(Number.isFinite(officialHostSnapshotRequestedAtMs) ? { officialHostSnapshotRequestedAtMs } : {}),
    latestOfficialAppServerStartMs: appServerCount === 1 && Number.isFinite(inspectedAppServerStartMs)
      ? inspectedAppServerStartMs
      : undefined
  };
}

function taskActivityIndexingStatus() {
  return {
    isBusy: true,
    isUncertain: true,
    reason: "task_activity_indexing",
    activeThreadIds: [],
    activeTasks: [],
    threadIdUnavailable: true,
    activityIndexing: true
  };
}

function restoreTaskActivityCache(entries, codexDir) {
  const cache = new Map();
  const sessionsRoot = path.resolve(codexDir, "sessions");
  if (!Array.isArray(entries)) return cache;
  for (const entry of entries) {
    const [cachePath, state] = Array.isArray(entry) ? entry : [];
    const resolvedPath = typeof cachePath === "string" ? path.resolve(cachePath) : "";
    const relativePath = resolvedPath ? path.relative(sessionsRoot, resolvedPath) : "";
    if (!relativePath || relativePath === ".." || relativePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath)) continue;
    const offset = Number(state?.offset);
    if (!Number.isSafeInteger(offset) || offset < 0 || !state || typeof state !== "object" || Array.isArray(state)) continue;
    cache.set(resolvedPath, {
      ...state,
      offset,
      remainder: Buffer.alloc(0),
      activeThreadIds: Array.isArray(state.activeThreadIds) ? state.activeThreadIds.filter((id) => typeof id === "string") : []
    });
  }
  return cache;
}

function getCodexActivityStatus({ codexDir, isProcessAlive: processAlive, getProcessInfo: processInfo, nowMs, activityWindowMs, taskActivityCache, inspectOfficialProcesses, readProcessRegistry, processRegistryOverride, taskActivityOverride, latestActivityOverride }) {
  const processRegistry = processRegistryOverride ?? activeChatProcesses(codexDir, processAlive, processInfo, readProcessRegistry, nowMs, activityWindowMs);
  const registeredThreadIds = processRegistry.registeredThreadIds ?? [];
  const officialProcessSnapshot = inspectOfficialProcesses?.() ?? { count: 0 };
  const inspectedOfficialProcessCount = Math.max(0, Number(
    officialProcessSnapshot.hostCount ?? officialProcessSnapshot.count
  ) || 0);
  const appServerCount = Math.max(0, Number(officialProcessSnapshot.appServerCount) || 0);
  const inspectedAppServerStartMs = officialProcessSnapshot.latestAppServerStartMs == null
    ? undefined
    : Number(officialProcessSnapshot.latestAppServerStartMs);
  const latestOfficialAppServerStartMs = appServerCount === 1 && Number.isFinite(inspectedAppServerStartMs)
    ? inspectedAppServerStartMs
    : undefined;
  const processRegistryDiagnostic = {
    state: processRegistry.state,
    ...(processRegistry.reason ? { reason: processRegistry.reason } : {}),
    ...(Number.isFinite(processRegistry.lastWriteMs) ? { lastWriteMs: processRegistry.lastWriteMs } : {}),
    ...(Number.isFinite(latestOfficialAppServerStartMs) ? { latestOfficialAppServerStartMs } : {}),
    ...(processRegistry.ignoredStaleTaskCount > 0 ? { ignoredStaleTaskCount: processRegistry.ignoredStaleTaskCount } : {}),
    ...(Number.isFinite(processRegistry.oldestStaleEvidenceAtMs)
      ? { oldestStaleEvidenceAtMs: processRegistry.oldestStaleEvidenceAtMs }
      : {}),
    ...(Number.isFinite(processRegistry.lastWriteMs) && Number.isFinite(latestOfficialAppServerStartMs)
      && processRegistry.lastWriteMs < latestOfficialAppServerStartMs
      ? { predatesAppServerStart: true }
      : {})
  };
  const activeProcesses = processRegistry.processes;
  const officialProcessCount = Math.max(activeProcesses.length, inspectedOfficialProcessCount);
  const officialHostState = officialProcessCount > 0
    ? "present"
    : officialProcessSnapshot.inspected === true ? "absent" : "unknown";
  const processEvidenceSource = activeProcesses.length > 0
    ? "process_registry"
    : inspectedOfficialProcessCount > 0 ? "official_process_scan" : "none";
  const liveThreadIds = [...new Set([
    ...activeProcesses.map((item) => item.threadId).filter(Boolean),
    ...registeredThreadIds
  ])];
  const taskActivity = taskActivityOverride ?? inspectCodexTaskActivity(codexDir, taskActivityCache, {
    nowMs,
    liveThreadIds,
    officialHostState,
    latestOfficialAppServerStartMs
  });
  if (activeProcesses.length > 0 || registeredThreadIds.length > 0) {
    const processThreadIds = activeProcesses.map((item) => item.threadId).filter(Boolean);
    const registryThreadIds = [...new Set([...processThreadIds, ...registeredThreadIds])];
    const taskThreadIds = taskActivity.isBusy ? taskActivity.activeThreadIds : [];
    const activeThreadIds = [...new Set([...registryThreadIds, ...taskThreadIds])].sort();
    const taskAssociationConfidence = activeThreadIds.length > 0 && activeThreadIds.every((id) => processThreadIds.includes(id))
      ? "verified"
      : activeThreadIds.some((id) => processThreadIds.includes(id)) ? "partial"
        : activeThreadIds.length > 0 ? "unavailable" : "none";
    const activeTasks = Array.isArray(taskActivity.activeTasks) ? taskActivity.activeTasks : [];
    const taskFallbacks = new Map(activeTasks.map((task) => [task.id, task.displayName]));
    const taskActivityLevels = new Map(activeTasks
      .filter((task) => typeof task?.id === "string"
        && ["top_level", "subagent", "unknown"].includes(task.activityLevel))
      .map((task) => [task.id, task.activityLevel]));
    const hasLifecycleOnlyTask = taskThreadIds.some((id) => !registryThreadIds.includes(id));
    const threadIdUnavailable = activeProcesses.some((item) => !item.threadId)
      || (taskActivity.isBusy && taskActivity.threadIdUnavailable)
      || activeThreadIds.length === 0;
    const activityParts = [];
    if (activeProcesses.length > 0) {
      activityParts.push(`processes:${[...processThreadIds].sort().join(",") || "unknown"}`);
    }
    if (registryThreadIds.length > 0) {
      activityParts.push(`registry:${[...registryThreadIds].sort().join(",")}`);
    }
    if (hasLifecycleOnlyTask && taskActivity.activityKey) {
      activityParts.push(taskActivity.activityKey);
    }
    return {
      isBusy: true,
      reason: activeProcesses.length > 0 ? "active_chat_process" : "active_registry_task",
      activeProcessCount: activeProcesses.length,
      officialProcessCount,
      activeThreadIds,
      activeTasks: resolveTaskDisplayNames(codexDir, activeThreadIds, taskFallbacks, taskActivityLevels),
      threadIdUnavailable,
      processRegistryState: processRegistry.state,
      processRegistryDiagnostic,
      processEvidenceSource,
      taskEvidenceSource: hasLifecycleOnlyTask ? "mixed" : "process_registry",
      taskAssociationConfidence,
      activityIndexing: Boolean(taskActivity.activityIndexing),
      activityKey: activityParts.join("|"),
      lastActivityAt: undefined,
      activitySnapshot: taskActivity.activitySnapshot,
      taskActivity
    };
  }

  if (taskActivity.isBusy) {
    return {
      isBusy: true,
      reason: taskActivity.reason,
      activeProcessCount: officialProcessCount,
      officialProcessCount,
      lastActivityAt: undefined,
      activeThreadIds: taskActivity.activeThreadIds,
      activeTasks: taskActivity.activeTasks,
      threadIdUnavailable: taskActivity.threadIdUnavailable,
      processRegistryState: processRegistry.state,
      processRegistryDiagnostic,
      processEvidenceSource,
      taskEvidenceSource: "lifecycle",
      taskAssociationConfidence: "unavailable",
      activityIndexing: Boolean(taskActivity.activityIndexing),
      activityKey: taskActivity.activityKey,
      activitySnapshot: taskActivity.activitySnapshot,
      taskActivity
    };
  }

  const latestActivity = latestActivityOverride ?? latestCodexActivity(codexDir);
  if (latestActivity && nowMs - latestActivity.mtimeMs <= activityWindowMs) {
    return {
      isBusy: true,
      reason: "recent_session_activity",
      activeProcessCount: 0,
      officialProcessCount,
      lastActivityAt: latestActivity.mtimeMs,
      activeThreadIds: [],
      activeTasks: [],
      threadIdUnavailable: true,
      processRegistryState: processRegistry.state,
      processRegistryDiagnostic,
      processEvidenceSource,
      taskEvidenceSource: "recent_rollout",
      taskAssociationConfidence: "none",
      activityIndexing: Boolean(taskActivity.activityIndexing),
      activityKey: rolloutActivityKey(latestActivity),
      activitySnapshot: latestActivity
    };
  }

  const activeThreadIds = taskActivity.activeThreadIds ?? [];
  return {
    isBusy: false,
    reason: officialProcessCount > 0 ? "unassociated_official_process" : "idle",
    activeProcessCount: 0,
    officialProcessCount,
    activeThreadIds,
    activeTasks: [],
    threadIdUnavailable: officialProcessCount > 0,
    processRegistryState: processRegistry.state,
    processRegistryDiagnostic,
    processEvidenceSource,
    taskEvidenceSource: "none",
    taskAssociationConfidence: officialProcessCount > 0 ? "unavailable" : "none",
    activityIndexing: Boolean(taskActivity.activityIndexing),
    lastActivityAt: latestActivity?.mtimeMs,
    activityKey: latestActivity ? rolloutActivityKey(latestActivity, activeThreadIds) : "idle",
    activitySnapshot: latestActivity
  };
}

function rolloutActivityKey(snapshot, threadIds = []) {
  const ids = [...new Set(threadIds)].sort().join(",");
  return `rollout:${ids || "unknown"}:${path.basename(snapshot.path)}:${snapshot.size}:${snapshot.mtimeMs}`;
}

function activeChatProcesses(codexDir, processAlive, processInfo, readRegistry = readCodexProcessRegistry, nowMs = Date.now(), activityWindowMs = 30_000) {
  const chatProcessesPath = path.join(codexDir, "process_manager", "chat_processes.json");
  let registryBytes;
  let lastWriteMs;
  try {
    ({ bytes: registryBytes, lastWriteMs } = readRegistry(chatProcessesPath));
  } catch (error) {
    return error?.code === "ENOENT"
      ? { state: "missing", reason: "not_found", processes: [], registeredThreadIds: [] }
      : error?.code === "PROCESS_REGISTRY_UNSTABLE"
        ? { state: "corrupt", reason: "unstable", processes: [], registeredThreadIds: [] }
      : { state: "corrupt", reason: "unreadable", processes: [], registeredThreadIds: [] };
  }
  if (registryBytes.length > 0 && registryBytes.every((byte) => byte === 0)) {
    return { state: "corrupt", reason: "all_zero", lastWriteMs, processes: [], registeredThreadIds: [] };
  }
  try {
    const value = JSON.parse(registryBytes.toString("utf8"));
    const items = Array.isArray(value) ? value : Object.values(value ?? {});
    const processes = new Map();
    const rows = [];
    for (const item of items) {
      const threadId = typeof item?.conversationId === "string" && item.conversationId.trim()
        ? item.conversationId.trim()
        : typeof item?.turnId === "string" && item.turnId.trim()
          ? item.turnId.trim()
          : undefined;
      const pid = Number(item?.osPid);
      if (Number.isInteger(pid) && pid > 0) {
        processes.set(pid, { pid, threadId });
      }
      rows.push({ item, threadId, pid });
    }
    const active = [];
    for (const [pid, item] of processes) {
      if (processAlive(pid) && (!processInfo || isOfficialCodexProcess(processInfo(pid)))) {
        active.push(item);
      }
    }
    const activePids = new Set(active.map((item) => item.pid));
    const registeredThreadIds = new Set();
    for (const item of active) {
      if (item.threadId) registeredThreadIds.add(item.threadId);
    }
    let ignoredStaleTaskCount = 0;
    let oldestStaleEvidenceAtMs;
    for (const row of rows) {
      if (!row.threadId || activePids.has(row.pid)) continue;
      const commandPid = Number(row.item?.processId);
      const commandIsAlive = Number.isInteger(commandPid) && commandPid > 0 && processAlive(commandPid);
      const rowEvidenceAtMs = firstFiniteTime(row.item?.updatedAtMs, row.item?.startedAtMs, lastWriteMs);
      const evidenceAgeMs = nowMs - rowEvidenceAtMs;
      const isRecent = Number.isFinite(evidenceAgeMs) && evidenceAgeMs >= 0 && evidenceAgeMs <= activityWindowMs;
      if (commandIsAlive || isRecent) {
        registeredThreadIds.add(row.threadId);
        continue;
      }
      ignoredStaleTaskCount += 1;
      if (Number.isFinite(rowEvidenceAtMs)) {
        oldestStaleEvidenceAtMs = Math.min(oldestStaleEvidenceAtMs ?? rowEvidenceAtMs, rowEvidenceAtMs);
      }
    }
    return {
      state: "valid",
      lastWriteMs,
      processes: active,
      registeredThreadIds: [...registeredThreadIds].sort(),
      ignoredStaleTaskCount,
      oldestStaleEvidenceAtMs
    };
  } catch {
    return { state: "corrupt", reason: "malformed_json", lastWriteMs, processes: [], registeredThreadIds: [] };
  }
}

function firstFiniteTime(...values) {
  for (const value of values) {
    const time = Number(value);
    if (Number.isFinite(time) && time >= 0) return time;
  }
  return undefined;
}

export function readCodexProcessRegistry(filePath, fsImpl = fs) {
  const fd = fsImpl.openSync(filePath, "r");
  try {
    const before = fsImpl.fstatSync(fd);
    const bytes = fsImpl.readFileSync(fd);
    const after = fsImpl.fstatSync(fd);
    const sameIdentity = before.dev === after.dev
      && (!before.ino || !after.ino || before.ino === after.ino);
    if (!sameIdentity || before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
      throw Object.assign(new Error("Process registry changed during read."), {
        code: "PROCESS_REGISTRY_UNSTABLE"
      });
    }
    return { lastWriteMs: after.mtimeMs, bytes };
  } finally {
    fsImpl.closeSync(fd);
  }
}

function latestCodexActivity(codexDir) {
  const candidates = [
    ...latestMatchingFiles(path.join(codexDir, "sessions"), /^rollout-.*\.jsonl$/)
  ];
  return candidates.sort((left, right) => right.mtimeMs - left.mtimeMs)[0];
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function getProcessInfo(pid) {
  if (process.platform !== "win32") {
    return undefined;
  }
  const script = `
$process = Get-CimInstance Win32_Process -Filter "ProcessId = ${Number(pid) || 0}" -ErrorAction SilentlyContinue
if ($process) {
  [pscustomobject]@{
    name = $process.Name
    executablePath = $process.ExecutablePath
    processId = $process.ProcessId
    parentProcessId = $process.ParentProcessId
  } | ConvertTo-Json -Compress
}
`;
  try {
    const output = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 5_000
    }).trim();
    return output ? JSON.parse(output) : undefined;
  } catch {
    return undefined;
  }
}

function isUsableAutoSwitchTarget(account, now) {
  return pickBest([account], now)?.id === account.id;
}

function isQuotaExhaustedPublic(account) {
  return isQuotaExhaustedUsage(account?.usage);
}

function isQuotaExhaustedUsage(usage) {
  return usage?.executionLimited === true
    || isUsageWindowExhausted(usage?.fiveHour)
    || isUsageWindowExhausted(usage?.oneWeek);
}

function executionLimitAppliesToUsage(limitedUsage, canonicalUsage) {
  if (limitedUsage?.executionLimited !== true) return false;
  const windowName = limitedUsage.executionLimitWindow;
  const limitedAtMs = finiteTime(limitedUsage.executionLimitedAtMs);
  const window = windowName === "fiveHour" || windowName === "oneWeek"
    ? canonicalUsage?.[windowName]
    : undefined;
  const resetAtMs = Number(window?.resetAt) * 1_000;
  const windowMs = Number(window?.windowSeconds) * 1_000;
  return limitedAtMs !== undefined
    && Number.isFinite(resetAtMs)
    && Number.isFinite(windowMs)
    && windowMs > 0
    && limitedAtMs >= resetAtMs - windowMs
    && limitedAtMs < resetAtMs;
}

function isUsageWindowExhausted(window) {
  return Boolean(window) && Number(window.usedPercent) >= 100;
}

function projectUsageLimitExhaustion(usage, interruptedAtMs, nowMs) {
  if (!usage || typeof usage !== "object") return usage;
  const candidates = ["fiveHour", "oneWeek"].flatMap((windowName) => {
    const window = usage[windowName];
    const resetAtMs = Number(window?.resetAt) * 1_000;
    const windowMs = Number(window?.windowSeconds) * 1_000;
    if (!Number.isFinite(resetAtMs) || !Number.isFinite(windowMs) || windowMs <= 0) return [];
    if (nowMs >= resetAtMs || interruptedAtMs < resetAtMs - windowMs || interruptedAtMs >= resetAtMs) return [];
    const remaining = Number.isFinite(Number(window.remainingPercent))
      ? Number(window.remainingPercent)
      : 100 - Number(window.usedPercent);
    return Number.isFinite(remaining) ? [{ windowName, remaining }] : [];
  });
  if (candidates.length === 0) return usage;
  candidates.sort((left, right) => left.remaining - right.remaining || left.windowName.localeCompare(right.windowName));
  const windowName = candidates[0].windowName;
  return {
    ...usage,
    executionLimited: true,
    executionLimitWindow: windowName,
    executionLimitSource: "codex_usage_limit_exceeded",
    executionLimitedAtMs: interruptedAtMs
  };
}

function assertRecoverySelection(selection, action) {
  const keys = selection && typeof selection === "object" && !Array.isArray(selection) ? Object.keys(selection).sort() : [];
  const completePoint = keys.length === 1 && keys[0] === "recoveryPointId";
  const independent = keys.length === 2 && keys[0] === "conversationId" && keys[1] === "criticalId";
  if (!completePoint && !independent) {
    throw new Error(`${action} accepts only recovery generation IDs`);
  }
  if (!Object.values(selection).every((value) => typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value))) {
    throw new Error("Invalid recovery generation ID");
  }
}

function launchOfficialCodex(options = {}) {
  if (process.platform !== "win32") {
    return false;
  }
  const script = buildOfficialCodexLaunchScript(options);
  try {
    execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 10_000
    });
    return true;
  } catch {
    return false;
  }
}

export function normalizeDesktopDiscoveryDiagnostics(value) {
  const result = {};
  for (const key of ["warmupScans", "warmupReady"]) {
    if (Number.isSafeInteger(value?.[key]) && value[key] >= 0) result[key] = Math.min(value[key], 100_000);
  }
  for (const key of ["windows", "controls", "disabled", "offscreen", "bounds", "owner", "unreadable", "mismatched", "matched", "errors", "invokeErrors", "verificationUncertain", "notFocusable", "valueReadonly", "unsupportedControlType", "textReadonly", "readonlyUnknown", "patternUnavailable", "valueReadErrors", "textReadErrors", "propertyReadErrors"]) {
    if (Number.isSafeInteger(value?.[key]) && value[key] >= 0) result[key] = Math.min(value[key], 100_000);
  }
  return result;
}

function submitOfficialCodexContinuation(threadId, options = {}) {
  if (process.platform !== "win32") return Promise.resolve(false);
  let script;
  try {
    script = buildCodexDesktopContinuationScript(threadId, options);
  } catch {
    return Promise.resolve(false);
  }
  let child;
  let phaseBuffer = "";
  const operation = new Promise((resolve) => {
    child = execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-STA", "-Command", script], {
      encoding: "utf8",
      windowsHide: true,
      timeout: AUTO_RESUME_DESKTOP_PROCESS_MS
    }, (error, stdout, stderr) => {
      operation.failureReason = desktopContinuationFailureReason(error, stderr, operation.submitInvoked === true);
      operation.processOutcome = desktopContinuationProcessOutcome(error);
      resolve(!error && stdout.split(/\r?\n/).some((line) => line.trim() === "turn_started"));
    });
    child.stdout?.setEncoding?.("utf8");
    child.stdout?.on?.("data", (chunk) => {
      phaseBuffer += String(chunk);
      let newline;
      while ((newline = phaseBuffer.indexOf("\n")) >= 0) {
        const line = phaseBuffer.slice(0, newline).trim();
        phaseBuffer = phaseBuffer.slice(newline + 1);
        if (line.startsWith("diagnostic:") && line.length < 4096) {
          try { options.onDiagnostic?.(normalizeDesktopDiscoveryDiagnostics(JSON.parse(line.slice(11)))); } catch {}
          continue;
        }
        if (!line.startsWith("phase:")) continue;
        const phase = line.slice(6);
        if (!AUTO_RESUME_DESKTOP_PHASES.has(phase)) continue;
        if (phase === "invoke_started" || phase === "prompt_consumed") operation.submitInvoked = true;
        try { options.onPhase?.(phase); } catch {}
      }
    });
  });
  operation.cancel = () => {
    try { child?.kill(); } catch {}
  };
  return operation;
}

function desktopContinuationProcessOutcome(error) {
  if (!error) return { source: "exit", exitCode: 0 };
  if (error.killed === true || error.code === "ETIMEDOUT") {
    return { source: "timeout", ...(typeof error.signal === "string" ? { signal: error.signal } : {}) };
  }
  if (typeof error.signal === "string") return { source: "signal", signal: error.signal };
  if (Number.isSafeInteger(error.code)) return { source: "exit", exitCode: error.code };
  if (typeof error.code === "string") return { source: "spawn_error", code: error.code.slice(0, 64) };
  return { source: "error" };
}

export function desktopContinuationFailureReason(error, stderr, submitInvoked = false) {
  if (!error) return undefined;
  if (error.killed === true || error.code === "ETIMEDOUT") return "submission_timeout";
  // Only classify helper stderr. Node's error.message can echo the generated
  // PowerShell command and therefore contain unused marker strings.
  const output = String(stderr ?? "");
  if (submitInvoked) {
    if (output.includes("prompt was not consumed")) return "prompt_not_consumed";
    if (output.includes("turn was not observed")) return "turn_not_observed";
    return "submission_error";
  }
  if (output.includes("composer was not found")) return "composer_not_found";
  if (output.includes("submit control was not found")) return "submit_not_found";
  if (output.includes("composer or submit button was not found")) return "composer_or_submit_not_found";
  if (output.includes("prompt was not consumed")) return "prompt_not_consumed";
  if (output.includes("turn was not observed")) return "turn_not_observed";
  if (output.includes("foreground")) return "foreground_changed";
  if (output.includes("focus")) return "composer_focus_failed";
  return "submission_error";
}

export function buildCodexThreadUri(threadId) {
  const normalized = typeof threadId === "string" ? threadId.trim() : "";
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(normalized)) {
    throw new Error("Invalid Codex thread id");
  }
  return `codex://threads/${encodeURIComponent(normalized)}`;
}

export function buildCodexContinuationUri(threadId) {
  return buildCodexThreadUri(threadId) + "?prompt=" + encodeURIComponent(AUTO_RESUME_PROMPT);
}

export function buildCodexDesktopContinuationScript(threadId, options = {}) {
  const uriBase64 = Buffer.from(buildCodexContinuationUri(threadId), "utf8").toString("base64");
  const promptBase64 = Buffer.from(AUTO_RESUME_PROMPT, "utf8").toString("base64");
  const threadIdBase64 = Buffer.from(threadId, "utf8").toString("base64");
  const evidenceStartedAtIso = new Date(finiteTime(options.evidenceStartedAtMs) ?? Date.now()).toISOString();
  return [
    "$ErrorActionPreference = 'Stop'",
    "Add-Type -AssemblyName UIAutomationClient",
    "Add-Type -AssemblyName UIAutomationTypes",
    "Add-Type @'",
    "using System;",
    "using System.Runtime.InteropServices;",
    "public static class CodexForegroundWindow {",
    "  [DllImport(\"user32.dll\")]",
    "  [return: MarshalAs(UnmanagedType.Bool)]",
    "  public static extern bool SetForegroundWindow(IntPtr hWnd);",
    "  [DllImport(\"user32.dll\")]",
    "  public static extern IntPtr GetForegroundWindow();",
    "  [DllImport(\"user32.dll\")]",
    "  [return: MarshalAs(UnmanagedType.Bool)]",
    "  public static extern bool IsIconic(IntPtr hWnd);",
    "  [DllImport(\"user32.dll\")]",
    "  [return: MarshalAs(UnmanagedType.Bool)]",
    "  public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);",
    "  [DllImport(\"user32.dll\")]",
    "  [return: MarshalAs(UnmanagedType.Bool)]",
    "  public static extern bool IsWindow(IntPtr hWnd);",
    "  [StructLayout(LayoutKind.Sequential)]",
    "  public struct POINT { public int X; public int Y; }",
    "  [DllImport(\"user32.dll\")]",
    "  [return: MarshalAs(UnmanagedType.Bool)]",
    "  public static extern bool GetCursorPos(out POINT point);",
    "  [DllImport(\"user32.dll\")]",
    "  [return: MarshalAs(UnmanagedType.Bool)]",
    "  public static extern bool SetCursorPos(int x, int y);",
    "  [DllImport(\"user32.dll\")]",
    "  private static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extraInfo);",
    "  public static void ClickAt(double x, double y) {",
    "    SetCursorPos((int)Math.Round(x), (int)Math.Round(y));",
    "    mouse_event(0x0002, 0, 0, 0, UIntPtr.Zero);",
    "    mouse_event(0x0004, 0, 0, 0, UIntPtr.Zero);",
    "  }",
    "}",
    "'@",
    "function Write-ContinuationPhase($phase) {",
    "  [Console]::Out.WriteLine(\"phase:$phase\")",
    "  [Console]::Out.Flush()",
    "}",
    "function Restore-ContinuationForeground($previous, $target) {",
    "  if ($previous -ne [IntPtr]::Zero -and $previous -ne $target -and [CodexForegroundWindow]::IsWindow($previous)) {",
    "    [CodexForegroundWindow]::SetForegroundWindow($previous) | Out-Null",
    "  }",
    "}",
    "function Restore-ContinuationCursor($captured, $point) {",
    "  if ($captured) { [CodexForegroundWindow]::SetCursorPos($point.X, $point.Y) | Out-Null }",
    "}",
    "function Test-SameAutomationElement($left, $right) {",
    "  try {",
    "    $leftId = @($left.GetRuntimeId())",
    "    $rightId = @($right.GetRuntimeId())",
    "    if ($leftId.Count -ne $rightId.Count) { return $false }",
    "    for ($index = 0; $index -lt $leftId.Count; $index++) {",
    "      if ($leftId[$index] -ne $rightId[$index]) { return $false }",
    "    }",
    "    return $true",
    "  } catch { return $false }",
    "}",
    "function Test-ContinuationPromptValue($value, $expectedPrompt) {",
    "  if ($null -eq $value) { return $false }",
    "  return [String]::Equals(([string]$value).TrimEnd([char[]]\"`r`n\"), $expectedPrompt.TrimEnd([char[]]\"`r`n\"), [StringComparison]::Ordinal)",
    "}",
    "function Read-ContinuationTailLines($path, $maxLines = 256, $maxBytes = 2097152) {",
    "  $stream = $null",
    "  $reader = $null",
    "  try {",
    "    $stream = [System.IO.File]::Open($path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite -bor [System.IO.FileShare]::Delete)",
    "    $offset = [Math]::Max([Int64]0, $stream.Length - [Int64]$maxBytes)",
    "    [void]$stream.Seek($offset, [System.IO.SeekOrigin]::Begin)",
    "    $reader = [System.IO.StreamReader]::new($stream, [System.Text.Encoding]::UTF8, $true, 4096)",
    "    $text = $reader.ReadToEnd()",
    "    return @($text -split \"`r?`n\" | Select-Object -Last $maxLines)",
    "  } catch { return @() }",
    "  finally { if ($reader) { $reader.Dispose() }; if ($stream) { $stream.Dispose() } }",
    "}",
    "function Add-ContinuationReadDiagnostic($diagnostics, $key) {",
    "  if ($null -ne $diagnostics) { $diagnostics[$key] = [Math]::Min(100000, [int]$diagnostics[$key] + 1) }",
    "}",
    "function Get-ContinuationComposerValue($control, $diagnostics = $null) {",
    "  try { if (-not $control.Current.IsKeyboardFocusable) { Add-ContinuationReadDiagnostic $diagnostics 'notFocusable'; return $null } } catch { Add-ContinuationReadDiagnostic $diagnostics 'propertyReadErrors'; return $null }",
    "  $pattern = $null",
    "  try {",
    "    if ($control.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$pattern)) {",
    "      if ($pattern.Current.IsReadOnly) { Add-ContinuationReadDiagnostic $diagnostics 'valueReadonly'; return $null }",
    "      return [string]$pattern.Current.Value",
    "    }",
    "  } catch { Add-ContinuationReadDiagnostic $diagnostics 'valueReadErrors' }",
    "  try { if ($control.Current.ControlType -notin @([System.Windows.Automation.ControlType]::Edit, [System.Windows.Automation.ControlType]::Document)) { Add-ContinuationReadDiagnostic $diagnostics 'unsupportedControlType'; return $null } } catch { Add-ContinuationReadDiagnostic $diagnostics 'propertyReadErrors'; return $null }",
    "  $pattern = $null",
    "  try {",
    "    if ($control.TryGetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern, [ref]$pattern)) {",
    "      $readOnly = $pattern.DocumentRange.GetAttributeValue([System.Windows.Automation.TextPattern]::IsReadOnlyAttribute)",
    "      if ($readOnly -is [bool] -and -not $readOnly) { return [string]$pattern.DocumentRange.GetText(4096) }",
    "      if ($readOnly -is [bool]) { Add-ContinuationReadDiagnostic $diagnostics 'textReadonly' } else { Add-ContinuationReadDiagnostic $diagnostics 'readonlyUnknown' }",
    "      return $null",
    "    }",
    "  } catch { Add-ContinuationReadDiagnostic $diagnostics 'textReadErrors'; return $null }",
    "  Add-ContinuationReadDiagnostic $diagnostics 'patternUnavailable'",
    "  return $null",
    "}",
    "function Wait-ContinuationAccessibility($desktop) {",
    "  $deadline = [DateTime]::UtcNow.AddSeconds(10)",
    "  $stats = @{ warmupScans = 0; warmupReady = 0 }",
    "  do {",
    "    $stats.warmupScans++",
    "    foreach ($window in $desktop.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)) {",
    "      try {",
    "        $process = Get-Process -Id $window.Current.ProcessId -ErrorAction Stop",
    "        if ($process.ProcessName -notin @('ChatGPT', 'Codex') -or $process.Path -notmatch '[\\\\/]OpenAI(?:\\.Codex_|[\\\\/]Codex[\\\\/])') { continue }",
    "        $controls = $window.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)",
    "        foreach ($control in $controls) {",
    "          if (-not $control.Current.IsEnabled -or $control.Current.IsOffscreen) { continue }",
    "          if ($null -ne (Get-ContinuationComposerValue $control)) { $stats.warmupReady = 1; break }",
    "        }",
    "      } catch {}",
    "      if ($stats.warmupReady) { break }",
    "    }",
    "    if ($stats.warmupReady) { break }",
    "    Start-Sleep -Milliseconds 200",
    "  } while ([DateTime]::UtcNow -lt $deadline)",
    "  [Console]::WriteLine('diagnostic:' + ($stats | ConvertTo-Json -Compress))",
    "}",
    "function Test-ContinuationProcessOwner($controlProcessId, $rootProcessId, $rootPath) {",
    "  if ($controlProcessId -eq $rootProcessId) { return $true }",
    "  $key = [string]$rootProcessId + ':' + [string]$controlProcessId",
    "  if ($ownerCache.ContainsKey($key)) { return $ownerCache[$key] }",
    "  $candidateId = $controlProcessId",
    "  $owned = $false",
    "  for ($depth = 0; $depth -lt 8 -and $candidateId -gt 0; $depth++) {",
    "    try {",
    "      $childProcess = Get-CimInstance Win32_Process -Filter (\"ProcessId = \" + [int]$candidateId) -ErrorAction Stop",
    "      if (-not [String]::Equals($childProcess.ExecutablePath, $rootPath, [StringComparison]::OrdinalIgnoreCase)) { break }",
    "      $candidateId = [int]$childProcess.ParentProcessId",
    "      if ($candidateId -eq $rootProcessId) { $owned = $true; break }",
    "    } catch { break }",
    "  }",
    "  $ownerCache[$key] = $owned",
    "  return $owned",
    "}",
    "function Test-ContinuationTurnStarted($rollouts, $startedAtUtc, $expectedPrompt) {",
    "  foreach ($rollout in @($rollouts)) {",
    "    try {",
    "      foreach ($line in @(Read-ContinuationTailLines $rollout.FullName)) {",
    "        try { $entry = $line | ConvertFrom-Json } catch { continue }",
    "        if ($entry.type -ne 'response_item' -or $entry.payload.type -ne 'message' -or $entry.payload.role -ne 'user') { continue }",
    "        try { if ([DateTimeOffset]::Parse([string]$entry.timestamp).UtcDateTime -lt $startedAtUtc) { continue } } catch { continue }",
    "        foreach ($content in @($entry.payload.content)) {",
    "          if ($content.type -eq 'input_text' -and [String]::Equals($content.text.TrimEnd([char[]]\"`r`n\"), $expectedPrompt.TrimEnd([char[]]\"`r`n\"), [StringComparison]::Ordinal)) { return $true }",
    "        }",
    "      }",
    "    } catch {}",
    "  }",
    "  return $false",
    "}",
    "function Find-ContinuationSubmit($composer, $processId) {",
    "  $composerBounds = $composer.Current.BoundingRectangle",
    "  $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker",
    "  $scope = $composer",
    "  $fallbackSubmit = $null",
    "  for ($depth = 0; $depth -lt 8; $depth++) {",
    "    $scope = $walker.GetParent($scope)",
    "    if (-not $scope) { break }",
    "    if ($scope.Current.ControlType -eq [System.Windows.Automation.ControlType]::Window) { break }",
    "    $scopeElements = $scope.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)",
    "    $submitCandidates = @()",
    "    foreach ($control in $scopeElements) {",
    "      try {",
    "        if (-not $control.Current.IsEnabled -or $control.Current.IsOffscreen -or $control.Current.ProcessId -ne $processId) { continue }",
    "        $bounds = $control.Current.BoundingRectangle",
    "        if ($bounds.Width -le 0 -or $bounds.Height -le 0) { continue }",
    "        $centerX = $bounds.Left + ($bounds.Width / 2)",
    "        $centerY = $bounds.Top + ($bounds.Height / 2)",
    "        if ($centerX -lt ($composerBounds.Left + ($composerBounds.Width * 0.6))) { continue }",
    "        if ($centerY -lt ($composerBounds.Top - 40) -or $centerY -gt ($composerBounds.Bottom + 120)) { continue }",
    "        $identity = \"$($control.Current.Name) $($control.Current.AutomationId) $($control.Current.HelpText)\"",
    "        $semantic = if ($identity -match '(?i:send|submit|发送|提交)') { 1 } else { 0 }",
    "        $isButton = $control.Current.ControlType -eq [System.Windows.Automation.ControlType]::Button",
    "        $rightEdgeFallback = $isButton -and $centerX -ge ($composerBounds.Right - 96) -and $identity -notmatch '(?i:voice|dictat|microphone|语音|听写)'",
    "        if ($semantic -eq 0 -and -not $rightEdgeFallback) { continue }",
    "        $invokePattern = $null",
    "        $hasInvoke = $control.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$invokePattern)",
    "        $clickPoint = New-Object System.Windows.Point",
    "        if (-not $hasInvoke -and -not ($isButton -and $control.TryGetClickablePoint([ref]$clickPoint))) { continue }",
    "        $submitCandidates += [pscustomobject]@{ Element = $control; Invoke = $invokePattern; Semantic = $semantic; CenterX = $centerX; Distance = [Math]::Abs($composerBounds.Bottom - $centerY) }",
    "      } catch {}",
    "    }",
    "    if ($submitCandidates.Count -gt 0) {",
    "      $semanticSubmit = $submitCandidates | Where-Object Semantic -eq 1 | Sort-Object @{ Expression = 'CenterX'; Descending = $true }, @{ Expression = 'Distance'; Ascending = $true } | Select-Object -First 1",
    "      if ($semanticSubmit) { return $semanticSubmit }",
    "      if (-not $fallbackSubmit) { $fallbackSubmit = $submitCandidates | Sort-Object @{ Expression = 'CenterX'; Descending = $true }, @{ Expression = 'Distance'; Ascending = $true } | Select-Object -First 1 }",
    "    }",
    "  }",
    "  return $fallbackSubmit",
    "}",
    "function Wait-ContinuationSubmission($composer, $rollouts, $startedAtUtc, $expectedPrompt) {",
    "  $promptConsumed = $false",
    "  $promptConsumptionReported = $false",
    "  $composerUncertain = $false",
    `  $verificationDeadline = [DateTime]::UtcNow.AddSeconds(${AUTO_RESUME_DESKTOP_VERIFICATION_MS / 1000})`,
    "  do {",
    "    if (Test-ContinuationTurnStarted $rollouts $startedAtUtc $expectedPrompt) { return 'turn_started' }",
    "    $value = $null",
    "    try { $value = Get-ContinuationComposerValue $composer } catch { $composerUncertain = $true }",
    "    if ($null -ne $value) {",
    "      if ($value -ceq '') { $promptConsumed = $true }",
    "      elseif (-not (Test-ContinuationPromptValue $value $expectedPrompt)) { $composerUncertain = $true }",
    "    } else { $composerUncertain = $true }",
    "    if ($promptConsumed -and -not $promptConsumptionReported) { Write-ContinuationPhase 'prompt_consumed'; $promptConsumptionReported = $true }",
    "    if ($promptConsumed -and (Test-ContinuationTurnStarted $rollouts $startedAtUtc $expectedPrompt)) { return 'turn_started' }",
    "    Start-Sleep -Milliseconds 100",
    "  } while ([DateTime]::UtcNow -lt $verificationDeadline)",
    "  if (Test-ContinuationTurnStarted $rollouts $startedAtUtc $expectedPrompt) { return 'turn_started' }",
    "  if ($composerUncertain) { [Console]::WriteLine('diagnostic:{\"verificationUncertain\":1}'); return 'turn_not_observed' }",
    "  if (-not $promptConsumed) { return 'prompt_not_consumed' }",
    "  return 'turn_not_observed'",
    "}",
    "$uri = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('" + uriBase64 + "'))",
    "$prompt = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('" + promptBase64 + "'))",
    "$threadId = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('" + threadIdBase64 + "'))",
    "$codexHome = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $env:USERPROFILE '.codex' }",
    "$rollouts = @(Get-ChildItem -LiteralPath (Join-Path $codexHome 'sessions') -Recurse -File -Filter ('*' + $threadId + '*.jsonl') -ErrorAction Stop | Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 2)",
    "if ($rollouts.Count -eq 0) { throw 'Codex continuation rollout was not found.' }",
    "$continuationStartedAtUtc = [DateTimeOffset]::Parse('" + evidenceStartedAtIso + "').UtcDateTime",
    "if (Test-ContinuationTurnStarted $rollouts $continuationStartedAtUtc $prompt) { Write-Output 'turn_started'; exit 0 }",
    "$previousForeground = [CodexForegroundWindow]::GetForegroundWindow()",
    "$windowHandle = [IntPtr]::Zero",
    "try {",
    "$desktop = [System.Windows.Automation.AutomationElement]::RootElement",
    "Wait-ContinuationAccessibility $desktop",
    "if (Test-ContinuationTurnStarted $rollouts $continuationStartedAtUtc $prompt) { Write-Output 'turn_started'; exit 0 }",
    "Start-Process -FilePath $uri | Out-Null",
    "Write-ContinuationPhase 'deep_link_opened'",
    "$desktop = [System.Windows.Automation.AutomationElement]::RootElement",
    "$window = $null",
    "$composer = $null",
    "$submit = $null",
    "$discoveryDeadline = [DateTime]::UtcNow.AddSeconds(10)",
    "$discovery = @{ windows = 0; controls = 0; disabled = 0; offscreen = 0; bounds = 0; owner = 0; unreadable = 0; mismatched = 0; matched = 0; errors = 0 }",
    "do {",
    "  if (Test-ContinuationTurnStarted $rollouts $continuationStartedAtUtc $prompt) { Write-Output 'turn_started'; exit 0 }",
    "  $window = $null",
    "  $composer = $null",
    "  $submit = $null",
    "  $ownerCache = @{}",
    "  Write-ContinuationPhase 'window_scan_started'",
    "  $windows = $desktop.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)",
    "  Write-ContinuationPhase 'window_scan_completed'",
    "  foreach ($candidateWindow in $windows) {",
    "    try {",
    "      $elementProcessId = [int]$candidateWindow.Current.ProcessId",
    "      $elementProcess = Get-Process -Id $elementProcessId -ErrorAction Stop",
    "      if ($elementProcess.ProcessName -notin @('ChatGPT', 'Codex')) { continue }",
    "      if ($elementProcess.Path -notmatch '[\\\\/]OpenAI(?:\\.Codex_|[\\\\/]Codex[\\\\/])') { continue }",
    "      $discovery.windows++",
    "      $windowHandle = [IntPtr]$candidateWindow.Current.NativeWindowHandle",
    "      if ([CodexForegroundWindow]::IsIconic($windowHandle)) {",
    "        [CodexForegroundWindow]::ShowWindowAsync($windowHandle, 9) | Out-Null",
    "        Start-Sleep -Milliseconds 200",
    "      }",
    "      Write-ContinuationPhase 'composer_scan_started'",
    "      $valueControls = $candidateWindow.FindAll(",
    "        [System.Windows.Automation.TreeScope]::Descendants,",
    "        ([System.Windows.Automation.OrCondition]::new([System.Windows.Automation.Condition[]]@(",
    "          [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::IsValuePatternAvailableProperty, $true),",
    "          [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Edit),",
    "          [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Document)",
    "        )))",
    "      )",
    "      Write-ContinuationPhase 'composer_scan_completed'",
    "      foreach ($control in $valueControls) {",
    "        $discovery.controls++",
    "        try {",
    "        if (-not $control.Current.IsEnabled) { $discovery.disabled++; continue }",
    "        if ($control.Current.IsOffscreen) { $discovery.offscreen++; continue }",
    "        $bounds = $control.Current.BoundingRectangle",
    "        if ($bounds.Width -le 0 -or $bounds.Height -le 0) { $discovery.bounds++; continue }",
    "        $value = Get-ContinuationComposerValue $control $discovery",
    "        if ($null -eq $value) { $discovery.unreadable++; continue }",
    "        if (-not (Test-ContinuationPromptValue $value $prompt)) { $discovery.mismatched++; continue }",
    "        if (-not (Test-ContinuationProcessOwner $control.Current.ProcessId $elementProcessId $elementProcess.Path)) { $discovery.owner++; continue }",
    "        $discovery.matched++",
    "        $window = $candidateWindow",
    "        $composer = $control",
    "        $submit = Find-ContinuationSubmit $composer $composer.Current.ProcessId",
    "        if ($submit) { break }",
    "        } catch { $discovery.errors++ }",
    "      }",
    "      if ($composer -and $submit) { break }",
    "    } catch { $discovery.errors++ }",
    "  }",
    "  [Console]::Out.WriteLine('diagnostic:' + ($discovery | ConvertTo-Json -Compress))",
    "  [Console]::Out.Flush()",
    "  if (-not $composer -or -not $submit) { Start-Sleep -Milliseconds 200 }",
    "} while ((-not $composer -or -not $submit) -and [DateTime]::UtcNow -lt $discoveryDeadline)",
    "if (Test-ContinuationTurnStarted $rollouts $continuationStartedAtUtc $prompt) { Write-Output 'turn_started'; exit 0 }",
    "if (-not $composer) { throw 'Codex continuation composer was not found.' }",
    "if (-not $submit) { throw 'Codex continuation submit control was not found.' }",
    "$windowHandle = [IntPtr]$window.Current.NativeWindowHandle",
    "if ($windowHandle -eq [IntPtr]::Zero) { throw 'Codex continuation window handle is unavailable.' }",
    "$elementProcessId = $composer.Current.ProcessId",
    "Write-ContinuationPhase 'window_restored'",
    "Write-ContinuationPhase 'composer_found'",
    "Write-ContinuationPhase 'submit_found'",
    "  [CodexForegroundWindow]::SetForegroundWindow($windowHandle) | Out-Null",
    "  $composer.SetFocus()",
    "  Start-Sleep -Milliseconds 100",
    "  if ([CodexForegroundWindow]::GetForegroundWindow() -ne $windowHandle) { throw 'Codex continuation window did not remain in the foreground.' }",
    "  $focusedComposer = [System.Windows.Automation.AutomationElement]::FocusedElement",
    "  $focusedValue = Get-ContinuationComposerValue $focusedComposer",
    "  if ($null -eq $focusedValue) {",
    "    throw 'Codex continuation composer focus could not be verified.'",
    "  }",
    "  if (-not (Test-SameAutomationElement $focusedComposer $composer) -or $focusedComposer.Current.ProcessId -ne $elementProcessId -or -not (Test-ContinuationPromptValue $focusedValue $prompt)) {",
    "    throw 'Codex continuation composer focus did not match.'",
    "  }",
    "  Write-ContinuationPhase 'focus_verified'",
    "  if ([CodexForegroundWindow]::GetForegroundWindow() -ne $windowHandle) { throw 'Codex continuation foreground changed before submission.' }",
    "  $focusedComposer = [System.Windows.Automation.AutomationElement]::FocusedElement",
    "  $focusedValue = Get-ContinuationComposerValue $focusedComposer",
    "  if ($null -eq $focusedValue -or -not (Test-SameAutomationElement $focusedComposer $composer) -or -not (Test-ContinuationPromptValue $focusedValue $prompt)) {",
    "    throw 'Codex continuation composer changed before submission.'",
    "  }",
    "  $submit = Find-ContinuationSubmit $composer $elementProcessId",
    "  if (-not $submit) { throw 'Codex continuation submit control was not found.' }",
    "  $primaryAction = $null",
    "  Write-ContinuationPhase 'invoke_started'",
    "  $invokeUncertain = $false",
    "  if ($submit.Invoke) { $primaryAction = 'invoke'; try { $submit.Invoke.Invoke() } catch { $invokeUncertain = $true; Write-Output 'diagnostic:{\"invokeErrors\":1}' } }",
    "  else {",
    "    $primaryAction = 'click'",
    "    $clickPoint = New-Object System.Windows.Point",
    "    if (-not $submit.Element.TryGetClickablePoint([ref]$clickPoint)) { throw 'Codex continuation submit control was not found.' }",
    "    $previousCursor = [CodexForegroundWindow+POINT]::new()",
    "    $cursorCaptured = [CodexForegroundWindow]::GetCursorPos([ref]$previousCursor)",
    "    try { [CodexForegroundWindow]::ClickAt($clickPoint.X, $clickPoint.Y) }",
    "    finally { Restore-ContinuationCursor $cursorCaptured $previousCursor }",
    "  }",
    "  try { $primaryOutcome = Wait-ContinuationSubmission $composer $rollouts $continuationStartedAtUtc $prompt } catch { throw 'Codex continuation submission could not be verified.' }",
    "  if ($primaryOutcome -eq 'turn_started') { Write-Output 'turn_started'; exit 0 }",
    "  if ($invokeUncertain) { throw 'Codex continuation submission could not be verified.' }",
    "  if ($primaryOutcome -eq 'turn_not_observed') { throw 'Codex continuation turn was not observed in the rollout.' }",
    "  Write-ContinuationPhase 'invoke_no_effect'",
    "  if (Test-ContinuationTurnStarted $rollouts $continuationStartedAtUtc $prompt) { Write-Output 'turn_started'; exit 0 }",
    "  if ([CodexForegroundWindow]::GetForegroundWindow() -ne $windowHandle) { throw 'Codex continuation foreground changed before fallback submission.' }",
    "  $focusedComposer = [System.Windows.Automation.AutomationElement]::FocusedElement",
    "  $focusedValue = Get-ContinuationComposerValue $focusedComposer",
    "  if ($null -eq $focusedValue -or -not (Test-SameAutomationElement $focusedComposer $composer) -or $focusedComposer.Current.ProcessId -ne $elementProcessId -or -not (Test-ContinuationPromptValue $focusedValue $prompt)) {",
    "    throw 'Codex continuation composer changed before fallback submission.'",
    "  }",
    "  $fallbackSubmit = Find-ContinuationSubmit $composer $elementProcessId",
    "  if (-not $fallbackSubmit) { throw 'Codex continuation prompt was not consumed and no fallback submit control was found.' }",
    "  $fallbackAction = $null",
    "  $fallbackPoint = New-Object System.Windows.Point",
    "  if ($primaryAction -eq 'invoke' -and $fallbackSubmit.Element.TryGetClickablePoint([ref]$fallbackPoint)) { $fallbackAction = 'click' }",
    "  if (-not $fallbackAction) { throw 'Codex continuation prompt was not consumed and no independent fallback action was available.' }",
    "  if (Test-ContinuationTurnStarted $rollouts $continuationStartedAtUtc $prompt) { Write-Output 'turn_started'; exit 0 }",
    "  Write-ContinuationPhase 'fallback_invoke_started'",
    "    $previousCursor = [CodexForegroundWindow+POINT]::new()",
    "    $cursorCaptured = [CodexForegroundWindow]::GetCursorPos([ref]$previousCursor)",
    "    try { [CodexForegroundWindow]::ClickAt($fallbackPoint.X, $fallbackPoint.Y) }",
    "    finally { Restore-ContinuationCursor $cursorCaptured $previousCursor }",
    "  try { $fallbackOutcome = Wait-ContinuationSubmission $composer $rollouts $continuationStartedAtUtc $prompt } catch { throw 'Codex continuation fallback submission could not be verified.' }",
    "  if ($fallbackOutcome -eq 'turn_started') { Write-Output 'turn_started'; exit 0 }",
    "  if ($fallbackOutcome -eq 'prompt_not_consumed') { throw 'Codex continuation prompt was not consumed after fallback submission.' }",
    "  throw 'Codex continuation turn was not observed in the rollout.'",
    "} finally {",
    "  Restore-ContinuationForeground $previousForeground $windowHandle",
    "}"
  ].join("\n");
}

function syncDshCodexAuthWithPowerShell({ scriptPath, sourceAuthPath, targetDirectory, verifyNoActiveDshCodex }) {
  if (process.platform !== "win32") {
    return { status: "skipped", reason: "unsupported_platform" };
  }
  if (!isRegularFilePath(scriptPath)) {
    return { status: "skipped", reason: "script_missing" };
  }
  if (!isDirectoryPath(targetDirectory)) {
    return { status: "skipped", reason: "target_missing" };
  }
  if (!isRegularFilePath(sourceAuthPath)) {
    return { status: "skipped", reason: "source_missing" };
  }
  try {
    const args = [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-WindowStyle",
      "Hidden",
      "-File",
      scriptPath,
      "-SourceAuthPath",
      sourceAuthPath,
      "-TargetDirectory",
      targetDirectory
    ];
    if (verifyNoActiveDshCodex === true) args.push("-VerifyNoActiveDshCodex");
    execFileSync("powershell.exe", args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      timeout: 10_000
    });
    return { status: "synced" };
  } catch (error) {
    const code = typeof error?.code === "string" ? error.code : undefined;
    const signal = typeof error?.signal === "string" ? error.signal : undefined;
    const timedOut = error?.killed === true || code === "ETIMEDOUT";
    const processOutput = `${error?.stdout ?? ""}\n${error?.stderr ?? ""}`;
    const busy = processOutput.includes("An active Codex subagent is still running.");
    return {
      status: "failed",
      retryable: true,
      reason: busy ? "busy" : timedOut ? "timeout" : "process_error"
    };
  }
}

function syncDshCodexAuthWithPowerShellAsync({ scriptPath, sourceAuthPath, targetDirectory, verifyNoActiveDshCodex }) {
  if (process.platform !== "win32") return Promise.resolve({ status: "skipped", reason: "unsupported_platform" });
  if (!isRegularFilePath(scriptPath)) return Promise.resolve({ status: "skipped", reason: "script_missing" });
  if (!isDirectoryPath(targetDirectory)) return Promise.resolve({ status: "skipped", reason: "target_missing" });
  if (!isRegularFilePath(sourceAuthPath)) return Promise.resolve({ status: "skipped", reason: "source_missing" });
  const args = [
    "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden",
    "-File", scriptPath, "-SourceAuthPath", sourceAuthPath, "-TargetDirectory", targetDirectory
  ];
  if (verifyNoActiveDshCodex === true) args.push("-VerifyNoActiveDshCodex");
  return new Promise((resolve) => {
    execFile("powershell.exe", args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      timeout: 10_000
    }, (error, stdout, stderr) => {
      if (!error) {
        resolve({ status: "synced" });
        return;
      }
      const timedOut = error?.killed === true || error?.code === "ETIMEDOUT";
      const processOutput = `${stdout ?? ""}\n${stderr ?? ""}`;
      const busy = processOutput.includes("An active Codex subagent is still running.");
      resolve({
        status: "failed",
        retryable: true,
        reason: busy ? "busy" : timedOut ? "timeout" : "process_error"
      });
    });
  });
}

function sha256RegularFile(filePath) {
  if (!isRegularFilePath(filePath)) return undefined;
  try {
    return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
  } catch {
    return undefined;
  }
}

function normalizeDshAuthSyncResult(value) {
  const status = ["synced", "in_sync", "failed", "skipped"].includes(value?.status) ? value.status : "synced";
  const reason = [
    "busy", "timeout", "process_error", "source_missing", "target_missing", "script_missing",
    "unsupported_platform", "non_default_codex_home", "hash_mismatch"
  ].includes(value?.reason) ? value.reason : "process_error";
  return {
    status,
    ...(status === "failed" || status === "skipped" ? { reason } : {}),
    retryable: value?.retryable === true
  };
}

function isRegularFilePath(filePath) {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function isDirectoryPath(directoryPath) {
  try {
    return fs.statSync(directoryPath).isDirectory();
  } catch {
    return false;
  }
}

function samePath(left, right) {
  try {
    return path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
  } catch {
    return false;
  }
}

function launchOfficialCodexAsync(options = {}) {
  if (process.platform !== "win32") return Promise.resolve(false);
  return new Promise((resolve) => {
    execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", buildOfficialCodexLaunchScript(options)], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 10_000
    }, (error, stdout) => resolve(!error && stdout.trim() === "turn_started"));
  });
}

export function buildOfficialCodexLaunchScript({ disableGpu = false, forceRendererAccessibility = false } = {}) {
  const findApp = `
$app = Get-StartApps | Where-Object { $_.AppID -like 'OpenAI.Codex_*' -or $_.Name -eq 'ChatGPT Codex' -or $_.Name -eq 'ChatGPT' -or $_.Name -eq 'Codex' } | Select-Object -First 1
if (-not $app) {
  throw "ChatGPT Codex app is not installed."
}
`;
  const launchArguments = [
    disableGpu ? "--disable-gpu" : undefined,
    forceRendererAccessibility ? "--force-renderer-accessibility" : undefined
  ].filter(Boolean).join(" ");
  if (!launchArguments) {
    return `${findApp}
Start-Process explorer.exe "shell:AppsFolder\\$($app.AppID)"
Write-Output $app.AppID
`;
  }
  return `${findApp}
$activationCode = @'
using System;
using System.Runtime.InteropServices;

[Flags]
public enum ActivateOptions { None = 0 }

[ComImport]
[Guid("2E941141-7F97-4756-BA1D-9DECDE894A3D")]
[InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IApplicationActivationManager
{
    int ActivateApplication(
        [MarshalAs(UnmanagedType.LPWStr)] string appUserModelId,
        [MarshalAs(UnmanagedType.LPWStr)] string arguments,
        ActivateOptions options,
        out uint processId);
    int ActivateForFile(IntPtr appUserModelId, IntPtr itemArray, IntPtr verb, out uint processId);
    int ActivateForProtocol(IntPtr appUserModelId, IntPtr itemArray, out uint processId);
}

[ComImport]
[Guid("45BA127D-10A8-46EA-8AB7-56EA9078943C")]
public class ApplicationActivationManager {}

public static class PackagedAppLauncher
{
    public static uint Activate(string appUserModelId, string arguments)
    {
        var manager = (IApplicationActivationManager)new ApplicationActivationManager();
        uint processId;
        int result = manager.ActivateApplication(appUserModelId, arguments, ActivateOptions.None, out processId);
        if (result < 0) Marshal.ThrowExceptionForHR(result);
        return processId;
    }
}
'@
Add-Type -TypeDefinition $activationCode -Language CSharp
Write-Output ([PackagedAppLauncher]::Activate($app.AppID, '${launchArguments}'))
`;
}

function unixNow() {
  return Math.floor(Date.now() / 1000);
}
