import assert from "node:assert/strict";
import test from "node:test";
import { protectString, unprotectString, unprotectStringAsync } from "../src/core/dpapi.js";

test("round trips a secret through Windows DPAPI", { skip: process.platform !== "win32" }, () => {
  const sample = `sample-${Date.now()}`;
  const encrypted = protectString(sample);
  assert.notEqual(encrypted, sample);
  assert.equal(unprotectString(encrypted), sample);
});

test("round trips CJK outside legacy console code pages and non-BMP text through Windows DPAPI", { skip: process.platform !== "win32" }, () => {
  const sample = `CJK-${String.fromCodePoint(0x9fff)}-nonbmp-${String.fromCodePoint(0x20000)}-${String.fromCodePoint(0x1f600)}`;
  const encrypted = protectString(sample);
  const recovered = unprotectString(encrypted);

  assert.equal(recovered, sample);
  assert.equal(recovered.includes(String.fromCharCode(0xfffd)), false);
});

test("asynchronously unprotects the existing DPAPI ciphertext format", { skip: process.platform !== "win32" }, async () => {
  const sample = `async-${String.fromCodePoint(0x9fff)}-${String.fromCodePoint(0x1f600)}-${Date.now()}`;
  const encrypted = protectString(sample);

  assert.equal(await unprotectStringAsync(encrypted), sample);
});

test("asynchronous DPAPI rejects an unreadable ciphertext without exposing its input", { skip: process.platform !== "win32" }, async () => {
  const invalidCiphertext = "synthetic-invalid-ciphertext";

  await assert.rejects(
    unprotectStringAsync(invalidCiphertext),
    (error) => error instanceof Error && !error.message.includes(invalidCiphertext)
  );
});
