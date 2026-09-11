import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test, { after } from "node:test";

const verifier = fileURLToPath(new URL("../scripts/verify-version-bump.ps1", import.meta.url));
const temporaryRepositories = [];

after(() => {
  for (const root of temporaryRepositories) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function git(root, ...args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

function createRepository() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "switcher-version-policy-"));
  temporaryRepositories.push(root);
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ version: "1.0.0" }));
  fs.writeFileSync(path.join(root, "package-lock.json"), JSON.stringify({ version: "1.0.0", packages: { "": { version: "1.0.0" } } }));
  fs.writeFileSync(path.join(root, "src", "app.js"), "export const value = 1;\n");
  git(root, "init", "-b", "main");
  git(root, "config", "user.email", "version-policy@example.invalid");
  git(root, "config", "user.name", "Version Policy Test");
  git(root, "add", ".");
  git(root, "commit", "-m", "baseline");
  return { root, baseline: git(root, "rev-parse", "HEAD") };
}

function writeVersion(root, version, lockVersion = version) {
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ version }));
  fs.writeFileSync(path.join(root, "package-lock.json"), JSON.stringify({ version: lockVersion, packages: { "": { version: lockVersion } } }));
}

function verify(root, baseline) {
  return spawnSync("pwsh", ["-NoProfile", "-File", verifier, "-SourceRoot", root, "-BaselineCommit", baseline], {
    encoding: "utf8",
  });
}

test("version policy rejects a product correction with an unchanged version", () => {
  const { root, baseline } = createRepository();
  fs.writeFileSync(path.join(root, "src", "app.js"), "export const value = 2;\n");
  git(root, "add", ".");
  git(root, "commit", "-m", "fix without bump");

  const result = verify(root, baseline);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Version policy violation/);
  assert.match(result.stderr, /1\.0\.0'[\s\S]*not greater than[\s\S]*parent version '1\.0\.0'/);
});

test("version policy accepts a product correction with a same-commit version increase", () => {
  const { root, baseline } = createRepository();
  fs.writeFileSync(path.join(root, "src", "app.js"), "export const value = 2;\n");
  writeVersion(root, "1.0.1");
  git(root, "add", ".");
  git(root, "commit", "-m", "fix with bump");

  const result = verify(root, baseline);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /passed for 1 product-impacting commit/);
});

test("version policy caps patch versions at ten and accepts minor rollover", () => {
  const { root, baseline } = createRepository();
  fs.writeFileSync(path.join(root, "src", "app.js"), "export const value = 2;\n");
  writeVersion(root, "1.0.11");
  git(root, "add", ".");
  git(root, "commit", "-m", "invalid patch overflow");
  const rejected = verify(root, baseline);
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /patch component to stay at or below 10/);

  const rolloverBaseline = git(root, "rev-parse", "HEAD");
  writeVersion(root, "1.1.0");
  git(root, "add", ".");
  git(root, "commit", "-m", "minor rollover");
  const accepted = verify(root, rolloverBaseline);
  assert.equal(accepted.status, 0, accepted.stderr);
});

test("version policy ignores documentation OpenSpec and test-only commits", () => {
  const { root, baseline } = createRepository();
  fs.mkdirSync(path.join(root, "openspec"));
  fs.mkdirSync(path.join(root, "tests"));
  fs.writeFileSync(path.join(root, "README.md"), "docs\n");
  fs.writeFileSync(path.join(root, "openspec", "proposal.md"), "spec\n");
  fs.writeFileSync(path.join(root, "tests", "app.test.js"), "test\n");
  git(root, "add", ".");
  git(root, "commit", "-m", "docs and tests");

  const result = verify(root, baseline);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /passed for 0 product-impacting commit/);
});

test("version policy rejects a decreasing semantic version", () => {
  const { root, baseline } = createRepository();
  fs.writeFileSync(path.join(root, "src", "app.js"), "export const value = 2;\n");
  writeVersion(root, "0.9.9");
  git(root, "add", ".");
  git(root, "commit", "-m", "fix with decreasing version");

  const result = verify(root, baseline);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Version policy violation/);
  assert.match(result.stderr, /0\.9\.9/);
});

test("version policy rejects package-lock version drift", () => {
  const { root, baseline } = createRepository();
  fs.writeFileSync(path.join(root, "src", "app.js"), "export const value = 2;\n");
  writeVersion(root, "1.0.1", "1.0.0");
  git(root, "add", ".");
  git(root, "commit", "-m", "fix with stale lock version");

  const result = verify(root, baseline);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /package\.json, package-lock\.json/);
});

test("version policy fails closed when its baseline is missing", () => {
  const { root } = createRepository();
  const result = verify(root, "f".repeat(40));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /baseline commit.*does not exist/i);
});

test("version policy does not let a later bump hide an earlier unchanged-version correction", () => {
  const { root, baseline } = createRepository();
  fs.writeFileSync(path.join(root, "src", "app.js"), "export const value = 2;\n");
  git(root, "add", ".");
  git(root, "commit", "-m", "fix without bump");
  writeVersion(root, "1.0.1");
  git(root, "add", ".");
  git(root, "commit", "-m", "later bump");

  const result = verify(root, baseline);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Version policy violation/);
});
