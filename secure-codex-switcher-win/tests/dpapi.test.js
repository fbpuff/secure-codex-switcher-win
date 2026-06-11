import assert from "node:assert/strict";
import test from "node:test";
import { protectString, unprotectString } from "../src/core/dpapi.js";

test("round trips a secret through Windows DPAPI", { skip: process.platform !== "win32" }, () => {
  const sample = `sample-${Date.now()}`;
  const encrypted = protectString(sample);
  assert.notEqual(encrypted, sample);
  assert.equal(unprotectString(encrypted), sample);
});
