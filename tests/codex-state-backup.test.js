import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import * as codexStateBackup from "../src/core/codex-state-backup.js";
import {
  createCompleteRecoveryPoint,
  createConversationBackup,
  createCriticalCodexSnapshot,
  inspectConversationBackup,
  inspectCriticalSnapshot,
  inventoryLegacyCodexRecoveryFiles,
  listCodexRecoveryBackups,
  migrateLegacyCodexRecoveryFiles,
  previewCodexRecovery,
  resolveCompleteRecoveryPoint,
  resolveCodexRecoverySelection,
  restoreCodexBackup
} from "../src/core/codex-state-backup.js";

function createFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-state-backup-"));
  const codexDir = path.join(root, ".codex");
  const backupRoot = path.join(root, "backup");
  fs.mkdirSync(codexDir, { recursive: true });
  fs.writeFileSync(
    path.join(codexDir, ".codex-global-state.json"),
    JSON.stringify({
      "local-projects": { "D:\\Private Project": { name: "Private Project" } },
      "project-order": ["D:\\Private Project"],
      "project-writable-roots": { "D:\\Private Project": ["D:\\Private Project"] },
      "thread-workspace-root-hints": { "private-thread": "D:\\Private Project" },
      "thread-project-assignments": { "private-thread": "D:\\Private Project" },
      "electron-saved-workspace-roots": ["D:\\Private Project"],
      "electron-persisted-atom-state": {
        "flat-project-sidebar-preferences-v1": { sortMode: "recent" },
        "sidebar-collapsed-sections-v1": { projects: false }
      }
    }),
    "utf8"
  );
  fs.writeFileSync(
    path.join(codexDir, "session_index.jsonl"),
    `${JSON.stringify({ id: "private-thread", title: "secret title" })}\n`,
    "utf8"
  );
  const database = new DatabaseSync(path.join(codexDir, "state_5.sqlite"));
  database.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT, archived INTEGER NOT NULL DEFAULT 0)");
  database.prepare("INSERT INTO threads (id, rollout_path, archived) VALUES (?, ?, ?)").run("private-thread", "secret-rollout", 1);
  database.close();
  return { root, codexDir, backupRoot };
}

function currentGlobalStateFixture() {
  return {
    "local-projects": { "D:\\Sanitized Project": { name: "Sanitized Project" } },
    "project-order": ["D:\\Sanitized Project"],
    "project-writable-roots": { "D:\\Sanitized Project": ["D:\\Sanitized Project"] },
    "thread-workspace-root-hints": { "sanitized-thread": "D:\\Sanitized Project" },
    "thread-project-assignments": { "sanitized-thread": { projectId: "sanitized-project" } },
    "electron-saved-workspace-roots": ["D:\\Sanitized Project"],
    "electron-persisted-atom-state": {
      "flat-project-sidebar-preferences-v1": { sortMode: "recent" },
      "sidebar-collapsed-sections-v1": { projects: false }
    }
  };
}

test("creates a validated critical snapshot without private manifest fields", () => {
  const fixture = createFixture();
  try {
    const result = createCriticalCodexSnapshot({ codexDir: fixture.codexDir, backupRoot: fixture.backupRoot, now: () => 1_700_000_000_000 });
    const manifestText = fs.readFileSync(result.manifestPath, "utf8");
    const manifest = JSON.parse(manifestText);

    assert.equal(manifest.validated, true);
    assert.deepEqual(manifest.counts, {
      projects: 1, projectOrder: 1, writableRoots: 1, workspaceHints: 1, assignments: 1,
      environmentRoots: 1, uiState: 2, threads: 1, archivedThreads: 1, sessionIndexRows: 1
    });
    assert.deepEqual(manifest.artifacts.map((artifact) => artifact.role), ["global-state", "thread-database", "session-index"]);
    assert.equal(manifest.artifacts.every((artifact) => artifact.bytes > 0 && /^[a-f0-9]{64}$/.test(artifact.sha256)), true);
    assert.equal(manifestText.includes("Private Project"), false);
    assert.equal(manifestText.includes("private-thread"), false);
    assert.equal(fs.existsSync(path.join(result.generationDir, ".codex-global-state.json")), true);
    assert.equal(fs.existsSync(path.join(result.generationDir, "state_5.sqlite")), true);
    assert.equal(fs.existsSync(path.join(result.generationDir, "session_index.jsonl")), true);
    assert.equal(fs.readdirSync(path.dirname(result.generationDir)).some((name) => name.includes(".pending")), false);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("rejects corrupt SQLite and insufficient destination space without replacing the last valid critical generation", () => {
  const fixture = createFixture();
  try {
    const valid = createCriticalCodexSnapshot({ codexDir: fixture.codexDir, backupRoot: fixture.backupRoot, now: () => 1_700_000_000_000 });
    const before = fs.readdirSync(path.dirname(valid.generationDir)).sort();
    fs.writeFileSync(path.join(fixture.codexDir, "state_5.sqlite"), "not sqlite", "utf8");
    assert.throws(
      () => createCriticalCodexSnapshot({ codexDir: fixture.codexDir, backupRoot: fixture.backupRoot, now: () => 1_700_000_001_000 }),
      /sqlite|database|malformed/i
    );
    assert.deepEqual(fs.readdirSync(path.dirname(valid.generationDir)).sort(), before);

    fs.rmSync(fixture.root, { recursive: true, force: true });
    const noSpace = createFixture();
    try {
      assert.throws(
        () => createCriticalCodexSnapshot({ codexDir: noSpace.codexDir, backupRoot: noSpace.backupRoot, getAvailableBytes: () => 0 }),
        /insufficient.*space/i
      );
      assert.equal(fs.existsSync(path.join(noSpace.backupRoot, "codex-state", "critical")), false);
    } finally {
      fs.rmSync(noSpace.root, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("rejects a partial critical copy and quarantines an interrupted post-promotion generation", () => {
  const fixture = createFixture();
  try {
    const copyFileSync = fs.copyFileSync;
    fs.copyFileSync = (source, destination, ...args) => {
      const result = copyFileSync(source, destination, ...args);
      if (path.basename(destination) === ".codex-global-state.json") fs.truncateSync(destination, 1);
      return result;
    };
    try {
      assert.throws(() => createCriticalCodexSnapshot({ codexDir: fixture.codexDir, backupRoot: fixture.backupRoot }), /verification/i);
    } finally {
      fs.copyFileSync = copyFileSync;
    }
    const criticalRoot = path.join(fixture.backupRoot, "codex-state", "critical");
    assert.equal(fs.existsSync(criticalRoot) && fs.readdirSync(criticalRoot).some((name) => name.includes("pending")), false);

    let inspections = 0;
    assert.throws(
      () => createCriticalCodexSnapshot({
        codexDir: fixture.codexDir,
        backupRoot: fixture.backupRoot,
        now: () => 1_700_000_002_000,
        inspectSnapshot: (generationDir) => {
          inspections += 1;
          if (!generationDir.includes(".pending") && inspections > 1) throw new Error("simulated interrupted promotion");
          return inspectCriticalSnapshot(generationDir);
        }
      }),
      /interrupted promotion/i
    );
    assert.equal(fs.existsSync(path.join(fixture.backupRoot, "codex-state", "quarantine")), true);
    assert.equal(fs.readdirSync(criticalRoot).some((name) => name.includes("pending")), false);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("rejects a same-length destination hash mismatch without promoting a critical generation", () => {
  const fixture = createFixture();
  const copyFileSync = fs.copyFileSync;
  fs.copyFileSync = (source, destination, ...args) => {
    const result = copyFileSync(source, destination, ...args);
    if (path.basename(destination) === "session_index.jsonl") {
      const text = fs.readFileSync(destination, "utf8");
      fs.writeFileSync(destination, text.replace("secret title", "public title"), "utf8");
    }
    return result;
  };
  try {
    assert.throws(
      () => createCriticalCodexSnapshot({ codexDir: fixture.codexDir, backupRoot: fixture.backupRoot }),
      /verification/i
    );
    const criticalRoot = path.join(fixture.backupRoot, "codex-state", "critical");
    assert.equal(fs.existsSync(criticalRoot) && fs.readdirSync(criticalRoot).length, 0);
  } finally {
    fs.copyFileSync = copyFileSync;
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("accepts the current Codex global-state schema without an invented sidebar-mode field across account switches", () => {
  const fixture = createFixture();
  const globalPath = path.join(fixture.codexDir, ".codex-global-state.json");
  try {
    fs.writeFileSync(globalPath, JSON.stringify(currentGlobalStateFixture()), "utf8");
    const first = createCriticalCodexSnapshot({ codexDir: fixture.codexDir, backupRoot: fixture.backupRoot, now: () => 1_700_000_000_000 });

    const switched = currentGlobalStateFixture();
    switched["electron-persisted-atom-state"]["sidebar-collapsed-sections-v1"].projects = true;
    fs.writeFileSync(globalPath, JSON.stringify(switched), "utf8");
    const second = createCriticalCodexSnapshot({ codexDir: fixture.codexDir, backupRoot: fixture.backupRoot, now: () => 1_700_000_001_000 });

    assert.equal(first.manifest.counts.uiState, 2);
    assert.equal(second.manifest.counts.uiState, 2);
    assert.equal("sidebarMode" in second.manifest.counts, false);
    assert.equal(inspectCriticalSnapshot(second.generationDir).valid, true);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("encrypts and deduplicates conversation files without plaintext metadata", { skip: process.platform !== "win32" }, async () => {
  const fixture = createFixture();
  const secret = "private prompt that must never appear on D";
  const sessionPath = path.join(fixture.codexDir, "sessions", "2026", "07", "rollout-private.jsonl");
  const archivedPath = path.join(fixture.codexDir, "archived_sessions", "rollout-archived.jsonl");
  fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
  fs.mkdirSync(path.dirname(archivedPath), { recursive: true });
  fs.writeFileSync(sessionPath, `${JSON.stringify({ title: "secret title", message: secret })}\n`, "utf8");
  fs.copyFileSync(sessionPath, archivedPath);
  try {
    const first = await createConversationBackup({ codexDir: fixture.codexDir, backupRoot: fixture.backupRoot, now: () => 1_700_000_000_000 });
    const second = await createConversationBackup({ codexDir: fixture.codexDir, backupRoot: fixture.backupRoot, now: () => 1_700_000_001_000 });
    const backupBytes = fs
      .readdirSync(path.join(fixture.backupRoot, "codex-state", "conversations", "blobs"))
      .map((name) => fs.readFileSync(path.join(fixture.backupRoot, "codex-state", "conversations", "blobs", name)))
      .reduce((combined, item) => Buffer.concat([combined, item]), Buffer.alloc(0));
    const manifestText = fs.readFileSync(second.manifestPath, "utf8");

    assert.equal(first.manifest.files.length, 2);
    assert.equal(second.manifest.files.length, 2);
    assert.equal(fs.readdirSync(path.join(fixture.backupRoot, "codex-state", "conversations", "blobs")).length, 1);
    assert.equal(manifestText.includes("rollout-private"), false);
    assert.equal(manifestText.includes("secret title"), false);
    assert.equal(manifestText.includes(secret), false);
    assert.equal(backupBytes.includes(Buffer.from(secret)), false);
    assert.deepEqual(await inspectConversationBackup(second.manifestPath), { valid: true, activeSessions: 1, archivedSessions: 1, files: 2 });
    await assert.rejects(() => inspectConversationBackup(second.manifestPath, { unprotectKey: () => { throw new Error("wrong Windows user"); } }), /wrong Windows user/);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("backs up and validates an empty conversation file", async () => {
  const fixture = createFixture();
  const emptySession = path.join(fixture.codexDir, "sessions", "empty.jsonl");
  fs.mkdirSync(path.dirname(emptySession), { recursive: true });
  fs.writeFileSync(emptySession, "");
  const identity = (value) => value;
  try {
    const result = await createConversationBackup({
      codexDir: fixture.codexDir,
      backupRoot: fixture.backupRoot,
      protectKey: identity,
      unprotectKey: identity
    });
    const inspected = await inspectConversationBackup(result.manifestPath, { unprotectKey: identity });
    assert.equal(inspected.valid, true);
    assert.equal(result.manifest.files[0].bytes, 0);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("reports honest aggregate conversation-backup progress without private file details", { skip: process.platform !== "win32" }, async () => {
  const fixture = createFixture();
  const active = path.join(fixture.codexDir, "sessions", "private-active-thread.jsonl");
  const archived = path.join(fixture.codexDir, "archived_sessions", "private-archived-thread.jsonl");
  fs.mkdirSync(path.dirname(active), { recursive: true });
  fs.mkdirSync(path.dirname(archived), { recursive: true });
  fs.writeFileSync(active, "private active conversation", "utf8");
  fs.writeFileSync(archived, "private archived conversation", "utf8");
  const progress = [];
  try {
    await createConversationBackup({
      codexDir: fixture.codexDir,
      backupRoot: fixture.backupRoot,
      now: () => 1_700_000_000_000,
      onProgress: (value) => progress.push(value)
    });

    assert.deepEqual(progress.map((value) => value.stage), [
      "discovering", "processing", "processing", "processing",
      "validating", "validating", "validating", "validating", "pruning", "completed"
    ]);
    assert.deepEqual(progress.filter((value) => value.stage === "processing").map((value) => value.processedFiles), [0, 1, 2]);
    assert.equal(progress.at(-1).processedFiles, 2);
    assert.equal(progress.at(-1).totalFiles, 2);
    assert.equal(progress.at(-1).processedBytes, Buffer.byteLength("private active conversation") + Buffer.byteLength("private archived conversation"));
    assert.equal(progress.at(-1).processedBytes, progress.at(-1).totalBytes);
    const serialized = JSON.stringify(progress);
    assert.doesNotMatch(serialized, /private-active|private-archived|conversation|sessions|archived_sessions|[A-Z]:\\/i);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("progress callback failures do not abort a conversation backup", { skip: process.platform !== "win32" }, async () => {
  const fixture = createFixture();
  const active = path.join(fixture.codexDir, "sessions", "rollout.jsonl");
  fs.mkdirSync(path.dirname(active), { recursive: true });
  fs.writeFileSync(active, "synthetic conversation", "utf8");
  try {
    const result = await createConversationBackup({
      codexDir: fixture.codexDir,
      backupRoot: fixture.backupRoot,
      onProgress: () => { throw new Error("listener failed"); }
    });
    assert.equal(result.manifest.counts.activeSessions, 1);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("does not promote a conversation generation when a source changes during encryption", { skip: process.platform !== "win32" }, async () => {
  const fixture = createFixture();
  const sessionPath = path.join(fixture.codexDir, "sessions", "rollout.jsonl");
  fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
  fs.writeFileSync(sessionPath, "last valid", "utf8");
  try {
    await createConversationBackup({ codexDir: fixture.codexDir, backupRoot: fixture.backupRoot, now: () => 1_700_000_000_000 });
    fs.writeFileSync(sessionPath, "candidate", "utf8");
    const createReadStream = fs.createReadStream;
    let changed = false;
    fs.createReadStream = (filePath, ...args) => {
      if (!changed && path.resolve(filePath) === path.resolve(sessionPath)) {
        changed = true;
        fs.writeFileSync(sessionPath, "changed during encryption", "utf8");
      }
      return createReadStream(filePath, ...args);
    };
    try {
      await assert.rejects(
        () => createConversationBackup({ codexDir: fixture.codexDir, backupRoot: fixture.backupRoot, now: () => 1_700_000_001_000 }),
        /changed|hash|length/i
      );
    } finally {
      fs.createReadStream = createReadStream;
    }

    const root = path.join(fixture.backupRoot, "codex-state", "conversations");
    assert.equal(fs.readdirSync(path.join(root, "manifests")).length, 1);
    assert.equal(fs.readdirSync(path.join(root, "blobs")).length, 1);
    assert.equal(
      [...fs.readdirSync(path.join(root, "manifests")), ...fs.readdirSync(path.join(root, "blobs"))]
        .some((name) => name.includes("pending") || name.endsWith(".tmp")),
      false
    );
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("does not create conversation artifacts when a source changes while being hashed", { skip: process.platform !== "win32" }, async () => {
  const fixture = createFixture();
  const sessionPath = path.join(fixture.codexDir, "sessions", "rollout.jsonl");
  fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
  fs.writeFileSync(sessionPath, "candidate", "utf8");
  const statSync = fs.statSync;
  let sourceStats = 0;
  fs.statSync = (filePath, ...args) => {
    if (path.resolve(filePath) === path.resolve(sessionPath) && ++sourceStats === 2) {
      fs.writeFileSync(sessionPath, "changed while hashing", "utf8");
    }
    return statSync(filePath, ...args);
  };
  try {
    await assert.rejects(
      async () => {
        try {
          await createConversationBackup({ codexDir: fixture.codexDir, backupRoot: fixture.backupRoot });
        } catch (error) {
          assert.equal(error.message.includes(path.basename(sessionPath)), false);
          throw error;
        }
      },
      /changed while hashing/i
    );
    const root = path.join(fixture.backupRoot, "codex-state", "conversations");
    assert.equal(fs.existsSync(path.join(root, "manifests")), false);
    assert.equal(fs.readdirSync(path.join(root, "blobs")).length, 0);
  } finally {
    fs.statSync = statSync;
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("repairs a corrupt reusable conversation blob before promoting a new manifest", { skip: process.platform !== "win32" }, async () => {
  const fixture = createFixture();
  const sessionPath = path.join(fixture.codexDir, "sessions", "rollout.jsonl");
  fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
  fs.writeFileSync(sessionPath, "unchanged", "utf8");
  try {
    const first = await createConversationBackup({ codexDir: fixture.codexDir, backupRoot: fixture.backupRoot, now: () => 1_700_000_000_000 });
    const blobRoot = path.join(fixture.backupRoot, "codex-state", "conversations", "blobs");
    const blobPath = path.join(blobRoot, fs.readdirSync(blobRoot)[0]);
    fs.writeFileSync(blobPath, "corrupt", "utf8");

    const second = await createConversationBackup({ codexDir: fixture.codexDir, backupRoot: fixture.backupRoot, now: () => 1_700_000_001_000 });
    assert.deepEqual(await inspectConversationBackup(second.manifestPath), { valid: true, activeSessions: 1, archivedSessions: 0, files: 1 });
    assert.equal(fs.readdirSync(blobRoot).length, 1);
    assert.equal(fs.existsSync(first.manifestPath), true);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("rejects an impossible encrypted blob header before allocating protected-key metadata", async () => {
  const fixture = createFixture();
  const conversationRoot = path.join(fixture.backupRoot, "codex-state", "conversations");
  const manifestRoot = path.join(conversationRoot, "manifests");
  const blobRoot = path.join(conversationRoot, "blobs");
  const sha256 = "a".repeat(64);
  const blob = `${sha256}.scsb`;
  const manifestPath = path.join(manifestRoot, "conversation-manifest-corrupt.json");
  fs.mkdirSync(manifestRoot, { recursive: true });
  fs.mkdirSync(blobRoot, { recursive: true });
  const header = Buffer.alloc(12);
  header.write("SCSBLOB1", 0, "ascii");
  header.writeUInt32BE(1024 * 1024, 8);
  fs.writeFileSync(path.join(blobRoot, blob), header);
  fs.writeFileSync(manifestPath, JSON.stringify({
    version: 1,
    kind: "conversations",
    complete: true,
    counts: { activeSessions: 1, archivedSessions: 0 },
    files: [{ scope: "active", pathDpapi: "rollout.jsonl", sha256, bytes: 0, blob }]
  }));
  try {
    await assert.rejects(
      () => inspectConversationBackup(manifestPath, { unprotectKey: (value) => value }),
      /invalid encrypted conversation blob metadata/i
    );
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("rejects an unprotected conversation key unless it is canonical base64 for exactly 32 bytes", async () => {
  const fixture = createFixture();
  const conversationRoot = path.join(fixture.backupRoot, "codex-state", "conversations");
  const manifestRoot = path.join(conversationRoot, "manifests");
  const blobRoot = path.join(conversationRoot, "blobs");
  const sha256 = "b".repeat(64);
  const blob = `${sha256}.scsb`;
  const manifestPath = path.join(manifestRoot, "conversation-manifest-bad-key.json");
  const protectedKey = Buffer.from("wrapped-key", "utf8");
  const bytes = Buffer.alloc(12 + protectedKey.length + 12 + 16);
  bytes.write("SCSBLOB1", 0, "ascii");
  bytes.writeUInt32BE(protectedKey.length, 8);
  protectedKey.copy(bytes, 12);
  fs.mkdirSync(manifestRoot, { recursive: true });
  fs.mkdirSync(blobRoot, { recursive: true });
  fs.writeFileSync(path.join(blobRoot, blob), bytes);
  fs.writeFileSync(manifestPath, JSON.stringify({
    version: 1,
    kind: "conversations",
    complete: true,
    counts: { activeSessions: 1, archivedSessions: 0 },
    files: [{ scope: "active", pathDpapi: "rollout.jsonl", sha256, bytes: 0, blob }]
  }));
  try {
    await assert.rejects(
      () => inspectConversationBackup(manifestPath, { unprotectKey: () => "not canonical base64" }),
      /invalid protected conversation key/i
    );
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("rejects all-zero critical JSON without replacing the last valid generation", () => {
  const fixture = createFixture();
  try {
    createCriticalCodexSnapshot({ codexDir: fixture.codexDir, backupRoot: fixture.backupRoot, now: () => 1_700_000_000_000 });
    fs.writeFileSync(path.join(fixture.codexDir, ".codex-global-state.json"), Buffer.alloc(128));

    assert.throws(
      () => createCriticalCodexSnapshot({ codexDir: fixture.codexDir, backupRoot: fixture.backupRoot, now: () => 1_700_000_001_000 }),
      /all-zero/i
    );
    const criticalRoot = path.join(fixture.backupRoot, "codex-state", "critical");
    assert.equal(fs.readdirSync(criticalRoot).filter((name) => name.startsWith("critical-")).length, 1);
    assert.equal(fs.readdirSync(criticalRoot).some((name) => name.includes("pending")), false);

  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("retains only the latest ten validated critical snapshots", () => {
  const fixture = createFixture();
  try {
    for (let index = 0; index < 11; index += 1) {
      createCriticalCodexSnapshot({
        codexDir: fixture.codexDir,
        backupRoot: fixture.backupRoot,
        now: () => 1_700_000_000_000 + index * 1000
      });
    }
    const names = fs.readdirSync(path.join(fixture.backupRoot, "codex-state", "critical")).sort();
    assert.equal(names.length, 10);
    assert.equal(names.some((name) => name.includes("00-00-00-000Z")), false);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("reuses readiness for unchanged historical critical generations", () => {
  const fixture = createFixture();
  const inspected = [];
  const inspectSnapshot = (generationDir) => {
    inspected.push(path.basename(generationDir));
    return inspectCriticalSnapshot(generationDir);
  };
  try {
    const first = createCriticalCodexSnapshot({
      codexDir: fixture.codexDir,
      backupRoot: fixture.backupRoot,
      now: () => 1_700_000_000_000,
      inspectSnapshot
    });
    inspected.length = 0;
    createCriticalCodexSnapshot({
      codexDir: fixture.codexDir,
      backupRoot: fixture.backupRoot,
      now: () => 1_700_000_001_000,
      inspectSnapshot
    });

    assert.equal(inspected.includes(path.basename(first.generationDir)), false);
    assert.equal(inspected.length >= 2, true);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("rechecks and quarantines a cached critical generation when its identity changes", () => {
  const fixture = createFixture();
  const inspected = [];
  const inspectSnapshot = (generationDir) => {
    inspected.push(path.basename(generationDir));
    return inspectCriticalSnapshot(generationDir);
  };
  try {
    const first = createCriticalCodexSnapshot({
      codexDir: fixture.codexDir,
      backupRoot: fixture.backupRoot,
      now: () => 1_700_000_000_000,
      inspectSnapshot
    });
    fs.appendFileSync(path.join(first.generationDir, "session_index.jsonl"), "{}\n");
    inspected.length = 0;

    createCriticalCodexSnapshot({
      codexDir: fixture.codexDir,
      backupRoot: fixture.backupRoot,
      now: () => 1_700_000_001_000,
      inspectSnapshot
    });

    assert.equal(inspected.includes(path.basename(first.generationDir)), true);
    assert.equal(fs.existsSync(first.generationDir), false);
    assert.equal(fs.readdirSync(path.join(fixture.backupRoot, "codex-state", "quarantine")).length, 1);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("excludes invalid generations from lineage and quarantines them before retention", () => {
  const fixture = createFixture();
  try {
    const first = createCriticalCodexSnapshot({ codexDir: fixture.codexDir, backupRoot: fixture.backupRoot, now: () => 1_700_000_000_000 });
    const invalid = createCriticalCodexSnapshot({ codexDir: fixture.codexDir, backupRoot: fixture.backupRoot, now: () => 1_700_000_001_000 });
    const invalidManifest = JSON.parse(fs.readFileSync(invalid.manifestPath, "utf8"));
    invalidManifest.counts.projects = 99;
    fs.writeFileSync(invalid.manifestPath, JSON.stringify(invalidManifest), "utf8");

    const next = createCriticalCodexSnapshot({ codexDir: fixture.codexDir, backupRoot: fixture.backupRoot, now: () => 1_700_000_002_000 });
    assert.equal(next.manifest.lineage, path.basename(first.generationDir));
    assert.equal(fs.existsSync(invalid.generationDir), false);
    assert.equal(fs.readdirSync(path.join(fixture.backupRoot, "codex-state", "quarantine")).length, 1);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("readiness rejects duplicate critical roles and aggregate count tampering", () => {
  const fixture = createFixture();
  try {
    const snapshot = createCriticalCodexSnapshot({ codexDir: fixture.codexDir, backupRoot: fixture.backupRoot });
    const manifest = JSON.parse(fs.readFileSync(snapshot.manifestPath, "utf8"));
    manifest.artifacts[2] = { ...manifest.artifacts[0] };
    fs.writeFileSync(snapshot.manifestPath, JSON.stringify(manifest), "utf8");
    assert.throws(() => inspectCriticalSnapshot(snapshot.generationDir), /exactly one|required roles/i);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("retains three complete conversation manifests and only their referenced blobs", { skip: process.platform !== "win32" }, async () => {
  const fixture = createFixture();
  const sessionPath = path.join(fixture.codexDir, "sessions", "rollout.jsonl");
  fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
  try {
    for (let index = 0; index < 4; index += 1) {
      fs.writeFileSync(sessionPath, `${JSON.stringify({ message: `private-${index}` })}\n`, "utf8");
      await createConversationBackup({ codexDir: fixture.codexDir, backupRoot: fixture.backupRoot, now: () => 1_700_000_000_000 + index * 1000 });
    }
    const root = path.join(fixture.backupRoot, "codex-state", "conversations");
    assert.equal(fs.readdirSync(path.join(root, "manifests")).length, 3);
    assert.equal(fs.readdirSync(path.join(root, "blobs")).length, 3);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("invalid conversation manifests cannot block or displace the latest three valid generations", async () => {
  const fixture = createFixture();
  const sessionPath = path.join(fixture.codexDir, "sessions", "rollout.jsonl");
  const protectKey = (value) => value;
  const unprotectKey = (value) => value;
  fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
  try {
    for (let index = 0; index < 3; index += 1) {
      fs.writeFileSync(sessionPath, `sanitized-${index}`, "utf8");
      await createConversationBackup({
        codexDir: fixture.codexDir,
        backupRoot: fixture.backupRoot,
        now: () => 1_700_000_000_000 + index * 1000,
        protectKey,
        unprotectKey
      });
    }
    const root = path.join(fixture.backupRoot, "codex-state", "conversations");
    const manifestRoot = path.join(root, "manifests");
    const blobRoot = path.join(root, "blobs");
    fs.writeFileSync(path.join(blobRoot, "orphan.scsb"), "invalid", "utf8");
    fs.writeFileSync(path.join(blobRoot, "upload.pending"), "keep", "utf8");
    fs.writeFileSync(path.join(blobRoot, "notes.txt"), "keep", "utf8");
    fs.writeFileSync(
      path.join(manifestRoot, "conversation-manifest-9999999999999.json"),
      JSON.stringify({
        version: 1,
        kind: "conversations",
        complete: true,
        counts: { activeSessions: 1, archivedSessions: 0 },
        files: []
      }),
      "utf8"
    );

    fs.writeFileSync(sessionPath, "sanitized-3", "utf8");
    await createConversationBackup({
      codexDir: fixture.codexDir,
      backupRoot: fixture.backupRoot,
      now: () => 1_700_000_003_000,
      protectKey,
      unprotectKey
    });

    const retained = fs.readdirSync(manifestRoot).sort();
    assert.deepEqual(retained, [
      "conversation-manifest-1700000001000.json",
      "conversation-manifest-1700000002000.json",
      "conversation-manifest-1700000003000.json"
    ]);
    const quarantineFiles = fs.readdirSync(path.join(root, "quarantine")).sort();
    assert.deepEqual(quarantineFiles.filter((name) => name.endsWith(".json") && !name.endsWith(".reason.json")), ["conversation-manifest-9999999999999.json"]);
    assert.equal(quarantineFiles.filter((name) => name.endsWith(".reason.json")).length, 1);
    assert.equal(fs.readdirSync(blobRoot).filter((name) => name.endsWith(".scsb")).length, 3);
    assert.equal(fs.existsSync(path.join(blobRoot, "orphan.scsb")), false);
    assert.equal(fs.existsSync(path.join(blobRoot, "upload.pending")), true);
    assert.equal(fs.existsSync(path.join(blobRoot, "notes.txt")), true);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("previews recovery conflicts without exposing content", { skip: process.platform !== "win32" }, async () => {
  const fixture = createFixture();
  const sessionPath = path.join(fixture.codexDir, "sessions", "rollout.jsonl");
  fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
  fs.writeFileSync(sessionPath, `${JSON.stringify({ message: "backup version" })}\n`, "utf8");
  try {
    const critical = createCriticalCodexSnapshot({ codexDir: fixture.codexDir, backupRoot: fixture.backupRoot, now: () => 1_700_000_000_000 });
    const conversations = await createConversationBackup({ codexDir: fixture.codexDir, backupRoot: fixture.backupRoot, now: () => 1_700_000_000_000 });
    fs.writeFileSync(sessionPath, `${JSON.stringify({ message: "newer live version" })}\n`, "utf8");

    const preview = await previewCodexRecovery({
      criticalGenerationDir: critical.generationDir,
      conversationManifestPath: conversations.manifestPath,
      liveCodexDir: fixture.codexDir
    });
    assert.deepEqual(preview.counts, {
      projects: 1, projectOrder: 1, writableRoots: 1, workspaceHints: 1, assignments: 1,
      environmentRoots: 1, uiState: 2, threads: 1, archivedThreads: 1, sessionIndexRows: 1,
      activeSessions: 1, archivedSessions: 0
    });
    assert.deepEqual(preview.effects, { missing: 0, conflicts: 1 });
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("rejects recovery snapshots with duplicate local-project paths", { skip: process.platform !== "win32" }, async () => {
  const fixture = createFixture();
  const globalPath = path.join(fixture.codexDir, ".codex-global-state.json");
  try {
    const globalState = JSON.parse(fs.readFileSync(globalPath, "utf8"));
    globalState["local-projects"] = {
      legacy: { name: "Legacy", rootPaths: ["D:\\Same Project"] },
      "local-current": { name: "Current", rootPaths: ["D:\\Same Project"] }
    };
    globalState["project-order"] = ["legacy", "local-current"];
    fs.writeFileSync(globalPath, JSON.stringify(globalState), "utf8");
    const critical = createCriticalCodexSnapshot({ codexDir: fixture.codexDir, backupRoot: fixture.backupRoot });
    const conversations = await createConversationBackup({ codexDir: fixture.codexDir, backupRoot: fixture.backupRoot });

    await assert.rejects(
      () => previewCodexRecovery({ criticalGenerationDir: critical.generationDir, conversationManifestPath: conversations.manifestPath, liveCodexDir: fixture.codexDir }),
      /duplicate local-project path/i
    );
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("lists only valid recovery generations as privacy-safe opaque summaries", async () => {
  const fixture = createFixture();
  const protectKey = (value) => value;
  const sessionPath = path.join(fixture.codexDir, "sessions", "private-rollout.jsonl");
  fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
  fs.writeFileSync(sessionPath, `${JSON.stringify({ title: "private title", message: "private message" })}\n`, "utf8");
  try {
    createCriticalCodexSnapshot({ codexDir: fixture.codexDir, backupRoot: fixture.backupRoot, now: () => 1_700_000_000_000 });
    await createConversationBackup({
      codexDir: fixture.codexDir,
      backupRoot: fixture.backupRoot,
      now: () => 1_700_000_001_000,
      protectKey,
      unprotectKey: protectKey
    });
    const invalidCritical = path.join(fixture.backupRoot, "codex-state", "critical", "critical-invalid");
    fs.mkdirSync(invalidCritical);
    fs.writeFileSync(path.join(invalidCritical, "manifest.json"), "{}", "utf8");
    const manifestRoot = path.join(fixture.backupRoot, "codex-state", "conversations", "manifests");
    fs.writeFileSync(path.join(manifestRoot, "conversation-manifest-invalid.json"), "{}", "utf8");

    const result = await listCodexRecoveryBackups({ backupRoot: fixture.backupRoot, unprotectKey: protectKey });

    assert.equal(result.criticalGenerations.length, 1);
    assert.equal(result.conversationGenerations.length, 1);
    assert.deepEqual(result.criticalGenerations[0].counts, { projects: 1, assignments: 1, threads: 1 });
    assert.deepEqual(result.conversationGenerations[0].counts, { active: 1, archived: 0 });
    assert.match(result.criticalGenerations[0].generationId, /^[A-Za-z0-9_-]{43}$/);
    assert.match(result.conversationGenerations[0].generationId, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(result.criticalGenerations[0].backupTime, "2023-11-14T22:13:20.000Z");
    assert.equal(result.conversationGenerations[0].backupTime, "2023-11-14T22:13:21.000Z");
    const serialized = JSON.stringify(result);
    assert.doesNotMatch(serialized, /private|title|message|[A-Z]:\\|sha256|dpapi/i);
    const criticalQuarantine = fs.readdirSync(path.join(fixture.backupRoot, "codex-state", "quarantine"));
    const conversationQuarantine = fs.readdirSync(path.join(fixture.backupRoot, "codex-state", "conversations", "quarantine"));
    assert.equal(criticalQuarantine.some((name) => name.startsWith("critical-invalid")), true);
    assert.equal(conversationQuarantine.some((name) => name.startsWith("conversation-manifest-invalid")), true);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("recovery-list completion retains the validated aggregate progress", async () => {
  const fixture = createFixture();
  const protectKey = (value) => value;
  const sessionPath = path.join(fixture.codexDir, "sessions", "completion-progress.jsonl");
  fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
  fs.writeFileSync(sessionPath, "completion progress fixture\n", "utf8");
  try {
    await createConversationBackup({
      codexDir: fixture.codexDir, backupRoot: fixture.backupRoot, now: () => 1_700_000_000_000,
      protectKey, unprotectKey: protectKey
    });
    const progress = [];
    await listCodexRecoveryBackups({
      backupRoot: fixture.backupRoot,
      unprotectKey: protectKey,
      onProgress: (value) => progress.push(value)
    });

    const validating = progress.filter((value) => value.stage === "validating_backup").at(-1);
    const completed = progress.at(-1);
    assert.ok(validating?.totalFiles > 0);
    assert.deepEqual(completed, { ...validating, stage: "completed" });
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("retries a temporary conversation validation failure without quarantining a valid manifest", async () => {
  const fixture = createFixture();
  const protectKey = (value) => value;
  const sessionPath = path.join(fixture.codexDir, "sessions", "retry.jsonl");
  fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
  fs.writeFileSync(sessionPath, "retry fixture\n", "utf8");
  try {
    const backup = await createConversationBackup({
      codexDir: fixture.codexDir, backupRoot: fixture.backupRoot, now: () => 1_700_000_000_000,
      protectKey, unprotectKey: protectKey
    });
    let calls = 0;
    const listed = await listCodexRecoveryBackups({
      backupRoot: fixture.backupRoot,
      unprotectKey: (value) => {
        calls += 1;
        if (calls === 1) {
          const error = new Error("DPAPI temporarily unavailable");
          error.code = "EAGAIN";
          throw error;
        }
        return value;
      }
    });

    assert.equal(listed.conversationGenerations.length, 1);
    assert.equal(listed.unavailableConversationBackups, 0);
    assert.equal(fs.existsSync(backup.manifestPath), true);
    assert.equal(fs.existsSync(path.join(fixture.backupRoot, "codex-state", "conversations", "quarantine")), false);
    assert.ok(calls > 1);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("keeps a persistent temporary validation failure active and reports only an unavailable count", async () => {
  const fixture = createFixture();
  const protectKey = (value) => value;
  const sessionPath = path.join(fixture.codexDir, "sessions", "unavailable.jsonl");
  fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
  fs.writeFileSync(sessionPath, "unavailable fixture\n", "utf8");
  try {
    const backup = await createConversationBackup({
      codexDir: fixture.codexDir, backupRoot: fixture.backupRoot, now: () => 1_700_000_000_000,
      protectKey, unprotectKey: protectKey
    });
    const listed = await listCodexRecoveryBackups({
      backupRoot: fixture.backupRoot,
      unprotectKey: () => {
        const error = new Error("DPAPI temporarily unavailable");
        error.code = "EAGAIN";
        throw error;
      }
    });

    assert.equal(listed.conversationGenerations.length, 0);
    assert.equal(listed.unavailableConversationBackups, 1);
    assert.equal(fs.existsSync(backup.manifestPath), true);
    assert.equal(fs.existsSync(path.join(fixture.backupRoot, "codex-state", "conversations", "quarantine")), false);
    assert.doesNotMatch(JSON.stringify(listed), /retry\.jsonl|unavailable\.jsonl|private/i);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("quarantines repeatably malformed JSON manifests with a safe reason record", async () => {
  const fixture = createFixture();
  const manifestRoot = path.join(fixture.backupRoot, "codex-state", "conversations", "manifests");
  const name = "conversation-manifest-invalid.json";
  fs.mkdirSync(manifestRoot, { recursive: true });
  fs.writeFileSync(path.join(manifestRoot, name), "{", "utf8");
  try {
    const listed = await listCodexRecoveryBackups({ backupRoot: fixture.backupRoot, unprotectKey: (value) => value });
    const quarantineRoot = path.join(fixture.backupRoot, "codex-state", "conversations", "quarantine");
    const reasonPath = path.join(quarantineRoot, `${name}.reason.json`);

    assert.equal(fs.existsSync(path.join(manifestRoot, name)), false);
    assert.equal(fs.existsSync(path.join(quarantineRoot, name)), true);
    assert.equal(fs.existsSync(reasonPath), true);
    assert.equal(JSON.parse(fs.readFileSync(reasonPath, "utf8")).reason, "invalid_manifest");
    assert.equal(listed.quarantinedConversationGenerations.length, 1);
    assert.equal(listed.quarantinedConversationGenerations[0].reason, "invalid_manifest");
    assert.doesNotMatch(JSON.stringify(listed), /manifestRoot|backupRoot|[A-Z]:\\/);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("metadata-only recovery listing avoids content decryption while full listing still detects corruption", async () => {
  const fixture = createFixture();
  const protectKey = (value) => value;
  const sessionPath = path.join(fixture.codexDir, "sessions", "metadata-only.jsonl");
  fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
  fs.writeFileSync(sessionPath, "metadata-only fixture\n", "utf8");
  try {
    const backup = await createConversationBackup({
      codexDir: fixture.codexDir,
      backupRoot: fixture.backupRoot,
      now: () => 1_700_000_000_000,
      protectKey,
      unprotectKey: protectKey
    });
    const blobName = backup.manifest.files[0].blob;
    const blobPath = path.join(fixture.backupRoot, "codex-state", "conversations", "blobs", blobName);
    const damaged = fs.readFileSync(blobPath);
    damaged[damaged.length - 17] ^= 0xff;
    fs.writeFileSync(blobPath, damaged);

    const metadataProgress = [];
    let metadataUnprotectCalls = 0;
    const metadataOnly = await listCodexRecoveryBackups({
      backupRoot: fixture.backupRoot,
      unprotectKey: (value) => {
        metadataUnprotectCalls += 1;
        return value;
      },
      full: false,
      onProgress: (value) => metadataProgress.push(value)
    });
    assert.equal(metadataOnly.conversationGenerations.length, 1);
    assert.equal(metadataOnly.quarantinedConversationGenerations.length, 0);
    assert.equal(metadataUnprotectCalls, 0);
    assert.equal(metadataProgress.some(({ stage }) => stage === "validating_backup"), false);

    const fullProgress = [];
    const fullyValidated = await listCodexRecoveryBackups({
      backupRoot: fixture.backupRoot,
      unprotectKey: protectKey,
      full: true,
      onProgress: (value) => fullProgress.push(value)
    });
    assert.equal(fullyValidated.conversationGenerations.length, 0);
    assert.equal(fullyValidated.quarantinedConversationGenerations.length, 1);
    assert.equal(fullyValidated.quarantinedConversationGenerations[0].reason, "integrity_failure");
    assert.equal(fullProgress.some(({ stage }) => stage === "validating_backup"), true);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("revalidates a valid quarantined conversation manifest and promotes it back to active inventory", async () => {
  const fixture = createFixture();
  const protectKey = (value) => value;
  const sessionPath = path.join(fixture.codexDir, "sessions", "promote.jsonl");
  fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
  fs.writeFileSync(sessionPath, "promote fixture\n", "utf8");
  try {
    const backup = await createConversationBackup({
      codexDir: fixture.codexDir, backupRoot: fixture.backupRoot, now: () => 1_700_000_000_000,
      protectKey, unprotectKey: protectKey
    });
    const listed = await listCodexRecoveryBackups({ backupRoot: fixture.backupRoot, unprotectKey: protectKey });
    const quarantineRoot = path.join(fixture.backupRoot, "codex-state", "conversations", "quarantine");
    fs.mkdirSync(quarantineRoot, { recursive: true });
    fs.renameSync(backup.manifestPath, path.join(quarantineRoot, path.basename(backup.manifestPath)));

    const promoted = await codexStateBackup.revalidateQuarantinedConversationBackup({
      backupRoot: fixture.backupRoot,
      conversationId: listed.conversationGenerations[0].generationId,
      unprotectKey: protectKey
    });

    assert.equal(promoted.counts.active, 1);
    assert.equal(promoted.counts.archived, 0);
    assert.equal(fs.existsSync(backup.manifestPath), true);
    assert.equal(fs.existsSync(path.join(quarantineRoot, path.basename(backup.manifestPath))), false);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("lists and promotes a legacy collision-named quarantined conversation manifest", async () => {
  const fixture = createFixture();
  const protectKey = (value) => value;
  const sessionPath = path.join(fixture.codexDir, "sessions", "legacy-collision.jsonl");
  fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
  fs.writeFileSync(sessionPath, "legacy collision fixture\n", "utf8");
  try {
    const backup = await createConversationBackup({
      codexDir: fixture.codexDir, backupRoot: fixture.backupRoot, now: () => 1_700_000_000_000,
      protectKey, unprotectKey: protectKey
    });
    const quarantineRoot = path.join(fixture.backupRoot, "codex-state", "conversations", "quarantine");
    const legacyName = `${path.basename(backup.manifestPath)}-1700000000001`;
    fs.mkdirSync(quarantineRoot, { recursive: true });
    fs.renameSync(backup.manifestPath, path.join(quarantineRoot, legacyName));

    const listed = await listCodexRecoveryBackups({ backupRoot: fixture.backupRoot, unprotectKey: protectKey });
    assert.equal(listed.quarantinedConversationGenerations.length, 1);
    const promoted = await codexStateBackup.revalidateQuarantinedConversationBackup({
      backupRoot: fixture.backupRoot,
      conversationId: listed.quarantinedConversationGenerations[0].generationId,
      unprotectKey: protectKey
    });

    assert.equal(promoted.counts.active, 1);
    assert.equal(fs.existsSync(backup.manifestPath), true);
    assert.equal(fs.existsSync(path.join(quarantineRoot, legacyName)), false);
    const relisted = await listCodexRecoveryBackups({ backupRoot: fixture.backupRoot, unprotectKey: protectKey });
    assert.equal(promoted.generationId, relisted.conversationGenerations[0].generationId);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("retention keeps blobs referenced by a parseable quarantined manifest", async () => {
  const fixture = createFixture();
  const protectKey = (value) => value;
  const sessionPath = path.join(fixture.codexDir, "sessions", "retained-quarantine.jsonl");
  fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
  try {
    fs.writeFileSync(sessionPath, "quarantined version\n", "utf8");
    const first = await createConversationBackup({
      codexDir: fixture.codexDir, backupRoot: fixture.backupRoot, now: () => 1_700_000_000_000,
      protectKey, unprotectKey: protectKey
    });
    const firstBlob = first.manifest.files[0].blob;
    const quarantineRoot = path.join(fixture.backupRoot, "codex-state", "conversations", "quarantine");
    fs.mkdirSync(quarantineRoot, { recursive: true });
    const legacyName = `${path.basename(first.manifestPath)}-1700000000001`;
    fs.renameSync(first.manifestPath, path.join(quarantineRoot, legacyName));
    for (const [index, content] of ["second", "third", "fourth"].entries()) {
      fs.writeFileSync(sessionPath, `${content}\n`, "utf8");
      await createConversationBackup({
        codexDir: fixture.codexDir, backupRoot: fixture.backupRoot, now: () => 1_700_000_001_000 + index,
        protectKey, unprotectKey: protectKey
      });
    }

    assert.equal(fs.existsSync(path.join(fixture.backupRoot, "codex-state", "conversations", "blobs", firstBlob)), true);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("retention keeps all blobs when an active manifest is temporarily unreadable", async () => {
  const fixture = createFixture();
  const protectKey = (value) => value;
  const sessionPath = path.join(fixture.codexDir, "sessions", "temporarily-unreadable.jsonl");
  fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
  fs.writeFileSync(sessionPath, "first version\n", "utf8");
  const originalReadFileSync = fs.readFileSync;
  try {
    const first = await createConversationBackup({
      codexDir: fixture.codexDir, backupRoot: fixture.backupRoot, now: () => 1_700_000_000_000,
      protectKey, unprotectKey: protectKey, mode: "full"
    });
    const firstBlob = first.manifest.files[0].blob;
    const firstManifestPath = path.resolve(first.manifestPath);
    fs.readFileSync = (filePath, ...args) => {
      if (path.resolve(String(filePath)) === firstManifestPath) {
        const error = new Error("Temporary manifest read interruption");
        error.code = "EAGAIN";
        throw error;
      }
      return originalReadFileSync.call(fs, filePath, ...args);
    };
    for (const [index, content] of ["second", "third", "fourth"].entries()) {
      fs.writeFileSync(sessionPath, `${content} version\n`, "utf8");
      await createConversationBackup({
        codexDir: fixture.codexDir, backupRoot: fixture.backupRoot, now: () => 1_700_000_001_000 + index,
        protectKey, unprotectKey: protectKey, mode: "full"
      });
    }

    assert.equal(fs.existsSync(first.manifestPath), true);
    assert.equal(fs.existsSync(path.join(fixture.backupRoot, "codex-state", "conversations", "blobs", firstBlob)), true);
  } finally {
    fs.readFileSync = originalReadFileSync;
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("complete recovery pruning keeps all blobs when a quarantined manifest is temporarily unreadable", async () => {
  const fixture = createFixture();
  const protectKey = (value) => value;
  const sessionPath = path.join(fixture.codexDir, "sessions", "complete-prune.jsonl");
  fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
  fs.writeFileSync(sessionPath, "quarantined version\n", "utf8");
  const originalReadFileSync = fs.readFileSync;
  try {
    const quarantined = await createConversationBackup({
      codexDir: fixture.codexDir, backupRoot: fixture.backupRoot, now: () => 1_700_000_000_000,
      protectKey, unprotectKey: protectKey, mode: "full"
    });
    const quarantinedBlob = quarantined.manifest.files[0].blob;
    const quarantineRoot = path.join(fixture.backupRoot, "codex-state", "conversations", "quarantine");
    const quarantinedPath = path.join(quarantineRoot, path.basename(quarantined.manifestPath));
    fs.mkdirSync(quarantineRoot, { recursive: true });
    fs.renameSync(quarantined.manifestPath, quarantinedPath);
    fs.writeFileSync(sessionPath, "checkpoint version\n", "utf8");
    const checkpointStartedAt = 1_700_000_001_000;
    const checkpointId = "A".repeat(43);
    const critical = createCriticalCodexSnapshot({
      codexDir: fixture.codexDir, backupRoot: fixture.backupRoot, now: () => checkpointStartedAt, checkpointId, checkpointStartedAt
    });
    const conversations = await createConversationBackup({
      codexDir: fixture.codexDir, backupRoot: fixture.backupRoot, now: () => checkpointStartedAt,
      protectKey, unprotectKey: protectKey, checkpointId, checkpointStartedAt
    });
    const resolvedQuarantinedPath = path.resolve(quarantinedPath);
    fs.readFileSync = (filePath, ...args) => {
      if (path.resolve(String(filePath)) === resolvedQuarantinedPath) {
        const error = new Error("Temporary quarantined manifest read interruption");
        error.code = "EAGAIN";
        throw error;
      }
      return originalReadFileSync.call(fs, filePath, ...args);
    };

    createCompleteRecoveryPoint({ backupRoot: fixture.backupRoot, checkpointId, checkpointStartedAt, critical, conversations });

    assert.equal(fs.existsSync(quarantinedPath), true);
    assert.equal(fs.existsSync(path.join(fixture.backupRoot, "codex-state", "conversations", "blobs", quarantinedBlob)), true);
  } finally {
    fs.readFileSync = originalReadFileSync;
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("resolves only listed recovery IDs and rejects paths, unknown IDs, and quarantined generations", async () => {
  const fixture = createFixture();
  const protectKey = (value) => value;
  fs.mkdirSync(path.join(fixture.codexDir, "sessions"), { recursive: true });
  fs.writeFileSync(path.join(fixture.codexDir, "sessions", "rollout.jsonl"), "safe fixture", "utf8");
  try {
    const critical = createCriticalCodexSnapshot({ codexDir: fixture.codexDir, backupRoot: fixture.backupRoot, now: () => 1_700_000_000_000 });
    const conversations = await createConversationBackup({
      codexDir: fixture.codexDir,
      backupRoot: fixture.backupRoot,
      now: () => 1_700_000_001_000,
      protectKey,
      unprotectKey: protectKey
    });
    const listed = await listCodexRecoveryBackups({ backupRoot: fixture.backupRoot, unprotectKey: protectKey });
    const selection = {
      criticalId: listed.criticalGenerations[0].generationId,
      conversationId: listed.conversationGenerations[0].generationId
    };

    assert.deepEqual(
      await resolveCodexRecoverySelection({ backupRoot: fixture.backupRoot, ...selection, unprotectKey: protectKey }),
      { criticalGenerationDir: critical.generationDir, conversationManifestPath: conversations.manifestPath }
    );
    await assert.rejects(
      () => resolveCodexRecoverySelection({ backupRoot: fixture.backupRoot, criticalId: "../critical", conversationId: selection.conversationId, unprotectKey: protectKey }),
      /invalid recovery generation id/i
    );
    await assert.rejects(
      () => resolveCodexRecoverySelection({ backupRoot: fixture.backupRoot, criticalId: "A".repeat(43), conversationId: selection.conversationId, unprotectKey: protectKey }),
      /unknown or unavailable critical/i
    );

    const quarantineRoot = path.join(fixture.backupRoot, "codex-state", "quarantine");
    fs.mkdirSync(quarantineRoot, { recursive: true });
    fs.renameSync(critical.generationDir, path.join(quarantineRoot, path.basename(critical.generationDir)));
    await assert.rejects(
      () => resolveCodexRecoverySelection({ backupRoot: fixture.backupRoot, ...selection, unprotectKey: protectKey }),
      /unknown or unavailable critical/i
    );
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("daily incremental backup exits without a redundant manifest when the stable inventory is unchanged", async () => {
  const fixture = createFixture();
  const protectKey = (value) => value;
  const sessionPath = path.join(fixture.codexDir, "sessions", "incremental.jsonl");
  fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
  fs.writeFileSync(sessionPath, "stable conversation\n", "utf8");
  try {
    const first = await createConversationBackup({
      codexDir: fixture.codexDir, backupRoot: fixture.backupRoot, now: () => 1_700_000_000_000,
      protectKey, unprotectKey: protectKey, mode: "full"
    });
    const second = await createConversationBackup({
      codexDir: fixture.codexDir, backupRoot: fixture.backupRoot, now: () => 1_700_000_001_000,
      protectKey, unprotectKey: protectKey, mode: "incremental"
    });
    const manifestRoot = path.dirname(first.manifestPath);

    assert.equal(second.unchanged, true);
    assert.equal(second.manifestPath, first.manifestPath);
    assert.equal(fs.readdirSync(manifestRoot).filter((name) => name.endsWith(".json")).length, 1);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("complete recovery points are promoted only after both validated layers succeed", async () => {
  const fixture = createFixture();
  const protectKey = (value) => value;
  fs.mkdirSync(path.join(fixture.codexDir, "sessions"), { recursive: true });
  fs.writeFileSync(path.join(fixture.codexDir, "sessions", "paired.jsonl"), "paired\n", "utf8");
  try {
    const critical = createCriticalCodexSnapshot({
      codexDir: fixture.codexDir, backupRoot: fixture.backupRoot, now: () => 1_700_000_000_000,
      checkpointId: "A".repeat(43), checkpointStartedAt: 1_700_000_000_000
    });
    const conversations = await createConversationBackup({
      codexDir: fixture.codexDir, backupRoot: fixture.backupRoot, now: () => 1_700_000_002_000,
      protectKey, unprotectKey: protectKey, checkpointId: "A".repeat(43), checkpointStartedAt: 1_700_000_000_000
    });
    const point = createCompleteRecoveryPoint({
      backupRoot: fixture.backupRoot,
      checkpointId: "A".repeat(43),
      checkpointStartedAt: 1_700_000_000_000,
      critical,
      conversations
    });
    const listed = await listCodexRecoveryBackups({ backupRoot: fixture.backupRoot, unprotectKey: protectKey });
    const resolved = await resolveCompleteRecoveryPoint({
      backupRoot: fixture.backupRoot,
      recoveryPointId: point.recoveryPointId,
      unprotectKey: protectKey
    });

    assert.equal(listed.completeRecoveryPoints.length, 1);
    assert.equal(listed.completeRecoveryPoints[0].recoveryPointId, point.recoveryPointId);
    assert.equal(listed.completeRecoveryPoints[0].checkpointTime, "2023-11-14T22:13:20.000Z");
    assert.equal(listed.completeRecoveryPoints[0].criticalCapturedAt, critical.manifest.createdAt);
    assert.equal(listed.completeRecoveryPoints[0].conversationCapturedAt, conversations.manifest.createdAt);
    assert.equal(JSON.parse(fs.readFileSync(point.manifestPath, "utf8")).conversationReused, false);
    assert.deepEqual(resolved, {
      criticalGenerationDir: critical.generationDir,
      conversationManifestPath: conversations.manifestPath
    });
    assert.doesNotMatch(fs.readFileSync(point.manifestPath, "utf8"), /Private Project|private-thread|paired\.jsonl/);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("retains conversation manifests referenced by complete recovery points", async () => {
  const fixture = createFixture();
  const protectKey = (value) => value;
  fs.mkdirSync(path.join(fixture.codexDir, "sessions"), { recursive: true });
  try {
    for (const [index, letter] of ["A", "B", "C", "D"].entries()) {
      fs.writeFileSync(path.join(fixture.codexDir, "sessions", "retained.jsonl"), `version-${letter}\n`, "utf8");
      const checkpointStartedAt = 1_700_000_000_000 + index * 1_000;
      const checkpointId = letter.repeat(43);
      const critical = createCriticalCodexSnapshot({ codexDir: fixture.codexDir, backupRoot: fixture.backupRoot, now: () => checkpointStartedAt, checkpointId, checkpointStartedAt });
      const conversations = await createConversationBackup({ codexDir: fixture.codexDir, backupRoot: fixture.backupRoot, now: () => checkpointStartedAt, protectKey, unprotectKey: protectKey, checkpointId, checkpointStartedAt });
      createCompleteRecoveryPoint({ backupRoot: fixture.backupRoot, checkpointId, checkpointStartedAt, critical, conversations });
    }
    const listed = await listCodexRecoveryBackups({ backupRoot: fixture.backupRoot, unprotectKey: protectKey });
    assert.equal(listed.completeRecoveryPoints.length, 4);
    assert.equal(fs.readdirSync(path.join(fixture.backupRoot, "codex-state", "conversations", "manifests")).filter((name) => name.endsWith(".json")).length, 4);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("independent recovery resolution does not decrypt unrelated manifests", async () => {
  const fixture = createFixture();
  const protectKey = (value) => value;
  fs.mkdirSync(path.join(fixture.codexDir, "sessions"), { recursive: true });
  fs.writeFileSync(path.join(fixture.codexDir, "sessions", "one.jsonl"), "one\n", "utf8");
  try {
    const critical = createCriticalCodexSnapshot({ codexDir: fixture.codexDir, backupRoot: fixture.backupRoot, now: () => 1_700_000_000_000 });
    const first = await createConversationBackup({ codexDir: fixture.codexDir, backupRoot: fixture.backupRoot, now: () => 1_700_000_000_000, protectKey, unprotectKey: protectKey });
    fs.writeFileSync(path.join(fixture.codexDir, "sessions", "one.jsonl"), "two\n", "utf8");
    const second = await createConversationBackup({ codexDir: fixture.codexDir, backupRoot: fixture.backupRoot, now: () => 1_700_000_001_000, protectKey, unprotectKey: protectKey });
    const listed = await listCodexRecoveryBackups({ backupRoot: fixture.backupRoot, unprotectKey: protectKey });
    const selectedCritical = listed.criticalGenerations[0];
    const selected = listed.conversationGenerations.find((item) => item.backupTime === second.manifest.createdAt);
    assert.ok(selectedCritical && selected);
    const resolved = await resolveCodexRecoverySelection({ backupRoot: fixture.backupRoot, criticalId: selectedCritical.generationId, conversationId: selected.generationId, unprotectKey: () => { throw new Error("unexpected decrypt"); } });
    assert.deepEqual(resolved, { criticalGenerationDir: critical.generationDir, conversationManifestPath: second.manifestPath });
    assert.equal(fs.existsSync(first.manifestPath), true);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("mismatched checkpoint layers leave no promoted complete recovery point", async () => {
  const fixture = createFixture();
  const protectKey = (value) => value;
  fs.mkdirSync(path.join(fixture.codexDir, "sessions"), { recursive: true });
  fs.writeFileSync(path.join(fixture.codexDir, "sessions", "mismatch.jsonl"), "mismatch\n", "utf8");
  try {
    const critical = createCriticalCodexSnapshot({
      codexDir: fixture.codexDir, backupRoot: fixture.backupRoot, now: () => 1_700_000_000_000,
      checkpointId: "A".repeat(43), checkpointStartedAt: 1_700_000_000_000
    });
    const conversations = await createConversationBackup({
      codexDir: fixture.codexDir, backupRoot: fixture.backupRoot, now: () => 1_700_000_001_000,
      protectKey, unprotectKey: protectKey, checkpointId: "B".repeat(43), checkpointStartedAt: 1_700_000_000_000
    });

    assert.throws(() => createCompleteRecoveryPoint({
      backupRoot: fixture.backupRoot,
      checkpointId: "A".repeat(43),
      checkpointStartedAt: 1_700_000_000_000,
      critical,
      conversations
    }), /checkpoint/i);
    const root = path.join(fixture.backupRoot, "codex-state", "checkpoints");
    assert.equal(fs.existsSync(root) ? fs.readdirSync(root).length : 0, 0);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("unchanged incremental layers record an explicit reusable conversation binding", async () => {
  const fixture = createFixture();
  const protectKey = (value) => value;
  const checkpointId = "U".repeat(43);
  const checkpointStartedAt = 1_700_000_001_000;
  fs.mkdirSync(path.join(fixture.codexDir, "sessions"), { recursive: true });
  fs.writeFileSync(path.join(fixture.codexDir, "sessions", "stable.jsonl"), "stable\n", "utf8");
  try {
    await createConversationBackup({ codexDir: fixture.codexDir, backupRoot: fixture.backupRoot, now: () => 1_700_000_000_000, protectKey, unprotectKey: protectKey });
    const conversations = await createConversationBackup({ codexDir: fixture.codexDir, backupRoot: fixture.backupRoot, now: () => checkpointStartedAt, protectKey, unprotectKey: protectKey, mode: "incremental", checkpointId, checkpointStartedAt });
    const critical = createCriticalCodexSnapshot({ codexDir: fixture.codexDir, backupRoot: fixture.backupRoot, now: () => checkpointStartedAt, checkpointId, checkpointStartedAt });
    const point = createCompleteRecoveryPoint({ backupRoot: fixture.backupRoot, checkpointId, checkpointStartedAt, critical, conversations });

    assert.equal(conversations.unchanged, true);
    assert.equal(point.manifest.conversationReused, true);
    assert.deepEqual(await resolveCompleteRecoveryPoint({ backupRoot: fixture.backupRoot, recoveryPointId: checkpointId, unprotectKey: protectKey }), {
      criticalGenerationDir: critical.generationDir,
      conversationManifestPath: conversations.manifestPath
    });
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("complete recovery resolution rejects changed child capture metadata", async () => {
  const fixture = createFixture();
  const protectKey = (value) => value;
  const checkpointId = "T".repeat(43);
  const checkpointStartedAt = 1_700_000_000_000;
  fs.mkdirSync(path.join(fixture.codexDir, "sessions"), { recursive: true });
  fs.writeFileSync(path.join(fixture.codexDir, "sessions", "bound.jsonl"), "bound\n", "utf8");
  try {
    const critical = createCriticalCodexSnapshot({ codexDir: fixture.codexDir, backupRoot: fixture.backupRoot, now: () => checkpointStartedAt, checkpointId, checkpointStartedAt });
    const conversations = await createConversationBackup({ codexDir: fixture.codexDir, backupRoot: fixture.backupRoot, now: () => checkpointStartedAt, protectKey, unprotectKey: protectKey, checkpointId, checkpointStartedAt });
    createCompleteRecoveryPoint({ backupRoot: fixture.backupRoot, checkpointId, checkpointStartedAt, critical, conversations });
    const manifest = JSON.parse(fs.readFileSync(conversations.manifestPath, "utf8"));
    manifest.createdAt = new Date(checkpointStartedAt + 1_000).toISOString();
    fs.writeFileSync(conversations.manifestPath, JSON.stringify(manifest), "utf8");

    await assert.rejects(
      () => resolveCompleteRecoveryPoint({ backupRoot: fixture.backupRoot, recoveryPointId: checkpointId, unprotectKey: protectKey }),
      /binding mismatch/i
    );
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("default merge restores missing state while preserving live conflicts", { skip: process.platform !== "win32" }, async () => {
  const fixture = createFixture();
  const activePath = path.join(fixture.codexDir, "sessions", "rollout-active.jsonl");
  const archivedPath = path.join(fixture.codexDir, "archived_sessions", "rollout-archived.jsonl");
  fs.mkdirSync(path.dirname(activePath), { recursive: true });
  fs.mkdirSync(path.dirname(archivedPath), { recursive: true });
  fs.writeFileSync(activePath, "backup active", "utf8");
  fs.writeFileSync(archivedPath, "backup archived", "utf8");
  try {
    const critical = createCriticalCodexSnapshot({ codexDir: fixture.codexDir, backupRoot: fixture.backupRoot, now: () => 1_700_000_000_000 });
    const conversations = await createConversationBackup({ codexDir: fixture.codexDir, backupRoot: fixture.backupRoot, now: () => 1_700_000_000_000 });
    fs.writeFileSync(
      path.join(fixture.codexDir, ".codex-global-state.json"),
      JSON.stringify({
        "local-projects": { "D:\\Private Project": { name: "Private Project" } },
        "project-order": ["D:\\Private Project"],
        "project-writable-roots": { "D:\\Private Project": ["D:\\Newer Root"] },
        "thread-workspace-root-hints": {},
        "thread-project-assignments": {},
        "electron-saved-workspace-roots": ["D:\\Private Project"],
        "electron-persisted-atom-state": {
          "flat-project-sidebar-preferences-v1": { sortMode: "recent" },
          "sidebar-collapsed-sections-v1": { projects: false }
        }
      }),
      "utf8"
    );
    fs.writeFileSync(activePath, "newer live active", "utf8");
    fs.rmSync(archivedPath);
    const authorization = { authorized: true, mode: "merge" };

    const result = await restoreCodexBackup({ authorization, criticalGenerationDir: critical.generationDir, conversationManifestPath: conversations.manifestPath, liveCodexDir: fixture.codexDir });
    const globalState = JSON.parse(fs.readFileSync(path.join(fixture.codexDir, ".codex-global-state.json"), "utf8"));
    assert.deepEqual(globalState["project-writable-roots"]["D:\\Private Project"], ["D:\\Newer Root"]);
    assert.equal(globalState["thread-project-assignments"]["private-thread"], "D:\\Private Project");
    assert.equal(fs.readFileSync(activePath, "utf8"), "newer live active");
    assert.equal(fs.readFileSync(archivedPath, "utf8"), "backup archived");
    assert.deepEqual(result, { mode: "merge", restoredMetadata: 2, restoredConversationFiles: 1, preservedConflicts: 2 });
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("merge limits global state to previewed fields and reports same-ID SQLite conflicts", { skip: process.platform !== "win32" }, async () => {
  const fixture = createFixture();
  try {
    const backupGlobalPath = path.join(fixture.codexDir, ".codex-global-state.json");
    const backupGlobal = JSON.parse(fs.readFileSync(backupGlobalPath, "utf8"));
    backupGlobal["unpreviewed-private-root"] = { value: "must-not-merge" };
    fs.writeFileSync(backupGlobalPath, JSON.stringify(backupGlobal), "utf8");
    const critical = createCriticalCodexSnapshot({ codexDir: fixture.codexDir, backupRoot: fixture.backupRoot });
    const conversations = await createConversationBackup({ codexDir: fixture.codexDir, backupRoot: fixture.backupRoot });
    const liveGlobal = JSON.parse(fs.readFileSync(backupGlobalPath, "utf8"));
    delete liveGlobal["unpreviewed-private-root"];
    fs.writeFileSync(backupGlobalPath, JSON.stringify(liveGlobal), "utf8");
    const database = new DatabaseSync(path.join(fixture.codexDir, "state_5.sqlite"));
    database.prepare("UPDATE threads SET rollout_path = ?, archived = ? WHERE id = ?").run("newer-live", 0, "private-thread");
    database.close();

    const preview = await previewCodexRecovery({ criticalGenerationDir: critical.generationDir, conversationManifestPath: conversations.manifestPath, liveCodexDir: fixture.codexDir });
    assert.equal(preview.effects.conflicts, 1);
    const result = await restoreCodexBackup({ authorization: { authorized: true, mode: "merge" }, criticalGenerationDir: critical.generationDir, conversationManifestPath: conversations.manifestPath, liveCodexDir: fixture.codexDir });
    assert.equal(result.preservedConflicts, 1);
    assert.equal("unpreviewed-private-root" in JSON.parse(fs.readFileSync(backupGlobalPath, "utf8")), false);
    const restored = new DatabaseSync(path.join(fixture.codexDir, "state_5.sqlite"), { readOnly: true });
    assert.equal(restored.prepare("SELECT rollout_path FROM threads WHERE id = ?").get("private-thread").rollout_path, "newer-live");
    restored.close();
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("preview and merge share recursive nested global missing and conflict counts", { skip: process.platform !== "win32" }, async () => {
  const fixture = createFixture();
  try {
    const globalPath = path.join(fixture.codexDir, ".codex-global-state.json");
    const backupGlobal = JSON.parse(fs.readFileSync(globalPath, "utf8"));
    backupGlobal["local-projects"]["D:\\Private Project"].settings = { missing: "restore", conflict: "backup" };
    fs.writeFileSync(globalPath, JSON.stringify(backupGlobal), "utf8");
    const critical = createCriticalCodexSnapshot({ codexDir: fixture.codexDir, backupRoot: fixture.backupRoot });
    const conversations = await createConversationBackup({ codexDir: fixture.codexDir, backupRoot: fixture.backupRoot });
    const liveGlobal = JSON.parse(fs.readFileSync(globalPath, "utf8"));
    liveGlobal["local-projects"]["D:\\Private Project"].settings = { conflict: "live" };
    fs.writeFileSync(globalPath, JSON.stringify(liveGlobal), "utf8");

    const preview = await previewCodexRecovery({ criticalGenerationDir: critical.generationDir, conversationManifestPath: conversations.manifestPath, liveCodexDir: fixture.codexDir });
    assert.deepEqual(preview.effects, { missing: 1, conflicts: 1 });
    const result = await restoreCodexBackup({ authorization: { authorized: true, mode: "merge" }, criticalGenerationDir: critical.generationDir, conversationManifestPath: conversations.manifestPath, liveCodexDir: fixture.codexDir });
    assert.equal(result.restoredMetadata, 1);
    assert.equal(result.preservedConflicts, 1);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("preview and merge preserve live rows on analyzable non-primary unique SQLite conflicts", { skip: process.platform !== "win32" }, async () => {
  const fixture = createFixture();
  try {
    const databasePath = path.join(fixture.codexDir, "state_5.sqlite");
    let database = new DatabaseSync(databasePath);
    database.exec("CREATE UNIQUE INDEX threads_rollout_unique ON threads(rollout_path)");
    database.prepare("INSERT INTO threads (id, rollout_path, archived) VALUES (?, ?, ?)").run("backup-only", "duplicate-rollout", 0);
    database.close();
    const critical = createCriticalCodexSnapshot({ codexDir: fixture.codexDir, backupRoot: fixture.backupRoot });
    const conversations = await createConversationBackup({ codexDir: fixture.codexDir, backupRoot: fixture.backupRoot });
    database = new DatabaseSync(databasePath);
    database.prepare("DELETE FROM threads WHERE id = ?").run("backup-only");
    database.prepare("INSERT INTO threads (id, rollout_path, archived) VALUES (?, ?, ?)").run("live-only", "duplicate-rollout", 0);
    database.close();

    const preview = await previewCodexRecovery({ criticalGenerationDir: critical.generationDir, conversationManifestPath: conversations.manifestPath, liveCodexDir: fixture.codexDir });
    assert.deepEqual(preview.effects, { missing: 0, conflicts: 1 });
    const result = await restoreCodexBackup({ authorization: { authorized: true, mode: "merge" }, criticalGenerationDir: critical.generationDir, conversationManifestPath: conversations.manifestPath, liveCodexDir: fixture.codexDir });
    assert.equal(result.preservedConflicts, 1);
    database = new DatabaseSync(databasePath, { readOnly: true });
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM threads WHERE id = ?").get("backup-only").count, 0);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM threads WHERE id = ?").get("live-only").count, 1);
    database.close();
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

for (const { collation, backupValue, liveValue } of [
  { collation: "NOCASE", backupValue: "CaseValue", liveValue: "casevalue" },
  { collation: "RTRIM", backupValue: "trail", liveValue: "trail   " }
]) {
  test(`preview and merge honor ${collation} unique SQLite conflicts`, { skip: process.platform !== "win32" }, async () => {
    const fixture = createFixture();
    try {
      const databasePath = path.join(fixture.codexDir, "state_5.sqlite");
      let database = new DatabaseSync(databasePath);
      database.exec(`CREATE UNIQUE INDEX threads_rollout_unique ON threads(rollout_path COLLATE ${collation})`);
      database.prepare("INSERT INTO threads (id, rollout_path, archived) VALUES (?, ?, ?)").run("backup-only", backupValue, 0);
      database.close();
      const critical = createCriticalCodexSnapshot({ codexDir: fixture.codexDir, backupRoot: fixture.backupRoot });
      const conversations = await createConversationBackup({ codexDir: fixture.codexDir, backupRoot: fixture.backupRoot });
      database = new DatabaseSync(databasePath);
      database.prepare("DELETE FROM threads WHERE id = ?").run("backup-only");
      database.prepare("INSERT INTO threads (id, rollout_path, archived) VALUES (?, ?, ?)").run("live-only", liveValue, 0);
      database.close();

      const preview = await previewCodexRecovery({ criticalGenerationDir: critical.generationDir, conversationManifestPath: conversations.manifestPath, liveCodexDir: fixture.codexDir });
      assert.deepEqual(preview.effects, { missing: 0, conflicts: 1 });
      const result = await restoreCodexBackup({ authorization: { authorized: true, mode: "merge" }, criticalGenerationDir: critical.generationDir, conversationManifestPath: conversations.manifestPath, liveCodexDir: fixture.codexDir });
      assert.equal(result.preservedConflicts, 1);
      database = new DatabaseSync(databasePath, { readOnly: true });
      assert.equal(database.prepare("SELECT COUNT(*) AS count FROM threads WHERE id = ?").get("backup-only").count, 0);
      assert.equal(database.prepare("SELECT COUNT(*) AS count FROM threads WHERE id = ?").get("live-only").count, 1);
      database.close();
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });
}

test("replacement restore exactly swaps validated critical and conversation state", { skip: process.platform !== "win32" }, async () => {
  const fixture = createFixture();
  const activeRoot = path.join(fixture.codexDir, "sessions");
  const activePath = path.join(activeRoot, "selected.jsonl");
  fs.mkdirSync(activeRoot, { recursive: true });
  fs.writeFileSync(activePath, "selected backup", "utf8");
  try {
    const critical = createCriticalCodexSnapshot({ codexDir: fixture.codexDir, backupRoot: fixture.backupRoot, now: () => 1_700_000_000_000 });
    const conversations = await createConversationBackup({ codexDir: fixture.codexDir, backupRoot: fixture.backupRoot, now: () => 1_700_000_000_000 });
    fs.writeFileSync(path.join(fixture.codexDir, ".codex-global-state.json"), JSON.stringify(currentGlobalStateFixture()), "utf8");
    fs.writeFileSync(activePath, "newer live", "utf8");
    fs.writeFileSync(path.join(activeRoot, "extra.jsonl"), "remove me", "utf8");
    const database = new DatabaseSync(path.join(fixture.codexDir, "state_5.sqlite"));
    database.prepare("INSERT INTO threads (id, rollout_path, archived) VALUES (?, ?, ?)").run("extra-thread", "extra", 0);
    database.close();

    const result = await restoreCodexBackup({
      authorization: { authorized: true, mode: "replace" },
      criticalGenerationDir: critical.generationDir,
      conversationManifestPath: conversations.manifestPath,
      liveCodexDir: fixture.codexDir
    });

    assert.equal(result.mode, "replace");
    assert.equal(fs.readFileSync(activePath, "utf8"), "selected backup");
    assert.equal(fs.existsSync(path.join(activeRoot, "extra.jsonl")), false);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(fixture.codexDir, ".codex-global-state.json"), "utf8"))["project-order"], ["D:\\Private Project"]);
    const restored = new DatabaseSync(path.join(fixture.codexDir, "state_5.sqlite"), { readOnly: true });
    const restoredIds = restored.prepare("SELECT id FROM threads ORDER BY id").all().map((row) => row.id);
    restored.close();
    assert.deepEqual(restoredIds, ["private-thread"]);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("replacement restore rolls back every durable target after a mid-commit failure", { skip: process.platform !== "win32" }, async () => {
  const fixture = createFixture();
  const globalPath = path.join(fixture.codexDir, ".codex-global-state.json");
  const indexPath = path.join(fixture.codexDir, "session_index.jsonl");
  const databasePath = path.join(fixture.codexDir, "state_5.sqlite");
  const activePath = path.join(fixture.codexDir, "sessions", "selected.jsonl");
  fs.mkdirSync(path.dirname(activePath), { recursive: true });
  fs.writeFileSync(activePath, "selected backup", "utf8");
  try {
    const critical = createCriticalCodexSnapshot({ codexDir: fixture.codexDir, backupRoot: fixture.backupRoot });
    const conversations = await createConversationBackup({ codexDir: fixture.codexDir, backupRoot: fixture.backupRoot });
    fs.writeFileSync(globalPath, JSON.stringify(currentGlobalStateFixture()), "utf8");
    fs.writeFileSync(indexPath, `${JSON.stringify({ id: "live-only" })}\n`, "utf8");
    fs.writeFileSync(activePath, "newer live", "utf8");
    fs.writeFileSync(path.join(path.dirname(activePath), "extra.jsonl"), "keep on rollback", "utf8");
    const before = new Map([globalPath, indexPath, databasePath, activePath, path.join(path.dirname(activePath), "extra.jsonl")].map((filePath) => [filePath, fs.readFileSync(filePath)]));
    const renameSync = fs.renameSync;
    let injected = false;
    fs.renameSync = (source, destination) => {
      if (!injected && path.resolve(destination) === path.resolve(indexPath)) {
        injected = true;
        throw new Error("simulated replacement failure");
      }
      return renameSync(source, destination);
    };
    try {
      await assert.rejects(
        () => restoreCodexBackup({
          authorization: { authorized: true, mode: "replace" },
          criticalGenerationDir: critical.generationDir,
          conversationManifestPath: conversations.manifestPath,
          liveCodexDir: fixture.codexDir
        }),
        /simulated replacement failure/
      );
    } finally {
      fs.renameSync = renameSync;
    }
    assert.equal(injected, true);
    for (const [filePath, bytes] of before) assert.deepEqual(fs.readFileSync(filePath), bytes);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("replacement restore runs the final safety gate after staging and before live commit", { skip: process.platform !== "win32" }, async () => {
  const fixture = createFixture();
  try {
    fs.mkdirSync(path.join(fixture.codexDir, "sessions"), { recursive: true });
    fs.writeFileSync(path.join(fixture.codexDir, "sessions", "selected.jsonl"), "backup", "utf8");
    const critical = createCriticalCodexSnapshot({ codexDir: fixture.codexDir, backupRoot: fixture.backupRoot });
    const conversations = await createConversationBackup({ codexDir: fixture.codexDir, backupRoot: fixture.backupRoot });
    const globalPath = path.join(fixture.codexDir, ".codex-global-state.json");
    fs.writeFileSync(globalPath, JSON.stringify(currentGlobalStateFixture()), "utf8");
    const before = fs.readFileSync(globalPath);
    let checked = false;
    await assert.rejects(
      () => restoreCodexBackup({
        authorization: { authorized: true, mode: "replace" },
        criticalGenerationDir: critical.generationDir,
        conversationManifestPath: conversations.manifestPath,
        liveCodexDir: fixture.codexDir,
        assertBeforeCommit: async () => { checked = true; throw new Error("Codex restarted before commit"); }
      }),
      /restarted before commit/
    );
    assert.equal(checked, true);
    assert.deepEqual(fs.readFileSync(globalPath), before);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("content identities cover selected critical artifacts, conversation manifests, and referenced blobs", { skip: process.platform !== "win32" }, async () => {
  const fixture = createFixture();
  const sessionPath = path.join(fixture.codexDir, "sessions", "selected.jsonl");
  fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
  fs.writeFileSync(sessionPath, "selected content", "utf8");
  try {
    const critical = createCriticalCodexSnapshot({ codexDir: fixture.codexDir, backupRoot: fixture.backupRoot });
    const conversations = await createConversationBackup({ codexDir: fixture.codexDir, backupRoot: fixture.backupRoot });
    const sources = { criticalGenerationDir: critical.generationDir, conversationManifestPath: conversations.manifestPath };
    const originalIdentity = await codexStateBackup.recoverySelectionContentIdentity(sources);

    const manifest = JSON.parse(fs.readFileSync(conversations.manifestPath, "utf8"));
    manifest.createdAt = "2020-01-01T00:00:00.000Z";
    fs.writeFileSync(conversations.manifestPath, JSON.stringify(manifest), "utf8");
    assert.notEqual(await codexStateBackup.recoverySelectionContentIdentity(sources), originalIdentity);

    const blobPath = path.join(fixture.backupRoot, "codex-state", "conversations", "blobs", manifest.files[0].blob);
    const blob = fs.readFileSync(blobPath);
    blob[blob.length - 1] ^= 1;
    fs.writeFileSync(blobPath, blob);
    await assert.rejects(() => codexStateBackup.recoverySelectionContentIdentity(sources), /auth|hash|conversation|decrypt/i);

    const criticalArtifact = path.join(critical.generationDir, ".codex-global-state.json");
    fs.writeFileSync(criticalArtifact, Buffer.alloc(fs.statSync(criticalArtifact).size, 1));
    assert.throws(() => codexStateBackup.criticalSnapshotContentIdentity(critical.generationDir), /critical|json|hash/i);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("live content identity covers critical state and sorted active and archived sessions", async () => {
  const fixture = createFixture();
  const activePath = path.join(fixture.codexDir, "sessions", "active.jsonl");
  const archivedPath = path.join(fixture.codexDir, "archived_sessions", "archived.jsonl");
  fs.mkdirSync(path.dirname(activePath), { recursive: true });
  fs.mkdirSync(path.dirname(archivedPath), { recursive: true });
  fs.writeFileSync(activePath, "active one", "utf8");
  fs.writeFileSync(archivedPath, "archived one", "utf8");
  try {
    const original = await codexStateBackup.codexLiveContentIdentity(fixture.codexDir);
    fs.writeFileSync(activePath, "active two", "utf8");
    const modified = await codexStateBackup.codexLiveContentIdentity(fixture.codexDir);
    assert.notEqual(modified, original);
    fs.writeFileSync(path.join(fixture.codexDir, "sessions", "added.jsonl"), "added", "utf8");
    assert.notEqual(await codexStateBackup.codexLiveContentIdentity(fixture.codexDir), modified);
    fs.rmSync(archivedPath);
    assert.notEqual(await codexStateBackup.codexLiveContentIdentity(fixture.codexDir), modified);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("live identity streams large sessions without blocking the event loop", async () => {
  const fixture = createFixture();
  const sessionPath = path.join(fixture.codexDir, "sessions", "large.jsonl");
  fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
  fs.writeFileSync(sessionPath, Buffer.alloc(16 * 1024 * 1024, 7));
  try {
    let timerFired = false;
    const identityPromise = codexStateBackup.codexLiveContentIdentity(fixture.codexDir);
    setTimeout(() => { timerFired = true; }, 0);
    await identityPromise;
    assert.equal(timerFired, true);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("live identity rejects an early file changed while a later file is hashing", async () => {
  const fixture = createFixture();
  const firstPath = path.join(fixture.codexDir, "sessions", "a-first.jsonl");
  const laterPath = path.join(fixture.codexDir, "sessions", "z-later.jsonl");
  fs.mkdirSync(path.dirname(firstPath), { recursive: true });
  fs.writeFileSync(firstPath, "first", "utf8");
  fs.writeFileSync(laterPath, Buffer.alloc(8 * 1024 * 1024, 9));
  const createReadStream = fs.createReadStream;
  let changed = false;
  fs.createReadStream = (filePath, ...args) => {
    if (!changed && path.resolve(filePath) === path.resolve(laterPath)) {
      changed = true;
      fs.writeFileSync(firstPath, "changed after first hash", "utf8");
    }
    return createReadStream(filePath, ...args);
  };
  try {
    await assert.rejects(() => codexStateBackup.codexLiveContentIdentity(fixture.codexDir), /changed/i);
    assert.equal(changed, true);
  } finally {
    fs.createReadStream = createReadStream;
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("merge restore rejects missing live artifacts before mutating live state", { skip: process.platform !== "win32" }, async () => {
  const fixture = createFixture();
  const globalPath = path.join(fixture.codexDir, ".codex-global-state.json");
  try {
    const critical = createCriticalCodexSnapshot({ codexDir: fixture.codexDir, backupRoot: fixture.backupRoot });
    fs.mkdirSync(path.join(fixture.codexDir, "sessions"), { recursive: true });
    fs.writeFileSync(path.join(fixture.codexDir, "sessions", "rollout.jsonl"), "backup", "utf8");
    const conversations = await createConversationBackup({ codexDir: fixture.codexDir, backupRoot: fixture.backupRoot });
    const before = fs.readFileSync(globalPath);
    fs.rmSync(path.join(fixture.codexDir, "session_index.jsonl"));

    await assert.rejects(
      () => restoreCodexBackup({
        authorization: { authorized: true, mode: "merge" },
        criticalGenerationDir: critical.generationDir,
        conversationManifestPath: conversations.manifestPath,
        liveCodexDir: fixture.codexDir
      }),
      /missing live.*session_index/i
    );
    assert.deepEqual(fs.readFileSync(globalPath), before);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("merge restore rejects a conversation target beneath a symlink or junction", async (t) => {
  const fixture = createFixture();
  const archivedPath = path.join(fixture.codexDir, "archived_sessions", "linked", "rollout.jsonl");
  const outsideRoot = path.join(fixture.root, "outside");
  fs.mkdirSync(path.dirname(archivedPath), { recursive: true });
  fs.writeFileSync(archivedPath, "backup archived", "utf8");
  try {
    const critical = createCriticalCodexSnapshot({ codexDir: fixture.codexDir, backupRoot: fixture.backupRoot });
    const conversations = await createConversationBackup({
      codexDir: fixture.codexDir,
      backupRoot: fixture.backupRoot,
      protectKey: (value) => value,
      unprotectKey: (value) => value
    });
    fs.rmSync(path.join(fixture.codexDir, "archived_sessions"), { recursive: true, force: true });
    fs.mkdirSync(path.join(fixture.codexDir, "archived_sessions"), { recursive: true });
    fs.mkdirSync(outsideRoot);
    try {
      fs.symlinkSync(outsideRoot, path.join(fixture.codexDir, "archived_sessions", "linked"), process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      if (["EPERM", "EACCES", "ENOTSUP"].includes(error.code)) {
        t.skip(`link fixture unavailable: ${error.code}`);
        return;
      }
      throw error;
    }

    await assert.rejects(
      () => restoreCodexBackup({
        authorization: { authorized: true, mode: "merge" },
        criticalGenerationDir: critical.generationDir,
        conversationManifestPath: conversations.manifestPath,
        liveCodexDir: fixture.codexDir,
        unprotectKey: (value) => value
      }),
      /symbolic link|junction|reparse/i
    );
    assert.equal(fs.existsSync(path.join(outsideRoot, "rollout.jsonl")), false);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("merge restore rechecks conversation paths immediately before commit", async (t) => {
  const fixture = createFixture();
  const archivedRoot = path.join(fixture.codexDir, "archived_sessions");
  const archivedPath = path.join(archivedRoot, "rollout.jsonl");
  const outsideRoot = path.join(fixture.root, "outside-commit");
  fs.mkdirSync(archivedRoot, { recursive: true });
  fs.writeFileSync(archivedPath, "backup archived", "utf8");
  try {
    const critical = createCriticalCodexSnapshot({ codexDir: fixture.codexDir, backupRoot: fixture.backupRoot });
    const conversations = await createConversationBackup({
      codexDir: fixture.codexDir,
      backupRoot: fixture.backupRoot,
      protectKey: (value) => value,
      unprotectKey: (value) => value
    });
    fs.rmSync(archivedRoot, { recursive: true, force: true });
    fs.mkdirSync(archivedRoot);
    fs.mkdirSync(outsideRoot);
    const probe = path.join(fixture.root, "link-probe");
    try {
      fs.symlinkSync(outsideRoot, probe, process.platform === "win32" ? "junction" : "dir");
      fs.rmSync(probe, { recursive: true, force: true });
    } catch (error) {
      if (["EPERM", "EACCES", "ENOTSUP"].includes(error.code)) {
        t.skip(`link fixture unavailable: ${error.code}`);
        return;
      }
      throw error;
    }

    const globalPath = path.join(fixture.codexDir, ".codex-global-state.json");
    const renameSync = fs.renameSync;
    let injected = false;
    fs.renameSync = (source, destination) => {
      const result = renameSync(source, destination);
      if (!injected && path.resolve(destination) === path.resolve(globalPath)) {
        injected = true;
        fs.rmSync(archivedRoot, { recursive: true, force: true });
        fs.symlinkSync(outsideRoot, archivedRoot, process.platform === "win32" ? "junction" : "dir");
      }
      return result;
    };
    try {
      await assert.rejects(
        () => restoreCodexBackup({
          authorization: { authorized: true, mode: "merge" },
          criticalGenerationDir: critical.generationDir,
          conversationManifestPath: conversations.manifestPath,
          liveCodexDir: fixture.codexDir,
          unprotectKey: (value) => value
        }),
        /symbolic link|junction|reparse/i
      );
    } finally {
      fs.renameSync = renameSync;
    }
    assert.equal(injected, true);
    assert.equal(fs.existsSync(path.join(outsideRoot, "rollout.jsonl")), false);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("merge restore rolls back every live artifact when commit fails midway", { skip: process.platform !== "win32" }, async () => {
  const fixture = createFixture();
  const globalPath = path.join(fixture.codexDir, ".codex-global-state.json");
  const indexPath = path.join(fixture.codexDir, "session_index.jsonl");
  const databasePath = path.join(fixture.codexDir, "state_5.sqlite");
  const archivedPath = path.join(fixture.codexDir, "archived_sessions", "rollout.jsonl");
  try {
    fs.mkdirSync(path.dirname(archivedPath), { recursive: true });
    fs.writeFileSync(archivedPath, "backup archived", "utf8");
    const critical = createCriticalCodexSnapshot({ codexDir: fixture.codexDir, backupRoot: fixture.backupRoot });
    const conversations = await createConversationBackup({ codexDir: fixture.codexDir, backupRoot: fixture.backupRoot });
    fs.rmSync(archivedPath);
    const liveGlobal = JSON.parse(fs.readFileSync(globalPath, "utf8"));
    liveGlobal["thread-project-assignments"] = {};
    fs.writeFileSync(globalPath, JSON.stringify(liveGlobal), "utf8");
    fs.writeFileSync(indexPath, "", "utf8");
    const before = new Map([globalPath, indexPath, databasePath].map((filePath) => [filePath, fs.readFileSync(filePath)]));

    const renameSync = fs.renameSync;
    fs.renameSync = (source, destination) => {
      if (path.resolve(destination) === path.resolve(indexPath)) throw new Error("simulated mid-restore failure");
      return renameSync(source, destination);
    };
    try {
      await assert.rejects(
        () => restoreCodexBackup({
          authorization: { authorized: true, mode: "merge" },
          criticalGenerationDir: critical.generationDir,
          conversationManifestPath: conversations.manifestPath,
          liveCodexDir: fixture.codexDir
        }),
        /simulated mid-restore failure/
      );
    } finally {
      fs.renameSync = renameSync;
    }

    for (const [filePath, bytes] of before) assert.deepEqual(fs.readFileSync(filePath), bytes);
    assert.equal(fs.existsSync(archivedPath), false);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("classifies and safely migrates legacy global-state recovery files without touching invalid sources", { skip: process.platform !== "win32" }, async () => {
  const fixture = createFixture();
  const legacyRoot = path.join(fixture.root, "legacy-c");
  fs.mkdirSync(legacyRoot);
  const complete = path.join(legacyRoot, ".codex-global-state.20260713.json");
  const duplicate = path.join(legacyRoot, ".codex-global-state.backup-duplicate.json");
  const incomplete = path.join(legacyRoot, ".codex-global-state.recovery-incomplete.json");
  const invalid = path.join(legacyRoot, ".codex-global-state.recovery-invalid.json");
  const completeText = JSON.stringify({
    "local-projects": {}, "project-order": [], "project-writable-roots": {}, "thread-workspace-root-hints": {},
    "thread-project-assignments": {}, "electron-saved-workspace-roots": [], "electron-persisted-atom-state": {}
  });
  fs.writeFileSync(complete, completeText, "utf8");
  fs.writeFileSync(duplicate, completeText, "utf8");
  fs.writeFileSync(incomplete, JSON.stringify({ "local-projects": {} }), "utf8");
  fs.writeFileSync(invalid, Buffer.alloc(32));
  try {
    assert.deepEqual(inventoryLegacyCodexRecoveryFiles(legacyRoot).map((item) => item.classification).sort(), ["complete", "duplicate", "incomplete", "invalid"]);
    const result = await migrateLegacyCodexRecoveryFiles({ legacyRoot, backupRoot: fixture.backupRoot, removeSource: true, now: () => 1_700_000_000_000 });
    const manifestText = fs.readFileSync(result.manifestPath, "utf8");
    assert.equal(fs.existsSync(complete), false);
    assert.equal(fs.existsSync(duplicate), false);
    assert.equal(fs.existsSync(incomplete), false);
    assert.equal(fs.existsSync(invalid), true);
    assert.equal(manifestText.includes("recovery-incomplete"), false);
    assert.equal(result.manifest.entries.filter((entry) => entry.promotable).length, 1);
    assert.equal(result.manifest.entries.filter((entry) => !entry.promotable).length, 2);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("does not classify wrong-typed legacy fields as a complete Codex global-state schema", () => {
  const fixture = createFixture();
  const legacyRoot = path.join(fixture.root, "legacy-c");
  fs.mkdirSync(legacyRoot);
  fs.writeFileSync(path.join(legacyRoot, ".codex-global-state.wrong-types.json"), JSON.stringify({
    "local-projects": [], "project-order": {}, "project-writable-roots": [], "thread-workspace-root-hints": [],
    "thread-project-assignments": [], "electron-saved-workspace-roots": {}, "electron-persisted-atom-state": []
  }), "utf8");
  try {
    assert.equal(inventoryLegacyCodexRecoveryFiles(legacyRoot)[0].classification, "incomplete");
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("legacy migration keeps every source when any protected source path is unreadable", { skip: process.platform !== "win32" }, async () => {
  const fixture = createFixture();
  const legacyRoot = path.join(fixture.root, "legacy-c");
  fs.mkdirSync(legacyRoot);
  const sources = ["one", "two"].map((suffix) => path.join(legacyRoot, `.codex-global-state.${suffix}.json`));
  const state = JSON.stringify({
    "local-projects": {}, "project-order": [], "project-writable-roots": {}, "thread-workspace-root-hints": {},
    "thread-project-assignments": {}, "electron-saved-workspace-roots": [], "electron-persisted-atom-state": {}
  });
  sources.forEach((source, index) => fs.writeFileSync(source, `${state}${index ? " " : ""}`, "utf8"));
  try {
    const { protectString } = await import("../src/core/dpapi.js");
    await assert.rejects(
      () => migrateLegacyCodexRecoveryFiles({
        legacyRoot,
        backupRoot: fixture.backupRoot,
        removeSource: true,
        protectKey: (value) => value.startsWith(".codex-global-state") ? "not-dpapi" : protectString(value)
      }),
      /source|dpapi|decrypt|data/i
    );
    assert.equal(sources.every((source) => fs.existsSync(source)), true);
    const migrationRoot = path.join(fixture.backupRoot, "codex-state", "legacy-global-state");
    assert.equal(fs.existsSync(migrationRoot) && fs.readdirSync(migrationRoot).some((name) => name.startsWith("legacy-manifest")), false);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("failed legacy migration never removes an existing valid manifest with the same timestamp", { skip: process.platform !== "win32" }, async () => {
  const fixture = createFixture();
  const legacyRoot = path.join(fixture.root, "legacy-c");
  fs.mkdirSync(legacyRoot);
  const source = path.join(legacyRoot, ".codex-global-state.valid.json");
  fs.writeFileSync(source, JSON.stringify({
    "local-projects": {}, "project-order": [], "project-writable-roots": {}, "thread-workspace-root-hints": {},
    "thread-project-assignments": {}, "electron-saved-workspace-roots": [], "electron-persisted-atom-state": {}
  }), "utf8");
  const timestamp = () => 1_700_000_000_000;
  try {
    const first = await migrateLegacyCodexRecoveryFiles({ legacyRoot, backupRoot: fixture.backupRoot, now: timestamp });
    const before = fs.readFileSync(first.manifestPath);
    const { protectString } = await import("../src/core/dpapi.js");
    await assert.rejects(
      () => migrateLegacyCodexRecoveryFiles({
        legacyRoot,
        backupRoot: fixture.backupRoot,
        now: timestamp,
        removeSource: true,
        protectKey: (value) => value.startsWith(".codex-global-state") ? "not-dpapi" : protectString(value)
      }),
      /source|dpapi|decrypt|data/i
    );
    assert.deepEqual(fs.readFileSync(first.manifestPath), before);
    assert.equal(fs.existsSync(source), true);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});
