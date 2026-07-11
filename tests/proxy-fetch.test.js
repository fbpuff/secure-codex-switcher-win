import assert from "node:assert/strict";
import test from "node:test";
import { resolveProxyUrl } from "../src/core/proxy-fetch.js";

test("explicit proxy environment takes precedence over Windows proxy", () => {
  let reads = 0;
  const value = resolveProxyUrl({ HTTPS_PROXY: "http://explicit:7890" }, { platform: "win32", readWindowsProxy: () => { reads += 1; return "http://windows:7897"; } });
  assert.equal(value, "http://explicit:7890");
  assert.equal(reads, 0);
});

test("enabled Windows proxy is used when desktop startup has no proxy environment", () => {
  assert.equal(resolveProxyUrl({}, { platform: "win32", readWindowsProxy: () => "127.0.0.1:7897" }), "127.0.0.1:7897");
});

test("disabled or unavailable Windows proxy falls back to direct fetch", () => {
  assert.equal(resolveProxyUrl({}, { platform: "win32", readWindowsProxy: () => "" }), "");
  assert.equal(resolveProxyUrl({}, { platform: "linux", readWindowsProxy: () => "127.0.0.1:7897" }), "");
});
