import fs from "node:fs";
import path from "node:path";
import { latestMatchingFiles } from "./file-io.js";

const MAX_SESSION_FILES = 8;
const SESSION_INVENTORY_REFRESH_MS = 10_000;
const sessionInventories = new WeakMap();
export const COLD_ACTIVE_RECOVERY_MS = 24 * 60 * 60 * 1_000;

export function inspectCodexTaskActivity(codexDir, cache = new Map(), options = {}) {
  const nowMs = options.nowMs ?? Date.now();
  const liveThreadIds = new Set(options.liveThreadIds ?? []);
  const candidates = sessionCandidates(codexDir, cache, nowMs);
  const coldScan = cache.size === 0;
  const latestFiles = coldScan ? candidates : candidates.slice(0, MAX_SESSION_FILES);
  const retainedPaths = new Set(candidates.slice(0, MAX_SESSION_FILES).map((file) => file.path));
  const filesByPath = new Map(latestFiles.map((file) => [file.path, file]));
  for (const [cachedPath, cachedState] of cache.entries()) {
    if (!cachedState?.active || filesByPath.has(cachedPath)) continue;
    try {
      const stat = fs.statSync(cachedPath);
      filesByPath.set(cachedPath, { path: cachedPath, mtimeMs: stat.mtimeMs, size: stat.size });
    } catch {
      cache.delete(cachedPath);
    }
  }
  const files = [...filesByPath.values()].sort((left, right) => right.mtimeMs - left.mtimeMs);
  let uncertain = false;
  let observedLifecycle = false;
  let latestSnapshot;
  let activeFiles = [];
  const activeThreadIds = new Set();

  for (const file of files) {
    latestSnapshot ??= file;
    const previous = cache.get(file.path);
    const firstObservation = !previous;
    const state = previous && previous.offset <= file.size
      ? previous
      : { offset: 0, remainder: Buffer.alloc(0), active: false, observedLifecycle: false, currentThreadId: undefined, activeThreadIds: [], latestRecordAt: undefined, lifecycleStartedAtMs: undefined, lifecycleStartedAtIsExplicit: false };
    state.activeThreadIds ??= [];
    if (file.size > state.offset) {
      const length = file.size - state.offset;
      const buffer = Buffer.alloc(length);
      const fd = fs.openSync(file.path, "r");
      try {
        fs.readSync(fd, buffer, 0, length, state.offset);
      } finally {
        fs.closeSync(fd);
      }
      const combined = Buffer.concat([state.remainder, buffer]);
      const lastNewline = combined.lastIndexOf(0x0a);
      if (lastNewline >= 0) {
        const complete = combined.subarray(0, lastNewline).toString("utf8");
        state.remainder = combined.subarray(lastNewline + 1);
        for (const line of complete.split("\n")) {
          if (!line.trim()) continue;
          try {
            const event = JSON.parse(line);
            const recordAt = Date.parse(event?.timestamp);
            if (Number.isFinite(recordAt)) {
              state.latestRecordAt = Math.max(state.latestRecordAt ?? 0, recordAt);
            }
            const type = event?.type === "event_msg" ? event?.payload?.type : undefined;
            if (event?.type === "session_meta") {
              const payload = event?.payload;
              const threadId = normalizeThreadId(payload?.id);
              state.currentThreadId = threadId;
              state.workspacePath = normalizeText(payload?.cwd, 500);
              state.startedAt = normalizeTimestamp(payload?.timestamp ?? event?.timestamp);
              state.threadSource = normalizeThreadSource(payload?.thread_source);
              state.parentThreadId = normalizeThreadId(payload?.parent_thread_id)
                ?? normalizeThreadId(payload?.source?.subagent?.thread_spawn?.parent_thread_id);
            } else if (type === "task_started") {
              state.active = true;
              state.observedLifecycle = true;
              state.lifecycleStartedAtMs = Number.isFinite(recordAt) ? recordAt : firstObservation ? file.mtimeMs : nowMs;
              state.lifecycleStartedAtIsExplicit = Number.isFinite(recordAt);
              state.activeThreadIds = state.currentThreadId ? [state.currentThreadId] : [];
            } else if (type === "task_complete" || type === "turn_aborted") {
              state.active = false;
              state.observedLifecycle = true;
              state.activeThreadIds = [];
            }
          } catch {
            uncertain = true;
          }
        }
      } else {
        state.remainder = combined;
      }
      state.offset = file.size;
      cache.set(file.path, state);
    }
    const latestEvidenceAt = state.latestRecordAt ?? file.mtimeMs;
    const hasAssociatedLiveProcess = state.activeThreadIds.some((threadId) => liveThreadIds.has(threadId));
    const lifecycleStartedAtMs = state.lifecycleStartedAtMs ?? latestEvidenceAt;
    const latestOfficialAppServerStartMs = Number(options.latestOfficialAppServerStartMs);
    const officialHostSnapshotRequestedAtMs = Number(options.officialHostSnapshotRequestedAtMs);
    const verifiedHostAbsence = options.officialHostState === "absent"
      && (!Number.isFinite(officialHostSnapshotRequestedAtMs)
        || (state.lifecycleStartedAtIsExplicit === true
          && Number.isFinite(lifecycleStartedAtMs)
          && lifecycleStartedAtMs <= officialHostSnapshotRequestedAtMs));
    const supersededByNewerHost = state.lifecycleStartedAtIsExplicit === true
      && Number.isFinite(lifecycleStartedAtMs)
      && Number.isFinite(latestOfficialAppServerStartMs)
      && lifecycleStartedAtMs < latestOfficialAppServerStartMs;
    const coldHistoricalRecord = firstObservation
      && !hasAssociatedLiveProcess
      && nowMs - lifecycleStartedAtMs > COLD_ACTIVE_RECOVERY_MS;
    if (state.active && !hasAssociatedLiveProcess && (verifiedHostAbsence || supersededByNewerHost || coldHistoricalRecord)) {
      state.active = false;
      state.activeThreadIds = [];
    }
    observedLifecycle ||= state.observedLifecycle;
    if (state.active) {
      activeFiles.push(file);
    } else if (!state.active && !retainedPaths.has(file.path)) {
      cache.delete(file.path);
    }
  }

  activeFiles = activeFiles.filter((file) => {
    const state = cache.get(file.path);
    const threadId = state?.currentThreadId;
    if (!threadId) return true;
    const evidenceAt = state.latestRecordAt ?? file.mtimeMs;
    return !files.some((other) => {
      if (other.path === file.path) return false;
      const otherState = cache.get(other.path);
      return otherState?.currentThreadId === threadId
        && (otherState.latestRecordAt ?? other.mtimeMs) > evidenceAt;
    });
  });
  for (const file of activeFiles) {
    for (const threadId of cache.get(file.path)?.activeThreadIds ?? []) activeThreadIds.add(threadId);
  }

  const sortedActiveThreadIds = [...activeThreadIds].sort();
  if (activeFiles.length > 0) {
    const hasUnknownActiveThread = activeFiles.some((file) => !(cache.get(file.path)?.activeThreadIds?.length));
    return taskStatus(codexDir, cache, "active_task_lifecycle", activeFiles, sortedActiveThreadIds, false, hasUnknownActiveThread);
  }
  if (uncertain) {
    return taskStatus(codexDir, cache, "task_lifecycle_uncertain", latestSnapshot ? [latestSnapshot] : [], [], true);
  }
  return {
    isBusy: false,
    isUncertain: false,
    reason: observedLifecycle ? "task_lifecycle_complete" : "task_lifecycle_unavailable",
    activeThreadIds: [],
    activeTasks: [],
    threadIdUnavailable: true,
    activitySnapshot: latestSnapshot,
    activityKey: latestSnapshot ? taskActivityKey([latestSnapshot], []) : undefined,
    lastActivityAt: latestSnapshot?.mtimeMs
  };
}

function taskStatus(codexDir, cache, reason, snapshots, threadIds, isUncertain, hasUnknownActiveThread = false) {
  const activeThreadIds = [...new Set(threadIds)].filter(Boolean);
  const orderedSnapshots = [...snapshots].sort((left, right) => right.mtimeMs - left.mtimeMs);
  const fallbacks = new Map();
  const activityLevels = new Map();
  for (const snapshot of orderedSnapshots) {
    const state = cache.get(snapshot.path);
    for (const id of state?.activeThreadIds ?? []) {
      if (!fallbacks.has(id)) fallbacks.set(id, workspaceFallback(state));
      const level = activityLevel(state);
      if (!activityLevels.has(id) || activityLevelRank(level) > activityLevelRank(activityLevels.get(id))) {
        activityLevels.set(id, level);
      }
    }
  }
  return {
    isBusy: true,
    isUncertain,
    reason,
    activeThreadIds,
    activeTasks: resolveTaskDisplayNames(codexDir, activeThreadIds, fallbacks, activityLevels),
    threadIdUnavailable: hasUnknownActiveThread || activeThreadIds.length === 0,
    activitySnapshot: orderedSnapshots[0],
    activitySnapshots: orderedSnapshots,
    activityKey: orderedSnapshots.length ? taskActivityKey(orderedSnapshots, activeThreadIds) : undefined,
    lastActivityAt: orderedSnapshots.reduce((latest, snapshot) => Math.max(latest, snapshot.mtimeMs), 0) || undefined
  };
}

export function resolveTaskDisplayNames(codexDir, threadIds, fallbacks = new Map(), activityLevels = new Map()) {
  const titles = readThreadTitles(path.join(codexDir, "session_index.jsonl"));
  return [...new Set(threadIds)].filter(Boolean).sort().map((id) => {
    const title = titles.get(id);
    const details = activityLevels.has(id) ? { activityLevel: activityLevels.get(id) } : {};
    if (title) return { id, displayName: title, nameSource: "thread_title", ...details };
    const fallback = fallbacks.get(id);
    if (fallback) return { id, displayName: fallback, nameSource: "workspace", ...details };
    return { id, displayName: "", nameSource: "unnamed", ...details };
  });
}

function sessionCandidates(codexDir, cache, nowMs) {
  const previous = sessionInventories.get(cache);
  if (!previous || nowMs - previous.scannedAtMs >= SESSION_INVENTORY_REFRESH_MS) {
    const candidates = latestMatchingFiles(path.join(codexDir, "sessions"), /^rollout-.*\.jsonl$/)
      .sort((left, right) => right.mtimeMs - left.mtimeMs);
    sessionInventories.set(cache, { scannedAtMs: nowMs, candidates });
    return candidates;
  }
  const refreshed = previous.candidates.map((file, index) => {
    if (index >= MAX_SESSION_FILES && !cache.get(file.path)?.active) return file;
    try {
      const stat = fs.statSync(file.path);
      return { path: file.path, mtimeMs: stat.mtimeMs, size: stat.size };
    } catch {
      return undefined;
    }
  }).filter(Boolean).sort((left, right) => right.mtimeMs - left.mtimeMs);
  sessionInventories.set(cache, { ...previous, candidates: refreshed });
  return refreshed;
}

function activityLevel(state) {
  if (state?.threadSource === "subagent" || state?.parentThreadId) return "subagent";
  if (state?.threadSource === "user") return "top_level";
  return "unknown";
}

function activityLevelRank(level) {
  return level === "subagent" ? 2 : level === "top_level" ? 1 : 0;
}

function readThreadTitles(indexPath) {
  const titles = new Map();
  if (!fs.existsSync(indexPath)) return titles;
  try {
    for (const line of fs.readFileSync(indexPath, "utf8").split("\n")) {
      if (!line.trim()) continue;
      const row = JSON.parse(line);
      const id = normalizeThreadId(row?.id);
      const title = normalizeText(row?.thread_name, 80);
      if (id && title) titles.set(id, title);
    }
  } catch {
    return new Map();
  }
  return titles;
}

function workspaceFallback(state) {
  const workspace = state?.workspacePath ? path.basename(state.workspacePath) : "";
  if (!workspace) return undefined;
  const startedAt = normalizeTimestamp(state.startedAt);
  if (!startedAt) return normalizeText(workspace, 80);
  return normalizeText(`${workspace} · ${beijingTimestamp(startedAt).slice(0, 16).replace("T", " ")} 北京时间`, 80);
}

function taskActivityKey(snapshots, threadIds) {
  const ids = [...new Set(threadIds)].sort().join(",");
  const snapshotKey = snapshots
    .map((snapshot) => `${path.basename(snapshot.path)}:${snapshot.size}:${snapshot.mtimeMs}`)
    .sort()
    .join("|");
  return `task:${ids || "unknown"}:${snapshotKey}`;
}

function normalizeThreadId(value) {
  const text = typeof value === "string" ? value.trim() : "";
  return text && text.length <= 200 ? text : undefined;
}

function normalizeThreadSource(value) {
  const text = typeof value === "string" ? value.trim().toLowerCase() : "";
  return text && text.length <= 80 ? text : undefined;
}

function normalizeText(value, maxLength) {
  const text = typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim() : "";
  return text ? text.slice(0, maxLength) : undefined;
}

function normalizeTimestamp(value) {
  if (Number.isFinite(value)) return value;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
import { beijingTimestamp } from "./beijing-time.js";
