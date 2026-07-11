import crypto from "node:crypto";

export function summarizeAuth(authJson) {
  const tokenSource = authTokenSource(authJson);
  const idToken = pickString(tokenSource, ["id_token", "idToken"]);
  const accessToken = pickString(tokenSource, ["access_token", "accessToken"]);
  const refreshToken = pickString(tokenSource, ["refresh_token", "refreshToken"]);
  const decoded = decodeJwtPayload(idToken) ?? decodeJwtPayload(accessToken) ?? {};
  const email = pickString(decoded, ["email", "https://api.openai.com/profile/email"]) ?? "unknown";
  const accountId =
    pickString(tokenSource, ["account_id", "accountId", "chatgpt_account_id", "chatgptAccountId"]) ??
    pickString(decoded, ["https://api.openai.com/profile/account_id", "account_id", "sub"]) ??
    stableAccountId(authJson);
  const planType = pickString(tokenSource, ["plan_type", "planType"]) ?? pickString(decoded, ["plan_type"]) ?? "unknown";

  return {
    accountId,
    email,
    emailMasked: maskEmail(email),
    planType,
    hasAccessToken: Boolean(accessToken),
    hasRefreshToken: Boolean(refreshToken)
  };
}

export function extractAccessToken(authJson) {
  return pickString(authTokenSource(authJson), ["access_token", "accessToken"]);
}

export function extractAccountId(authJson, fallbackId) {
  const summary = summarizeAuth(authJson);
  return summary.accountId || fallbackId;
}

function stableAccountId(value) {
  return `acct_${crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16)}`;
}

function authTokenSource(authJson) {
  const nestedTokens = authJson?.tokens;
  if (nestedTokens && typeof nestedTokens === "object" && !Array.isArray(nestedTokens)) {
    return nestedTokens;
  }
  return authJson;
}

function pickString(source, names) {
  if (!source || typeof source !== "object") {
    return undefined;
  }
  for (const name of names) {
    const value = source[name];
    if (typeof value === "string" && value.trim() !== "") {
      return value.trim();
    }
  }
  return undefined;
}

function decodeJwtPayload(token) {
  if (!token || typeof token !== "string") {
    return undefined;
  }
  const parts = token.split(".");
  if (parts.length < 2) {
    return undefined;
  }
  try {
    const normalized = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    return JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
  } catch {
    return undefined;
  }
}

function maskEmail(email) {
  const [name, domain] = String(email).split("@");
  if (!name || !domain) {
    return "unknown";
  }
  const visible = name.length <= 2 ? `${name[0] ?? "*"}*` : `${name.slice(0, 2)}***`;
  return `${visible}@${domain}`;
}
