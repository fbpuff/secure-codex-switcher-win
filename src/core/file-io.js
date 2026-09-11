import fs from "node:fs";
import path from "node:path";

const ATOMIC_RENAME_RETRIES = 6;
const ATOMIC_RENAME_DELAY_MS = 25;

export function atomicWriteJson(filePath, value, options = {}) {
  if (options.backup !== false && fs.existsSync(filePath)) {
    const current = fs.readFileSync(filePath, "utf8");
    try {
      JSON.parse(current);
      atomicWriteText(`${filePath}.bak`, current);
    } catch {}
  }
  const serialized = options.compact
    ? JSON.stringify(value)
    : `${JSON.stringify(value, null, 2)}\n`;
  atomicWriteText(filePath, serialized);
}

export function atomicWriteText(filePath, value) {
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  let handle;
  try {
    handle = fs.openSync(tempPath, "w", 0o600);
    fs.writeFileSync(handle, value, "utf8");
    fs.fsyncSync(handle);
    fs.closeSync(handle);
    handle = undefined;
    renameWithRetry(tempPath, filePath);
  } finally {
    if (handle !== undefined) fs.closeSync(handle);
    fs.rmSync(tempPath, { force: true });
  }
}

function renameWithRetry(sourcePath, targetPath) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      fs.renameSync(sourcePath, targetPath);
      return;
    } catch (error) {
      if (!['EPERM', 'EACCES', 'EBUSY'].includes(error?.code) || attempt >= ATOMIC_RENAME_RETRIES) throw error;
      // Windows readers/AV can hold the destination briefly; bounded retry preserves atomic replacement.
      const wait = new Int32Array(new SharedArrayBuffer(4));
      Atomics.wait(wait, 0, 0, ATOMIC_RENAME_DELAY_MS);
    }
  }
}

export function readJsonIfExists(filePath, fallback) {
  if (!fs.existsSync(filePath)) {
    return fallback;
  }
  const primary = fs.readFileSync(filePath, "utf8");
  try {
    return JSON.parse(primary);
  } catch (primaryError) {
    const backupPath = `${filePath}.bak`;
    if (!fs.existsSync(backupPath)) throw primaryError;
    let recovered;
    try {
      recovered = JSON.parse(fs.readFileSync(backupPath, "utf8"));
    } catch {
      throw primaryError;
    }
    fs.renameSync(filePath, `${filePath}.corrupt-${Date.now()}`);
    atomicWriteText(filePath, `${JSON.stringify(recovered, null, 2)}\n`);
    return recovered;
  }
}

export function findStateDatabases(codexDir) {
  if (!fs.existsSync(codexDir)) {
    return [];
  }
  return fs
    .readdirSync(codexDir)
    .filter((name) => /^state_.*\.sqlite$/.test(name))
    .map((name) => path.join(codexDir, name))
    .sort();
}

export function latestMatchingFiles(rootDir, namePattern, options = {}) {
  if (!fs.existsSync(rootDir)) {
    return [];
  }

  const recursive = options.recursive !== false;
  const results = [];
  const stack = [rootDir];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (recursive) {
          stack.push(fullPath);
        }
        continue;
      }
      if (!entry.isFile() || !namePattern.test(entry.name)) {
        continue;
      }
      try {
        const stat = fs.statSync(fullPath);
        results.push({ path: fullPath, mtimeMs: stat.mtimeMs, size: stat.size });
      } catch {}
    }
  }
  return results;
}
