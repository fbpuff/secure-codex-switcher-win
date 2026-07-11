import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { protectString, unprotectString } from "../core/dpapi.js";
import { extractAccessToken, extractAccountId, summarizeAuth } from "../core/auth-summary.js";
import { fetchUsageSnapshot } from "../core/usage.js";
import { getTokenUsageStats } from "../core/token-usage-stats.js";
import {
  appendQuotaSnapshot,
  buildDailyUsageReport,
  buildWeeklyUsageReport,
  createObservationState,
  pruneObservationState,
  readObservationState,
  readRolloutUsageEvents,
  setActiveAccount,
  startOfPreviousLocalWeek,
  writeObservationState
} from "../core/usage-observations.js";
import { compareAccountsByScore, pickBestAccount as pickBest, pickRecoveryAccount, remainingScore } from "../core/ranking.js";
import { decideAutoSwitchActivity } from "../core/activity-switching.js";
import { atomicWriteJson, atomicWriteText, latestMatchingFiles, readJsonIfExists } from "../core/file-io.js";
import { isOfficialCodexProcess, officialCodexProcessScript } from "../core/official-codex-process.js";
import {
  HTTP_ONLY_PROVIDER_ID,
  ensureCodexHttpOnlyMode,
  readCodexBaseProvider,
  readCodexHttpOnlyStatus,
  setCodexHttpOnlyMode
} from "../core/codex-config.js";
import { migrateCodexHistoryProvider, revertCodexHistoryProvider } from "../core/codex-history.js";
import { inspectCodexTaskActivity } from "../core/codex-task-activity.js";

export function createAccountService(userDataPath, options = {}) {
  return new AccountService(userDataPath, options);
}

class AccountService {
  constructor(userDataPath, options = {}) {
    this.userDataPath = userDataPath;
    this.codexDir = options.codexDir ?? path.join(os.homedir(), ".codex");
    this.fetchImpl = options.fetchImpl;
    this.closeCodexProcesses = options.closeCodexProcesses ?? closeOfficialCodexProcesses;
    this.launchCodex = options.launchCodex ?? launchOfficialCodex;
    this.countCodexProcesses = options.countCodexProcesses ?? countOfficialCodexProcesses;
    this.verifyCodexClosure = options.verifyCodexClosure ?? !options.closeCodexProcesses;
    this.isProcessAlive = options.isProcessAlive ?? isProcessAlive;
    this.getCodexProcessInfo = options.getCodexProcessInfo ?? getProcessInfo;
    this.nowMs = options.nowMs ?? (() => Date.now());
    this.activityWindowMs = options.activityWindowMs ?? 30_000;
    this.taskActivityCache = new Map();
    this.codexAuthPath = path.join(this.codexDir, "auth.json");
    this.codexConfigPath = path.join(this.codexDir, "config.toml");
    this.storePath = path.join(userDataPath, "accounts-store.json");
    this.settingsPath = path.join(userDataPath, "settings.json");
    this.autoSwitchStatePath = path.join(userDataPath, "auto-switch-state.json");
    this.autoSwitchEventsPath = path.join(userDataPath, "auto-switch-events.jsonl");
    this.tokenUsageCachePath = path.join(userDataPath, "token-usage-cache.json");
    this.usageObservationsPath = path.join(userDataPath, "usage-observations.json");
    fs.mkdirSync(userDataPath, { recursive: true });
    this.migratePlaintextBackups();
    this.reconcileActiveAccount("startup");
  }

  listAccounts() {
    this.syncCurrentAuth();
    const store = this.readStore();
    const currentFingerprint = this.currentAuthFingerprint();
    const settings = this.readSettings();
    const now = Math.floor(this.nowMs() / 1000);
    const manualTargetId = settings.autoSwitchTargetMode === "manual" ? settings.manualAutoSwitchTargetAccountId : undefined;
    return store.accounts
      .map((account) => this.publicAccount(account, currentFingerprint))
      .sort((left, right) => {
        if (left.isCurrent !== right.isCurrent) {
          return left.isCurrent ? -1 : 1;
        }
        const leftIsManualTarget = Boolean(manualTargetId && left.id === manualTargetId && !left.isCurrent);
        const rightIsManualTarget = Boolean(manualTargetId && right.id === manualTargetId && !right.isCurrent);
        if (leftIsManualTarget !== rightIsManualTarget) {
          return leftIsManualTarget ? -1 : 1;
        }
        return compareAccountsByScore(left, right, now);
      });
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

  async refreshUsage(accountId, force = false) {
    this.syncCurrentAuth();
    const store = this.readStore();
    const account = this.findAccount(store, accountId);
    const now = Math.floor(this.nowMs() / 1000);
    if (!force && account.status === "ready" && !account.usageError && account.usage?.fetchedAt && now - account.usage.fetchedAt < 60) {
      return account.usage;
    }

    try {
      const authJson = this.decryptAccountAuth(account);
      const accessToken = extractAccessToken(authJson);
      const upstreamAccountId = extractAccountId(authJson, account.accountId);
      const usage = await fetchUsageSnapshot({
        accessToken,
        accountId: upstreamAccountId,
        fetchImpl: this.fetchImpl ?? fetch,
        now: () => now
      });
      const latestStore = this.readStore();
      const latestAccount = latestStore.accounts.find((item) => item.id === accountId);
      if (latestAccount) {
        latestAccount.usage = usage;
        latestAccount.planType = usage.planType ?? latestAccount.planType;
        latestAccount.usageError = undefined;
        latestAccount.usageRefreshAttemptedAt = now;
        latestAccount.status = "ready";
        latestAccount.updatedAt = now;
        this.writeStore(latestStore);
      }
      this.recordQuotaObservation(accountId, usage);
      return usage;
    } catch (error) {
      const message = redactError(error);
      const latestStore = this.readStore();
      const latestAccount = latestStore.accounts.find((item) => item.id === accountId);
      if (latestAccount) {
        latestAccount.usageError = message;
        latestAccount.usageRefreshAttemptedAt = now;
        latestAccount.status = isAuthFailure(error) ? "needs_login" : "usage_failed";
        latestAccount.updatedAt = now;
        this.writeStore(latestStore);
      }
      throw new Error(message);
    }
  }

  async refreshAllUsage() {
    this.syncCurrentAuth();
    const results = [];
    const currentFingerprint = this.currentAuthFingerprint();
    const accounts = this.readStore().accounts.sort(
      (left, right) => Number(right.fingerprint === currentFingerprint) - Number(left.fingerprint === currentFingerprint)
    );
    for (const account of accounts) {
      try {
        const usage = await this.refreshUsage(account.id, false);
        results.push({ id: account.id, ok: true, usage });
      } catch (error) {
        results.push({ id: account.id, ok: false, error: redactError(error) });
      }
    }
    return results;
  }

  switchAccount(accountId, options = {}) {
    this.syncCurrentAuth();
    const store = this.readStore();
    const account = this.findAccount(store, accountId);
    const authJson = this.decryptAccountAuth(account);
    const fingerprint = authFingerprint(authJson);
    const targetNeedsLogin = account.status === "needs_login";
    if (this.currentAuthFingerprint() === fingerprint) {
      this.recordActiveAccount(account.id, "current_confirmed");
      return {
        switchedTo: this.publicAccount(account, fingerprint),
        authPath: this.codexAuthPath,
        closedCodexProcesses: 0,
        launchedCodex: false,
        alreadyCurrent: true
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
    const runningCodexProcesses = this.verifyCodexClosure ? this.countCodexProcesses() : 0;
    const closedCodexProcesses = this.closeCodexProcesses();
    const remainingCodexProcesses = this.verifyCodexClosure ? this.countCodexProcesses() : 0;
    if (remainingCodexProcesses > 0) {
      throw new Error("ChatGPT Codex 仍在运行，已取消本次切换以避免只替换认证文件。请完全退出 ChatGPT Codex 后重试。");
    }
    fs.mkdirSync(this.codexDir, { recursive: true });
    this.backupCurrentAuth();
    atomicWriteJson(this.codexAuthPath, authJson);
    account.usageError = undefined;
    account.status = "ready";
    account.updatedAt = unixNow();
    this.writeStore(store);
    this.recordActiveAccount(account.id, "switch");
    const transportWarning = this.ensurePreferredTransport(account);
    const launchedCodex = this.launchCodex();
    return {
      switchedTo: this.publicAccount(account, fingerprint),
      authPath: this.codexAuthPath,
      closedCodexProcesses,
      verifiedCodexClosure: runningCodexProcesses > 0 && remainingCodexProcesses === 0,
      targetNeedsLogin,
      launchedCodex,
      transportWarning
    };
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
      const closedCodexProcesses = this.closeCodexProcesses();
      fs.mkdirSync(this.codexDir, { recursive: true });
      this.backupCurrentAuth();
      fs.rmSync(this.codexAuthPath, { force: true });
      store.accounts = store.accounts.filter((item) => item.id !== accountId);
      this.writeStore(store);
      this.recordActiveAccount(undefined, "login_new");
      this.clearDeletedAccountReferences(accountId);
      const transportWarning = this.ensurePreferredTransport();
      const launchedCodex = this.launchCodex();
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
    const closedCodexProcesses = this.closeCodexProcesses();
    fs.mkdirSync(this.codexDir, { recursive: true });
    this.backupCurrentAuth();
    atomicWriteJson(this.codexAuthPath, replacementAuth);
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
    const launchedCodex = this.launchCodex();
    return {
      deleted: true,
      switchedTo: this.publicAccount(replacementInStore ?? replacement, authFingerprint(replacementAuth)),
      closedCodexProcesses,
      launchedCodex,
      transportWarning
    };
  }

  pickBestAccount() {
    const now = Math.floor(this.nowMs() / 1000);
    const accounts = this.listAccounts();
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
    return getCodexActivityStatus({
      codexDir: this.codexDir,
      isProcessAlive: this.isProcessAlive,
      getProcessInfo: this.getCodexProcessInfo,
      nowMs: this.nowMs(),
      activityWindowMs: this.activityWindowMs,
      taskActivityCache: this.taskActivityCache
    });
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
    return this.updateSettings({
      autoSwitchTargetMode: "manual",
      manualAutoSwitchTargetAccountId: accountId
    });
  }

  clearAutoSwitchTarget() {
    return this.updateSettings({
      autoSwitchTargetMode: "best",
      manualAutoSwitchTargetAccountId: undefined
    });
  }

  getAutoSwitchState() {
    return normalizeAutoSwitchState(readJsonIfExists(this.autoSwitchStatePath, {}));
  }

  writeAutoSwitchState(state) {
    const next = normalizeAutoSwitchState(state);
    atomicWriteJson(this.autoSwitchStatePath, next);
    return next;
  }

  clearAutoSwitchState() {
    return this.writeAutoSwitchState({});
  }

  evaluateAutoSwitch(reason = "auto") {
    this.syncCurrentAuth();
    const settings = this.readSettings();
    const current = this.listAccounts().find((account) => account.isCurrent);
    const pending = this.getAutoSwitchState().pending;

    if (!settings.autoSwitchEnabled) {
      this.writeAutoSwitchEvent("disabled", { reason });
      return { status: "disabled" };
    }
    if (!current) {
      this.clearAutoSwitchState();
      this.writeAutoSwitchEvent("not_ready", { reason: "current_unavailable" });
      return { status: "not_ready", reason: "current_unavailable" };
    }
    if (!isQuotaExhaustedPublic(current)) {
      if (pending) {
        this.clearAutoSwitchState();
        this.writeAutoSwitchEvent("cancelled", { reason: "current_recovered", accountId: pending.accountId });
        return { status: "cancelled", reason: "current_recovered" };
      }
      return { status: "idle", reason: "current_available" };
    }

    const resolved = pending?.mode === "manual"
      ? this.resolvePendingManualTarget(pending, current.id)
      : this.resolveAutoSwitchTarget(current.id);
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

    if (resolved.fallback) {
      this.writeAutoSwitchEvent("manual_target_fallback", {
        mode: resolved.mode,
        accountId: resolved.target.id,
        requestedTargetId: resolved.fallback.requestedTargetId,
        reason: resolved.fallback.reason
      });
    }

    const activityStatus = this.getCodexActivityStatus();
    const decision = decideAutoSwitchActivity(activityStatus, pending, { nowMs: this.nowMs() });
    if (decision.shouldQueue) {
      const nextPending = {
        accountId: resolved.target.id,
        emailMasked: resolved.target.emailMasked,
        mode: resolved.mode,
        reason,
        createdAtMs: pending?.createdAtMs ?? this.nowMs(),
        updatedAtMs: this.nowMs(),
        lastBusyAt: decision.lastBusyAt,
        quietUntilMs: decision.quietUntilMs,
        activityReason: activityStatus.reason,
        fallback: resolved.fallback
      };
      this.writeAutoSwitchState({ pending: nextPending });
      this.writeAutoSwitchEvent("queued", {
        mode: resolved.mode,
        accountId: resolved.target.id,
        reason,
        activityReason: activityStatus.reason
      });
      return { status: "queued", target: resolved.target, pending: nextPending, activityStatus, fallback: resolved.fallback };
    }

    try {
      const result = this.switchAccount(resolved.target.id);
      this.clearAutoSwitchState();
      this.writeAutoSwitchEvent("switched", {
        mode: resolved.mode,
        accountId: resolved.target.id,
        closedCodexProcesses: result.closedCodexProcesses ?? 0
      });
      return { status: "switched", target: resolved.target, result, fallback: resolved.fallback };
    } catch (error) {
      const failed = {
        accountId: resolved.target.id,
        emailMasked: resolved.target.emailMasked,
        mode: resolved.mode,
        reason,
        createdAtMs: pending?.createdAtMs ?? this.nowMs(),
        updatedAtMs: this.nowMs(),
        fallback: resolved.fallback,
        lastError: redactError(error)
      };
      this.writeAutoSwitchState({ pending: failed });
      this.writeAutoSwitchEvent("switch_failed", {
        mode: resolved.mode,
        accountId: resolved.target.id,
        error: failed.lastError
      });
      return { status: "failed", target: resolved.target, error: failed.lastError, fallback: resolved.fallback };
    }
  }

  resolveAutoSwitchTarget(currentAccountId) {
    const allAccounts = this.listAccounts();
    const accounts = allAccounts.filter((account) => account.id !== currentAccountId);
    const settings = this.readSettings();
    const now = Math.floor(this.nowMs() / 1000);
    if (settings.autoSwitchTargetMode === "manual" && settings.manualAutoSwitchTargetAccountId) {
      const requestedTarget = allAccounts.find((account) => account.id === settings.manualAutoSwitchTargetAccountId);
      const target = accounts.find((account) => account.id === settings.manualAutoSwitchTargetAccountId);
      const unavailableReason = !requestedTarget
        ? "manual_target_missing"
        : requestedTarget.id === currentAccountId
          ? "manual_target_current"
        : !isUsableAutoSwitchTarget(target, now)
          ? "manual_target_unavailable"
          : !this.canReadAccountAuth(target.id)
            ? "manual_target_unreadable"
            : undefined;
      if (!unavailableReason) {
        return { mode: "manual", target };
      }
      const fallback = pickBest(
        accounts.filter((account) => account.id !== target?.id && this.canReadAccountAuth(account.id)),
        now
      );
      return fallback
        ? {
            mode: "manual",
            target: fallback,
            fallback: { requestedTargetId: settings.manualAutoSwitchTargetAccountId, reason: unavailableReason }
          }
        : { mode: "manual", target, unavailableReason };
    }
    return { mode: "best", target: pickBest(accounts.filter((account) => this.canReadAccountAuth(account.id)), now) };
  }

  resolvePendingManualTarget(pending, currentAccountId) {
    const now = Math.floor(this.nowMs() / 1000);
    const target = this.listAccounts().find((account) => account.id === pending.accountId && account.id !== currentAccountId);
    if (target && isUsableAutoSwitchTarget(target, now) && this.canReadAccountAuth(target.id)) {
      return { mode: "manual", target, fallback: pending.fallback };
    }
    return this.resolveAutoSwitchTarget(currentAccountId);
  }

  canReadAccountAuth(accountId) {
    const account = this.readStore().accounts.find((item) => item.id === accountId);
    if (!account) {
      return false;
    }
    try {
      this.decryptAccountAuth(account);
      return true;
    } catch {
      return false;
    }
  }

  getTokenUsageStats(options = {}) {
    return getTokenUsageStats({
      codexDir: this.codexDir,
      nowMs: selectedStatsNowMs(options?.asOfDate, this.nowMs()),
      cachePath: this.tokenUsageCachePath
    });
  }

  getWeeklyUsageReport(options = {}) {
    const state = pruneObservationState(readObservationState(this.usageObservationsPath), this.nowMs());
    const weekStartMs = parseLocalDateStart(options?.weekStart) ?? startOfPreviousLocalWeek(this.nowMs());
    const tokenEvents = readRolloutUsageEvents({
      codexDir: this.codexDir,
      startMs: weekStartMs,
      endMs: weekStartMs + 7 * 24 * 60 * 60 * 1000
    });
    writeObservationState(this.usageObservationsPath, state);
    return buildWeeklyUsageReport({ state, tokenEvents, accounts: this.listAccounts(), weekStartMs });
  }

  getDailyUsageReport(options = {}) {
    const state = pruneObservationState(readObservationState(this.usageObservationsPath), this.nowMs());
    const dayStartMs = parseLocalDateStart(options?.date) ?? parseLocalDateStart(new Date(this.nowMs()).toLocaleDateString("en-CA")) ?? this.nowMs();
    const endDate = new Date(dayStartMs);
    endDate.setDate(endDate.getDate() + 1);
    const tokenEvents = readRolloutUsageEvents({ codexDir: this.codexDir, startMs: dayStartMs, endMs: endDate.getTime() });
    writeObservationState(this.usageObservationsPath, state);
    return buildDailyUsageReport({ state, tokenEvents, accounts: this.listAccounts(), dayStartMs });
  }

  clearUsageObservations() {
    const state = createObservationState();
    const current = this.currentSavedAccountId();
    if (current) {
      setActiveAccount(state, { accountId: current, atMs: this.nowMs(), source: "history_reset" });
    }
    writeObservationState(this.usageObservationsPath, state);
    return { cleared: true };
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

  readSettings() {
    return normalizeSettings(readJsonIfExists(this.settingsPath, {}));
  }

  updateSettings(patch) {
    const current = this.readSettings();
    const next = normalizeSettings({
      autoSwitchEnabled: typeof patch?.autoSwitchEnabled === "boolean" ? patch.autoSwitchEnabled : current.autoSwitchEnabled,
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
      autoSwitchTargetMode: isAutoSwitchTargetMode(patch?.autoSwitchTargetMode)
        ? patch.autoSwitchTargetMode
        : current.autoSwitchTargetMode,
      manualAutoSwitchTargetAccountId:
        typeof patch?.manualAutoSwitchTargetAccountId === "string"
          ? patch.manualAutoSwitchTargetAccountId
          : current.manualAutoSwitchTargetAccountId,
      httpOnlyModeEnabled: current.httpOnlyModeEnabled,
      accountListPanePercent:
        Number.isFinite(patch?.accountListPanePercent)
          ? Math.round(Math.max(28, Math.min(68, Number(patch.accountListPanePercent))))
          : current.accountListPanePercent,
      usageRefreshIntervalMinutes:
        Number.isFinite(patch?.usageRefreshIntervalMinutes)
          ? Math.round(Math.max(1, Math.min(60, Number(patch.usageRefreshIntervalMinutes))))
          : current.usageRefreshIntervalMinutes
    });
    atomicWriteJson(this.settingsPath, next);
    return next;
  }

  setHttpOnlyMode(enabled) {
    const current = this.readSettings();
    const nextEnabled = Boolean(enabled);
    if (current.httpOnlyModeEnabled === nextEnabled) {
      if (nextEnabled) {
        const baseProvider = readCodexBaseProvider(this.codexConfigPath);
        const closedCodexProcesses = this.closeCodexProcesses();
        try {
          const migration = migrateCodexHistoryProvider(this.codexDir, HTTP_ONLY_PROVIDER_ID, baseProvider);
          ensureCodexHttpOnlyMode(this.codexConfigPath);
          const launchedCodex = closedCodexProcesses > 0 ? this.launchCodex() : false;
          return { settings: current, closedCodexProcesses, launchedCodex, migration };
        } catch (error) {
          if (closedCodexProcesses > 0) {
            this.launchCodex();
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
        migration = migrateCodexHistoryProvider(this.codexDir, HTTP_ONLY_PROVIDER_ID, baseProvider);
        try {
          setCodexHttpOnlyMode(this.codexConfigPath, true);
        } catch (error) {
          revertCodexHistoryProvider(this.codexDir, baseProvider);
          throw error;
        }
      } else {
        migration = revertCodexHistoryProvider(this.codexDir, baseProvider);
        try {
          setCodexHttpOnlyMode(this.codexConfigPath, false);
        } catch (error) {
          migrateCodexHistoryProvider(this.codexDir, HTTP_ONLY_PROVIDER_ID, baseProvider);
          throw error;
        }
      }

      const settings = normalizeSettings({ ...current, httpOnlyModeEnabled: nextEnabled });
      atomicWriteJson(this.settingsPath, settings);
      const launchedCodex = closedCodexProcesses > 0 ? this.launchCodex() : false;
      return { settings, closedCodexProcesses, launchedCodex, migration };
    } catch (error) {
      if (closedCodexProcesses > 0) {
        this.launchCodex();
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
      const migration = this.applyTransportMode(Boolean(enabled));
      const launchedCodex = closedCodexProcesses > 0 ? this.launchCodex() : false;
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
        this.launchCodex();
      }
      throw error;
    }
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

  applyTransportMode(enabled) {
    if (enabled) {
      if (readCodexHttpOnlyStatus(this.codexConfigPath).enabled) {
        ensureCodexHttpOnlyMode(this.codexConfigPath);
        return { changedRollouts: 0, changedThreads: 0 };
      }
      const baseProvider = readCodexBaseProvider(this.codexConfigPath);
      const migration = migrateCodexHistoryProvider(this.codexDir, HTTP_ONLY_PROVIDER_ID, baseProvider);
      try {
        setCodexHttpOnlyMode(this.codexConfigPath, true);
      } catch (error) {
        revertCodexHistoryProvider(this.codexDir, baseProvider);
        throw error;
      }
      return migration;
    }

    if (!readCodexHttpOnlyStatus(this.codexConfigPath).enabled) {
      return { changedRollouts: 0, changedThreads: 0 };
    }
    const baseProvider = readCodexBaseProvider(this.codexConfigPath);
    const migration = revertCodexHistoryProvider(this.codexDir, baseProvider);
    try {
      setCodexHttpOnlyMode(this.codexConfigPath, false);
    } catch (error) {
      migrateCodexHistoryProvider(this.codexDir, HTTP_ONLY_PROVIDER_ID, baseProvider);
      throw error;
    }
    return migration;
  }

  readStore() {
    return readJsonIfExists(this.storePath, { version: 1, accounts: [] });
  }

  writeStore(store) {
    atomicWriteJson(this.storePath, store);
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

  recordActiveAccount(accountId, source) {
    const state = readObservationState(this.usageObservationsPath);
    const open = [...state.intervals].reverse().find((item) => item.endMs === undefined);
    if (open?.accountId === accountId || (!open && !accountId)) return;
    setActiveAccount(state, { accountId, atMs: this.nowMs(), source });
    pruneObservationState(state, this.nowMs());
    writeObservationState(this.usageObservationsPath, state);
  }

  recordQuotaObservation(accountId, usage) {
    const state = readObservationState(this.usageObservationsPath);
    appendQuotaSnapshot(state, {
      accountId,
      fetchedAtMs: Number(usage.fetchedAt) * 1000,
      source: usage.source ?? "chatgpt_usage_api",
      fiveHour: usage.fiveHour,
      oneWeek: usage.oneWeek,
      explicitResetCause: usage.explicitResetCause
    });
    pruneObservationState(state, this.nowMs());
    writeObservationState(this.usageObservationsPath, state);
  }

  writeAutoSwitchEvent(type, details = {}) {
    const event = redactDiagnosticValue({
      timestamp: new Date(this.nowMs()).toISOString(),
      type,
      details
    });
    fs.mkdirSync(path.dirname(this.autoSwitchEventsPath), { recursive: true });
    fs.appendFileSync(this.autoSwitchEventsPath, `${JSON.stringify(event)}\n`, "utf8");
    pruneTextFile(this.autoSwitchEventsPath, 256 * 1024);
  }

  clearDeletedAccountReferences(accountId) {
    const settings = this.readSettings();
    if (settings.manualAutoSwitchTargetAccountId === accountId) {
      this.clearAutoSwitchTarget();
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
    return JSON.parse(unprotectString(account.encryptedAuth));
  }

  publicAccount(account, currentFingerprint) {
    return {
      id: account.id,
      accountId: account.accountId,
      emailMasked: account.emailMasked,
      planType: account.planType,
      usage: account.usage,
      usageError: account.usageError,
      usageRefreshAttemptedAt: account.usageRefreshAttemptedAt,
      status: account.status,
      httpOnlyModeEnabled: this.resolveHttpOnlyMode(account),
      httpOnlyModeOverride: typeof account.httpOnlyModeEnabled === "boolean",
      isCurrent: Boolean(currentFingerprint && account.fingerprint === currentFingerprint),
      createdAt: account.createdAt,
      updatedAt: account.updatedAt
    };
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

  backupCurrentAuth() {
    if (!fs.existsSync(this.codexAuthPath)) {
      return;
    }
    const backupDir = path.join(this.codexDir, "secure-switcher-backups");
    fs.mkdirSync(backupDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const encryptedBackup = protectString(fs.readFileSync(this.codexAuthPath, "utf8"));
    atomicWriteText(path.join(backupDir, `auth.${stamp}.json.dpapi`), `${encryptedBackup}\n`);
    this.pruneBackups(backupDir);
  }

  migratePlaintextBackups() {
    const backupDir = path.join(this.codexDir, "secure-switcher-backups");
    if (!fs.existsSync(backupDir)) {
      return;
    }
    for (const name of fs.readdirSync(backupDir).filter((item) => item.startsWith("auth.") && item.endsWith(".json"))) {
      const source = path.join(backupDir, name);
      const target = `${source}.dpapi`;
      if (!fs.existsSync(target)) {
        atomicWriteText(target, `${protectString(fs.readFileSync(source, "utf8"))}\n`);
      }
      fs.rmSync(source, { force: true });
    }
    this.pruneBackups(backupDir);
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
    requireSwitchConfirmation: typeof value?.requireSwitchConfirmation === "boolean" ? value.requireSwitchConfirmation : true,
    lowQuotaWarningEnabled: typeof value?.lowQuotaWarningEnabled === "boolean" ? value.lowQuotaWarningEnabled : true,
    lowQuotaThresholdPercent: Number.isFinite(threshold) ? Math.max(1, Math.min(50, threshold)) : 15,
    uiLanguage: value?.uiLanguage === "en" ? "en" : "zh-CN",
    closeBehavior: isCloseBehavior(value?.closeBehavior) ? value.closeBehavior : "ask",
    themeMode: isThemeMode(value?.themeMode) ? value.themeMode : "system",
    autoSwitchTargetMode: targetMode,
    manualAutoSwitchTargetAccountId: manualTargetId,
    httpOnlyModeEnabled: typeof value?.httpOnlyModeEnabled === "boolean" ? value.httpOnlyModeEnabled : false,
    accountListPanePercent: Number.isFinite(Number(value?.accountListPanePercent))
      ? Math.round(Math.max(28, Math.min(68, Number(value.accountListPanePercent))))
      : 46,
    usageRefreshIntervalMinutes: Number.isFinite(refreshInterval) ? Math.round(Math.max(1, Math.min(60, refreshInterval))) : 5
  };
}

function parseLocalDateStart(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const parsed = new Date(`${value}T00:00:00`).getTime();
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
  if (!value || typeof value !== "object" || !value.pending || typeof value.pending !== "object") {
    return {};
  }
  const accountId = typeof value.pending.accountId === "string" ? value.pending.accountId : undefined;
  if (!accountId) {
    return {};
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
      quietUntilMs: Number.isFinite(value.pending.quietUntilMs) ? value.pending.quietUntilMs : undefined,
      activityReason: typeof value.pending.activityReason === "string" ? value.pending.activityReason : undefined,
      fallback: normalizeFallback(value.pending.fallback),
      lastError: typeof value.pending.lastError === "string" ? value.pending.lastError : undefined
    }
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

function selectedStatsNowMs(asOfDate, currentNowMs) {
  if (typeof asOfDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(asOfDate)) {
    return currentNowMs;
  }
  const [year, month, day] = asOfDate.split("-").map(Number);
  const selectedStart = new Date(year, month - 1, day).getTime();
  if (!Number.isFinite(selectedStart)) {
    return currentNowMs;
  }
  const selectedEnd = selectedStart + 24 * 60 * 60 * 1000 - 1;
  const currentDate = new Date(currentNowMs);
  const currentStart = new Date(currentDate.getFullYear(), currentDate.getMonth(), currentDate.getDate()).getTime();
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

function isAuthFailure(error) {
  return /401|Unauthorized|登录态被用量接口拒绝/i.test(redactError(error));
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

function getCodexActivityStatus({ codexDir, isProcessAlive: processAlive, getProcessInfo: processInfo, nowMs, activityWindowMs, taskActivityCache }) {
  const activeProcessCount = countActiveChatProcesses(codexDir, processAlive, processInfo);
  if (activeProcessCount > 0) {
    return {
      isBusy: true,
      reason: "active_chat_process",
      activeProcessCount,
      lastActivityAt: undefined
    };
  }

  const taskActivity = inspectCodexTaskActivity(codexDir, taskActivityCache);
  if (taskActivity.isBusy) {
    return {
      isBusy: true,
      reason: taskActivity.reason,
      activeProcessCount: 0,
      lastActivityAt: undefined,
      taskActivity
    };
  }

  const latestActivity = latestCodexActivity(codexDir);
  if (latestActivity && nowMs - latestActivity.mtimeMs <= activityWindowMs) {
    return {
      isBusy: true,
      reason: "recent_session_activity",
      activeProcessCount: 0,
      lastActivityAt: latestActivity.mtimeMs,
      activitySnapshot: latestActivity
    };
  }

  return {
    isBusy: false,
    reason: "idle",
    activeProcessCount: 0,
    lastActivityAt: latestActivity?.mtimeMs,
    activitySnapshot: latestActivity
  };
}

function countActiveChatProcesses(codexDir, processAlive, processInfo) {
  const chatProcessesPath = path.join(codexDir, "process_manager", "chat_processes.json");
  if (!fs.existsSync(chatProcessesPath)) {
    return 0;
  }

  try {
    const value = JSON.parse(fs.readFileSync(chatProcessesPath, "utf8"));
    const items = Array.isArray(value) ? value : Object.values(value ?? {});
    const pids = new Set();
    for (const item of items) {
      const pid = Number(item?.osPid);
      if (Number.isInteger(pid) && pid > 0) {
        pids.add(pid);
      }
    }
    let count = 0;
    for (const pid of pids) {
      if (processAlive(pid) && (!processInfo || isOfficialCodexProcess(processInfo(pid)))) {
        count += 1;
      }
    }
    return count;
  } catch {
    return 0;
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
  return isUsageWindowExhausted(account?.usage?.fiveHour) || isUsageWindowExhausted(account?.usage?.oneWeek);
}

function isUsageWindowExhausted(window) {
  return Boolean(window) && Number(window.usedPercent) >= 100;
}

function launchOfficialCodex() {
  if (process.platform !== "win32") {
    return false;
  }
  const script = `
$app = Get-StartApps | Where-Object { $_.AppID -like 'OpenAI.Codex_*' -or $_.Name -eq 'ChatGPT Codex' -or $_.Name -eq 'ChatGPT' -or $_.Name -eq 'Codex' } | Select-Object -First 1
if (-not $app) {
  throw "ChatGPT Codex app is not installed."
}
Start-Process explorer.exe "shell:AppsFolder\\$($app.AppID)"
Write-Output $app.AppID
`;
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

function unixNow() {
  return Math.floor(Date.now() / 1000);
}
