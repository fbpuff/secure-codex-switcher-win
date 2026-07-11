$ErrorActionPreference = "Stop"

$appRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$packagedExe = Join-Path $appRoot "dist\win-unpacked\Secure Codex Switcher.exe"
$shortcutIcon = Join-Path $appRoot "dist\win-unpacked\resources\shortcut-icon-2.5.2.ico"
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

function Update-DesktopShortcut {
  if (-not (Test-Path -LiteralPath $shortcutIcon)) {
    return
  }
  $desktop = [Environment]::GetFolderPath("Desktop")
  $shortcutPath = Join-Path $desktop "Codex Switcher.lnk"
  $retiredShortcut = Join-Path $desktop "Secure Codex Switcher.lnk"
  $shell = New-Object -ComObject WScript.Shell
  $shortcut = $shell.CreateShortcut($shortcutPath)
  $shortcut.TargetPath = $packagedExe
  $shortcut.WorkingDirectory = Split-Path -Parent $packagedExe
  $shortcut.IconLocation = "$shortcutIcon,0"
  $shortcut.Arguments = ""
  $shortcut.Save()
  if (Test-Path -LiteralPath $retiredShortcut) {
    Remove-Item -LiteralPath $retiredShortcut -Force
  }
  Start-Process -FilePath "$env:SystemRoot\System32\ie4uinit.exe" -ArgumentList "-show" -WindowStyle Hidden -ErrorAction SilentlyContinue
}

try {
  if (-not (Test-Path -LiteralPath $packagedExe)) {
    Show-LaunchError "Cannot find the packaged application:`n$packagedExe`n`nRun npm run package:dir in the project folder."
    exit 1
  }

  Import-WindowsProxy
  Update-DesktopShortcut
  Start-Process -FilePath $packagedExe -WorkingDirectory (Split-Path -Parent $packagedExe)
} catch {
  Add-Content -Path $logPath -Value "$(Get-Date -Format o) $($_.Exception.Message)"
  Show-LaunchError "Error launching Codex Switcher:`n$($_.Exception.Message)`n`nLog: $logPath"
  exit 1
}
