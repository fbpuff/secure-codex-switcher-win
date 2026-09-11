import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const main = fs.readFileSync(new URL("../src/main.js", import.meta.url), "utf8");
const preload = fs.readFileSync(new URL("../src/preload.cjs", import.meta.url), "utf8");

test("main exposes only an explicit path-free conversation backup IPC action", () => {
  assert.match(main, /"backup:conversations": async \(event, operationId\) =>/);
  assert.match(main, /await accountService\.runConversationBackup\("explicit", \{/);
  assert.match(main, /event\.sender\.send\("backup:conversationProgress", \{ operationId, progress \}\)/);
  assert.doesNotMatch(main, /"backup:conversations"[^\n]*(path|directory|root)/i);
  assert.match(main, /counts:\s*\{\s*active:/);
  assert.doesNotMatch(main, /"backup:conversations"[\s\S]*?return\s+result\s*;/);
  assert.match(main, /throw new Error\("Conversation backup failed\. Please retry\."\)/);
  assert.match(preload, /onConversationBackupProgress/);
  assert.match(preload, /ipcRenderer\.on\("backup:conversationProgress", handler\)/);
  assert.match(preload, /ipcRenderer\.removeListener\("backup:conversationProgress", handler\)/);
  assert.match(preload, /envelope\?\.operationId === conversationBackupOperationId/);
  assert.doesNotMatch(preload, /on:\s*\(channel|receive:\s*\(channel/);
});

test("main checks daily idle backup eligibility at a low frequency", () => {
  assert.match(main, /runConversationBackup\("daily-idle"\)/);
  assert.match(main, /setInterval\(check, 60 \* 60 \* 1000\)/);
  assert.doesNotMatch(main, /function startConversationBackupMaintenance\(\) \{[\s\S]*?\n\s*check\(\);/);
});

test("production conversation backup work is delegated away from the Electron main thread", () => {
  const service = fs.readFileSync(new URL("../src/services/account-service.js", import.meta.url), "utf8");
  assert.match(service, /createConversationBackupInWorker/);
  assert.match(service, /this\.createConversationBackup\s*=\s*options\.createConversationBackup\s*\?\?\s*createConversationBackupInWorker/);
});

test("app shutdown terminates outstanding background workers", () => {
  const main = fs.readFileSync(new URL("../src/main.js", import.meta.url), "utf8");
  assert.match(main, /import \{ stopBackgroundJobs \} from "\.\/core\/background-jobs\.js"/);
  assert.match(main, /app\.on\("before-quit",[\s\S]*?stopBackgroundJobs\(\)/);
});

test("main exposes recovery summaries and preview through IDs without accepting paths", () => {
  assert.match(main, /"backup:listCodexRecovery": async \(event, full, operationId\) => \{[\s\S]*?assertRecoveryValidationMode\(full\)[\s\S]*?accountService\.listCodexRecoveryBackups\(\{\s*full,/);
  assert.match(preload, /listCodexRecoveryBackups:\s*\(\{\s*full\s*=\s*true\s*\}\s*=\s*\{\}\)\s*=>\s*invoke\("backup:listCodexRecovery",\s*full,\s*\+\+recoveryOperationId\)/);
  assert.match(main, /"backup:previewCodexRecovery": async \(event, selection, operationId\) => \{[\s\S]*?accountService\.previewCodexRecoveryById/);
  assert.match(main, /event\.sender\.send\("backup:recoveryProgress", \{ operationId, progress \}\)/);
  assert.doesNotMatch(main, /"backup:previewCodexRecovery"[^\n]*(criticalPath|manifestPath|generationDir|backupRoot)/i);
  assert.match(main, /assertRecoveryOperationId\(operationId\)/);
  assert.match(main, /Invalid recovery progress request/);
  assert.match(main, /backup:listCodexRecovery[\s\S]*?try[\s\S]*?throw new Error\("Recovery list failed\. Please retry\."\)/);
  assert.match(main, /backup:previewCodexRecovery[\s\S]*?try[\s\S]*?throw new Error\("Recovery preview failed\. Please retry\."\)/);
  assert.doesNotMatch(main, /Recovery (?:list|preview) failed[\s\S]*?D:\\\\private/);
});

test("main exposes quarantined conversation revalidation through only an opaque ID", () => {
  assert.match(main, /"backup:revalidateQuarantinedConversation": async \(event, conversationId, operationId\) => \{[\s\S]*?accountService\.revalidateQuarantinedConversationBackup/);
  assert.match(main, /"backup:revalidateQuarantinedConversation"[\s\S]*?assertRecoveryOperationId\(operationId\)/);
  assert.match(preload, /revalidateQuarantinedConversation:\s*\(conversationId\)\s*=>\s*invoke\("backup:revalidateQuarantinedConversation",\s*conversationId,\s*\+\+recoveryOperationId\)/);
  assert.doesNotMatch(main, /"backup:revalidateQuarantinedConversation"[^\n]*(?:path|directory|root)/i);
});

test("main exposes two-stage replacement through IDs and an opaque token only", () => {
  assert.match(main, /"backup:prepareCodexReplacement": \(_event, selection\) => accountService\.prepareCodexReplacement\(selection\)/);
  assert.match(main, /"backup:confirmCodexReplacement": \(_event, request\) => accountService\.confirmCodexReplacement\(request\)/);
  assert.doesNotMatch(main, /"backup:(?:prepare|confirm)CodexReplacement"[^\n]*(?:path|directory|root)/i);
  assert.match(preload, /prepareCodexReplacement: \(selection\) => invoke\("backup:prepareCodexReplacement", selection\)/);
  assert.match(preload, /confirmCodexReplacement: \(request\) => invoke\("backup:confirmCodexReplacement", request\)/);
});
