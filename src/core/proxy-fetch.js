import { fetch as undiciFetch, ProxyAgent } from "undici";
import { execFileSync } from "node:child_process";

export function createProxyAwareFetch(baseFetch = fetch, proxyUrl = resolveProxyUrl()) {
  if (!proxyUrl) {
    return baseFetch;
  }
  const dispatcher = new ProxyAgent(normalizeProxyUrl(proxyUrl));
  return (url, init = {}) => undiciFetch(url, { ...init, dispatcher });
}

export function resolveProxyUrl(env = process.env, options = {}) {
  const explicit = env.HTTPS_PROXY || env.HTTP_PROXY || env.ALL_PROXY || env.https_proxy || env.http_proxy || env.all_proxy;
  if (explicit) return explicit;
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") return "";
  const readWindowsProxy = options.readWindowsProxy ?? readWindowsUserProxy;
  return readWindowsProxy();
}

function readWindowsUserProxy() {
  const key = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings";
  try {
    const enabled = execFileSync("reg.exe", ["query", key, "/v", "ProxyEnable"], { encoding: "utf8", windowsHide: true, timeout: 2_000 });
    if (!/REG_DWORD\s+0x1\b/i.test(enabled)) return "";
    const output = execFileSync("reg.exe", ["query", key, "/v", "ProxyServer"], { encoding: "utf8", windowsHide: true, timeout: 2_000 });
    const match = output.match(/ProxyServer\s+REG_SZ\s+(.+)$/im);
    return pickWindowsProxy(match?.[1]?.trim() ?? "");
  } catch {
    return "";
  }
}

function pickWindowsProxy(value) {
  if (!value.includes("=")) return value;
  const entries = new Map(value.split(";").map((item) => item.split("=", 2).map((part) => part.trim())).filter((item) => item.length === 2));
  return entries.get("https") || entries.get("http") || entries.values().next().value || "";
}

function normalizeProxyUrl(value) {
  if (/^https?:\/\//i.test(value)) {
    return value;
  }
  return `http://${value}`;
}
