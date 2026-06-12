import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { protectString, unprotectString } from "../core/dpapi.js";
import { extractAccessToken, extractAccountId, summarizeAuth } from "../core/auth-summary.js";
import { fetchUsageSnapshot } from "../core/usage.js";
import { pickBestAccount as pickBest, remainingScore } from "../core/ranking.js";
import {
  HTTP_ONLY_PROVIDER_ID,
  ensureCodexHttpOnlyMode,
  readCodexBaseProvider,
  setCodexHttpOnlyMode
} from "../core/codex-config.js";
import { migrateCodexHistoryProvider, revertCodexHistoryProvider } from "../core/codex-history.js";

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
    this.codexAuthPath = path.join(this.codexDir, "auth.json");
    this.codexConfigPath = path.join(this.codexDir, "config.toml");
    this.storePath = path.join(userDataPath, "accounts-store.json");
    this.settingsPath = path.join(userDataPath, "settings.json");
    fs.mkdirSync(userDataPath, { recursive: true });
    this.migratePlaintextBackups();
  }

  listAccounts() {
    this.syncCurrentAuth();
    const store = this.readStore();
    const currentFingerprint = this.currentAuthFingerprint();
    return store.accounts
      .map((account) => this.publicAccount(account, currentFingerprint))
      .sort((left, right) => {
        if (left.isCurrent !== right.isCurrent) {
          return left.isCurrent ? -1 : 1;
        }
        return remainingScore(right) - remainingScore(left);
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
    return this.publicAccount(next, fingerprint);
  }

  async refreshUsage(accountId, force = false) {
    this.syncCurrentAuth();
    const store = this.readStore();
    const account = this.findAccount(store, accountId);
    const now = unixNow();
    if (!force && account.status === "ready" && !account.usageError && account.usage?.fetchedAt && now - account.usage.fetchedAt < 60) {
      return account.usage;
    }

    try {
      const authJson = this.decryptAccountAuth(account);
      const accessToken = extractAccessToken(authJson);
      const upstreamAccountId = extractAccountId(authJson, account.accountId);
      const usage = await fetchUsageSnapshot({ accessToken, accountId: upstreamAccountId, fetchImpl: this.fetchImpl ?? fetch });
      const latestStore = this.readStore();
      const latestAccount = latestStore.accounts.find((item) => item.id === accountId);
      if (latestAccount) {
        latestAccount.usage = usage;
        latestAccount.planType = usage.planType ?? latestAccount.planType;
        latestAccount.usageError = undefined;
        latestAccount.status = "ready";
        latestAccount.updatedAt = now;
        this.writeStore(latestStore);
      }
      return usage;
    } catch (error) {
      const message = redactError(error);
      const latestStore = this.readStore();
      const latestAccount = latestStore.accounts.find((item) => item.id === accountId);
      if (latestAccount) {
        latestAccount.usageError = message;
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
    for (const account of this.readStore().accounts) {
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
    if (this.currentAuthFingerprint() === fingerprint) {
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
    const closedCodexProcesses = this.closeCodexProcesses();
    fs.mkdirSync(this.codexDir, { recursive: true });
    this.backupCurrentAuth();
    atomicWriteJson(this.codexAuthPath, authJson);
    account.usageError = undefined;
    account.status = "ready";
    account.updatedAt = unixNow();
    this.writeStore(store);
    const transportWarning = this.ensurePreferredTransport();
    const launchedCodex = this.launchCodex();
    return {
      switchedTo: this.publicAccount(account, fingerprint),
      authPath: this.codexAuthPath,
      closedCodexProcesses,
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
      return { deleted: true, closedCodexProcesses: 0, launchedCodex: false };
    }

    if (deleteOptions.mode === "login_new") {
      const closedCodexProcesses = this.closeCodexProcesses();
      fs.mkdirSync(this.codexDir, { recursive: true });
      this.backupCurrentAuth();
      fs.rmSync(this.codexAuthPath, { force: true });
      store.accounts = store.accounts.filter((item) => item.id !== accountId);
      this.writeStore(store);
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
    const transportWarning = this.ensurePreferredTransport();
    const launchedCodex = this.launchCodex();
    return {
      deleted: true,
      switchedTo: this.publicAccount(replacement, authFingerprint(replacementAuth)),
      closedCodexProcesses,
      launchedCodex,
      transportWarning
    };
  }

  pickBestAccount() {
    const best = pickBest(this.listAccounts());
    return best ? { account: best, score: remainingScore(best) } : { account: undefined, score: 0 };
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

  ensurePreferredTransport() {
    if (this.readSettings().httpOnlyModeEnabled) {
      try {
        ensureCodexHttpOnlyMode(this.codexConfigPath);
      } catch (error) {
        return redactError(error);
      }
    }
    return undefined;
  }

  readStore() {
    return readJsonIfExists(this.storePath, { version: 1, accounts: [] });
  }

  writeStore(store) {
    atomicWriteJson(this.storePath, store);
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
      status: account.status,
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

function atomicWriteJson(filePath, value) {
  atomicWriteText(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function atomicWriteText(filePath, value) {
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(tmp, value, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tmp, filePath);
}

function readJsonIfExists(filePath, fallback) {
  if (!fs.existsSync(filePath)) {
    return fallback;
  }
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function normalizeSettings(value) {
  const threshold = Number(value?.lowQuotaThresholdPercent);
  const refreshInterval = Number(value?.usageRefreshIntervalMinutes);
  return {
    autoSwitchEnabled: typeof value?.autoSwitchEnabled === "boolean" ? value.autoSwitchEnabled : false,
    requireSwitchConfirmation: typeof value?.requireSwitchConfirmation === "boolean" ? value.requireSwitchConfirmation : true,
    lowQuotaWarningEnabled: typeof value?.lowQuotaWarningEnabled === "boolean" ? value.lowQuotaWarningEnabled : true,
    lowQuotaThresholdPercent: Number.isFinite(threshold) ? Math.max(1, Math.min(50, threshold)) : 15,
    uiLanguage: value?.uiLanguage === "en" ? "en" : "zh-CN",
    closeBehavior: isCloseBehavior(value?.closeBehavior) ? value.closeBehavior : "ask",
    themeMode: isThemeMode(value?.themeMode) ? value.themeMode : "system",
    httpOnlyModeEnabled: typeof value?.httpOnlyModeEnabled === "boolean" ? value.httpOnlyModeEnabled : false,
    accountListPanePercent: Number.isFinite(Number(value?.accountListPanePercent))
      ? Math.round(Math.max(28, Math.min(68, Number(value.accountListPanePercent))))
      : 46,
    usageRefreshIntervalMinutes: Number.isFinite(refreshInterval) ? Math.round(Math.max(1, Math.min(60, refreshInterval))) : 5
  };
}

function isCloseBehavior(value) {
  return value === "ask" || value === "minimize" || value === "quit";
}

function isThemeMode(value) {
  return value === "system" || value === "light" || value === "dark";
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

function isAuthFailure(error) {
  return /401|Unauthorized|登录态被用量接口拒绝/i.test(redactError(error));
}

function closeOfficialCodexProcesses() {
  if (process.platform !== "win32") {
    return 0;
  }
  const script = `
$currentPid = ${process.pid}
$targets = Get-Process -ErrorAction SilentlyContinue | Where-Object {
  ($_.ProcessName -eq 'Codex' -or $_.ProcessName -eq 'codex') -and
  $_.Id -ne $currentPid -and
  $_.Path -and
  (
    $_.Path -like '*\\OpenAI.Codex_*' -or
    $_.Path -like '*\\AppData\\Local\\OpenAI\\Codex\\*'
  )
}
$count = 0
foreach ($target in $targets) {
  try {
    Stop-Process -Id $target.Id -Force -ErrorAction Stop
    $count += 1
  } catch {}
}
Start-Sleep -Milliseconds 500
$remaining = @(Get-Process -ErrorAction SilentlyContinue | Where-Object {
  ($_.ProcessName -eq 'Codex' -or $_.ProcessName -eq 'codex') -and
  $_.Id -ne $currentPid -and
  $_.Path -and
  (
    $_.Path -like '*\\OpenAI.Codex_*' -or
    $_.Path -like '*\\AppData\\Local\\OpenAI\\Codex\\*'
  )
})
if ($remaining.Count -gt 0) {
  throw "Official Codex processes are still running: $($remaining.Count)"
}
Write-Output $count
`;
  try {
    const output = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 10_000
    }).trim();
    return Number.parseInt(output, 10) || 0;
  } catch {
    throw new Error("无法完全关闭官方 Codex，已取消本次切换或删除。请手动退出 Codex 后重试。");
  }
}

function countOfficialCodexProcesses() {
  if (process.platform !== "win32") {
    return 0;
  }
  const script = `
$currentPid = ${process.pid}
$targets = @(Get-Process -ErrorAction SilentlyContinue | Where-Object {
  ($_.ProcessName -eq 'Codex' -or $_.ProcessName -eq 'codex') -and
  $_.Id -ne $currentPid -and
  $_.Path -and
  (
    $_.Path -like '*\\OpenAI.Codex_*' -or
    $_.Path -like '*\\AppData\\Local\\OpenAI\\Codex\\*'
  )
})
Write-Output $targets.Count
`;
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

function launchOfficialCodex() {
  if (process.platform !== "win32") {
    return false;
  }
  const script = `
$app = Get-StartApps | Where-Object { $_.AppID -like 'OpenAI.Codex_*' -or $_.Name -eq 'Codex' } | Select-Object -First 1
if (-not $app) {
  throw "Codex app is not installed."
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
