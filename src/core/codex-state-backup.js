import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { DatabaseSync } from "node:sqlite";
import { protectString, unprotectString } from "./dpapi.js";
import { atomicWriteJson, atomicWriteText } from "./file-io.js";

const CRITICAL_ROLES = [
  ["global-state", ".codex-global-state.json"],
  ["thread-database", "state_5.sqlite"],
  ["session-index", "session_index.jsonl"]
];
const BLOB_MAGIC = Buffer.from("SCSBLOB1");
const MAX_PROTECTED_KEY_BYTES = 64 * 1024;
const CONVERSATION_VALIDATION_ATTEMPTS = 3;
const QUARANTINE_REASON_CODES = new Set(["invalid_manifest", "integrity_failure", "needs_revalidation"]);
const criticalReadinessCache = new Map();
const GLOBAL_FIELDS = {
  projects: ["local-projects", "projects"],
  projectOrder: ["project-order", "projectOrder"],
  writableRoots: ["project-writable-roots", "projectWritableRoots"],
  workspaceHints: ["thread-workspace-root-hints", "threadWorkspaceHints"],
  assignments: ["thread-project-assignments", "threadProjectAssignments"],
  environmentRoots: ["electron-saved-workspace-roots", "environmentRoots"],
  uiState: ["electron-persisted-atom-state", "electronPersistedAtomState"]
};
const GLOBAL_FIELD_VALIDATORS = {
  projects: isPlainObject,
  projectOrder: Array.isArray,
  writableRoots: isPlainObject,
  workspaceHints: isPlainObject,
  assignments: isPlainObject,
  environmentRoots: Array.isArray,
  uiState: isPlainObject
};

export async function createConversationBackup({
  codexDir,
  backupRoot,
  now = Date.now,
  protectKey = protectString,
  unprotectKey = unprotectString,
  onProgress = () => {},
  mode = "full",
  checkpointId,
  checkpointStartedAt
}) {
  if (!["full", "incremental"].includes(mode)) throw new Error("Invalid conversation backup mode");
  const conversationRoot = path.join(backupRoot, "codex-state", "conversations");
  const blobRoot = path.join(conversationRoot, "blobs");
  const manifestRoot = path.join(conversationRoot, "manifests");
  fs.mkdirSync(blobRoot, { recursive: true });
  reportConversationBackupProgress(onProgress, { stage: "discovering" });
  const sources = conversationSourceInventory(codexDir);
  const prior = mode === "incremental" ? latestConversationManifest(manifestRoot) : undefined;
  const priorFiles = prior ? conversationManifestFileMap(prior.manifest, unprotectKey) : new Map();
  const totals = {
    processedFiles: 0,
    totalFiles: sources.length,
    processedBytes: 0,
    totalBytes: sources.reduce((sum, source) => sum + source.bytes, 0)
  };
  reportConversationBackupProgress(onProgress, { stage: "processing", ...totals });
  const files = [];
  let changed = !prior || prior.manifest.files.length !== sources.length;
  for (const item of sources) {
    const scope = item.scope === "sessions" ? "active" : "archived";
    const relativePath = path.relative(path.join(codexDir, item.scope), item.source);
    const previous = priorFiles.get(`${scope}\0${relativePath}`);
    if (previous && previous.bytes === item.bytes && previous.mtimeMs === item.mtimeMs) {
      encryptedBlobMetadata(path.join(blobRoot, previous.blob), unprotectKey);
      files.push(previous);
    } else {
      changed = true;
      const sourceMetadata = stableFileMetadata(item.source);
      if (sourceMetadata.bytes !== item.bytes || sourceMetadata.mtimeMs !== item.mtimeMs) throw new Error("Source changed while hashing");
      const contentHash = sourceMetadata.sha256;
      const blobName = `${contentHash}.scsb`;
      const blobPath = path.join(blobRoot, blobName);
      await ensureConversationBlob(item.source, blobPath, sourceMetadata, protectKey, unprotectKey, mode === "full");
      files.push({
        scope,
        pathDpapi: protectKey(relativePath),
        sha256: contentHash,
        bytes: sourceMetadata.bytes,
        mtimeMs: sourceMetadata.mtimeMs,
        blob: blobName
      });
    }
    totals.processedFiles += 1;
    totals.processedBytes += item.bytes;
    reportConversationBackupProgress(onProgress, { stage: "processing", ...totals });
  }
  if (!sameConversationInventory(sources, conversationSourceInventory(codexDir))) throw new Error("Conversation source inventory changed during backup");
  if (mode === "incremental" && !changed) {
    reportConversationBackupProgress(onProgress, { stage: "completed", ...totals });
    return { manifestPath: prior.manifestPath, manifest: prior.manifest, unchanged: true };
  }
  reportConversationBackupProgress(onProgress, { stage: "validating", ...totals });
  const timestamp = now();
  const manifest = {
    version: 1,
    kind: "conversations",
    createdAt: new Date(timestamp).toISOString(),
    complete: true,
    counts: {
      activeSessions: files.filter((file) => file.scope === "active").length,
      archivedSessions: files.filter((file) => file.scope === "archived").length
    },
    ...(checkpointId ? { checkpointId, checkpointStartedAt: new Date(checkpointStartedAt).toISOString() } : {}),
    files
  };
  const manifestPath = path.join(manifestRoot, `conversation-manifest-${timestamp}.json`);
  const pendingManifestPath = `${manifestPath}.pending-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
  try {
    atomicWriteJson(pendingManifestPath, manifest, { backup: false });
    await inspectConversationBackup(pendingManifestPath, { unprotectKey, full: mode === "full", onProgress });
    fs.renameSync(pendingManifestPath, manifestPath);
  } finally {
    fs.rmSync(pendingManifestPath, { force: true });
  }
  reportConversationBackupProgress(onProgress, { stage: "pruning", ...totals });
  if (!checkpointId) await pruneConversationBackups(manifestRoot, blobRoot, 3, unprotectKey, mode === "full");
  reportConversationBackupProgress(onProgress, { stage: "completed", ...totals });
  return { manifestPath, manifest };
}

function reportConversationBackupProgress(callback, value) {
  try {
    callback(value)?.catch?.(() => {});
  } catch {}
}

export async function inspectConversationBackup(manifestPath, {
  unprotectKey = unprotectString,
  full = true,
  onProgress = () => {},
  verifiedBlobs
} = {}) {
  const { manifest, activeSessions, archivedSessions } = readConversationManifestStructure(manifestPath);
  const verified = verifiedBlobs ?? new Map();
  const totals = {
    processedFiles: 0,
    totalFiles: new Set(manifest.files.map((file) => file?.blob).filter(Boolean)).size,
    processedBytes: 0,
    totalBytes: [...new Map(manifest.files.map((file) => [file?.blob, file?.bytes])).values()].reduce((sum, bytes) => sum + (Number(bytes) || 0), 0)
  };
  reportConversationBackupProgress(onProgress, { stage: "validating", ...totals });
  for (const file of manifest.files) {
    if (full) unprotectKey(file.pathDpapi);
    const blobPath = path.join(path.dirname(path.dirname(manifestPath)), "blobs", file.blob);
    let result = verified.get(file.blob);
    if (!result) {
      result = full
        ? await decryptConversationBlob(blobPath, unprotectKey)
        : { sha256: file.sha256, bytes: encryptedBlobStructure(blobPath).bytes };
      verified.set(file.blob, result);
      totals.processedFiles += 1;
      totals.processedBytes += file.bytes;
      reportConversationBackupProgress(onProgress, { stage: "validating", ...totals });
    }
    if (result.sha256 !== file.sha256 || result.bytes !== file.bytes) throw new Error("Conversation backup hash or length mismatch");
  }
  return {
    valid: true,
    activeSessions,
    archivedSessions,
    files: manifest.files.length
  };
}

function readConversationManifestStructure(manifestPath) {
  const source = fs.readFileSync(manifestPath, "utf8");
  let manifest;
  try {
    manifest = JSON.parse(source);
  } catch {
    throw new Error("Invalid conversation backup manifest");
  }
  if (manifest?.version !== 1 || manifest.kind !== "conversations" || manifest.complete !== true || !Array.isArray(manifest.files) || !isPlainObject(manifest.counts)) {
    throw new Error("Invalid conversation backup manifest");
  }
  for (const file of manifest.files) {
    if (
      !isPlainObject(file) ||
      !["active", "archived"].includes(file.scope) ||
      typeof file.pathDpapi !== "string" ||
      !/^[a-f0-9]{64}$/.test(file.sha256) ||
      !Number.isSafeInteger(file.bytes) || file.bytes < 0 ||
      (file.mtimeMs !== undefined && (!Number.isFinite(file.mtimeMs) || file.mtimeMs < 0)) ||
      file.blob !== `${file.sha256}.scsb`
    ) throw new Error("Invalid conversation backup file entry");
  }
  const activeSessions = manifest.files.filter((file) => file.scope === "active").length;
  const archivedSessions = manifest.files.filter((file) => file.scope === "archived").length;
  if (manifest.counts.activeSessions !== activeSessions || manifest.counts.archivedSessions !== archivedSessions) {
    throw new Error("Conversation backup aggregate counts mismatch");
  }
  return { manifest, activeSessions, archivedSessions };
}

function readConversationManifestSummary(manifestPath) {
  const { manifest, activeSessions, archivedSessions } = readConversationManifestStructure(manifestPath);
  if (typeof manifest.createdAt !== "string" || !Number.isFinite(Date.parse(manifest.createdAt))) {
    throw new Error("Invalid recovery backup time");
  }
  return {
    backupTime: manifest.createdAt,
    counts: { active: activeSessions, archived: archivedSessions }
  };
}

async function validateConversationBackupWithRetries(manifestPath, {
  unprotectKey = unprotectString,
  full = true,
  onProgress = () => {},
  verifiedBlobs
} = {}) {
  const failures = [];
  for (let attempt = 1; attempt <= CONVERSATION_VALIDATION_ATTEMPTS; attempt += 1) {
    try {
      await inspectConversationBackup(manifestPath, { unprotectKey, full, onProgress, verifiedBlobs });
      return { valid: true, summary: readConversationManifestSummary(manifestPath), attempts: attempt };
    } catch (error) {
      failures.push(classifyConversationValidationFailure(error));
    }
  }
  const quarantineReason = failures.every((reason) => reason && reason === failures[0]) ? failures[0] : undefined;
  return { valid: false, attempts: CONVERSATION_VALIDATION_ATTEMPTS, quarantineReason };
}

function classifyConversationValidationFailure(error) {
  const message = String(error?.message || "");
  if ([
    "Invalid conversation backup manifest",
    "Invalid conversation backup file entry",
    "Conversation backup aggregate counts mismatch",
    "Invalid recovery backup time"
  ].includes(message)) return "invalid_manifest";
  if (
    /^(Conversation backup hash or length mismatch|Invalid encrypted conversation blob(?: metadata)?|Truncated encrypted conversation blob|Invalid protected conversation key)$/.test(message) ||
    /unable to authenticate data/i.test(message)
  ) return "integrity_failure";
  return undefined;
}

export async function listCodexRecoveryBackups({ backupRoot, unprotectKey = unprotectString, full = true, onProgress = () => {} }) {
  const { critical, conversations, quarantinedConversations, unavailableConversationBackups } = await discoverCodexRecoveryBackups({
    backupRoot,
    unprotectKey,
    full,
    onProgress
  });
  return {
    completeRecoveryPoints: listCompleteRecoveryPoints({ backupRoot, critical, conversations }),
    criticalGenerations: critical.map(({ sourcePath, ...summary }) => summary),
    conversationGenerations: conversations.map(({ sourcePath, ...summary }) => summary),
    quarantinedConversationGenerations: quarantinedConversations,
    unavailableConversationBackups
  };
}

export async function revalidateQuarantinedConversationBackup({
  backupRoot,
  conversationId,
  unprotectKey = unprotectString,
  onProgress = () => {}
}) {
  assertConversationGenerationId(conversationId);
  const conversationRoot = path.join(backupRoot, "codex-state", "conversations");
  const quarantineRoot = path.join(conversationRoot, "quarantine");
  const name = findConversationManifestName(quarantineRoot, conversationId);
  if (!name) throw new Error("Unknown quarantined conversation recovery generation");
  const sourcePath = path.join(quarantineRoot, name);
  const validation = await validateConversationBackupWithRetries(sourcePath, { unprotectKey, onProgress });
  if (!validation.valid) throw new Error("Quarantined conversation backup is not currently valid");

  const manifestRoot = path.join(conversationRoot, "manifests");
  const targetName = canonicalConversationManifestName(name);
  const targetPath = path.join(manifestRoot, targetName);
  if (fs.existsSync(targetPath)) throw new Error("Active conversation recovery generation already exists");
  fs.mkdirSync(manifestRoot, { recursive: true });
  fs.renameSync(sourcePath, targetPath);
  fs.rmSync(conversationQuarantineReasonPath(quarantineRoot, name), { force: true });
  const summary = readConversationManifestSummary(targetPath);
  return {
    generationId: recoveryGenerationId("conversation", targetName),
    backupTime: summary.backupTime,
    counts: summary.counts
  };
}

export function createCompleteRecoveryPoint({ backupRoot, checkpointId, checkpointStartedAt, critical, conversations }) {
  if (typeof checkpointId !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(checkpointId)) throw new Error("Invalid checkpoint ID");
  inspectCriticalSnapshot(critical.generationDir);
  const checkpointTime = new Date(checkpointStartedAt).toISOString();
  if (
    critical.manifest?.checkpointId !== checkpointId ||
    critical.manifest?.checkpointStartedAt !== checkpointTime ||
    (!conversations.unchanged && (
      conversations.manifest?.checkpointId !== checkpointId ||
      conversations.manifest?.checkpointStartedAt !== checkpointTime
    ))
  ) {
    throw new Error("Checkpoint layers do not belong to the same operation");
  }
  const criticalName = path.basename(critical.generationDir);
  const conversationName = path.basename(conversations.manifestPath);
  const root = completeRecoveryPointRoot(backupRoot);
  fs.mkdirSync(root, { recursive: true });
  const manifest = {
    version: 1,
    kind: "complete-recovery-point",
    complete: true,
    checkpointId,
    checkpointTime,
    conversationReused: conversations.unchanged === true,
    criticalCapturedAt: critical.manifest.createdAt,
    conversationCapturedAt: conversations.manifest.createdAt,
    criticalGeneration: criticalName,
    conversationManifest: conversationName,
    counts: {
      projects: critical.manifest.counts.projects,
      assignments: critical.manifest.counts.assignments,
      threads: critical.manifest.counts.threads,
      active: conversations.manifest.counts.activeSessions,
      archived: conversations.manifest.counts.archivedSessions
    }
  };
  const manifestPath = path.join(root, `checkpoint-${checkpointId}.json`);
  try {
    atomicWriteJson(manifestPath, manifest, { backup: false });
    inspectCompleteRecoveryPoint({ backupRoot, manifestPath });
  } catch (error) {
    fs.rmSync(manifestPath, { force: true });
    throw error;
  }
  pruneCompleteRecoveryPoints(backupRoot, 10);
  pruneRecoveryLayersForCompletePoints(backupRoot);
  return { recoveryPointId: checkpointId, manifestPath, manifest };
}

export async function resolveCompleteRecoveryPoint({ backupRoot, recoveryPointId, unprotectKey = unprotectString }) {
  if (typeof recoveryPointId !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(recoveryPointId)) throw new Error("Invalid complete recovery point ID");
  const manifestPath = path.join(completeRecoveryPointRoot(backupRoot), `checkpoint-${recoveryPointId}.json`);
  const resolved = inspectCompleteRecoveryPoint({ backupRoot, manifestPath });
  return { criticalGenerationDir: resolved.criticalGenerationDir, conversationManifestPath: resolved.conversationManifestPath };
}

function completeRecoveryPointRoot(backupRoot) {
  return path.join(backupRoot, "codex-state", "checkpoints");
}

function inspectCompleteRecoveryPoint({ backupRoot, manifestPath }) {
  const root = completeRecoveryPointRoot(backupRoot);
  if (path.dirname(path.resolve(manifestPath)) !== path.resolve(root)) throw new Error("Invalid checkpoint manifest path");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (
    manifest?.version !== 1 ||
    manifest.kind !== "complete-recovery-point" ||
    manifest.complete !== true ||
    typeof manifest.checkpointId !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/.test(manifest.checkpointId) ||
    path.basename(manifestPath) !== `checkpoint-${manifest.checkpointId}.json` ||
    typeof manifest.criticalGeneration !== "string" ||
    path.basename(manifest.criticalGeneration) !== manifest.criticalGeneration ||
    typeof manifest.conversationManifest !== "string" ||
    path.basename(manifest.conversationManifest) !== manifest.conversationManifest ||
    typeof manifest.conversationReused !== "boolean" ||
    !Number.isFinite(Date.parse(manifest.checkpointTime)) ||
    !Number.isFinite(Date.parse(manifest.criticalCapturedAt)) ||
    !Number.isFinite(Date.parse(manifest.conversationCapturedAt)) ||
    !isPlainObject(manifest.counts)
  ) throw new Error("Invalid complete recovery point manifest");
  const criticalGenerationDir = path.join(backupRoot, "codex-state", "critical", manifest.criticalGeneration);
  const conversationManifestPath = path.join(backupRoot, "codex-state", "conversations", "manifests", manifest.conversationManifest);
  const criticalManifest = readCriticalManifestStructure(criticalGenerationDir);
  const { manifest: conversationManifest } = readConversationManifestStructure(conversationManifestPath);
  const sameCritical = criticalManifest.checkpointId === manifest.checkpointId &&
    criticalManifest.checkpointStartedAt === manifest.checkpointTime &&
    criticalManifest.createdAt === manifest.criticalCapturedAt &&
    criticalManifest.counts.projects === manifest.counts.projects &&
    criticalManifest.counts.assignments === manifest.counts.assignments &&
    criticalManifest.counts.threads === manifest.counts.threads;
  const sameConversation = conversationManifest.createdAt === manifest.conversationCapturedAt &&
    conversationManifest.counts.activeSessions === manifest.counts.active &&
    conversationManifest.counts.archivedSessions === manifest.counts.archived &&
    (manifest.conversationReused || (
      conversationManifest.checkpointId === manifest.checkpointId &&
      conversationManifest.checkpointStartedAt === manifest.checkpointTime
    ));
  if (!sameCritical || !sameConversation) throw new Error("Complete recovery point layer binding mismatch");
  return { manifest, criticalGenerationDir, conversationManifestPath };
}

function listCompleteRecoveryPoints({ backupRoot, critical, conversations }) {
  const root = completeRecoveryPointRoot(backupRoot);
  if (!fs.existsSync(root)) return [];
  const criticalNames = new Set(critical.map((item) => path.basename(item.sourcePath)));
  const conversationNames = new Set(conversations.map((item) => path.basename(item.sourcePath)));
  const points = [];
  for (const name of fs.readdirSync(root).filter((item) => item.endsWith(".json")).sort().reverse()) {
    try {
      const { manifest } = inspectCompleteRecoveryPoint({ backupRoot, manifestPath: path.join(root, name) });
      if (!criticalNames.has(manifest.criticalGeneration) || !conversationNames.has(manifest.conversationManifest)) continue;
      points.push({
        recoveryPointId: manifest.checkpointId,
        checkpointTime: manifest.checkpointTime,
        criticalCapturedAt: manifest.criticalCapturedAt,
        conversationCapturedAt: manifest.conversationCapturedAt,
        counts: {
          projects: Number(manifest.counts.projects) || 0,
          assignments: Number(manifest.counts.assignments) || 0,
          threads: Number(manifest.counts.threads) || 0,
          active: Number(manifest.counts.active) || 0,
          archived: Number(manifest.counts.archived) || 0
        }
      });
    } catch {}
  }
  return points.sort((left, right) => Date.parse(right.checkpointTime) - Date.parse(left.checkpointTime));
}

function pruneCompleteRecoveryPoints(backupRoot, limit) {
  const root = completeRecoveryPointRoot(backupRoot);
  const valid = [];
  for (const name of fs.readdirSync(root).filter((item) => item.endsWith(".json")).sort()) {
    try {
      const { manifest } = inspectCompleteRecoveryPoint({ backupRoot, manifestPath: path.join(root, name) });
      valid.push({ name, checkpointTime: manifest.checkpointTime });
    } catch {
      fs.rmSync(path.join(root, name), { force: true });
    }
  }
  valid.sort((left, right) => Date.parse(left.checkpointTime) - Date.parse(right.checkpointTime));
  for (const item of valid.slice(0, Math.max(0, valid.length - limit))) fs.rmSync(path.join(root, item.name), { force: true });
}

function pruneRecoveryLayersForCompletePoints(backupRoot) {
  const checkpointRoot = completeRecoveryPointRoot(backupRoot);
  const protectedCritical = new Set();
  const protectedConversations = new Set();
  for (const name of fs.readdirSync(checkpointRoot).filter((item) => item.endsWith(".json"))) {
    try {
      const { manifest } = inspectCompleteRecoveryPoint({ backupRoot, manifestPath: path.join(checkpointRoot, name) });
      protectedCritical.add(manifest.criticalGeneration);
      protectedConversations.add(manifest.conversationManifest);
    } catch {}
  }
  pruneCriticalSnapshots(path.join(backupRoot, "codex-state", "critical"), 10, inspectCriticalSnapshot, protectedCritical);
  const manifestRoot = path.join(backupRoot, "codex-state", "conversations", "manifests");
  const blobRoot = path.join(backupRoot, "codex-state", "conversations", "blobs");
  if (!fs.existsSync(manifestRoot)) return;
  const manifests = conversationManifestNames(manifestRoot);
  const retained = new Set([...manifests.slice(-3), ...[...protectedConversations].filter((name) => manifests.includes(name))]);
  for (const name of manifests) if (!retained.has(name)) fs.rmSync(path.join(manifestRoot, name), { force: true });
  const referenced = new Set();
  let completeReferences = true;
  for (const name of retained) completeReferences = addConversationManifestBlobReferences(path.join(manifestRoot, name), referenced) && completeReferences;
  completeReferences = addQuarantinedConversationBlobReferences(path.join(backupRoot, "codex-state", "conversations", "quarantine"), referenced) && completeReferences;
  if (!completeReferences) return;
  if (fs.existsSync(blobRoot)) for (const name of fs.readdirSync(blobRoot).filter((item) => item.endsWith(".scsb") && !item.includes(".pending"))) {
    if (!referenced.has(name)) fs.rmSync(path.join(blobRoot, name), { force: true });
  }
}

export async function resolveCodexRecoverySelection({ backupRoot, criticalId, conversationId, unprotectKey = unprotectString }) {
  for (const generationId of [criticalId, conversationId]) {
    if (typeof generationId !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(generationId)) {
      throw new Error("Invalid recovery generation ID");
    }
  }
  const criticalRoot = path.join(backupRoot, "codex-state", "critical");
  const criticalName = fs.existsSync(criticalRoot)
    ? fs.readdirSync(criticalRoot, { withFileTypes: true }).find((entry) => entry.isDirectory() && entry.name.startsWith("critical-") && recoveryGenerationId("critical", entry.name) === criticalId)?.name
    : undefined;
  if (!criticalName) throw new Error("Unknown or unavailable critical recovery generation");
  const criticalGenerationDir = path.join(criticalRoot, criticalName);
  readCriticalManifestStructure(criticalGenerationDir);
  const manifestRoot = path.join(backupRoot, "codex-state", "conversations", "manifests");
  const conversationName = conversationManifestNames(manifestRoot)
    .find((name) => recoveryGenerationId("conversation", name) === conversationId);
  if (!conversationName) throw new Error("Unknown or unavailable conversation recovery generation");
  const conversationManifestPath = path.join(manifestRoot, conversationName);
  readConversationManifestStructure(conversationManifestPath);
  return {
    criticalGenerationDir,
    conversationManifestPath
  };
}

export async function previewCodexRecovery({ criticalGenerationDir, conversationManifestPath, liveCodexDir, unprotectKey = unprotectString, onProgress = () => {} }) {
  reportRecoveryProgress(onProgress, { stage: "discovering" });
  const critical = inspectCriticalSnapshot(criticalGenerationDir);
  const conversations = await inspectConversationBackup(conversationManifestPath, {
    unprotectKey,
    onProgress: (value) => reportRecoveryProgress(onProgress, { ...value, stage: "validating_backup" })
  });
  const criticalManifest = JSON.parse(fs.readFileSync(path.join(criticalGenerationDir, "manifest.json"), "utf8"));
  const conversationManifest = JSON.parse(fs.readFileSync(conversationManifestPath, "utf8"));
  let missing = 0;
  let conflicts = 0;
  if (liveCodexDir) {
    const backupGlobal = readValidatedGlobalState(path.join(criticalGenerationDir, ".codex-global-state.json"));
    assertNoDuplicateLocalProjectPaths(backupGlobal);
    const liveGlobal = readValidatedGlobalState(path.join(liveCodexDir, ".codex-global-state.json"));
    const globalDifference = analyzeGlobalState(liveGlobal, backupGlobal, false);
    missing += globalDifference.missing;
    conflicts += globalDifference.conflicts;
    const threadDifference = threadDifferences(path.join(criticalGenerationDir, "state_5.sqlite"), path.join(liveCodexDir, "state_5.sqlite"));
    missing += threadDifference.missing;
    conflicts += threadDifference.conflicts;
    const compareTotals = {
      processedFiles: 0,
      totalFiles: conversationManifest.files.length,
      processedBytes: 0,
      totalBytes: conversationManifest.files.reduce((sum, file) => sum + file.bytes, 0)
    };
    reportRecoveryProgress(onProgress, { stage: "comparing_live", ...compareTotals });
    for (const file of conversationManifest.files) {
      const scope = file.scope === "active" ? "sessions" : "archived_sessions";
      const relativePath = unprotectKey(file.pathDpapi);
      const livePath = safeRelativeTarget(path.join(liveCodexDir, scope), relativePath);
      if (!fs.existsSync(livePath)) missing += 1;
      else if (sha256File(livePath) !== file.sha256) conflicts += 1;
      compareTotals.processedFiles += 1;
      compareTotals.processedBytes += file.bytes;
      reportRecoveryProgress(onProgress, { stage: "comparing_live", ...compareTotals });
    }
  }
  reportRecoveryProgress(onProgress, { stage: "completed", processedFiles: 0, totalFiles: 0, processedBytes: 0, totalBytes: 0 });
  return {
    valid: true,
    backupTime: criticalManifest.createdAt,
    counts: {
      projects: critical.projects,
      projectOrder: critical.projectOrder,
      writableRoots: critical.writableRoots,
      workspaceHints: critical.workspaceHints,
      assignments: critical.assignments,
      environmentRoots: critical.environmentRoots,
      uiState: critical.uiState,
      threads: critical.threads,
      archivedThreads: critical.archivedThreads,
      sessionIndexRows: critical.sessionIndexRows,
      activeSessions: conversations.activeSessions,
      archivedSessions: conversations.archivedSessions
    },
    effects: { missing, conflicts }
  };
}

export function criticalSnapshotContentIdentity(generationDir) {
  inspectCriticalSnapshot(generationDir);
  return contentIdentity([
    ["manifest", path.join(generationDir, "manifest.json")],
    ...CRITICAL_ROLES.map(([role, name]) => [role, path.join(generationDir, name)])
  ]);
}

export async function recoverySelectionContentIdentity({ criticalGenerationDir, conversationManifestPath, unprotectKey = unprotectString, validated = false }) {
  const criticalIdentity = criticalSnapshotContentIdentity(criticalGenerationDir);
  if (!validated) await inspectConversationBackup(conversationManifestPath, { unprotectKey });
  const manifest = JSON.parse(fs.readFileSync(conversationManifestPath, "utf8"));
  const blobRoot = path.join(path.dirname(path.dirname(conversationManifestPath)), "blobs");
  const blobs = [...new Set(manifest.files.map((file) => file.blob))].sort();
  const labelsBefore = blobs.join("\0");
  const conversationIdentity = await contentIdentityAsync([
    ["manifest", conversationManifestPath],
    ...blobs.map((name) => [`blob:${name}`, path.join(blobRoot, name)])
  ]);
  const after = JSON.parse(fs.readFileSync(conversationManifestPath, "utf8"));
  if ([...new Set(after.files.map((file) => file.blob))].sort().join("\0") !== labelsBefore) {
    throw new Error("Conversation backup changed while validating its identity");
  }
  return crypto.createHash("sha256").update(criticalIdentity).update(conversationIdentity).digest("hex");
}

export async function codexLiveContentIdentity(codexDir) {
  const enumerate = () => {
    const files = CRITICAL_ROLES.map(([role, name]) => [`critical:${role}`, path.join(codexDir, name)]);
    for (const scope of ["sessions", "archived_sessions"]) {
      const root = path.join(codexDir, scope);
      for (const filePath of listFiles(root)) files.push([`${scope}:${path.relative(root, filePath).split(path.sep).join("/")}`, filePath]);
    }
    return files.sort(([left], [right]) => left.localeCompare(right));
  };
  const files = enumerate();
  const identity = await contentIdentityAsync(files);
  if (files.map(([label]) => label).join("\0") !== enumerate().map(([label]) => label).join("\0")) {
    throw new Error("Live Codex state changed while validating its identity");
  }
  return identity;
}

export async function restoreCodexBackup({ authorization, criticalGenerationDir, conversationManifestPath, liveCodexDir, unprotectKey = unprotectString, assertBeforeCommit }) {
  if (authorization?.authorized !== true || !["merge", "replace"].includes(authorization.mode)) throw new Error("A restore authorization is required");
  if (authorization.mode === "replace") {
    return replaceCodexBackup({ criticalGenerationDir, conversationManifestPath, liveCodexDir, unprotectKey, assertBeforeCommit });
  }
  inspectCriticalSnapshot(criticalGenerationDir);
  await inspectConversationBackup(conversationManifestPath, { unprotectKey });

  const requiredLive = [".codex-global-state.json", "session_index.jsonl", "state_5.sqlite"];
  for (const name of requiredLive) {
    const livePath = path.join(liveCodexDir, name);
    if (!fs.existsSync(livePath) || !fs.statSync(livePath).isFile()) throw new Error(`Missing live Codex artifact: ${name}`);
    fs.accessSync(livePath, fs.constants.R_OK | fs.constants.W_OK);
  }
  readValidatedGlobalState(path.join(liveCodexDir, ".codex-global-state.json"));
  readValidatedJsonLines(path.join(liveCodexDir, "session_index.jsonl"));
  validateThreadDatabase(path.join(liveCodexDir, "state_5.sqlite"));
  assertMatchingThreadSchemas(path.join(criticalGenerationDir, "state_5.sqlite"), path.join(liveCodexDir, "state_5.sqlite"));
  fs.accessSync(liveCodexDir, fs.constants.W_OK);

  const backupGlobal = readValidatedGlobalState(path.join(criticalGenerationDir, ".codex-global-state.json"));
  assertNoDuplicateLocalProjectPaths(backupGlobal);
  const liveGlobalPath = path.join(liveCodexDir, ".codex-global-state.json");
  const liveGlobal = readValidatedGlobalState(liveGlobalPath);
  const globalResult = analyzeGlobalState(liveGlobal, backupGlobal, true);
  const metadataResult = { restored: globalResult.missing, conflicts: globalResult.conflicts };
  const manifest = JSON.parse(fs.readFileSync(conversationManifestPath, "utf8"));
  const blobRoot = path.join(path.dirname(path.dirname(conversationManifestPath)), "blobs");
  let restoredConversationFiles = 0;
  let conversationConflicts = 0;
  const conversationPlans = [];
  for (const [index, file] of manifest.files.entries()) {
    const root = path.join(liveCodexDir, file.scope === "active" ? "sessions" : "archived_sessions");
    const target = safeRelativeTarget(root, unprotectKey(file.pathDpapi));
    assertNoLinkedRestorePath(root, target);
    if (fs.existsSync(target)) {
      if (!fs.statSync(target).isFile()) throw new Error("Conversation restore target is not a file");
      fs.accessSync(target, fs.constants.R_OK | fs.constants.W_OK);
      if (sha256File(target) !== file.sha256) conversationConflicts += 1;
      continue;
    }
    assertWritableTarget(target);
    conversationPlans.push({ file, target, index, restoreRoot: root });
  }

  const stagingRoot = path.join(path.dirname(liveCodexDir), `.codex-restore.pending-${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`);
  fs.mkdirSync(stagingRoot, { recursive: true });
  try {
    const stagedGlobal = path.join(stagingRoot, ".codex-global-state.json");
    const stagedIndex = path.join(stagingRoot, "session_index.jsonl");
    const stagedDatabase = path.join(stagingRoot, "state_5.sqlite");
    atomicWriteJson(stagedGlobal, liveGlobal, { backup: false });
    fs.copyFileSync(path.join(liveCodexDir, "session_index.jsonl"), stagedIndex);
    const indexResult = mergeSessionIndex(path.join(criticalGenerationDir, "session_index.jsonl"), stagedIndex);
    snapshotSqlite(path.join(liveCodexDir, "state_5.sqlite"), stagedDatabase);
    const databaseResult = mergeThreadDatabase(path.join(criticalGenerationDir, "state_5.sqlite"), stagedDatabase);

    const commitItems = [
      { staged: stagedGlobal, target: liveGlobalPath },
      { staged: stagedIndex, target: path.join(liveCodexDir, "session_index.jsonl") },
      { staged: stagedDatabase, target: path.join(liveCodexDir, "state_5.sqlite") }
    ];
    for (const plan of conversationPlans) {
      const staged = path.join(stagingRoot, "conversations", String(plan.index));
      await decryptConversationBlobToFile(path.join(blobRoot, plan.file.blob), staged, unprotectKey);
      if (sha256File(staged) !== plan.file.sha256 || fs.statSync(staged).size !== plan.file.bytes) {
        throw new Error("Restored conversation file hash or length mismatch");
      }
      commitItems.push({ staged, target: plan.target, restoreRoot: plan.restoreRoot });
      restoredConversationFiles += 1;
    }

    readValidatedGlobalState(stagedGlobal);
    readValidatedJsonLines(stagedIndex);
    validateThreadDatabase(stagedDatabase);
    commitRestoreItems(commitItems, stagingRoot);
    return {
      mode: "merge",
      restoredMetadata: metadataResult.restored + indexResult.restored + databaseResult.restored,
      restoredConversationFiles,
      preservedConflicts: metadataResult.conflicts + indexResult.conflicts + databaseResult.conflicts + conversationConflicts
    };
  } finally {
    fs.rmSync(stagingRoot, { recursive: true, force: true });
  }
}

async function replaceCodexBackup({ criticalGenerationDir, conversationManifestPath, liveCodexDir, unprotectKey, assertBeforeCommit }) {
  inspectCriticalSnapshot(criticalGenerationDir);
  assertNoDuplicateLocalProjectPaths(readValidatedGlobalState(path.join(criticalGenerationDir, ".codex-global-state.json")));
  await inspectConversationBackup(conversationManifestPath, { unprotectKey });
  for (const name of [".codex-global-state.json", "session_index.jsonl", "state_5.sqlite"]) {
    const livePath = path.join(liveCodexDir, name);
    if (!fs.existsSync(livePath) || !fs.statSync(livePath).isFile()) throw new Error(`Missing live Codex artifact: ${name}`);
    fs.accessSync(livePath, fs.constants.R_OK | fs.constants.W_OK);
  }
  assertMatchingThreadSchemas(path.join(criticalGenerationDir, "state_5.sqlite"), path.join(liveCodexDir, "state_5.sqlite"));
  fs.accessSync(liveCodexDir, fs.constants.W_OK);

  const manifest = JSON.parse(fs.readFileSync(conversationManifestPath, "utf8"));
  const blobRoot = path.join(path.dirname(path.dirname(conversationManifestPath)), "blobs");
  const stagingRoot = path.join(path.dirname(liveCodexDir), `.codex-replace.pending-${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`);
  fs.mkdirSync(stagingRoot, { recursive: true });
  try {
    const items = [];
    for (const name of [".codex-global-state.json", "session_index.jsonl", "state_5.sqlite"]) {
      const staged = path.join(stagingRoot, "critical", name);
      fs.mkdirSync(path.dirname(staged), { recursive: true });
      fs.copyFileSync(path.join(criticalGenerationDir, name), staged);
      items.push({ staged, target: path.join(liveCodexDir, name), kind: "file" });
    }
    for (const scope of ["active", "archived"]) {
      const directory = scope === "active" ? "sessions" : "archived_sessions";
      const stagedRoot = path.join(stagingRoot, "conversations", directory);
      fs.mkdirSync(stagedRoot, { recursive: true });
      for (const file of manifest.files.filter((item) => item.scope === scope)) {
        const staged = safeRelativeTarget(stagedRoot, unprotectKey(file.pathDpapi));
        await decryptConversationBlobToFile(path.join(blobRoot, file.blob), staged, unprotectKey);
        if (sha256File(staged) !== file.sha256 || fs.statSync(staged).size !== file.bytes) {
          throw new Error("Restored conversation file hash or length mismatch");
        }
      }
      items.push({ staged: stagedRoot, target: path.join(liveCodexDir, directory), kind: "directory" });
    }
    readValidatedGlobalState(path.join(stagingRoot, "critical", ".codex-global-state.json"));
    readValidatedJsonLines(path.join(stagingRoot, "critical", "session_index.jsonl"));
    validateThreadDatabase(path.join(stagingRoot, "critical", "state_5.sqlite"));
    await assertBeforeCommit?.();
    commitReplacementItems(items, stagingRoot);
    return { mode: "replace", restoredCriticalArtifacts: 3, restoredConversationFiles: manifest.files.length };
  } finally {
    fs.rmSync(stagingRoot, { recursive: true, force: true });
  }
}

export function inventoryLegacyCodexRecoveryFiles(legacyRoot) {
  const seen = new Set();
  return listFiles(legacyRoot)
    .filter((filePath) => /^\.codex-global-state\..+\.json$/i.test(path.basename(filePath)))
    .map((filePath) => {
      const bytes = fs.statSync(filePath).size;
      let classification = "invalid";
      let sha256;
      try {
        const value = readValidatedJson(filePath);
        sha256 = sha256File(filePath);
        if (seen.has(sha256)) classification = "duplicate";
        else if (isCompleteGlobalState(value, true)) classification = "complete";
        else classification = "incomplete";
        seen.add(sha256);
      } catch {}
      return { path: filePath, classification, sha256, bytes };
    });
}

export async function migrateLegacyCodexRecoveryFiles({
  legacyRoot,
  backupRoot,
  removeSource = false,
  now = Date.now,
  protectKey = protectString,
  unprotectKey = unprotectString
}) {
  const inventory = inventoryLegacyCodexRecoveryFiles(legacyRoot);
  const migrationRoot = path.join(backupRoot, "codex-state", "legacy-global-state");
  const blobRoot = path.join(migrationRoot, "blobs");
  fs.mkdirSync(blobRoot, { recursive: true });
  const entries = [];
  for (const item of inventory.filter((candidate) => candidate.classification !== "invalid")) {
    const blob = `${item.sha256}.scsb`;
    const blobPath = path.join(blobRoot, blob);
    await ensureConversationBlob(item.path, blobPath, {
      sha256: item.sha256,
      bytes: item.bytes,
      mtimeMs: fs.statSync(item.path).mtimeMs
    }, protectKey, unprotectKey);
    entries.push({
      classification: item.classification,
      promotable: item.classification === "complete",
      sourceDpapi: protectKey(path.relative(legacyRoot, item.path)),
      sha256: item.sha256,
      bytes: item.bytes,
      blob
    });
  }
  const timestamp = now();
  const manifest = {
    version: 1,
    kind: "legacy-global-state",
    createdAt: new Date(timestamp).toISOString(),
    invalidSources: inventory.filter((item) => item.classification === "invalid").length,
    entries
  };
  const manifestPath = path.join(migrationRoot, `legacy-manifest-${timestamp}.json`);
  const pendingManifestPath = `${manifestPath}.pending-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
  let promoted = false;
  try {
    atomicWriteJson(pendingManifestPath, manifest, { backup: false });
    await inspectLegacyMigrationManifest(pendingManifestPath, legacyRoot, unprotectKey);
    fs.renameSync(pendingManifestPath, manifestPath);
    promoted = true;
    await inspectLegacyMigrationManifest(manifestPath, legacyRoot, unprotectKey);
  } catch (error) {
    if (promoted) fs.rmSync(manifestPath, { force: true });
    throw error;
  } finally {
    fs.rmSync(pendingManifestPath, { force: true });
  }
  if (removeSource) {
    const sources = inventory.filter((candidate) => candidate.classification !== "invalid");
    for (const item of sources) {
      if (!fs.existsSync(item.path) || fs.statSync(item.path).size !== item.bytes || sha256File(item.path) !== item.sha256) {
        throw new Error("Legacy recovery source changed before removal");
      }
    }
    for (const item of sources) fs.rmSync(item.path);
  }
  return { manifestPath, manifest };
}

async function inspectLegacyMigrationManifest(manifestPath, legacyRoot, unprotectKey) {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (manifest?.version !== 1 || manifest.kind !== "legacy-global-state" || !Array.isArray(manifest.entries)) {
    throw new Error("Invalid legacy recovery manifest");
  }
  const blobRoot = path.join(path.dirname(manifestPath), "blobs");
  for (const entry of manifest.entries) {
    if (!["complete", "duplicate", "incomplete"].includes(entry.classification)) throw new Error("Invalid legacy recovery classification");
    safeRelativeTarget(legacyRoot, unprotectKey(entry.sourceDpapi));
    if (entry.promotable !== (entry.classification === "complete")) throw new Error("Invalid legacy recovery promotion status");
    const verified = await decryptConversationBlob(path.join(blobRoot, entry.blob), unprotectKey);
    if (verified.sha256 !== entry.sha256 || verified.bytes !== entry.bytes || entry.blob !== `${entry.sha256}.scsb`) {
      throw new Error("Legacy recovery migration verification failed");
    }
  }
  return manifest;
}

export function createCriticalCodexSnapshot({
  codexDir,
  backupRoot,
  now = Date.now,
  getAvailableBytes = availableBytes,
  inspectSnapshot = inspectCriticalSnapshot,
  checkpointId,
  checkpointStartedAt
}) {
  const criticalRoot = path.join(backupRoot, "codex-state", "critical");
  const generationName = `critical-${new Date(now()).toISOString().replace(/[:.]/g, "-")}`;
  const generationDir = path.join(criticalRoot, generationName);
  const pendingDir = `${generationDir}.pending-${process.pid}`;
  if (fs.existsSync(generationDir) || fs.existsSync(pendingDir)) throw new Error("Critical snapshot generation already exists");

  const sources = Object.fromEntries(CRITICAL_ROLES.map(([role, name]) => [role, path.join(codexDir, name)]));
  for (const [role, source] of Object.entries(sources)) {
    if (!fs.existsSync(source) || !fs.statSync(source).isFile()) throw new Error(`Missing required Codex ${role}`);
  }
  const requiredBytes = Object.values(sources).reduce((total, source) => total + fs.statSync(source).size, 0) + 1024 * 1024;
  if (getAvailableBytes(backupRoot) < requiredBytes) throw new Error("Insufficient D-drive space for critical Codex snapshot");

  const globalState = readValidatedGlobalState(sources["global-state"]);
  const sessionRows = readValidatedJsonLines(sources["session-index"]);
  const sourceStats = new Map(Object.values(sources).map((source) => [source, stableIdentity(source)]));
  fs.mkdirSync(pendingDir, { recursive: true });
  let promoted = false;
  try {
    copyAndVerify(sources["global-state"], path.join(pendingDir, ".codex-global-state.json"));
    snapshotSqlite(sources["thread-database"], path.join(pendingDir, "state_5.sqlite"));
    copyAndVerify(sources["session-index"], path.join(pendingDir, "session_index.jsonl"));

    for (const source of Object.values(sources)) {
      if (sourceStats.get(source) !== stableIdentity(source)) throw new Error(`Codex source changed during snapshot: ${path.basename(source)}`);
    }

    const sqliteCounts = validateThreadDatabase(path.join(pendingDir, "state_5.sqlite"));
    const artifacts = CRITICAL_ROLES.map(([role, name]) => artifactMetadata(role, path.join(pendingDir, name)));
    const manifest = {
      version: 1,
      kind: "critical",
      createdAt: new Date(now()).toISOString(),
      lineage: latestValidGenerationName(criticalRoot, inspectSnapshot),
      validated: true,
      ...(checkpointId ? { checkpointId, checkpointStartedAt: new Date(checkpointStartedAt).toISOString() } : {}),
      counts: {
        projects: collectionCount(globalValue(globalState, "projects")),
        projectOrder: collectionCount(globalValue(globalState, "projectOrder")),
        writableRoots: collectionCount(globalValue(globalState, "writableRoots")),
        workspaceHints: collectionCount(globalValue(globalState, "workspaceHints")),
        assignments: collectionCount(globalValue(globalState, "assignments")),
        environmentRoots: collectionCount(globalValue(globalState, "environmentRoots")),
        uiState: collectionCount(globalValue(globalState, "uiState")),
        threads: sqliteCounts.threads,
        archivedThreads: sqliteCounts.archivedThreads,
        sessionIndexRows: sessionRows.length
      },
      artifacts
    };
    atomicWriteJson(path.join(pendingDir, "manifest.json"), manifest, { backup: false });
    inspectSnapshot(pendingDir);
    fs.renameSync(pendingDir, generationDir);
    promoted = true;
    inspectCriticalSnapshotReady(generationDir, inspectSnapshot);
    if (!checkpointId) pruneCriticalSnapshots(criticalRoot, 10, inspectSnapshot);
    return { generationDir, manifestPath: path.join(generationDir, "manifest.json"), manifest };
  } catch (error) {
    fs.rmSync(pendingDir, { recursive: true, force: true });
    if (promoted && fs.existsSync(generationDir)) quarantineCriticalGeneration(criticalRoot, generationName);
    throw error;
  }
}

export function inspectCriticalSnapshot(generationDir) {
  const manifestPath = path.join(generationDir, "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (manifest?.version !== 1 || manifest.kind !== "critical" || manifest.validated !== true || !Array.isArray(manifest.artifacts)) {
    throw new Error("Invalid critical snapshot manifest");
  }
  const roles = manifest.artifacts.map((artifact) => artifact.role).sort();
  const requiredRoles = CRITICAL_ROLES.map(([role]) => role).sort();
  if (roles.length !== requiredRoles.length || roles.some((role, index) => role !== requiredRoles[index])) {
    throw new Error("Critical snapshot must contain exactly one of each required roles");
  }
  for (const artifact of manifest.artifacts) {
    const expected = CRITICAL_ROLES.find(([role]) => role === artifact.role);
    if (!expected) throw new Error("Unknown critical snapshot artifact");
    const artifactPath = path.join(generationDir, expected[1]);
    if (!fs.existsSync(artifactPath) || fs.statSync(artifactPath).size !== artifact.bytes || sha256File(artifactPath) !== artifact.sha256) {
      throw new Error(`Critical snapshot hash or length mismatch: ${artifact.role}`);
    }
  }
  const globalState = readValidatedGlobalState(path.join(generationDir, ".codex-global-state.json"));
  const sessionRows = readValidatedJsonLines(path.join(generationDir, "session_index.jsonl"));
  const sqliteCounts = validateThreadDatabase(path.join(generationDir, "state_5.sqlite"));
  const actualCounts = {
    projects: collectionCount(globalValue(globalState, "projects")),
    projectOrder: collectionCount(globalValue(globalState, "projectOrder")),
    writableRoots: collectionCount(globalValue(globalState, "writableRoots")),
    workspaceHints: collectionCount(globalValue(globalState, "workspaceHints")),
    assignments: collectionCount(globalValue(globalState, "assignments")),
    environmentRoots: collectionCount(globalValue(globalState, "environmentRoots")),
    uiState: collectionCount(globalValue(globalState, "uiState")),
    threads: sqliteCounts.threads,
    archivedThreads: sqliteCounts.archivedThreads,
    sessionIndexRows: sessionRows.length
  };
  if (JSON.stringify(actualCounts) !== JSON.stringify(manifest.counts)) throw new Error("Critical snapshot aggregate counts mismatch");
  return { valid: true, ...manifest.counts };
}

function readCriticalManifestStructure(generationDir) {
  const manifest = JSON.parse(fs.readFileSync(path.join(generationDir, "manifest.json"), "utf8"));
  if (manifest?.version !== 1 || manifest.kind !== "critical" || manifest.validated !== true || !Array.isArray(manifest.artifacts)) {
    throw new Error("Invalid critical snapshot manifest");
  }
  const roles = manifest.artifacts.map((artifact) => artifact.role).sort();
  const requiredRoles = CRITICAL_ROLES.map(([role]) => role).sort();
  if (roles.length !== requiredRoles.length || roles.some((role, index) => role !== requiredRoles[index])) throw new Error("Invalid critical snapshot roles");
  if (!Number.isFinite(Date.parse(manifest.createdAt)) || !isPlainObject(manifest.counts)) throw new Error("Invalid critical snapshot metadata");
  return manifest;
}

function readValidatedJson(filePath) {
  const bytes = fs.readFileSync(filePath);
  if (bytes.length === 0 || bytes.every((byte) => byte === 0)) throw new Error(`All-zero or empty JSON: ${path.basename(filePath)}`);
  const value = JSON.parse(bytes.toString("utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid JSON object: ${path.basename(filePath)}`);
  return value;
}

function readValidatedGlobalState(filePath, allowLegacy = false) {
  const value = readValidatedJson(filePath);
  if (!isCompleteGlobalState(value, allowLegacy)) throw new Error(`Missing required Codex global-state fields: ${path.basename(filePath)}`);
  return value;
}

function assertNoDuplicateLocalProjectPaths(globalState) {
  const projects = globalValue(globalState, "projects");
  const writableRoots = globalValue(globalState, "writableRoots");
  const owners = new Map();
  for (const [projectId, project] of Object.entries(projects)) {
    const roots = Array.isArray(project?.rootPaths) && project.rootPaths.length > 0
      ? project.rootPaths
      : (writableRoots[projectId] ?? []).map((entry) => typeof entry === "string" ? entry : entry?.path);
    for (const root of roots) {
      if (typeof root !== "string" || root.trim() === "") continue;
      const normalized = path.win32.normalize(root).replace(/[\\/]+$/, "").toLowerCase();
      const owner = owners.get(normalized);
      if (owner && owner !== projectId) throw new Error("Duplicate local-project path in recovery snapshot");
      owners.set(normalized, projectId);
    }
  }
}

function isCompleteGlobalState(value, allowLegacy = false) {
  return Object.entries(GLOBAL_FIELDS).every(([field, [realKey, legacyKey]]) => {
    const key = realKey in value ? realKey : allowLegacy && legacyKey in value ? legacyKey : null;
    return key !== null && GLOBAL_FIELD_VALIDATORS[field](value[key]);
  });
}

function globalValue(value, field) {
  const [realKey, legacyKey] = GLOBAL_FIELDS[field];
  return realKey in value ? value[realKey] : value[legacyKey];
}

function readValidatedJsonLines(filePath) {
  const text = fs.readFileSync(filePath, "utf8");
  return text
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

function snapshotSqlite(source, destination) {
  const database = new DatabaseSync(source, { readOnly: true });
  try {
    const escapedDestination = destination.replaceAll("'", "''");
    database.exec(`VACUUM INTO '${escapedDestination}'`);
  } finally {
    database.close();
  }
}

function validateThreadDatabase(filePath) {
  const database = new DatabaseSync(filePath, { readOnly: true });
  try {
    const integrity = database.prepare("PRAGMA integrity_check").all();
    if (integrity.length !== 1 || integrity[0].integrity_check !== "ok") throw new Error("SQLite integrity check failed");
    const tables = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'threads'").all();
    if (tables.length !== 1) throw new Error("SQLite threads table is missing");
    const columns = database.prepare("PRAGMA table_info(threads)").all().map((row) => String(row.name));
    const archivedColumn = ["archived", "is_archived"].find((name) => columns.includes(name));
    const threads = Number(database.prepare("SELECT COUNT(*) AS count FROM threads").get().count);
    const archivedThreads = archivedColumn
      ? Number(database.prepare(`SELECT COUNT(*) AS count FROM threads WHERE ${archivedColumn} IS NOT NULL AND ${archivedColumn} != 0`).get().count)
      : 0;
    return { threads, archivedThreads };
  } finally {
    database.close();
  }
}

function assertMatchingThreadSchemas(backupPath, livePath) {
  const schema = (filePath) => {
    const database = new DatabaseSync(filePath, { readOnly: true });
    try {
      return database.prepare("PRAGMA table_info(threads)").all().map(({ cid, name, type, notnull, dflt_value, pk }) => ({
        cid: Number(cid),
        name: String(name),
        type: String(type),
        notnull: Number(notnull),
        dflt_value,
        pk: Number(pk)
      }));
    } finally {
      database.close();
    }
  };
  if (JSON.stringify(schema(backupPath)) !== JSON.stringify(schema(livePath))) {
    throw new Error("Incompatible recovery thread database schema");
  }
}

function assertWritableTarget(target) {
  let ancestor = path.dirname(target);
  while (!fs.existsSync(ancestor)) {
    const parent = path.dirname(ancestor);
    if (parent === ancestor) throw new Error("Conversation restore target has no writable parent");
    ancestor = parent;
  }
  if (!fs.statSync(ancestor).isDirectory()) throw new Error("Conversation restore target parent is not a directory");
  fs.accessSync(ancestor, fs.constants.W_OK);
}

function commitRestoreItems(items, stagingRoot) {
  const rollbackRoot = path.join(stagingRoot, "rollback");
  fs.mkdirSync(rollbackRoot, { recursive: true });
  const originals = items.map(({ staged, target, restoreRoot }, index) => {
    if (!fs.existsSync(staged) || !fs.statSync(staged).isFile()) throw new Error("Missing staged restore artifact");
    if (restoreRoot) assertNoLinkedRestorePath(restoreRoot, target);
    assertWritableTarget(target);
    const existed = fs.existsSync(target);
    if (existed && !fs.statSync(target).isFile()) throw new Error("Restore target is not a file");
    const backup = path.join(rollbackRoot, String(index));
    if (existed) fs.copyFileSync(target, backup);
    return { target, existed, backup };
  });

  try {
    for (const { staged, target, restoreRoot } of items) {
      if (restoreRoot) assertNoLinkedRestorePath(restoreRoot, target);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.renameSync(staged, target);
    }
  } catch (error) {
    for (const original of originals.toReversed()) {
      if (original.existed) fs.copyFileSync(original.backup, original.target);
      else fs.rmSync(original.target, { force: true });
    }
    throw error;
  }
}

function commitReplacementItems(items, stagingRoot) {
  const rollbackRoot = path.join(stagingRoot, "rollback");
  fs.mkdirSync(rollbackRoot, { recursive: true });
  const originals = items.map(({ staged, target, kind }, index) => {
    if (!fs.existsSync(staged) || (kind === "file" ? !fs.statSync(staged).isFile() : !fs.statSync(staged).isDirectory())) {
      throw new Error("Missing staged replacement artifact");
    }
    const existed = fs.existsSync(target);
    if (existed && (kind === "file" ? !fs.statSync(target).isFile() : !fs.statSync(target).isDirectory())) {
      throw new Error("Replacement target has the wrong type");
    }
    assertWritableTarget(target);
    return { target, kind, existed, backup: path.join(rollbackRoot, String(index)) };
  });
  try {
    for (const original of originals) {
      if (original.existed) fs.renameSync(original.target, original.backup);
    }
    for (const { staged, target } of items) {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.renameSync(staged, target);
    }
  } catch (error) {
    for (const original of originals.toReversed()) {
      if (fs.existsSync(original.backup)) {
        fs.rmSync(original.target, { recursive: original.kind === "directory", force: true });
        fs.renameSync(original.backup, original.target);
      } else if (!original.existed) {
        fs.rmSync(original.target, { recursive: original.kind === "directory", force: true });
      }
    }
    throw error;
  }
}

function copyAndVerify(source, destination) {
  fs.copyFileSync(source, destination);
  if (fs.statSync(source).size !== fs.statSync(destination).size || sha256File(source) !== sha256File(destination)) {
    throw new Error(`Critical snapshot verification failed: ${path.basename(source)}`);
  }
}

function artifactMetadata(role, filePath) {
  return { role, bytes: fs.statSync(filePath).size, sha256: sha256File(filePath), schemaVersion: 1 };
}

function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  const handle = fs.openSync(filePath, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let bytesRead;
    do {
      bytesRead = fs.readSync(handle, buffer, 0, buffer.length, null);
      if (bytesRead > 0) hash.update(buffer.subarray(0, bytesRead));
    } while (bytesRead > 0);
  } finally {
    fs.closeSync(handle);
  }
  return hash.digest("hex");
}

async function encryptConversationBlob(source, target, protectKey) {
  const key = crypto.randomBytes(32);
  const iv = crypto.randomBytes(12);
  const protectedKey = Buffer.from(protectKey(key.toString("base64")), "utf8");
  const header = Buffer.alloc(BLOB_MAGIC.length + 4 + protectedKey.length + iv.length);
  BLOB_MAGIC.copy(header, 0);
  header.writeUInt32BE(protectedKey.length, BLOB_MAGIC.length);
  protectedKey.copy(header, BLOB_MAGIC.length + 4);
  iv.copy(header, BLOB_MAGIC.length + 4 + protectedKey.length);
  const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temp, header, { mode: 0o600 });
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
    await pipeline(fs.createReadStream(source), cipher, fs.createWriteStream(temp, { flags: "a", mode: 0o600 }));
    fs.appendFileSync(temp, cipher.getAuthTag());
    fs.renameSync(temp, target);
  } finally {
    fs.rmSync(temp, { force: true });
  }
}

async function ensureConversationBlob(source, target, expected, protectKey, unprotectKey, full = true) {
  if (fs.existsSync(target)) {
    try {
      const actual = full ? await decryptConversationBlob(target, unprotectKey) : { ...encryptedBlobMetadata(target, unprotectKey), sha256: expected.sha256, bytes: expected.bytes };
      if (actual.sha256 === expected.sha256 && actual.bytes === expected.bytes) {
        assertUnchangedSource(source, expected);
        return;
      }
    } catch {}
  }

  const pending = `${target}.pending-${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
  try {
    await encryptConversationBlob(source, pending, protectKey);
    const actual = await decryptConversationBlob(pending, unprotectKey);
    if (actual.sha256 !== expected.sha256 || actual.bytes !== expected.bytes) {
      throw new Error("Conversation source changed during encryption");
    }
    assertUnchangedSource(source, expected);
    if (fs.existsSync(target)) fs.rmSync(target, { force: true });
    fs.renameSync(pending, target);
  } finally {
    fs.rmSync(pending, { force: true });
  }
}

async function decryptConversationBlob(blobPath, unprotectKey) {
  const metadata = encryptedBlobMetadata(blobPath, unprotectKey);
  const decipher = crypto.createDecipheriv("aes-256-gcm", metadata.key, metadata.iv);
  decipher.setAuthTag(metadata.tag);
  const hash = crypto.createHash("sha256");
  let bytes = 0;
  if (metadata.end < metadata.start) {
    const chunk = decipher.final();
    hash.update(chunk);
    return { sha256: hash.digest("hex"), bytes: chunk.length };
  }
  for await (const chunk of fs.createReadStream(blobPath, { start: metadata.start, end: metadata.end }).pipe(decipher)) {
    hash.update(chunk);
    bytes += chunk.length;
  }
  return { sha256: hash.digest("hex"), bytes };
}

async function decryptConversationBlobToFile(blobPath, target, unprotectKey) {
  const metadata = encryptedBlobMetadata(blobPath, unprotectKey);
  const decipher = crypto.createDecipheriv("aes-256-gcm", metadata.key, metadata.iv);
  decipher.setAuthTag(metadata.tag);
  const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  try {
    if (metadata.end < metadata.start) {
      fs.writeFileSync(temp, decipher.final(), { mode: 0o600 });
    } else {
      await pipeline(
        fs.createReadStream(blobPath, { start: metadata.start, end: metadata.end }),
        decipher,
        fs.createWriteStream(temp, { mode: 0o600 })
      );
    }
    fs.renameSync(temp, target);
  } finally {
    fs.rmSync(temp, { force: true });
  }
}

function encryptedBlobMetadata(blobPath, unprotectKey) {
  const structure = encryptedBlobStructure(blobPath);
  const keyText = unprotectKey(structure.protectedKey);
  if (typeof keyText !== "string" || !/^[A-Za-z0-9+/]{43}=$/.test(keyText)) {
    throw new Error("Invalid protected conversation key");
  }
  const key = Buffer.from(keyText, "base64");
  if (key.length !== 32 || key.toString("base64") !== keyText) throw new Error("Invalid protected conversation key");
  return {
    key,
    iv: structure.iv,
    tag: structure.tag,
    start: structure.start,
    end: structure.end
  };
}

function encryptedBlobStructure(blobPath) {
  const handle = fs.openSync(blobPath, "r");
  try {
    const prefix = Buffer.alloc(BLOB_MAGIC.length + 4);
    if (fs.readSync(handle, prefix, 0, prefix.length, 0) !== prefix.length || !prefix.subarray(0, BLOB_MAGIC.length).equals(BLOB_MAGIC)) {
      throw new Error("Invalid encrypted conversation blob");
    }
    const protectedKeyLength = prefix.readUInt32BE(BLOB_MAGIC.length);
    const stat = fs.fstatSync(handle);
    const minimumBytes = prefix.length + protectedKeyLength + 12 + 16;
    if (protectedKeyLength === 0 || protectedKeyLength > MAX_PROTECTED_KEY_BYTES || stat.size < minimumBytes) {
      throw new Error("Invalid encrypted conversation blob metadata");
    }
    const metadata = Buffer.alloc(protectedKeyLength + 12);
    if (fs.readSync(handle, metadata, 0, metadata.length, prefix.length) !== metadata.length) throw new Error("Truncated encrypted conversation blob");
    const start = prefix.length + metadata.length;
    const end = stat.size - 17;
    if (end < start - 1) throw new Error("Truncated encrypted conversation blob");
    const tag = Buffer.alloc(16);
    if (fs.readSync(handle, tag, 0, tag.length, stat.size - tag.length) !== tag.length) throw new Error("Truncated encrypted conversation blob");
    return {
      protectedKey: metadata.subarray(0, protectedKeyLength).toString("utf8"),
      iv: metadata.subarray(protectedKeyLength),
      tag,
      start,
      end,
      bytes: Math.max(0, end - start + 1)
    };
  } finally {
    fs.closeSync(handle);
  }
}

function listFiles(root) {
  if (!fs.existsSync(root)) return [];
  const files = [];
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(fullPath);
      else if (entry.isFile()) files.push(fullPath);
    }
  }
  return files.sort();
}

function conversationSourceInventory(codexDir) {
  return ["sessions", "archived_sessions"].flatMap((scope) =>
    listFiles(path.join(codexDir, scope)).map((source) => {
      const stat = fs.statSync(source);
      return { scope, source, bytes: stat.size, mtimeMs: stat.mtimeMs };
    })
  );
}

function sameConversationInventory(left, right) {
  return left.length === right.length && left.every((item, index) => {
    const other = right[index];
    return item.scope === other.scope && item.source === other.source && item.bytes === other.bytes && item.mtimeMs === other.mtimeMs;
  });
}

function latestConversationManifest(manifestRoot) {
  if (!fs.existsSync(manifestRoot)) return undefined;
  const name = conversationManifestNames(manifestRoot).at(-1);
  if (!name) return undefined;
  const manifestPath = path.join(manifestRoot, name);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (manifest?.version !== 1 || manifest.kind !== "conversations" || manifest.complete !== true || !Array.isArray(manifest.files)) return undefined;
  return { manifestPath, manifest };
}

function conversationManifestFileMap(manifest, unprotectKey) {
  const map = new Map();
  for (const file of manifest.files) {
    if (!Number.isFinite(file.mtimeMs)) return new Map();
    map.set(`${file.scope}\0${unprotectKey(file.pathDpapi)}`, file);
  }
  return map;
}

function analyzeGlobalState(live, backup, apply) {
  let missing = 0;
  let conflicts = 0;
  for (const field of Object.keys(GLOBAL_FIELDS)) {
    const [realKey, legacyKey] = GLOBAL_FIELDS[field];
    const liveKey = realKey in live ? realKey : legacyKey;
    const backupKey = realKey in backup ? realKey : legacyKey;
    const liveValue = live[liveKey];
    const backupValue = backup[backupKey];
    if (isPlainObject(liveValue) && isPlainObject(backupValue)) {
      const result = analyzeObject(liveValue, backupValue, apply);
      missing += result.missing;
      conflicts += result.conflicts;
    } else if (JSON.stringify(liveValue) !== JSON.stringify(backupValue)) {
      conflicts += 1;
    }
  }
  return { missing, conflicts };
}

function analyzeObject(live, backup, apply) {
  let missing = 0;
  let conflicts = 0;
  for (const [key, backupValue] of Object.entries(backup)) {
    if (!(key in live)) {
      missing += 1;
      if (apply) live[key] = structuredClone(backupValue);
      continue;
    }
    if (isPlainObject(live[key]) && isPlainObject(backupValue)) {
      const nested = analyzeObject(live[key], backupValue, apply);
      missing += nested.missing;
      conflicts += nested.conflicts;
    } else if (JSON.stringify(live[key]) !== JSON.stringify(backupValue)) {
      conflicts += 1;
    }
  }
  return { missing, conflicts };
}

function isPlainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function mergeSessionIndex(backupPath, livePath) {
  const backupRows = readValidatedJsonLines(backupPath);
  const liveRows = readValidatedJsonLines(livePath);
  const rowKey = (row) => String(row.id ?? row.thread_id ?? row.threadId ?? JSON.stringify(row));
  const liveByKey = new Map(liveRows.map((row) => [rowKey(row), row]));
  let restored = 0;
  let conflicts = 0;
  for (const row of backupRows) {
    const key = rowKey(row);
    if (!liveByKey.has(key)) {
      liveRows.push(row);
      liveByKey.set(key, row);
      restored += 1;
    } else if (JSON.stringify(liveByKey.get(key)) !== JSON.stringify(row)) {
      conflicts += 1;
    }
  }
  atomicWriteText(livePath, liveRows.map((row) => JSON.stringify(row)).join("\n") + (liveRows.length ? "\n" : ""));
  return { restored, conflicts };
}

function mergeThreadDatabase(backupPath, livePath) {
  const database = new DatabaseSync(livePath);
  const escaped = backupPath.replaceAll("'", "''");
  try {
    database.exec(`ATTACH DATABASE '${escaped}' AS recovery`);
    const liveColumns = database.prepare("PRAGMA main.table_info(threads)").all().map((row) => String(row.name));
    const backupColumns = database.prepare("PRAGMA recovery.table_info(threads)").all().map((row) => String(row.name));
    if (liveColumns.length !== backupColumns.length || liveColumns.some((name, index) => name !== backupColumns[index])) {
      throw new Error("Incompatible recovery thread database schema");
    }
    const quotedColumns = liveColumns.map((name) => `"${name.replaceAll('"', '""')}"`).join(", ");
    if (!liveColumns.includes("id")) throw new Error("SQLite threads table has no id column");
    const liveRows = database.prepare(`SELECT ${quotedColumns} FROM main.threads`).all();
    const backupRows = database.prepare(`SELECT ${quotedColumns} FROM recovery.threads`).all();
    const analysis = analyzeThreadRows(liveRows, backupRows, liveColumns, readUniqueThreadIndexes(database, "main"));
    const insert = database.prepare(`INSERT INTO main.threads (${quotedColumns}) VALUES (${liveColumns.map(() => "?").join(", ")})`);
    database.exec("BEGIN IMMEDIATE");
    for (const row of analysis.insertRows) insert.run(...liveColumns.map((name) => row[name]));
    database.exec("COMMIT");
    return { restored: analysis.insertRows.length, conflicts: analysis.conflicts };
  } catch (error) {
    try { database.exec("ROLLBACK"); } catch {}
    throw error;
  } finally {
    try { database.exec("DETACH DATABASE recovery"); } catch {}
    database.close();
  }
}

function threadDifferences(backupPath, livePath) {
  const readData = (databasePath, includeIndexes = false) => {
    const database = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const columns = database.prepare("PRAGMA table_info(threads)").all().map((row) => String(row.name));
      const quoted = columns.map((name) => `"${name.replaceAll('"', '""')}"`).join(", ");
      return { columns, rows: database.prepare(`SELECT ${quoted} FROM threads`).all(), indexes: includeIndexes ? readUniqueThreadIndexes(database, "main") : [] };
    } finally {
      database.close();
    }
  };
  const backup = readData(backupPath);
  const live = readData(livePath, true);
  if (JSON.stringify(backup.columns) !== JSON.stringify(live.columns)) throw new Error("Incompatible recovery thread database schema");
  const analysis = analyzeThreadRows(live.rows, backup.rows, live.columns, live.indexes);
  return { missing: analysis.insertRows.length, conflicts: analysis.conflicts };
}

function readUniqueThreadIndexes(database, schema) {
  return database.prepare(`PRAGMA ${schema}.index_list('threads')`).all()
    .filter((index) => Number(index.unique) === 1 && String(index.origin) !== "pk")
    .map((index) => {
      if (Number(index.partial) === 1) throw new Error("Cannot safely analyze a partial unique threads index");
      const escaped = String(index.name).replaceAll("'", "''");
      const rows = database.prepare(`PRAGMA ${schema}.index_xinfo('${escaped}')`).all()
        .filter((row) => Number(row.key) === 1)
        .sort((left, right) => Number(left.seqno) - Number(right.seqno));
      if (rows.length === 0 || rows.some((row) => Number(row.cid) < 0 || typeof row.name !== "string")) {
        throw new Error("Cannot safely analyze an expression-based unique threads index");
      }
      return rows.map((row) => {
        const collation = String(row.coll || "").toUpperCase();
        if (!["BINARY", "NOCASE", "RTRIM"].includes(collation)) {
          throw new Error("Cannot safely analyze an unknown unique threads index collation");
        }
        return { name: String(row.name), collation, descending: Number(row.desc) === 1 };
      });
    });
}

function analyzeThreadRows(liveRows, backupRows, columns, uniqueIndexes) {
  const liveById = new Map(liveRows.map((row) => [String(row.id), row]));
  const occupied = uniqueIndexes.map((indexColumns) => {
    const values = new Set();
    for (const row of liveRows) {
      const key = uniqueKey(row, indexColumns);
      if (key !== undefined) values.add(key);
    }
    return values;
  });
  const insertRows = [];
  let conflicts = 0;
  for (const row of backupRows) {
    const existing = liveById.get(String(row.id));
    if (existing) {
      if (JSON.stringify(columns.map((name) => existing[name])) !== JSON.stringify(columns.map((name) => row[name]))) conflicts += 1;
      continue;
    }
    const keys = uniqueIndexes.map((indexColumns) => uniqueKey(row, indexColumns));
    if (keys.some((key, index) => key !== undefined && occupied[index].has(key))) {
      conflicts += 1;
      continue;
    }
    insertRows.push(row);
    keys.forEach((key, index) => { if (key !== undefined) occupied[index].add(key); });
  }
  return { insertRows, conflicts };
}

function uniqueKey(row, columns) {
  const values = columns.map(({ name, collation }) => {
    const value = row[name];
    if (typeof value !== "string") return value;
    if (collation === "NOCASE") return value.replace(/[A-Z]/g, (character) => character.toLowerCase());
    if (collation === "RTRIM") return value.replace(/ +$/, "");
    return value;
  });
  return values.some((value) => value === null || value === undefined) ? undefined : JSON.stringify(values);
}

function safeRelativeTarget(root, relativePath) {
  const resolvedRoot = path.resolve(root);
  const target = path.resolve(root, relativePath);
  if (target !== resolvedRoot && !target.startsWith(`${resolvedRoot}${path.sep}`)) throw new Error("Invalid conversation backup path");
  return target;
}

async function discoverCodexRecoveryBackups({ backupRoot, unprotectKey, full, onProgress = () => {} }) {
  reportRecoveryProgress(onProgress, { stage: "discovering" });
  const criticalRoot = path.join(backupRoot, "codex-state", "critical");
  const manifestRoot = path.join(backupRoot, "codex-state", "conversations", "manifests");
  const quarantineRoot = path.join(backupRoot, "codex-state", "conversations", "quarantine");
  const critical = [];
  if (fs.existsSync(criticalRoot)) {
    for (const name of validCriticalGenerationNames(criticalRoot, true, inspectCriticalSnapshot)) {
      const sourcePath = path.join(criticalRoot, name);
      try {
        const counts = inspectCriticalSnapshot(sourcePath);
        critical.push({
          generationId: recoveryGenerationId("critical", name),
          backupTime: readBackupTime(path.join(sourcePath, "manifest.json")),
          counts: { projects: counts.projects, assignments: counts.assignments, threads: counts.threads },
          sourcePath
        });
      } catch {
        quarantineCriticalGeneration(criticalRoot, name);
      }
    }
  }

  const conversations = [];
  let unavailableConversationBackups = 0;
  const aggregate = { processedFiles: 0, totalFiles: 0, processedBytes: 0, totalBytes: 0 };
  if (fs.existsSync(manifestRoot)) {
    const names = conversationManifestNames(manifestRoot);
    if (full) {
      const allUnique = new Map();
      for (const name of names) {
        try {
          const manifest = JSON.parse(fs.readFileSync(path.join(manifestRoot, name), "utf8"));
          for (const [blob, bytes] of new Map(manifest.files?.map((file) => [file.blob, file.bytes]) ?? [])) {
            allUnique.set(blob, bytes);
          }
        } catch {}
      }
      aggregate.totalFiles = allUnique.size;
      aggregate.totalBytes = [...allUnique.values()].reduce((sum, bytes) => sum + bytes, 0);
      reportRecoveryProgress(onProgress, { stage: "validating_backup", ...aggregate });
    }
    const verifiedBlobs = new Map();
    for (const name of names) {
      const sourcePath = path.join(manifestRoot, name);
      const validation = await validateConversationBackupWithRetries(sourcePath, {
        unprotectKey,
        full,
        verifiedBlobs,
        onProgress: (value) => {
          if (!full || value.stage !== "validating") return;
          aggregate.processedFiles = verifiedBlobs.size;
          aggregate.processedBytes = [...verifiedBlobs.values()].reduce((sum, result) => sum + result.bytes, 0);
          reportRecoveryProgress(onProgress, {
            stage: "validating_backup",
            processedFiles: aggregate.processedFiles,
            totalFiles: aggregate.totalFiles,
            processedBytes: aggregate.processedBytes,
            totalBytes: aggregate.totalBytes
          });
        }
      });
      if (validation.valid) {
        conversations.push({
          generationId: recoveryGenerationId("conversation", name),
          backupTime: validation.summary.backupTime,
          counts: validation.summary.counts,
          sourcePath
        });
      } else if (validation.quarantineReason) {
        quarantineConversationManifest(manifestRoot, name, validation);
      } else {
        unavailableConversationBackups += 1;
      }
    }
  }
  const quarantinedConversations = listQuarantinedConversationBackups(quarantineRoot);
  reportRecoveryProgress(onProgress, { stage: "completed", ...aggregate });
  return { critical, conversations, quarantinedConversations, unavailableConversationBackups };
}

function reportRecoveryProgress(callback, value) {
  try {
    callback(value)?.catch?.(() => {});
  } catch {}
}

function recoveryGenerationId(kind, name) {
  return crypto.createHash("sha256").update(`${kind}\0${name}`).digest("base64url");
}

function assertConversationGenerationId(conversationId) {
  if (typeof conversationId !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(conversationId)) {
    throw new Error("Invalid recovery generation ID");
  }
}

function conversationManifestNames(root) {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isFile() && isConversationManifestName(entry.name))
    .map((entry) => entry.name)
    .sort();
}

function isConversationManifestName(name) {
  return !name.endsWith(".reason.json") && /^conversation-manifest-.+\.json(?:-\d+)?$/.test(name);
}

function canonicalConversationManifestName(name) {
  return name.replace(/^(.*\.json)-\d+$/, "$1");
}

function findConversationManifestName(root, conversationId) {
  return conversationManifestNames(root).find((name) => recoveryGenerationId("conversation", name) === conversationId);
}

function listQuarantinedConversationBackups(quarantineRoot) {
  return conversationManifestNames(quarantineRoot).map((name) => {
    const manifestPath = path.join(quarantineRoot, name);
    let summary;
    try {
      summary = readConversationManifestSummary(manifestPath);
    } catch {}
    return {
      generationId: recoveryGenerationId("conversation", name),
      ...(summary ? { backupTime: summary.backupTime, counts: summary.counts } : {}),
      reason: readConversationQuarantineReason(quarantineRoot, name)
    };
  });
}

function conversationQuarantineReasonPath(quarantineRoot, name) {
  return path.join(quarantineRoot, `${name}.reason.json`);
}

function readConversationQuarantineReason(quarantineRoot, name) {
  try {
    const record = JSON.parse(fs.readFileSync(conversationQuarantineReasonPath(quarantineRoot, name), "utf8"));
    if (QUARANTINE_REASON_CODES.has(record?.reason)) return record.reason;
  } catch {}
  return "needs_revalidation";
}

function readBackupTime(manifestPath) {
  const backupTime = JSON.parse(fs.readFileSync(manifestPath, "utf8"))?.createdAt;
  if (typeof backupTime !== "string" || !Number.isFinite(Date.parse(backupTime))) throw new Error("Invalid recovery backup time");
  return backupTime;
}

function assertNoLinkedRestorePath(root, target) {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = safeRelativeTarget(resolvedRoot, path.relative(resolvedRoot, target));
  const segments = [resolvedRoot];
  let current = resolvedRoot;
  for (const segment of path.relative(resolvedRoot, resolvedTarget).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    segments.push(current);
  }
  for (const candidate of segments) {
    let stat;
    try {
      stat = fs.lstatSync(candidate);
    } catch (error) {
      if (error.code === "ENOENT") break;
      throw error;
    }
    if (stat.isSymbolicLink()) throw new Error("Conversation restore path contains a symbolic link, junction, or reparse point");
  }
}

async function pruneConversationBackups(manifestRoot, blobRoot, limit, unprotectKey = unprotectString, full = true) {
  const manifests = conversationManifestNames(manifestRoot);
  const valid = [];
  const temporarilyUnavailable = [];
  const verifiedBlobs = new Map();
  for (const name of manifests) {
    const validation = await validateConversationBackupWithRetries(path.join(manifestRoot, name), { unprotectKey, full, verifiedBlobs });
    if (validation.valid) {
      valid.push(name);
    } else if (validation.quarantineReason) {
      quarantineConversationManifest(manifestRoot, name, validation);
    } else {
      temporarilyUnavailable.push(name);
    }
  }
  const retained = valid.slice(-limit);
  for (const name of valid.slice(0, Math.max(0, valid.length - limit))) fs.rmSync(path.join(manifestRoot, name), { force: true });

  const referenced = new Set();
  let completeReferences = true;
  for (const name of [...retained, ...temporarilyUnavailable]) completeReferences = addConversationManifestBlobReferences(path.join(manifestRoot, name), referenced) && completeReferences;
  completeReferences = addQuarantinedConversationBlobReferences(path.join(path.dirname(manifestRoot), "quarantine"), referenced) && completeReferences;
  if (!completeReferences) return;
  for (const name of fs.readdirSync(blobRoot).filter((item) => item.endsWith(".scsb") && !item.includes(".pending"))) {
    if (!referenced.has(name)) fs.rmSync(path.join(blobRoot, name), { force: true });
  }
}

function quarantineConversationManifest(manifestRoot, name, validation = {}) {
  const source = path.join(manifestRoot, name);
  if (!fs.existsSync(source)) return undefined;
  const quarantineRoot = path.join(path.dirname(manifestRoot), "quarantine");
  fs.mkdirSync(quarantineRoot, { recursive: true });
  const manifestSha256 = sha256File(source);
  let targetName = name;
  while (fs.existsSync(path.join(quarantineRoot, targetName))) {
    const parsed = path.parse(name);
    targetName = `${parsed.name}-${Date.now()}-${crypto.randomBytes(2).toString("hex")}${parsed.ext}`;
  }
  const target = path.join(quarantineRoot, targetName);
  fs.renameSync(source, target);
  if (QUARANTINE_REASON_CODES.has(validation.quarantineReason)) {
    atomicWriteJson(conversationQuarantineReasonPath(quarantineRoot, targetName), {
      version: 1,
      reason: validation.quarantineReason,
      attempts: validation.attempts,
      quarantinedAt: new Date().toISOString(),
      manifestSha256
    }, { backup: false });
  }
  return target;
}

function addConversationManifestBlobReferences(manifestPath, referenced) {
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    if (!Array.isArray(manifest?.files)) return false;
    for (const file of manifest.files) {
      if (typeof file?.blob !== "string" || !/^[a-f0-9]{64}\.scsb$/.test(file.blob)) return false;
      referenced.add(file.blob);
    }
    return true;
  } catch {
    return false;
  }
}

function addQuarantinedConversationBlobReferences(quarantineRoot, referenced) {
  return conversationManifestNames(quarantineRoot)
    .every((name) => addConversationManifestBlobReferences(path.join(quarantineRoot, name), referenced));
}

function stableIdentity(filePath) {
  const metadata = stableFileMetadata(filePath);
  return `${metadata.bytes}:${metadata.mtimeMs}:${metadata.sha256}`;
}

function contentIdentity(files) {
  const hash = crypto.createHash("sha256");
  for (const [label, filePath] of files) {
    const metadata = stableFileMetadata(filePath);
    hash.update(label).update("\0").update(String(metadata.bytes)).update("\0").update(metadata.sha256).update("\0");
  }
  return hash.digest("hex");
}

async function contentIdentityAsync(files) {
  const hash = crypto.createHash("sha256");
  const before = new Map(files.map(([label, filePath]) => [label, fileMetadataSnapshot(filePath)]));
  for (const [label, filePath] of files) {
    const sha256 = await sha256FileAsync(filePath);
    hash.update(label).update("\0").update(before.get(label).size).update("\0").update(sha256).update("\0");
  }
  for (const [label, filePath] of files) {
    if (JSON.stringify(fileMetadataSnapshot(filePath)) !== JSON.stringify(before.get(label))) {
      throw new Error(`Source changed while hashing: ${path.basename(filePath)}`);
    }
  }
  return hash.digest("hex");
}

async function sha256FileAsync(filePath) {
  const hash = crypto.createHash("sha256");
  for await (const chunk of fs.createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

function fileMetadataSnapshot(filePath) {
  const stat = fs.statSync(filePath, { bigint: true });
  return {
    size: String(stat.size),
    mtimeNs: String(stat.mtimeNs),
    birthtimeNs: String(stat.birthtimeNs),
    dev: String(stat.dev),
    ino: String(stat.ino)
  };
}

function stableFileMetadata(filePath) {
  const before = fs.statSync(filePath);
  const sha256 = sha256File(filePath);
  const after = fs.statSync(filePath);
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
    throw new Error(`Source changed while hashing: ${path.basename(filePath)}`);
  }
  return { bytes: after.size, mtimeMs: after.mtimeMs, sha256 };
}

function assertUnchangedSource(filePath, expected) {
  const actual = stableFileMetadata(filePath);
  if (actual.bytes !== expected.bytes || actual.mtimeMs !== expected.mtimeMs || actual.sha256 !== expected.sha256) {
    throw new Error(`Source changed during backup: ${path.basename(filePath)}`);
  }
}

function collectionCount(value) {
  if (Array.isArray(value)) return new Set(value.map((item) => JSON.stringify(item))).size;
  if (value && typeof value === "object") return Object.keys(value).length;
  return 0;
}

function latestValidGenerationName(root, inspectSnapshot) {
  if (!fs.existsSync(root)) return null;
  return validCriticalGenerationNames(root, false, inspectSnapshot).at(-1) ?? null;
}

function pruneCriticalSnapshots(root, limit, inspectSnapshot, protectedNames = new Set()) {
  if (!fs.existsSync(root)) return;
  const generations = validCriticalGenerationNames(root, true, inspectSnapshot);
  const retained = [...new Set([...generations.slice(-limit), ...[...protectedNames].filter((name) => generations.includes(name))])];
  for (const name of retained) inspectCriticalSnapshotReady(path.join(root, name), inspectSnapshot);
  if (retained.length === 0) return;
  for (const name of generations.filter((name) => !retained.includes(name))) {
    const generationDir = path.join(root, name);
    fs.rmSync(generationDir, { recursive: true, force: true });
    criticalReadinessCache.delete(path.resolve(generationDir));
  }
}

function validCriticalGenerationNames(root, quarantineInvalid, inspectSnapshot) {
  const names = fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("critical-") && !entry.name.includes(".pending"))
    .map((entry) => entry.name)
    .sort();
  const valid = [];
  for (const name of names) {
    try {
      inspectCriticalSnapshotReady(path.join(root, name), inspectSnapshot);
      valid.push(name);
    } catch {
      if (quarantineInvalid) quarantineCriticalGeneration(root, name);
    }
  }
  return valid;
}

function inspectCriticalSnapshotReady(generationDir, inspectSnapshot) {
  const cacheKey = path.resolve(generationDir);
  const identity = criticalGenerationIdentity(generationDir);
  const cached = criticalReadinessCache.get(cacheKey);
  if (cached?.identity === identity) return cached.result;
  const result = inspectSnapshot(generationDir);
  criticalReadinessCache.set(cacheKey, { identity, result });
  return result;
}

function criticalGenerationIdentity(generationDir) {
  return ["manifest.json", ...CRITICAL_ROLES.map(([, name]) => name)]
    .map((name) => {
      const stat = fs.statSync(path.join(generationDir, name));
      return `${name}:${stat.size}:${stat.mtimeMs}`;
    })
    .join("|");
}

function quarantineCriticalGeneration(root, name) {
  const source = path.join(root, name);
  if (!fs.existsSync(source)) return;
  criticalReadinessCache.delete(path.resolve(source));
  const quarantineRoot = path.join(path.dirname(root), "quarantine");
  fs.mkdirSync(quarantineRoot, { recursive: true });
  let target = path.join(quarantineRoot, name);
  if (fs.existsSync(target)) target = `${target}-${Date.now()}`;
  fs.renameSync(source, target);
}

function availableBytes(target) {
  let current = target;
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) return 0;
    current = parent;
  }
  const stat = fs.statfsSync(current);
  return Number(stat.bavail) * Number(stat.bsize);
}
