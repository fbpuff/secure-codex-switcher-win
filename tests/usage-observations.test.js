import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const moduleUrl = new URL("../src/core/usage-observations.js", import.meta.url);
const moduleExists = fs.existsSync(moduleUrl);
const observations = moduleExists ? await import(moduleUrl) : {};

test("usage observation module exists", () => {
  assert.equal(moduleExists, true);
});

test("parses rollout token events with model and reasoning context without content", () => {
  if (!observations.readRolloutUsageEvents) return;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "switcher-observation-test-"));
  const sessionDir = path.join(root, "sessions", "2026", "07", "06");
  fs.mkdirSync(sessionDir, { recursive: true });
  const rolloutPath = path.join(sessionDir, "rollout-synthetic.jsonl");
  fs.writeFileSync(rolloutPath, [
    event("2026-07-06T01:00:00Z", "turn_context", { model: "gpt-test", effort: "high", summary: "private" }),
    event("2026-07-06T01:01:00Z", "event_msg", { message: "do not read", info: { last_token_usage: usage(100, 20, 120) } }),
    event("2026-07-06T02:00:00Z", "turn_context", { model: "gpt-test-fast", effort: "medium" }),
    event("2026-07-06T02:01:00Z", "event_msg", { info: { last_token_usage: usage(40, 10, 50) } }),
    event("2026-07-06T02:02:00Z", "event_msg", { info: { total_token_usage: usage(100, 20, 120) } }),
    event("2026-07-06T02:03:00Z", "event_msg", { info: { total_token_usage: usage(140, 30, 170) } })
  ].join("\n") + "\n", "utf8");

  const parsed = observations.readRolloutUsageEvents({ codexDir: root });

  assert.equal(parsed.length, 3);
  assert.deepEqual(parsed.map((item) => [item.model, item.reasoningEffort, item.totalTokens]), [
    ["gpt-test", "high", 120],
    ["gpt-test-fast", "medium", 50],
    ["gpt-test-fast", "medium", 50]
  ]);
  assert.doesNotMatch(JSON.stringify(parsed), /private|do not read/);

  fs.appendFileSync(rolloutPath, event("2026-07-06T03:01:00Z", "event_msg", { info: { last_token_usage: usage(5, 2, 7) } }) + "\n");
  assert.equal(observations.readRolloutUsageEvents({ codexDir: root }).length, 4);
  fs.writeFileSync(rolloutPath, event("2026-07-06T04:01:00Z", "event_msg", { info: { last_token_usage: usage(3, 1, 4) } }) + "\n");
  const truncated = observations.readRolloutUsageEvents({ codexDir: root });
  assert.equal(truncated.length, 1);
  assert.equal(truncated[0].model, "unknown");
});

test("recovers corrupt local observation state and prunes expired metadata", () => {
  if (!observations.readObservationState) return;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "switcher-observation-state-"));
  const statePath = path.join(root, "usage-observations.json");
  fs.writeFileSync(statePath, "{broken", "utf8");
  const recovered = observations.readObservationState(statePath);
  assert.equal(recovered.version, 1);
  assert.equal(recovered.intervals.length, 0);

  const nowMs = Date.parse("2026-07-11T12:00:00Z");
  const state = observations.createObservationState({
    intervals: [{ accountId: "old", startMs: nowMs - 100 * 86_400_000, endMs: nowMs - 99 * 86_400_000, source: "test" }],
    quotaSnapshots: [{ accountId: "old", fetchedAtMs: nowMs - 100 * 86_400_000, source: "test", fiveHour: { usedPercent: 10, resetAt: 1, windowSeconds: 18_000 } }]
  });
  observations.pruneObservationState(state, nowMs);
  observations.writeObservationState(statePath, state);
  assert.equal(observations.readObservationState(statePath).quotaSnapshots.length, 0);
  assert.equal(observations.readObservationState(statePath).intervals.length, 0);
});

test("tracks unambiguous active-account intervals and leaves gaps unattributed", () => {
  if (!observations.createObservationState) return;
  const state = observations.createObservationState();
  observations.setActiveAccount(state, { accountId: "account-a", atMs: 1_000, source: "import" });
  observations.setActiveAccount(state, { accountId: "account-b", atMs: 2_000, source: "switch" });
  observations.setActiveAccount(state, { accountId: undefined, atMs: 3_000, source: "login_new" });

  assert.equal(observations.accountAt(state, 1_500), "account-a");
  assert.equal(observations.accountAt(state, 2_500), "account-b");
  assert.equal(observations.accountAt(state, 3_500), undefined);
  const overlapping = observations.createObservationState({ intervals: [
    { accountId: "account-a", startMs: 1_000, endMs: 3_000, source: "test" },
    { accountId: "account-b", startMs: 2_000, endMs: 4_000, source: "test" }
  ] });
  assert.equal(observations.accountAt(overlapping, 2_500), undefined);
  assert.doesNotMatch(JSON.stringify(state), /@|access_token|refresh_token/);
});

test("detects scheduled and confirmed unscheduled resets without inventing reset cards", () => {
  if (!observations.appendQuotaSnapshot) return;
  const state = observations.createObservationState();
  observations.appendQuotaSnapshot(state, snapshot("scheduled", 1_000, 80, 2));
  observations.appendQuotaSnapshot(state, snapshot("scheduled", 2_100, 5, 20_000));
  assert.equal(state.resetEvents[0].kind, "scheduled");
  assert.equal(state.resetEvents[0].cause, "boundary");

  observations.appendQuotaSnapshot(state, snapshot("manual", 3_000, 80, 30_000));
  observations.appendQuotaSnapshot(state, snapshot("manual", 4_000, 30, 30_000));
  assert.equal(state.resetEvents.filter((item) => item.accountId === "manual").length, 0);
  observations.appendQuotaSnapshot(state, snapshot("manual", 5_000, 31, 30_000));
  const unscheduled = state.resetEvents.find((item) => item.accountId === "manual");
  assert.equal(unscheduled.kind, "observed_unscheduled");
  assert.equal(unscheduled.cause, "unknown");

  observations.appendQuotaSnapshot(state, snapshot("card", 6_000, 90, 40_000));
  observations.appendQuotaSnapshot(state, { ...snapshot("card", 7_000, 20, 40_000), explicitResetCause: "reset_card" });
  observations.appendQuotaSnapshot(state, snapshot("card", 8_000, 21, 40_000));
  assert.equal(state.resetEvents.find((item) => item.accountId === "card").cause, "reset_card");
});

test("records a 5h boundary independently without inventing a 7d reset", () => {
  const state = observations.createObservationState();
  const before = snapshot("independent", 1_000, 80, 2);
  before.oneWeek = { usedPercent: 40, resetAt: 40_000, windowSeconds: 604_800 };
  const after = snapshot("independent", 2_100, 5, 20_000);
  after.oneWeek = { usedPercent: 41, resetAt: 40_000, windowSeconds: 604_800 };
  observations.appendQuotaSnapshot(state, before);
  observations.appendQuotaSnapshot(state, after);
  assert.deepEqual(state.resetEvents.map((item) => item.window), ["fiveHour"]);
});

test("deduplicates one reset cycle while preserving different accounts", () => {
  const detected = observations.createObservationState();
  observations.appendQuotaSnapshot(detected, snapshot("same", 1_000, 80, 2));
  observations.appendQuotaSnapshot(detected, snapshot("same", 2_100, 5, 2));
  observations.appendQuotaSnapshot(detected, snapshot("same", 3_000, 80, 2));
  observations.appendQuotaSnapshot(detected, snapshot("same", 4_000, 5, 2));
  assert.equal(detected.resetEvents.length, 1);

  const state = observations.createObservationState({ resetEvents: [
    { accountId: "a", window: "fiveHour", atMs: 1_000, kind: "scheduled", cause: "boundary", previousResetAt: 100 },
    { accountId: "a", window: "fiveHour", atMs: 2_000, kind: "scheduled", cause: "boundary", previousResetAt: 100 },
    { accountId: "b", window: "fiveHour", atMs: 2_000, kind: "scheduled", cause: "boundary", previousResetAt: 100 }
  ] });
  const start = Date.parse("2026-07-11T00:00:00");
  state.resetEvents.forEach((event, index) => { event.atMs = start + index * 1_000; });
  const report = observations.buildDailyUsageReport({ state, tokenEvents: [], accounts: [
    { id: "a", emailMasked: "a***@mail.com" }, { id: "b", emailMasked: "b***@mail.com" }
  ], dayStartMs: start });
  assert.equal(report.resets.length, 2);
  assert.deepEqual(report.resets.map((item) => item.emailMasked).sort(), ["a***@mail.com", "b***@mail.com"]);
});

test("reports the latest expected reset time for each account window", () => {
  const start = Date.parse("2026-07-11T00:00:00");
  const state = observations.createObservationState();
  observations.setActiveAccount(state, { accountId: "a", atMs: start, source: "test" });
  observations.appendQuotaSnapshot(state, snapshot("a", start + 1_000, 10, Math.floor((start + 3_600_000) / 1000)));
  observations.appendQuotaSnapshot(state, snapshot("a", start + 2_000, 11, Math.floor((start + 7_200_000) / 1000)));
  const report = observations.buildDailyUsageReport({ state, tokenEvents: [tokenEvent(start + 1_500, 10)], accounts: [{ id: "a", emailMasked: "a***@mail.com" }], dayStartMs: start });
  assert.equal(report.accounts[0].nextExpectedReset.fiveHour, start + 7_200_000);
  assert.equal(report.accounts[0].nextExpectedReset.oneWeek, start + 7_200_000 + 500_000_000);
});

test("builds weekly account model reasoning and capacity summaries", () => {
  if (!observations.buildWeeklyUsageReport) return;
  const weekStartMs = Date.parse("2026-07-06T00:00:00");
  const state = observations.createObservationState();
  observations.setActiveAccount(state, { accountId: "account-a", atMs: weekStartMs, source: "startup" });
  observations.appendQuotaSnapshot(state, snapshot("account-a", weekStartMs + 1_000, 10, Math.floor((weekStartMs + 100_000) / 1000)));
  observations.appendQuotaSnapshot(state, snapshot("account-a", weekStartMs + 61_000, 20, Math.floor((weekStartMs + 100_000) / 1000)));
  const events = [
    tokenEvent(weekStartMs + 10_000, 100, "gpt-test", "high"),
    tokenEvent(weekStartMs + 20_000, 50, "gpt-test", "high")
  ];

  const report = observations.buildWeeklyUsageReport({
    state,
    tokenEvents: events,
    accounts: [{ id: "account-a", emailMasked: "a***@mail.test", planType: "plus" }],
    weekStartMs
  });

  assert.equal(report.accounts[0].totalTokens, 150);
  assert.equal(report.accounts[0].models[0].model, "gpt-test");
  assert.equal(report.accounts[0].models[0].reasoning[0].reasoningEffort, "high");
  assert.equal(report.capacity.fiveHour.samples[0].estimatedTokens, 1_500);
  assert.equal(report.capacity.fiveHour.samples[0].quotaRatePercentPerHour, 600);
  assert.equal(report.accounts[0].fiveHourQuotaRatePerHour, 600);
  assert.deepEqual(report.capacity.fiveHour.groups[0], {
    model: "gpt-test",
    reasoningEffort: "high",
    count: 1,
    min: 1_500,
    max: 1_500,
    mean: 1_500,
    median: 1_500
  });
  assert.equal(report.unattributed.totalTokens, 0);
});

test("rejects capacity samples that cross a recorded reset", () => {
  if (!observations.buildWeeklyUsageReport) return;
  const weekStartMs = Date.parse("2026-07-06T00:00:00");
  const state = observations.createObservationState({
    intervals: [{ accountId: "account-a", startMs: weekStartMs, source: "test" }],
    quotaSnapshots: [
      snapshot("account-a", weekStartMs + 1_000, 10, Math.floor((weekStartMs + 100_000) / 1000)),
      snapshot("account-a", weekStartMs + 61_000, 20, Math.floor((weekStartMs + 100_000) / 1000))
    ],
    resetEvents: [{ accountId: "account-a", window: "fiveHour", atMs: weekStartMs + 30_000, kind: "observed_unscheduled", cause: "unknown" }]
  });
  const report = observations.buildWeeklyUsageReport({ state, tokenEvents: [tokenEvent(weekStartMs + 20_000, 100, "gpt-test", "high")], weekStartMs });
  assert.equal(report.capacity.fiveHour.count, 0);
});

test("builds a local daily report with start-inclusive end-exclusive boundaries", () => {
  assert.equal(typeof observations.buildDailyUsageReport, "function");
  const dayStartMs = new Date(2026, 6, 10, 0, 0, 0, 0).getTime();
  const nextDayMs = new Date(2026, 6, 11, 0, 0, 0, 0).getTime();
  const state = observations.createObservationState({
    intervals: [{ accountId: "account-a", startMs: dayStartMs, endMs: dayStartMs + 3_600_000, source: "test" }],
    resetEvents: [{ accountId: "account-a", window: "fiveHour", atMs: dayStartMs + 30_000, kind: "scheduled", cause: "boundary" }]
  });
  const report = observations.buildDailyUsageReport({
    state,
    dayStartMs,
    accounts: [{ id: "account-a", emailMasked: "a***@mail.test", planType: "plus" }],
    tokenEvents: [
      tokenEvent(dayStartMs - 1, 999, "outside", "low"),
      tokenEvent(dayStartMs, 100, "gpt-test", "high"),
      tokenEvent(dayStartMs + 7_200_000, 50, "gpt-other", "medium"),
      tokenEvent(nextDayMs, 999, "outside", "low")
    ]
  });
  assert.equal(report.mode, "daily");
  assert.equal(report.startMs, dayStartMs);
  assert.equal(report.endMs, nextDayMs);
  assert.equal(report.accounts[0].totalTokens, 100);
  assert.equal(report.accounts[0].models[0].reasoning[0].reasoningEffort, "high");
  assert.equal(report.unattributed.totalTokens, 50);
  assert.equal(report.resets.length, 1);
  assert.equal(report.capacity.fiveHour.confidence, "insufficient");
});

test("attributes conflict-free session gaps and reports intuitive account metrics", () => {
  const start = new Date(2026, 6, 10).getTime();
  const resetAtA = Math.floor((start + 10_000_000) / 1000);
  const resetAtB = resetAtA + 20_000;
  const state = observations.createObservationState({
    intervals: [
      { accountId: "a", startMs: start, endMs: start + 3_600_000, source: "test" },
      { accountId: "b", startMs: start + 10_800_000, source: "test" }
    ],
    quotaSnapshots: [
      snapshot("a", start + 1_000, 10, resetAtA),
      snapshot("a", start + 2_000, 20, resetAtA),
      snapshot("a", start + 4_000, 5, resetAtB),
      snapshot("a", start + 5_000, 15, resetAtB)
    ],
    resetEvents: [{ accountId: "a", window: "fiveHour", atMs: start + 3_000, kind: "scheduled", cause: "boundary" }]
  });
  const events = [
    { ...tokenEvent(start + 1_000, 100, "gpt", "high"), sessionId: "one" },
    { ...tokenEvent(start + 7_200_000, 50, "gpt", "high"), sessionId: "one" },
    { ...tokenEvent(start + 2_000, 20, "gpt", "medium"), sessionId: "conflict" },
    { ...tokenEvent(start + 10_800_000, 30, "gpt", "medium"), sessionId: "conflict" },
    { ...tokenEvent(start + 7_300_000, 40, "gpt", "medium"), sessionId: "conflict" }
  ];
  const report = observations.buildDailyUsageReport({ state, tokenEvents: events, accounts: [{ id: "a" }, { id: "b" }], dayStartMs: start });
  const accountA = report.accounts.find((item) => item.accountId === "a");
  assert.equal(accountA.totalTokens, 170);
  assert.equal(accountA.sessionCount, 2);
  assert.equal(accountA.averageTokensPerSession, 85);
  assert.equal(accountA.attributionConfidence, "medium");
  assert.equal(accountA.fiveHourQuotaChange.consumedPercent, 20);
  assert.equal(accountA.fiveHourQuotaChange.resetCount, 1);
  assert.equal(report.unattributed.totalTokens, 40);
  assert.equal(report.coverage.attributedTokens, 200);
  assert.equal(report.coverage.totalTokens, 240);
  assert.equal(report.coverage.percent, 83.33);
});

function event(timestamp, type, payload) {
  return JSON.stringify({ timestamp, type, payload });
}

function usage(input, output, total) {
  return { input_tokens: input, output_tokens: output, total_tokens: total, cached_input_tokens: 0, reasoning_output_tokens: 0 };
}

function snapshot(accountId, fetchedAtMs, usedPercent, resetAt) {
  return {
    accountId,
    fetchedAtMs,
    source: "chatgpt_usage_api",
    fiveHour: { usedPercent, resetAt, windowSeconds: 18_000 },
    oneWeek: { usedPercent, resetAt: resetAt + 500_000, windowSeconds: 604_800 }
  };
}

function tokenEvent(timestampMs, totalTokens, model, reasoningEffort) {
  return {
    timestampMs,
    model,
    reasoningEffort,
    inputTokens: totalTokens,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens,
    durationMs: 0
  };
}
