import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { migrateCodexHistoryProvider, revertCodexHistoryProvider } from "../src/core/codex-history.js";
import { migrateLegacySwitcherBackups } from "../src/core/switcher-backups.js";

const fixtureRoots = new Set();
after(() => {
  for (const root of fixtureRoots) fs.rmSync(root, { recursive: true, force: true });
});

function createFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "secure-codex-history-"));
  fixtureRoots.add(root);
  const codexDir = path.join(root, ".codex");
  const rolloutPath = path.join(codexDir, "sessions", "2026", "06", "rollout-test.jsonl");
  fs.mkdirSync(path.dirname(rolloutPath), { recursive: true });
  fs.writeFileSync(
    rolloutPath,
    `${JSON.stringify({
      timestamp: "2026-06-12T00:00:00Z",
      type: "session_meta",
      payload: { id: "thread-1", model_provider: "openai", cwd: "C:\\work" }
    })}\n${JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "keep me" } })}\n`,
    "utf8"
  );

  const databasePath = path.join(codexDir, "state_5.sqlite");
  const database = new DatabaseSync(databasePath);
  database.exec(`
    CREATE TABLE threads (
      id TEXT PRIMARY KEY,
      rollout_path TEXT NOT NULL,
      model_provider TEXT NOT NULL
    );
  `);
  database.prepare("INSERT INTO threads (id, rollout_path, model_provider) VALUES (?, ?, ?)").run(
    "thread-1",
    rolloutPath,
    "openai"
  );
  database.close();
  return { codexDir, rolloutPath, databasePath };
}

function readRollout(filePath) {
  return fs.readFileSync(filePath, "utf8").trimEnd().split(/\r?\n/).map((line) => JSON.parse(line));
}

function readThreadProvider(databasePath) {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return database.prepare("SELECT model_provider FROM threads WHERE id = ?").get("thread-1").model_provider;
  } finally {
    database.close();
  }
}

test("migrates rollout and sqlite providers without changing conversation content", () => {
  const fixture = createFixture();

  const result = migrateCodexHistoryProvider(fixture.codexDir, "secure_codex_switcher_http", "openai");
  const rollout = readRollout(fixture.rolloutPath);

  assert.equal(result.changedRollouts, 1);
  assert.equal(result.changedThreads, 1);
  assert.equal(rollout[0].payload.model_provider, "secure_codex_switcher_http");
  assert.equal(rollout[1].payload.message, "keep me");
  assert.equal(readThreadProvider(fixture.databasePath), "secure_codex_switcher_http");
  assert.equal(fs.existsSync(path.join(fixture.codexDir, "secure-switcher-http-history.json")), true);
  assert.equal(fs.readdirSync(path.join(fixture.codexDir, "secure-switcher-history-backups")).some((name) => name.endsWith(".bak")), true);
});

test("skips empty or malformed rollouts without aborting transport migration", () => {
  const fixture = createFixture();
  const emptyPath = path.join(fixture.codexDir, "sessions", "2026", "06", "rollout-empty.jsonl");
  const malformedPath = path.join(fixture.codexDir, "sessions", "2026", "06", "rollout-malformed.jsonl");
  fs.writeFileSync(emptyPath, "", "utf8");
  fs.writeFileSync(malformedPath, "not-json\n", "utf8");

  const result = migrateCodexHistoryProvider(fixture.codexDir, "secure_codex_switcher_http", "openai");

  assert.equal(result.changedRollouts, 1);
  assert.equal(result.changedThreads, 1);
  assert.equal(result.skippedRollouts, 2);
  assert.deepEqual(result.skippedRolloutPaths.map((item) => item.path).sort(), [emptyPath, malformedPath].sort());
  assert.equal(fs.readFileSync(emptyPath, "utf8"), "");
  assert.equal(fs.readFileSync(malformedPath, "utf8"), "not-json\n");
});

test("reverts migrated history and maps sessions created in HTTP-only mode to the previous provider", () => {
  const fixture = createFixture();
  migrateCodexHistoryProvider(fixture.codexDir, "secure_codex_switcher_http", "openai");

  const newRolloutPath = path.join(fixture.codexDir, "sessions", "2026", "06", "rollout-new.jsonl");
  fs.writeFileSync(
    newRolloutPath,
    `${JSON.stringify({
      type: "session_meta",
      payload: { id: "thread-2", model_provider: "secure_codex_switcher_http" }
    })}\n`,
    "utf8"
  );
  const database = new DatabaseSync(fixture.databasePath);
  database.prepare("INSERT INTO threads (id, rollout_path, model_provider) VALUES (?, ?, ?)").run(
    "thread-2",
    newRolloutPath,
    "secure_codex_switcher_http"
  );
  database.close();

  const result = revertCodexHistoryProvider(fixture.codexDir, "openai");

  assert.equal(result.manifestFound, true);
  assert.equal(readRollout(fixture.rolloutPath)[0].payload.model_provider, "openai");
  assert.equal(readRollout(newRolloutPath)[0].payload.model_provider, "openai");
  const check = new DatabaseSync(fixture.databasePath, { readOnly: true });
  try {
    assert.deepEqual(
      check.prepare("SELECT id, model_provider FROM threads ORDER BY id").all().map((row) => ({ ...row })),
      [
        { id: "thread-1", model_provider: "openai" },
        { id: "thread-2", model_provider: "openai" }
      ]
    );
  } finally {
    check.close();
  }
  assert.equal(fs.existsSync(path.join(fixture.codexDir, "secure-switcher-http-history.json")), false);
});

test("stores history manifests and backups outside official Codex home", () => {
  const fixture = createFixture();
  const backupRoot = path.join(fixture.codexDir, "..", "appdata", "codex-backups");
  const storage = {
    manifestPath: path.join(backupRoot, "http-history.json"),
    backupDir: path.join(backupRoot, "history")
  };

  migrateCodexHistoryProvider(fixture.codexDir, "secure_codex_switcher_http", "openai", storage);

  assert.equal(fs.existsSync(storage.manifestPath), true);
  assert.equal(fs.readdirSync(storage.backupDir).some((name) => name.endsWith(".bak")), true);
  assert.equal(fs.existsSync(path.join(fixture.codexDir, "secure-switcher-http-history.json")), false);
  assert.equal(fs.existsSync(path.join(fixture.codexDir, "secure-switcher-history-backups")), false);

  revertCodexHistoryProvider(fixture.codexDir, "openai", storage);

  assert.equal(fs.existsSync(storage.manifestPath), false);
  assert.equal(fs.readdirSync(storage.backupDir).some((name) => name.startsWith("provider-manifest.")), true);
});

test("migrates valid legacy history JSON and SQLite backups after verification", () => {
  const fixture = createFixture();
  const legacyHistory = path.join(fixture.codexDir, "secure-switcher-history-backups");
  const legacyManifest = path.join(fixture.codexDir, "secure-switcher-http-history.json");
  const backupRoot = path.join(fixture.codexDir, "..", "appdata", "codex-backups");
  fs.mkdirSync(legacyHistory, { recursive: true });
  fs.writeFileSync(path.join(legacyHistory, "provider-manifest.2026-07-14.json"), JSON.stringify({ version: 1 }), "utf8");
  fs.copyFileSync(fixture.databasePath, path.join(legacyHistory, "state_5.sqlite.2026-07-14.bak"));
  fs.writeFileSync(legacyManifest, JSON.stringify({ version: 1 }), "utf8");

  migrateLegacySwitcherBackups(fixture.codexDir, backupRoot);

  assert.equal(fs.existsSync(legacyHistory), false);
  assert.equal(fs.existsSync(legacyManifest), false);
  assert.deepEqual(fs.readdirSync(path.join(backupRoot, "history")).sort(), [
    "provider-manifest.2026-07-14.json",
    "state_5.sqlite.2026-07-14.bak"
  ]);
  assert.equal(JSON.parse(fs.readFileSync(path.join(backupRoot, "http-history.json"), "utf8")).version, 1);
});
