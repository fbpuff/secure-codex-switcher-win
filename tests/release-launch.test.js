import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const launcher = fs.readFileSync(new URL("../Start-CodexSwitcher.ps1", import.meta.url), "utf8");

test("normal launcher resolves the installed executable", () => {
  assert.match(launcher, /D:\\Secure Codex Switcher Workspace\\Program/);
  assert.match(launcher, /\$userDataPath\s*=\s*"D:\\Secure Codex Switcher Workspace\\Data"/);
  assert.match(launcher, /--user-data-dir=.*\$userDataPath/);
  assert.doesNotMatch(launcher, /D:\\Programs\\Secure Codex Switcher/);
  assert.doesNotMatch(launcher, /LOCALAPPDATA/);
  assert.match(launcher, /Secure Codex Switcher\.exe/);
  assert.doesNotMatch(launcher, /dist\\win-unpacked\\Secure Codex Switcher\.exe/);
});

test("normal launcher fails closed when the installed executable is absent", () => {
  assert.match(launcher, /installed application|installed executable/i);
  assert.match(launcher, /exit 1/);
});

test("normal launcher creates the formal process outside an inherited Codex job", () => {
  assert.match(launcher, /function Start-DetachedSwitcher/);
  assert.match(launcher, /\(\[wmiclass\]"Win32_ProcessStartup"\)\.CreateInstance\(\)/);
  assert.match(launcher, /\$startup\.EnvironmentVariables = \[string\[\]\]/);
  assert.doesNotMatch(launcher, /\$startup\.ShowWindow\s*=\s*0/);
  assert.match(launcher, /\(\[wmiclass\]"Win32_Process"\)\.Create\(\$commandLine, \$installedRoot, \$startup\)/);
  assert.doesNotMatch(launcher, /Start-Process -FilePath \$packagedExe/);
});
