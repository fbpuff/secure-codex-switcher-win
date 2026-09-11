const UNKNOWN = "unknown";
const SWITCHER_HTTP_PROVIDER = "secure_codex_switcher_http";
const MAX_CONFIG_LENGTH = 256_000;
const MAX_ERROR_LENGTH = 8_192;
const MAX_RETRY_VALUE = 1_000;
const MAX_TIMEOUT_VALUE = 86_400_000;

/**
 * Derive a bounded description from caller-supplied text and proxy snapshots.
 * This function deliberately does not read config files, the process
 * environment, or the Windows registry.  Callers provide those inputs so the
 * diagnostic remains read-only and easy to test.
 */
export function diagnoseTransport(input = {}) {
  const options = isRecord(input) ? input : {};
  const configText = pickString(options, ["configText", "codexConfigText"]);
  const switcherHttpOnly = readHttpOnlySetting(options);
  const config = parseConfig(configText);
  const provider = selectProvider(config, switcherHttpOnly);

  const wireApi = normalizedString(provider.values.wire_api);
  let supportsWebsockets = parseBoolean(provider.values.supports_websockets);
  if (supportsWebsockets === undefined && switcherHttpOnly === true && provider.id === SWITCHER_HTTP_PROVIDER) {
    supportsWebsockets = false;
  }

  const streamMaxRetries = parseNumber(provider.values.stream_max_retries, 0, MAX_RETRY_VALUE);
  const streamIdleTimeoutMs = parseNumber(provider.values.stream_idle_timeout_ms, 1, MAX_TIMEOUT_VALUE);
  const recentError = boundedErrorText(options);

  return {
    wireMode: resolveWireMode(wireApi, supportsWebsockets),
    supportsWebsockets: supportsWebsockets ?? UNKNOWN,
    streamMaxRetries,
    streamIdleTimeoutMs,
    proxySource: resolveProxySource(options),
    errorCategory: classifyTransportError(recentError),
    retryOrdinal: resolveRetryOrdinal(options, recentError)
  };
}

// Keep the call site name flexible without changing the bounded result shape.
export const getTransportDiagnostics = diagnoseTransport;
export default diagnoseTransport;

function parseConfig(text) {
  const root = Object.create(null);
  const sections = new Map();
  if (typeof text !== "string" || !text) return { root, sections };

  let sectionName = "";
  for (const rawLine of text.slice(0, MAX_CONFIG_LENGTH).split(/\r?\n/)) {
    const line = stripTomlComment(rawLine).trim();
    if (!line) continue;

    const section = line.match(/^\[([^\]]+)\]$/);
    if (section) {
      sectionName = section[1].trim();
      if (!sections.has(sectionName)) sections.set(sectionName, Object.create(null));
      continue;
    }

    const assignment = line.match(/^([A-Za-z0-9_-]+)\s*=\s*(.*?)\s*$/);
    if (!assignment) continue;
    const target = sectionName ? sections.get(sectionName) : root;
    target[assignment[1]] = parseTomlValue(assignment[2]);
  }

  return { root, sections };
}

function selectProvider(config, switcherHttpOnly) {
  const providerId = normalizedString(config.root.model_provider);
  if (providerId) {
    const values = config.sections.get(`model_providers.${providerId}`);
    if (values) return { id: providerId, values };
  }

  if (switcherHttpOnly === true) {
    const values = config.sections.get(`model_providers.${SWITCHER_HTTP_PROVIDER}`);
    if (values) return { id: SWITCHER_HTTP_PROVIDER, values };
  }

  // A small root-level fixture is useful for diagnostics of an incomplete
  // config. It is only accepted when it actually contains provider keys.
  if (["wire_api", "supports_websockets", "stream_max_retries", "stream_idle_timeout_ms"].some((key) => Object.hasOwn(config.root, key))) {
    return { id: providerId, values: config.root };
  }
  return { id: providerId, values: Object.create(null) };
}

function resolveWireMode(wireApi, supportsWebsockets) {
  if (wireApi !== "responses") return UNKNOWN;
  if (supportsWebsockets === false) return "responses_sse";
  if (supportsWebsockets === true) return "websocket_capable";
  return UNKNOWN;
}

function readHttpOnlySetting(options) {
  const direct = firstOwn(options, ["httpOnlyModeEnabled", "httpOnly"]);
  if (direct !== undefined) return readBooleanSetting(direct);
  const nested = firstOwn(options, ["switcherHttpOnly", "switcherSettings", "settings"]);
  return readBooleanSetting(nested);
}

function readBooleanSetting(value) {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (/^true$/i.test(value.trim())) return true;
    if (/^false$/i.test(value.trim())) return false;
  }
  if (!isRecord(value)) return undefined;
  for (const key of ["httpOnlyModeEnabled", "enabled", "httpOnly"]) {
    if (Object.hasOwn(value, key)) return readBooleanSetting(value[key]);
  }
  return undefined;
}

function resolveProxySource(options) {
  const envKey = firstKey(options, ["environmentProxy", "envProxy", "environment", "env", "environmentProxyPresent", "envProxyPresent"]);
  const windowsKey = firstKey(options, ["windowsProxy", "windowsProxyPresent", "windowsProxyConfigured"]);
  if (!envKey && !windowsKey) return UNKNOWN;

  const environment = envKey ? classifyProxy(options[envKey], "environment") : { state: "unknown", endpointClass: UNKNOWN };
  const windows = windowsKey ? classifyProxy(options[windowsKey], "windows") : { state: "unknown", endpointClass: UNKNOWN };

  if (environment.state === "unknown" || windows.state === "unknown") return UNKNOWN;
  if (environment.state === "absent" && windows.state === "absent") return "none";
  if (environment.state === "present" && windows.state === "absent") return "env";
  if (environment.state === "absent" && windows.state === "present") return "windows";
  // Presence-only snapshots can still establish that both routes are
  // configured. An endpoint-class mismatch is reported only when both
  // bounded classes are actually known.
  if (environment.endpointClass === UNKNOWN && windows.endpointClass === UNKNOWN) return "both";
  if (environment.endpointClass === UNKNOWN || windows.endpointClass === UNKNOWN) return UNKNOWN;
  return environment.endpointClass === windows.endpointClass ? "both" : "mismatch";
}

function classifyProxy(value, kind) {
  if (value === undefined) return { state: "unknown", endpointClass: UNKNOWN };
  if (value === null || value === false || value === "") return { state: "absent", endpointClass: UNKNOWN };
  if (value === true) return { state: "present", endpointClass: UNKNOWN };
  if (typeof value === "string") return classifyProxyString(value);
  if (!isRecord(value)) return { state: "unknown", endpointClass: UNKNOWN };

  for (const key of ["present", "enabled", "exists", "configured"]) {
    if (Object.hasOwn(value, key)) {
      const state = readBooleanSetting(value[key]);
      if (state === false) return { state: "absent", endpointClass: UNKNOWN };
      if (state === undefined) return { state: "unknown", endpointClass: UNKNOWN };
      break;
    }
  }

  const endpointClass = normalizedEndpointClass(value.endpointClass ?? value.endpoint_class);
  if (endpointClass !== undefined) return { state: "present", endpointClass };

  const endpoint = firstOwn(value, ["proxy", "url", "endpoint", "server", "proxyServer", "ProxyServer"]);
  if (endpoint !== undefined) return classifyProxy(endpoint);

  if (kind === "environment") {
    const values = Object.entries(value)
      .filter(([key]) => /^(?:https?|all)_proxy$/i.test(key))
      .map(([, proxy]) => classifyProxyString(proxy))
      .filter((item) => item.state !== "absent");
    if (values.length === 0) return { state: "absent", endpointClass: UNKNOWN };
    const classes = new Set(values.map((item) => item.endpointClass));
    return { state: "present", endpointClass: classes.size === 1 ? values[0].endpointClass : UNKNOWN };
  }

  // Registry-shaped snapshots are accepted, but only their presence and
  // endpoint class are retained.
  const enabled = firstOwn(value, ["proxyEnable", "ProxyEnable"]);
  if (enabled !== undefined) {
    const enabledValue = readBooleanSetting(enabled) ?? (Number(enabled) === 1 ? true : Number(enabled) === 0 ? false : undefined);
    if (enabledValue === false) return { state: "absent", endpointClass: UNKNOWN };
    if (enabledValue === true) return classifyProxy(firstOwn(value, ["proxyServer", "ProxyServer"]) ?? true);
  }
  return { state: "unknown", endpointClass: UNKNOWN };
}

function classifyProxyString(value) {
  if (typeof value !== "string") return { state: "unknown", endpointClass: UNKNOWN };
  const text = value.trim();
  if (!text || /^(?:0|false|none|direct|disabled|off)$/i.test(text)) return { state: "absent", endpointClass: UNKNOWN };
  const lower = text.toLowerCase();
  if (/\b(?:pac|wpad|auto(?:matic)?)[\s:=/]/i.test(lower) || lower === "pac" || lower === "wpad") {
    return { state: "present", endpointClass: "pac" };
  }

  const withoutScheme = text.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
  const withoutCredentials = withoutScheme.replace(/^[^/@\s]+@/, "");
  const hostMatch = withoutCredentials.match(/^\[([^\]]+)\]|^([^/:?#\s]+)/);
  const host = (hostMatch?.[1] ?? hostMatch?.[2] ?? "").toLowerCase();
  if (!host) return { state: "present", endpointClass: UNKNOWN };
  if (host === "localhost" || host.endsWith(".localhost") || host === "127.0.0.1" || host === "::1") {
    return { state: "present", endpointClass: "local" };
  }
  return { state: "present", endpointClass: "remote" };
}

function normalizedEndpointClass(value) {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (["local", "remote", "pac", UNKNOWN].includes(normalized)) return normalized;
  return undefined;
}

function boundedErrorText(options) {
  const value = firstOwn(options, ["recentError", "error", "recentErrorString"]);
  if (typeof value === "string") return value.slice(0, MAX_ERROR_LENGTH);
  if (isRecord(value)) {
    const code = typeof value.code === "string" ? value.code : "";
    const message = typeof value.message === "string" ? value.message : "";
    return `${code} ${message}`.trim().slice(0, MAX_ERROR_LENGTH);
  }
  return "";
}

function classifyTransportError(text) {
  const value = String(text || "").toLowerCase();
  if (!value) return UNKNOWN;
  if (/error decoding response body|(?:decode|decoding|decoded).{0,32}response|response.{0,32}(?:decode|incomplete)|unexpected end of (?:json|input)|invalid json/.test(value)) {
    return "response_decode";
  }
  if (/(?:certificate|tls|ssl|secure channel|self[- ]signed)/.test(value)) return "tls_failure";
  if (/econnrefused|(?:connection|connect).{0,24}refused/.test(value)) return "connection_refused";
  if (/(?:timeout|timed out|etimedout|und_err_connect_timeout|idle timeout)/.test(value)) return "timeout";
  if (/(?:stream reset|stream disconnected|disconnected before completion|connection reset|econnreset|premature close|socket closed|other side closed|err_stream_premature_close|err_stream_destroyed)/.test(value)) {
    return "stream_reset";
  }
  return UNKNOWN;
}

function resolveRetryOrdinal(options, errorText) {
  const explicit = normalizeOrdinal(firstOwn(options, ["retryOrdinal", "retryIndex"]));
  if (explicit !== UNKNOWN) return explicit;

  const fraction = errorText.match(/(?:^|\D)(\d{1,4})\s*\/\s*(\d{1,4})(?:\D|$)/);
  if (fraction) {
    const ordinal = normalizeOrdinal(fraction[1]);
    const total = normalizeOrdinal(fraction[2]);
    if (ordinal !== UNKNOWN && total !== UNKNOWN && ordinal <= total) return ordinal;
  }

  const labeled = errorText.match(/(?:retry|retries|reconnect(?:ing|ion)?|attempt|重试|重新连接|重连)\D{0,8}(\d{1,4})/i);
  return labeled ? normalizeOrdinal(labeled[1]) : UNKNOWN;
}

function normalizeOrdinal(value) {
  const number = toNumber(value);
  return Number.isInteger(number) && number >= 0 && number <= MAX_RETRY_VALUE ? number : UNKNOWN;
}

function parseNumber(value, minimum, maximum) {
  const number = toNumber(value);
  return Number.isInteger(number) && number >= minimum && number <= maximum ? number : UNKNOWN;
}

function toNumber(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : NaN;
  if (typeof value !== "string" || !/^\s*[+-]?\d+(?:\.\d+)?\s*$/.test(value)) return NaN;
  const number = Number(value);
  return Number.isFinite(number) ? number : NaN;
}

function parseBoolean(value) {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (/^true$/i.test(value.trim())) return true;
    if (/^false$/i.test(value.trim())) return false;
  }
  return undefined;
}

function parseTomlValue(value) {
  const text = String(value).trim();
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    return text.slice(1, -1);
  }
  const bool = parseBoolean(text);
  if (bool !== undefined) return bool;
  const number = toNumber(text);
  return Number.isFinite(number) ? number : text;
}

function stripTomlComment(line) {
  let quote = "";
  let escaped = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (quote === '"' && character === "\\" && !escaped) {
      escaped = true;
      continue;
    }
    if ((character === '"' || character === "'") && !escaped) {
      quote = quote ? "" : character;
    }
    if (character === "#" && !quote) return line.slice(0, index);
    escaped = false;
  }
  return line;
}

function normalizedString(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : undefined;
}

function pickString(value, keys) {
  const result = firstOwn(value, keys);
  return typeof result === "string" ? result : "";
}

function firstKey(value, keys) {
  return keys.find((key) => Object.hasOwn(value, key));
}

function firstOwn(value, keys) {
  const key = firstKey(value, keys);
  return key ? value[key] : undefined;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
