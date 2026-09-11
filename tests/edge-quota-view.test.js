import assert from "node:assert/strict";
import test from "node:test";

import { buildEdgeQuotaView } from "../src/core/edge-quota-view.js";

const nowSeconds = 2_000_000_000;
const current = {
  id: "current",
  isCurrent: true,
  remark: "主力账号",
  emailMasked: "c***@example.com",
  status: "ready",
  usage: {
    fetchedAt: nowSeconds - 30,
    source: "codex_app_server",
    executionLimited: true,
    executionLimitWindow: "fiveHour",
    executionLimitSource: "codex_usage_limit_exceeded",
    fiveHour: { remainingPercent: 8, usedPercent: 92, resetAt: nowSeconds + 3600, windowSeconds: 18_000 },
    oneWeek: { remainingPercent: 42, usedPercent: 58, resetAt: nowSeconds + 86_400, windowSeconds: 604_800 }
  }
};

test("builds the compact account, quota, and bounded task projection", () => {
  const view = buildEdgeQuotaView({
    accounts: [current, { id: "next", remark: "备用账号", emailMasked: "n***@example.com" }],
    nextAccountId: "next",
    activity: {
      activeTasks: [
        { id: "12345678-1234-1234-1234-123456789abc", displayName: "正在执行" },
        { id: "bad", displayName: "无效 ID" },
        { id: "22345678-1234-1234-1234-123456789abc", displayName: "第三项" },
        { id: "32345678-1234-1234-1234-123456789abc", displayName: "第四项" }
      ]
    },
    threads: [
      { id: "42345678-1234-1234-1234-123456789abc", title: "最近完成", turnState: "completed", updatedAtMs: 9 },
      { id: "52345678-1234-1234-1234-123456789abc", title: "较早完成", turnState: "completed", updatedAtMs: 8 },
      { id: "62345678-1234-1234-1234-123456789abc", title: "不应展示", turnState: "completed", updatedAtMs: 7 },
      { id: "codex:project:ambiguous", entityType: "project", title: "项目集合", turnState: "completed", updatedAtMs: 10 }
    ],
    nowSeconds
  });

  assert.equal(view.current.label, "主力账号");
  assert.equal(view.next.label, "备用账号");
  assert.equal(view.quota.fiveHour.remainingPercent, 8);
  assert.equal(view.quota.source, "codex_app_server");
  assert.equal(view.quota.executionLimited, true);
  assert.equal(view.quota.availability, "execution_limited");
  assert.equal(view.quota.executionLimitWindow, "fiveHour");
  assert.equal(view.quota.fiveHour.executionLimited, true);
  assert.equal(view.quota.oneWeek.executionLimited, false);
  assert.equal(view.quota.fiveHour.low, true);
  assert.equal(view.quota.oneWeek.low, false);
  assert.equal(view.activeTasks.length, 3);
  assert.equal(view.activeTasks[1].threadId, undefined);
  assert.deepEqual(view.completedTasks.map((task) => task.title), ["最近完成", "较早完成"]);
});

test("stale quota is omitted instead of presented as current", () => {
  const view = buildEdgeQuotaView({
    accounts: [{ ...current, usage: { ...current.usage, fetchedAt: nowSeconds - 601 } }],
    activity: {},
    threads: [],
    nowSeconds
  });
  assert.equal(view.quota.current, false);
  assert.equal(view.quota.fiveHour, undefined);
  assert.equal(view.quota.oneWeek, undefined);
});
