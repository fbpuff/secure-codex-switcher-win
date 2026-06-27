import assert from "node:assert/strict";
import test from "node:test";
import { classifyRefreshResults, isLoginRefreshError } from "../src/core/refresh-status.js";

test("classifies usage 401 errors as login refresh errors", () => {
  assert.equal(isLoginRefreshError("当前保存的账号登录态被用量接口拒绝（401）。"), true);
  assert.equal(isLoginRefreshError(new Error("Error invoking remote method 'accounts:refreshUsage': Error: usage endpoint auth failed: 401")), true);
});

test("classifies refresh results by login and other failures", () => {
  assert.deepEqual(
    classifyRefreshResults([
      { id: "ok", ok: true },
      { id: "login", ok: false, error: "登录态被用量接口拒绝（401）" },
      { id: "network", ok: false, error: "HTTP 500" }
    ]),
    { failures: 2, loginFailures: 1, otherFailures: 1 }
  );
});

test("handles missing refresh result lists", () => {
  assert.deepEqual(classifyRefreshResults(undefined), { failures: 0, loginFailures: 0, otherFailures: 0 });
});
