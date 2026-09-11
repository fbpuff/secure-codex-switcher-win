import fs from "node:fs";
import { beijingTimestamp } from "./beijing-time.js";
import path from "node:path";

export const EDGE_WINDOW_LIFECYCLE_MAX_RECORDS = 512;
export const EDGE_WINDOW_LIFECYCLE_MAX_BYTES = 128 * 1024;

const LIFECYCLE_EVENTS = new Set([
  "panel_create_requested",
  "panel_created",
  "panel_load_started",
  "panel_renderer_ready",
  "panel_ready_to_show",
  "panel_shown",
  "panel_hidden",
  "panel_focus",
  "panel_blur",
  "panel_renderer_gone",
  "panel_destroy_requested",
  "panel_closed",
  "handle_create_requested",
  "handle_created",
  "handle_load_started",
  "handle_renderer_ready",
  "handle_renderer_gone",
  "handle_shown",
  "handle_hidden",
  "handle_destroy_requested",
  "handle_closed",
  "auto_hide_scheduled",
  "auto_hide_cancelled",
  "auto_hide_skipped",
  "auto_hide_executing",
  "reveal_requested",
  "reveal_applied",
  "reproject_requested",
  "reproject_skipped",
  "reproject_applied",
  "move_started",
  "move_settled",
  "resize_started",
  "resize_settled",
  "placement_saved",
  "recovery_scheduled",
  "recovery_started",
  "recovery_completed",
  "recovery_failed",
  "renderer_boot",
  "renderer_visibility",
  "renderer_pagehide",
  "renderer_error",
  "renderer_unhandled_rejection",
  "edge_error",
  "handle_geometry"
]);
const TOKEN_PATTERN = /^[a-z][a-z0-9_.-]{0,63}$/;

export function createEdgeWindowLifecycleRecord({
  event,
  surface = "panel",
  phase = "unknown",
  reasonCode = "unspecified",
  side,
  visible,
  destroyed,
  bounds,
  contentBounds,
  requestedBounds,
  scaleFactor,
  rendererState,
  recoveryAttempt,
  errorCode,
  pid = process.pid,
  version = "unknown",
  packaged = false,
  timestamp = new Date()
} = {}) {
  const record = {
    timestamp: normalizeTimestamp(timestamp),
    pid: Number.isSafeInteger(pid) && pid > 0 ? pid : 0,
    version: normalizeVersion(version),
    packaged: Boolean(packaged),
    surface: normalizeToken(surface, "panel"),
    event: LIFECYCLE_EVENTS.has(event) ? event : "unknown",
    phase: normalizeToken(phase, "unknown"),
    reason: normalizeToken(reasonCode, "unspecified")
  };
  if (side === "left" || side === "right") record.side = side;
  if (typeof visible === "boolean") record.visible = visible;
  if (typeof destroyed === "boolean") record.destroyed = destroyed;
  const safeBounds = normalizeBounds(bounds);
  if (safeBounds) record.bounds = safeBounds;
  if (normalizeBounds(contentBounds)) record.contentBounds = normalizeBounds(contentBounds);
  if (normalizeBounds(requestedBounds)) record.requestedBounds = normalizeBounds(requestedBounds);
  if (Number.isFinite(scaleFactor) && scaleFactor > 0 && scaleFactor <= 8) record.scaleFactor = scaleFactor;
  if (rendererState !== undefined) record.rendererState = normalizeToken(rendererState, "unknown");
  if (Number.isSafeInteger(recoveryAttempt) && recoveryAttempt >= 0) record.recoveryAttempt = recoveryAttempt;
  if (errorCode !== undefined) record.errorCode = normalizeToken(errorCode, "unknown");
  return record;
}

export function appendEdgeWindowLifecycleRecord(filePath, record) {
  if (typeof filePath !== "string" || filePath.length === 0 || !record || typeof record !== "object") return false;
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.appendFileSync(filePath, `${JSON.stringify(record)}\n`, "utf8");
    let lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/).filter(Boolean);
    if (lines.length <= EDGE_WINDOW_LIFECYCLE_MAX_RECORDS && byteLength(lines) <= EDGE_WINDOW_LIFECYCLE_MAX_BYTES) return true;
    lines = lines.slice(-EDGE_WINDOW_LIFECYCLE_MAX_RECORDS);
    while (lines.length > 1 && byteLength(lines) > EDGE_WINDOW_LIFECYCLE_MAX_BYTES) lines.shift();
    fs.writeFileSync(filePath, `${lines.join("\n")}\n`, "utf8");
    return true;
  } catch {
    return false;
  }
}

export function normalizeEdgeWindowLifecycleToken(value, fallback = "unspecified") {
  return normalizeToken(value, fallback);
}

export function createEdgeLifecycleWriter(filePath) {
  let pending = [];
  let timer;
  let active;
  let history;
  let dirty = false;
  const trim = (lines) => {
    lines = lines.slice(-EDGE_WINDOW_LIFECYCLE_MAX_RECORDS);
    while (lines.length && byteLength(lines) > EDGE_WINDOW_LIFECYCLE_MAX_BYTES) lines.shift();
    return lines;
  };
  async function flush() {
    clearTimeout(timer);
    timer = undefined;
    if (active) return active;
    active = (async () => {
      try {
        await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
        if (!history) {
          try { history = trim((await fs.promises.readFile(filePath, "utf8")).split(/\r?\n/).filter(Boolean)); }
          catch (error) { if (error.code !== "ENOENT") throw error; history = []; }
        }
        while (pending.length || dirty) {
          const batch = pending;
          pending = [];
          history = trim([...history, ...batch]);
          dirty = true;
          await fs.promises.writeFile(filePath + ".pending", history.length ? history.join("\n") + "\n" : "", "utf8");
          await fs.promises.rename(filePath + ".pending", filePath);
          dirty = false;
        }
        return true;
      } catch {
        // Retain the bounded in-memory suffix for the next attempt.
        return false;
      } finally { active = undefined; }
    })();
    return active;
  }
  return {
    append(record) {
      if (!record || typeof record !== "object") return false;
      const line = JSON.stringify(record);
      if (Buffer.byteLength(line) + 1 > EDGE_WINDOW_LIFECYCLE_MAX_BYTES) return false;
      pending.push(line);
      if (pending.length > EDGE_WINDOW_LIFECYCLE_MAX_RECORDS) pending.shift();
      if (!timer && !active) timer = setTimeout(() => { void flush(); }, 100);
      timer?.unref?.();
      return true;
    },
    flush
  };
}

function normalizeToken(value, fallback) {
  const fallbackText = String(fallback ?? "").trim().toLowerCase();
  const safeFallback = TOKEN_PATTERN.test(fallbackText) ? fallbackText : "unspecified";
  const text = String(value ?? "").trim().toLowerCase();
  return TOKEN_PATTERN.test(text) ? text : safeFallback;
}

function normalizeVersion(value) {
  const text = String(value ?? "").trim();
  return /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(text) ? text : "unknown";
}

function normalizeTimestamp(value) {
  const date = value instanceof Date ? value : new Date(value ?? Date.now());
  return beijingTimestamp(Number.isNaN(date.getTime()) ? Date.now() : date);
}

function normalizeBounds(bounds) {
  if (!bounds || ![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite)) return undefined;
  return {
    x: Math.round(bounds.x),
    y: Math.round(bounds.y),
    width: Math.max(0, Math.round(bounds.width)),
    height: Math.max(0, Math.round(bounds.height))
  };
}

function byteLength(lines) {
  return Buffer.byteLength(`${lines.join("\n")}\n`, "utf8");
}
