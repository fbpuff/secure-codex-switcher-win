import assert from "node:assert/strict";
import test from "node:test";
import * as ranking from "../src/core/ranking.js";

const { compareAccountsByScore, isQuotaExhausted, pickBestAccount, pickRecoveryAccount, quotaBalanceScore, remainingScore } = ranking;

test("scores full remaining quota as 100 availability points", () => {
  const score = remainingScore({
    usage: {
      fiveHour: { usedPercent: 0, resetAt: 10_000 },
      oneWeek: { usedPercent: 0, resetAt: 303_400 }
    }
  }, 1_000);
  assert.equal(score, 100);
});

test("weights the lower remaining window as the bottleneck", () => {
  const score = remainingScore({
    usage: {
      fiveHour: { usedPercent: 0 },
      oneWeek: { usedPercent: 50 }
    }
  }, 1_000);
  assert.equal(score, 60);
});

test("uses the known remaining value when one window is missing", () => {
  assert.equal(remainingScore({ usage: { fiveHour: { usedPercent: 25 } } }, 1_000), 75);
});

test("exposes a shared score breakdown and deterministic comparator", () => {
  assert.equal(typeof ranking.scoreBreakdown, "function");
  assert.equal(typeof ranking.compareAccountsByScore, "function");
});

test("breaks equal availability scores with seven day remaining quota first", () => {
  const accounts = [
    { id: "five-hour-heavy", createdAt: 1, usage: { fiveHour: { usedPercent: 40 }, oneWeek: { usedPercent: 50 } } },
    { id: "seven-day-heavy", createdAt: 2, usage: { fiveHour: { usedPercent: 50 }, oneWeek: { usedPercent: 40 } } }
  ];

  accounts.sort((left, right) => ranking.compareAccountsByScore(left, right, 1_000));
  assert.equal(accounts[0].id, "seven-day-heavy");
});

test("automatic selection rejects future-dated quota evidence like the display layer", () => {
  const account = { status: "ready", usage: { fetchedAt: 1001, fiveHour: { usedPercent: 0, resetAt: 2000 } } };
  assert.equal(pickBestAccount([account], 1000), undefined);
  account.usage.fiveHour.usedPercent = 100;
  assert.equal(pickRecoveryAccount([account], 1000), undefined);
});

test("picks ready fresh account with the most remaining quota", () => {
  const best = pickBestAccount(
    [
      { id: "old", status: "ready", createdAt: 1, usage: { fetchedAt: 100, fiveHour: { usedPercent: 0 }, oneWeek: { usedPercent: 0 } } },
      { id: "bad", status: "usage_failed", createdAt: 2, usage: { fetchedAt: 1000, fiveHour: { usedPercent: 0 }, oneWeek: { usedPercent: 0 } } },
      { id: "best", status: "ready", createdAt: 3, usage: { fetchedAt: 1000, fiveHour: { usedPercent: 10 }, oneWeek: { usedPercent: 20 } } }
    ],
    1000
  );
  assert.equal(best.id, "best");
});

test("excludes expired usage authentication from automatic switching", () => {
  const best = pickBestAccount([
    { id: "expired", status: "usage_auth_expired", createdAt: 1, usage: { fetchedAt: 1_000, fiveHour: { usedPercent: 0 }, oneWeek: { usedPercent: 0 } } },
    { id: "ready", status: "ready", createdAt: 2, usage: { fetchedAt: 1_000, fiveHour: { usedPercent: 50 }, oneWeek: { usedPercent: 50 } } }
  ], 1_000);

  assert.equal(best.id, "ready");
});

test("treats either exhausted window as exhausted", () => {
  assert.equal(isQuotaExhausted({ usage: { fiveHour: { usedPercent: 100 } } }), true);
  assert.equal(isQuotaExhausted({ usage: { oneWeek: { usedPercent: 99 } } }), false);
});

test("execution-limited accounts keep official balance context but have zero immediate availability", () => {
  const limited = {
    status: "ready",
    usage: {
      fetchedAt: 1_000,
      executionLimited: true,
      executionLimitWindow: "fiveHour",
      fiveHour: { usedPercent: 2, resetAt: 2_000 },
      oneWeek: { usedPercent: 30, resetAt: 9_000 }
    }
  };

  assert.equal(isQuotaExhausted(limited), true);
  assert.equal(remainingScore(limited, 1_000), 0);
  assert.ok(quotaBalanceScore(limited, 1_000) > 0);
  assert.equal(pickBestAccount([limited], 1_000), undefined);
  assert.equal(pickRecoveryAccount([limited], 1_000), limited);
});

test("higher availability always wins even when the lower score resets sooner", () => {
  const best = pickBestAccount([
    { id: "higher-later", status: "ready", createdAt: 1, usage: { fetchedAt: 1_000, fiveHour: { usedPercent: 1, resetAt: 19_000 }, oneWeek: { usedPercent: 0, resetAt: 605_800 } } },
    { id: "lower-sooner", status: "ready", createdAt: 2, usage: { fetchedAt: 1_000, fiveHour: { usedPercent: 5, resetAt: 1_001 }, oneWeek: { usedPercent: 3, resetAt: 605_800 } } }
  ], 1_000);

  assert.equal(best.id, "higher-later");
});

test("uses the limiting-window reset only when raw scores are exactly equal", () => {
  const accounts = [
    { id: "later", createdAt: 1, usage: { fiveHour: { usedPercent: 5, resetAt: 19_000 }, oneWeek: { usedPercent: 3, resetAt: 605_800 } } },
    { id: "sooner", createdAt: 2, usage: { fiveHour: { usedPercent: 5, resetAt: 1_001 }, oneWeek: { usedPercent: 3, resetAt: 605_800 } } }
  ];
  accounts.sort((left, right) => ranking.compareAccountsByScore(left, right, 1_000));
  assert.equal(accounts[0].id, "sooner");
});

test("higher availability wins when scores differ by more than five points", () => {
  const accounts = [
    { id: "higher-later", createdAt: 1, usage: { fiveHour: { usedPercent: 30, resetAt: 19_000 }, oneWeek: { usedPercent: 30, resetAt: 605_800 } } },
    { id: "lower-sooner", createdAt: 2, usage: { fiveHour: { usedPercent: 40, resetAt: 1_001 }, oneWeek: { usedPercent: 40, resetAt: 605_800 } } }
  ];
  accounts.sort((left, right) => ranking.compareAccountsByScore(left, right, 1_000));
  assert.equal(accounts[0].id, "higher-later");
});

test("excludes usage snapshots whose known reset boundary has passed", () => {
  const best = pickBestAccount([
    { id: "expired", status: "ready", createdAt: 1, usage: { fetchedAt: 1_000, fiveHour: { usedPercent: 0, resetAt: 999 }, oneWeek: { usedPercent: 0, resetAt: 999 } } },
    { id: "valid", status: "ready", createdAt: 2, usage: { fetchedAt: 1_000, fiveHour: { usedPercent: 40, resetAt: 2_000 }, oneWeek: { usedPercent: 40, resetAt: 2_000 } } }
  ], 1_000);

  assert.equal(best.id, "valid");
});

test("never lets recovery timing inflate immediate availability", () => {
  const exhaustedSoon = { id: "soon", status: "ready", usage: { fetchedAt: 1_000, fiveHour: { usedPercent: 100, resetAt: 1_060 }, oneWeek: { usedPercent: 0, resetAt: 9_000 } } };
  const usable = { id: "usable", status: "ready", usage: { fetchedAt: 1_000, fiveHour: { usedPercent: 90, resetAt: 5_000 }, oneWeek: { usedPercent: 90, resetAt: 9_000 } } };
  assert.equal(remainingScore(exhaustedSoon, 1_000), 0);
  assert.equal(pickBestAccount([exhaustedSoon, usable], 1_000).id, "usable");
});

test("chooses nearest valid recovery only when callers request a recovery candidate", () => {
  const accounts = [
    { id: "later", status: "ready", usage: { fetchedAt: 1_000, fiveHour: { usedPercent: 100, resetAt: 2_000 }, oneWeek: { usedPercent: 20, resetAt: 9_000 } } },
    { id: "soon", status: "ready", usage: { fetchedAt: 1_000, fiveHour: { usedPercent: 100, resetAt: 1_100 }, oneWeek: { usedPercent: 30, resetAt: 9_000 } } }
  ];
  assert.equal(pickBestAccount(accounts, 1_000), undefined);
  assert.equal(pickRecoveryAccount(accounts, 1_000).id, "soon");
});

test("preserves overall quota context when one window blocks immediate use", () => {
  const account = { usage: { fiveHour: { usedPercent: 100 }, oneWeek: { usedPercent: 20 } } };
  assert.equal(remainingScore(account, 1_000), 0);
  assert.equal(quotaBalanceScore(account, 1_000), 16);
});

test("orders usable accounts first and blocked accounts by exhausted-window recovery", () => {
  const accounts = [
    { id: "blocked-late", status: "ready", usage: { fiveHour: { usedPercent: 100, resetAt: 3_000 }, oneWeek: { usedPercent: 20 } } },
    { id: "usable", status: "ready", usage: { fiveHour: { usedPercent: 95, resetAt: 4_000 }, oneWeek: { usedPercent: 95 } } },
    { id: "blocked-soon", status: "ready", usage: { fiveHour: { usedPercent: 100, resetAt: 2_000 }, oneWeek: { usedPercent: 80 } } }
  ];
  accounts.sort((left, right) => compareAccountsByScore(left, right, 1_000));
  assert.deepEqual(accounts.map((item) => item.id), ["usable", "blocked-soon", "blocked-late"]);
});
