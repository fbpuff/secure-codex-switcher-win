export function isUsageAuthExpiredError(error) {
  const text = error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error ?? "");
  return /401|usage_auth_expired|用量认证已过期|usage authentication expired/i.test(text);
}

export function classifyRefreshResults(results) {
  const failures = Array.isArray(results) ? results.filter((result) => !result.ok) : [];
  const authExpiredFailures = failures.filter((result) => isUsageAuthExpiredError(result.error));
  return {
    failures: failures.length,
    authExpiredFailures: authExpiredFailures.length,
    otherFailures: failures.length - authExpiredFailures.length
  };
}
