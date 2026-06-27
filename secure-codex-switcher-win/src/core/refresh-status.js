export function isLoginRefreshError(error) {
  const text = error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error ?? "");
  return /401|needs_login|登录态被用量接口拒绝|login state needs refresh/i.test(text);
}

export function classifyRefreshResults(results) {
  const failures = Array.isArray(results) ? results.filter((result) => !result.ok) : [];
  const loginFailures = failures.filter((result) => isLoginRefreshError(result.error));
  return {
    failures: failures.length,
    loginFailures: loginFailures.length,
    otherFailures: failures.length - loginFailures.length
  };
}
