import assert from "node:assert/strict";
import test from "node:test";
import { localDateInputValue, nextUsageDateState, usageDateFollowsToday } from "../src/core/usage-date.js";

test("formats local dates for date inputs", () => {
  assert.equal(localDateInputValue(new Date(2026, 5, 22)), "2026-06-22");
});

test("advances stale usage date when it still follows today", () => {
  assert.deepEqual(
    nextUsageDateState({ value: "2026-06-21", today: "2026-06-22", followsToday: true }),
    { value: "2026-06-22", followsToday: true }
  );
});

test("keeps a manually selected historical usage date", () => {
  assert.deepEqual(
    nextUsageDateState({ value: "2026-06-21", today: "2026-06-22", followsToday: false }),
    { value: "2026-06-21", followsToday: false }
  );
});

test("treats empty or today usage date as following today", () => {
  assert.equal(usageDateFollowsToday("", "2026-06-22"), true);
  assert.equal(usageDateFollowsToday("2026-06-22", "2026-06-22"), true);
  assert.equal(usageDateFollowsToday("2026-06-21", "2026-06-22"), false);
});
