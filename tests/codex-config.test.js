import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  HTTP_ONLY_PROVIDER_ID,
  ensureCodexHttpOnlyMode,
  readCodexBaseProvider,
  readCodexHttpOnlyStatus,
  setCodexHttpOnlyMode
} from "../src/core/codex-config.js";

function createConfig(content = "") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "secure-codex-config-"));
  const configPath = path.join(root, ".codex", "config.toml");
  if (content) {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, content, "utf8");
  }
  return configPath;
}

test("enables HTTP-only mode without disturbing existing Codex settings", () => {
  const original = [
    'model = "gpt-5.4"',
    'approval_policy = "on-request"',
    "",
    "[mcp_servers.example]",
    'command = "example"',
    ""
  ].join("\n");
  const configPath = createConfig(original);

  const status = setCodexHttpOnlyMode(configPath, true);
  const configured = fs.readFileSync(configPath, "utf8");

  assert.equal(status.enabled, true);
  assert.equal(readCodexBaseProvider(configPath), "openai");
  assert.match(configured, new RegExp(`model_provider = "${HTTP_ONLY_PROVIDER_ID}"`));
  assert.match(configured, new RegExp(`\\[model_providers\\.${HTTP_ONLY_PROVIDER_ID}\\]`));
  assert.match(configured, /supports_websockets = false/);
  assert.match(configured, /model = "gpt-5.4"/);
  assert.match(configured, /\[mcp_servers\.example\]/);
  assert.equal((configured.match(/supports_websockets = false/g) ?? []).length, 1);
});

test("restores an existing model_provider when HTTP-only mode is disabled", () => {
  const original = [
    'model_provider = "company_proxy" # keep this comment',
    'model = "gpt-5.4"',
    "",
    "[model_providers.company_proxy]",
    'base_url = "https://example.invalid/v1"',
    'wire_api = "responses"',
    ""
  ].join("\r\n");
  const configPath = createConfig(original);

  setCodexHttpOnlyMode(configPath, true);
  assert.equal(readCodexBaseProvider(configPath), "company_proxy");
  const enabledAgain = ensureCodexHttpOnlyMode(configPath);
  assert.equal(enabledAgain.enabled, true);
  assert.equal((fs.readFileSync(configPath, "utf8").match(/supports_websockets = false/g) ?? []).length, 1);

  const disabled = setCodexHttpOnlyMode(configPath, false);
  const restored = fs.readFileSync(configPath, "utf8");

  assert.equal(disabled.enabled, false);
  assert.match(restored, /^model_provider = "company_proxy" # keep this comment$/m);
  assert.match(restored, /\[model_providers\.company_proxy\]/);
  assert.doesNotMatch(restored, /secure-codex-switcher/);
  assert.doesNotMatch(restored, new RegExp(HTTP_ONLY_PROVIDER_ID));
});

test("removes an inserted model_provider cleanly when disabled", () => {
  const configPath = createConfig('[features]\nweb_search = true\n');

  setCodexHttpOnlyMode(configPath, true);
  setCodexHttpOnlyMode(configPath, false);

  const restored = fs.readFileSync(configPath, "utf8");
  assert.equal(readCodexHttpOnlyStatus(configPath).enabled, false);
  assert.match(restored, /^\[features\]$/m);
  assert.match(restored, /^web_search = true$/m);
  assert.doesNotMatch(restored, /model_provider/);
});

test("rejects a conflicting provider id outside the managed block", () => {
  const configPath = createConfig(
    `[model_providers.${HTTP_ONLY_PROVIDER_ID}]\nbase_url = "https://example.invalid"\n`
  );

  assert.throws(() => setCodexHttpOnlyMode(configPath, true), /already defines model provider/);
});
