$ErrorActionPreference = "Stop"

$workspaceRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$appRoot = Join-Path $workspaceRoot "secure-codex-switcher-win"
$launcherPath = Join-Path $workspaceRoot "Start-CodexSwitcher.ps1"
$desktopShortcut = Join-Path ([Environment]::GetFolderPath("Desktop")) "Codex Switcher.lnk"
$electronExe = Join-Path $appRoot "node_modules\electron\dist\electron.exe"

function Assert-Command($name) {
  if (-not (Get-Command $name -ErrorAction SilentlyContinue)) {
    throw "Required command '$name' was not found. Please install Node.js LTS first, then run this script again."
  }
}

if (-not (Test-Path -LiteralPath $appRoot)) {
  throw "Cannot find app folder: $appRoot"
}

if (-not (Test-Path -LiteralPath $launcherPath)) {
  throw "Cannot find launcher: $launcherPath"
}

Assert-Command "node"
Assert-Command "npm"

Push-Location $appRoot
try {
  npm install
  npm test
} finally {
  Pop-Location
}

if (-not (Test-Path -LiteralPath $electronExe)) {
  throw "Electron runtime was not installed at: $electronExe"
}

$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($desktopShortcut)
$shortcut.TargetPath = "powershell.exe"
$shortcut.Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$launcherPath`""
$shortcut.WorkingDirectory = $workspaceRoot
$shortcut.IconLocation = $electronExe
$shortcut.Description = "Secure Codex Switcher"
$shortcut.Save()

Write-Host "Codex Switcher installed."
Write-Host "Desktop shortcut: $desktopShortcut"
Write-Host "Launch script: $launcherPath"
