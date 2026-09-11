param(
  [string]$SourceRoot = (Split-Path -Parent $PSScriptRoot),
  [string]$BaselineCommit = "d7b947cdae7ae245bf2482b02b98cd14b07448dc"
)

$ErrorActionPreference = "Stop"
$productPaths = @(
  "package.json",
  "package-lock.json",
  "src",
  "build",
  "scripts",
  "Start-CodexSwitcher.ps1"
)

function Invoke-GitText([string[]]$Arguments) {
  $output = & git -C $SourceRoot @Arguments 2>&1
  if ($LASTEXITCODE -ne 0) {
    throw "Git command failed: git $($Arguments -join ' ')`n$($output -join "`n")"
  }
  return ($output -join "`n").Trim()
}

function Get-PackageVersion([string]$Commit) {
  $packageJson = Invoke-GitText @("show", "$Commit`:package.json")
  $package = $packageJson | ConvertFrom-Json
  $version = [string]$package.version
  if ($version -notmatch '^(\d+)\.(\d+)\.(\d+)$') {
    throw "Version policy requires a numeric semantic version at $Commit; found '$version'."
  }

  $packageLockJson = Invoke-GitText @("show", "$Commit`:package-lock.json")
  $packageLock = $packageLockJson | ConvertFrom-Json -AsHashtable
  $lockVersion = [string]$packageLock["version"]
  $lockPackageVersion = [string]$packageLock["packages"][""]["version"]
  if ($lockVersion -ne $version -or $lockPackageVersion -ne $version) {
    throw "Version policy requires package.json, package-lock.json, and package-lock root package versions to match at $Commit; found '$version', '$lockVersion', and '$lockPackageVersion'."
  }
  return [pscustomobject]@{
    Text = $version
    Major = [uint64]$Matches[1]
    Minor = [uint64]$Matches[2]
    Patch = [uint64]$Matches[3]
  }
}

function Test-VersionGreater($Current, $Previous) {
  if ($Current.Major -ne $Previous.Major) { return $Current.Major -gt $Previous.Major }
  if ($Current.Minor -ne $Previous.Minor) { return $Current.Minor -gt $Previous.Minor }
  return $Current.Patch -gt $Previous.Patch
}

& git -C $SourceRoot cat-file -e "$BaselineCommit`^{commit}" 2>$null
if ($LASTEXITCODE -ne 0) {
  throw "Version policy baseline commit '$BaselineCommit' does not exist."
}

& git -C $SourceRoot merge-base --is-ancestor $BaselineCommit HEAD
if ($LASTEXITCODE -ne 0) {
  throw "Version policy baseline '$BaselineCommit' is not an ancestor of HEAD."
}

$commitsText = Invoke-GitText @("rev-list", "--reverse", "--first-parent", "$BaselineCommit..HEAD")
$commits = @($commitsText -split "`r?`n" | Where-Object { $_ })
$checked = 0

foreach ($commit in $commits) {
  $parent = Invoke-GitText @("rev-parse", "$commit^")
  $changedText = Invoke-GitText (@("diff", "--name-only", $parent, $commit, "--") + $productPaths)
  if (-not $changedText) {
    continue
  }

  $checked += 1
  $previousVersion = Get-PackageVersion $parent
  $currentVersion = Get-PackageVersion $commit
  if ($currentVersion.Patch -gt 10) {
    throw "Version policy requires the patch component to stay at or below 10; found '$($currentVersion.Text)' at $commit. Increment the minor version and reset patch to 0."
  }
  if (-not (Test-VersionGreater $currentVersion $previousVersion)) {
    $shortCommit = Invoke-GitText @("rev-parse", "--short", $commit)
    throw "Version policy violation at $shortCommit`: product-impacting files changed, but version '$($currentVersion.Text)' is not greater than parent version '$($previousVersion.Text)'."
  }
}

Write-Output "Version policy passed for $checked product-impacting commit(s) after baseline $BaselineCommit."
