import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("canonicalizes a unique legacy project and registers its environment root", { skip: process.platform !== "win32" }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-project-repair-"));
  const projectRoot = path.join(root, "legacy-project");
  const statePath = path.join(root, ".codex-global-state.json");
  const resultPath = path.join(root, "result.json");
  const legacyId = "00000000-0000-4000-8000-000000000002";
  const canonicalId = `local-${crypto.createHash("sha256").update(projectRoot).digest("hex").slice(0, 32)}`;
  fs.mkdirSync(projectRoot);
  fs.writeFileSync(statePath, JSON.stringify({
    "local-projects": {
      [legacyId]: { id: legacyId, name: "Legacy project", rootPaths: [projectRoot], createdAt: 1, updatedAt: 1 }
    },
    "project-writable-roots": {},
    "thread-project-assignments": {
      thread: { projectKind: "local", projectId: legacyId, cwd: projectRoot, pendingCoreUpdate: false }
    },
    "project-order": [legacyId],
    "pinned-project-ids": [legacyId],
    "active-workspace-roots": [],
    "selected-project": { type: "local", projectId: legacyId },
    "sidebar-project-thread-orders": { [legacyId]: { threadIds: ["thread"] } },
    "electron-saved-workspace-roots": []
  }), "utf8");

  try {
    const script = path.resolve("scripts/repair-codex-project-id-migration_202607201015.ps1");
    const result = spawnSync("pwsh.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, "-StatePath", statePath, "-ResultPath", resultPath, "-Execute"], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const repaired = JSON.parse(fs.readFileSync(statePath, "utf8"));
    assert.deepEqual(Object.keys(repaired["local-projects"]), [canonicalId]);
    assert.equal(repaired["thread-project-assignments"].thread.projectId, canonicalId);
    assert.deepEqual(repaired["project-writable-roots"][canonicalId], [{ kind: "local", path: projectRoot }]);
    assert.deepEqual(repaired["electron-saved-workspace-roots"], [projectRoot]);
    assert.equal(repaired["selected-project"].projectId, canonicalId);
    const summary = JSON.parse(fs.readFileSync(resultPath, "utf8")).summary;
    assert.equal(summary.addedWritableRoots, 1);
    assert.equal(summary.removedEmptyWritableRoots, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
