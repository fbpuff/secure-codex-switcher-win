export const DEFAULT_AUTO_SWITCH_QUIET_MS = 90_000;

export function autoSwitchQuietSecondsRemaining(pendingState, nowMs = Date.now()) {
  const quietUntilMs = validTimestamp(pendingState?.quietUntilMs);
  return quietUntilMs ? Math.max(0, Math.ceil((quietUntilMs - nowMs) / 1000)) : 0;
}

function validTimestamp(value) {
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

export function decideAutoSwitchActivity(activityStatus, pendingState = {}, options = {}) {
  const nowMs = options.nowMs ?? Date.now();
  const quietMs = options.quietMs ?? DEFAULT_AUTO_SWITCH_QUIET_MS;
  const previousLastBusyAt = validTimestamp(pendingState?.lastBusyAt);
  const activityKey = normalizeActivityKey(activityStatus);

  if (activityStatus?.isBusy) {
    const sameBusyActivity = pendingState?.activityBusy === true && pendingState?.activityKey === activityKey;
    return {
      shouldQueue: true,
      activityStatus,
      activityKey,
      activityBusy: true,
      lastBusyAt: sameBusyActivity ? previousLastBusyAt ?? nowMs : nowMs,
      quietStartedAtMs: undefined,
      quietActivityKey: undefined,
      quietUntilMs: undefined
    };
  }

  const lastActivityAt = validTimestamp(activityStatus?.lastActivityAt);
  const previousQuietUntil = validTimestamp(pendingState?.quietUntilMs);
  if (pendingState?.activityBusy === false && previousQuietUntil) {
    if (nowMs < previousQuietUntil) {
      return {
        shouldQueue: true,
        activityStatus,
        activityKey,
        activityBusy: false,
        lastBusyAt: previousLastBusyAt,
        quietStartedAtMs: validTimestamp(pendingState?.quietStartedAtMs),
        quietActivityKey: pendingState.quietActivityKey ?? activityKey,
        quietUntilMs: previousQuietUntil
      };
    }
    return {
      shouldQueue: false,
      activityStatus,
      activityKey,
      activityBusy: false,
      lastBusyAt: previousLastBusyAt,
      quietStartedAtMs: validTimestamp(pendingState?.quietStartedAtMs),
      quietActivityKey: pendingState.quietActivityKey ?? activityKey,
      quietUntilMs: previousQuietUntil
    };
  }

  const quietSince = pendingState?.activityBusy === true
    ? nowMs
    : Math.min(lastActivityAt ?? previousLastBusyAt ?? 0, nowMs);
  if (quietSince > 0) {
    const quietUntilMs = quietSince + quietMs;
    if (nowMs >= quietUntilMs) {
      return {
        shouldQueue: false,
        activityStatus,
        activityKey,
        activityBusy: false,
        lastBusyAt: previousLastBusyAt,
        quietStartedAtMs: quietSince,
        quietActivityKey: activityKey,
        quietUntilMs
      };
    }
    return {
      shouldQueue: true,
      activityStatus,
      activityKey,
      activityBusy: false,
      lastBusyAt: previousLastBusyAt,
      quietStartedAtMs: quietSince,
      quietActivityKey: activityKey,
      quietUntilMs
    };
  }

  return {
    shouldQueue: false,
    activityStatus,
    activityKey,
    activityBusy: false,
    lastBusyAt: previousLastBusyAt,
    quietStartedAtMs: undefined,
    quietActivityKey: undefined,
    quietUntilMs: undefined
  };
}

function normalizeActivityKey(activityStatus) {
  const explicit = typeof activityStatus?.activityKey === "string" ? activityStatus.activityKey.trim() : "";
  if (explicit) {
    return explicit;
  }
  const threadIds = Array.isArray(activityStatus?.activeThreadIds)
    ? [...new Set(activityStatus.activeThreadIds.filter((id) => typeof id === "string" && id))].sort()
    : [];
  if (threadIds.length > 0) {
    return `threads:${threadIds.join(",")}`;
  }
  const snapshot = activityStatus?.activitySnapshot;
  if (snapshot && Number.isFinite(snapshot.size) && Number.isFinite(snapshot.mtimeMs)) {
    return `snapshot:${snapshot.size}:${snapshot.mtimeMs}`;
  }
  return activityStatus?.isBusy ? `busy:${activityStatus?.reason ?? "unknown"}` : "idle";
}
