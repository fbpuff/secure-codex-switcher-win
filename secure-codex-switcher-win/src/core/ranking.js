export function remainingScore(account) {
  const oneWeekUsed = account.usage?.oneWeek?.usedPercent ?? 100;
  const fiveHourUsed = account.usage?.fiveHour?.usedPercent ?? 100;
  const oneWeekRemaining = Math.max(0, 100 - oneWeekUsed);
  const fiveHourRemaining = Math.max(0, 100 - fiveHourUsed);
  return oneWeekRemaining * 0.7 + fiveHourRemaining * 0.3;
}

export function pickBestAccount(accounts, now = Math.floor(Date.now() / 1000)) {
  return [...accounts]
    .filter((account) => account.status === "ready")
    .filter((account) => account.usage?.fetchedAt && now - account.usage.fetchedAt <= 10 * 60)
    .filter((account) => !isQuotaExhausted(account))
    .sort((left, right) => {
      const scoreDiff = remainingScore(right) - remainingScore(left);
      if (scoreDiff !== 0) {
        return scoreDiff;
      }
      return left.createdAt - right.createdAt;
    })[0];
}

export function shouldAutoSwitch(currentAccount) {
  return Boolean(currentAccount) && isQuotaExhausted(currentAccount);
}

export function isQuotaExhausted(account) {
  return isWindowExhausted(account?.usage?.fiveHour) || isWindowExhausted(account?.usage?.oneWeek);
}

function isWindowExhausted(window) {
  return Boolean(window) && Number(window.usedPercent) >= 100;
}
