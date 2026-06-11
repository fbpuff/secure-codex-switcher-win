import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const MANIFEST_NAME = "secure-switcher-http-history.json";
const BACKUP_DIR_NAME = "secure-switcher-history-backups";

export function migrateCodexHistoryProvider(codexDir, targetProvider, previousProvider = "openai") {
  const manifestPath = path.join(codexDir, MANIFEST_NAME);
  const existingManifest = readJsonIfExists(manifestPath);
  const rolloutChanges = collectRolloutChanges(codexDir, () => targetProvider);
  const dbChanges = collectDatabaseChanges(codexDir, targetProvider);
  const manifest = mergeManifest(existingManifest, {
    version: 1,
    targetProvider,
    previousProvider,
    createdAt: new Date().toISOString(),
    rollouts: rolloutChanges.map((change) => ({
      path: toSafeRelativePath(codexDir, change.path),
      oldProvider: change.oldProvider
    })),
    databaseThreads: dbChanges.flatMap((change) =>
      change.rows.map((row) => ({ database: path.basename(change.path), id: row.id, oldProvider: row.oldProvider }))
    )
  });

  return applyMigration({
    codexDir,
    manifestPath,
    manifest,
    rolloutChanges,
    dbChanges,
    targetProvider
  });
}

export function revertCodexHistoryProvider(codexDir, fallbackProvider = "openai") {
  const manifestPath = path.join(codexDir, MANIFEST_NAME);
  const manifest = readJsonIfExists(manifestPath);
  if (!manifest) {
    return { changedRollouts: 0, changedThreads: 0, skippedRollouts: 0, manifestFound: false };
  }

  const rolloutProviders = new Map(
    (manifest.rollouts ?? []).map((entry) => [entry.path, entry.oldProvider || fallbackProvider])
  );
  const rolloutChanges = collectRolloutChanges(codexDir, (filePath, currentProvider) => {
    if (currentProvider !== manifest.targetProvider) {
      return currentProvider;
    }
    return rolloutProviders.get(toSafeRelativePath(codexDir, filePath)) ?? fallbackProvider;
  });
  const dbChanges = collectDatabaseRevertChanges(codexDir, manifest, fallbackProvider);
  const result = applyMigration({
    codexDir,
    manifestPath,
    manifest: undefined,
    rolloutChanges,
    dbChanges,
    targetProvider: fallbackProvider
  });

  archiveManifest(codexDir, manifestPath);
  return { ...result, manifestFound: true };
}

function applyMigration({ codexDir, manifestPath, manifest, rolloutChanges, dbChanges, targetProvider }) {
  fs.mkdirSync(codexDir, { recursive: true });
  const pendingManifestPath = manifest ? `${manifestPath}.${process.pid}.pending` : undefined;
  const completedRollouts = [];
  const completedDatabases = [];

  try {
    if (pendingManifestPath) {
      atomicWriteJson(pendingManifestPath, manifest);
    }
    for (const change of rolloutChanges) {
      rewriteRolloutProvider(change.path, change.nextData);
      completedRollouts.push(change);
    }
    for (const change of dbChanges) {
      if (change.rows.length === 0 && (change.restoreRows?.length ?? 0) === 0) {
        continue;
      }
      backupDatabase(codexDir, change.path);
      applyDatabaseChange(change);
      completedDatabases.push(change);
    }
    if (pendingManifestPath) {
      fs.renameSync(pendingManifestPath, manifestPath);
    }
    pruneBackups(codexDir);
    return {
      provider: targetProvider,
      changedRollouts: rolloutChanges.length,
      changedThreads: dbChanges.reduce((total, change) => total + change.rows.length, 0),
      skippedRollouts: 0,
      manifestFound: Boolean(manifest)
    };
  } catch (error) {
    for (const change of completedDatabases.reverse()) {
      restoreDatabaseChange(change);
    }
    for (const change of completedRollouts.reverse()) {
      rewriteRolloutProvider(change.path, change.originalData);
    }
    if (pendingManifestPath) {
      fs.rmSync(pendingManifestPath, { force: true });
    }
    throw error;
  }
}

function collectRolloutChanges(codexDir, resolveProvider) {
  const changes = [];
  for (const rootName of ["sessions", "archived_sessions"]) {
    for (const filePath of findRolloutFiles(path.join(codexDir, rootName))) {
      const originalData = readRolloutMetadata(filePath);
      const oldProvider = getProvider(originalData);
      if (!oldProvider) {
        continue;
      }
      const nextProvider = resolveProvider(filePath, oldProvider);
      if (!nextProvider || nextProvider === oldProvider) {
        continue;
      }
      const nextData = structuredClone(originalData);
      if (!setProvider(nextData, nextProvider)) {
        continue;
      }
      changes.push({ path: filePath, oldProvider, nextProvider, originalData, nextData });
    }
  }
  return changes;
}

function collectDatabaseChanges(codexDir, targetProvider) {
  return findStateDatabases(codexDir).map((dbPath) => {
    const database = new DatabaseSync(dbPath);
    try {
      const providerColumn = findProviderColumn(database);
      if (!providerColumn) {
        return { path: dbPath, providerColumn: undefined, rows: [], targetProvider };
      }
      const rows = database
        .prepare(`SELECT id, ${providerColumn} AS oldProvider FROM threads WHERE ${providerColumn} IS NOT ?`)
        .all(targetProvider)
        .map((row) => ({ id: String(row.id), oldProvider: String(row.oldProvider ?? "") }));
      return { path: dbPath, providerColumn, rows, targetProvider };
    } finally {
      database.close();
    }
  });
}

function collectDatabaseRevertChanges(codexDir, manifest, fallbackProvider) {
  const previousRowsByDatabase = new Map();
  for (const entry of manifest.databaseThreads ?? []) {
    if (!previousRowsByDatabase.has(entry.database)) {
      previousRowsByDatabase.set(entry.database, []);
    }
    previousRowsByDatabase.get(entry.database).push({ id: entry.id, oldProvider: entry.oldProvider || fallbackProvider });
  }

  return findStateDatabases(codexDir).map((dbPath) => {
    const database = new DatabaseSync(dbPath);
    try {
      const providerColumn = findProviderColumn(database);
      if (!providerColumn) {
        return { path: dbPath, providerColumn: undefined, rows: [], targetProvider: fallbackProvider };
      }
      const currentRows = database
        .prepare(`SELECT id, ${providerColumn} AS oldProvider FROM threads WHERE ${providerColumn} = ?`)
        .all(manifest.targetProvider)
        .map((row) => ({ id: String(row.id), oldProvider: String(row.oldProvider ?? "") }));
      return {
        path: dbPath,
        providerColumn,
        rows: currentRows,
        targetProvider: fallbackProvider,
        restoreRows: previousRowsByDatabase.get(path.basename(dbPath)) ?? []
      };
    } finally {
      database.close();
    }
  });
}

function applyDatabaseChange(change) {
  if (!change.providerColumn || (change.rows.length === 0 && (change.restoreRows?.length ?? 0) === 0)) {
    return;
  }
  const database = new DatabaseSync(change.path);
  try {
    database.exec("BEGIN IMMEDIATE");
    const update = database.prepare(`UPDATE threads SET ${change.providerColumn} = ? WHERE id = ?`);
    for (const row of change.rows) {
      update.run(change.targetProvider, row.id);
    }
    for (const row of change.restoreRows ?? []) {
      update.run(row.oldProvider, row.id);
    }
    database.exec("COMMIT");
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {}
    throw error;
  } finally {
    database.close();
  }
}

function restoreDatabaseChange(change) {
  if (!change.providerColumn || change.rows.length === 0) {
    return;
  }
  const database = new DatabaseSync(change.path);
  try {
    database.exec("BEGIN IMMEDIATE");
    const update = database.prepare(`UPDATE threads SET ${change.providerColumn} = ? WHERE id = ?`);
    for (const row of change.rows) {
      update.run(row.oldProvider, row.id);
    }
    database.exec("COMMIT");
  } catch {
    try {
      database.exec("ROLLBACK");
    } catch {}
  } finally {
    database.close();
  }
}

function findProviderColumn(database) {
  const columns = database.prepare("PRAGMA table_info(threads)").all().map((row) => String(row.name));
  if (columns.includes("model_provider")) {
    return "model_provider";
  }
  if (columns.includes("provider")) {
    return "provider";
  }
  return undefined;
}

function readRolloutMetadata(filePath) {
  const descriptor = fs.openSync(filePath, "r");
  try {
    const chunks = [];
    const buffer = Buffer.alloc(8192);
    let position = 0;
    while (position < 1024 * 1024) {
      const bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, position);
      if (bytesRead === 0) {
        break;
      }
      const chunk = Buffer.from(buffer.subarray(0, bytesRead));
      const newlineIndex = chunk.indexOf(0x0a);
      if (newlineIndex >= 0) {
        chunks.push(chunk.subarray(0, newlineIndex));
        break;
      }
      chunks.push(chunk);
      position += bytesRead;
    }
    const line = Buffer.concat(chunks).toString("utf8").replace(/\r$/, "");
    if (!line) {
      throw new Error(`Codex rollout is empty: ${filePath}`);
    }
    return JSON.parse(line);
  } finally {
    fs.closeSync(descriptor);
  }
}

function rewriteRolloutProvider(filePath, metadata) {
  const source = fs.openSync(filePath, "r");
  const stat = fs.fstatSync(source);
  const prefix = Buffer.alloc(Math.min(stat.size, 1024 * 1024));
  const prefixLength = fs.readSync(source, prefix, 0, prefix.length, 0);
  const newlineIndex = prefix.subarray(0, prefixLength).indexOf(0x0a);
  if (newlineIndex < 0) {
    fs.closeSync(source);
    throw new Error(`Codex rollout metadata line is too large: ${filePath}`);
  }
  const lineEnding = newlineIndex > 0 && prefix[newlineIndex - 1] === 0x0d ? "\r\n" : "\n";
  const remainderOffset = newlineIndex + 1;
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  const target = fs.openSync(tempPath, "w", 0o600);
  let completed = false;

  try {
    fs.writeSync(target, `${JSON.stringify(metadata)}${lineEnding}`, undefined, "utf8");
    const copyBuffer = Buffer.alloc(1024 * 1024);
    let sourcePosition = remainderOffset;
    while (sourcePosition < stat.size) {
      const bytesRead = fs.readSync(source, copyBuffer, 0, copyBuffer.length, sourcePosition);
      if (bytesRead === 0) {
        break;
      }
      fs.writeSync(target, copyBuffer, 0, bytesRead);
      sourcePosition += bytesRead;
    }
    completed = true;
  } finally {
    fs.closeSync(source);
    fs.closeSync(target);
    if (!completed) {
      fs.rmSync(tempPath, { force: true });
    }
  }
  fs.renameSync(tempPath, filePath);
}

function getProvider(data) {
  if (typeof data.model_provider === "string") {
    return data.model_provider;
  }
  if (typeof data.session_meta?.model_provider === "string") {
    return data.session_meta.model_provider;
  }
  if (typeof data.payload?.model_provider === "string") {
    return data.payload.model_provider;
  }
  return undefined;
}

function setProvider(data, provider) {
  if (typeof data.model_provider === "string") {
    data.model_provider = provider;
    return true;
  }
  if (typeof data.session_meta?.model_provider === "string") {
    data.session_meta.model_provider = provider;
    return true;
  }
  if (typeof data.payload?.model_provider === "string") {
    data.payload.model_provider = provider;
    return true;
  }
  return false;
}

function findRolloutFiles(root) {
  if (!fs.existsSync(root)) {
    return [];
  }
  const files = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...findRolloutFiles(fullPath));
    } else if (entry.isFile() && /^rollout-.*\.jsonl$/.test(entry.name)) {
      files.push(fullPath);
    }
  }
  return files.sort();
}

function findStateDatabases(codexDir) {
  if (!fs.existsSync(codexDir)) {
    return [];
  }
  return fs
    .readdirSync(codexDir)
    .filter((name) => /^state_.*\.sqlite$/.test(name))
    .map((name) => path.join(codexDir, name))
    .sort();
}

function mergeManifest(existing, next) {
  if (!existing || existing.targetProvider !== next.targetProvider) {
    return next;
  }
  const rolloutMap = new Map((existing.rollouts ?? []).map((entry) => [entry.path, entry]));
  for (const entry of next.rollouts) {
    if (!rolloutMap.has(entry.path)) {
      rolloutMap.set(entry.path, entry);
    }
  }
  const threadMap = new Map(
    (existing.databaseThreads ?? []).map((entry) => [`${entry.database}:${entry.id}`, entry])
  );
  for (const entry of next.databaseThreads) {
    const key = `${entry.database}:${entry.id}`;
    if (!threadMap.has(key)) {
      threadMap.set(key, entry);
    }
  }
  return {
    ...existing,
    rollouts: [...rolloutMap.values()],
    databaseThreads: [...threadMap.values()]
  };
}

function backupDatabase(codexDir, databasePath) {
  if (!fs.existsSync(databasePath)) {
    return;
  }
  const backupDir = path.join(codexDir, BACKUP_DIR_NAME);
  fs.mkdirSync(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  fs.copyFileSync(databasePath, path.join(backupDir, `${path.basename(databasePath)}.${stamp}.bak`));
}

function archiveManifest(codexDir, manifestPath) {
  if (!fs.existsSync(manifestPath)) {
    return;
  }
  const backupDir = path.join(codexDir, BACKUP_DIR_NAME);
  fs.mkdirSync(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  try {
    fs.renameSync(manifestPath, path.join(backupDir, `provider-manifest.${stamp}.json`));
  } catch {
    fs.rmSync(manifestPath, { force: true });
  }
}

function pruneBackups(codexDir) {
  const backupDir = path.join(codexDir, BACKUP_DIR_NAME);
  if (!fs.existsSync(backupDir)) {
    return;
  }
  const groups = new Map();
  for (const name of fs.readdirSync(backupDir).sort()) {
    const key = name.startsWith("provider-manifest.") ? "provider-manifest" : name.split(".sqlite.", 1)[0];
    if (!groups.has(key)) {
      groups.set(key, []);
    }
    groups.get(key).push(name);
  }
  for (const names of groups.values()) {
    for (const extra of names.slice(0, Math.max(0, names.length - 3))) {
      fs.rmSync(path.join(backupDir, extra), { force: true });
    }
  }
}

function toSafeRelativePath(root, filePath) {
  const relative = path.relative(root, filePath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Refusing Codex history path outside CODEX_HOME: ${filePath}`);
  }
  return relative;
}

function readJsonIfExists(filePath) {
  if (!fs.existsSync(filePath)) {
    return undefined;
  }
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function atomicWriteJson(filePath, value) {
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tempPath, filePath);
}
