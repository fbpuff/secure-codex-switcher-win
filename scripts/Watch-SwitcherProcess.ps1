param(
  [Parameter(Mandatory = $true)][int]$ParentProcessId,
  [Parameter(Mandatory = $true)][string]$Nonce,
  [Parameter(Mandatory = $true)][string]$ExecutablePath,
  [Parameter(Mandatory = $true)][string]$UserDataPath,
  [Parameter(Mandatory = $true)][string]$IntentMarkerPath
)

$ErrorActionPreference = "SilentlyContinue"
$recoveryLogPath = Join-Path $UserDataPath "watchdog-recovery.jsonl"
$parentExitCode = $null
function Write-RecoveryEvent([string]$Event, [string]$Reason = "") {
  try {
    $record = [ordered]@{ timestamp = [DateTimeOffset]::UtcNow.ToOffset([TimeSpan]::FromHours(8)).ToString("o"); event = $Event; reason = $Reason; parentProcessId = $ParentProcessId }
    if ($null -ne $parentExitCode) { $record.exitCode = $parentExitCode }
    Add-Content -LiteralPath $recoveryLogPath -Value ($record | ConvertTo-Json -Compress) -Encoding UTF8
  } catch {}
}
Write-RecoveryEvent "watchdog_started"
$watchedParent = Get-Process -Id $ParentProcessId -ErrorAction SilentlyContinue
try { if ($watchedParent) { $null = $watchedParent.Handle } } catch {}
while ($watchedParent -and -not $watchedParent.HasExited) {
  Start-Sleep -Milliseconds 500
}
try { if ($watchedParent) { $parentExitCode = $watchedParent.ExitCode; $watchedParent.Dispose() } } catch {}
Write-RecoveryEvent "parent_exited" $(if ($null -eq $parentExitCode) { "exit_code_unavailable" } else { "exit_observed" })
Start-Sleep -Milliseconds 750

$intentional = $false
if (Test-Path -LiteralPath $IntentMarkerPath) {
  try {
    $marker = Get-Content -LiteralPath $IntentMarkerPath -Raw | ConvertFrom-Json
    $intentional = [string]::Equals([string]$marker.nonce, $Nonce, [StringComparison]::Ordinal)
    if ($intentional) { Remove-Item -LiteralPath $IntentMarkerPath -Force; Write-RecoveryEvent "intentional_exit" }
  } catch {}
}
if ($intentional) { exit 0 }

$recentRecoveryCutoff = [DateTime]::UtcNow.AddMinutes(-5)
$recentRecoveryCount = @(
  Get-Content -LiteralPath $recoveryLogPath -Tail 40 -ErrorAction SilentlyContinue |
    ForEach-Object { try { $_ | ConvertFrom-Json } catch { $null } } |
    Where-Object {
      $_ -and $_.event -eq "recovery_launched" -and
      ([DateTime]$_.timestamp).ToUniversalTime() -ge $recentRecoveryCutoff
    }
).Count
if ($recentRecoveryCount -ge 3) { Write-RecoveryEvent "recovery_skipped" "recovery_backoff"; exit 0 }

if (-not (Test-Path -LiteralPath $ExecutablePath)) { Write-RecoveryEvent "recovery_skipped" "executable_missing"; exit 0 }

$resolvedExecutable = [IO.Path]::GetFullPath($ExecutablePath)
$alreadyRunning = Get-CimInstance Win32_Process -Filter "Name = 'Secure Codex Switcher.exe'" |
  Where-Object {
    $_.ExecutablePath -and
    $_.CommandLine -and $_.CommandLine -notmatch '(?:^|\s)--type=' -and
    [string]::Equals([IO.Path]::GetFullPath($_.ExecutablePath), $resolvedExecutable, [StringComparison]::OrdinalIgnoreCase)
  } |
  Select-Object -First 1
if ($alreadyRunning) { Write-RecoveryEvent "recovery_skipped" "already_running"; exit 0 }

try {
$recoveredProcess = Start-Process -FilePath $resolvedExecutable `
  -ArgumentList "--user-data-dir=`"$UserDataPath`"" `
  -WorkingDirectory (Split-Path -Parent $resolvedExecutable) `
  -WindowStyle Hidden -PassThru -ErrorAction Stop
if (-not $recoveredProcess) { throw 'No recovered process' }
Write-RecoveryEvent "recovery_launched"
} catch {
  Write-RecoveryEvent "recovery_failed" "launch_failed"
  exit 1
}
