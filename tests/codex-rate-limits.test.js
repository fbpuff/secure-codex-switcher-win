import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { mapCodexRateLimits, readLatestCodexRateLimits } from "../src/core/codex-rate-limits.js";

test("maps the exact Codex rate-limit windows without inventing a missing window", () => {
  const usage = mapCodexRateLimits({
    limit_id: "base_model_inference",
    limit_name: "gpt-reserve",
    primary: { used_percent: 37, window_minutes: 10_080, resets_at: 2_000 },
    secondary: null
  }, 1_000);

  assert.equal(usage.fiveHour, undefined);
  assert.deepEqual(usage.oneWeek, { usedPercent: 37, remainingPercent: 63, resetAt: 2_000, windowSeconds: 604_800 });
  assert.equal(usage.source, "codex_app_server");
});

test("reads the newest valid Codex rate-limit event from rollout tails", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-rate-limits-"));
  const sessions = path.join(root, "sessions", "2026", "08", "29");
  fs.mkdirSync(sessions, { recursive: true });
  const rollout = path.join(sessions, "rollout-test.jsonl");
  const event = (timestamp, used) => JSON.stringify({
    timestamp,
    type: "event_msg",
    payload: { type: "token_count", info: {}, rate_limits: {
      primary: { used_percent: used, window_minutes: 300, resets_at: 2_000 }
    } }
  });
  fs.writeFileSync(rollout, `${event("2026-08-29T05:00:00Z", 20)}\n${event("2026-08-29T05:01:00Z", 21)}\n`);

  try {
    assert.equal(readLatestCodexRateLimits(root).fiveHour.remainingPercent, 79);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
