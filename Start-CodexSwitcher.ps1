$ErrorActionPreference = "Stop"

$installedRoot = "D:\Secure Codex Switcher Workspace\Program"
$packagedExe = Join-Path $installedRoot "Secure Codex Switcher.exe"
$shortcutIcon = Join-Path $installedRoot "resources\shortcut-icon-2.5.2.ico"
$userDataPath = "D:\Secure Codex Switcher Workspace\Data"
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

function Repair-Shortcuts {
  $shortcutDirectories = @(
    [Environment]::GetFolderPath("Desktop"),
    [Environment]::GetFolderPath("Programs")
  )
  $shell = New-Object -ComObject WScript.Shell

  foreach ($shortcutDirectory in $shortcutDirectories) {
    $shortcutPath = Join-Path $shortcutDirectory "Codex Switcher.lnk"
    $retiredShortcut = Join-Path $shortcutDirectory "Secure Codex Switcher.lnk"
    $shortcut = $shell.CreateShortcut($shortcutPath)
    $shortcut.TargetPath = $packagedExe
    $shortcut.WorkingDirectory = $installedRoot
    $shortcut.IconLocation = "$shortcutIcon,0"
    $shortcut.Arguments = "--user-data-dir=`"$userDataPath`""
    $shortcut.Save()
    if (Test-Path -LiteralPath $retiredShortcut) {
      Remove-Item -LiteralPath $retiredShortcut -Force
    }
  }
  Start-Process -FilePath "$env:SystemRoot\System32\ie4uinit.exe" -ArgumentList "-show" -WindowStyle Hidden -ErrorAction SilentlyContinue
}

function Start-DetachedSwitcher {
  $commandLine = "`"$packagedExe`" --user-data-dir=`"$userDataPath`""
  $startup = ([wmiclass]"Win32_ProcessStartup").CreateInstance()
  $startup.EnvironmentVariables = [string[]]@(
    [Environment]::GetEnvironmentVariables().GetEnumerator() |
      ForEach-Object { "$($_.Key)=$($_.Value)" }
  )
  $result = ([wmiclass]"Win32_Process").Create($commandLine, $installedRoot, $startup)
  if ([int]$result.ReturnValue -ne 0) {
    throw "WMI process creation failed with code $($result.ReturnValue)."
  }
}

if (-not (Test-Path -LiteralPath $packagedExe)) {
  Show-LaunchError "Cannot find the installed application:`n$packagedExe`n`nInstall the latest Secure Codex Switcher release first. Development builds are available only through Start-CodexSwitcher-Dev.ps1."
  exit 1
}

Import-WindowsProxy
try {
  Repair-Shortcuts
} catch {
  Add-Content -Path $logPath -Value "$(Get-Date -Format o) Shortcut repair failed: $($_.Exception.Message)"
  Show-LaunchError "Error repairing Codex Switcher shortcuts:`n$($_.Exception.Message)`n`nThe application was not started.`n`nLog: $logPath"
  exit 1
}

try {
  Start-DetachedSwitcher
} catch {
  Add-Content -Path $logPath -Value "$(Get-Date -Format o) $($_.Exception.Message)"
  Show-LaunchError "Error launching Codex Switcher:`n$($_.Exception.Message)`n`nLog: $logPath"
  exit 1
}
