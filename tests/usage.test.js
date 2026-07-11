import assert from "node:assert/strict";
import test from "node:test";
import { fetchUsageSnapshot, mapUsagePayload } from "../src/core/usage.js";

test("maps five hour and weekly usage windows", () => {
  const usage = mapUsagePayload(
    {
      plan_type: "plus",
      rate_limit: {
        primary_window: {
          used_percent: 40,
          limit_window_seconds: 18_000,
          reset_at: 2000
        }
      },
      additional_rate_limits: [
        {
          rate_limit: {
            secondary_window: {
              used_percent: 75,
              limit_window_seconds: 604_800,
              reset_at: 3000
            }
          }
        }
      ],
      credits: { has_credits: true, unlimited: false, balance: "$1.00" }
    },
    1000
  );

  assert.equal(usage.fetchedAt, 1000);
  assert.equal(usage.planType, "plus");
  assert.equal(usage.fiveHour.remainingPercent, 60);
  assert.equal(usage.oneWeek.remainingPercent, 25);
  assert.equal(usage.credits.balance, "$1.00");
});

test("does not duplicate a single usage window into both periods", () => {
  const usage = mapUsagePayload({
    rate_limit: {
      primary_window: {
        used_percent: 1,
        limit_window_seconds: 18_000,
        reset_at: 1_800_000_000
      }
    }
  });

  assert.equal(usage.fiveHour.remainingPercent, 99);
  assert.equal(usage.oneWeek, undefined);
});

test("summarizes connect timeout as a proxy/network hint", async () => {
  const error = new TypeError("fetch failed");
  error.cause = { code: "UND_ERR_CONNECT_TIMEOUT" };
  await assert.rejects(
    () => fetchUsageSnapshot({
      accessToken: "access",
      accountId: "acct",
      fetchImpl: async () => {
        throw error;
      }
    }),
    /无法连接 chatgpt\.com 用量接口/
  );
});

test("distinguishes rejected login state from unsupported usage access", async () => {
  await assert.rejects(
    () => fetchUsageSnapshot({
      accessToken: "access",
      accountId: "acct",
      fetchImpl: async () => new Response("", { status: 401 })
    }),
    /登录态被用量接口拒绝（401）/
  );

  await assert.rejects(
    () => fetchUsageSnapshot({
      accessToken: "access",
      accountId: "acct",
      fetchImpl: async () => new Response("", { status: 403 })
    }),
    /用量接口拒绝访问（403）/
  );
});

test("reports non-auth HTTP failures without masking the status", async () => {
  await assert.rejects(
    () => fetchUsageSnapshot({
      accessToken: "access",
      accountId: "acct",
      fetchImpl: async () => new Response("", { status: 500 })
    }),
    /HTTP 500/
  );
});
