import assert from "node:assert/strict";
import test from "node:test";
import { formatMainProcessError, isRecoverableMainProcessError } from "../src/core/main-errors.js";

test("treats closed TLS socket errors as recoverable", () => {
  const error = new Error("SocketError: other side closed");
  error.stack = [
    "SocketError: other side closed",
    "    at TLSSocket.onHttp2SocketEnd (node_modules/undici/lib/dispatcher/client-h2.js:22)",
    "    at TLSSocket.emit (node:events:521:24)"
  ].join("\n");

  assert.equal(isRecoverableMainProcessError(error), true);
});

test("does not classify ordinary programming errors as network socket failures", () => {
  assert.equal(isRecoverableMainProcessError(new TypeError("Cannot read properties of undefined")), false);
});

test("redacts user profile paths and credentials from main-process errors", () => {
  const error = new Error("failed at C:\\Users\\private-user\\AppData\\Roaming\\state.json with Bearer secret-token");
  error.stack = `${error.message}\nfile:///C:/Users/private-user/AppData/Local/app.asar/main.js\naccess_token=secret-access`;

  const formatted = formatMainProcessError(error);

  assert.doesNotMatch(formatted, /private-user|secret-token|secret-access/);
  assert.match(formatted, /%USERPROFILE%|\[redacted\]/);
});
