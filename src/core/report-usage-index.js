import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { atomicWriteJson, latestMatchingFiles, readJsonIfExists } from "./file-io.js";
import { createRolloutParserState, parseRolloutText } from "./usage-observations.js";

const REPORT_INDEX_VERSION = 4;
const HASH_READ_BYTES = 1024 * 1024;
const USAGE_FIELDS = ["inputTokens", "cachedInputTokens", "outputTokens", "reasoningOutputTokens", "totalTokens"];
const EVENT_FIELDS = ["timestampMs", "sessionId", "model", "reasoningEffort", ...USAGE_FIELDS, "durationMs"];

export function readIndexedRolloutUsageEvents({ codexDir, cachePath, startMs = -Infinity, endMs = Infinity, diagnostics = {} }) {
  for (const key of ["bytesRead", "verificationBytesRead", "filesReused", "filesAppended", "filesRebuilt"]) diagnostics[key] ??= 0;
  const cache = readIndex(cachePath);
  const next = { version: REPORT_INDEX_VERSION, files: {} };
  let changed = false;

  for (const listed of rolloutFiles(codexDir)) {
    const file = fileMetadata(listed.path);
    const key = fileKey(file.path);
    const cached = cache.files[key];
    let entry;
    if (sameFileVersion(cached, file)) {
      entry = cached;
      increment(diagnostics, "filesReused");
    } else if (canAppend(cached, file)) {
      entry = appendEntry(cached, file, diagnostics);
      if (entry) {
        increment(diagnostics, "filesAppended");
      } else {
        entry = rebuildEntry(file, diagnostics);
        increment(diagnostics, "filesRebuilt");
      }
      changed = true;
    } else {
      entry = rebuildEntry(file, diagnostics);
      increment(diagnostics, "filesRebuilt");
      changed = true;
    }
    next.files[key] = entry;
  }

  if (Object.keys(cache.files).some((filePath) => !next.files[filePath])) changed = true;
  if (cachePath && changed) {
    atomicWriteJson(cachePath, next, { backup: false });
    fs.rmSync(`${cachePath}.bak`, { force: true });
  }
  return indexedEvents(next, startMs, endMs);
}

function readIndex(cachePath) {
  const empty = { version: REPORT_INDEX_VERSION, files: {} };
  if (!cachePath) return empty;
  try {
    const value = readJsonIfExists(cachePath, empty);
    return value?.version === REPORT_INDEX_VERSION && exactKeys(value, ["version", "files"]) && isRecord(value.files) ? value : empty;
  } catch {
    return empty;
  }
}

function rolloutFiles(codexDir) {
  return [
    ...latestMatchingFiles(path.join(codexDir, "sessions"), /^rollout-.*\.jsonl$/),
    ...latestMatchingFiles(path.join(codexDir, "archived_sessions"), /^rollout-.*\.jsonl$/)
  ];
}

function fileMetadata(filePath) {
  const stat = fs.statSync(filePath);
  return {
    path: filePath,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    identity: `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`
  };
}

function sameFileVersion(cached, file) {
  return Boolean(validEntry(cached) && cached.identity === file.identity && cached.size === file.size && cached.mtimeMs === file.mtimeMs);
}

function canAppend(cached, file) {
  return Boolean(
    validEntry(cached) &&
    cached.identity === file.identity &&
    file.size > cached.size
  );
}

function validEntry(entry) {
  return Boolean(
    exactKeys(entry, ["size", "mtimeMs", "identity", "offset", "state", "events", "fingerprint"]) &&
    typeof entry.identity === "string" &&
    Number.isInteger(entry.size) && entry.size >= 0 &&
    Number.isFinite(entry.mtimeMs) &&
    Number.isInteger(entry.offset) &&
    entry.offset >= 0 &&
    entry.offset <= entry.size &&
    validParserState(entry.state) &&
    validFingerprint(entry.fingerprint, entry.offset) &&
    Array.isArray(entry.events) &&
    entry.events.every(validEvent)
  );
}

function rebuildEntry(file, diagnostics) {
  const entry = {
    size: file.size,
    mtimeMs: file.mtimeMs,
    identity: file.identity,
    offset: 0,
    state: createRolloutParserState(file.path),
    events: [],
    fingerprint: undefined
  };
  const bytes = readStableSlice(file.path, 0, file);
  increment(diagnostics, "bytesRead", bytes.length);
  const complete = parseCompleteBytes(entry, bytes);
  entry.fingerprint = { offset: entry.offset, sha256: digest(complete) };
  return entry;
}

function appendEntry(cached, file, diagnostics) {
  const prefixHash = hashCommittedPrefix(file.path, cached.offset, diagnostics);
  if (prefixHash.copy().digest("hex") !== cached.fingerprint.sha256) return undefined;
  const entry = {
    ...cached,
    state: { ...cached.state },
    events: [...(cached.events ?? [])]
  };
  const bytes = readStableSlice(file.path, entry.offset, file);
  increment(diagnostics, "bytesRead", bytes.length);
  const complete = parseCompleteBytes(entry, bytes);
  entry.size = file.size;
  entry.mtimeMs = file.mtimeMs;
  entry.identity = file.identity;
  prefixHash.update(complete);
  entry.fingerprint = { offset: entry.offset, sha256: prefixHash.digest("hex") };
  return entry;
}

function parseCompleteBytes(entry, bytes) {
  const completeLength = bytes.lastIndexOf(10) + 1;
  const complete = bytes.subarray(0, completeLength);
  if (completeLength > 0) {
    const seen = new Set(entry.events.map(eventKey));
    parseRolloutText(complete.toString("utf8"), entry.state, entry.events, seen);
    entry.offset += completeLength;
  }
  return complete;
}

function readStableSlice(filePath, start, expected) {
  const length = Math.max(0, expected.size - start);
  const bytes = Buffer.alloc(length);
  const handle = fs.openSync(filePath, "r");
  try {
    let bytesRead = 0;
    while (bytesRead < length) {
      const count = fs.readSync(handle, bytes, bytesRead, length - bytesRead, start + bytesRead);
      if (count === 0) throw new Error("Rollout ended while building the local report index");
      bytesRead += count;
    }
  } finally {
    fs.closeSync(handle);
  }
  const after = fileMetadata(filePath);
  if (after.identity !== expected.identity || after.size !== expected.size || after.mtimeMs !== expected.mtimeMs) {
    throw new Error("Rollout changed while building the local report index");
  }
  return bytes;
}

function indexedEvents(index, startMs, endMs) {
  const events = [];
  const seen = new Set();
  for (const entry of Object.values(index.files)) {
    for (const event of entry.events ?? []) {
      if (event.timestampMs < startMs || event.timestampMs >= endMs) continue;
      const key = eventKey(event);
      if (seen.has(key)) continue;
      seen.add(key);
      events.push(event);
    }
  }
  return events.sort((left, right) => left.timestampMs - right.timestampMs);
}

function eventKey(event) {
  return `${event.sessionId}|${event.timestampMs}|${event.totalTokens}|${event.inputTokens}|${event.outputTokens}`;
}

function fileKey(filePath) {
  return crypto.createHash("sha256").update(path.resolve(filePath)).digest("hex");
}

function validParserState(state) {
  return Boolean(
    isRecord(state) &&
    hasOnlyKeys(state, ["model", "reasoningEffort", "sessionId", "previousCumulative"]) &&
    validLabel(state.model) &&
    validLabel(state.reasoningEffort) &&
    validSessionId(state.sessionId) &&
    (state.previousCumulative === undefined || validUsage(state.previousCumulative))
  );
}

function validEvent(event) {
  return Boolean(
    exactKeys(event, EVENT_FIELDS) &&
    Number.isFinite(event.timestampMs) &&
    validSessionId(event.sessionId) &&
    validLabel(event.model) &&
    validLabel(event.reasoningEffort) &&
    validUsage(event, false) &&
    Number.isFinite(event.durationMs) && event.durationMs >= 0
  );
}

function validUsage(value, exact = true) {
  return Boolean(
    isRecord(value) &&
    (!exact || exactKeys(value, USAGE_FIELDS)) &&
    USAGE_FIELDS.every((key) => Number.isFinite(value[key]) && value[key] >= 0)
  );
}

function validFingerprint(value, offset) {
  return Boolean(
    exactKeys(value, ["offset", "sha256"]) &&
    value.offset === offset &&
    /^[a-f0-9]{64}$/.test(value.sha256)
  );
}

function hashCommittedPrefix(filePath, offset, diagnostics) {
  const hash = crypto.createHash("sha256");
  const handle = fs.openSync(filePath, "r");
  try {
    let position = 0;
    while (position < offset) {
      const length = Math.min(HASH_READ_BYTES, offset - position);
      const bytes = Buffer.allocUnsafe(length);
      const count = fs.readSync(handle, bytes, 0, length, position);
      if (count !== length) throw new Error("Rollout prefix changed while verifying the local report index");
      hash.update(bytes);
      increment(diagnostics, "verificationBytesRead", count);
      position += count;
    }
  } finally {
    fs.closeSync(handle);
  }
  return hash;
}

function digest(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function validSessionId(value) {
  return typeof value === "string" && /^[a-f0-9]{16}$/.test(value);
}

function validLabel(value) {
  return typeof value === "string" && /^[a-zA-Z0-9._-]{1,80}$/.test(value);
}

function isRecord(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function hasOnlyKeys(value, allowed) {
  return isRecord(value) && Object.keys(value).every((key) => allowed.includes(key));
}

function exactKeys(value, expected) {
  return hasOnlyKeys(value, expected) && expected.every((key) => Object.hasOwn(value, key));
}

function increment(target, key, amount = 1) {
  target[key] = (target[key] ?? 0) + amount;
}
