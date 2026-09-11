import assert from "node:assert/strict";
import test from "node:test";
import { formatQuotaPercent, quotaDisplayState } from "../src/renderer/quota-display.js";

function account(overrides = {}) {
  return {
    status: "ready",
    usageError: undefined,
    usage: {
      fetchedAt: 1_000,
      fiveHour: {
        usedPercent: 0.4,
        remainingPercent: 99.6,
        windowSeconds: 18_000,
        resetAt: 2_000
      },
      oneWeek: {
        usedPercent: 40,
        remainingPercent: 60,
        windowSeconds: 604_800,
        resetAt: 3_000
      }
    },
    ...overrides
  };
}

test("current quota state exposes normalized windows and reset metadata", () => {
  const state = quotaDisplayState(account(), 1_000);

  assert.equal(state.current, true);
  assert.equal(state.fiveHour.remainingPercent, 99.6);
  assert.equal(state.oneWeek.remainingPercent, 60);
  assert.equal(state.fiveHour.windowSeconds, 18_000);
  assert.equal(state.oneWeek.resetAt, 3_000);
  assert.equal(state.availability, "available");
});

test("execution limits stay separate from official remaining percentages", () => {
  const value = account();
  const state = quotaDisplayState({
    ...value,
    usage: {
      ...value.usage,
      executionLimited: true,
      executionLimitWindow: "fiveHour",
      executionLimitSource: "codex_usage_limit_exceeded"
    }
  }, 1_000);

  assert.equal(state.fiveHour.remainingPercent, 99.6);
  assert.equal(state.executionLimited, true);
  assert.equal(state.executionLimitWindow, "fiveHour");
  assert.equal(state.availability, "execution_limited");
});

test("stale or failed snapshots never expose retained percentages as current", () => {
  const stale = quotaDisplayState(account(), 1_601);
  assert.equal(stale.current, false);
  assert.equal(stale.fiveHour, undefined);
  assert.equal(stale.oneWeek, undefined);

  const failed = quotaDisplayState(account({ usageError: "usage failed" }), 1_000);
  assert.equal(failed.current, false);
  assert.equal(failed.fiveHour, undefined);

  const nonReady = quotaDisplayState(account({ status: "usage_auth_expired" }), 1_000);
  assert.equal(nonReady.current, false);
  assert.equal(nonReady.availability, "unknown");
});

test("exhausted official windows use the same shared availability state", () => {
  const value = account();
  const state = quotaDisplayState({
    ...value,
    usage: {
      ...value.usage,
      fiveHour: { ...value.usage.fiveHour, usedPercent: 100, remainingPercent: 0 }
    }
  }, 1_000);

  assert.equal(state.availability, "exhausted");
});

test("invalid or mismatched windows are not displayed as current", () => {
  const state = quotaDisplayState(account({
    usage: {
      fetchedAt: 1_000,
      fiveHour: {
        usedPercent: 20,
        remainingPercent: 80,
        windowSeconds: 14_400,
        resetAt: 2_000
      },
      oneWeek: {
        usedPercent: 20,
        remainingPercent: 101,
        windowSeconds: 604_800,
        resetAt: 3_000
      }
    }
  }), 1_000);

  assert.equal(state.current, false);
  assert.equal(state.fiveHour, undefined);
  assert.equal(state.oneWeek, undefined);
});

test("percentage formatting keeps fractional values below 100 honest", () => {
  assert.equal(formatQuotaPercent(99.6), "99.6%");
  assert.equal(formatQuotaPercent(99.96), "99.9%");
  assert.equal(formatQuotaPercent(100), "100%");
  assert.equal(formatQuotaPercent(Number.NaN), "?");
});
