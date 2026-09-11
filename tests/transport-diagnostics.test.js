import assert from "node:assert/strict";
import test from "node:test";
import { diagnoseTransport } from "../src/core/transport-diagnostics.js";

const HTTP_ONLY_CONFIG = [
  'model_provider = "secure_codex_switcher_http"',
  "",
  "[model_providers.secure_codex_switcher_http]",
  'wire_api = "responses"',
  "supports_websockets = false",
  "stream_max_retries = 5",
  "stream_idle_timeout_ms = 300000",
  ""
].join("\n");

test("identifies HTTP-only Responses/SSE and bounded retry details", () => {
  const result = diagnoseTransport({
    configText: HTTP_ONLY_CONFIG,
    switcherHttpOnly: { httpOnlyModeEnabled: true },
    environmentProxy: { HTTP_PROXY: "http://127.0.0.1:7897" },
    windowsProxy: { present: true, endpointClass: "local" },
    recentError: "正在重新连接 1/5: error decoding response body"
  });

  assert.deepEqual(result, {
    wireMode: "responses_sse",
    supportsWebsockets: false,
    streamMaxRetries: 5,
    streamIdleTimeoutMs: 300000,
    proxySource: "both",
    errorCategory: "response_decode",
    retryOrdinal: 1
  });
});

test("identifies a Responses provider that is WebSocket capable", () => {
  const result = diagnoseTransport({
    configText: [
      'model_provider = "openai"',
      "",
      "[model_providers.openai]",
      'wire_api = "responses"',
      "supports_websockets = true",
      "stream_max_retries = 4"
    ].join("\n"),
    environmentProxyPresent: false,
    windowsProxyPresent: false
  });

  assert.deepEqual(result, {
    wireMode: "websocket_capable",
    supportsWebsockets: true,
    streamMaxRetries: 4,
    streamIdleTimeoutMs: "unknown",
    proxySource: "none",
    errorCategory: "unknown",
    retryOrdinal: "unknown"
  });
});

test("reports both proxy sources when only presence is available", () => {
  assert.equal(
    diagnoseTransport({ environmentProxyPresent: true, windowsProxyPresent: true }).proxySource,
    "both"
  );
});

test("marks environment and Windows proxy endpoint classes as mismatched", () => {
  const result = diagnoseTransport({
    configText: HTTP_ONLY_CONFIG,
    environmentProxy: { HTTPS_PROXY: "http://user:secret@127.0.0.1:7897" },
    windowsProxy: { present: true, endpointClass: "remote" },
    recentError: "stream disconnected before completion; reconnecting 2/5"
  });

  assert.equal(result.proxySource, "mismatch");
  assert.equal(result.errorCategory, "stream_reset");
  assert.equal(result.retryOrdinal, 2);
  assert.equal(result.wireMode, "responses_sse");
  assert.doesNotMatch(JSON.stringify(result), /secret|127\.0\.0\.1|7897|stream disconnected/i);
});

test("returns unknown for incomplete input without guessing transport state", () => {
  const result = diagnoseTransport();

  assert.deepEqual(result, {
    wireMode: "unknown",
    supportsWebsockets: "unknown",
    streamMaxRetries: "unknown",
    streamIdleTimeoutMs: "unknown",
    proxySource: "unknown",
    errorCategory: "unknown",
    retryOrdinal: "unknown"
  });
});

test("classifies bounded transport errors without retaining raw messages", () => {
  const cases = [
    ["ECONNREFUSED while connecting", "connection_refused"],
    ["request timed out after 30000ms", "timeout"],
    ["certificate verify failed: https://private.invalid", "tls_failure"]
  ];

  for (const [recentError, errorCategory] of cases) {
    const result = diagnoseTransport({ recentError });
    assert.equal(result.errorCategory, errorCategory);
    assert.doesNotMatch(JSON.stringify(result), /private\.invalid|30000|ECONNREFUSED/i);
  }
});
