param(
  [string]$InstallRoot,
  [Alias("user-data-dir")][string]$UserDataPath
)

$ErrorActionPreference = "Stop"
$logPath = Join-Path $env:TEMP "codex-switcher-launch.log"

function Get-InstalledSwitcherCandidates {
  $shell = New-Object -ComObject WScript.Shell
  foreach ($directory in @([Environment]::GetFolderPath("Desktop"), [Environment]::GetFolderPath("Programs"))) {
    foreach ($name in @("Codex Switcher.lnk", "Secure Codex Switcher.lnk")) {
      $shortcutPath = Join-Path $directory $name
      if (-not (Test-Path -LiteralPath $shortcutPath)) { continue }
      $shortcut = $shell.CreateShortcut($shortcutPath)
      if ([IO.Path]::GetFileName($shortcut.TargetPath) -ne "Secure Codex Switcher.exe") { continue }
      $match = [regex]::Match($shortcut.Arguments, '(?:^|\s)--user-data-dir=(?:"(?<quoted>[^"]+)"|(?<bare>\S+))')
      $dataPath = if ($match.Groups['quoted'].Success) { $match.Groups['quoted'].Value } else { $match.Groups['bare'].Value }
      [pscustomobject]@{ Root = Split-Path -Parent $shortcut.TargetPath; DataPath = $dataPath }
    }
  }
  foreach ($registryRoot in @(
    "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall",
    "HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall",
    "HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall"
  )) {
    Get-ChildItem -LiteralPath $registryRoot -ErrorAction SilentlyContinue | ForEach-Object {
      $entry = Get-ItemProperty -LiteralPath $_.PSPath -ErrorAction SilentlyContinue
      if ($entry.DisplayName -ne "Secure Codex Switcher") { return }
      $root = $entry.InstallLocation
      if (-not $root) {
        $match = [regex]::Match([string]$entry.UninstallString, '^\s*"(?<path>[^"]+\\Uninstall Secure Codex Switcher\.exe)"')
        if ($match.Success) { $root = Split-Path -Parent $match.Groups['path'].Value }
      }
      if ($root) { [pscustomobject]@{ Root = $root; DataPath = $null } }
    }
  }
}

function Resolve-SwitcherLaunchPaths($InstallRoot, $UserDataPath, $ScriptRoot, $AppData, $LocalAppData, $Candidates) {
  if ($InstallRoot) {
    $root = $InstallRoot
  } elseif (Test-Path -LiteralPath (Join-Path $ScriptRoot "Secure Codex Switcher.exe") -PathType Leaf) {
    $root = $ScriptRoot
  } else {
    $possibleRoots = @($Candidates | ForEach-Object { $_.Root })
    if ($LocalAppData) { $possibleRoots += Join-Path $LocalAppData "Programs\Secure Codex Switcher" }
    $roots = @($possibleRoots | Where-Object {
      $_ -and (Test-Path -LiteralPath (Join-Path $_ "Secure Codex Switcher.exe") -PathType Leaf)
    } | ForEach-Object { [IO.Path]::GetFullPath($_).TrimEnd('\') } | Sort-Object -Unique)
    if ($roots.Count -ne 1) { throw "Cannot uniquely find the installed application. Specify -InstallRoot explicitly." }
    $root = $roots[0]
  }
  if ($root -notmatch '^(?:[A-Za-z]:\\|\\\\[^\\]+\\[^\\]+)') { throw "-InstallRoot requires an absolute path." }
  $root = [IO.Path]::GetFullPath($root).TrimEnd('\')
  $exe = Join-Path $root "Secure Codex Switcher.exe"
  if (-not (Test-Path -LiteralPath $exe -PathType Leaf)) { throw "Cannot find the installed application: $exe" }
  if (-not $UserDataPath) {
    $savedPaths = @($Candidates | Where-Object { $_.Root -and [IO.Path]::GetFullPath($_.Root).TrimEnd('\') -eq $root -and $_.DataPath } |
      ForEach-Object { $_.DataPath } | Sort-Object -Unique)
    if ($savedPaths.Count -gt 1) { throw "Conflicting shortcut data directories. Specify -UserDataPath explicitly." }
    if ($savedPaths.Count -eq 1) { $UserDataPath = $savedPaths[0] }
    elseif ($AppData) { $UserDataPath = Join-Path $AppData "secure-codex-switcher-win" }
    else { throw "APPDATA is unavailable. Specify -UserDataPath explicitly." }
  }
  if ($UserDataPath -notmatch '^(?:[A-Za-z]:\\|\\\\[^\\]+\\[^\\]+)' -or $UserDataPath.Contains('"')) {
    throw "-UserDataPath requires an absolute path without embedded quotes."
  }
  [pscustomobject]@{ InstallRoot = $root; UserDataPath = [IO.Path]::GetFullPath($UserDataPath); Executable = $exe }
}

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

try {
  $paths = Resolve-SwitcherLaunchPaths $InstallRoot $UserDataPath $PSScriptRoot $env:APPDATA $env:LOCALAPPDATA @(Get-InstalledSwitcherCandidates)
  $installedRoot = $paths.InstallRoot
  $userDataPath = $paths.UserDataPath
  $packagedExe = $paths.Executable
  $shortcutIcon = Join-Path $installedRoot "resources\shortcut-icon-2.5.2.ico"
} catch {
  Show-LaunchError "$($_.Exception.Message)`n`nInstall the latest release or specify -InstallRoot and -UserDataPath. Development builds are available only through Start-CodexSwitcher-Dev.ps1."
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
