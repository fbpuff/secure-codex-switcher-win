import { USAGE_WINDOW_SECONDS } from "../core/usage.js";

export const QUOTA_FRESHNESS_SECONDS = 10 * 60;

/**
 * Return the only quota snapshot that renderer "current" surfaces may use.
 * Retained values are deliberately omitted when the snapshot is stale, failed,
 * malformed, or belongs to a non-ready account.
 */
export function quotaDisplayState(account, nowSeconds = Date.now() / 1000) {
  const usage = account?.usage;
  const fetchedAt = finiteNumber(usage?.fetchedAt) && usage.fetchedAt > 0 ? usage.fetchedAt : undefined;
  const ageSeconds = fetchedAt === undefined || !finiteNumber(nowSeconds)
    ? undefined
    : nowSeconds - fetchedAt;
  const fresh = ageSeconds !== undefined && ageSeconds >= 0 && ageSeconds <= QUOTA_FRESHNESS_SECONDS;
  const baseCurrent = account?.status === "ready" && !account?.usageError && fresh;
  const fiveHour = normalizeDisplayWindow(usage?.fiveHour, USAGE_WINDOW_SECONDS.fiveHour);
  const oneWeek = normalizeDisplayWindow(usage?.oneWeek, USAGE_WINDOW_SECONDS.oneWeek);
  const current = Boolean(baseCurrent && (fiveHour || oneWeek));
  const executionLimited = Boolean(current && usage?.executionLimited === true);
  const exhausted = Boolean(current && [fiveHour, oneWeek].some((window) => Number(window?.usedPercent) >= 100));

  return {
    current,
    fiveHour: current ? fiveHour : undefined,
    oneWeek: current ? oneWeek : undefined,
    fetchedAt,
    ageSeconds,
    availability: !current ? "unknown" : executionLimited ? "execution_limited" : exhausted ? "exhausted" : "available",
    executionLimited,
    executionLimitWindow: usage?.executionLimitWindow,
    executionLimitSource: usage?.executionLimitSource,
    state: current ? "current" : usage ? (fresh ? "unknown" : "stale") : "unknown"
  };
}

/**
 * Format a normalized percentage without turning a fractional value below
 * 100 into the misleading text "100%".
 */
export function formatQuotaPercent(value) {
  if (!finiteNumber(value) || value < 0 || value > 100) {
    return "?";
  }
  const rounded = Math.round(value * 10) / 10;
  const safe = value < 100 && rounded >= 100 ? 99.9 : rounded;
  return `${Number.isInteger(safe) ? safe : safe.toFixed(1)}%`;
}

function normalizeDisplayWindow(window, expectedSeconds) {
  if (!window || window.windowSeconds !== expectedSeconds) {
    return undefined;
  }
  const usedPercent = normalizedPercent(window.usedPercent);
  const remainingPercent = normalizedPercent(window.remainingPercent);
  if (
    usedPercent === undefined
    || remainingPercent === undefined
    || Math.abs(usedPercent + remainingPercent - 100) > 0.001
  ) {
    return undefined;
  }
  return {
    usedPercent,
    remainingPercent,
    windowSeconds: expectedSeconds,
    resetAt: window.resetAt
  };
}

function normalizedPercent(value) {
  return finiteNumber(value) && value >= 0 && value <= 100 ? value : undefined;
}

function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}
