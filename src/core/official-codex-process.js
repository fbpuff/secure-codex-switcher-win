export function officialCodexProcessIds(processes, options = {}) {
  const currentPid = Number(options.currentPid);
  const excluded = options.excludeCurrentTree ? currentOfficialCodexTreeIds(processes, currentPid) : new Set();
  return processes
    .filter((process) => isOfficialCodexProcess(process))
    .map((process) => Number(process.processId))
    .filter((pid) => Number.isInteger(pid) && pid > 0 && pid !== currentPid && !excluded.has(pid))
    .sort((left, right) => left - right);
}

export function officialCodexProcessScript({ mode, currentPid, excludeCurrentTree = false }) {
  const close = mode === "close";
  return `
$ErrorActionPreference = 'Stop'
$currentPid = ${Number(currentPid) || 0}
$all = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)
function IsOfficialCodex($process) {
  if (-not $process -or -not $process.ExecutablePath) { return $false }
  return (
    (
      $process.Name -ieq 'ChatGPT.exe' -or
      $process.Name -ieq 'chatgpt.exe' -or
      $process.Name -ieq 'Codex.exe' -or
      $process.Name -ieq 'codex.exe' -or
      $process.Name -ieq 'codex-code-mode-host.exe'
    ) -and
    (
      $process.ExecutablePath -like '*\\OpenAI.Codex_*' -or
      $process.ExecutablePath -like '*\\AppData\\Local\\OpenAI\\Codex\\*' -or
      $process.ExecutablePath -like '*\\.codex\\.sandbox-bin\\codex.exe' -or
      $process.ExecutablePath -like '*\\.codex\\plugins\\.plugin-appserver\\codex.exe'
    )
  )
}
function CurrentOfficialCodexTreeIds {
  $byId = @{}
  foreach ($process in $all) { $byId[[int]$process.ProcessId] = $process }
  $ancestorIds = New-Object System.Collections.Generic.HashSet[int]
  $ancestorVisited = New-Object System.Collections.Generic.HashSet[int]
  $cursor = if ($byId.ContainsKey($currentPid)) { $byId[$currentPid] } else { $null }
  while ($cursor) {
    $cursorPid = [int]$cursor.ProcessId
    if (-not $ancestorVisited.Add($cursorPid)) { break }
    if (IsOfficialCodex $cursor) { [void]$ancestorIds.Add($cursorPid) }
    $parentId = [int]$cursor.ParentProcessId
    $cursor = if ($parentId -gt 0 -and $byId.ContainsKey($parentId)) { $byId[$parentId] } else { $null }
  }
  $ids = New-Object System.Collections.Generic.HashSet[int]
  foreach ($process in $all) {
    $processId = [int]$process.ProcessId
    $cursor = $process
    $visited = New-Object System.Collections.Generic.HashSet[int]
    while ($cursor) {
      $cursorPid = [int]$cursor.ProcessId
      if (-not $visited.Add($cursorPid)) { break }
      if ($ancestorIds.Contains($cursorPid)) {
        [void]$ids.Add($processId)
        break
      }
      $parentId = [int]$cursor.ParentProcessId
      $cursor = if ($parentId -gt 0 -and $byId.ContainsKey($parentId)) { $byId[$parentId] } else { $null }
    }
  }
  return ,$ids
}
$excluded = ${excludeCurrentTree ? "CurrentOfficialCodexTreeIds" : "New-Object System.Collections.Generic.HashSet[int]"}
$targets = @($all | Where-Object {
  (IsOfficialCodex $_) -and
  ([int]$_.ProcessId -ne $currentPid) -and
  (-not $excluded.Contains([int]$_.ProcessId))
})
${close ? closeScriptBody() : "Write-Output $targets.Count"}
`;
}

function closeScriptBody() {
  return `$count = 0
foreach ($target in $targets) {
  try {
    Stop-Process -Id $target.ProcessId -Force -ErrorAction Stop
    $count += 1
  } catch {}
}
Start-Sleep -Milliseconds 500
$remaining = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
  (IsOfficialCodex $_) -and
  ([int]$_.ProcessId -ne $currentPid) -and
  (-not $excluded.Contains([int]$_.ProcessId))
})
if ($remaining.Count -gt 0) {
  throw "Official Codex processes are still running: $($remaining.Count)"
}
Write-Output $count`;
}

function currentOfficialCodexTreeIds(processes, currentPid) {
  const byId = new Map(processes.map((process) => [Number(process.processId), process]));
  const ancestorIds = new Set();
  const ancestorVisited = new Set();
  let cursor = byId.get(currentPid);
  while (cursor) {
    const cursorPid = Number(cursor.processId);
    if (ancestorVisited.has(cursorPid)) break;
    ancestorVisited.add(cursorPid);
    if (isOfficialCodexProcess(cursor)) ancestorIds.add(cursorPid);
    cursor = byId.get(Number(cursor.parentProcessId));
  }
  const ids = new Set();
  for (const process of processes) {
    let candidate = process;
    const visited = new Set();
    while (candidate) {
      const candidatePid = Number(candidate.processId);
      if (visited.has(candidatePid)) break;
      visited.add(candidatePid);
      if (ancestorIds.has(candidatePid)) {
        ids.add(Number(process.processId));
        break;
      }
      candidate = byId.get(Number(candidate.parentProcessId));
    }
  }
  return ids;
}

export function isOfficialCodexProcess(process) {
  const name = String(process?.name ?? "").toLowerCase();
  const executablePath = String(process?.executablePath ?? "").toLowerCase();
  return (
    (name === "chatgpt.exe" || name === "chatgpt" || name === "codex.exe" || name === "codex" || name === "codex-code-mode-host.exe") &&
    (
      executablePath.includes("\\openai.codex_") ||
      executablePath.includes("\\appdata\\local\\openai\\codex\\") ||
      executablePath.endsWith("\\.codex\\.sandbox-bin\\codex.exe") ||
      executablePath.endsWith("\\.codex\\plugins\\.plugin-appserver\\codex.exe")
    )
  );
}
