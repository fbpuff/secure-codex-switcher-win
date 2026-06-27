import assert from "node:assert/strict";
import test from "node:test";
import { isRecoverableMainProcessError } from "../src/core/main-errors.js";

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
