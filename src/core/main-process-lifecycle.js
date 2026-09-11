import fs from "node:fs";
import { beijingTimestamp } from "./beijing-time.js";
import path from "node:path";

export const MAIN_PROCESS_LIFECYCLE_MAX_RECORDS = 256;
export const MAIN_PROCESS_LIFECYCLE_MAX_BYTES = 64 * 1024;

const LIFECYCLE_EVENTS = new Set([
  "process_start",
  "app_ready",
  "window_created",
  "window_closed",
  "tray_created",
  "tray_destroyed",
  "renderer_gone",
  "quit_requested",
  "recoverable_error",
  "fatal_error",
  "process_exit"
]);
const LIFECYCLE_TOKEN_PATTERN = /^[a-z][a-z0-9_.-]{0,63}$/;

export function createMainProcessLifecycleRecord({
  event,
  phase = "unknown",
  reasonCode = "unspecified",
  pid = process.pid,
  version = "unknown",
  packaged = false,
  timestamp = new Date()
} = {}) {
  return {
    timestamp: normalizeTimestamp(timestamp),
    pid: Number.isSafeInteger(pid) && pid > 0 ? pid : 0,
    version: normalizeVersion(version),
    packaged: Boolean(packaged),
    event: LIFECYCLE_EVENTS.has(event) ? event : "unknown",
    phase: normalizeToken(phase, "unknown"),
    reasonCode: normalizeToken(reasonCode, "unspecified")
  };
}

export function appendMainProcessLifecycleRecord(filePath, record) {
  if (typeof filePath !== "string" || filePath.length === 0) return;

  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.appendFileSync(filePath, `${JSON.stringify(record)}\n`, "utf8");
    let lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/).filter(Boolean);
    if (lines.length <= MAIN_PROCESS_LIFECYCLE_MAX_RECORDS && byteLength(lines) <= MAIN_PROCESS_LIFECYCLE_MAX_BYTES) return;
    lines = lines.slice(-MAIN_PROCESS_LIFECYCLE_MAX_RECORDS);
    while (lines.length > 1 && byteLength(lines) > MAIN_PROCESS_LIFECYCLE_MAX_BYTES) {
      lines.shift();
    }
    fs.writeFileSync(filePath, `${lines.join("\n")}\n`, "utf8");
  } catch {}
}

export function normalizeMainProcessLifecycleToken(value, fallback = "unspecified") {
  return normalizeToken(value, fallback);
}

export function shouldQuitAfterAllWindowsClosed({
  platform = process.platform,
  isQuitting = false,
  explicitQuit = false
} = {}) {
  if (platform === "darwin") return false;
  return Boolean(isQuitting || explicitQuit);
}

function normalizeToken(value, fallback) {
  const fallbackText = String(fallback ?? "").trim().toLowerCase();
  const safeFallback = LIFECYCLE_TOKEN_PATTERN.test(fallbackText) ? fallbackText : "unspecified";
  const text = String(value ?? "").trim().toLowerCase();
  return LIFECYCLE_TOKEN_PATTERN.test(text) ? text : safeFallback;
}

function normalizeVersion(value) {
  const text = String(value ?? "").trim();
  return /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(text) ? text : "unknown";
}

function normalizeTimestamp(value) {
  const date = value instanceof Date ? value : new Date(value ?? Date.now());
  return beijingTimestamp(Number.isNaN(date.getTime()) ? Date.now() : date);
}

function byteLength(lines) {
  return Buffer.byteLength(`${lines.join("\n")}\n`, "utf8");
}
