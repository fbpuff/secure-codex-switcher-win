import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { atomicWriteJson, latestMatchingFiles, readJsonIfExists } from "./file-io.js";

export const OBSERVATION_VERSION = 1;
export const OBSERVATION_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const CAPACITY_MIN_DELTA = 2;
const UNSCHEDULED_RESET_DELTA = 5;
const RESET_CONFIRMATION_TOLERANCE = 2;

export function createObservationState(value = {}) {
  return {
    version: OBSERVATION_VERSION,
    intervals: Array.isArray(value.intervals) ? value.intervals.map(normalizeInterval).filter(Boolean) : [],
    quotaSnapshots: Array.isArray(value.quotaSnapshots) ? value.quotaSnapshots.map(normalizeSnapshot).filter(Boolean) : [],
    resetEvents: Array.isArray(value.resetEvents) ? value.resetEvents.map(normalizeResetEvent).filter(Boolean) : [],
    pendingResets: Array.isArray(value.pendingResets) ? value.pendingResets.map(normalizePendingReset).filter(Boolean) : []
  };
}

export function readObservationState(filePath) {
  try {
    return createObservationState(readJsonIfExists(filePath, {}));
  } catch {
    return createObservationState();
  }
}

export function writeObservationState(filePath, state) {
  atomicWriteJson(filePath, createObservationState(state));
}

export function setActiveAccount(state, { accountId, atMs, source = "unknown" }) {
  const timestamp = finiteTimestamp(atMs);
  if (timestamp === undefined) return state;
  const normalizedAccountId = nonEmptyString(accountId);
  const open = [...state.intervals].reverse().find((item) => item.endMs === undefined);
  if (open?.accountId === normalizedAccountId) return state;
  if (open) open.endMs = Math.max(open.startMs, timestamp);
  if (normalizedAccountId) {
    state.intervals.push({ accountId: normalizedAccountId, startMs: timestamp, endMs: undefined, source: safeLabel(source) });
  }
  state.intervals.sort((left, right) => left.startMs - right.startMs);
  return state;
}

export function accountAt(state, timestampMs) {
  const timestamp = finiteTimestamp(timestampMs);
  if (timestamp === undefined) return undefined;
  const matches = state.intervals.filter((item) => item.startMs <= timestamp && (item.endMs === undefined || timestamp < item.endMs));
  return matches.length === 1 ? matches[0].accountId : undefined;
}

export function appendQuotaSnapshot(state, value) {
  const snapshot = normalizeSnapshot(value);
  if (!snapshot) return state;
  const previous = [...state.quotaSnapshots].reverse().find((item) => item.accountId === snapshot.accountId && item.fetchedAtMs < snapshot.fetchedAtMs);
  if (previous) {
    detectReset(state, previous, snapshot, "fiveHour");
    detectReset(state, previous, snapshot, "oneWeek");
  }
  state.quotaSnapshots.push(snapshot);
  state.quotaSnapshots.sort((left, right) => left.fetchedAtMs - right.fetchedAtMs);
  return state;
}

export function pruneObservationState(state, nowMs = Date.now()) {
  const cutoff = nowMs - OBSERVATION_RETENTION_MS;
  state.quotaSnapshots = state.quotaSnapshots.filter((item) => item.fetchedAtMs >= cutoff);
  state.resetEvents = state.resetEvents.filter((item) => item.atMs >= cutoff);
  state.pendingResets = state.pendingResets.filter((item) => item.atMs >= cutoff);
  state.intervals = state.intervals
    .filter((item) => item.endMs === undefined || item.endMs >= cutoff)
    .map((item) => ({ ...item, startMs: Math.max(item.startMs, cutoff) }));
  return state;
}

export function readRolloutUsageEvents({ codexDir, startMs = -Infinity, endMs = Infinity }) {
  const files = [
    ...latestMatchingFiles(path.join(codexDir, "sessions"), /^rollout-.*\.jsonl$/),
    ...latestMatchingFiles(path.join(codexDir, "archived_sessions"), /^rollout-.*\.jsonl$/)
  ];
  const events = [];
  const seen = new Set();
  for (const file of files) {
    parseRolloutFile(file.path, events, seen, startMs, endMs);
  }
  return events.sort((left, right) => left.timestampMs - right.timestampMs);
}

export function buildWeeklyUsageReport({ state, tokenEvents, accounts = [], weekStartMs }) {
  const start = finiteTimestamp(weekStartMs) ?? startOfPreviousLocalWeek(Date.now());
  return buildUsageReport({ state, tokenEvents, accounts, start, end: start + WEEK_MS, mode: "weekly" });
}

export function buildDailyUsageReport({ state, tokenEvents, accounts = [], dayStartMs }) {
  const start = startOfLocalDay(finiteTimestamp(dayStartMs) ?? Date.now());
  const endDate = new Date(start);
  endDate.setDate(endDate.getDate() + 1);
  return buildUsageReport({ state, tokenEvents, accounts, start, end: endDate.getTime(), mode: "daily" });
}

function buildUsageReport({ state, tokenEvents, accounts, start, end, mode }) {
  const accountMetadata = new Map(accounts.map((account) => [account.id, account]));
  const accountBuckets = new Map();
  const unattributed = emptyUsageBucket();
  const eligibleEvents = tokenEvents.filter((event) => event.timestampMs >= start && event.timestampMs < end);
  const directAccountsBySession = new Map();

  for (const event of eligibleEvents) {
    const accountId = accountAt(state, event.timestampMs);
    if (!accountId || !event.sessionId) continue;
    const directAccounts = directAccountsBySession.get(event.sessionId) ?? new Set();
    directAccounts.add(accountId);
    directAccountsBySession.set(event.sessionId, directAccounts);
  }

  for (const event of eligibleEvents) {
    const directAccountId = accountAt(state, event.timestampMs);
    const sessionAccounts = directAccountsBySession.get(event.sessionId);
    const continuityAccountId = !directAccountId && sessionAccounts?.size === 1 ? [...sessionAccounts][0] : undefined;
    const accountId = directAccountId ?? continuityAccountId;
    if (!accountId) {
      addUsage(unattributed, event);
      continue;
    }
    const bucket = accountBuckets.get(accountId) ?? createAccountBucket(accountId, accountMetadata.get(accountId));
    addUsage(bucket, event);
    addGroupedUsage(bucket, event);
    if (event.sessionId) bucket._sessions.add(event.sessionId);
    if (continuityAccountId) bucket._mediumEvents += 1;
    accountBuckets.set(accountId, bucket);
  }

  const accountsReport = [...accountBuckets.values()].map(finalizeAccountBucket).sort((left, right) => right.totalTokens - left.totalTokens);
  const attributedTokens = accountsReport.reduce((sum, account) => sum + account.totalTokens, 0);
  const totalTokens = attributedTokens + unattributed.totalTokens;
  const fiveHourSamples = capacitySamples(state, eligibleEvents, start, end, "fiveHour");
  const oneWeekSamples = capacitySamples(state, eligibleEvents, start, end, "oneWeek");
  for (const account of accountsReport) {
    account.fiveHourQuotaRatePerHour = meanRate(fiveHourSamples.filter((item) => item.accountId === account.accountId));
    account.oneWeekQuotaRatePerHour = meanRate(oneWeekSamples.filter((item) => item.accountId === account.accountId));
    account.sharePercent = attributedTokens > 0 ? Math.round((account.totalTokens / attributedTokens) * 10_000) / 100 : 0;
    account.fiveHourQuotaChange = quotaChange(state, account.accountId, start, end, "fiveHour");
    account.oneWeekQuotaChange = quotaChange(state, account.accountId, start, end, "oneWeek");
    account.nextExpectedReset = latestExpectedReset(state, account.accountId);
  }
  return {
    generatedAt: Math.floor(Date.now() / 1000),
    mode,
    startMs: start,
    endMs: end,
    ...(mode === "weekly" ? { weekStartMs: start, weekEndMs: end } : { dayStartMs: start, dayEndMs: end }),
    source: "local_observation",
    accounts: accountsReport,
    unattributed,
    capacity: {
      fiveHour: capacitySummary(fiveHourSamples),
      oneWeek: capacitySummary(oneWeekSamples)
    },
    resets: reportResetEvents(state, accountMetadata, start, end),
    confidence: reportConfidence(accountsReport, unattributed),
    coverage: {
      attributedTokens,
      unattributedTokens: unattributed.totalTokens,
      totalTokens,
      percent: totalTokens > 0 ? Math.round((attributedTokens / totalTokens) * 10_000) / 100 : 0
    }
  };
}

function latestExpectedReset(state, accountId) {
  const snapshot = [...state.quotaSnapshots].reverse().find((item) => item.accountId === accountId);
  return {
    fiveHour: snapshot?.fiveHour?.resetAt ? snapshot.fiveHour.resetAt * 1000 : undefined,
    oneWeek: snapshot?.oneWeek?.resetAt ? snapshot.oneWeek.resetAt * 1000 : undefined
  };
}

function reportResetEvents(state, accountMetadata, start, end) {
  const unique = new Map();
  for (const event of state.resetEvents.filter((item) => item.atMs >= start && item.atMs < end)) {
    const cycle = event.previousResetAt ?? Math.floor(event.atMs / 120_000);
    const key = `${event.accountId}|${event.window}|${cycle}`;
    if (!unique.has(key)) unique.set(key, { ...event, emailMasked: accountMetadata.get(event.accountId)?.emailMasked ?? shortIdentifier(event.accountId) });
  }
  return [...unique.values()].sort((left, right) => left.atMs - right.atMs);
}

function quotaChange(state, accountId, start, end, windowName) {
  const snapshots = state.quotaSnapshots
    .filter((item) => item.accountId === accountId && item.fetchedAtMs >= start && item.fetchedAtMs < end && item[windowName])
    .sort((left, right) => left.fetchedAtMs - right.fetchedAtMs);
  let consumedPercent = 0;
  for (let index = 1; index < snapshots.length; index += 1) {
    const previous = snapshots[index - 1];
    const current = snapshots[index];
    if (previous[windowName].resetAt !== current[windowName].resetAt) continue;
    if (state.resetEvents.some((event) => event.accountId === accountId && event.window === windowName && event.atMs > previous.fetchedAtMs && event.atMs <= current.fetchedAtMs)) continue;
    consumedPercent += Math.max(0, current[windowName].usedPercent - previous[windowName].usedPercent);
  }
  return {
    consumedPercent: Math.round(consumedPercent * 100) / 100,
    resetCount: state.resetEvents.filter((event) => event.accountId === accountId && event.window === windowName && event.atMs >= start && event.atMs < end).length
  };
}

export function startOfLocalDay(nowMs = Date.now()) {
  const date = new Date(nowMs);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

export function startOfPreviousLocalWeek(nowMs = Date.now()) {
  const date = new Date(nowMs);
  date.setHours(0, 0, 0, 0);
  const daysSinceMonday = (date.getDay() + 6) % 7;
  date.setDate(date.getDate() - daysSinceMonday - 7);
  return date.getTime();
}

function parseRolloutFile(filePath, events, seen, startMs, endMs) {
  let text;
  try {
    text = fs.readFileSync(filePath, "utf8");
  } catch {
    return;
  }
  let model = "unknown";
  let reasoningEffort = "unknown";
  let sessionId = crypto.createHash("sha256").update(path.basename(filePath)).digest("hex").slice(0, 16);
  let previousCumulative;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    const payload = objectValue(event.payload);
    if (event.type === "session_meta") {
      sessionId = safeIdentifier(payload.id ?? payload.session_id) ?? sessionId;
    }
    if (event.type === "turn_context") {
      model = safeLabel(payload.model) || "unknown";
      reasoningEffort = safeLabel(payload.effort) || "unknown";
    }
    const timestampMs = parseTimestamp(event.timestamp);
    if (timestampMs === undefined || timestampMs < startMs || timestampMs >= endMs) continue;
    const info = objectValue(payload.info);
    const lastUsage = normalizeTokenUsage(info.last_token_usage);
    const cumulative = normalizeTokenUsage(info.total_token_usage);
    let usage = lastUsage;
    if (!usage && cumulative) {
      usage = previousCumulative ? subtractUsage(cumulative, previousCumulative) : undefined;
      previousCumulative = cumulative;
    } else if (cumulative) {
      previousCumulative = cumulative;
    }
    if (!usage || usage.totalTokens <= 0) continue;
    const key = `${sessionId}|${timestampMs}|${usage.totalTokens}|${usage.inputTokens}|${usage.outputTokens}`;
    if (seen.has(key)) continue;
    seen.add(key);
    events.push({ timestampMs, sessionId, model, reasoningEffort, ...usage, durationMs: 0 });
  }
}

function detectReset(state, previous, current, windowName) {
  const before = previous[windowName];
  const after = current[windowName];
  if (!before || !after) return;
  const pendingIndex = state.pendingResets.findIndex((item) => item.accountId === current.accountId && item.window === windowName);
  const pending = pendingIndex >= 0 ? state.pendingResets[pendingIndex] : undefined;
  if (pending) {
    if (after.usedPercent <= pending.recoveredUsedPercent + RESET_CONFIRMATION_TOLERANCE) {
      pushResetEvent(state, {
        accountId: current.accountId,
        window: windowName,
        atMs: pending.atMs,
        kind: "observed_unscheduled",
        cause: pending.explicitCause ?? "unknown",
        previousResetAt: pending.previousResetAt
      });
    }
    state.pendingResets.splice(pendingIndex, 1);
  }

  const recovery = before.usedPercent - after.usedPercent;
  if (recovery < CAPACITY_MIN_DELTA) return;
  const boundaryMs = before.resetAt * 1000;
  if (current.fetchedAtMs >= boundaryMs - 60_000) {
    pushResetEvent(state, {
      accountId: current.accountId,
      window: windowName,
      atMs: current.fetchedAtMs,
      kind: "scheduled",
      cause: "boundary",
      previousResetAt: before.resetAt
    });
    return;
  }
  if (recovery >= UNSCHEDULED_RESET_DELTA) {
    state.pendingResets.push({
      accountId: current.accountId,
      window: windowName,
      atMs: current.fetchedAtMs,
      recoveredUsedPercent: after.usedPercent,
      previousResetAt: before.resetAt,
      explicitCause: current.explicitResetCause === "reset_card" ? "reset_card" : undefined
    });
  }
}

function pushResetEvent(state, value) {
  const duplicate = state.resetEvents.some((item) => item.accountId === value.accountId
    && item.window === value.window
    && (value.previousResetAt ? item.previousResetAt === value.previousResetAt : Math.abs(item.atMs - value.atMs) < 120_000));
  if (!duplicate) state.resetEvents.push(value);
}

function capacitySamples(state, tokenEvents, start, end, windowName) {
  const samples = [];
  const byAccount = Map.groupBy(
    state.quotaSnapshots.filter((item) => item.fetchedAtMs >= start && item.fetchedAtMs < end && item[windowName]),
    (item) => item.accountId
  );
  for (const [accountId, snapshots] of byAccount) {
    snapshots.sort((left, right) => left.fetchedAtMs - right.fetchedAtMs);
    for (let index = 1; index < snapshots.length; index += 1) {
      const previous = snapshots[index - 1];
      const current = snapshots[index];
      const before = previous[windowName];
      const after = current[windowName];
      const delta = after.usedPercent - before.usedPercent;
      if (delta < CAPACITY_MIN_DELTA || before.resetAt !== after.resetAt) continue;
      if (!intervalCovers(state, accountId, previous.fetchedAtMs, current.fetchedAtMs)) continue;
      if (state.resetEvents.some((item) => item.accountId === accountId && item.window === windowName && item.atMs > previous.fetchedAtMs && item.atMs <= current.fetchedAtMs)) continue;
      const intervalEvents = tokenEvents.filter((event) => event.timestampMs > previous.fetchedAtMs && event.timestampMs <= current.fetchedAtMs && accountAt(state, event.timestampMs) === accountId);
      const tokens = intervalEvents.reduce((sum, event) => sum + event.totalTokens, 0);
      if (tokens <= 0) continue;
      const models = [...new Set(intervalEvents.map((event) => event.model || "unknown"))];
      const efforts = [...new Set(intervalEvents.map((event) => event.reasoningEffort || "unknown"))];
      samples.push({
        accountId,
        fromMs: previous.fetchedAtMs,
        toMs: current.fetchedAtMs,
        quotaDeltaPercent: delta,
        quotaRatePercentPerHour: Math.round((delta / ((current.fetchedAtMs - previous.fetchedAtMs) / 3_600_000)) * 100) / 100,
        localTokens: tokens,
        model: models.length === 1 ? models[0] : "mixed",
        reasoningEffort: efforts.length === 1 ? efforts[0] : "mixed",
        estimatedTokens: Math.round((tokens / delta) * 100),
        confidence: "low"
      });
    }
  }
  return samples;
}

function meanRate(samples) {
  if (!samples.length) return undefined;
  return Math.round((samples.reduce((sum, item) => sum + item.quotaRatePercentPerHour, 0) / samples.length) * 100) / 100;
}

function capacitySummary(samples) {
  const values = samples.map((item) => item.estimatedTokens).sort((left, right) => left - right);
  if (values.length === 0) return { samples, groups: [], count: 0, confidence: "insufficient" };
  const mean = values.length >= 2 ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length) : undefined;
  const median = values.length >= 2 ? Math.round(values.length % 2 ? values[(values.length - 1) / 2] : (values[values.length / 2 - 1] + values[values.length / 2]) / 2) : undefined;
  const groups = [...Map.groupBy(samples, (item) => `${item.model}|${item.reasoningEffort}`).entries()].map(([key, items]) => {
    const [model, reasoningEffort] = key.split("|");
    const summary = summarizeCapacityValues(items.map((item) => item.estimatedTokens));
    return { model, reasoningEffort, ...summary };
  });
  return {
    samples,
    groups,
    count: values.length,
    min: values[0],
    max: values.at(-1),
    mean,
    median,
    confidence: values.length >= 3 ? "medium" : "low"
  };
}

function summarizeCapacityValues(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const mean = Math.round(sorted.reduce((sum, value) => sum + value, 0) / sorted.length);
  const median = Math.round(sorted.length % 2 ? sorted[(sorted.length - 1) / 2] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2);
  return { count: sorted.length, min: sorted[0], max: sorted.at(-1), mean, median };
}

function intervalCovers(state, accountId, startMs, endMs) {
  return state.intervals.some((item) => item.accountId === accountId && item.startMs <= startMs && (item.endMs === undefined || item.endMs >= endMs));
}

function createAccountBucket(accountId, account = {}) {
  return { ...emptyUsageBucket(), accountId, emailMasked: account.emailMasked ?? shortIdentifier(accountId), planType: account.planType ?? "unknown", _models: new Map(), _sessions: new Set(), _mediumEvents: 0, _firstAt: undefined, _lastAt: undefined };
}

function addGroupedUsage(account, event) {
  const model = event.model || "unknown";
  const effort = event.reasoningEffort || "unknown";
  const modelBucket = account._models.get(model) ?? { ...emptyUsageBucket(), model, _reasoning: new Map() };
  addUsage(modelBucket, event);
  const reasoning = modelBucket._reasoning.get(effort) ?? { ...emptyUsageBucket(), reasoningEffort: effort };
  addUsage(reasoning, event);
  modelBucket._reasoning.set(effort, reasoning);
  account._models.set(model, modelBucket);
}

function finalizeAccountBucket(account) {
  const models = [...account._models.values()].map((model) => {
    const reasoning = [...model._reasoning.values()].sort((left, right) => right.totalTokens - left.totalTokens);
    delete model._reasoning;
    return { ...model, reasoning };
  }).sort((left, right) => right.totalTokens - left.totalTokens);
  delete account._models;
  const sessionCount = account._sessions.size;
  const attributionConfidence = account._mediumEvents > 0 ? "medium" : "high";
  delete account._sessions;
  delete account._mediumEvents;
  const durationMs = Math.max(0, (account._lastAt ?? 0) - (account._firstAt ?? 0));
  delete account._firstAt;
  delete account._lastAt;
  return { ...account, activeDurationMs: durationMs, tokenRatePerHour: durationMs > 0 ? Math.round(account.totalTokens / (durationMs / 3_600_000)) : undefined, sessionCount, averageTokensPerSession: sessionCount > 0 ? Math.round(account.totalTokens / sessionCount) : undefined, attributionConfidence, models };
}

function addUsage(target, usage) {
  for (const key of ["inputTokens", "cachedInputTokens", "outputTokens", "reasoningOutputTokens", "totalTokens"]) {
    target[key] += Number(usage[key]) || 0;
  }
  target.events += 1;
  if ("_firstAt" in target) {
    target._firstAt = target._firstAt === undefined ? usage.timestampMs : Math.min(target._firstAt, usage.timestampMs);
    target._lastAt = target._lastAt === undefined ? usage.timestampMs : Math.max(target._lastAt, usage.timestampMs);
  }
}

function emptyUsageBucket() {
  return { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 0, events: 0 };
}

function normalizeTokenUsage(value) {
  if (!value || typeof value !== "object") return undefined;
  const usage = {
    inputTokens: positiveNumber(value.input_tokens),
    cachedInputTokens: positiveNumber(value.cached_input_tokens),
    outputTokens: positiveNumber(value.output_tokens),
    reasoningOutputTokens: positiveNumber(value.reasoning_output_tokens),
    totalTokens: positiveNumber(value.total_tokens)
  };
  usage.totalTokens ||= usage.inputTokens + usage.outputTokens;
  return usage.totalTokens > 0 ? usage : undefined;
}

function subtractUsage(current, previous) {
  const result = {};
  for (const key of ["inputTokens", "cachedInputTokens", "outputTokens", "reasoningOutputTokens", "totalTokens"]) {
    result[key] = Math.max(0, current[key] - previous[key]);
  }
  return result.totalTokens > 0 ? result : undefined;
}

function normalizeSnapshot(value) {
  const accountId = nonEmptyString(value?.accountId);
  const fetchedAtMs = finiteTimestamp(value?.fetchedAtMs ?? Number(value?.fetchedAt) * 1000);
  if (!accountId || fetchedAtMs === undefined) return undefined;
  return {
    accountId,
    fetchedAtMs,
    source: safeLabel(value.source) || "chatgpt_usage_api",
    fiveHour: normalizeWindow(value.fiveHour),
    oneWeek: normalizeWindow(value.oneWeek),
    explicitResetCause: value.explicitResetCause === "reset_card" ? "reset_card" : undefined
  };
}

function normalizeWindow(value) {
  const usedPercent = Number(value?.usedPercent);
  const resetAt = Number(value?.resetAt);
  const windowSeconds = Number(value?.windowSeconds);
  if (!Number.isFinite(usedPercent) || !Number.isFinite(resetAt) || !Number.isFinite(windowSeconds)) return undefined;
  return { usedPercent: Math.max(0, Math.min(100, usedPercent)), resetAt, windowSeconds };
}

function normalizeInterval(value) {
  const accountId = nonEmptyString(value?.accountId);
  const startMs = finiteTimestamp(value?.startMs);
  if (!accountId || startMs === undefined) return undefined;
  const endMs = value.endMs === undefined ? undefined : finiteTimestamp(value.endMs);
  return { accountId, startMs, endMs, source: safeLabel(value.source) || "unknown" };
}

function normalizeResetEvent(value) {
  const accountId = nonEmptyString(value?.accountId);
  const atMs = finiteTimestamp(value?.atMs);
  if (!accountId || atMs === undefined || !["fiveHour", "oneWeek"].includes(value.window)) return undefined;
  return { accountId, window: value.window, atMs, kind: value.kind === "scheduled" ? "scheduled" : "observed_unscheduled", cause: value.cause === "reset_card" || value.cause === "boundary" ? value.cause : "unknown", previousResetAt: Number(value.previousResetAt) || undefined };
}

function normalizePendingReset(value) {
  const accountId = nonEmptyString(value?.accountId);
  const atMs = finiteTimestamp(value?.atMs);
  if (!accountId || atMs === undefined || !["fiveHour", "oneWeek"].includes(value.window)) return undefined;
  return { accountId, window: value.window, atMs, recoveredUsedPercent: Number(value.recoveredUsedPercent) || 0, previousResetAt: Number(value.previousResetAt) || undefined, explicitCause: value.explicitCause === "reset_card" ? "reset_card" : undefined };
}

function reportConfidence(accounts, unattributed) {
  const attributed = accounts.reduce((sum, item) => sum + item.totalTokens, 0);
  const total = attributed + unattributed.totalTokens;
  if (total === 0) return "insufficient";
  const ratio = attributed / total;
  return ratio >= 0.9 ? "high" : ratio >= 0.6 ? "medium" : "low";
}

function parseTimestamp(value) {
  if (typeof value === "number") return value > 10_000_000_000 ? value : value * 1000;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function finiteTimestamp(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : undefined;
}

function positiveNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function safeLabel(value) {
  return typeof value === "string" ? value.replace(/[^a-zA-Z0-9._-]/g, "").slice(0, 80) : "";
}

function safeIdentifier(value) {
  const text = nonEmptyString(value);
  return text ? crypto.createHash("sha256").update(text).digest("hex").slice(0, 16) : undefined;
}

function shortIdentifier(value) {
  return value.length > 12 ? `${value.slice(0, 6)}...${value.slice(-4)}` : value;
}

function objectValue(value) {
  return value && typeof value === "object" ? value : {};
}
