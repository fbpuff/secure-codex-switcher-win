import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { getCodexThreadProjectionHealth } from "../src/core/codex-thread-projection.js";

function makeFixture(options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "secure-switcher-projection-"));
  const statePath = path.join(root, "state_5.sqlite");
  const rolloutPath = options.rolloutPath ?? path.join(root, "sessions", "rollout-private.jsonl");
  const stateThreadId = Object.hasOwn(options, "stateThreadId") ? options.stateThreadId : "secret-thread-id";
  const projectionThreadId = Object.hasOwn(options, "projectionThreadId")
    ? options.projectionThreadId
    : "secret-thread-id";
  fs.mkdirSync(path.dirname(rolloutPath), { recursive: true });
  fs.writeFileSync(rolloutPath, options.rolloutContents ?? "private-thread-content\n", "utf8");

  const state = new DatabaseSync(statePath);
  try {
    if (options.legacyOnly) {
      state.exec("CREATE TABLE threads (id TEXT PRIMARY KEY)");
    } else if (options.stateSchema === "history-only") {
      state.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, history_mode TEXT)");
    } else if (options.stateSchema === "rollout-only") {
      state.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT)");
    } else {
      state.exec(`CREATE TABLE threads (
        id TEXT PRIMARY KEY,
        history_mode TEXT,
        rollout_path TEXT,
        archived INTEGER DEFAULT 0,
        has_user_event INTEGER DEFAULT 0,
        tokens_used INTEGER DEFAULT 0
      )`);
    }
    if (!options.omitThread) {
      const insert = options.legacyOnly
        ? state.prepare("INSERT INTO threads (id) VALUES (?)")
        : options.stateSchema === "rollout-only"
        ? state.prepare("INSERT INTO threads (id, rollout_path) VALUES (?, ?)")
        : options.stateSchema === "history-only"
          ? state.prepare("INSERT INTO threads (id, history_mode) VALUES (?, ?)")
          : state.prepare(`INSERT INTO threads (
              id, history_mode, rollout_path, archived, has_user_event, tokens_used
            ) VALUES (?, ?, ?, ?, ?, ?)`);
      if (options.legacyOnly) {
        insert.run(stateThreadId);
      } else if (options.stateSchema === "history-only") {
        insert.run(stateThreadId, "paginated");
      } else if (options.stateSchema === "rollout-only") {
        insert.run(stateThreadId, rolloutPath);
      } else {
        insert.run(
          stateThreadId,
          options.historyMode ?? "paginated",
          options.missingRollout ? null : rolloutPath,
          options.archived ? 1 : 0,
          options.hasUserEvent ? 1 : 0,
          options.tokensUsed ?? 0
        );
      }
    }
  } finally {
    state.close();
  }

  if (!options.omitHistory) {
    const historyPath = path.join(root, options.historyName ?? "thread_history_1.sqlite");
    const history = new DatabaseSync(historyPath);
    try {
      if (options.historySchema !== false) {
        history.exec(`CREATE TABLE thread_history_projection_state (
          thread_id TEXT,
          next_rollout_byte_offset INTEGER,
          next_rollout_ordinal INTEGER
        )`);
        history.exec("CREATE TABLE thread_turns (thread_id TEXT)");
        history.exec("CREATE TABLE thread_items (thread_id TEXT)");
        if (!options.missingProjection) {
          history.prepare(
            "INSERT INTO thread_history_projection_state (thread_id, next_rollout_byte_offset, next_rollout_ordinal) VALUES (?, ?, ?)"
          ).run(projectionThreadId, options.offset ?? fs.statSync(rolloutPath).size, options.ordinal ?? 1);
        }
        if (options.projectedTurn) history.prepare("INSERT INTO thread_turns (thread_id) VALUES (?)").run(stateThreadId);
        if (options.projectedItem) history.prepare("INSERT INTO thread_items (thread_id) VALUES (?)").run(stateThreadId);
        if (options.historyIntegrityFailure || options.historyIntegrityCheckThrows) {
          history.exec("CREATE INDEX projection_integrity_probe ON thread_history_projection_state(thread_id)");
        }
      } else {
        history.exec("CREATE TABLE unsupported_projection (thread_id TEXT, offset INTEGER)");
      }
    } finally {
      history.close();
    }
    if (options.historyIntegrityFailure || options.historyIntegrityCheckThrows) {
      const bytes = fs.readFileSync(historyPath);
      const marker = Buffer.from(projectionThreadId);
      const markerOffset = bytes.lastIndexOf(marker);
      assert.notEqual(markerOffset, -1);
      if (options.historyIntegrityCheckThrows) {
        bytes[markerOffset - 4] = 0xff;
      } else {
        const lastByteOffset = markerOffset + marker.length - 1;
        bytes[lastByteOffset] = bytes[lastByteOffset] === 0x75 ? 0x76 : 0x75;
      }
      fs.writeFileSync(historyPath, bytes);
    }
  }

  return {
    root,
    rolloutPath,
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true });
    }
  };
}

function assertPrivateProjectionResult(result, expectedStatus, expectedHealthy) {
  assert.equal(result.status, expectedStatus);
  assert.equal(result.healthy, expectedHealthy);
  assert.deepEqual(Object.keys(result).sort(), ["counts", "healthy", "status", "timings"]);
  assert.deepEqual(Object.keys(result.timings).sort(), ["integrityMs", "projectionMs", "rolloutMs", "stateMs", "totalMs"]);
  assert.ok(Object.values(result.timings).every((value) => Number.isSafeInteger(value) && value >= 0));
  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, /secret-thread-id|rollout-private\.jsonl|thread_history_/);
  assert.doesNotMatch(serialized, /private-thread-content/);
}

test("reports healthy when every paginated projection offset is exactly the rollout size", () => {
  const fixture = makeFixture();
  try {
    const result = getCodexThreadProjectionHealth(fixture.root);
    assertPrivateProjectionResult(result, "healthy", true);
    assert.equal(result.counts.paginatedThreads, 1);
    assert.equal(result.counts.checkedThreads, 1);
    assert.equal(result.counts.mismatchedOffsets, 0);
  } finally {
    fixture.cleanup();
  }
});

test("reports a healthy projection with an ahead offset and an aggregate mismatch count", () => {
  const fixture = makeFixture({ offset: 10_000 });
  try {
    const result = getCodexThreadProjectionHealth(fixture.root);
    assertPrivateProjectionResult(result, "healthy", true);
    assert.equal(result.counts.mismatchedOffsets, 1);
  } finally {
    fixture.cleanup();
  }
});

test("reports a healthy projection with a behind offset and an aggregate mismatch count", () => {
  const fixture = makeFixture({ offset: 0 });
  try {
    const result = getCodexThreadProjectionHealth(fixture.root);
    assertPrivateProjectionResult(result, "healthy", true);
    assert.equal(result.counts.mismatchedOffsets, 1);
  } finally {
    fixture.cleanup();
  }
});

test("fails closed when the history database integrity check is not ok", () => {
  const fixture = makeFixture({ historyIntegrityFailure: true });
  try {
    const result = getCodexThreadProjectionHealth(fixture.root);
    assertPrivateProjectionResult(result, "unhealthy", false);
    assert.equal(result.counts.historyIntegrityFailures, 1);
  } finally {
    fixture.cleanup();
  }
});

test("fails closed and counts a history integrity check execution error", () => {
  const fixture = makeFixture({ historyIntegrityCheckThrows: true });
  try {
    const result = getCodexThreadProjectionHealth(fixture.root);
    assertPrivateProjectionResult(result, "unhealthy", false);
    assert.equal(result.counts.historyIntegrityFailures, 1);
    assert.equal(result.counts.unreadableHistoryDatabases, 0);
  } finally {
    fixture.cleanup();
  }
});

test("fails closed when the projection row is missing", () => {
  const fixture = makeFixture({ missingProjection: true });
  try {
    const result = getCodexThreadProjectionHealth(fixture.root);
    assertPrivateProjectionResult(result, "unhealthy", false);
    assert.equal(result.counts.missingProjectionRows, 1);
  } finally {
    fixture.cleanup();
  }
});

test("ignores an archived empty lifecycle tombstone without rollout or projected history", () => {
  const fixture = makeFixture({ missingProjection: true, archived: true });
  fs.rmSync(fixture.rolloutPath);
  try {
    const result = getCodexThreadProjectionHealth(fixture.root);
    assertPrivateProjectionResult(result, "healthy", true);
    assert.equal(result.counts.ignoredArchivedTombstones, 1);
    assert.equal(result.counts.missingProjectionRows, 0);
    assert.equal(result.counts.checkedThreads, 0);
  } finally {
    fixture.cleanup();
  }
});

for (const [label, options] of [
  ["user event", { hasUserEvent: true }],
  ["token usage", { tokensUsed: 1 }],
  ["projected turn", { projectedTurn: true }],
  ["projected item", { projectedItem: true }]
]) {
  test(`keeps an archived ${label} thread fail-closed when projection and rollout are missing`, () => {
    const fixture = makeFixture({ missingProjection: true, archived: true, ...options });
    fs.rmSync(fixture.rolloutPath);
    try {
      const result = getCodexThreadProjectionHealth(fixture.root);
      assertPrivateProjectionResult(result, "unhealthy", false);
      assert.equal(result.counts.ignoredArchivedTombstones, 0);
      assert.equal(result.counts.missingProjectionRows, 1);
    } finally {
      fixture.cleanup();
    }
  });
}

test("fails closed when a bound rollout file is missing", () => {
  const fixture = makeFixture({});
  fs.rmSync(fixture.rolloutPath);
  try {
    const result = getCodexThreadProjectionHealth(fixture.root);
    assertPrivateProjectionResult(result, "unhealthy", false);
    assert.equal(result.counts.unreadableRollouts, 1);
  } finally {
    fixture.cleanup();
  }
});

test("fails closed when a paginated thread has no bound rollout", () => {
  const fixture = makeFixture({ missingRollout: true });
  try {
    const result = getCodexThreadProjectionHealth(fixture.root);
    assertPrivateProjectionResult(result, "unhealthy", false);
    assert.equal(result.counts.missingRollouts, 1);
  } finally {
    fixture.cleanup();
  }
});

for (const [label, options] of [
  ["null state", { stateThreadId: null }],
  ["empty state", { stateThreadId: "" }],
  ["whitespace state", { stateThreadId: " \t" }],
  ["null projection", { projectionThreadId: null }],
  ["empty projection", { projectionThreadId: "" }],
  ["whitespace projection", { projectionThreadId: " \t" }]
]) {
  test(`fails closed for ${label} thread ID`, () => {
    const fixture = makeFixture(options);
    try {
      const result = getCodexThreadProjectionHealth(fixture.root);
      assertPrivateProjectionResult(result, "unhealthy", false);
      assert.equal(result.counts.invalidThreadIds, 1);
    } finally {
      fixture.cleanup();
    }
  });
}

test("fails closed for an unsupported projection schema", () => {
  const fixture = makeFixture({ historySchema: false });
  try {
    const result = getCodexThreadProjectionHealth(fixture.root);
    assertPrivateProjectionResult(result, "unhealthy", false);
    assert.equal(result.counts.unsupportedSchemas, 1);
  } finally {
    fixture.cleanup();
  }
});

test("fails closed for a negative or non-safe projection number", () => {
  const fixture = makeFixture({ offset: -1 });
  try {
    const result = getCodexThreadProjectionHealth(fixture.root);
    assertPrivateProjectionResult(result, "unhealthy", false);
    assert.equal(result.counts.invalidNumbers, 1);
  } finally {
    fixture.cleanup();
  }
});

test("fails closed when the projection ordinal is invalid", () => {
  const fixture = makeFixture({ ordinal: -1 });
  try {
    const result = getCodexThreadProjectionHealth(fixture.root);
    assertPrivateProjectionResult(result, "unhealthy", false);
    assert.equal(result.counts.invalidNumbers, 1);
  } finally {
    fixture.cleanup();
  }
});

test("fails closed when a projection number exceeds the safe integer range", () => {
  const fixture = makeFixture({ offset: "9007199254740992" });
  try {
    const result = getCodexThreadProjectionHealth(fixture.root);
    assertPrivateProjectionResult(result, "unhealthy", false);
    assert.equal(result.counts.invalidNumbers, 1);
  } finally {
    fixture.cleanup();
  }
});

test("fails closed for duplicate projection rows", () => {
  const fixture = makeFixture();
  const historyPath = path.join(fixture.root, "thread_history_1.sqlite");
  const history = new DatabaseSync(historyPath);
  try {
    history.prepare(
      "INSERT INTO thread_history_projection_state (thread_id, next_rollout_byte_offset, next_rollout_ordinal) VALUES (?, ?, ?)"
    ).run("secret-thread-id", fs.statSync(fixture.rolloutPath).size, 2);
  } finally {
    history.close();
  }
  try {
    const result = getCodexThreadProjectionHealth(fixture.root);
    assertPrivateProjectionResult(result, "unhealthy", false);
    assert.equal(result.counts.duplicateProjectionRows, 1);
  } finally {
    fixture.cleanup();
  }
});

test("fails closed for duplicate paginated thread IDs across state databases", () => {
  const fixture = makeFixture();
  const secondStatePath = path.join(fixture.root, "state_6.sqlite");
  const state = new DatabaseSync(secondStatePath);
  try {
    state.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, history_mode TEXT, rollout_path TEXT)");
    state.prepare("INSERT INTO threads (id, history_mode, rollout_path) VALUES (?, ?, ?)")
      .run("secret-thread-id", "paginated", fixture.rolloutPath);
  } finally {
    state.close();
  }
  try {
    const result = getCodexThreadProjectionHealth(fixture.root);
    assertPrivateProjectionResult(result, "unhealthy", false);
    assert.equal(result.counts.duplicatePaginatedThreadIds, 1);
  } finally {
    fixture.cleanup();
  }
});

test("fails closed when only one projection-related state column exists", () => {
  const fixture = makeFixture({ stateSchema: "history-only", omitHistory: true });
  try {
    const result = getCodexThreadProjectionHealth(fixture.root);
    assertPrivateProjectionResult(result, "unhealthy", false);
    assert.equal(result.counts.unsupportedStateSchemas, 1);
  } finally {
    fixture.cleanup();
  }
});

test("fails closed for a corrupt state database", () => {
  const fixture = makeFixture();
  fs.writeFileSync(path.join(fixture.root, "state_5.sqlite"), "not-a-sqlite-database", "utf8");
  try {
    const result = getCodexThreadProjectionHealth(fixture.root);
    assertPrivateProjectionResult(result, "unhealthy", false);
    assert.equal(result.counts.unreadableStateDatabases, 1);
  } finally {
    fixture.cleanup();
  }
});

test("fails closed for a corrupt history database", () => {
  const fixture = makeFixture();
  fs.writeFileSync(path.join(fixture.root, "thread_history_1.sqlite"), "not-a-sqlite-database", "utf8");
  try {
    const result = getCodexThreadProjectionHealth(fixture.root);
    assertPrivateProjectionResult(result, "unhealthy", false);
    assert.equal(result.counts.historyIntegrityFailures, 1);
    assert.equal(result.counts.unreadableHistoryDatabases, 0);
  } finally {
    fixture.cleanup();
  }
});

test("fails closed as unreadable when the history database disappears before opening", () => {
  const fixture = makeFixture();
  const originalStatSync = fs.statSync;
  let removed = false;
  fs.statSync = (filePath, ...args) => {
    const result = originalStatSync(filePath, ...args);
    if (!removed && path.basename(String(filePath)) === "thread_history_1.sqlite") {
      fs.rmSync(filePath);
      removed = true;
    }
    return result;
  };
  try {
    const result = getCodexThreadProjectionHealth(fixture.root);
    assert.equal(removed, true);
    assertPrivateProjectionResult(result, "unhealthy", false);
    assert.equal(result.counts.unreadableHistoryDatabases, 1);
    assert.equal(result.counts.historyIntegrityFailures, 0);
  } finally {
    fs.statSync = originalStatSync;
    fixture.cleanup();
  }
});

test("fails closed when a bound rollout path is a directory", () => {
  const fixture = makeFixture();
  fs.rmSync(fixture.rolloutPath);
  fs.mkdirSync(fixture.rolloutPath);
  try {
    const result = getCodexThreadProjectionHealth(fixture.root);
    assertPrivateProjectionResult(result, "unhealthy", false);
    assert.equal(result.counts.unreadableRollouts, 1);
  } finally {
    fixture.cleanup();
  }
});

test("legacy-only state is healthy without a history database", () => {
  const fixture = makeFixture({ legacyOnly: true, omitHistory: true });
  try {
    const result = getCodexThreadProjectionHealth(fixture.root);
    assertPrivateProjectionResult(result, "not_applicable", true);
    assert.equal(result.counts.paginatedThreads, 0);
  } finally {
    fixture.cleanup();
  }
});

test("requires rollout paths to be unique across paginated threads", () => {
  const fixture = makeFixture();
  const statePath = path.join(fixture.root, "state_5.sqlite");
  const state = new DatabaseSync(statePath);
  try {
    state.prepare("INSERT INTO threads (id, history_mode, rollout_path) VALUES (?, ?, ?)")
      .run(
        "secret-second-thread-id",
        "paginated",
        ["sessions", "..", "sessions", path.basename(fixture.rolloutPath)].join(path.sep)
      );
  } finally {
    state.close();
  }
  try {
    const result = getCodexThreadProjectionHealth(fixture.root);
    assertPrivateProjectionResult(result, "unhealthy", false);
    assert.equal(result.counts.duplicateRollouts, 1);
  } finally {
    fixture.cleanup();
  }
});
