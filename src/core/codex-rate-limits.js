import fs from "node:fs";
import path from "node:path";
import { latestMatchingFiles } from "./file-io.js";

const TAIL_BYTES = 8 * 1024 * 1024;
const WINDOW_SECONDS = Object.freeze({ 300: 18_000, 10_080: 604_800 });

export function readLatestCodexRateLimits(codexDir) {
  const files = latestMatchingFiles(path.join(codexDir, "sessions"), /^rollout-.*\.jsonl$/)
    .sort((left, right) => right.mtimeMs - left.mtimeMs);
  let latest;
  for (const file of files) {
    if (latest && file.mtimeMs <= latest.fetchedAt * 1000) break;
    const candidate = readLatestFromFile(file.path, file.size);
    if (candidate && (!latest || candidate.fetchedAt > latest.fetchedAt)) latest = candidate;
  }
  return latest;
}

export function mapCodexRateLimits(rateLimits, fetchedAt) {
  if (!rateLimits || !Number.isFinite(fetchedAt)) return undefined;
  const windows = [rateLimits.primary, rateLimits.secondary].filter(Boolean);
  const fiveHour = mapWindow(windows.find((item) => item.window_minutes === 300));
  const oneWeek = mapWindow(windows.find((item) => item.window_minutes === 10_080));
  if (!fiveHour && !oneWeek) return undefined;
  return {
    fetchedAt,
    source: "codex_app_server",
    limitId: text(rateLimits.limit_id),
    limitName: text(rateLimits.limit_name),
    fiveHour,
    oneWeek
  };
}

function readLatestFromFile(filePath, size) {
  let handle;
  try {
    handle = fs.openSync(filePath, "r");
    const length = Math.min(size, TAIL_BYTES);
    const buffer = Buffer.allocUnsafe(length);
    fs.readSync(handle, buffer, 0, length, size - length);
    const lines = buffer.toString("utf8").split(/\r?\n/);
    for (let index = lines.length - 1; index >= (size > length ? 1 : 0); index -= 1) {
      try {
        const entry = JSON.parse(lines[index]);
        const fetchedAt = Date.parse(entry?.timestamp) / 1000;
        const mapped = mapCodexRateLimits(entry?.payload?.rate_limits ?? entry?.payload?.info?.rate_limits, fetchedAt);
        if (mapped) return mapped;
      } catch {}
    }
  } catch {
  } finally {
    if (handle !== undefined) fs.closeSync(handle);
  }
  return undefined;
}

function mapWindow(value) {
  const usedPercent = Number(value?.used_percent);
  const resetAt = Number(value?.resets_at);
  const windowSeconds = WINDOW_SECONDS[value?.window_minutes];
  if (!Number.isFinite(usedPercent) || usedPercent < 0 || usedPercent > 100 || !Number.isFinite(resetAt) || !windowSeconds) {
    return undefined;
  }
  return { usedPercent, remainingPercent: 100 - usedPercent, resetAt, windowSeconds };
}

function text(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
