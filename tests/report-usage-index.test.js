import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { readRolloutUsageEvents } from "../src/core/usage-observations.js";

const moduleUrl = new URL("../src/core/report-usage-index.js", import.meta.url);
const moduleExists = fs.existsSync(moduleUrl);
const reportIndex = moduleExists ? await import(moduleUrl) : {};
const roots = [];

after(() => roots.forEach((root) => fs.rmSync(root, { recursive: true, force: true })));

test("report usage index module exists", () => {
  assert.equal(moduleExists, true);
});

test("retries short filesystem reads while rebuilding an index entry", () => {
  if (!reportIndex.readIndexedRolloutUsageEvents) return;
  const fixture = makeFixture();
  fs.writeFileSync(fixture.rollout, event("2026-07-15T00:00:00Z", "event_msg", {
    info: { last_token_usage: usage(10, 2, 12) }
  }) + "\n");
  const readSync = fs.readSync;
  let shortened = false;
  fs.readSync = (handle, buffer, offset, length, position) => {
    const requested = !shortened && length > 1 ? Math.ceil(length / 2) : length;
    shortened = true;
    return readSync(handle, buffer, offset, requested, position);
  };
  try {
    assert.equal(readIndexed(fixture).length, 1);
    assert.equal(shortened, true);
  } finally {
    fs.readSync = readSync;
  }
});

test("reuses unchanged rollouts and parses only appended complete bytes after full-prefix verification", () => {
  if (!reportIndex.readIndexedRolloutUsageEvents) return;
  const fixture = makeFixture();
  fs.writeFileSync(fixture.rollout, lines([
    event("2026-07-15T00:00:00Z", "turn_context", { model: "gpt-test", effort: "high", private: "do not cache" }),
    event("2026-07-15T00:01:00Z", "event_msg", { info: { total_token_usage: usage(100, 20, 120) } })
  ]));

  const cold = {};
  assert.deepEqual(readIndexed(fixture, cold), []);
  assert.equal(cold.filesRebuilt, 1);
  assert.ok(cold.bytesRead > 0);

  const warm = {};
  assert.deepEqual(readIndexed(fixture, warm), []);
  assert.equal(warm.filesReused, 1);
  assert.equal(warm.bytesRead, 0);

  const appended = event("2026-07-15T00:02:00Z", "event_msg", { info: { total_token_usage: usage(140, 30, 170) } }) + "\n";
  fs.appendFileSync(fixture.rollout, appended);
  const incremental = {};
  const events = readIndexed(fixture, incremental);
  assert.equal(incremental.filesAppended, 1);
  assert.equal(incremental.bytesRead, Buffer.byteLength(appended));
  assert.ok(incremental.verificationBytesRead > 0);
  assert.deepEqual(events.map(({ model, reasoningEffort, totalTokens }) => [model, reasoningEffort, totalTokens]), [["gpt-test", "high", 50]]);
  const persisted = fs.readFileSync(fixture.cache, "utf8");
  assert.doesNotMatch(persisted, /do not cache|rollout-synthetic|switcher-report-index/);
  assert.equal(fs.existsSync(`${fixture.cache}.bak`), false);
});

test("defers an incomplete trailing JSONL record until its newline arrives", () => {
  if (!reportIndex.readIndexedRolloutUsageEvents) return;
  const fixture = makeFixture();
  fs.writeFileSync(fixture.rollout, lines([
    event("2026-07-15T01:00:00Z", "turn_context", { model: "gpt-partial", effort: "medium" })
  ]));
  readIndexed(fixture);
  const partial = event("2026-07-15T01:01:00Z", "event_msg", { info: { last_token_usage: usage(7, 3, 10) } });
  fs.appendFileSync(fixture.rollout, partial);
  assert.equal(readIndexed(fixture).length, 0);
  fs.appendFileSync(fixture.rollout, "\n");
  const completed = readIndexed(fixture);
  assert.equal(completed.length, 1);
  assert.equal(completed[0].totalTokens, 10);
  assert.equal(completed[0].model, "gpt-partial");
});

test("rebuilds truncated and same-size replaced rollouts", () => {
  if (!reportIndex.readIndexedRolloutUsageEvents) return;
  const fixture = makeFixture();
  const first = event("2026-07-15T02:00:00Z", "event_msg", { info: { last_token_usage: usage(10, 2, 12) } }) + "\n";
  fs.writeFileSync(fixture.rollout, first + first);
  assert.equal(readIndexed(fixture).length, 1);

  fs.writeFileSync(fixture.rollout, first);
  const truncatedDiagnostics = {};
  assert.equal(readIndexed(fixture, truncatedDiagnostics).length, 1);
  assert.equal(truncatedDiagnostics.filesRebuilt, 1);

  const replacement = event("2026-07-15T03:00:00Z", "event_msg", { info: { last_token_usage: usage(20, 4, 24) } }) + "\n";
  assert.equal(Buffer.byteLength(replacement), Buffer.byteLength(first));
  fs.writeFileSync(fixture.rollout, replacement);
  const future = new Date(Date.now() + 5_000);
  fs.utimesSync(fixture.rollout, future, future);
  const replacedDiagnostics = {};
  const replaced = readIndexed(fixture, replacedDiagnostics);
  assert.equal(replacedDiagnostics.filesRebuilt, 1);
  assert.equal(replaced.length, 1);
  assert.equal(replaced[0].totalTokens, 24);
});

test("rejects append reuse when the committed prefix was rewritten before growth", () => {
  if (!reportIndex.readIndexedRolloutUsageEvents) return;
  const fixture = makeFixture();
  const paddingBefore = Array.from({ length: 150 }, (_, index) => event("2026-07-15T03:00:00Z", "event_msg", { note: `before-${index}-${"x".repeat(80)}` }));
  const paddingAfter = Array.from({ length: 150 }, (_, index) => event("2026-07-15T03:20:00Z", "event_msg", { note: `after-${index}-${"x".repeat(80)}` }));
  const first = event("2026-07-15T03:10:00Z", "event_msg", { info: { last_token_usage: usage(10, 2, 12) } });
  fs.writeFileSync(fixture.rollout, lines([...paddingBefore, first, ...paddingAfter]));
  assert.deepEqual(readIndexed(fixture).map((item) => item.totalTokens), [12]);

  const replacement = event("2026-07-15T03:10:00Z", "event_msg", { info: { last_token_usage: usage(30, 4, 34) } });
  const appended = event("2026-07-15T03:21:00Z", "event_msg", { info: { last_token_usage: usage(50, 6, 56) } });
  fs.writeFileSync(fixture.rollout, lines([...paddingBefore, replacement, ...paddingAfter, appended]));
  const diagnostics = {};
  const indexed = readIndexed(fixture, diagnostics);
  assert.equal(diagnostics.filesRebuilt, 1);
  assert.deepEqual(indexed.map((item) => item.totalTokens), [34, 56]);
  assert.deepEqual(indexed, readRolloutUsageEvents({ codexDir: fixture.root }));
});

test("rejects raw identifiers or unsafe labels inside otherwise allowed cache fields", () => {
  if (!reportIndex.readIndexedRolloutUsageEvents) return;
  const fixture = makeFixture();
  fs.writeFileSync(fixture.rollout, lines([
    event("2026-07-15T03:30:00Z", "session_meta", { id: "synthetic-safe-id" }),
    event("2026-07-15T03:31:00Z", "event_msg", { info: { last_token_usage: usage(9, 3, 12) } })
  ]));
  readIndexed(fixture);
  const cache = JSON.parse(fs.readFileSync(fixture.cache, "utf8"));
  const entry = Object.values(cache.files)[0];
  entry.state.sessionId = "019f0000-0000-7000-8000-000000000099";
  entry.events[0].model = "secret@example.com";
  fs.writeFileSync(fixture.cache, JSON.stringify(cache), "utf8");

  const diagnostics = {};
  assert.equal(readIndexed(fixture, diagnostics).length, 1);
  assert.equal(diagnostics.filesRebuilt, 1);
  assert.doesNotMatch(fs.readFileSync(fixture.cache, "utf8"), /019f0000|secret@example\.com/);
});

test("recovers a corrupt cache and drops removed or moved file contributions", () => {
  if (!reportIndex.readIndexedRolloutUsageEvents) return;
  const fixture = makeFixture();
  fs.writeFileSync(fixture.rollout, event("2026-07-15T04:00:00Z", "event_msg", { info: { last_token_usage: usage(5, 2, 7) } }) + "\n");
  fs.writeFileSync(fixture.cache, "{broken", "utf8");
  assert.equal(readIndexed(fixture).length, 1);

  const archived = path.join(fixture.root, "archived_sessions", path.basename(fixture.rollout));
  fs.mkdirSync(path.dirname(archived), { recursive: true });
  fs.renameSync(fixture.rollout, archived);
  assert.equal(readIndexed(fixture).length, 1);
  fs.rmSync(archived);
  assert.equal(readIndexed(fixture).length, 0);
});

test("rebuilds a structurally invalid cache entry instead of reusing partial statistics", () => {
  if (!reportIndex.readIndexedRolloutUsageEvents) return;
  const fixture = makeFixture();
  fs.writeFileSync(fixture.rollout, event("2026-07-15T04:30:00Z", "event_msg", { info: { last_token_usage: usage(8, 2, 10) } }) + "\n");
  readIndexed(fixture);
  const cache = JSON.parse(fs.readFileSync(fixture.cache, "utf8"));
  const entry = Object.values(cache.files)[0];
  entry.state = null;
  entry.events = "not-an-event-list";
  fs.writeFileSync(fixture.cache, JSON.stringify(cache), "utf8");

  const diagnostics = {};
  const rebuilt = readIndexed(fixture, diagnostics);
  assert.equal(diagnostics.filesRebuilt, 1);
  assert.equal(rebuilt.length, 1);
  assert.equal(rebuilt[0].totalTokens, 10);
});

test("rebuilds a cache entry whose persisted event or parser continuation is incomplete", () => {
  if (!reportIndex.readIndexedRolloutUsageEvents) return;
  const fixture = makeFixture();
  fs.writeFileSync(fixture.rollout, lines([
    event("2026-07-15T04:45:00Z", "event_msg", { info: { total_token_usage: usage(8, 2, 10) } }),
    event("2026-07-15T04:46:00Z", "event_msg", { info: { total_token_usage: usage(16, 4, 20) } })
  ]));
  readIndexed(fixture);
  const cache = JSON.parse(fs.readFileSync(fixture.cache, "utf8"));
  const entry = Object.values(cache.files)[0];
  delete entry.events[0].inputTokens;
  entry.privatePrompt = "must be discarded";
  entry.events[0].privateResponse = "must be discarded";
  entry.state.previousCumulative = { totalTokens: 20 };
  fs.writeFileSync(fixture.cache, JSON.stringify(cache), "utf8");

  const diagnostics = {};
  const rebuilt = readIndexed(fixture, diagnostics);
  assert.equal(diagnostics.filesRebuilt, 1);
  assert.equal(rebuilt.length, 1);
  assert.equal(rebuilt[0].totalTokens, 10);
  assert.doesNotMatch(fs.readFileSync(fixture.cache, "utf8"), /must be discarded|privatePrompt|privateResponse/);
});

test("indexed events exactly match the existing full parser", () => {
  if (!reportIndex.readIndexedRolloutUsageEvents) return;
  const fixture = makeFixture();
  fs.writeFileSync(fixture.rollout, lines([
    event("2026-07-15T05:00:00Z", "session_meta", { id: "019f0000-0000-7000-8000-000000000001" }),
    event("2026-07-15T05:00:01Z", "turn_context", { model: "gpt-parity", effort: "low" }),
    event("2026-07-15T05:01:00Z", "event_msg", { info: { last_token_usage: usage(30, 5, 35) } }),
    event("2026-07-15T05:02:00Z", "event_msg", { info: { total_token_usage: usage(100, 20, 120) } }),
    event("2026-07-15T05:03:00Z", "event_msg", { info: { total_token_usage: usage(150, 30, 180) } })
  ]));
  assert.deepEqual(readIndexed(fixture), readRolloutUsageEvents({ codexDir: fixture.root }));
  assert.doesNotMatch(fs.readFileSync(fixture.cache, "utf8"), /019f0000-0000-7000-8000-000000000001/);
});

test("bounded indexed events match the full parser across a cumulative baseline before the range", () => {
  if (!reportIndex.readIndexedRolloutUsageEvents) return;
  const fixture = makeFixture();
  fs.writeFileSync(fixture.rollout, lines([
    event("2026-07-15T06:00:00Z", "event_msg", { info: { total_token_usage: usage(100, 20, 120) } }),
    event("2026-07-15T06:02:00Z", "event_msg", { info: { total_token_usage: usage(140, 30, 170) } })
  ]));
  const startMs = Date.parse("2026-07-15T06:01:00Z");
  const endMs = Date.parse("2026-07-15T06:03:00Z");
  assert.deepEqual(
    reportIndex.readIndexedRolloutUsageEvents({ codexDir: fixture.root, cachePath: fixture.cache, startMs, endMs }),
    readRolloutUsageEvents({ codexDir: fixture.root, startMs, endMs })
  );
});

function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "switcher-report-index-"));
  roots.push(root);
  const sessionDir = path.join(root, "sessions", "2026", "07", "15");
  fs.mkdirSync(sessionDir, { recursive: true });
  return {
    root,
    rollout: path.join(sessionDir, "rollout-synthetic.jsonl"),
    cache: path.join(root, "usage-report-index.json")
  };
}

function readIndexed(fixture, diagnostics = {}) {
  return reportIndex.readIndexedRolloutUsageEvents({ codexDir: fixture.root, cachePath: fixture.cache, diagnostics });
}

function lines(items) {
  return `${items.join("\n")}\n`;
}

function event(timestamp, type, payload) {
  return JSON.stringify({ timestamp, type, payload });
}

function usage(input, output, total) {
  return { input_tokens: input, cached_input_tokens: 0, output_tokens: output, reasoning_output_tokens: 0, total_tokens: total };
}
