$ErrorActionPreference = "Stop"

$appRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$electronExe = Join-Path $appRoot "node_modules\electron\dist\electron.exe"

if (-not (Test-Path -LiteralPath $electronExe)) {
  throw "Cannot find Electron development runtime: $electronExe"
}

Start-Process -FilePath $electronExe -ArgumentList "`"$appRoot`"" -WorkingDirectory $appRoot
