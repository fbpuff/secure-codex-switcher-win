import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createAccountService } from "../src/services/account-service.js";
import { extractAccessToken, extractAccountId, summarizeAuth } from "../src/core/auth-summary.js";
import { readCodexHttpOnlyStatus } from "../src/core/codex-config.js";

function makeFixture({ createCodexDir = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "secure-codex-switcher-"));
  const userData = path.join(root, "appdata");
  const codexDir = path.join(root, ".codex");
  if (createCodexDir) {
    fs.mkdirSync(codexDir, { recursive: true });
  }
  return { root, userData, codexDir };
}

test("imports encrypted auth and switches with backup", { skip: process.platform !== "win32" }, () => {
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
  const processCounts = [2, 0];
  const service = createAccountService(userData, {
    codexDir,
    verifyCodexClosure: true,
    countCodexProcesses: () => processCounts.shift() ?? 0,
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
  assert.equal(switched.verifiedCodexClosure, true);
  assert.equal(switched.targetNeedsLogin, true);
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

test("detects active Codex chat processes", () => {
  const { userData, codexDir } = makeFixture();
  const processDir = path.join(codexDir, "process_manager");
  fs.mkdirSync(processDir, { recursive: true });
  fs.writeFileSync(
    path.join(processDir, "chat_processes.json"),
    JSON.stringify([
      { osPid: 111, conversationId: "busy" },
      { osPid: 222, conversationId: "done" }
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

test("keeps an unfinished rollout task busy beyond the file activity window", () => {
  const { userData, codexDir } = makeFixture();
  const sessionDir = path.join(codexDir, "sessions", "2026", "06", "13");
  fs.mkdirSync(sessionDir, { recursive: true });
  const rolloutPath = path.join(sessionDir, "rollout-test.jsonl");
  fs.writeFileSync(rolloutPath, `${JSON.stringify({ type: "event_msg", payload: { type: "task_started" } })}\n`, "utf8");
  fs.utimesSync(rolloutPath, new Date(100_000), new Date(100_000));
  const service = createAccountService(userData, {
    codexDir,
    isProcessAlive: () => false,
    nowMs: () => 1_000_000,
    activityWindowMs: 30_000
  });

  const status = service.getCodexActivityStatus();

  assert.equal(status.isBusy, true);
  assert.equal(status.reason, "active_task_lifecycle");
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

  const updated = service.updateSettings({
    uiLanguage: "en",
    closeBehavior: "minimize",
    themeMode: "dark",
    accountListPanePercent: 20,
    usageRefreshIntervalMinutes: 0
  });
  assert.equal(updated.uiLanguage, "en");
  assert.equal(updated.closeBehavior, "minimize");
  assert.equal(updated.themeMode, "dark");
  assert.equal(updated.accountListPanePercent, 28);
  assert.equal(updated.usageRefreshIntervalMinutes, 1);
  assert.equal(service.readSettings().uiLanguage, "en");

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

test("falls back to the best account when the manual target is stale", { skip: process.platform !== "win32" }, () => {
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

  const result = service.evaluateAutoSwitch("test");

  assert.equal(result.status, "switched");
  assert.equal(result.target?.id, best.id);
  assert.equal(result.fallback?.requestedTargetId, target.id);
  assert.equal(result.fallback?.reason, "manual_target_unavailable");
  assert.deepEqual(service.readAutoSwitchTargetPreference(), { mode: "best", accountId: undefined });
  assert.equal(service.getAutoSwitchState().pending, undefined);
  const diagnostics = fs.readFileSync(path.join(userData, "auto-switch-events.jsonl"), "utf8");
  assert.match(diagnostics, /manual_target_fallback/);
  assert.doesNotMatch(diagnostics, /access_token|refresh_token|Bearer /i);
});

test("falls back when the manual target encrypted record is unreadable", { skip: process.platform !== "win32" }, () => {
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

  const result = service.evaluateAutoSwitch("test");

  assert.equal(result.status, "switched");
  assert.equal(result.target?.id, fallback.id);
  assert.equal(result.fallback?.reason, "manual_target_unreadable");
  assert.deepEqual(service.readAutoSwitchTargetPreference(), { mode: "best", accountId: undefined });
});

test("persists queued auto-switch state and cancels when current usage recovers", { skip: process.platform !== "win32" }, () => {
  const { userData, codexDir } = makeFixture();
  const service = createAccountService(userData, {
    codexDir,
    nowMs: () => unixTestNow() * 1000,
    getCodexProcessInfo: () => ({ name: "Codex.exe", executablePath: "C:\\Program Files\\WindowsApps\\OpenAI.Codex_1.0.0.0_x64__2p2nqsd0c76g0\\app\\Codex.exe" }),
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

  const queued = service.evaluateAutoSwitch("test");

  assert.equal(queued.status, "queued");
  assert.equal(service.getAutoSwitchState().pending.accountId, target.id);
  assert.equal(service.getAutoSwitchState().pending.mode, "manual");
  assert.deepEqual(service.readAutoSwitchTargetPreference(), { mode: "best", accountId: undefined });

  const recovered = JSON.parse(fs.readFileSync(storePath, "utf8"));
  recovered.accounts.find((account) => account.id === current.id).usage.fiveHour.usedPercent = 10;
  fs.writeFileSync(storePath, JSON.stringify(recovered), "utf8");
  const cancelled = service.evaluateAutoSwitch("test");

  assert.equal(cancelled.status, "cancelled");
  assert.equal(service.getAutoSwitchState().pending, undefined);
});

test("migrates plaintext auth backups to DPAPI encrypted files", { skip: process.platform !== "win32" }, () => {
  const { userData, codexDir } = makeFixture();
  const backupDir = path.join(codexDir, "secure-switcher-backups");
  fs.mkdirSync(backupDir, { recursive: true });
  fs.writeFileSync(path.join(backupDir, "auth.old.json"), JSON.stringify({ access_token: "p" }), "utf8");

  createAccountService(userData, { codexDir });

  const backups = fs.readdirSync(backupDir);
  assert.deepEqual(backups, ["auth.old.json.dpapi"]);
  assert.equal(fs.readFileSync(path.join(backupDir, backups[0]), "utf8").includes('"p"'), false);
});

test("automatically syncs refreshed current auth into encrypted storage", { skip: process.platform !== "win32" }, () => {
  const { userData, codexDir } = makeFixture();
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

test("marks 401 as login refresh needed but keeps 403 as usage failure", { skip: process.platform !== "win32" }, async () => {
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
  assert.equal(service.listAccounts()[0].status, "needs_login");
});

test("usage refresh does not overwrite accounts added while the request is pending", { skip: process.platform !== "win32" }, async () => {
  const { userData, codexDir } = makeFixture();
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
  const { userData, codexDir } = makeFixture();
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

function unixTestNow() {
  return 2_000_000_000;
}
