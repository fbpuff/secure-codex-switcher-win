import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { atomicWriteJson, readJsonIfExists } from "../src/core/file-io.js";

const fixtureRoots = new Set();
after(() => {
  for (const root of fixtureRoots) fs.rmSync(root, { recursive: true, force: true });
});

function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "secure-codex-switcher-file-io-"));
  fixtureRoots.add(root);
  return root;
}

test("recovers a zeroed JSON primary from its last valid backup", () => {
  const root = makeFixture();
  const filePath = path.join(root, "state.json");
  atomicWriteJson(filePath, { version: 1 });
  atomicWriteJson(filePath, { version: 2 });
  fs.writeFileSync(filePath, Buffer.alloc(fs.statSync(filePath).size));

  assert.deepEqual(readJsonIfExists(filePath), { version: 1 });
  assert.deepEqual(JSON.parse(fs.readFileSync(filePath, "utf8")), { version: 1 });
  const corruptFiles = fs.readdirSync(root).filter((name) => name.startsWith("state.json.corrupt-"));
  assert.equal(corruptFiles.length, 1);
  assert.equal(fs.readFileSync(path.join(root, corruptFiles[0])).every((byte) => byte === 0), true);
});

test("does not replace a valid JSON backup with a corrupt primary", () => {
  const root = makeFixture();
  const filePath = path.join(root, "state.json");
  atomicWriteJson(filePath, { version: 1 });
  atomicWriteJson(filePath, { version: 2 });
  fs.writeFileSync(filePath, Buffer.alloc(fs.statSync(filePath).size));

  atomicWriteJson(filePath, { version: 3 });

  assert.deepEqual(JSON.parse(fs.readFileSync(filePath, "utf8")), { version: 3 });
  assert.deepEqual(JSON.parse(fs.readFileSync(`${filePath}.bak`, "utf8")), { version: 1 });
});
