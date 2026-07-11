export function scoreBreakdown(account, now = Math.floor(Date.now() / 1000)) {
  const values = {
    fiveHourRemaining: remainingPercent(account?.usage?.fiveHour),
    oneWeekRemaining: remainingPercent(account?.usage?.oneWeek),
    fiveHourResetAt: futureResetAt(account?.usage?.fiveHour, now),
    oneWeekResetAt: futureResetAt(account?.usage?.oneWeek, now)
  };
  const remaining = [values.fiveHourRemaining, values.oneWeekRemaining].filter(Number.isFinite);
  const balanceTotal = remaining.length === 2
    ? Math.min(...remaining) * 0.60 + values.fiveHourRemaining * 0.20 + values.oneWeekRemaining * 0.20
    : remaining[0] ?? 0;
  const total = remaining.includes(0) ? 0 : balanceTotal;
  return { ...values, minimumRemaining: remaining.length ? Math.min(...remaining) : undefined, balanceTotal, total };
}

export function remainingScore(account, now = Math.floor(Date.now() / 1000)) {
  return scoreBreakdown(account, now).total;
}

export function quotaBalanceScore(account, now = Math.floor(Date.now() / 1000)) {
  return scoreBreakdown(account, now).balanceTotal;
}

export function compareAccountsByScore(left, right, now = Math.floor(Date.now() / 1000)) {
  const leftBlocked = isQuotaExhausted(left);
  const rightBlocked = isQuotaExhausted(right);
  if (leftBlocked !== rightBlocked) return leftBlocked ? 1 : -1;
  if (leftBlocked && rightBlocked) {
    const recoveryDifference = comparable(exhaustedResetAt(left, now), Number.MAX_SAFE_INTEGER)
      - comparable(exhaustedResetAt(right, now), Number.MAX_SAFE_INTEGER);
    if (recoveryDifference !== 0) return recoveryDifference;
  }
  const leftScore = scoreBreakdown(left, now);
  const rightScore = scoreBreakdown(right, now);
  const totalDifference = rightScore.total - leftScore.total;
  if (totalDifference !== 0) return totalDifference;
  const limitingResetDifference = limitingResetAt(leftScore) - limitingResetAt(rightScore);
  if (limitingResetDifference !== 0) return limitingResetDifference;
  const oneWeekDifference = comparable(rightScore.oneWeekRemaining) - comparable(leftScore.oneWeekRemaining);
  if (oneWeekDifference !== 0) {
    return oneWeekDifference;
  }
  const fiveHourDifference = comparable(rightScore.fiveHourRemaining) - comparable(leftScore.fiveHourRemaining);
  if (fiveHourDifference !== 0) {
    return fiveHourDifference;
  }
  const resetDifference = nearestResetAt(left) - nearestResetAt(right);
  if (resetDifference !== 0) {
    return resetDifference;
  }
  return comparable(left.createdAt, Number.MAX_SAFE_INTEGER) - comparable(right.createdAt, Number.MAX_SAFE_INTEGER);
}

export function pickBestAccount(accounts, now = Math.floor(Date.now() / 1000)) {
  return [...accounts]
    .filter((account) => account.status === "ready")
    .filter((account) => account.usage?.fetchedAt && now - account.usage.fetchedAt <= 10 * 60)
    .filter((account) => !isQuotaExhausted(account))
    .filter((account) => !hasPassedReset(account, now))
    .sort((left, right) => compareAccountsByScore(left, right, now))[0];
}

export function pickRecoveryAccount(accounts, now = Math.floor(Date.now() / 1000)) {
  return [...accounts]
    .filter((account) => account.status === "ready")
    .filter((account) => account.usage?.fetchedAt && now - account.usage.fetchedAt <= 10 * 60)
    .filter((account) => isQuotaExhausted(account))
    .map((account) => ({ account, resetAt: exhaustedResetAt(account, now) }))
    .filter((item) => Number.isFinite(item.resetAt))
    .sort((left, right) => left.resetAt - right.resetAt || compareAccountsByScore(left.account, right.account, now))[0]?.account;
}

export function isQuotaExhausted(account) {
  return isWindowExhausted(account?.usage?.fiveHour) || isWindowExhausted(account?.usage?.oneWeek);
}

function isWindowExhausted(window) {
  return Boolean(window) && Number(window.usedPercent) >= 100;
}

function remainingPercent(window) {
  const usedPercent = Number(window?.usedPercent);
  return Number.isFinite(usedPercent) ? clamp(100 - usedPercent) : undefined;
}

function futureResetAt(window, now) {
  const resetAt = Number(window?.resetAt);
  return Number.isFinite(resetAt) && resetAt > now ? resetAt : undefined;
}

function limitingResetAt(score) {
  if (score.fiveHourRemaining === undefined) return comparable(score.oneWeekResetAt, Number.MAX_SAFE_INTEGER);
  if (score.oneWeekRemaining === undefined) return comparable(score.fiveHourResetAt, Number.MAX_SAFE_INTEGER);
  if (score.fiveHourRemaining < score.oneWeekRemaining) return comparable(score.fiveHourResetAt, Number.MAX_SAFE_INTEGER);
  if (score.oneWeekRemaining < score.fiveHourRemaining) return comparable(score.oneWeekResetAt, Number.MAX_SAFE_INTEGER);
  return Math.min(
    comparable(score.fiveHourResetAt, Number.MAX_SAFE_INTEGER),
    comparable(score.oneWeekResetAt, Number.MAX_SAFE_INTEGER)
  );
}

function hasPassedReset(account, now) {
  return [account?.usage?.fiveHour, account?.usage?.oneWeek]
    .some((window) => Number.isFinite(Number(window?.resetAt)) && Number(window.resetAt) <= now);
}

function nearestResetAt(account) {
  const resetTimes = [account?.usage?.fiveHour?.resetAt, account?.usage?.oneWeek?.resetAt]
    .map(Number)
    .filter(Number.isFinite);
  return resetTimes.length > 0 ? Math.min(...resetTimes) : Number.MAX_SAFE_INTEGER;
}

export function exhaustedResetAt(account, now = Math.floor(Date.now() / 1000)) {
  const resetTimes = [account?.usage?.fiveHour, account?.usage?.oneWeek]
    .filter((window) => isWindowExhausted(window))
    .map((window) => Number(window?.resetAt))
    .filter((resetAt) => Number.isFinite(resetAt) && resetAt > now);
  return resetTimes.length ? Math.min(...resetTimes) : undefined;
}

function comparable(value, fallback = -1) {
  return Number.isFinite(Number(value)) ? Number(value) : fallback;
}

function clamp(value) {
  return Math.max(0, Math.min(100, value));
}
