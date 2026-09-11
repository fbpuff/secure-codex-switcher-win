import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { classifyRefreshResults, isUsageAuthExpiredError } from "../src/core/refresh-status.js";

test("classifies usage 401 errors as expired usage authentication", () => {
  assert.equal(isUsageAuthExpiredError("当前保存的用量认证已过期（401）。"), true);
  assert.equal(isUsageAuthExpiredError(new Error("Error invoking remote method 'accounts:refreshUsage': Error: usage endpoint auth failed: 401")), true);
});

test("classifies refresh results by login and other failures", () => {
  assert.deepEqual(
    classifyRefreshResults([
      { id: "ok", ok: true },
      { id: "expired", ok: false, error: "用量认证已过期（401）" },
      { id: "network", ok: false, error: "HTTP 500" }
    ]),
    { failures: 2, authExpiredFailures: 1, otherFailures: 1 }
  );
});

test("handles missing refresh result lists", () => {
  assert.deepEqual(classifyRefreshResults(undefined), { failures: 0, authExpiredFailures: 0, otherFailures: 0 });
});

test("renders expired usage authentication as switchable instead of requiring login", () => {
  const renderer = fs.readFileSync(new URL("../src/renderer/app.js", import.meta.url), "utf8");
  assert.match(renderer, /"statusLabel\.usage_auth_expired": "用量认证待刷新"/);
  assert.match(renderer, /"status\.accountUsageAuthExpired": "\{email\} 的用量认证已过期，但账号仍可切换/);
  assert.doesNotMatch(renderer, /"statusLabel\.needs_login"/);
});
