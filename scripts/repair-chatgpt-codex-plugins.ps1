[CmdletBinding()]
param(
  [string]$CodexHome = (Join-Path $HOME ".codex")
)

$ErrorActionPreference = "Stop"
$timestamp = Get-Date -Format "yyyyMMddHHmmss"
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)

function Backup-PluginFile([string]$Path) {
  $backupPath = "$Path.secure-codex-switcher-backup-$timestamp"
  Copy-Item -LiteralPath $Path -Destination $backupPath -Force
  return $backupPath
}

function Repair-NgsManifest {
  $manifestPath = Join-Path $CodexHome ".tmp\plugins\plugins\ngs-analysis\.codex-plugin\plugin.json"
  if (-not (Test-Path -LiteralPath $manifestPath)) {
    return [pscustomobject]@{ status = "not_found" }
  }

  try {
    $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
    $defaultPrompt = [string]$manifest.interface.defaultPrompt[0]
    if ($defaultPrompt.Length -le 128) {
      return [pscustomobject]@{ status = "already_repaired" }
    }

    $backupPath = Backup-PluginFile $manifestPath
    $manifest.interface.defaultPrompt = @("Guide a local NGS analysis: inspect inputs, choose a public pipeline, validate tools, run safely, and capture QC artifacts.")
    [System.IO.File]::WriteAllText($manifestPath, ($manifest | ConvertTo-Json -Depth 20), $utf8NoBom)
    return [pscustomobject]@{ status = "repaired"; backupPath = $backupPath }
  } catch {
    return [pscustomobject]@{ status = "error"; error = $_.Exception.Message }
  }
}

function Repair-SitesServer {
  $sitesRoot = Join-Path $CodexHome "plugins\cache\openai-bundled\sites"
  $version = Get-ChildItem -LiteralPath $sitesRoot -Directory -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1
  if (-not $version) {
    return [pscustomobject]@{ status = "not_found" }
  }

  $serverPath = Join-Path $version.FullName "mcp\server.mjs"
  if (-not (Test-Path -LiteralPath $serverPath)) {
    return [pscustomobject]@{ status = "not_found" }
  }

  try {
    $source = Get-Content -LiteralPath $serverPath -Raw
    if ($source.Contains('method === "resources/list"')) {
      return [pscustomobject]@{ status = "already_repaired" }
    }

    $marker = '  if (method === "ping") {'
    if (-not $source.Contains($marker)) {
      return [pscustomobject]@{ status = "unsupported" }
    }

    $backupPath = Backup-PluginFile $serverPath
    $resourceHandler = @'
  if (method === "resources/list") {
    sendResult(id, { resources: [] });
    return;
  }

'@
    [System.IO.File]::WriteAllText($serverPath, $source.Replace($marker, $resourceHandler + $marker), $utf8NoBom)
    return [pscustomobject]@{ status = "repaired"; backupPath = $backupPath }
  } catch {
    return [pscustomobject]@{ status = "error"; error = $_.Exception.Message }
  }
}

[pscustomobject]@{
  ngs = Repair-NgsManifest
  sites = Repair-SitesServer
} | ConvertTo-Json -Depth 4 -Compress
