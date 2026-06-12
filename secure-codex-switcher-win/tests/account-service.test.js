import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createAccountService } from "../src/services/account-service.js";
import { extractAccessToken, extractAccountId, summarizeAuth } from "../src/core/auth-summary.js";

test("imports encrypted auth and switches with backup", { skip: process.platform !== "win32" }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "secure-codex-switcher-"));
  const userData = path.join(root, "appdata");
  const codexDir = path.join(root, ".codex");
  fs.mkdirSync(codexDir, { recursive: true });
  const initialAuth = {
    access_token: "a",
    refresh_token: "ra",
    account_id: "acct-a",
    plan_type: "plus"
  };
  fs.writeFileSync(path.join(codexDir, "auth.json"), JSON.stringify(initialAuth), "utf8");

  let closedCodexProcesses = 0;
  let launchedCodex = 0;
  const service = createAccountService(userData, {
    codexDir,
    closeCodexProcesses: () => {
      closedCodexProcesses += 1;
      return 2;
    },
    launchCodex: () => {
      launchedCodex += 1;
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
  storeWithStaleError.accounts[0].usageError = "stale usage error";
  storeWithStaleError.accounts[0].status = "needs_login";
  fs.writeFileSync(storePath, JSON.stringify(storeWithStaleError), "utf8");

  fs.writeFileSync(path.join(codexDir, "auth.json"), JSON.stringify({ access_token: "other" }), "utf8");
  const switched = service.switchAccount(imported.id);
  assert.equal(switched.switchedTo.accountId, "acct-a");
  assert.equal(switched.closedCodexProcesses, 2);
  assert.equal(switched.launchedCodex, true);
  assert.equal(closedCodexProcesses, 1);
  assert.equal(launchedCodex, 1);
  assert.equal(switched.switchedTo.usageError, undefined);
  assert.equal(switched.switchedTo.status, "ready");
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(codexDir, "auth.json"), "utf8")), initialAuth);

  const backups = fs.readdirSync(path.join(codexDir, "secure-switcher-backups"));
  assert.equal(backups.length, 1);
  assert.equal(backups[0].endsWith(".json.dpapi"), true);
  assert.equal(fs.readFileSync(path.join(codexDir, "secure-switcher-backups", backups[0]), "utf8").includes("other"), false);
});

test("switching to the current account does not restart Codex", { skip: process.platform !== "win32" }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "secure-codex-switcher-"));
  const userData = path.join(root, "appdata");
  const codexDir = path.join(root, ".codex");
  fs.mkdirSync(codexDir, { recursive: true });
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

test("deferred auto switch does not close running Codex", { skip: process.platform !== "win32" }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "secure-codex-switcher-"));
  const userData = path.join(root, "appdata");
  const codexDir = path.join(root, ".codex");
  fs.mkdirSync(codexDir, { recursive: true });
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "secure-codex-switcher-"));
  const userData = path.join(root, "appdata");
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

test("account switching still reopens Codex when HTTP-only config repair fails", { skip: process.platform !== "win32" }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "secure-codex-switcher-"));
  const userData = path.join(root, "appdata");
  const codexDir = path.join(root, ".codex");
  fs.mkdirSync(codexDir, { recursive: true });
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

test("supports nested Codex tokens auth format", { skip: process.platform !== "win32" }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "secure-codex-switcher-"));
  const userData = path.join(root, "appdata");
  const codexDir = path.join(root, ".codex");
  fs.mkdirSync(codexDir, { recursive: true });
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
  await service.refreshUsage(imported.id, true);
  assert.equal(service.listAccounts()[0].planType, "plus");

  const rawStore = fs.readFileSync(path.join(userData, "accounts-store.json"), "utf8");
  assert.equal(rawStore.includes('"b"'), false);
  assert.equal(rawStore.includes('"rb"'), false);
});

test("fills missing legacy settings with safe defaults", { skip: process.platform !== "win32" }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "secure-codex-switcher-"));
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
  assert.equal(settings.uiLanguage, "zh-CN");
  assert.equal(settings.closeBehavior, "ask");
  assert.equal(settings.themeMode, "system");
  assert.equal(settings.httpOnlyModeEnabled, false);
  assert.equal(settings.accountListPanePercent, 46);
  assert.equal(settings.usageRefreshIntervalMinutes, 5);

  const updated = service.updateSettings({ uiLanguage: "en", closeBehavior: "minimize", themeMode: "dark", accountListPanePercent: 20, usageRefreshIntervalMinutes: 0 });
  assert.equal(updated.uiLanguage, "en");
  assert.equal(updated.closeBehavior, "minimize");
  assert.equal(updated.themeMode, "dark");
  assert.equal(updated.accountListPanePercent, 28);
  assert.equal(updated.usageRefreshIntervalMinutes, 1);
  assert.equal(service.readSettings().uiLanguage, "en");

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
});

test("migrates plaintext auth backups to DPAPI encrypted files", { skip: process.platform !== "win32" }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "secure-codex-switcher-"));
  const userData = path.join(root, "appdata");
  const codexDir = path.join(root, ".codex");
  const backupDir = path.join(codexDir, "secure-switcher-backups");
  fs.mkdirSync(backupDir, { recursive: true });
  fs.writeFileSync(path.join(backupDir, "auth.old.json"), JSON.stringify({ access_token: "p" }), "utf8");

  createAccountService(userData, { codexDir });

  const backups = fs.readdirSync(backupDir);
  assert.deepEqual(backups, ["auth.old.json.dpapi"]);
  assert.equal(fs.readFileSync(path.join(backupDir, backups[0]), "utf8").includes('"p"'), false);
});

test("automatically syncs refreshed current auth into encrypted storage", { skip: process.platform !== "win32" }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "secure-codex-switcher-"));
  const userData = path.join(root, "appdata");
  const codexDir = path.join(root, ".codex");
  fs.mkdirSync(codexDir, { recursive: true });
  const oldAuth = { access_token: "old", refresh_token: "oldr", account_id: "acct-sync" };
  const refreshedAuth = { access_token: "new", refresh_token: "newr", account_id: "acct-sync" };
  fs.writeFileSync(path.join(codexDir, "auth.json"), JSON.stringify(oldAuth), "utf8");

  const service = createAccountService(userData, { codexDir });
  const imported = service.importCurrentAuth();
  const store = service.readStore();
  store.accounts[0].status = "needs_login";
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "secure-codex-switcher-"));
  const userData = path.join(root, "appdata");
  const codexDir = path.join(root, ".codex");
  fs.mkdirSync(codexDir, { recursive: true });
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

test("marks 401 as login refresh needed but keeps 403 as usage failure", { skip: process.platform !== "win32" }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "secure-codex-switcher-"));
  const userData = path.join(root, "appdata");
  const codexDir = path.join(root, ".codex");
  fs.mkdirSync(codexDir, { recursive: true });
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
  assert.equal(service.listAccounts()[0].status, "needs_login");
});

test("usage refresh does not overwrite accounts added while the request is pending", { skip: process.platform !== "win32" }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "secure-codex-switcher-"));
  const userData = path.join(root, "appdata");
  const codexDir = path.join(root, ".codex");
  fs.mkdirSync(codexDir, { recursive: true });
  fs.writeFileSync(path.join(codexDir, "auth.json"), JSON.stringify({ access_token: "a", account_id: "acct-a" }), "utf8");

  let finishFetch;
  const service = createAccountService(userData, {
    codexDir,
    fetchImpl: async () => new Promise((resolve) => {
      finishFetch = resolve;
    })
  });
  const first = service.importCurrentAuth();
  const pendingRefresh = service.refreshUsage(first.id, true);

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

test("deleting a non-current account does not close or launch Codex", { skip: process.platform !== "win32" }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "secure-codex-switcher-"));
  const userData = path.join(root, "appdata");
  const codexDir = path.join(root, ".codex");
  fs.mkdirSync(codexDir, { recursive: true });
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "secure-codex-switcher-"));
  const userData = path.join(root, "appdata");
  const codexDir = path.join(root, ".codex");
  fs.mkdirSync(codexDir, { recursive: true });
  const currentAuth = { access_token: "current", account_id: "acct-current" };
  const replacementAuth = { access_token: "replacement", account_id: "acct-replacement" };
  fs.writeFileSync(path.join(codexDir, "auth.json"), JSON.stringify(currentAuth), "utf8");

  let closedCodexProcesses = 0;
  let launchedCodex = 0;
  const service = createAccountService(userData, {
    codexDir,
    closeCodexProcesses: () => {
      closedCodexProcesses += 1;
      return 3;
    },
    launchCodex: () => {
      launchedCodex += 1;
      return true;
    }
  });
  const current = service.importCurrentAuth();
  fs.writeFileSync(path.join(codexDir, "auth.json"), JSON.stringify(replacementAuth), "utf8");
  const replacement = service.importCurrentAuth();
  fs.writeFileSync(path.join(codexDir, "auth.json"), JSON.stringify(currentAuth), "utf8");

  assert.throws(() => service.deleteAccount(current.id), /必须选择另一个账号/);
  const deleted = service.deleteAccount(current.id, replacement.id);
  assert.equal(deleted.deleted, true);
  assert.equal(deleted.closedCodexProcesses, 3);
  assert.equal(deleted.launchedCodex, true);
  assert.equal(closedCodexProcesses, 1);
  assert.equal(launchedCodex, 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(codexDir, "auth.json"), "utf8")), replacementAuth);
  assert.deepEqual(service.listAccounts().map((account) => account.id), [replacement.id]);
});

test("deleting current account can clear auth and launch new login", { skip: process.platform !== "win32" }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "secure-codex-switcher-"));
  const userData = path.join(root, "appdata");
  const codexDir = path.join(root, ".codex");
  fs.mkdirSync(codexDir, { recursive: true });
  const currentAuth = { access_token: "current", account_id: "acct-current" };
  fs.writeFileSync(path.join(codexDir, "auth.json"), JSON.stringify(currentAuth), "utf8");

  let closedCodexProcesses = 0;
  let launchedCodex = 0;
  const service = createAccountService(userData, {
    codexDir,
    closeCodexProcesses: () => {
      closedCodexProcesses += 1;
      return 2;
    },
    launchCodex: () => {
      launchedCodex += 1;
      return true;
    }
  });
  const current = service.importCurrentAuth();
  const deleted = service.deleteAccount(current.id, { mode: "login_new" });

  assert.equal(deleted.deleted, true);
  assert.equal(deleted.loginNew, true);
  assert.equal(deleted.closedCodexProcesses, 2);
  assert.equal(deleted.launchedCodex, true);
  assert.equal(closedCodexProcesses, 1);
  assert.equal(launchedCodex, 1);
  assert.equal(fs.existsSync(path.join(codexDir, "auth.json")), false);
  assert.deepEqual(service.listAccounts(), []);

  const backups = fs.readdirSync(path.join(codexDir, "secure-switcher-backups"));
  assert.equal(backups.length, 1);
  assert.equal(backups[0].endsWith(".json.dpapi"), true);
  assert.equal(fs.readFileSync(path.join(codexDir, "secure-switcher-backups", backups[0]), "utf8").includes("current"), false);
});

test("cancels switch and delete when Codex cannot be fully closed", { skip: process.platform !== "win32" }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "secure-codex-switcher-"));
  const userData = path.join(root, "appdata");
  const codexDir = path.join(root, ".codex");
  fs.mkdirSync(codexDir, { recursive: true });
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
