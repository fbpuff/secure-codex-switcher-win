import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { markIntentionalSwitcherExit } from "../src/core/switcher-watchdog.js";

const main = fs.readFileSync(new URL("../src/main.js", import.meta.url), "utf8");
const watcher = fs.readFileSync(new URL("../scripts/Watch-SwitcherProcess.ps1", import.meta.url), "utf8");

test("main process starts an external packaged watchdog and marks every intentional quit", () => {
  assert.match(main, /startSwitcherWatchdog\(\{[\s\S]*packaged:\s*app\.isPackaged/);
  assert.match(main, /function requestAppQuit[\s\S]*markIntentionalSwitcherExit\(watchdog\)[\s\S]*app\.quit\(\)/);
  assert.match(main, /before-quit[\s\S]*markIntentionalSwitcherExit\(watchdog\)/);
});

test("watchdog bootstrap uses WMI so it survives the Electron process job", () => {
  const source = fs.readFileSync(new URL("../src/core/switcher-watchdog.js", import.meta.url), "utf8");
  assert.match(source, /\(\[wmiclass\]"Win32_ProcessStartup"\)\.CreateInstance\(\)/);
  assert.match(source, /\$startup\.ShowWindow = 0/);
  assert.match(source, /\(\[wmiclass\]"Win32_Process"\)\.Create\(\$watchdogCommandLine, \$null, \$startup\)/);
  assert.doesNotMatch(source, /Invoke-CimMethod|New-CimInstance/);
  assert.doesNotMatch(source, /Start-Process -FilePath/);
  assert.match(source, /utf16le/);
  assert.match(source, /-EncodedCommand/);
});

test("watchdog relaunches only after an unintentional parent exit", () => {
  assert.match(watcher, /\$watchedParent = Get-Process -Id \$ParentProcessId/);
  assert.match(watcher, /\$intentional[\s\S]*exit 0/);
  assert.match(watcher, /Get-CimInstance Win32_Process[\s\S]*\$alreadyRunning[\s\S]*exit 0/);
  assert.match(watcher, /AddMinutes\(-5\)[\s\S]*recovery_launched[\s\S]*recentRecoveryCount[\s\S]*recovery_backoff/);
  assert.match(watcher, /Start-Process -FilePath \$resolvedExecutable/);
  assert.doesNotMatch(watcher, /Stop-Process|taskkill|auth\.json/);
});

test("watchdog tracks the original process and does not let orphan renderers block recovery", () => {
  assert.match(watcher, /\$watchedParent\.Handle/);
  assert.match(watcher, /\$watchedParent\.HasExited/);
  assert.match(watcher, /\$record\.exitCode/);
  assert.match(watcher, /\$watchedParent\.ExitCode/);
  assert.match(watcher, /\$_\.CommandLine -notmatch/);
  assert.match(watcher, /--type=/);
  assert.match(watcher, /-PassThru -ErrorAction Stop/);
  assert.match(watcher, /recovery_failed/);
});

test("intentional exit marker contains only an opaque nonce and timestamp", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "switcher-watchdog-"));
  const markerPath = path.join(root, "intent.json");
  try {
    assert.equal(markIntentionalSwitcherExit({ nonce: "opaque-nonce", markerPath }), true);
    assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(markerPath, "utf8"))), ["nonce", "createdAtMs"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
