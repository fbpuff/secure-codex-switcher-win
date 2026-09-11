import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { protectString, unprotectString } from "./dpapi.js";
import { atomicWriteText } from "./file-io.js";
import { saveRecoverySnapshot } from "./recovery-snapshots.js";

export function runSwitcherStartupMaintenance(options) {
  migratePlaintextAuthBackups(path.join(options.codexDir, "secure-switcher-backups"));
  migrateLegacySwitcherBackups(options.codexDir, options.backupRoot);
  migratePlaintextAuthBackups(options.authBackupPath);
  saveRecoverySnapshot(options.recoverySnapshotsPath, options.store, options.settings);
  return { completed: true };
}

export function migratePlaintextAuthBackups(backupDir) {
  if (!fs.existsSync(backupDir)) return;
  for (const name of fs.readdirSync(backupDir).filter((item) => item.startsWith("auth.") && item.endsWith(".json"))) {
    const source = path.join(backupDir, name);
    const target = `${source}.dpapi`;
    if (!fs.existsSync(target)) {
      atomicWriteText(target, `${protectString(fs.readFileSync(source, "utf8"))}\n`);
    }
    fs.rmSync(source, { force: true });
  }
  pruneAuthBackups(backupDir);
}

function pruneAuthBackups(backupDir) {
  const backups = fs.readdirSync(backupDir)
    .filter((name) => name.startsWith("auth.") && name.endsWith(".json.dpapi"))
    .sort();
  for (const extra of backups.slice(0, Math.max(0, backups.length - 3))) {
    fs.rmSync(path.join(backupDir, extra), { force: true });
  }
}

export function migrateLegacySwitcherBackups(codexDir, backupRoot) {
  migrateDirectory(
    path.join(codexDir, "secure-switcher-backups"),
    path.join(backupRoot, "auth"),
    validateAuthBackup
  );
  migrateDirectory(
    path.join(codexDir, "secure-switcher-history-backups"),
    path.join(backupRoot, "history"),
    validateHistoryBackup
  );
  migrateFile(
    path.join(codexDir, "secure-switcher-http-history.json"),
    path.join(backupRoot, "http-history.json"),
    validateJson
  );
}

function migrateDirectory(sourceDir, destinationDir, validate) {
  if (!fs.existsSync(sourceDir)) return;
  for (const name of fs.readdirSync(sourceDir)) {
    const source = path.join(sourceDir, name);
    if (!fs.statSync(source).isFile()) continue;
    migrateFile(source, path.join(destinationDir, name), (candidate) => validate(candidate, name));
  }
  if (fs.readdirSync(sourceDir).length === 0) fs.rmdirSync(sourceDir);
}

function migrateFile(source, requestedTarget, validate) {
  if (!fs.existsSync(source)) return;
  try {
    validate(source);
  } catch (error) {
    throw new Error(`Invalid legacy Switcher backup: ${path.basename(source)}`, { cause: error });
  }

  const sourceHash = fileHash(source);
  const target = availableTarget(requestedTarget, sourceHash);
  if (fs.existsSync(target)) {
    fs.rmSync(source, { force: true });
    return;
  }

  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.copyFileSync(source, temp);
    const handle = fs.openSync(temp, "r+");
    try {
      fs.fsyncSync(handle);
    } finally {
      fs.closeSync(handle);
    }
    if (fs.statSync(source).size !== fs.statSync(temp).size || sourceHash !== fileHash(temp)) {
      throw new Error(`Legacy Switcher backup copy verification failed: ${path.basename(source)}`);
    }
    validate(temp);
    fs.renameSync(temp, target);
    if (sourceHash !== fileHash(target)) {
      throw new Error(`Legacy Switcher backup destination verification failed: ${path.basename(source)}`);
    }
    fs.rmSync(source, { force: true });
  } finally {
    fs.rmSync(temp, { force: true });
  }
}

function availableTarget(requestedTarget, sourceHash) {
  if (!fs.existsSync(requestedTarget) || fileHash(requestedTarget) === sourceHash) return requestedTarget;
  const suffix = `.legacy-${sourceHash.slice(0, 12)}`;
  if (requestedTarget.endsWith(".json.dpapi")) return requestedTarget.replace(/\.json\.dpapi$/, `${suffix}.json.dpapi`);
  if (requestedTarget.endsWith(".json")) return requestedTarget.replace(/\.json$/, `${suffix}.json`);
  return `${requestedTarget}${suffix}`;
}

function fileHash(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function validateAuthBackup(filePath) {
  JSON.parse(unprotectString(fs.readFileSync(filePath, "utf8")));
}

function validateHistoryBackup(filePath, originalName) {
  if (originalName.startsWith("provider-manifest.") && originalName.endsWith(".json")) {
    validateJson(filePath);
    return;
  }
  const header = fs.readFileSync(filePath).subarray(0, 16).toString("binary");
  if (header !== "SQLite format 3\0") throw new Error("Invalid SQLite backup");
}

function validateJson(filePath) {
  JSON.parse(fs.readFileSync(filePath, "utf8"));
}
