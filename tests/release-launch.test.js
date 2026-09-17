import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const launcher = fs.readFileSync(new URL("../Start-CodexSwitcher.ps1", import.meta.url), "utf8");

test("normal launcher resolves the installed executable", () => {
  assert.match(launcher, /Resolve-SwitcherLaunchPaths/);
  assert.match(launcher, /\$env:APPDATA/);
  assert.match(launcher, /--user-data-dir=.*\$userDataPath/);
  assert.doesNotMatch(launcher, /D:\\Programs\\Secure Codex Switcher/);
  assert.match(launcher, /\$env:LOCALAPPDATA/);
  assert.match(launcher, /Secure Codex Switcher\.exe/);
  assert.doesNotMatch(launcher, /dist\\win-unpacked\\Secure Codex Switcher\.exe/);
});

test("normal launcher fails closed when the installed executable is absent", () => {
  assert.match(launcher, /installed application|installed executable/i);
  assert.match(launcher, /exit 1/);
});

test("launcher path resolution preserves custom data, discovers installed roots and fails on ambiguity", { skip: process.platform !== "win32" }, () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "switcher-launch-fixture-"));
  try {
    for (const name of ["Installed App", "Other App", "Local/Programs/Secure Codex Switcher"]) {
      const root = path.join(directory, name);
      fs.mkdirSync(root, { recursive: true });
      fs.writeFileSync(path.join(root, "Secure Codex Switcher.exe"), "synthetic placeholder; never execute");
    }
    const functions = launcher.slice(launcher.indexOf("function Get-InstalledSwitcherCandidates"), launcher.indexOf("function Show-LaunchError"));
    const script = `
$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
${functions}
$base = '${directory.replaceAll("'", "''")}'
$app = Join-Path $base 'Installed App'
$other = Join-Path $base 'Other App'
$data = Join-Path $base 'Custom 数据'
$roaming = Join-Path $base 'Roaming'
$local = Join-Path $base 'Local'
$candidate = [pscustomobject]@{ Root = $app; DataPath = $data }
$result = [ordered]@{}
$result.explicit = Resolve-SwitcherLaunchPaths $app $data $base $roaming $local @()
$result.shortcut = Resolve-SwitcherLaunchPaths $null $null $base $roaming $null @($candidate)
$result.override = Resolve-SwitcherLaunchPaths $app (Join-Path $base 'Override') $base $roaming $null @($candidate)
$result.adjacent = Resolve-SwitcherLaunchPaths $null $null $app $roaming $null @()
$result.default = Resolve-SwitcherLaunchPaths $null $null $base $roaming $local @()
$result.registry = Resolve-SwitcherLaunchPaths $null $null $base $roaming $null @([pscustomobject]@{ Root = $app; DataPath = $null })
$result.duplicate = Resolve-SwitcherLaunchPaths $null $null $base $roaming $null @($candidate, $candidate)
try { Resolve-SwitcherLaunchPaths $null $null $base $roaming $null @() | Out-Null; throw 'expected missing' } catch { $result.missing = $_.Exception.Message }
try { Resolve-SwitcherLaunchPaths $null $null $base $roaming $null @($candidate, [pscustomobject]@{Root=$other}) | Out-Null; throw 'expected ambiguous' } catch { $result.ambiguous = $_.Exception.Message }
try { Resolve-SwitcherLaunchPaths $app 'relative' $base $roaming $null @() | Out-Null; throw 'expected invalid data' } catch { $result.invalid = $_.Exception.Message }
try { Resolve-SwitcherLaunchPaths $app $null $base $roaming $null @($candidate, [pscustomobject]@{Root=$app; DataPath=(Join-Path $base 'Conflict')}) | Out-Null; throw 'expected conflict' } catch { $result.conflict = $_.Exception.Message }
$result | ConvertTo-Json -Depth 4 -Compress
`;
    const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { encoding: "utf8", windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
    const values = JSON.parse(result.stdout);
    assert.equal(values.explicit.InstallRoot, path.join(directory, "Installed App"));
    assert.equal(values.explicit.UserDataPath, path.join(directory, "Custom 数据"));
    assert.deepEqual(values.shortcut, values.explicit);
    assert.deepEqual(values.duplicate, values.explicit);
    assert.equal(values.override.UserDataPath, path.join(directory, "Override"));
    assert.equal(values.adjacent.UserDataPath, path.join(directory, "Roaming", "secure-codex-switcher-win"));
    assert.deepEqual(values.registry, values.adjacent);
    assert.equal(values.default.InstallRoot, path.join(directory, "Local", "Programs", "Secure Codex Switcher"));
    assert.match(values.missing, /Cannot uniquely find/);
    assert.match(values.ambiguous, /Cannot uniquely find/);
    assert.match(values.invalid, /absolute path/);
    assert.match(values.conflict, /Conflicting shortcut/);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test("normal launcher creates the formal process outside an inherited Codex job", () => {
  assert.match(launcher, /function Start-DetachedSwitcher/);
  assert.match(launcher, /\(\[wmiclass\]"Win32_ProcessStartup"\)\.CreateInstance\(\)/);
  assert.match(launcher, /\$startup\.EnvironmentVariables = \[string\[\]\]/);
  assert.doesNotMatch(launcher, /\$startup\.ShowWindow\s*=\s*0/);
  assert.match(launcher, /\(\[wmiclass\]"Win32_Process"\)\.Create\(\$commandLine, \$installedRoot, \$startup\)/);
  assert.doesNotMatch(launcher, /Start-Process -FilePath \$packagedExe/);
});
