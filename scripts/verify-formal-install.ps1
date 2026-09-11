param(
  [string]$SourceRoot = (Split-Path -Parent $PSScriptRoot),
  [string]$InstallRoot = "D:\Secure Codex Switcher Workspace\Program",
  [string]$UserDataPath = "D:\Secure Codex Switcher Workspace\Data",
  [string]$SnapshotPath,
  [switch]$RequireRunning
)

$ErrorActionPreference = "Stop"

function Read-Shortcut($Path, $Shell) {
  if (-not (Test-Path -LiteralPath $Path)) {
    return [pscustomobject]@{ target = $null; workingDirectory = $null; iconLocation = $null; arguments = $null }
  }
  $shortcut = $Shell.CreateShortcut($Path)
  [pscustomobject]@{
    target = $shortcut.TargetPath
    workingDirectory = $shortcut.WorkingDirectory
    iconLocation = $shortcut.IconLocation
    arguments = $shortcut.Arguments
  }
}

function Get-UninstallExecutable($CommandLine) {
  $quoted = [regex]::Match([string]$CommandLine, '^\s*"(?<path>[^"]+)"(?:\s|$)')
  if ($quoted.Success) { return $quoted.Groups['path'].Value }
  $bare = [regex]::Match([string]$CommandLine, '^\s*(?<path>\S+)')
  if ($bare.Success) { return $bare.Groups['path'].Value }
  return $null
}

function Get-AsarEntryHash($AsarPath, $EntryPath) {
  $asarModule = Join-Path $SourceRoot "node_modules\@electron\asar"
  $script = "const asar=require(process.argv[1]); const crypto=require('node:crypto'); const bytes=asar.extractFile(process.argv[2],process.argv[3]); process.stdout.write(crypto.createHash('sha256').update(bytes).digest('hex').toUpperCase())"
  $result = & node -e $script $asarModule $AsarPath $EntryPath 2>$null
  if ($LASTEXITCODE -ne 0) { return $null }
  return $result
}

function Get-AsarEntryJson($AsarPath, $EntryPath) {
  $asarModule = Join-Path $SourceRoot "node_modules\@electron\asar"
  $script = "const asar=require(process.argv[1]); process.stdout.write(asar.extractFile(process.argv[2],process.argv[3]).toString('utf8'))"
  $result = & node -e $script $asarModule $AsarPath $EntryPath 2>$null
  if ($LASTEXITCODE -ne 0 -or -not $result) { return $null }
  try { return ($result -join "`n") | ConvertFrom-Json }
  catch { return $null }
}

function Get-GitText([string[]]$Arguments) {
  $result = & git -C $SourceRoot @Arguments 2>$null
  if ($LASTEXITCODE -ne 0) { return $null }
  return ($result -join "`n").Trim()
}

function Test-GitCommand([string[]]$Arguments) {
  & git -C $SourceRoot @Arguments 1>$null 2>$null
  return $LASTEXITCODE -eq 0
}

function Test-ExecutableIconResource($ExecutablePath, $ProductIconPath) {
  $reseditModule = Join-Path $SourceRoot "node_modules\resedit"
  $script = @'
const fs = require("node:fs");
const crypto = require("node:crypto");
const ResEdit = require(process.argv[1]);
const executable = ResEdit.NtExecutable.from(fs.readFileSync(process.argv[2]));
const resources = ResEdit.NtExecutableResource.from(executable);
const iconFile = ResEdit.Data.IconFile.from(fs.readFileSync(process.argv[3]));
const digest = (bytes) => crypto.createHash("sha256").update(Buffer.from(bytes)).digest("hex");
const fingerprint = (icon, bytes) => `${icon.width}:${icon.height}:${icon.bitCount}:${digest(bytes)}`;
const expected = iconFile.icons.map((icon) => fingerprint(icon, icon.data.bin)).sort().join("|");
const matches = ResEdit.Resource.IconGroupEntry.fromEntries(resources.entries).some((group) => {
  const actual = group.icons.map((icon) => {
    const entry = resources.entries.find((candidate) => candidate.type === 3 && candidate.id === icon.iconID && candidate.lang === group.lang);
    return entry ? fingerprint(icon, entry.bin) : "";
  }).sort().join("|");
  return actual === expected;
});
process.stdout.write(matches ? "true" : "false");
'@
  $result = & node -e $script $reseditModule $ExecutablePath $ProductIconPath 2>$null
  return $LASTEXITCODE -eq 0 -and (($result -join "").Trim() -eq "true")
}

if ($SnapshotPath) {
  $snapshot = Get-Content -Raw -LiteralPath $SnapshotPath | ConvertFrom-Json
} else {
  $executablePath = Join-Path $InstallRoot "Secure Codex Switcher.exe"
  $builtAsarPath = Join-Path $SourceRoot "dist\win-unpacked\resources\app.asar"
  $sourceBuildIconPath = Join-Path $SourceRoot "build\icon.png"
  $installedAsarPath = Join-Path $InstallRoot "resources\app.asar"
  $shortcutIconPath = Join-Path $InstallRoot "resources\shortcut-icon-2.5.2.ico"
  $trayIconPath = Join-Path $InstallRoot "resources\tray-icon-2.5.3.png"
  $uninstallerPath = Join-Path $InstallRoot "Uninstall Secure Codex Switcher.exe"
  $builtProvenance = if (Test-Path -LiteralPath $builtAsarPath) { Get-AsarEntryJson $builtAsarPath "src/build-provenance.json" } else { $null }
  $installedProvenance = if (Test-Path -LiteralPath $installedAsarPath) { Get-AsarEntryJson $installedAsarPath "src/build-provenance.json" } else { $null }
  $sourceBranch = Get-GitText @("branch", "--show-current")
  $sourceHead = Get-GitText @("rev-parse", "HEAD")
  $provenanceCommit = [string]$builtProvenance.commit
  $provenanceCommitExists = $provenanceCommit -match '^[0-9a-fA-F]{40}$' -and (Test-GitCommand @("cat-file", "-e", "$provenanceCommit`^{commit}"))
  $provenanceIsAncestor = $provenanceCommitExists -and (Test-GitCommand @("merge-base", "--is-ancestor", $provenanceCommit, "HEAD"))
  $releaseTreeMatches = $provenanceIsAncestor -and (Test-GitCommand @(
    "diff", "--quiet", $provenanceCommit, "HEAD", "--",
    "package.json", "src", "build", "scripts", "Start-CodexSwitcher.ps1"
  ))

  $uninstallCandidates = @(Get-ChildItem "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall" -ErrorAction SilentlyContinue |
    ForEach-Object {
      try { Get-ItemProperty -LiteralPath $_.PSPath -ErrorAction Stop } catch { $null }
    } |
    Where-Object { $_.DisplayName -like "Secure Codex Switcher*" })

  $shell = New-Object -ComObject WScript.Shell
  $desktopShortcutPath = Join-Path ([Environment]::GetFolderPath("Desktop")) "Codex Switcher.lnk"
  $startMenuShortcutPath = Join-Path ([Environment]::GetFolderPath("Programs")) "Codex Switcher.lnk"

  $snapshot = [pscustomobject]@{
    files = [pscustomobject]@{
      executable = Test-Path -LiteralPath $executablePath
      builtAsar = Test-Path -LiteralPath $builtAsarPath
      installedAsar = Test-Path -LiteralPath $installedAsarPath
      sourceBuildIcon = Test-Path -LiteralPath $sourceBuildIconPath
      shortcutIcon = Test-Path -LiteralPath $shortcutIconPath
      trayIcon = Test-Path -LiteralPath $trayIconPath
      uninstaller = Test-Path -LiteralPath $uninstallerPath
    }
    hashes = [pscustomobject]@{
      builtAsar = if (Test-Path -LiteralPath $builtAsarPath) { (Get-FileHash -LiteralPath $builtAsarPath -Algorithm SHA256).Hash } else { $null }
      installedAsar = if (Test-Path -LiteralPath $installedAsarPath) { (Get-FileHash -LiteralPath $installedAsarPath -Algorithm SHA256).Hash } else { $null }
      sourceBuildIcon = if (Test-Path -LiteralPath $sourceBuildIconPath) { (Get-FileHash -LiteralPath $sourceBuildIconPath -Algorithm SHA256).Hash } else { $null }
      installedAsarBuildIcon = if (Test-Path -LiteralPath $installedAsarPath) { Get-AsarEntryHash $installedAsarPath "build/icon.png" } else { $null }
    }
    integrity = [pscustomobject]@{
      executableIconMatchesProductIcon = if ((Test-Path -LiteralPath $executablePath) -and (Test-Path -LiteralPath $shortcutIconPath)) {
        Test-ExecutableIconResource $executablePath $shortcutIconPath
      } else { $false }
    }
    provenance = [pscustomobject]@{
      built = $builtProvenance
      installed = $installedProvenance
      source = [pscustomobject]@{
        branch = $sourceBranch
        head = $sourceHead
        provenanceCommitExists = $provenanceCommitExists
        provenanceIsAncestor = $provenanceIsAncestor
        releaseTreeMatches = $releaseTreeMatches
      }
    }
    uninstallCandidates = @($uninstallCandidates | ForEach-Object {
      [pscustomobject]@{
        installLocation = $_.InstallLocation
        uninstallString = $_.UninstallString
      }
    })
    shortcuts = [pscustomobject]@{
      desktop = Read-Shortcut $desktopShortcutPath $shell
      startMenu = Read-Shortcut $startMenuShortcutPath $shell
    }
    processes = @(Get-CimInstance Win32_Process -Filter "Name = 'Secure Codex Switcher.exe'" -ErrorAction SilentlyContinue | ForEach-Object {
      [pscustomobject]@{
        processId = $_.ProcessId
        parentProcessId = $_.ParentProcessId
        executablePath = $_.ExecutablePath
        commandLine = $_.CommandLine
      }
    })
  }
}

$issues = [System.Collections.Generic.List[object]]::new()
$expectedExecutable = Join-Path $InstallRoot "Secure Codex Switcher.exe"
$expectedUninstaller = Join-Path $InstallRoot "Uninstall Secure Codex Switcher.exe"
$expectedAppAsar = Join-Path $InstallRoot "resources\app.asar"
$expectedIcon = (Join-Path $InstallRoot "resources\shortcut-icon-2.5.2.ico") + ",0"
$expectedShortcutArguments = "--user-data-dir=`"$UserDataPath`""
$expectedProvenanceBranch = "codex/complete-branch-integration"

foreach ($name in @("executable", "builtAsar", "installedAsar", "sourceBuildIcon", "shortcutIcon", "trayIcon", "uninstaller")) {
  if ($snapshot.files.$name -ne $true) {
    $issues.Add([pscustomobject]@{
      code = "file.$name"
      message = "Required formal-install artifact is missing."
    })
  }
}

$formalUninstallCandidates = @($snapshot.uninstallCandidates | Where-Object {
  [string]::Equals((Get-UninstallExecutable $_.uninstallString), $expectedUninstaller, [System.StringComparison]::OrdinalIgnoreCase)
})
$uninstallCandidateCount = @($snapshot.uninstallCandidates).Count
if ($uninstallCandidateCount -ne 1 -or $formalUninstallCandidates.Count -ne 1) {
  $issues.Add([pscustomobject]@{
    code = "registry.uninstallIdentity"
    message = "The Secure Codex Switcher uninstall entry must exist exactly once and be the formal NSIS uninstaller."
    expected = $expectedUninstaller
    actual = [pscustomobject]@{
      candidateCount = $uninstallCandidateCount
      matchingCount = $formalUninstallCandidates.Count
    }
  })
} else {
  $installLocation = [string]$formalUninstallCandidates[0].installLocation
  if ($installLocation -and -not [string]::Equals($installLocation, $InstallRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    $issues.Add([pscustomobject]@{
      code = "registry.installLocation"
      message = "InstallLocation, when present, must equal the complete formal install root."
      expected = $InstallRoot
      actual = $installLocation
    })
  }
}

if (-not [string]::Equals($snapshot.hashes.builtAsar, $snapshot.hashes.installedAsar, [System.StringComparison]::OrdinalIgnoreCase)) {
  $issues.Add([pscustomobject]@{
    code = "hash.appAsar"
    message = "Built and installed app.asar SHA256 hashes differ."
    expected = $snapshot.hashes.builtAsar
    actual = $snapshot.hashes.installedAsar
  })
}

$builtProvenance = $snapshot.provenance.built
$installedProvenance = $snapshot.provenance.installed
$sourceProvenance = $snapshot.provenance.source
if (-not $builtProvenance -or -not $installedProvenance) {
  $issues.Add([pscustomobject]@{
    code = "provenance.missing"
    message = "Built and installed app.asar must contain build provenance."
  })
} else {
  $sameProvenance = [string]::Equals([string]$builtProvenance.branch, [string]$installedProvenance.branch, [System.StringComparison]::Ordinal) -and
    [string]::Equals([string]$builtProvenance.commit, [string]$installedProvenance.commit, [System.StringComparison]::OrdinalIgnoreCase)
  if (-not $sameProvenance) {
    $issues.Add([pscustomobject]@{
      code = "provenance.identity"
      message = "Built and installed app.asar provenance must be identical."
      expected = $builtProvenance
      actual = $installedProvenance
    })
  }
  if (-not [string]::Equals([string]$builtProvenance.branch, $expectedProvenanceBranch, [System.StringComparison]::Ordinal)) {
    $issues.Add([pscustomobject]@{
      code = "provenance.branch"
      message = "Formal package provenance must use the canonical integration branch."
      expected = $expectedProvenanceBranch
      actual = $builtProvenance.branch
    })
  }
}

if (-not $sourceProvenance -or
    -not [string]::Equals([string]$sourceProvenance.branch, $expectedProvenanceBranch, [System.StringComparison]::Ordinal) -or
    $sourceProvenance.provenanceCommitExists -ne $true -or
    $sourceProvenance.provenanceIsAncestor -ne $true -or
    $sourceProvenance.releaseTreeMatches -ne $true) {
  $issues.Add([pscustomobject]@{
    code = "provenance.source"
    message = "Packaged provenance must be an ancestor of Source with no later release-tree changes."
    expected = [pscustomobject]@{
      branch = $expectedProvenanceBranch
      provenanceCommitExists = $true
      provenanceIsAncestor = $true
      releaseTreeMatches = $true
    }
    actual = $sourceProvenance
  })
}

if ([string]::IsNullOrWhiteSpace([string]$snapshot.hashes.sourceBuildIcon) -or
    [string]::IsNullOrWhiteSpace([string]$snapshot.hashes.installedAsarBuildIcon) -or
    -not [string]::Equals($snapshot.hashes.sourceBuildIcon, $snapshot.hashes.installedAsarBuildIcon, [System.StringComparison]::OrdinalIgnoreCase)) {
  $issues.Add([pscustomobject]@{
    code = "hash.buildIcon"
    message = "Installed app.asar build/icon.png SHA256 must match the source build/icon.png."
    expected = $snapshot.hashes.sourceBuildIcon
    actual = $snapshot.hashes.installedAsarBuildIcon
  })
}

if ($snapshot.integrity.executableIconMatchesProductIcon -ne $true) {
  $issues.Add([pscustomobject]@{
    code = "icon.executable"
    message = "The executable PE icon resources must match the versioned product icon."
  })
}

foreach ($name in @("desktop", "startMenu")) {
  $shortcut = $snapshot.shortcuts.$name
  if (-not [string]::Equals($shortcut.target, $expectedExecutable, [System.StringComparison]::OrdinalIgnoreCase)) {
    $issues.Add([pscustomobject]@{
      code = "shortcut.$name.target"
      message = "Shortcut target must use the complete formal install path."
      expected = $expectedExecutable
      actual = $shortcut.target
    })
  }
  if (-not [string]::Equals($shortcut.workingDirectory, $InstallRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    $issues.Add([pscustomobject]@{
      code = "shortcut.$name.workingDirectory"
      message = "Shortcut working directory must equal the complete formal install root."
      expected = $InstallRoot
      actual = $shortcut.workingDirectory
    })
  }
  if (-not [string]::Equals($shortcut.iconLocation, $expectedIcon, [System.StringComparison]::OrdinalIgnoreCase)) {
    $issues.Add([pscustomobject]@{
      code = "shortcut.$name.iconLocation"
      message = "Shortcut must use the versioned formal-install icon."
      expected = $expectedIcon
      actual = $shortcut.iconLocation
    })
  }
  if (-not [string]::Equals($shortcut.arguments, $expectedShortcutArguments, [System.StringComparison]::OrdinalIgnoreCase)) {
    $issues.Add([pscustomobject]@{
      code = "shortcut.$name.arguments"
      message = "Shortcut arguments must use the formal user-data directory."
      expected = $expectedShortcutArguments
      actual = $shortcut.arguments
    })
  }
}

$rootProcessCount = 0
foreach ($process in @($snapshot.processes)) {
  $commandLine = [string]$process.commandLine
  if ($commandLine -notmatch '(?:^|\s)--type=') { $rootProcessCount++ }
  if (-not [string]::Equals($process.executablePath, $expectedExecutable, [System.StringComparison]::OrdinalIgnoreCase)) {
    $issues.Add([pscustomobject]@{
      code = "process.executable"
      message = "Running Switcher process must use the formal executable."
      expected = $expectedExecutable
      actual = $process.executablePath
    })
  }

  $userDataMatch = [regex]::Match($commandLine, '--user-data-dir=(?:"(?<quoted>[^"]+)"|(?<bare>[^"]+?)(?="(?:\s|$)|\s--|$))', [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)
  $actualUserData = if ($userDataMatch.Groups['quoted'].Success) { $userDataMatch.Groups['quoted'].Value } else { $userDataMatch.Groups['bare'].Value }
  if (-not $userDataMatch.Success -or -not [string]::Equals($actualUserData, $UserDataPath, [System.StringComparison]::OrdinalIgnoreCase)) {
    $issues.Add([pscustomobject]@{
      code = "process.userData"
      message = "Running Switcher process must use the formal user-data directory."
      expected = $UserDataPath
      actual = $actualUserData
    })
  }

  $appPathMatch = [regex]::Match($commandLine, '--app-path=(?:"(?<quoted>[^"]+)"|(?<bare>[^"]+?)(?="(?:\s|$)|\s--|$))', [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)
  if ($appPathMatch.Success) {
    $actualAppPath = if ($appPathMatch.Groups['quoted'].Success) { $appPathMatch.Groups['quoted'].Value } else { $appPathMatch.Groups['bare'].Value }
    if (-not [string]::Equals($actualAppPath, $expectedAppAsar, [System.StringComparison]::OrdinalIgnoreCase)) {
      $issues.Add([pscustomobject]@{
        code = "process.appPath"
        message = "Running Switcher process must load the installed app.asar."
        expected = $expectedAppAsar
        actual = $actualAppPath
      })
    }
  } elseif ($commandLine -match '(?:^|\s)--type=renderer(?:\s|$)') {
    $issues.Add([pscustomobject]@{
      code = "process.appPath"
      message = "Renderer process is missing the installed app.asar identity."
      expected = $expectedAppAsar
      actual = $null
    })
  }
}

if ($RequireRunning -and $rootProcessCount -eq 0) {
  $issues.Add([pscustomobject]@{
    code = "process.root"
    message = "No formal root Switcher process is running."
  })
}

[pscustomobject]@{
  ok = $issues.Count -eq 0
  errors = @($issues)
  facts = [pscustomobject]@{
    sourceRoot = $SourceRoot
    installRoot = $InstallRoot
    userDataPath = $UserDataPath
    hashes = $snapshot.hashes
    integrity = $snapshot.integrity
    provenance = $snapshot.provenance
    processCount = @($snapshot.processes).Count
  }
} | ConvertTo-Json -Depth 8
if ($issues.Count -gt 0) { exit 1 }
