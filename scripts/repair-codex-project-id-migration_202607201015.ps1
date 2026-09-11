param(
  [string]$StatePath = (Join-Path $env:USERPROFILE ".codex\.codex-global-state.json"),
  [string]$ResultPath = (Join-Path $env:USERPROFILE ".codex\recovery\codex-project-id-consolidation-result_202607201015.json"),
  [switch]$Execute,
  [switch]$ControlledRestart,
  [string]$SwitcherExecutable,
  [string]$SwitcherDataDirectory,
  [int]$DelaySeconds = 0
)

$ErrorActionPreference = "Stop"

function Get-OfficialCodexProcesses {
  @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
    $_.ExecutablePath -like "*\OpenAI.Codex_*" -and
    $_.Name -in @("ChatGPT.exe", "codex.exe", "codex-code-mode-host.exe")
  })
}

function Get-SwitcherProcesses([string]$Executable) {
  if ([string]::IsNullOrWhiteSpace($Executable)) { return @() }
  $resolved = [IO.Path]::GetFullPath($Executable)
  @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
    $_.ExecutablePath -and [IO.Path]::GetFullPath($_.ExecutablePath) -ieq $resolved
  })
}

function Stop-And-Wait([scriptblock]$Discover, [string]$Label) {
  $processes = @(& $Discover)
  if ($processes.Count) {
    Stop-Process -Id @($processes.ProcessId) -Force -ErrorAction SilentlyContinue
  }
  $deadline = (Get-Date).AddSeconds(30)
  while (@(& $Discover).Count -gt 0 -and (Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 500
  }
  if (@(& $Discover).Count -gt 0) { throw "$Label did not exit within 30 seconds." }
}

function Get-NormalizedProjectPath([System.Collections.IDictionary]$State, [string]$ProjectId) {
  $project = $State["local-projects"][$ProjectId]
  $pathValue = if (@($project["rootPaths"]).Count) {
    [string]@($project["rootPaths"])[0]
  } elseif ($State["project-writable-roots"].Contains($ProjectId)) {
    $localRoot = @($State["project-writable-roots"][$ProjectId] | Where-Object { $_["kind"] -eq "local" })[0]
    [string]$localRoot["path"]
  } else {
    ""
  }
  if ([string]::IsNullOrWhiteSpace($pathValue)) { return "" }
  [IO.Path]::GetFullPath($pathValue).TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
}

function Get-CanonicalProjectId([string]$ProjectPath) {
  $bytes = [Text.Encoding]::UTF8.GetBytes($ProjectPath)
  $hash = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($bytes)).ToLowerInvariant()
  "local-$($hash.Substring(0, 32))"
}

function Map-ProjectId([string]$ProjectId, [System.Collections.IDictionary]$Mapping) {
  if ($Mapping.Contains($ProjectId)) { return [string]$Mapping[$ProjectId] }
  $ProjectId
}

function Replace-ProjectIdTokens([string]$Value, [System.Collections.IDictionary]$Mapping) {
  $result = $Value
  foreach ($legacyId in $Mapping.Keys) {
    $result = $result.Replace([string]$legacyId, [string]$Mapping[$legacyId])
  }
  $result
}

function Map-UniqueIds($Values, [System.Collections.IDictionary]$Mapping) {
  $seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
  @($Values | ForEach-Object {
    $mapped = Map-ProjectId ([string]$_) $Mapping
    if ($seen.Add($mapped)) { $mapped }
  })
}

function Remap-ExactProjectIds($Value, [System.Collections.IDictionary]$Mapping) {
  if ($Value -is [string]) { return Replace-ProjectIdTokens $Value $Mapping }
  if ($Value -is [System.Collections.IDictionary]) {
    $result = [ordered]@{}
    foreach ($key in $Value.Keys) {
      $mappedKey = Replace-ProjectIdTokens ([string]$key) $Mapping
      if ($result.Contains($mappedKey) -and $mappedKey -ne [string]$key) { continue }
      $result[$mappedKey] = Remap-ExactProjectIds $Value[$key] $Mapping
    }
    return $result
  }
  if ($Value -is [System.Collections.IList]) {
    return @($Value | ForEach-Object { Remap-ExactProjectIds $_ $Mapping })
  }
  $Value
}

function Merge-SidebarOrder($Existing, $Incoming) {
  $left = if ($Existing -and $Existing.Contains("threadIds")) { @($Existing["threadIds"]) } else { @() }
  $right = if ($Incoming -and $Incoming.Contains("threadIds")) { @($Incoming["threadIds"]) } else { @() }
  [ordered]@{ threadIds = @(Map-UniqueIds ($left + $right) @{}) }
}

function New-ConsolidatedState([System.Collections.IDictionary]$State) {
  foreach ($required in @("local-projects", "project-writable-roots", "thread-project-assignments")) {
    if (-not $State.Contains($required) -or $State[$required] -isnot [System.Collections.IDictionary]) {
      throw "Missing or invalid required field: $required"
    }
  }

  $projects = $State["local-projects"]
  $beforeProjectCount = $projects.Count
  $beforeAssignmentCount = $State["thread-project-assignments"].Count
  $beforeWritableRootCount = $State["project-writable-roots"].Count
  $groups = [Collections.Generic.Dictionary[string, Collections.Generic.List[string]]]::new([StringComparer]::OrdinalIgnoreCase)
  foreach ($projectId in @($projects.Keys)) {
    $root = Get-NormalizedProjectPath $State $projectId
    if ([string]::IsNullOrWhiteSpace($root) -or -not (Test-Path -LiteralPath $root -PathType Container)) { continue }
    if (-not $groups.ContainsKey($root)) { $groups[$root] = [Collections.Generic.List[string]]::new() }
    $groups[$root].Add([string]$projectId)
  }

  $mapping = [ordered]@{}
  $duplicatePairs = 0
  foreach ($entry in $groups.GetEnumerator()) {
    $canonicalId = Get-CanonicalProjectId $entry.Key
    $legacy = @($entry.Value | Where-Object { $_ -match "^[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$" })
    $current = @($entry.Value | Where-Object { $_ -like "local-*" })
    if ($entry.Value.Count -gt 2 -or $legacy.Count -gt 1 -or $current.Count -gt 1 -or ($current.Count -eq 1 -and $current[0] -ne $canonicalId)) {
      throw "Ambiguous project identities for $($entry.Key)."
    }
    if ($legacy.Count -eq 1) {
      if (@($projects[$legacy[0]]["rootPaths"]).Count -ne 1) { throw "Legacy project must have exactly one root: $($legacy[0])" }
      $mapping[$legacy[0]] = $canonicalId
      if ($entry.Value.Count -eq 2) { $duplicatePairs += 1 }
    }
  }
  if ($mapping.Count -eq 0) { throw "No legacy project identities were found." }

  foreach ($assignment in $State["thread-project-assignments"].Values) {
    if ($assignment -is [System.Collections.IDictionary] -and $assignment.Contains("projectId")) {
      $assignment["projectId"] = Map-ProjectId ([string]$assignment["projectId"]) $mapping
    }
  }

  if ($State.Contains("project-order")) {
    $State["project-order"] = @(Map-UniqueIds $State["project-order"] $mapping)
  }
  if ($State.Contains("pinned-project-ids")) {
    $State["pinned-project-ids"] = @(Map-UniqueIds $State["pinned-project-ids"] $mapping)
  }
  if ($State.Contains("active-workspace-roots")) {
    $State["active-workspace-roots"] = Remap-ExactProjectIds $State["active-workspace-roots"] $mapping
  }
  if ($State.Contains("selected-project") -and $State["selected-project"] -is [System.Collections.IDictionary] -and $State["selected-project"].Contains("projectId")) {
    $State["selected-project"]["projectId"] = Map-ProjectId ([string]$State["selected-project"]["projectId"]) $mapping
  }
  if ($State.Contains("electron-persisted-atom-state")) {
    $State["electron-persisted-atom-state"] = Remap-ExactProjectIds $State["electron-persisted-atom-state"] $mapping
  }

  $sidebarOrders = if ($State.Contains("sidebar-project-thread-orders") -and $State["sidebar-project-thread-orders"] -is [System.Collections.IDictionary]) {
    $State["sidebar-project-thread-orders"]
  } else {
    [ordered]@{}
  }
  foreach ($legacyId in @($mapping.Keys)) {
    $currentId = [string]$mapping[$legacyId]
    $projectRoot = Get-NormalizedProjectPath $State $legacyId
    if (-not $projects.Contains($currentId)) {
      $projects[$currentId] = [ordered]@{}
      foreach ($key in @($projects[$legacyId].Keys)) { $projects[$currentId][$key] = $projects[$legacyId][$key] }
      $projects[$currentId]["id"] = $currentId
    }
    if ($sidebarOrders.Contains($legacyId)) {
      $sidebarOrders[$currentId] = Merge-SidebarOrder $sidebarOrders[$currentId] $sidebarOrders[$legacyId]
      $sidebarOrders.Remove($legacyId)
    }

    if (-not $State["project-writable-roots"].Contains($currentId) -and $State["project-writable-roots"].Contains($legacyId)) {
      $State["project-writable-roots"][$currentId] = $State["project-writable-roots"][$legacyId]
    }
    if (-not $State["project-writable-roots"].Contains($currentId)) {
      $State["project-writable-roots"][$currentId] = @([ordered]@{ kind = "local"; path = $projectRoot })
    }
    $State["project-writable-roots"].Remove($legacyId)

    foreach ($key in @($projects[$legacyId].Keys)) {
      if (-not $projects[$currentId].Contains($key)) { $projects[$currentId][$key] = $projects[$legacyId][$key] }
    }
    $projects.Remove($legacyId)
  }
  $State["sidebar-project-thread-orders"] = $sidebarOrders

  $savedRoots = [Collections.Generic.List[string]]::new()
  $savedRootSet = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
  foreach ($root in @($State["electron-saved-workspace-roots"])) {
    if ($root -and $savedRootSet.Add([string]$root)) { $savedRoots.Add([string]$root) }
  }
  foreach ($legacyId in $mapping.Keys) {
    $root = Get-NormalizedProjectPath $State ([string]$mapping[$legacyId])
    if ($root -and $savedRootSet.Add($root)) { $savedRoots.Add($root) }
  }
  $State["electron-saved-workspace-roots"] = @($savedRoots)

  foreach ($rootId in @($State["project-writable-roots"].Keys)) {
    if (-not $projects.Contains($rootId) -and @($State["project-writable-roots"][$rootId]).Count -eq 0) {
      $State["project-writable-roots"].Remove($rootId)
    }
  }

  $State["project-order"] = @(Map-UniqueIds (@($State["project-order"]) + @($projects.Keys)) @{})

  $normalizedRoots = @($projects.Keys | ForEach-Object { Get-NormalizedProjectPath $State ([string]$_) } | Where-Object { $_ })
  $duplicates = @($normalizedRoots | Group-Object | Where-Object Count -gt 1)
  if ($duplicates.Count) { throw "Duplicate project paths remain after consolidation." }
  if ($State["thread-project-assignments"].Count -ne $beforeAssignmentCount) { throw "Thread assignment count changed." }
  foreach ($assignment in $State["thread-project-assignments"].Values) {
    if ($assignment -isnot [System.Collections.IDictionary] -or -not $assignment.Contains("projectId") -or -not $projects.Contains([string]$assignment["projectId"])) {
      throw "A thread assignment references a missing project."
    }
  }
  foreach ($id in @($State["project-order"]) + @($State["pinned-project-ids"])) {
    if (-not $projects.Contains([string]$id)) { throw "Project order or pin state references a missing project: $id" }
  }
  if ($State.Contains("selected-project") -and $State["selected-project"]["projectId"] -and -not $projects.Contains([string]$State["selected-project"]["projectId"])) {
    throw "Selected project references a missing project."
  }
  foreach ($legacyId in $mapping.Keys) {
    if (($State | ConvertTo-Json -Depth 100 -Compress).Contains([string]$legacyId)) { throw "Legacy project reference remains: $legacyId" }
  }

  [ordered]@{
    state = $State
    summary = [ordered]@{
      duplicatePairs = $duplicatePairs
      canonicalizedLegacyProjects = $mapping.Count
      projectsBefore = $beforeProjectCount
      projectsAfter = $projects.Count
      distinctProjectPaths = @($normalizedRoots | Sort-Object -Unique).Count
      assignmentsBefore = $beforeAssignmentCount
      assignmentsAfter = $State["thread-project-assignments"].Count
      removedEmptyWritableRoots = [Math]::Max(0, $beforeWritableRootCount - $State["project-writable-roots"].Count)
      addedWritableRoots = [Math]::Max(0, $State["project-writable-roots"].Count - $beforeWritableRootCount)
      mapping = $mapping
    }
  }
}

function Write-JsonAtomically([string]$Path, $Value) {
  $json = $Value | ConvertTo-Json -Depth 100 -Compress
  $null = $json | ConvertFrom-Json -Depth 100 -AsHashtable
  $temp = "$Path.tmp-$([guid]::NewGuid())"
  [IO.File]::WriteAllText($temp, $json, [Text.UTF8Encoding]::new($false))
  [IO.File]::Move($temp, $Path, $true)
}

$startedAt = Get-Date
$defaultStatePath = Join-Path $env:USERPROFILE ".codex\.codex-global-state.json"
$isLiveState = [IO.Path]::GetFullPath($StatePath) -ieq [IO.Path]::GetFullPath($defaultStatePath)
$result = [ordered]@{ status = "started"; startedAt = $startedAt.ToString("o"); statePath = $StatePath }

try {
  if ($DelaySeconds -gt 0) { Start-Sleep -Seconds $DelaySeconds }
  if ($Execute -and $isLiveState -and -not $ControlledRestart) {
    throw "Live state execution requires -ControlledRestart."
  }
  if ($ControlledRestart -and -not $Execute) { throw "-ControlledRestart requires -Execute." }
  if ($ControlledRestart) {
    if ([string]::IsNullOrWhiteSpace($SwitcherExecutable) -or -not (Test-Path -LiteralPath $SwitcherExecutable -PathType Leaf)) {
      throw "A valid Switcher executable is required for controlled restart."
    }
    if ([string]::IsNullOrWhiteSpace($SwitcherDataDirectory) -or -not (Test-Path -LiteralPath $SwitcherDataDirectory -PathType Container)) {
      throw "A valid Switcher data directory is required for controlled restart."
    }
    Stop-And-Wait { Get-OfficialCodexProcesses } "ChatGPT Codex"
    Stop-And-Wait { Get-SwitcherProcesses $SwitcherExecutable } "Secure Codex Switcher"
  } elseif ($Execute -and (Get-OfficialCodexProcesses).Count -gt 0 -and $isLiveState) {
    throw "ChatGPT Codex must be closed before live state execution."
  }

  $state = Get-Content -LiteralPath $StatePath -Raw | ConvertFrom-Json -Depth 100 -AsHashtable
  $consolidated = New-ConsolidatedState $state
  $result.summary = $consolidated.summary

  if ($Execute) {
    $stamp = Get-Date -Format "yyyyMMddHHmmss"
    $backupPath = Join-Path (Split-Path -Parent $StatePath) ".codex-global-state.before-project-id-consolidation_$stamp.json"
    Copy-Item -LiteralPath $StatePath -Destination $backupPath -ErrorAction Stop
    Write-JsonAtomically $StatePath $consolidated.state
    $verified = Get-Content -LiteralPath $StatePath -Raw | ConvertFrom-Json -Depth 100 -AsHashtable
    $result.backupPath = $backupPath
    $result.status = "applied"
    $result.persistedProjects = $verified["local-projects"].Count
    $result.persistedAssignments = $verified["thread-project-assignments"].Count
  } else {
    $result.status = "preview"
  }

  if ($ControlledRestart) {
    Start-Process explorer.exe -ArgumentList "shell:AppsFolder\OpenAI.Codex_2p2nqsd0c76g0!App"
    Start-Process -FilePath $SwitcherExecutable -ArgumentList @("--user-data-dir=`"$SwitcherDataDirectory`"")
    Start-Sleep -Seconds 20
    $postRestart = Get-Content -LiteralPath $StatePath -Raw | ConvertFrom-Json -Depth 100 -AsHashtable
    $postRoots = @($postRestart["local-projects"].Keys | ForEach-Object { Get-NormalizedProjectPath $postRestart ([string]$_) } | Where-Object { $_ })
    $result.postRestart = [ordered]@{
      codexProcesses = (Get-OfficialCodexProcesses).Count
      switcherProcesses = (Get-SwitcherProcesses $SwitcherExecutable).Count
      projects = $postRestart["local-projects"].Count
      assignments = $postRestart["thread-project-assignments"].Count
      duplicateProjectPaths = @($postRoots | Group-Object | Where-Object Count -gt 1).Count
    }
    if ($result.postRestart.codexProcesses -eq 0 -or $result.postRestart.switcherProcesses -eq 0 -or $result.postRestart.duplicateProjectPaths -ne 0) {
      $result.status = "post_restart_verification_failed"
    } else {
      $result.status = "success"
    }
  }
} catch {
  $result.status = "failed"
  $result.error = $_.Exception.Message
  if ($ControlledRestart) {
    if ((Get-OfficialCodexProcesses).Count -eq 0) {
      Start-Process explorer.exe -ArgumentList "shell:AppsFolder\OpenAI.Codex_2p2nqsd0c76g0!App" -ErrorAction SilentlyContinue
    }
    if ($SwitcherExecutable -and (Get-SwitcherProcesses $SwitcherExecutable).Count -eq 0) {
      Start-Process -FilePath $SwitcherExecutable -ArgumentList @("--user-data-dir=`"$SwitcherDataDirectory`"") -ErrorAction SilentlyContinue
    }
  }
} finally {
  $result.completedAt = (Get-Date).ToString("o")
  $resultDirectory = Split-Path -Parent $ResultPath
  if ($resultDirectory) { New-Item -ItemType Directory -Path $resultDirectory -Force | Out-Null }
  Write-JsonAtomically $ResultPath $result
}

$result | ConvertTo-Json -Depth 20
if ($result.status -eq "failed" -or $result.status -eq "post_restart_verification_failed") { exit 1 }
