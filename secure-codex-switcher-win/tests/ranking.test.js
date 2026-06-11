import assert from "node:assert/strict";
import test from "node:test";
import { isQuotaExhausted, pickBestAccount, remainingScore } from "../src/core/ranking.js";

test("scores weekly quota more heavily than five hour quota", () => {
  const score = remainingScore({
    usage: {
      fiveHour: { usedPercent: 50 },
      oneWeek: { usedPercent: 20 }
    }
  });
  assert.equal(score, 71);
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

test("treats either exhausted window as exhausted", () => {
  assert.equal(isQuotaExhausted({ usage: { fiveHour: { usedPercent: 100 } } }), true);
  assert.equal(isQuotaExhausted({ usage: { oneWeek: { usedPercent: 99 } } }), false);
});
