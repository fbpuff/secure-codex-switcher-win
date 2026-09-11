import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getTokenUsageStats } from "../src/core/token-usage-stats.js";
import { beijingTimestamp, formatBeijingTime, beijingDate, beijingDayStart, previousBeijingWeekStart } from "../src/core/beijing-time.js";
import { createMainProcessLifecycleRecord } from "../src/core/main-process-lifecycle.js";
import { createEdgeWindowLifecycleRecord } from "../src/core/edge-window-lifecycle.js";

test("Beijing timestamps preserve instants and roll over dates", () => {
  for (const [input, expected] of [
    ["2026-09-05T06:01:39.456Z", "2026-09-05T14:01:39.456+08:00"],
    ["2026-12-31T20:00:00.000Z", "2027-01-01T04:00:00.000+08:00"]
  ]) {
    assert.equal(beijingTimestamp(input), expected);
    assert.equal(Date.parse(beijingTimestamp(input)), Date.parse(input));
    assert.equal(createMainProcessLifecycleRecord({ timestamp: input }).timestamp, expected);
    assert.equal(createEdgeWindowLifecycleRecord({ timestamp: input }).timestamp, expected);
  }
});

test("Beijing display is independent of host timezone", () => {
  const script = `import { formatBeijingTime } from './src/core/beijing-time.js'; console.log(formatBeijingTime('2026-09-05T06:01:39.456Z'));`;
  const outputs = ["UTC", "Asia/Tokyo", "America/New_York"].map(TZ =>
    execFileSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", env: { ...process.env, TZ } }).trim());
  assert.equal(new Set(outputs).size, 1);
  assert.match(outputs[0], /14:01:39/);
  assert.match(outputs[0], /北京时间/);
  assert.equal(formatBeijingTime("invalid"), "—");
});

test("Beijing report dates use midnight and Monday in UTC+08", () => {
  const now = "2026-09-06T16:30:00Z";
  assert.equal(beijingDate(now), "2026-09-07");
  assert.equal(beijingDayStart(now), Date.parse("2026-09-07T00:00:00+08:00"));
  assert.equal(previousBeijingWeekStart(now), Date.parse("2026-08-31T00:00:00+08:00"));
});

test("token cache is rebuilt with Beijing day buckets", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "switcher-beijing-time-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "sessions"));
  const rollout = path.join(root, "sessions", "rollout-test.jsonl");
  fs.writeFileSync(rollout, ["2026-09-05T15:30:00Z", "2026-09-05T16:30:00Z"].map(timestamp => JSON.stringify({
    timestamp, payload: { info: { last_token_usage: { total_tokens: 10 } } }
  })).join("\n") + "\n");
  const cachePath = path.join(root, "cache.json");
  fs.writeFileSync(cachePath, JSON.stringify({ version: 1, files: {} }));
  const stats = getTokenUsageStats({ codexDir: root, cachePath, nowMs: Date.parse("2026-09-05T17:00:00Z") });
  assert.equal(stats.totals.today.totalTokens, 10);
  assert.equal(stats.totals.sevenDays.totalTokens, 20);
  const cache = JSON.parse(fs.readFileSync(cachePath, "utf8"));
  assert.equal(cache.version, 2);
  assert.deepEqual(Object.keys(cache.files[rollout].days), ["2026-09-05", "2026-09-06"]);
});
