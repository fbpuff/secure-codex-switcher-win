import fs from "node:fs";
import path from "node:path";
import { atomicWriteJson, latestMatchingFiles, readJsonIfExists } from "./file-io.js";

const TOKEN_USAGE_CACHE_VERSION = 1;

export function getTokenUsageStats({ codexDir, nowMs, cachePath }) {
  const now = new Date(nowMs);
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const sevenDaysStart = todayStart - 6 * 24 * 60 * 60 * 1000;
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  const totals = {
    today: emptyTokenBucket(),
    sevenDays: emptyTokenBucket(),
    month: emptyTokenBucket()
  };
  const dailySevenDays = createDailyTokenBuckets(sevenDaysStart, 7);
  let latestAt;
  let scannedEvents = 0;
  let countedEvents = 0;
  const cache = readTokenUsageCache(cachePath);
  const nextCache = { version: TOKEN_USAGE_CACHE_VERSION, files: {} };
  let cacheChanged = false;

  for (const file of rolloutFiles(codexDir)) {
    const cached = cache.files[file.path];
    const { summary, changed } = tokenUsageSummaryForFile(file, cached);
    if (!summary) {
      continue;
    }
    cacheChanged ||= changed;
    nextCache.files[file.path] = summary;
    scannedEvents += summary.scannedEvents;
    countedEvents += summary.countedEvents;
    latestAt = latestAt === undefined ? summary.latestAt : Math.max(latestAt, summary.latestAt ?? 0);
    addTokenUsageSummary(totals, dailySevenDays, summary, { todayStart, sevenDaysStart, monthStart, nowMs });
  }

  if (cachePath && (cacheChanged || Object.keys(cache.files).length !== Object.keys(nextCache.files).length)) {
    try {
      atomicWriteJson(cachePath, nextCache);
    } catch {}
  }

  return {
    source: "local_rollout_last_token_usage",
    generatedAt: Math.floor(nowMs / 1000),
    latestAt: latestAt ? Math.floor(latestAt / 1000) : undefined,
    scannedEvents,
    countedEvents,
    dailySevenDays: dailySevenDays.map(({ startMs, endMs, ...bucket }) => bucket),
    totals
  };
}

function readTokenUsageCache(cachePath) {
  const empty = { version: TOKEN_USAGE_CACHE_VERSION, files: {} };
  if (!cachePath) {
    return empty;
  }
  try {
    const cache = readJsonIfExists(cachePath, empty);
    if (cache?.version !== TOKEN_USAGE_CACHE_VERSION || !cache.files || typeof cache.files !== "object") {
      return empty;
    }
    return cache;
  } catch {
    return empty;
  }
}

function tokenUsageSummaryForFile(file, cached) {
  if (cached && cached.size === file.size && cached.mtimeMs === file.mtimeMs) {
    return { summary: cached, changed: false };
  }
  if (cached && cached.size === file.size && file.size >= 0) {
    return { summary: { ...cached, mtimeMs: file.mtimeMs }, changed: true };
  }
  if (cached && Number.isFinite(cached.size) && cached.size > 0 && file.size > cached.size) {
    const summary = cloneTokenUsageSummary(cached);
    summary.size = file.size;
    summary.mtimeMs = file.mtimeMs;
    parseTokenUsageText(readFileSlice(file.path, cached.size), summary);
    return { summary, changed: true };
  }
  const summary = emptyTokenUsageFileSummary(file);
  try {
    parseTokenUsageText(fs.readFileSync(file.path, "utf8"), summary);
  } catch {
    return { summary: undefined, changed: false };
  }
  return { summary, changed: true };
}

function readFileSlice(filePath, start) {
  const stat = fs.statSync(filePath);
  const length = Math.max(0, stat.size - start);
  if (length === 0) {
    return "";
  }
  const descriptor = fs.openSync(filePath, "r");
  try {
    const buffer = Buffer.alloc(length);
    fs.readSync(descriptor, buffer, 0, length, start);
    return buffer.toString("utf8");
  } finally {
    fs.closeSync(descriptor);
  }
}

function emptyTokenUsageFileSummary(file) {
  return {
    path: file.path,
    size: file.size,
    mtimeMs: file.mtimeMs,
    scannedEvents: 0,
    countedEvents: 0,
    latestAt: undefined,
    days: {}
  };
}

function cloneTokenUsageSummary(summary) {
  return {
    ...summary,
    days: Object.fromEntries(
      Object.entries(summary.days ?? {}).map(([date, bucket]) => [date, { ...emptyTokenBucket(), ...bucket }])
    )
  };
}

function parseTokenUsageText(text, summary) {
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    summary.scannedEvents += 1;
    if (!line.includes("last_token_usage")) {
      continue;
    }
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    const usage = normalizeTokenUsage(event?.payload?.info?.last_token_usage);
    if (!usage) {
      continue;
    }
    const eventTime = parseEventTimestamp(event.timestamp);
    if (!Number.isFinite(eventTime)) {
      continue;
    }
    const date = localDateKey(eventTime);
    summary.countedEvents += 1;
    summary.latestAt = summary.latestAt === undefined ? eventTime : Math.max(summary.latestAt, eventTime);
    summary.days[date] ??= emptyTokenBucket();
    addTokenUsage(summary.days[date], usage);
  }
}

function addTokenUsageSummary(totals, dailySevenDays, summary, range) {
  for (const [date, bucket] of Object.entries(summary.days ?? {})) {
    const dayStart = Date.parse(`${date}T00:00:00`);
    if (!Number.isFinite(dayStart) || dayStart > range.nowMs) {
      continue;
    }
    if (dayStart >= range.todayStart) {
      addTokenUsage(totals.today, bucket);
    }
    if (dayStart >= range.sevenDaysStart) {
      addTokenUsage(totals.sevenDays, bucket);
      const daily = dailySevenDays.find((item) => item.date === date);
      if (daily) {
        addTokenUsage(daily, bucket);
      }
    }
    if (dayStart >= range.monthStart) {
      addTokenUsage(totals.month, bucket);
    }
  }
}

function localDateKey(timestampMs) {
  const date = new Date(timestampMs);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function createDailyTokenBuckets(startMs, count) {
  return Array.from({ length: count }, (_item, index) => {
    const start = startMs + index * 24 * 60 * 60 * 1000;
    const date = new Date(start);
    return {
      ...emptyTokenBucket(),
      date: `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`,
      startMs: start,
      endMs: start + 24 * 60 * 60 * 1000
    };
  });
}

function rolloutFiles(codexDir) {
  return [
    ...latestMatchingFiles(path.join(codexDir, "sessions"), /^rollout-.*\.jsonl$/),
    ...latestMatchingFiles(path.join(codexDir, "archived_sessions"), /^rollout-.*\.jsonl$/)
  ];
}

function emptyTokenBucket() {
  return {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0,
    events: 0
  };
}

function normalizeTokenUsage(value) {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const totalTokens = nonNegativeNumber(value.total_tokens);
  const inputTokens = nonNegativeNumber(value.input_tokens);
  const cachedInputTokens = nonNegativeNumber(value.cached_input_tokens);
  const outputTokens = nonNegativeNumber(value.output_tokens);
  const reasoningOutputTokens = nonNegativeNumber(value.reasoning_output_tokens);
  if ([totalTokens, inputTokens, cachedInputTokens, outputTokens, reasoningOutputTokens].every((item) => item === 0)) {
    return undefined;
  }
  return {
    inputTokens,
    cachedInputTokens,
    outputTokens,
    reasoningOutputTokens,
    totalTokens: totalTokens || inputTokens + outputTokens,
    events: 1
  };
}

function nonNegativeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function addTokenUsage(target, usage) {
  target.inputTokens += usage.inputTokens;
  target.cachedInputTokens += usage.cachedInputTokens;
  target.outputTokens += usage.outputTokens;
  target.reasoningOutputTokens += usage.reasoningOutputTokens;
  target.totalTokens += usage.totalTokens;
  target.events += usage.events;
}

function parseEventTimestamp(value) {
  if (typeof value === "number") {
    return value > 10_000_000_000 ? value : value * 1000;
  }
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}
