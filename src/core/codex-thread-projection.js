import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { findStateDatabases, latestMatchingFiles } from "./file-io.js";

const PROJECTION_TABLE = "thread_history_projection_state";
const PROJECTION_COLUMNS = ["thread_id", "next_rollout_byte_offset", "next_rollout_ordinal"];
const TOMBSTONE_COLUMNS = ["archived", "has_user_event", "tokens_used"];
const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);

export function getCodexThreadProjectionHealth(input) {
  const started = performance.now();
  const timings = { stateMs: 0, integrityMs: 0, projectionMs: 0, rolloutMs: 0 };
  const result = inspectProjectionHealth(input, timings);
  return { ...result, timings: { ...timings, totalMs: Math.round(performance.now() - started) } };
}

function inspectProjectionHealth(input, timings) {
  const started = performance.now();
  const codexDir = typeof input === "string" ? input : input?.codexDir;
  const counts = createCounts();
  if (typeof codexDir !== "string" || !codexDir.trim()) {
    counts.unreadableStateDatabases = 1;
    return healthResult(counts, "unhealthy", false);
  }

  let stateDatabases;
  try {
    stateDatabases = findStateDatabases(codexDir);
  } catch {
    counts.unreadableStateDatabases = 1;
    return healthResult(counts, "unhealthy", false);
  }
  counts.stateDatabases = stateDatabases.length;

  const paginatedThreads = [];
  const paginatedThreadIds = new Set();
  for (const databasePath of stateDatabases) {
    let database;
    try {
      database = openReadOnlyDatabase(databasePath);
      counts.readableStateDatabases += 1;
      const columns = tableColumns(database, "threads");
      const hasHistoryMode = columns.has("history_mode");
      const hasRolloutPath = columns.has("rollout_path");
      if (!hasHistoryMode && !hasRolloutPath) {
        continue;
      }
      if (!hasHistoryMode || !hasRolloutPath) {
        counts.unsupportedStateSchemas += 1;
        continue;
      }
      if (!columns.has("id")) {
        counts.unsupportedStateSchemas += 1;
        continue;
      }
      const canClassifyTombstones = TOMBSTONE_COLUMNS.every((column) => columns.has(column));
      const rows = database
        .prepare(`SELECT id, history_mode, rollout_path${canClassifyTombstones ? `, ${TOMBSTONE_COLUMNS.join(", ")}` : ""}
          FROM threads WHERE history_mode = ?`)
        .all("paginated");
      for (const row of rows) {
        const threadId = normalizeKey(row.id);
        if (!threadId.trim()) {
          counts.invalidThreadIds += 1;
        } else if (paginatedThreadIds.has(threadId)) {
          counts.duplicatePaginatedThreadIds += 1;
        } else {
          paginatedThreadIds.add(threadId);
        }
        paginatedThreads.push({
          id: threadId,
          rolloutPath: typeof row.rollout_path === "string" ? row.rollout_path.trim() : "",
          emptyArchivedCandidate: canClassifyTombstones
            && isDatabaseOne(row.archived)
            && isDatabaseZero(row.has_user_event)
            && isDatabaseZero(row.tokens_used)
        });
      }
    } catch {
      counts.unreadableStateDatabases += 1;
    } finally {
      database?.close();
    }
  }

  counts.paginatedThreads = paginatedThreads.length;
  timings.stateMs = Math.round(performance.now() - started);
  if (paginatedThreads.length === 0) {
    const stateHealthy = counts.unreadableStateDatabases === 0
      && counts.unsupportedStateSchemas === 0
      && counts.invalidThreadIds === 0;
    return healthResult(counts, stateHealthy ? "not_applicable" : "unhealthy", stateHealthy);
  }

  let historyCandidates;
  try {
    historyCandidates = latestMatchingFiles(
      codexDir,
      /^thread_history_.*\.sqlite$/,
      { recursive: false }
    );
  } catch {
    counts.unreadableHistoryDatabases += 1;
    return healthResult(counts, "unhealthy", false);
  }
  counts.historyDatabaseCandidates = historyCandidates.length;
  const latestHistory = [...historyCandidates]
    .sort((left, right) => right.mtimeMs - left.mtimeMs || right.path.localeCompare(left.path))[0];
  if (!latestHistory) {
    counts.missingHistoryDatabases = 1;
    return healthResult(counts, "unhealthy", false);
  }

  const projectionRows = new Map();
  const emptyArchivedTombstoneIds = new Set();
  let historyDatabase;
  try {
    historyDatabase = openReadOnlyDatabase(latestHistory.path);
    let integrityRows;
    const integrityStarted = performance.now();
    try {
      integrityRows = historyDatabase.prepare("PRAGMA integrity_check").all();
    } catch {
      counts.historyIntegrityFailures += 1;
      return healthResult(counts, "unhealthy", false);
    } finally {
      timings.integrityMs = Math.round(performance.now() - integrityStarted);
    }
    const integrityFailures = integrityRows.reduce(
      (count, row) => count + (
        typeof row?.integrity_check === "string"
          && row.integrity_check.trim().toLowerCase() === "ok"
          ? 0
          : 1
      ),
      0
    );
    counts.historyIntegrityFailures += integrityRows.length === 0
      ? 1
      : integrityFailures;
    const columns = tableColumns(historyDatabase, PROJECTION_TABLE);
    if (!PROJECTION_COLUMNS.every((column) => columns.has(column))) {
      counts.unsupportedSchemas += 1;
      return healthResult(counts, "unhealthy", false);
    }
    const rows = historyDatabase.prepare(`SELECT ${PROJECTION_COLUMNS.join(", ")} FROM ${PROJECTION_TABLE}`).all();
    counts.projectionRows = rows.length;
    for (const row of rows) {
      const threadId = normalizeKey(row.thread_id);
      if (!threadId.trim()) {
        counts.invalidThreadIds += 1;
        continue;
      }
      if (projectionRows.has(threadId)) {
        counts.duplicateProjectionRows += 1;
        continue;
      }
      projectionRows.set(threadId, {
        offset: row.next_rollout_byte_offset,
        ordinal: row.next_rollout_ordinal
      });
    }
    const turnColumns = tableColumns(historyDatabase, "thread_turns");
    const itemColumns = tableColumns(historyDatabase, "thread_items");
    const turnTableSupported = turnColumns.size === 0 || turnColumns.has("thread_id");
    const itemTableSupported = itemColumns.size === 0 || itemColumns.has("thread_id");
    if (!turnTableSupported || !itemTableSupported) {
      counts.unsupportedSchemas += 1;
      return healthResult(counts, "unhealthy", false);
    }
    {
      const hasTurn = turnColumns.size > 0
        ? historyDatabase.prepare("SELECT 1 FROM thread_turns WHERE thread_id = ? LIMIT 1")
        : undefined;
      const hasItem = itemColumns.size > 0
        ? historyDatabase.prepare("SELECT 1 FROM thread_items WHERE thread_id = ? LIMIT 1")
        : undefined;
      for (const thread of paginatedThreads) {
        if (thread.emptyArchivedCandidate
          && !projectionRows.has(thread.id)
          && !hasTurn?.get(thread.id)
          && !hasItem?.get(thread.id)) {
          emptyArchivedTombstoneIds.add(thread.id);
        }
      }
    }
  } catch {
    counts.unreadableHistoryDatabases += 1;
    return healthResult(counts, "unhealthy", false);
  } finally {
    historyDatabase?.close();
  }

  const seenRollouts = new Set();
  const rolloutStarted = performance.now();
  timings.projectionMs = Math.max(0, Math.round(rolloutStarted - started) - timings.stateMs - timings.integrityMs);
  for (const thread of paginatedThreads) {
    if (!thread.id.trim()) {
      continue;
    }
    if (!thread.rolloutPath) {
      if (emptyArchivedTombstoneIds.has(thread.id)) {
        counts.ignoredArchivedTombstones += 1;
        continue;
      }
      counts.missingRollouts += 1;
      continue;
    }
    const rolloutFile = path.resolve(codexDir, thread.rolloutPath);
    const rolloutKey = process.platform === "win32" ? rolloutFile.toLowerCase() : rolloutFile;
    if (seenRollouts.has(rolloutKey)) {
      counts.duplicateRollouts += 1;
    } else {
      seenRollouts.add(rolloutKey);
    }

    const projection = projectionRows.get(thread.id);
    if (!projection) {
      if (emptyArchivedTombstoneIds.has(thread.id) && !fs.existsSync(rolloutFile)) {
        counts.ignoredArchivedTombstones += 1;
        continue;
      }
      counts.missingProjectionRows += 1;
      continue;
    }
    counts.checkedThreads += 1;
    const offset = toSafeNonNegativeInteger(projection.offset);
    const ordinal = toSafeNonNegativeInteger(projection.ordinal);
    if (offset === undefined || ordinal === undefined) {
      counts.invalidNumbers += 1;
      continue;
    }

    let rolloutStat;
    try {
      rolloutStat = fs.statSync(rolloutFile);
    } catch {
      counts.unreadableRollouts += 1;
      continue;
    }
    if (!rolloutStat.isFile()) {
      counts.unreadableRollouts += 1;
      continue;
    }
    const size = rolloutStat.size;
    if (!Number.isSafeInteger(size) || offset !== size) {
      counts.mismatchedOffsets += 1;
    }
  }

  const healthy = counts.unreadableStateDatabases === 0
    && counts.unsupportedStateSchemas === 0
    && counts.unreadableHistoryDatabases === 0
    && counts.unsupportedSchemas === 0
    && counts.duplicatePaginatedThreadIds === 0
    && counts.invalidThreadIds === 0
    && counts.duplicateProjectionRows === 0
    && counts.missingHistoryDatabases === 0
    && counts.historyIntegrityFailures === 0
    && counts.missingRollouts === 0
    && counts.duplicateRollouts === 0
    && counts.missingProjectionRows === 0
    && counts.invalidNumbers === 0
    && counts.unreadableRollouts === 0
    && counts.checkedThreads + counts.ignoredArchivedTombstones === counts.paginatedThreads;
  timings.rolloutMs = Math.round(performance.now() - rolloutStarted);
  return healthResult(counts, healthy ? "healthy" : "unhealthy", healthy);
}

function openReadOnlyDatabase(databasePath) {
  return new DatabaseSync(databasePath, { readOnly: true, readBigInts: true });
}

function tableColumns(database, tableName) {
  return new Set(database.prepare(`PRAGMA table_info(${tableName})`).all().map((row) => String(row.name)));
}

function normalizeKey(value) {
  if (typeof value === "string") return value;
  if (typeof value === "bigint") return value.toString();
  if (value === null || value === undefined) return "";
  return String(value);
}

function toSafeNonNegativeInteger(value) {
  if (typeof value === "bigint") {
    return value >= 0n && value <= MAX_SAFE_BIGINT ? Number(value) : undefined;
  }
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function isDatabaseZero(value) {
  return value === 0 || value === 0n;
}

function isDatabaseOne(value) {
  return value === 1 || value === 1n;
}

function createCounts() {
  return {
    stateDatabases: 0,
    readableStateDatabases: 0,
    unreadableStateDatabases: 0,
    unsupportedStateSchemas: 0,
    duplicatePaginatedThreadIds: 0,
    invalidThreadIds: 0,
    paginatedThreads: 0,
    historyDatabaseCandidates: 0,
    missingHistoryDatabases: 0,
    unreadableHistoryDatabases: 0,
    unsupportedSchemas: 0,
    projectionRows: 0,
    duplicateProjectionRows: 0,
    checkedThreads: 0,
    ignoredArchivedTombstones: 0,
    missingRollouts: 0,
    duplicateRollouts: 0,
    missingProjectionRows: 0,
    unreadableRollouts: 0,
    invalidNumbers: 0,
    mismatchedOffsets: 0,
    historyIntegrityFailures: 0
  };
}

function healthResult(counts, status, healthy) {
  return { counts, status, healthy };
}
