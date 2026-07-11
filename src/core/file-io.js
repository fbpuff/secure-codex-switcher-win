import fs from "node:fs";
import path from "node:path";

export function atomicWriteJson(filePath, value) {
  atomicWriteText(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

export function atomicWriteText(filePath, value) {
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(tempPath, value, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tempPath, filePath);
}

export function readJsonIfExists(filePath, fallback) {
  if (!fs.existsSync(filePath)) {
    return fallback;
  }
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
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
