$ErrorActionPreference = "Stop"

$workspaceRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$appRoot = Join-Path $workspaceRoot "secure-codex-switcher-win"
$electronExe = Join-Path $appRoot "node_modules\electron\dist\electron.exe"
$logPath = Join-Path $env:TEMP "codex-switcher-launch.log"

function Show-LaunchError($message) {
  try {
    $shell = New-Object -ComObject WScript.Shell
    $null = $shell.Popup($message, 0, "Codex Switcher", 16)
  } catch {
    Add-Content -Path $logPath -Value $message
  }
}

function Import-WindowsProxy {
  try {
    $internetSettings = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings"
    $proxyEnabled = (Get-ItemProperty -Path $internetSettings -Name ProxyEnable -ErrorAction Stop).ProxyEnable
    $proxyServer = (Get-ItemProperty -Path $internetSettings -Name ProxyServer -ErrorAction Stop).ProxyServer
    if ($proxyEnabled -eq 1 -and $proxyServer) {
      $firstProxy = ($proxyServer -split ";")[0]
      if ($firstProxy -match "=") {
        $firstProxy = ($firstProxy -split "=", 2)[1]
      }
      if ($firstProxy -notmatch "^https?://") {
        $firstProxy = "http://$firstProxy"
      }
      if (-not $env:HTTPS_PROXY) {
        $env:HTTPS_PROXY = $firstProxy
      }
      if (-not $env:HTTP_PROXY) {
        $env:HTTP_PROXY = $firstProxy
      }
    }
  } catch {}
}

try {
  if (-not (Test-Path -LiteralPath $appRoot)) {
    Show-LaunchError "Cannot find Codex Switcher app folder:`n$appRoot"
    exit 1
  }

  if (-not (Test-Path -LiteralPath $electronExe)) {
    Show-LaunchError "Cannot find Electron runtime:`n$electronExe`n`nPlease run npm install in the app folder."
    exit 1
  }

  Import-WindowsProxy
  Start-Process -FilePath $electronExe -ArgumentList "`"$appRoot`"" -WorkingDirectory $appRoot
} catch {
  Add-Content -Path $logPath -Value "$(Get-Date -Format o) $($_.Exception.Message)"
  Show-LaunchError "Error launching Codex Switcher:`n$($_.Exception.Message)`n`nLog: $logPath"
  exit 1
}
