import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const projectRoot = path.resolve(import.meta.dirname, "..");
const recoveryScript = path.join(projectRoot, "scripts", "repair-chatgpt-codex-plugins.ps1");

test("repairs only the known ChatGPT Codex plugin compatibility artifacts", () => {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "chatgpt-codex-plugin-recovery-"));
  try {
    const ngsManifestPath = path.join(codexHome, ".tmp", "plugins", "plugins", "ngs-analysis", ".codex-plugin", "plugin.json");
    const sitesServerPath = path.join(codexHome, "plugins", "cache", "openai-bundled", "sites", "0.1.27", "mcp", "server.mjs");
    fs.mkdirSync(path.dirname(ngsManifestPath), { recursive: true });
    fs.mkdirSync(path.dirname(sitesServerPath), { recursive: true });
    fs.writeFileSync(ngsManifestPath, JSON.stringify({ interface: { defaultPrompt: ["x".repeat(129)] } }));
    fs.writeFileSync(sitesServerPath, 'async function handleRequest(message) {\n  if (method === "ping") { sendResult(id, {}); return; }\n}\n');

    const result = spawnSync("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      recoveryScript,
      "-CodexHome",
      codexHome
    ], { encoding: "utf8" });

    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.ngs.status, "repaired");
    assert.equal(report.sites.status, "repaired");
    assert.ok(fs.existsSync(report.ngs.backupPath));
    assert.ok(fs.existsSync(report.sites.backupPath));
    assert.ok(JSON.parse(fs.readFileSync(ngsManifestPath, "utf8")).interface.defaultPrompt[0].length <= 128);
    assert.match(fs.readFileSync(sitesServerPath, "utf8"), /method === "resources\/list"/);
  } finally {
    fs.rmSync(codexHome, { recursive: true, force: true });
  }
});
