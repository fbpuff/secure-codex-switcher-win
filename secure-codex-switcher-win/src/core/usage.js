const usageEndpoints = [
  "https://chatgpt.com/backend-api/wham/usage",
  "https://chatgpt.com/api/codex/usage"
];

export async function fetchUsageSnapshot({ accessToken, accountId, fetchImpl = fetch, now = unixNow }) {
  if (!accessToken) {
    throw new Error("Missing access token.");
  }

  const failures = [];
  for (const url of usageEndpoints) {
    try {
      const response = await fetchImpl(url, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "ChatGPT-Account-Id": accountId,
          Accept: "application/json",
          Origin: "https://chatgpt.com",
          Referer: "https://chatgpt.com/",
          "User-Agent": "secure-codex-switcher-win/0.1"
        },
        signal: AbortSignal.timeout(18_000)
      });
      if (response.status === 401 || response.status === 403) {
        throw new Error(`usage endpoint auth failed: ${response.status}`);
      }
      if (!response.ok) {
        failures.push({ url, message: `HTTP ${response.status}` });
        continue;
      }
      const contentType = response.headers.get("content-type") ?? "";
      if (contentType.includes("text/html")) {
        failures.push({ url, message: "HTML response" });
        continue;
      }
      return mapUsagePayload(await response.json(), now());
    } catch (error) {
      failures.push(endpointFailure(url, error));
    }
  }
  throw new Error(summarizeFailures(failures));
}

export function mapUsagePayload(payload, fetchedAt = unixNow()) {
  if (!payload || typeof payload !== "object") {
    throw new Error("usage response must be an object");
  }

  const windows = [];
  collectRateLimitWindows(payload.rate_limit, windows);
  if (Array.isArray(payload.additional_rate_limits)) {
    for (const item of payload.additional_rate_limits) {
      collectRateLimitWindows(item?.rate_limit, windows);
    }
  }

  const fiveHour = pickNearestWindow(windows, 5 * 60 * 60);
  const oneWeek = pickNearestWindow(windows, 7 * 24 * 60 * 60);

  return {
    fetchedAt,
    planType: optionalString(payload.plan_type),
    fiveHour: fiveHour ? toUsageWindow(fiveHour) : undefined,
    oneWeek: oneWeek ? toUsageWindow(oneWeek) : undefined,
    credits: parseCredits(payload.credits)
  };
}

function collectRateLimitWindows(rateLimit, windows) {
  if (!rateLimit || typeof rateLimit !== "object") {
    return;
  }
  const primary = parseUsageWindowRaw(rateLimit.primary_window);
  const secondary = parseUsageWindowRaw(rateLimit.secondary_window);
  if (primary) {
    windows.push(primary);
  }
  if (secondary) {
    windows.push(secondary);
  }
}

function parseUsageWindowRaw(value) {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const usedPercent = readNumber(value.used_percent);
  const limitWindowSeconds = readInteger(value.limit_window_seconds);
  const resetAt = readInteger(value.reset_at);
  if (usedPercent === undefined || limitWindowSeconds === undefined || resetAt === undefined) {
    return undefined;
  }
  return { usedPercent, limitWindowSeconds, resetAt };
}

function pickNearestWindow(windows, targetSeconds) {
  const nearest = [...windows].sort((left, right) => {
    const leftDistance = Math.abs(left.limitWindowSeconds - targetSeconds);
    const rightDistance = Math.abs(right.limitWindowSeconds - targetSeconds);
    return leftDistance - rightDistance;
  })[0];
  if (!nearest || Math.abs(nearest.limitWindowSeconds - targetSeconds) > targetSeconds * 0.25) {
    return undefined;
  }
  return nearest;
}

function toUsageWindow(raw) {
  return {
    usedPercent: raw.usedPercent,
    remainingPercent: Math.max(0, 100 - raw.usedPercent),
    windowSeconds: raw.limitWindowSeconds,
    resetAt: raw.resetAt
  };
}

function parseCredits(value) {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  return {
    hasCredits: Boolean(value.has_credits),
    unlimited: Boolean(value.unlimited),
    balance: optionalString(value.balance)
  };
}

function readNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readInteger(value) {
  return Number.isInteger(value) ? value : undefined;
}

function optionalString(value) {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function endpointFailure(url, error) {
  const message = error instanceof Error ? error.message : String(error);
  const cause = error instanceof Error ? error.cause : undefined;
  const code = cause && typeof cause === "object" && "code" in cause ? cause.code : undefined;
  return { url, message, code: typeof code === "string" ? code : undefined };
}

function summarizeFailures(failures) {
  if (failures.some((failure) => failure.code === "UND_ERR_CONNECT_TIMEOUT" || /timeout/i.test(failure.message))) {
    return "无法连接 chatgpt.com 用量接口。通常是当前代理/VPN 未启用，或代理端口不可用；请确认代理正在运行后重试。";
  }
  if (failures.some((failure) => /401/i.test(failure.message))) {
    return "当前保存的账号登录态被用量接口拒绝（401）。请切换到该账号并重新打开官方 Codex，待登录态自动刷新后再试；若仍失败，再重新登录并导入。";
  }
  if (failures.some((failure) => /403/i.test(failure.message))) {
    return "当前账号可以用于切换，但非公开用量接口拒绝访问（403），因此暂时无法显示余量。";
  }
  const preview = failures
    .slice(0, 2)
    .map((failure) => `${new URL(failure.url).pathname} -> ${failure.message}`)
    .join(" | ");
  return `用量接口请求失败：${preview}`;
}

function unixNow() {
  return Math.floor(Date.now() / 1000);
}
