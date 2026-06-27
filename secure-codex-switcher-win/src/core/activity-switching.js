export const DEFAULT_AUTO_SWITCH_QUIET_MS = 90_000;

function validTimestamp(value) {
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

export function decideAutoSwitchActivity(activityStatus, pendingState = {}, options = {}) {
  const nowMs = options.nowMs ?? Date.now();
  const quietMs = options.quietMs ?? DEFAULT_AUTO_SWITCH_QUIET_MS;
  const previousLastBusyAt = validTimestamp(pendingState?.lastBusyAt);

  if (activityStatus?.isBusy) {
    return {
      shouldQueue: true,
      activityStatus,
      lastBusyAt: nowMs,
      quietUntilMs: nowMs + quietMs
    };
  }

  const lastActivityAt = validTimestamp(activityStatus?.lastActivityAt);
  const quietSince = Math.max(previousLastBusyAt ?? 0, lastActivityAt ?? 0);
  if (quietSince > 0 && nowMs - quietSince < quietMs) {
    return {
      shouldQueue: true,
      activityStatus,
      lastBusyAt: previousLastBusyAt,
      quietUntilMs: quietSince + quietMs
    };
  }

  return {
    shouldQueue: false,
    activityStatus,
    lastBusyAt: previousLastBusyAt,
    quietUntilMs: undefined
  };
}
