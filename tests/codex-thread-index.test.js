import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { DatabaseSync } from "node:sqlite";
import {
  codexThreadIntegritySnapshot,
  codexThreadSidebarStateRevision,
  codexThreadStateRevisions,
  remapLocalCodexThreadSidebarState,
  selectQuotaInterruptedThread,
  selectQuotaInterruptedThreadFromThreads,
  searchLocalCodexThreads
} from "../src/core/codex-thread-index.js";

const roots = new Set();
test("unfinished selection uses lifecycle time and excludes cancelled or completed preferred tasks", () => {
  const threads = [
    { id: "capacity", turnState: "failed", updatedAtMs: 9900, lifecycleAtMs: 9500, resumeReason: "server_overloaded" },
    { id: "old-error", turnState: "failed", updatedAtMs: 9900, lifecycleAtMs: 1000 },
    { id: "cancelled", turnState: "interrupted", updatedAtMs: 9800 },
    { id: "done", turnState: "completed", updatedAtMs: 9800 },
    { id: "active", turnState: "running", updatedAtMs: 9700, lifecycleAtMs: 9600 }
  ];
  const result = selectQuotaInterruptedThreadFromThreads(threads, {
    nowMs: 10000, minInterruptedAtMs: 9000, lookbackMs: 10000,
    includeUnfinished: true, selectAllCandidates: true,
    preferredThreadIds: ["done", "cancelled", "active"], allowSwitchInterruptedActiveThread: true
  });
  assert.deepEqual(result.candidates.map((item) => item.threadId), ["active", "capacity"]);
  assert.equal(result.candidates[1].interruptedAtMs, 9500);
  assert.equal(result.candidates[1].reason, "server_overloaded");
});
test("capacity failure selection preserves the original rollout lifecycle timestamp", () => {
  const { codexDir } = fixture();
  const database = createThreadDatabase(codexDir);
  const rollout = path.join(codexDir, "rollout-capacity.jsonl");
  database.prepare(`INSERT INTO threads (id, title, created_at_ms, updated_at_ms, archived, thread_source, rollout_path)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run("capacity", "test", 1000, 9900, 0, "user", rollout);
  database.close();
  fs.writeFileSync(rollout, JSON.stringify({ timestamp: new Date(9500).toISOString(), type: "event_msg",
    payload: { type: "task_complete", error: { codex_error_info: "server_overloaded" } } }) + "\n");
  const result = selectQuotaInterruptedThread(codexDir, { nowMs: 10000, lookbackMs: 2000,
    minInterruptedAtMs: 9000, includeUnfinished: true, selectAllCandidates: true });
  assert.equal(result.candidate.reason, "server_overloaded");
  assert.equal(result.candidate.interruptedAtMs, 9500);
  assert.equal(selectQuotaInterruptedThread(codexDir, { nowMs: 10000, lookbackMs: 2000,
    minInterruptedAtMs: 9600, includeUnfinished: true }).status, "none");
});

after(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "switcher-thread-index-"));
  roots.add(root);
  const codexDir = path.join(root, ".codex");
  fs.mkdirSync(codexDir, { recursive: true });
  return { root, codexDir };
}

function createThreadDatabase(codexDir, name = "state_5.sqlite") {
  const database = new DatabaseSync(path.join(codexDir, name));
  database.exec(`
    CREATE TABLE threads (
      id TEXT PRIMARY KEY,
      title TEXT,
      cwd TEXT,
      created_at_ms INTEGER,
      updated_at_ms INTEGER,
      archived INTEGER,
      archived_at INTEGER,
      thread_source TEXT,
      source TEXT,
      agent_path TEXT,
      rollout_path TEXT,
      preview TEXT,
      first_user_message TEXT
    )
  `);
  return database;
}

test("sidebar and inventory revisions separate pin state from persistent metadata", () => {
  const { codexDir } = fixture();
  const statePath = path.join(codexDir, ".codex-global-state.json");
  const writeState = (unread, pins, unrelated = 1) => fs.writeFileSync(statePath, JSON.stringify({
    unrelated,
    "electron-persisted-atom-state": {
      "unread-thread-ids-by-host-v1": { local: unread },
      "unified-sidebar-pinned-order-v1": pins
    }
  }));

  writeState(["thread-b", "thread-a"], ["codex:thread:local:thread-a"]);
  const first = codexThreadStateRevisions(codexDir);
  writeState(["thread-b", "thread-a"], ["codex:project:project-a", "codex:thread:local:thread-a"]);
  const afterProjectPin = codexThreadStateRevisions(codexDir);
  writeState(["thread-a"], ["codex:thread:local:thread-a"]);
  const afterRead = codexThreadStateRevisions(codexDir);
  writeState(["thread-a"], ["codex:thread:local:thread-a"], 2);
  const unrelatedGlobalChange = codexThreadStateRevisions(codexDir);
  const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  state["thread-project-assignments"] = { "thread-a": { projectId: "project-a" } };
  fs.writeFileSync(statePath, JSON.stringify(state));
  const projectMetadataChange = codexThreadStateRevisions(codexDir);
  fs.writeFileSync(path.join(codexDir, "session_index.jsonl"), `${JSON.stringify({ id: "thread-a", thread_name: "renamed" })}\n`);
  const sessionIndexChange = codexThreadStateRevisions(codexDir);
  const database = createThreadDatabase(codexDir);
  database.prepare(`
    INSERT INTO threads (id, title, created_at_ms, updated_at_ms, archived)
    VALUES (?, ?, ?, ?, ?)
  `).run("thread-a", "Created", 1, 1, 0);
  database.close();
  const databaseChange = codexThreadStateRevisions(codexDir);

  assert.equal(codexThreadSidebarStateRevision(codexDir), databaseChange.sidebarRevision);
  assert.match(first.sidebarRevision, /^[A-F0-9]{64}$/);
  assert.match(first.inventoryRevision, /^[A-F0-9]{64}$/);
  assert.notEqual(first.sidebarRevision, afterProjectPin.sidebarRevision);
  assert.equal(first.inventoryRevision, afterProjectPin.inventoryRevision);
  assert.notEqual(first.sidebarRevision, afterRead.sidebarRevision);
  assert.equal(first.inventoryRevision, afterRead.inventoryRevision);
  assert.deepEqual(afterRead, unrelatedGlobalChange);
  assert.notEqual(unrelatedGlobalChange.inventoryRevision, projectMetadataChange.inventoryRevision);
  assert.notEqual(projectMetadataChange.inventoryRevision, sessionIndexChange.inventoryRevision);
  assert.notEqual(sessionIndexChange.inventoryRevision, databaseChange.inventoryRevision);
  fs.writeFileSync(statePath, "{");
  assert.equal(codexThreadSidebarStateRevision(codexDir), "");
});

test("remaps pin and unread state without rebuilding complete thread metadata", () => {
  const { codexDir } = fixture();
  fs.writeFileSync(path.join(codexDir, ".codex-global-state.json"), JSON.stringify({
    "electron-persisted-atom-state": {
      "unified-sidebar-pinned-order-v1": ["codex:thread:local:thread-a"],
      "unread-thread-ids-by-host-v1": { local: ["thread-a"] }
    }
  }));

  assert.deepEqual(remapLocalCodexThreadSidebarState(codexDir, [{
    id: "thread-a",
    title: "Keep complete metadata",
    turnState: "completed",
    pinnedIndex: 9
  }]), [{
    id: "thread-a",
    title: "Keep complete metadata",
    turnState: "completed",
    pinnedIndex: 1,
    unread: true
  }]);
});

test("remaps project pin additions and removals without rebuilding thread metadata", () => {
  const { codexDir } = fixture();
  const statePath = path.join(codexDir, ".codex-global-state.json");
  fs.writeFileSync(statePath, JSON.stringify({
    "local-projects": {
      "project-a": { id: "project-a", name: "Pinned project", rootPaths: ["D:\\Project"] }
    },
    "electron-persisted-atom-state": {
      "unified-sidebar-pinned-order-v1": ["codex:project:project-a"]
    }
  }));
  const baseThreads = [{ id: "thread-a", title: "Keep complete metadata" }];
  const withProject = remapLocalCodexThreadSidebarState(codexDir, baseThreads);
  assert.equal(withProject.filter(({ entityType }) => entityType === "project").length, 1);

  fs.writeFileSync(statePath, JSON.stringify({
    "local-projects": {
      "project-a": { id: "project-a", name: "Pinned project", rootPaths: ["D:\\Project"] }
    },
    "electron-persisted-atom-state": { "unified-sidebar-pinned-order-v1": [] }
  }));
  const withoutProject = remapLocalCodexThreadSidebarState(codexDir, withProject);
  assert.deepEqual(withoutProject, baseThreads);
});

test("searches newest local thread metadata by title, ID, and workspace without exposing bodies", () => {
  const { codexDir } = fixture();
  const database = createThreadDatabase(codexDir);
  database.prepare(`
    INSERT INTO threads (id, title, cwd, created_at_ms, updated_at_ms, archived, thread_source, preview, first_user_message)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "thread-switcher",
    "检查 Switcher 自动切换",
    "D:\\Projects\\Secure Codex Switcher",
    1_700_000_000_000,
    1_700_000_100_000,
    0,
    "app",
    "PRIVATE PREVIEW",
    "PRIVATE USER MESSAGE"
  );
  database.close();
  fs.writeFileSync(
    path.join(codexDir, "session_index.jsonl"),
    [
      JSON.stringify({ id: "thread-index-only", thread_name: "审查线程检索", updated_at: "2026-07-24T12:00:00.000Z" }),
      JSON.stringify({ id: "thread-switcher", thread_name: "稳定的 Switcher 标题", updated_at: "2026-07-24T11:00:00.000Z" })
    ].join("\n") + "\n",
    "utf8"
  );
  fs.mkdirSync(path.join(codexDir, "sessions"), { recursive: true });
  fs.writeFileSync(path.join(codexDir, "sessions", "rollout-private.jsonl"), "PRIVATE ROLLOUT BODY\n", "utf8");

  const titleResults = searchLocalCodexThreads(codexDir, "switcher");
  const idResults = searchLocalCodexThreads(codexDir, "thread-index-only");
  const pathResults = searchLocalCodexThreads(codexDir, "secure codex");

  assert.deepEqual(titleResults, [{
    id: "thread-switcher",
    title: "稳定的 Switcher 标题",
    workspacePath: "D:\\Projects\\Secure Codex Switcher",
    projectName: "",
    createdAtMs: 1_700_000_000_000,
    updatedAtMs: 1_700_000_100_000,
    archived: false,
    source: "state_database"
  }]);
  assert.deepEqual(idResults, []);
  assert.equal(pathResults[0].id, "thread-switcher");
  assert.equal(JSON.stringify(titleResults).includes("PRIVATE"), false);
  assert.deepEqual(Object.keys(titleResults[0]).sort(), ["archived", "createdAtMs", "id", "projectName", "source", "title", "updatedAtMs", "workspacePath"]);
});

test("keeps session-index search available when a state database cannot be read", () => {
  const { codexDir } = fixture();
  fs.writeFileSync(path.join(codexDir, "state_broken.sqlite"), "not a database", "utf8");
  fs.writeFileSync(
    path.join(codexDir, "session_index.jsonl"),
    `${JSON.stringify({ id: "thread-fallback", thread_name: "仅索引可见", updated_at: "2026-07-24T09:00:00.000Z" })}\n`,
    "utf8"
  );

  assert.deepEqual(searchLocalCodexThreads(codexDir, "索引"), [{
    id: "thread-fallback",
    title: "仅索引可见",
    workspacePath: "",
    projectName: "",
    createdAtMs: undefined,
    updatedAtMs: Date.parse("2026-07-24T09:00:00.000Z"),
    archived: false,
    source: "session_index"
  }]);
});

test("empty query returns persistent threads in most-recently-updated order", () => {
  const { codexDir } = fixture();
  const database = createThreadDatabase(codexDir);
  const insert = database.prepare(`
    INSERT INTO threads (id, title, cwd, created_at_ms, updated_at_ms, archived, thread_source, preview, first_user_message)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insert.run("thread-older", "Older", "D:\\Older", 100, 200, 0, "app", "PRIVATE", "PRIVATE");
  insert.run("thread-newer", "Newer", "D:\\Newer", 300, 400, 0, "app", "PRIVATE", "PRIVATE");
  database.close();

  const results = searchLocalCodexThreads(codexDir, "");
  assert.deepEqual(results.map(({ id }) => id), ["thread-newer", "thread-older"]);
  assert.equal(JSON.stringify(results).includes("PRIVATE"), false);
});

test("uses Codex project assignment metadata and normalizes the task directory", () => {
  const { codexDir } = fixture();
  const database = createThreadDatabase(codexDir);
  database.prepare(`
    INSERT INTO threads (id, title, cwd, created_at_ms, updated_at_ms, archived, thread_source, preview, first_user_message)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "thread-project",
    "<codex_delegation>transport title</codex_delegation>",
    "\\\\?\\D:\\Raw Database Path",
    100,
    200,
    0,
    "app",
    "PRIVATE PREVIEW",
    "PRIVATE USER MESSAGE"
  );
  database.close();
  fs.writeFileSync(
    path.join(codexDir, "session_index.jsonl"),
    `${JSON.stringify({ id: "thread-project", thread_name: "稳定项目标题", updated_at: "2026-07-24T09:00:00.000Z" })}\n`,
    "utf8"
  );
  fs.writeFileSync(
    path.join(codexDir, ".codex-global-state.json"),
    JSON.stringify({
      "local-projects": {
        "project-switcher": {
          id: "project-switcher",
          name: "Secure Codex Switcher Workspace",
          rootPaths: ["D:\\Secure Codex Switcher Workspace"]
        }
      },
      "thread-project-assignments": {
        "thread-project": {
          projectKind: "local",
          projectId: "project-switcher",
          cwd: "\\\\?\\D:\\Secure Codex Switcher Workspace"
        }
      }
    }),
    "utf8"
  );

  assert.deepEqual(searchLocalCodexThreads(codexDir, "secure codex"), [{
    id: "thread-project",
    title: "稳定项目标题",
    workspacePath: "D:\\Secure Codex Switcher Workspace",
    projectId: "project-switcher",
    projectName: "Secure Codex Switcher Workspace",
    createdAtMs: 100,
    updatedAtMs: 200,
    archived: false,
    source: "state_database"
  }]);
});

test("keeps an assigned task directory without inventing a missing project", () => {
  const { codexDir } = fixture();
  const database = createThreadDatabase(codexDir);
  database.prepare(`
    INSERT INTO threads (id, title, cwd, created_at_ms, updated_at_ms, archived, thread_source, preview, first_user_message)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run("thread-orphan", "Orphan", "\\\\?\\D:\\Workbuddy\\Task", 100, 200, 0, "app", "PRIVATE", "PRIVATE");
  database.close();
  fs.writeFileSync(
    path.join(codexDir, ".codex-global-state.json"),
    JSON.stringify({
      "local-projects": {},
      "thread-project-assignments": {
        "thread-orphan": {
          projectKind: "local",
          projectId: "missing-project",
          cwd: "\\\\?\\D:\\Workbuddy\\Task"
        }
      }
    }),
    "utf8"
  );

  const [result] = searchLocalCodexThreads(codexDir, "workbuddy");
  assert.equal(result.workspacePath, "D:\\Workbuddy\\Task");
  assert.equal(result.projectName, "");
  assert.equal(JSON.stringify(result).includes("PRIVATE"), false);
});

test("infers only one exact registered project root when an assignment is missing or stale", () => {
  const { codexDir } = fixture();
  const database = createThreadDatabase(codexDir);
  const insert = database.prepare(`
    INSERT INTO threads (id, title, cwd, created_at_ms, updated_at_ms, archived, thread_source)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  insert.run("thread-missing", "Missing", "\\\\?\\D:\\Projects\\Exact", 100, 400, 0, "app");
  insert.run("thread-stale", "Stale", "d:\\projects\\exact", 100, 300, 0, "app");
  insert.run("thread-prefix", "Prefix", "D:\\Projects\\Exact\\Child", 100, 200, 0, "app");
  insert.run("thread-ambiguous", "Ambiguous", "D:\\Projects\\Shared", 100, 100, 0, "app");
  database.close();
  const globalState = {
    "local-projects": {
      exact: { id: "exact", name: "Exact Project", rootPaths: ["D:\\Projects\\Exact"] },
      sharedA: { id: "sharedA", name: "Shared A", rootPaths: ["D:\\Projects\\Shared"] },
      sharedB: { id: "sharedB", name: "Shared B", rootPaths: ["d:\\projects\\shared"] }
    },
    "thread-project-assignments": {
      "thread-stale": { projectId: "deleted-project", cwd: "D:\\Projects\\Exact" }
    }
  };
  const globalStatePath = path.join(codexDir, ".codex-global-state.json");
  fs.writeFileSync(globalStatePath, JSON.stringify(globalState), "utf8");

  const results = searchLocalCodexThreads(codexDir);

  assert.equal(results.find(({ id }) => id === "thread-missing").projectName, "Exact Project");
  assert.equal(results.find(({ id }) => id === "thread-stale").projectName, "Exact Project");
  assert.equal(results.find(({ id }) => id === "thread-prefix").projectName, "");
  assert.equal(results.find(({ id }) => id === "thread-ambiguous").projectName, "");
  assert.deepEqual(JSON.parse(fs.readFileSync(globalStatePath, "utf8")), globalState);
});

test("classifies disposable AgentBridge executors without returning their instruction title", () => {
  const { codexDir } = fixture();
  const database = createThreadDatabase(codexDir);
  const instruction = [
    "You are an explicitly selected read-only AgentBridge workflow worker.",
    '{"kind":"executor","node_id":"codex-node-1","purpose":"PRIVATE INSTRUCTION"}'
  ].join("\n");
  database.prepare(`
    INSERT INTO threads (id, title, cwd, created_at_ms, updated_at_ms, archived, thread_source, preview, first_user_message)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "thread-agentbridge-executor",
    instruction,
    "\\\\?\\D:\\AgentBridge\\evidence\\disposable-runtimes\\synthetic-run\\workspace",
    100,
    200,
    0,
    "user",
    "PRIVATE PREVIEW",
    "PRIVATE USER MESSAGE"
  );
  database.close();

  const [result] = searchLocalCodexThreads(codexDir, "AgentBridge temporary executor task");

  assert.equal(result.id, "thread-agentbridge-executor");
  assert.equal(result.title, "AgentBridge temporary executor task");
  assert.equal(result.category, "temporary_executor");
  assert.equal(result.workspacePath, "D:\\AgentBridge\\evidence\\disposable-runtimes\\synthetic-run\\workspace");
  assert.equal(JSON.stringify(result).includes("PRIVATE"), false);
  assert.equal(JSON.stringify(result).includes("workflow worker"), false);
});

test("returns pinned order, subagent hierarchy, and privacy-safe lifecycle states", () => {
  const { codexDir } = fixture();
  const database = createThreadDatabase(codexDir);
  const insert = database.prepare(`
    INSERT INTO threads (
      id, title, cwd, created_at_ms, updated_at_ms, archived, thread_source,
      source, agent_path, rollout_path, preview, first_user_message
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const mainRollout = path.join(codexDir, "rollout-main.jsonl");
  const interruptedRollout = path.join(codexDir, "rollout-interrupted.jsonl");
  const limitedRollout = path.join(codexDir, "rollout-limited.jsonl");
  insert.run(
    "thread-main", "相同标题", "D:\\Project", 100, 500, 0, "user",
    "vscode", null, mainRollout, "PRIVATE", "PRIVATE"
  );
  insert.run(
    "thread-child-interrupted", "相同标题", "D:\\Project", 200, 400, 0, "subagent",
    JSON.stringify({ subagent: { thread_spawn: { parent_thread_id: "thread-main" } } }),
    "/root/review", interruptedRollout, "PRIVATE", "PRIVATE"
  );
  insert.run(
    "thread-child-limited", "相同标题", "D:\\Project", 300, 300, 0, "subagent",
    JSON.stringify({ subagent: { thread_spawn: { parent_thread_id: "thread-main" } } }),
    "/root/quota", limitedRollout, "PRIVATE", "PRIVATE"
  );
  database.close();
  fs.writeFileSync(mainRollout, [
    JSON.stringify({ type: "event_msg", payload: { type: "task_started" } }),
    JSON.stringify({ type: "event_msg", payload: { type: "task_complete" } })
  ].join("\n") + "\n");
  fs.writeFileSync(interruptedRollout,
    `${JSON.stringify({ type: "event_msg", payload: { type: "turn_aborted", reason: "interrupted" } })}\n`
  );
  fs.writeFileSync(limitedRollout,
    `${JSON.stringify({
      type: "event_msg",
      payload: {
        type: "task_complete",
        error: { codex_error_info: "usage_limit_exceeded", message: "PRIVATE LIMIT MESSAGE" }
      }
    })}\n`
  );
  fs.writeFileSync(path.join(codexDir, ".codex-global-state.json"), JSON.stringify({
    "pinned-thread-ids": ["thread-child-interrupted", "thread-main"],
    "electron-persisted-atom-state": {
      "unified-sidebar-pinned-order-v1": [
        "codex:thread:local:thread-main",
        "codex:project:project-one"
      ]
    }
  }));

  const results = searchLocalCodexThreads(codexDir);
  const main = results.find(({ id }) => id === "thread-main");
  const interrupted = results.find(({ id }) => id === "thread-child-interrupted");
  const limited = results.find(({ id }) => id === "thread-child-limited");

  assert.equal(main.pinnedIndex, 1);
  assert.equal(main.turnState, "completed");
  assert.equal(interrupted.pinnedIndex, undefined);
  assert.equal(interrupted.threadSource, "subagent");
  assert.equal(interrupted.parentThreadId, "thread-main");
  assert.equal(interrupted.agentPath, "/root/review");
  assert.equal(interrupted.turnState, "interrupted");
  assert.equal(limited.parentThreadId, "thread-main");
  assert.equal(limited.turnState, "usage_limited");
  assert.equal(JSON.stringify(results).includes("PRIVATE"), false);
  assert.equal(JSON.stringify(results).includes("rollout-"), false);
});

test("selects one recent non-archived root quota-interrupted thread with a privacy-safe timestamp", () => {
  const { codexDir } = fixture();
  const database = createThreadDatabase(codexDir);
  const insert = database.prepare(`
    INSERT INTO threads (
      id, title, cwd, created_at_ms, updated_at_ms, archived, thread_source,
      source, agent_path, rollout_path, preview, first_user_message
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const candidateRollout = path.join(codexDir, "rollout-candidate.jsonl");
  const childRollout = path.join(codexDir, "rollout-child.jsonl");
  const staleRollout = path.join(codexDir, "rollout-stale.jsonl");
  const archivedRollout = path.join(codexDir, "rollout-archived.jsonl");
  const quotaError = JSON.stringify({
    type: "event_msg",
    payload: { type: "task_complete", error: { codex_error_info: "usage_limit_exceeded", message: "PRIVATE" } }
  }) + "\n";
  insert.run("thread-root-limited", "PRIVATE TITLE", "D:\\Private", 8_000, 9_500, 0, "user", "vscode", null, candidateRollout, "PRIVATE", "PRIVATE");
  insert.run(
    "thread-child-limited", "PRIVATE CHILD", "D:\\Private", 8_000, 9_600, 0, "subagent",
    JSON.stringify({ subagent: { thread_spawn: { parent_thread_id: "thread-root-limited" } } }),
    "/private/agent", childRollout, "PRIVATE", "PRIVATE"
  );
  insert.run("thread-stale-limited", "PRIVATE STALE", "D:\\Private", 1_000, 1_000, 0, "user", "vscode", null, staleRollout, "PRIVATE", "PRIVATE");
  insert.run("thread-archived-limited", "PRIVATE ARCHIVED", "D:\\Private", 8_000, 9_700, 1, "user", "vscode", null, archivedRollout, "PRIVATE", "PRIVATE");
  database.close();
  for (const rollout of [candidateRollout, childRollout, staleRollout, archivedRollout]) fs.writeFileSync(rollout, quotaError, "utf8");

  assert.deepEqual(selectQuotaInterruptedThread(codexDir, { nowMs: 10_000, lookbackMs: 2_000 }), {
    status: "selected",
    candidateCount: 1,
    candidate: { threadId: "thread-root-limited", interruptedAtMs: 9_500 }
  });
});

test("does not select stale, archived, subagent, or ambiguous quota-interrupted threads", () => {
  const { codexDir } = fixture();
  const database = createThreadDatabase(codexDir);
  const insert = database.prepare(`
    INSERT INTO threads (
      id, title, cwd, created_at_ms, updated_at_ms, archived, thread_source,
      source, agent_path, rollout_path, preview, first_user_message
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const rollouts = new Set();
  const add = (id, updatedAtMs, archived, threadSource, rawSource) => {
    const rollout = path.join(codexDir, `rollout-${id}.jsonl`);
    rollouts.add(rollout);
    insert.run(id, "PRIVATE", "D:\\Private", 1_000, updatedAtMs, archived, threadSource, rawSource, null, rollout, "PRIVATE", "PRIVATE");
  };
  add("thread-stale", 1_000, 0, "user", "vscode");
  add("thread-archived", 9_700, 1, "user", "vscode");
  add("thread-child", 9_800, 0, "subagent", JSON.stringify({ subagent: { thread_spawn: { parent_thread_id: "thread-root" } } }));
  add("thread-completed", 9_850, 0, "user", "vscode");
  add("thread-interrupted", 9_860, 0, "user", "vscode");
  add("thread-other-failure", 9_870, 0, "user", "vscode");
  database.close();
  const quotaError = JSON.stringify({
    type: "event_msg",
    payload: { type: "task_complete", error: { codex_error_info: "usage_limit_exceeded" } }
  }) + "\n";
  for (const rollout of rollouts.keys()) fs.writeFileSync(rollout, quotaError, "utf8");
  fs.writeFileSync(path.join(codexDir, "rollout-thread-completed.jsonl"), JSON.stringify({
    type: "event_msg", payload: { type: "task_complete" }
  }) + "\n", "utf8");
  fs.writeFileSync(path.join(codexDir, "rollout-thread-interrupted.jsonl"), JSON.stringify({
    type: "event_msg", payload: { type: "turn_aborted", reason: "interrupted" }
  }) + "\n", "utf8");
  fs.writeFileSync(path.join(codexDir, "rollout-thread-other-failure.jsonl"), JSON.stringify({
    type: "event_msg", payload: { type: "task_complete", error: { codex_error_info: "other_error" } }
  }) + "\n", "utf8");
  assert.deepEqual(selectQuotaInterruptedThread(codexDir, { nowMs: 10_000, lookbackMs: 2_000 }), { status: "none", candidateCount: 0 });

  const ambiguous = fixture();
  const ambiguousDatabase = createThreadDatabase(ambiguous.codexDir);
  const ambiguousInsert = ambiguousDatabase.prepare(`
    INSERT INTO threads (id, title, cwd, created_at_ms, updated_at_ms, archived, thread_source, rollout_path)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const id of ["thread-a", "thread-b"]) {
    const rollout = path.join(ambiguous.codexDir, `rollout-${id}.jsonl`);
    ambiguousInsert.run(id, "PRIVATE", "D:\\Private", 9_000, 9_500, 0, "user", rollout);
    fs.writeFileSync(rollout, quotaError, "utf8");
  }
  ambiguousDatabase.close();
  assert.deepEqual(selectQuotaInterruptedThread(ambiguous.codexDir, { nowMs: 10_000, lookbackMs: 2_000 }), { status: "ambiguous", candidateCount: 2 });
});

test("keeps every recent quota interruption when one active root is preferred", () => {
  const { codexDir } = fixture();
  const database = createThreadDatabase(codexDir);
  const insert = database.prepare(`
    INSERT INTO threads (id, title, cwd, created_at_ms, updated_at_ms, archived, thread_source, rollout_path)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const quotaError = JSON.stringify({
    type: "event_msg",
    payload: { type: "task_complete", error: { codex_error_info: "usage_limit_exceeded" } }
  }) + "\n";
  for (const [id, updatedAtMs] of [["thread-limited-newer", 9_800], ["thread-limited-older", 9_500]]) {
    const rollout = path.join(codexDir, `rollout-${id}.jsonl`);
    insert.run(id, "PRIVATE", "D:\\Private", 8_000, updatedAtMs, 0, "user", rollout);
    fs.writeFileSync(rollout, quotaError, "utf8");
  }
  insert.run("thread-active", "PRIVATE", "D:\\Private", 8_000, 9_900, 0, "user", null);
  database.close();

  assert.deepEqual(selectQuotaInterruptedThread(codexDir, {
    nowMs: 10_000,
    lookbackMs: 2_000,
    preferredThreadIds: ["thread-active"],
    allowSwitchInterruptedActiveThread: true,
    selectAllCandidates: true
  }), {
    status: "selected",
    candidateCount: 3,
    candidates: [
      { threadId: "thread-active", interruptedAtMs: 10_000, reason: "switch_interrupted_active_thread" },
      { threadId: "thread-limited-newer", interruptedAtMs: 9_800 },
      { threadId: "thread-limited-older", interruptedAtMs: 9_500 }
    ]
  });
});

test("limits quota interruption discovery to the current account cycle", () => {
  const { codexDir } = fixture();
  const database = createThreadDatabase(codexDir);
  const insert = database.prepare(`
    INSERT INTO threads (id, title, cwd, created_at_ms, updated_at_ms, archived, thread_source, rollout_path)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const quotaError = JSON.stringify({
    type: "event_msg",
    payload: { type: "task_complete", error: { codex_error_info: "usage_limit_exceeded" } }
  }) + "\n";
  for (const [id, updatedAtMs] of [["thread-prior-cycle", 9_000], ["thread-current-cycle", 20_000]]) {
    const rollout = path.join(codexDir, `rollout-${id}.jsonl`);
    insert.run(id, "PRIVATE", "D:\\Private", 1_000, updatedAtMs, 0, "user", rollout);
    fs.writeFileSync(rollout, quotaError, "utf8");
  }
  database.close();

  assert.deepEqual(selectQuotaInterruptedThread(codexDir, {
    nowMs: 100_000,
    lookbackMs: 100_000,
    minInterruptedAtMs: 10_000,
    selectAllCandidates: true
  }), {
    status: "selected",
    candidateCount: 1,
    candidate: { threadId: "thread-current-cycle", interruptedAtMs: 20_000 }
  });
});

test("uses unified pin membership and order with legacy fallback only when unified state is absent", () => {
  const { codexDir } = fixture();
  const database = createThreadDatabase(codexDir);
  const insert = database.prepare(`
    INSERT INTO threads (
      id, title, cwd, created_at_ms, updated_at_ms, archived, thread_source,
      source, agent_path, rollout_path, preview, first_user_message
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const [id, title] of [
    ["thread-resolved", "Resolved temporary pin"],
    ["thread-legacy", "Legacy-only pin"],
    ["thread-unified", "Unified-only stale pin"]
  ]) insert.run(id, title, "D:\\Project", 100, 200, 0, "user", "vscode", null, null, "PRIVATE", "PRIVATE");
  database.close();
  const statePath = path.join(codexDir, ".codex-global-state.json");
  fs.writeFileSync(statePath, JSON.stringify({
    "pinned-thread-ids": ["thread-resolved", "thread-legacy"],
    "electron-persisted-atom-state": {
      "thread-client-id-v1:local%3Athread-resolved": "client-new-thread:temporary",
      "unified-sidebar-pinned-order-v1": [
        "codex:thread:local:client-new-thread:temporary",
        "codex:thread:local:thread-unified"
      ]
    }
  }));

  let results = searchLocalCodexThreads(codexDir);
  assert.equal(results.find(({ id }) => id === "thread-resolved").pinnedIndex, 1);
  assert.equal(results.find(({ id }) => id === "thread-legacy").pinnedIndex, undefined);
  assert.equal(results.find(({ id }) => id === "thread-unified").pinnedIndex, 2);

  fs.writeFileSync(statePath, JSON.stringify({
    "electron-persisted-atom-state": {
      "thread-client-id-v1:local%3Athread-resolved": "client-new-thread:temporary",
      "unified-sidebar-pinned-order-v1": ["codex:thread:local:client-new-thread:temporary"]
    }
  }));
  results = searchLocalCodexThreads(codexDir);
  assert.equal(results.find(({ id }) => id === "thread-resolved").pinnedIndex, 1);

  fs.writeFileSync(statePath, JSON.stringify({
    "pinned-thread-ids": ["thread-legacy"],
    "electron-persisted-atom-state": {
      "unified-sidebar-pinned-order-v1": []
    }
  }));
  assert.equal(searchLocalCodexThreads(codexDir).some(({ pinnedIndex }) => Number.isFinite(pinnedIndex)), false);

  fs.writeFileSync(statePath, JSON.stringify({ "pinned-thread-ids": ["thread-legacy"] }));
  results = searchLocalCodexThreads(codexDir);
  assert.equal(results.find(({ id }) => id === "thread-legacy").pinnedIndex, 1);
});

test("returns project and thread pins in Codex unified sidebar order", () => {
  const { codexDir } = fixture();
  const database = createThreadDatabase(codexDir);
  database.prepare(`
    INSERT INTO threads (id, title, cwd, created_at_ms, updated_at_ms, archived)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run("thread-a", "Pinned thread", "D:\\Project", 100, 200, 1);
  database.close();
  fs.writeFileSync(path.join(codexDir, ".codex-global-state.json"), JSON.stringify({
    "local-projects": {
      "project-storage-key": { id: "project-a", name: "Pinned project", rootPaths: ["D:\\Project"], createdAt: 10, updatedAt: 20 }
    },
    "electron-persisted-atom-state": {
      "unified-sidebar-pinned-order-v1": [
        "codex:project:project-a",
        "codex:thread:local:thread-a"
      ]
    }
  }));

  const results = searchLocalCodexThreads(codexDir);
  const project = results.find(({ entityType }) => entityType === "project");
  const thread = results.find(({ id }) => id === "thread-a");
  assert.equal(project.projectName, "Pinned project");
  assert.equal(project.projectId, "project-a");
  assert.deepEqual(project.rootPaths, ["D:\\Project"]);
  assert.equal(project.pinnedIndex, 1);
  assert.equal(thread.pinnedIndex, 2);
  assert.equal(thread.projectId, "project-a");
  assert.equal(thread.archived, true);
});

test("thread integrity snapshot hashes only semantic sidebar metadata", () => {
  const { codexDir } = fixture();
  const activeDir = path.join(codexDir, "sessions");
  const archivedDir = path.join(codexDir, "archived_sessions");
  fs.mkdirSync(activeDir, { recursive: true });
  fs.mkdirSync(archivedDir, { recursive: true });
  const activeRollout = path.join(activeDir, "active.jsonl");
  const archivedRollout = path.join(archivedDir, "archived.jsonl");
  fs.writeFileSync(activeRollout, "PRIVATE ACTIVE CONTENT\n");
  fs.writeFileSync(archivedRollout, "PRIVATE ARCHIVED CONTENT\n");
  const database = createThreadDatabase(codexDir);
  database.prepare(`INSERT INTO threads
    (id, title, rollout_path, archived, archived_at, updated_at_ms)
    VALUES (?, ?, ?, ?, ?, ?)`)
    .run("thread-active", "PRIVATE ACTIVE TITLE", activeRollout, 0, null, 10);
  database.prepare(`INSERT INTO threads
    (id, title, rollout_path, archived, archived_at, updated_at_ms)
    VALUES (?, ?, ?, ?, ?, ?)`)
    .run("thread-archived", "PRIVATE ARCHIVED TITLE", archivedRollout, 1, 20, 20);
  database.close();
  const statePath = path.join(codexDir, ".codex-global-state.json");
  fs.writeFileSync(statePath, JSON.stringify({
    "pinned-thread-ids": ["thread-archived"],
    "thread-project-assignments": { "thread-active": { projectId: "project-private", cwd: "D:\\PRIVATE" } },
    "electron-persisted-atom-state": {
      "unified-sidebar-pinned-order-v1": ["codex:thread:local:thread-active"],
      "unread-thread-ids-by-host-v1": { local: ["thread-archived"] }
    }
  }));

  const first = codexThreadIntegritySnapshot(codexDir);
  const writable = new DatabaseSync(path.join(codexDir, "state_5.sqlite"));
  writable.prepare("UPDATE threads SET title = ? WHERE id = ?").run("CHANGED PRIVATE TITLE", "thread-active");
  writable.close();
  const titleOnly = codexThreadIntegritySnapshot(codexDir);
  assert.deepEqual(titleOnly, first);

  const changed = new DatabaseSync(path.join(codexDir, "state_5.sqlite"));
  changed.prepare("UPDATE threads SET archived = 1, archived_at = 30 WHERE id = ?").run("thread-active");
  changed.close();
  const archiveChanged = codexThreadIntegritySnapshot(codexDir);
  assert.notEqual(archiveChanged.revision, first.revision);
  assert.notEqual(archiveChanged.componentRevisions.threadMetadata, first.componentRevisions.threadMetadata);
  assert.equal(archiveChanged.componentRevisions.rolloutMembership, first.componentRevisions.rolloutMembership);
  assert.equal(first.threadCount, 2);
  assert.equal(first.activeCount, 1);
  assert.equal(first.archivedCount, 1);
  assert.equal(JSON.stringify(first).includes("thread-"), false);
  assert.equal(JSON.stringify(first).includes("PRIVATE"), false);
});

test("keeps a thread visible with unknown state when its rollout is malformed", () => {
  const { codexDir } = fixture();
  const database = createThreadDatabase(codexDir);
  const rolloutPath = path.join(codexDir, "rollout-malformed.jsonl");
  database.prepare(`
    INSERT INTO threads (
      id, title, cwd, created_at_ms, updated_at_ms, archived, thread_source,
      source, agent_path, rollout_path, preview, first_user_message
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "thread-malformed", "Malformed", "D:\\Project", 100, 200, 0, "user",
    "vscode", null, rolloutPath, "PRIVATE", "PRIVATE"
  );
  database.close();
  fs.writeFileSync(rolloutPath, "{partial");

  const [result] = searchLocalCodexThreads(codexDir);

  assert.equal(result.id, "thread-malformed");
  assert.equal(result.turnState, undefined);
});

test("falls back to rollout parent metadata, classifies exec sources, and projects unread IDs", () => {
  const { codexDir } = fixture();
  const database = createThreadDatabase(codexDir);
  const insert = database.prepare(`
    INSERT INTO threads (
      id, title, cwd, created_at_ms, updated_at_ms, archived, thread_source,
      source, agent_path, rollout_path, preview, first_user_message
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const guardianRollout = path.join(codexDir, "rollout-guardian.jsonl");
  const execRollout = path.join(codexDir, "rollout-exec.jsonl");
  insert.run(
    "thread-main", "Main", "D:\\Project", 100, 300, 0, "user",
    "vscode", null, null, "PRIVATE", "PRIVATE"
  );
  insert.run(
    "thread-guardian", "Inherited private task title", "D:\\Project", 100, 200, 0, "subagent",
    JSON.stringify({ subagent: { other: "guardian" } }), "/root/guardian",
    guardianRollout, "PRIVATE", "PRIVATE"
  );
  insert.run(
    "thread-exec", "Private executor instructions", "D:\\Tests\\safe-workspace", 100, 100, 0, "user",
    "exec", null, execRollout, "PRIVATE", "PRIVATE"
  );
  database.close();
  fs.writeFileSync(guardianRollout, [
    JSON.stringify({
      type: "session_meta",
      payload: { id: "thread-guardian", parent_thread_id: "thread-main" }
    }),
    JSON.stringify({ type: "event_msg", payload: { type: "task_complete" } })
  ].join("\n") + "\n");
  fs.writeFileSync(execRollout,
    `${JSON.stringify({ type: "event_msg", payload: { type: "task_complete" } })}\n`
  );
  fs.writeFileSync(path.join(codexDir, ".codex-global-state.json"), JSON.stringify({
    "electron-persisted-atom-state": {
      "unread-thread-ids-by-host-v1": {
        local: ["thread-main"]
      }
    }
  }));

  const results = searchLocalCodexThreads(codexDir);
  const main = results.find(({ id }) => id === "thread-main");
  const guardian = results.find(({ id }) => id === "thread-guardian");
  const executor = results.find(({ id }) => id === "thread-exec");

  assert.equal(main.unread, true);
  assert.equal(guardian.parentThreadId, "thread-main");
  assert.equal(guardian.turnState, "completed");
  assert.equal(executor.category, "temporary_executor");
  assert.equal(executor.title, "AgentBridge temporary executor task");
  assert.equal(JSON.stringify(results).includes("Private executor instructions"), false);
  assert.equal(JSON.stringify(results).includes('"exec"'), false);
});
