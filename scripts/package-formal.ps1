param(
  [string]$SourceRoot = (Split-Path -Parent $PSScriptRoot),
  [switch]$DirectoryOnly,
  [switch]$SkipBuild
)

$ErrorActionPreference = "Stop"
$expectedBranch = "codex/complete-branch-integration"
$requiredAncestors = @(
  "0c0326dbd8d6843a54ff11ab91a1ef4dd961d5de",
  "c25ed946b35acaaca10ebcae515f77c326eed7cc",
  "300cfe7ff202aaecc9237bacb49e634766a66c33"
)
$requiredMarkers = @(
  @{ path = "src\services\account-service.js"; value = "autoSwitchStayAccountId" },
  @{ path = "src\services\account-service.js"; value = "ignoredStaleTaskCount" },
  @{ path = "src\services\account-service.js"; value = "manual-switch-inspection" },
  @{ path = "src\services\account-service.js"; value = "switchAccountPrioritized" },
  @{ path = "src\renderer\app.js"; value = "orderReportAccounts" },
  @{ path = "src\renderer\index.html"; value = "quota-auto-switch-action" }
)

function Invoke-GitText([string[]]$Arguments) {
  $output = & git -C $SourceRoot @Arguments 2>&1
  if ($LASTEXITCODE -ne 0) {
    throw "Git command failed: git $($Arguments -join ' ')`n$($output -join "`n")"
  }
  return ($output -join "`n").Trim()
}

$branch = Invoke-GitText @("branch", "--show-current")
if ($branch -ne $expectedBranch) {
  throw "Formal packaging requires branch '$expectedBranch'; current branch is '$branch'."
}

$dirty = Invoke-GitText @("status", "--porcelain", "--untracked-files=all")
if ($dirty) {
  throw "Formal packaging requires a clean tracked worktree.`n$dirty"
}

$versionPolicyVerifier = Join-Path $PSScriptRoot "verify-version-bump.ps1"
if (-not (Test-Path -LiteralPath $versionPolicyVerifier)) {
  throw "Formal packaging version policy verifier is missing: $versionPolicyVerifier"
}
& $versionPolicyVerifier -SourceRoot $SourceRoot
if ($LASTEXITCODE -ne 0) {
  throw "Formal packaging version policy failed with exit code $LASTEXITCODE."
}

foreach ($ancestor in $requiredAncestors) {
  & git -C $SourceRoot merge-base --is-ancestor $ancestor HEAD
  if ($LASTEXITCODE -ne 0) {
    throw "Formal packaging requires ancestor $ancestor."
  }
}

foreach ($marker in $requiredMarkers) {
  $filePath = Join-Path $SourceRoot $marker.path
  if (-not (Test-Path -LiteralPath $filePath) -or
      -not (Get-Content -Raw -LiteralPath $filePath).Contains($marker.value)) {
    throw "Formal packaging marker '$($marker.value)' is missing from '$($marker.path)'."
  }
}

$commit = Invoke-GitText @("rev-parse", "HEAD")
$provenancePath = Join-Path $SourceRoot "src\build-provenance.json"
if (Test-Path -LiteralPath $provenancePath) {
  throw "Refusing to overwrite existing temporary provenance file: $provenancePath"
}

$provenance = [ordered]@{
  schemaVersion = 1
  branch = $branch
  commit = $commit
  builtAtUtc = [DateTime]::UtcNow.ToString("o")
} | ConvertTo-Json

try {
  [IO.File]::WriteAllText($provenancePath, $provenance, [Text.UTF8Encoding]::new($false))
  if (-not $SkipBuild) {
    $builder = Join-Path $SourceRoot "node_modules\.bin\electron-builder.cmd"
    if (-not (Test-Path -LiteralPath $builder)) {
      throw "electron-builder is not installed at $builder"
    }
    $arguments = if ($DirectoryOnly) { @("--win", "--x64", "--dir") } else { @("--win", "nsis", "--x64") }
    & $builder @arguments
    if ($LASTEXITCODE -ne 0) {
      throw "electron-builder failed with exit code $LASTEXITCODE."
    }
  }
} finally {
  if (Test-Path -LiteralPath $provenancePath) {
    Remove-Item -LiteralPath $provenancePath -Force
  }
}
