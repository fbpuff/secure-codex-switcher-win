import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { COLD_ACTIVE_RECOVERY_MS } from "./codex-task-activity.js";
import { findStateDatabases, latestMatchingFiles } from "./file-io.js";

const MAX_SEARCH_LENGTH = 200;
const MAX_TEXT_LENGTH = 500;
const SESSION_HEAD_BYTES = 64 * 1_024;
const LIFECYCLE_TAIL_BYTES = 256 * 1_024;
const LIFECYCLE_SCAN_CHUNK_BYTES = 64 * 1_024;
const DEFAULT_QUOTA_INTERRUPTION_LOOKBACK_MS = 5 * 60_000;
const sessionIndexRevisionCache = new Map();

export function searchLocalCodexThreads(codexDir, query = "", options = {}) {
  const threads = new Map();
  const protectedActiveThreadIds = normalizeProtectedActiveThreadIds(options?.protectedActiveThreadIds);
  let hasAuthoritativeInventory = false;
  try {
    for (const databasePath of findStateDatabases(codexDir)) {
      hasAuthoritativeInventory = readThreadDatabase(databasePath, threads, protectedActiveThreadIds)
        || hasAuthoritativeInventory;
    }
  } catch {}
  readSessionIndex(path.join(codexDir, "session_index.jsonl"), threads, {
    allowInventory: !hasAuthoritativeInventory
  });
  applyProjectMetadata(path.join(codexDir, ".codex-global-state.json"), threads);

  return filterLocalCodexThreads([...threads.values()]
    .map(protectTemporaryExecutorMetadata)
    .sort((left, right) => (right.updatedAtMs ?? 0) - (left.updatedAtMs ?? 0) || left.id.localeCompare(right.id)), query);
}

export function selectQuotaInterruptedThread(codexDir, options = {}) {
  return selectQuotaInterruptedThreadFromThreads(searchLocalCodexThreads(codexDir), options);
}

export function selectQuotaInterruptedThreadFromThreads(threads, options = {}) {
  const nowMs = Number.isFinite(options.nowMs) ? Math.floor(options.nowMs) : Date.now();
  const lookbackMs = Number.isFinite(options.lookbackMs) && options.lookbackMs >= 0
    ? options.lookbackMs
    : DEFAULT_QUOTA_INTERRUPTION_LOOKBACK_MS;
  const minInterruptedAtMs = Number.isFinite(options.minInterruptedAtMs)
    ? Math.floor(options.minInterruptedAtMs)
    : -Infinity;
  const earliestInterruptedAtMs = Math.max(nowMs - lookbackMs, minInterruptedAtMs);
  const preferredThreadIds = new Set([
    ...normalizeProtectedActiveThreadIds(options.preferredThreadIds),
    ...normalizeProtectedActiveThreadIds(options.interruptedActiveThreadIds)
  ]);
  const candidates = threads.filter((thread) => {
    const interruptedAtMs = thread.lifecycleAtMs ?? thread.updatedAtMs;
    return (thread.turnState === "usage_limited"
      || (options.includeUnfinished === true && thread.turnState === "failed" && Number.isFinite(thread.lifecycleAtMs))
      || (options.includeUnfinished === true && thread.turnState === "running" && Number.isFinite(thread.lifecycleAtMs)))
      && isEligibleResumeRoot(thread)
      && Number.isFinite(interruptedAtMs)
      && interruptedAtMs >= earliestInterruptedAtMs
      && interruptedAtMs <= nowMs;
  }).map((thread) => thread.turnState === "running" ? { ...thread, lifecycleAtMs: nowMs } : thread);
  if (preferredThreadIds.size > 0) {
    const threadsById = new Map(threads.map((thread) => [thread.id, thread]));
    const preferredRoots = [...preferredThreadIds]
      .map((threadId) => threadsById.get(threadId))
      .filter((thread) => isEligibleResumeRoot(thread)
        && (options.includeUnfinished !== true || !["completed", "interrupted", "failed", "usage_limited"].includes(thread.turnState)
          || candidates.some(({ id }) => id === thread.id)));
    if (options.selectAllCandidates === true) {
      const selected = preferredRoots.flatMap((thread) => {
        const quotaCandidate = candidates.find((candidate) => candidate.id === thread.id);
        if (quotaCandidate) return [quotaCandidateFromThread(quotaCandidate)];
        return options.allowSwitchInterruptedActiveThread === true
          ? [{ threadId: thread.id, interruptedAtMs: nowMs, reason: "switch_interrupted_active_thread" }]
          : [];
      });
      const selectedThreadIds = new Set(selected.map(({ threadId }) => threadId));
      selected.push(...candidates
        .filter(({ id }) => !selectedThreadIds.has(id))
        .map(quotaCandidateFromThread));
      return selected.length > 0 ? selectedQuotaThreads(selected) : { status: "none", candidateCount: 0 };
    }
    if (preferredRoots.length > 1) return { status: "ambiguous", candidateCount: preferredRoots.length };
    if (preferredRoots.length === 1) {
      const thread = preferredRoots[0];
      const quotaCandidate = candidates.find((candidate) => candidate.id === thread.id);
      if (quotaCandidate) return selectedQuotaThread(quotaCandidate);
      if (options.allowSwitchInterruptedActiveThread === true) {
        return {
          status: "selected",
          candidateCount: 1,
          candidate: {
            threadId: thread.id,
            interruptedAtMs: nowMs,
            reason: "switch_interrupted_active_thread"
          }
        };
      }
    }
    return { status: "none", candidateCount: 0 };
  }
  if (candidates.length === 0) return { status: "none", candidateCount: 0 };
  if (candidates.length > 1 && options.selectAllCandidates === true) {
    return selectedQuotaThreads(candidates.map(quotaCandidateFromThread));
  }
  if (candidates.length > 1) return { status: "ambiguous", candidateCount: candidates.length };
  return selectedQuotaThread(candidates[0]);
}

function selectedQuotaThread(thread) {
  const candidate = quotaCandidateFromThread(thread);
  return {
    status: "selected",
    candidateCount: 1,
    candidate
  };
}

function selectedQuotaThreads(candidates) {
  return candidates.length === 1
    ? { status: "selected", candidateCount: 1, candidate: candidates[0] }
    : { status: "selected", candidateCount: candidates.length, candidates };
}

function quotaCandidateFromThread(thread) {
  return { threadId: thread.id, interruptedAtMs: thread.lifecycleAtMs ?? thread.updatedAtMs,
    ...(thread.resumeReason ? { reason: thread.resumeReason } : {}),
    ...(thread.turnState === "running" ? { reason: "switch_interrupted_active_thread" } : {}) };
}

function isEligibleResumeRoot(thread) {
  return Boolean(thread)
    && thread.archived !== true
    && thread?.threadSource !== "subagent"
    && !thread?.parentThreadId;
}

export function filterLocalCodexThreads(threads, query = "") {
  const needle = normalizeSearchText(query);
  return threads.filter((thread) => !needle || [
      thread.id,
      thread.title,
      thread.projectName,
      thread.workspacePath,
      thread.category === "temporary_executor" ? "AgentBridge 临时执行器任务 临时执行器与自动化任务" : ""
    ]
      .some((value) => value.toLocaleLowerCase().includes(needle)));
}

export function codexThreadSidebarStateRevision(codexDir) {
  return codexThreadStateRevisions(codexDir).sidebarRevision;
}

export function codexThreadStateRevisions(codexDir) {
  try {
    const globalStatePath = path.join(codexDir, ".codex-global-state.json");
    const state = JSON.parse(fs.readFileSync(globalStatePath, "utf8"));
    const unread = [...unreadThreadIds(state)].sort();
    const databases = findStateDatabases(codexDir);
    const databasePins = readDatabasePinnedThreadEntries(databases);
    const pins = pinnedSidebarEntries(state, databasePins).map(({ type, id, pinnedIndex }) => [type, id, pinnedIndex]);
    const inventoryRevision = hashRevision({
      projects: state?.["local-projects"],
      assignments: state?.["thread-project-assignments"],
      workspaceHints: state?.["thread-workspace-root-hints"],
      sessionIndex: readSessionIndexRevision(path.join(codexDir, "session_index.jsonl")),
      threadMetadata: databases.map((databasePath) => [
        path.basename(databasePath),
        readThreadMetadataRevision(databasePath)
      ])
    });
    return {
      inventoryRevision,
      sidebarRevision: hashRevision({ unread, pins, inventoryRevision })
    };
  } catch {
    return { inventoryRevision: "", sidebarRevision: "" };
  }
}

function readThreadMetadataRevision(databasePath) {
  let database;
  try {
    database = new DatabaseSync(databasePath, { readOnly: true });
    const columns = new Set(database.prepare("PRAGMA table_info(threads)").all().map(({ name }) => String(name)));
    if (!columns.has("id")) return "unavailable";
    const rows = database.prepare(`SELECT
      id,
      ${columnOrNull(columns, "title")} AS title,
      ${columnOrNull(columns, "cwd")} AS workspacePath,
      ${columnOrNull(columns, "created_at_ms", "created_at")} AS createdAt,
      ${columnOrNull(columns, "updated_at_ms", "updated_at")} AS updatedAt,
      ${columnOrNull(columns, "archived")} AS archived,
      ${columnOrNull(columns, "archived_at")} AS archivedAt,
      ${columnOrNull(columns, "thread_source")} AS threadSource,
      ${columnOrNull(columns, "source")} AS rawSource,
      ${columnOrNull(columns, "agent_path")} AS agentPath,
      ${columnOrNull(columns, "rollout_path")} AS rolloutPath
      FROM threads
      ORDER BY id`).all();
    return hashRevision(rows);
  } catch {
    return "unavailable";
  } finally {
    database?.close();
  }
}

function readSessionIndexRevision(indexPath) {
  let stat;
  try {
    stat = fs.statSync(indexPath);
    const cached = sessionIndexRevisionCache.get(indexPath);
    if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) return cached.revision;
  } catch {
    return "unavailable";
  }
  let content;
  try {
    content = fs.readFileSync(indexPath, "utf8");
  } catch {
    return "unavailable";
  }
  const rows = [];
  for (const line of content.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      const id = normalizeText(row?.id);
      if (id) rows.push([id, normalizeText(row?.thread_name), normalizeTimestamp(row?.updated_at)]);
    } catch {}
  }
  rows.sort((left, right) => left[0].localeCompare(right[0]));
  const revision = hashRevision(rows);
  sessionIndexRevisionCache.set(indexPath, { size: stat.size, mtimeMs: stat.mtimeMs, revision });
  return revision;
}

export function remapLocalCodexThreadSidebarState(codexDir, threads) {
  try {
    const state = JSON.parse(fs.readFileSync(path.join(codexDir, ".codex-global-state.json"), "utf8"));
    const pinnedIndexes = pinnedThreadIndexes(state, readDatabasePinnedThreadEntries(findStateDatabases(codexDir)));
    const unreadIds = unreadThreadIds(state);
    const remapped = threads
      .filter((thread) => thread?.entityType !== "project")
      .map((thread) => applySidebarState(thread, pinnedIndexes, unreadIds));
    return [...remapped, ...pinnedProjectRows(state)];
  } catch {
    return threads;
  }
}

export function codexThreadIntegritySnapshot(codexDir) {
  const databases = findStateDatabases(codexDir);
  if (databases.length === 0) throw new Error("Codex thread state database is unavailable");
  const rows = [];
  for (const databasePath of databases) rows.push(...readThreadIntegrityRows(codexDir, databasePath));
  rows.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  const state = JSON.parse(fs.readFileSync(path.join(codexDir, ".codex-global-state.json"), "utf8"));
  const pins = pinnedSidebarEntries(state, readDatabasePinnedThreadEntries(databases))
    .map(({ type, id, pinnedIndex }) => [type, id, pinnedIndex]);
  const unread = [...unreadThreadIds(state)].sort();
  const rollouts = ["sessions", "archived_sessions"].flatMap((scope) =>
    latestMatchingFiles(path.join(codexDir, scope), /\.jsonl$/)
      .map(({ path: filePath }) => `${scope}/${path.relative(path.join(codexDir, scope), filePath).replaceAll("\\", "/")}`)
  ).sort();
  const sidebar = integritySidebarState(state);
  const archivedCount = rows.filter(([, , archived]) => archived).length;
  return {
    revision: hashRevision({ rows, rollouts, pins, unread, sidebar }),
    componentRevisions: {
      threadMetadata: hashRevision(rows),
      rolloutMembership: hashRevision(rollouts),
      pinnedThreads: hashRevision(pins),
      unreadThreads: hashRevision(unread),
      sidebarStructure: hashRevision(sidebar)
    },
    threadCount: rows.length,
    activeCount: rows.length - archivedCount,
    archivedCount,
    activeRolloutCount: rollouts.filter((item) => item.startsWith("sessions/")).length,
    archivedRolloutCount: rollouts.filter((item) => item.startsWith("archived_sessions/")).length
  };
}

function hashRevision(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").toUpperCase();
}

function readThreadIntegrityRows(codexDir, databasePath) {
  let database;
  try {
    database = new DatabaseSync(databasePath, { readOnly: true });
    const integrity = database.prepare("PRAGMA integrity_check").all();
    if (integrity.length !== 1 || Object.values(integrity[0])[0] !== "ok") {
      throw new Error("Codex thread state database integrity check failed");
    }
    const columns = new Set(database.prepare("PRAGMA table_info(threads)").all().map(({ name }) => String(name)));
    if (!columns.has("id") || !columns.has("archived")) throw new Error("Codex thread state schema is unsupported");
    return database.prepare(`SELECT
      id,
      archived,
      ${columnOrNull(columns, "archived_at")} AS archivedAt,
      ${columnOrNull(columns, "rollout_path")} AS rolloutPath
      FROM threads`).all().map((row) => [
        path.basename(databasePath),
        normalizeText(row.id),
        Boolean(Number(row.archived)),
        Number.isFinite(row.archivedAt) ? Math.floor(row.archivedAt) : null,
        rolloutScope(codexDir, row.rolloutPath)
      ]);
  } finally {
    database?.close();
  }
}

function rolloutScope(codexDir, rolloutPath) {
  if (typeof rolloutPath !== "string" || !rolloutPath.trim()) return "";
  const relative = path.relative(codexDir, rolloutPath).replaceAll("\\", "/");
  if (relative.startsWith("sessions/")) return "active";
  if (relative.startsWith("archived_sessions/")) return "archived";
  return "other";
}

function integritySidebarState(state) {
  const persisted = isRecord(state?.["electron-persisted-atom-state"])
    ? state["electron-persisted-atom-state"]
    : {};
  const assignments = isRecord(state?.["thread-project-assignments"])
    ? Object.entries(state["thread-project-assignments"]).map(([threadId, assignment]) => [
        threadId,
        isRecord(assignment) ? normalizeText(assignment.projectId) : ""
      ]).sort()
    : [];
  return {
    assignments,
    pinnedProjects: state?.["pinned-project-ids"],
    projectOrder: state?.["project-order"],
    projectlessThreads: state?.["projectless-thread-ids"],
    projectThreadOrders: state?.["sidebar-project-thread-orders"],
    presentation: Object.fromEntries(Object.entries(persisted)
      .filter(([key]) => key === "flat-project-sidebar-preferences-v1"
        || key === "sidebar-collapsed-sections-v1"
        || key === "sidebar-project-list-expanded-v1"
        || key.startsWith("sidebar-project-expanded-v1-"))
      .sort(([left], [right]) => left.localeCompare(right)))
  };
}

function readThreadDatabase(databasePath, threads, protectedActiveThreadIds = new Set()) {
  let database;
  try {
    database = new DatabaseSync(databasePath, { readOnly: true });
    const columns = new Set(database.prepare("PRAGMA table_info(threads)").all().map(({ name }) => String(name)));
    if (!columns.has("id")) return false;
    const rows = database.prepare(`SELECT
      id,
      ${columnOrNull(columns, "title")} AS title,
      ${columnOrNull(columns, "cwd")} AS workspacePath,
      ${columnOrNull(columns, "created_at_ms", "created_at")} AS createdAt,
      ${columnOrNull(columns, "updated_at_ms", "updated_at")} AS updatedAt,
      ${columnOrNull(columns, "archived")} AS archived,
      ${columnOrNull(columns, "thread_source")} AS threadSource,
      ${columnOrNull(columns, "source")} AS rawSource,
      ${columnOrNull(columns, "agent_path")} AS agentPath,
      ${columnOrNull(columns, "rollout_path")} AS rolloutPath
      FROM threads`).all();
    for (const row of rows) {
      const sourceMetadata = subagentMetadata(row.threadSource, row.rawSource, row.agentPath);
      const rolloutMetadata = readRolloutMetadata(row.rolloutPath, row.id, protectedActiveThreadIds);
      const thread = normalizeThread({
        id: row.id,
        title: row.title,
        workspacePath: row.workspacePath,
        createdAtMs: row.createdAt,
        updatedAtMs: row.updatedAt,
        archived: row.archived,
        source: "state_database",
        ...sourceMetadata,
        parentThreadId: sourceMetadata.parentThreadId || rolloutMetadata.parentThreadId,
        category: normalizeText(row.rawSource) === "exec" ? "temporary_executor" : undefined,
        turnState: rolloutMetadata.turnState,
        lifecycleAtMs: rolloutMetadata.lifecycleAtMs,
        resumeReason: rolloutMetadata.resumeReason
      });
      if (thread) mergeDatabaseThread(threads, thread);
    }
    return true;
  } catch {
    return false;
  } finally {
    database?.close();
  }
}

function readSessionIndex(indexPath, threads, options = {}) {
  let content;
  try {
    content = fs.readFileSync(indexPath, "utf8");
  } catch {
    return;
  }
  for (const line of content.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      const thread = normalizeThread({
        id: row?.id,
        title: row?.thread_name,
        updatedAtMs: row?.updated_at,
        source: "session_index"
      });
      if (thread) mergeSessionIndexThread(threads, thread, options.allowInventory === true);
    } catch {}
  }
}

function mergeDatabaseThread(threads, thread) {
  const current = threads.get(thread.id);
  if (!current || compareUpdatedAt(thread, current) >= 0) threads.set(thread.id, thread);
}

function mergeSessionIndexThread(threads, thread, allowInventory = false) {
  const current = threads.get(thread.id);
  if (!current) {
    if (allowInventory) threads.set(thread.id, thread);
    return;
  }
  if (current.source !== "session_index") {
    if (thread.title) threads.set(thread.id, { ...current, title: thread.title });
    return;
  }
  if (compareUpdatedAt(thread, current) >= 0) threads.set(thread.id, thread);
}

function applyProjectMetadata(globalStatePath, threads) {
  let state;
  try {
    state = JSON.parse(fs.readFileSync(globalStatePath, "utf8"));
  } catch {
    return;
  }
  const projects = isRecord(state?.["local-projects"]) ? state["local-projects"] : {};
  const assignments = isRecord(state?.["thread-project-assignments"]) ? state["thread-project-assignments"] : {};
  const workspaceHints = isRecord(state?.["thread-workspace-root-hints"]) ? state["thread-workspace-root-hints"] : {};
  const projectsByRoot = indexProjectsByRoot(projects);
  const codexDir = path.dirname(globalStatePath);
  const pinnedIndexes = pinnedThreadIndexes(state, readDatabasePinnedThreadEntries(findStateDatabases(codexDir)));
  const unreadIds = unreadThreadIds(state);
  for (const [id, thread] of threads) {
    const assignment = isRecord(assignments[id]) ? assignments[id] : {};
    const assignedProject = isRecord(projects[assignment.projectId]) ? projects[assignment.projectId] : undefined;
    const workspacePath = normalizeWorkspacePath(assignment.cwd) || thread.workspacePath || normalizeWorkspacePath(workspaceHints[id]);
    const projectByRoot = projectsByRoot.get(workspacePath.toLocaleLowerCase());
    const projectId = assignedProject
      ? (normalizeText(assignedProject.id) || normalizeText(assignment.projectId))
      : normalizeText(projectByRoot?.id);
    const next = applySidebarState({
      ...thread,
      workspacePath,
      ...(projectId ? { projectId } : {}),
      projectName: assignedProject ? normalizeText(assignedProject.name) : (projectByRoot?.name ?? "")
    }, pinnedIndexes, unreadIds);
    threads.set(id, next);
  }
  for (const project of pinnedProjectRows(state)) threads.set(project.id, project);
}

function applySidebarState(thread, pinnedIndexes, unreadIds) {
  const next = { ...thread };
  delete next.pinnedIndex;
  delete next.unread;
  if (pinnedIndexes.has(thread.id)) next.pinnedIndex = pinnedIndexes.get(thread.id);
  if (unreadIds.has(thread.id)) next.unread = true;
  return next;
}

function indexProjectsByRoot(projects) {
  const indexed = new Map();
  for (const [key, project] of Object.entries(projects)) {
    if (!isRecord(project)) continue;
    const id = normalizeText(project.id) || key;
    const name = normalizeText(project.name);
    for (const root of Array.isArray(project.rootPaths) ? project.rootPaths : []) {
      const normalized = normalizeWorkspacePath(root).toLocaleLowerCase();
      if (!normalized) continue;
      const existing = indexed.get(normalized);
      if (!existing || existing.id === id) indexed.set(normalized, { id, name });
      else indexed.set(normalized, null);
    }
  }
  return indexed;
}

function pinnedThreadIndexes(state, databasePins) {
  return new Map(pinnedSidebarEntries(state, databasePins)
    .filter(({ type }) => type === "thread")
    .map(({ id, pinnedIndex }) => [id, pinnedIndex]));
}

function pinnedSidebarEntries(state, databasePins) {
  const persisted = isRecord(state?.["electron-persisted-atom-state"])
    ? state["electron-persisted-atom-state"]
    : {};
  const appServerOrder = persisted["app-server-pinned-thread-order-v1"];
  const unifiedOrder = persisted["unified-sidebar-pinned-order-v1"];
  const clientMappings = new Map(Object.entries(persisted)
    .filter(([key, value]) => key.startsWith("thread-client-id-v1:local%3A") && typeof value === "string")
    .map(([key, value]) => [value, key.slice("thread-client-id-v1:local%3A".length)]));
  const legacyIds = Array.isArray(state?.["pinned-thread-ids"])
    ? state["pinned-thread-ids"].map(normalizeText).filter(Boolean)
    : undefined;
  const entries = Array.isArray(appServerOrder)
    ? appServerOrder.map((value, index) => typeof value === "string"
      ? { type: "thread", id: normalizeText(value), pinnedIndex: index + 1 }
      : undefined)
    : Array.isArray(databasePins)
    ? databasePins
    : Array.isArray(unifiedOrder)
    ? unifiedOrder.map((value, index) => {
        if (typeof value !== "string") return undefined;
        if (value.startsWith("codex:thread:local:")) {
          const rawId = value.slice("codex:thread:local:".length);
          return { type: "thread", id: normalizeText(clientMappings.get(rawId) ?? rawId), pinnedIndex: index + 1 };
        }
        if (value.startsWith("codex:project:")) {
          return { type: "project", id: normalizeText(value.slice("codex:project:".length)), pinnedIndex: index + 1 };
        }
        return undefined;
      })
    : (legacyIds ?? []).map((id, index) => ({ type: "thread", id, pinnedIndex: index + 1 }));
  const seen = new Set();
  return entries.filter((entry) => {
    if (!entry?.id) return false;
    const key = `${entry.type}:${entry.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function readDatabasePinnedThreadEntries(databasePaths) {
  const pinned = new Map();
  let supported = false;
  for (const databasePath of databasePaths) {
    let database;
    try {
      database = new DatabaseSync(databasePath, { readOnly: true });
      const columns = new Set(database.prepare("PRAGMA table_info(threads)").all().map(({ name }) => String(name)));
      if (!columns.has("id") || !columns.has("is_pinned")) continue;
      supported = true;
      const recencyColumn = columns.has("recency_at_ms")
        ? "recency_at_ms"
        : columns.has("updated_at_ms") ? "updated_at_ms" : columns.has("updated_at") ? "updated_at" : "0";
      for (const row of database.prepare(`SELECT id, ${recencyColumn} AS pinRecency FROM threads WHERE is_pinned = 1`).all()) {
        const id = normalizeText(row.id);
        if (!id) continue;
        const pinRecency = normalizeTimestamp(row.pinRecency) ?? 0;
        const current = pinned.get(id);
        if (!current || pinRecency > current.pinRecency) pinned.set(id, { id, pinRecency });
      }
    } catch {
      continue;
    } finally {
      database?.close();
    }
  }
  if (!supported) return undefined;
  return [...pinned.values()]
    .sort((left, right) => right.pinRecency - left.pinRecency || left.id.localeCompare(right.id))
    .map(({ id }, index) => ({ type: "thread", id, pinnedIndex: index + 1 }));
}

function pinnedProjectRows(state) {
  const projects = isRecord(state?.["local-projects"]) ? state["local-projects"] : {};
  const byId = new Map();
  for (const [key, project] of Object.entries(projects)) {
    if (isRecord(project)) byId.set(normalizeText(project.id) || key, project);
  }
  return pinnedSidebarEntries(state)
    .filter(({ type }) => type === "project")
    .map(({ id, pinnedIndex }) => {
      const project = isRecord(projects[id]) ? projects[id] : byId.get(id);
      const rootPaths = (Array.isArray(project?.rootPaths) ? project.rootPaths : [])
        .map(normalizeWorkspacePath)
        .filter(Boolean);
      return {
        id: `codex:project:${id}`,
        entityType: "project",
        projectId: id,
        title: normalizeText(project?.name),
        projectName: normalizeText(project?.name),
        workspacePath: rootPaths[0] ?? "",
        rootPaths,
        createdAtMs: normalizeTimestamp(project?.createdAt),
        updatedAtMs: normalizeTimestamp(project?.updatedAt),
        pinnedIndex
      };
    });
}

function unreadThreadIds(state) {
  const persisted = isRecord(state?.["electron-persisted-atom-state"])
    ? state["electron-persisted-atom-state"]
    : {};
  const byHost = isRecord(persisted["unread-thread-ids-by-host-v1"])
    ? persisted["unread-thread-ids-by-host-v1"]
    : {};
  return new Set(Array.isArray(byHost.local) ? byHost.local.map(normalizeText).filter(Boolean) : []);
}

function subagentMetadata(threadSource, rawSource, agentPath) {
  let source;
  try {
    source = typeof rawSource === "string" ? JSON.parse(rawSource) : rawSource;
  } catch {}
  const spawn = isRecord(source?.subagent?.thread_spawn) ? source.subagent.thread_spawn : {};
  const parentThreadId = normalizeText(spawn.parent_thread_id);
  if (normalizeText(threadSource) !== "subagent" && !parentThreadId) return {};
  return {
    threadSource: "subagent",
    parentThreadId,
    agentPath: normalizeText(agentPath) || normalizeText(spawn.agent_path)
  };
}

function readRolloutMetadata(rolloutPath, threadId, protectedActiveThreadIds = new Set()) {
  const filePath = typeof rolloutPath === "string" ? rolloutPath.trim() : "";
  if (!filePath) return {};
  let handle;
  try {
    const size = fs.statSync(filePath).size;
    if (!size) return {};
    const headLength = Math.min(size, SESSION_HEAD_BYTES);
    const headBuffer = Buffer.alloc(headLength);
    handle = fs.openSync(filePath, "r");
    const headBytesRead = fs.readSync(handle, headBuffer, 0, headLength, 0);
    const headLines = headBuffer.subarray(0, headBytesRead).toString("utf8").split(/\r?\n/);
    if (headLength < size) headLines.pop();
    let parentThreadId;
    for (const line of headLines) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        if (event?.type === "session_meta") {
          parentThreadId = normalizeText(event?.payload?.parent_thread_id);
          break;
        }
      } catch {}
    }
    const length = Math.min(size, LIFECYCLE_TAIL_BYTES);
    const start = size - length;
    const buffer = Buffer.alloc(length);
    const bytesRead = fs.readSync(handle, buffer, 0, length, start);
    const lines = buffer.subarray(0, bytesRead).toString("utf8").split(/\r?\n/);
    if (start > 0) lines.shift();
    const latestTailLifecycle = latestRolloutLifecycle(lines);
    if (latestTailLifecycle) {
      return resolveRolloutLifecycle(latestTailLifecycle, parentThreadId, threadId, protectedActiveThreadIds);
    }
    if (start > 0) {
      const latestLifecycle = scanRolloutLifecycle(handle, size);
      if (latestLifecycle) {
        return resolveRolloutLifecycle(latestLifecycle, parentThreadId, threadId, protectedActiveThreadIds);
      }
    }
    return { parentThreadId };
  } catch {
    return {};
  } finally {
    if (handle !== undefined) fs.closeSync(handle);
  }
}

function latestRolloutLifecycle(lines) {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const lifecycle = parseRolloutLifecycle(lines[index]);
    if (lifecycle) return lifecycle;
  }
  return undefined;
}

function scanRolloutLifecycle(handle, size) {
  const buffer = Buffer.alloc(LIFECYCLE_SCAN_CHUNK_BYTES);
  let offset = 0;
  let remainder = "";
  let latest;
  while (offset < size) {
    const chunkLength = Math.min(buffer.length, size - offset);
    const bytesRead = fs.readSync(handle, buffer, 0, chunkLength, offset);
    if (bytesRead <= 0) break;
    const lines = `${remainder}${buffer.subarray(0, bytesRead).toString("utf8")}`.split("\n");
    remainder = lines.pop() ?? "";
    for (const line of lines) {
      const lifecycle = parseRolloutLifecycle(line);
      if (lifecycle) latest = lifecycle;
    }
    offset += bytesRead;
  }
  const finalLifecycle = parseRolloutLifecycle(remainder);
  return finalLifecycle ?? latest;
}

function parseRolloutLifecycle(line) {
  if (!line?.trim()) return undefined;
  let event;
  try {
    event = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (event?.type !== "event_msg") return undefined;
  const type = event?.payload?.type;
  if (!["task_started", "task_complete", "turn_aborted"].includes(type)) return undefined;
  const error = event?.payload?.error;
  const usageLimited = error?.codex_error_info === "usage_limit_exceeded"
    || error?.code === "usage_limit_exceeded"
    || error?.type === "usage_limit_exceeded";
  return {
    type,
    timestamp: event?.timestamp,
    failed: Boolean(error),
    resumeReason: usageLimited ? undefined
      : error?.codex_error_info === "server_overloaded" ? "server_overloaded"
      : error ? "task_failed" : undefined,
    usageLimited
  };
}

function resolveRolloutLifecycle(lifecycle, parentThreadId, threadId, protectedActiveThreadIds) {
  const evidence = {
    parentThreadId,
    lifecycleAtMs: normalizeTimestamp(lifecycle.timestamp),
    ...(lifecycle.resumeReason ? { resumeReason: lifecycle.resumeReason } : {})
  };
  if (lifecycle.type === "task_started") {
    if (protectedActiveThreadIds.has(normalizeProtectedActiveThreadId(threadId))) {
      return { ...evidence, turnState: "running" };
    }
    const startedAtMs = normalizeTimestamp(lifecycle.timestamp);
    if (!Number.isFinite(startedAtMs)) return { parentThreadId };
    const coldHistoricalStart = Date.now() - startedAtMs > COLD_ACTIVE_RECOVERY_MS;
    return coldHistoricalStart ? { parentThreadId } : { ...evidence, turnState: "running" };
  }
  if (lifecycle.type === "turn_aborted") {
    return { ...evidence, turnState: lifecycle.usageLimited ? "usage_limited" : lifecycle.failed ? "failed" : "interrupted" };
  }
  return {
    ...evidence,
    turnState: lifecycle.usageLimited ? "usage_limited" : lifecycle.failed ? "failed" : "completed"
  };
}

function compareUpdatedAt(left, right) {
  return (left.updatedAtMs ?? 0) - (right.updatedAtMs ?? 0);
}

function protectTemporaryExecutorMetadata(thread) {
  const workspacePath = thread.workspacePath.toLocaleLowerCase();
  const structuredExecutorTitle = thread.title.startsWith("You are an explicitly selected read-only AgentBridge workflow worker.")
    && /"kind"\s*:\s*"executor"/i.test(thread.title);
  if (thread.category !== "temporary_executor"
    && !workspacePath.includes("\\evidence\\disposable-runtimes\\")
    && !structuredExecutorTitle) return thread;
  return {
    ...thread,
    title: "AgentBridge temporary executor task",
    category: "temporary_executor"
  };
}

function columnOrNull(columns, preferred, fallback) {
  if (columns.has(preferred)) return preferred;
  return fallback && columns.has(fallback) ? fallback : "NULL";
}

function normalizeThread(value) {
  const id = normalizeText(value.id);
  if (!id) return undefined;
  const thread = {
    id,
    title: normalizeText(value.title),
    workspacePath: normalizeWorkspacePath(value.workspacePath),
    projectName: "",
    createdAtMs: normalizeTimestamp(value.createdAtMs),
    updatedAtMs: normalizeTimestamp(value.updatedAtMs),
    archived: Boolean(Number(value.archived)),
    source: value.source
  };
  if (value.threadSource === "subagent") thread.threadSource = "subagent";
  if (value.parentThreadId) thread.parentThreadId = normalizeText(value.parentThreadId);
  if (value.agentPath) thread.agentPath = normalizeText(value.agentPath);
  if (value.category) thread.category = normalizeText(value.category);
  if (value.turnState) thread.turnState = value.turnState;
  if (Number.isFinite(value.lifecycleAtMs)) thread.lifecycleAtMs = value.lifecycleAtMs;
  if (value.resumeReason) thread.resumeReason = value.resumeReason;
  return thread;
}

function normalizeWorkspacePath(value) {
  let workspacePath = normalizeText(value);
  if (workspacePath.startsWith("\\\\?\\UNC\\")) workspacePath = `\\\\${workspacePath.slice(8)}`;
  else if (workspacePath.startsWith("\\\\?\\")) workspacePath = workspacePath.slice(4);
  return path.win32.isAbsolute(workspacePath) ? path.win32.normalize(workspacePath) : workspacePath;
}

function normalizeProtectedActiveThreadIds(value) {
  const values = value instanceof Set ? [...value] : Array.isArray(value) ? value : [];
  return new Set(values.map(normalizeProtectedActiveThreadId).filter(Boolean));
}

function normalizeProtectedActiveThreadId(value) {
  const text = typeof value === "string" ? value.trim() : "";
  return text && text.length <= 200 ? text : undefined;
}

function normalizeSearchText(value) {
  return normalizeText(value).slice(0, MAX_SEARCH_LENGTH).toLocaleLowerCase();
}

function normalizeText(value) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, MAX_TEXT_LENGTH) : "";
}

function normalizeTimestamp(value) {
  if (Number.isFinite(value)) return Math.floor(value);
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
