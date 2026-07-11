import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createAccountService } from "../src/services/account-service.js";

test("account service records active-account and quota observations locally", { skip: process.platform !== "win32" }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "switcher-account-observation-"));
  const userData = path.join(root, "appdata");
  const codexDir = path.join(root, ".codex");
  fs.mkdirSync(codexDir, { recursive: true });
  fs.writeFileSync(path.join(codexDir, "auth.json"), JSON.stringify({ access_token: "synthetic", account_id: "acct-test", plan_type: "plus" }));
  let nowMs = Date.parse("2026-07-06T10:00:00Z");
  const service = createAccountService(userData, {
    codexDir,
    nowMs: () => nowMs,
    fetchImpl: async () => new Response(JSON.stringify({
      plan_type: "plus",
      rate_limit: { primary_window: { used_percent: 20, limit_window_seconds: 18_000, reset_at: 1_800_000_000 } },
      additional_rate_limits: [{ rate_limit: { secondary_window: { used_percent: 30, limit_window_seconds: 604_800, reset_at: 1_800_500_000 } } }]
    }), { status: 200, headers: { "content-type": "application/json" } })
  });

  const account = service.importCurrentAuth();
  nowMs += 60_000;
  await service.refreshUsage(account.id, true);

  const observationPath = path.join(userData, "usage-observations.json");
  const state = JSON.parse(fs.readFileSync(observationPath, "utf8"));
  assert.equal(state.intervals.at(-1).accountId, account.id);
  assert.equal(state.quotaSnapshots.at(-1).accountId, account.id);
  assert.equal(state.quotaSnapshots.at(-1).source, "chatgpt_usage_api");
  assert.doesNotMatch(JSON.stringify(state), /synthetic|access_token|acct-test/);
  const listed = service.listAccounts().find((item) => item.id === account.id);
  assert.equal(listed.usageRefreshAttemptedAt, Math.floor(nowMs / 1000));
});

test("account service returns and clears weekly local reports", { skip: process.platform !== "win32" }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "switcher-weekly-report-"));
  const userData = path.join(root, "appdata");
  const codexDir = path.join(root, ".codex");
  fs.mkdirSync(codexDir, { recursive: true });
  const service = createAccountService(userData, { codexDir, nowMs: () => Date.parse("2026-07-13T12:00:00") });

  const report = service.getWeeklyUsageReport();
  assert.equal(report.source, "local_observation");
  assert.equal(report.accounts.length, 0);
  assert.equal(service.clearUsageObservations().cleared, true);
  assert.equal(fs.existsSync(path.join(userData, "usage-observations.json")), true);
});

test("account service returns daily reports without changing weekly reports", { skip: process.platform !== "win32" }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "switcher-daily-report-"));
  const userData = path.join(root, "appdata");
  const codexDir = path.join(root, ".codex");
  fs.mkdirSync(codexDir, { recursive: true });
  const service = createAccountService(userData, { codexDir, nowMs: () => new Date(2026, 6, 11, 12).getTime() });
  const daily = service.getDailyUsageReport({ date: "2026-07-10" });
  const weekly = service.getWeeklyUsageReport({ weekStart: "2026-07-06" });
  assert.equal(daily.mode, "daily");
  assert.equal(weekly.mode, "weekly");
  assert.equal(new Date(daily.startMs).getDate(), 10);
});
