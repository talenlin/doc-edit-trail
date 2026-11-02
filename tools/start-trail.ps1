# EditTrail service launcher.
# Starts (1) the add-in static/event server and (2) one watcher per directory.
# Writes logs\service-pids.json for stop-trail.ps1 / status-trail.ps1.
# Kept ASCII-only on purpose: PowerShell 5.1 mis-decodes non-BOM UTF-8 files.
param(
  [string[]]$Dirs,
  [int]$Port = 39871,
  [string]$Actor = 'wps-user',
  [string]$Node = 'C:\Program Files\nodejs\node.exe',
  [switch]$NoAddin
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$logDir = Join-Path $root 'logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$pidFile = Join-Path $logDir 'service-pids.json'

if (-not $Dirs -or $Dirs.Count -eq 0) {
  $cfg = Join-Path $PSScriptRoot 'watch-dirs.txt'
  if (-not (Test-Path $cfg)) { throw "no -Dirs and no $cfg" }
  $Dirs = @(
    Get-Content $cfg -Encoding UTF8 |
      ForEach-Object { $_.Trim() } |
      Where-Object { $_ -and -not $_.StartsWith('#') }
  )
}

# stop a previous run first (idempotent)
$stopScript = Join-Path $PSScriptRoot 'stop-trail.ps1'
if (Test-Path $pidFile) { & $stopScript -Quiet }

if (-not (Test-Path $Node)) {
  $Node = (Get-Command node -ErrorAction Stop).Source
}

$entries = @()

if (-not $NoAddin) {
  $serve = Join-Path $root 'addin-wps\tools\serve.js'
  $p = Start-Process -FilePath $Node `
    -ArgumentList @($serve, "$Port") `
    -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput (Join-Path $logDir 'serve.out.log') `
    -RedirectStandardError  (Join-Path $logDir 'serve.err.log')
  $entries += [pscustomobject]@{ role = 'serve'; pid = $p.Id; arg = "port=$Port" }
  Write-Host "[start] serve  pid=$($p.Id) http://127.0.0.1:$Port/"
}

$cli = Join-Path $root 'src\cli\edittrail.mjs'
foreach ($d in $Dirs) {
  if (-not (Test-Path $d)) { Write-Warning "[skip] not found: $d"; continue }
  $slug = ($d -replace '[^A-Za-z0-9]+', '_').Trim('_')
  if ($slug.Length -gt 60) { $slug = $slug.Substring($slug.Length - 60) }
  $p = Start-Process -FilePath $Node `
    -ArgumentList @($cli, 'watch', "$d", '--actor', $Actor) `
    -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput (Join-Path $logDir "watch-$slug.out.log") `
    -RedirectStandardError  (Join-Path $logDir "watch-$slug.err.log")
  $entries += [pscustomobject]@{ role = 'watch'; pid = $p.Id; arg = $d }
  Write-Host "[start] watch  pid=$($p.Id) dir=$d"
}

[pscustomobject]@{
  startedAt = (Get-Date).ToString('o')
  actor     = $Actor
  port      = $Port
  entries   = $entries
} | ConvertTo-Json -Depth 5 | Set-Content -Path $pidFile -Encoding UTF8

Write-Host "[ok] pid file: $pidFile"
Write-Host "[ok] stop with: powershell -NoProfile -ExecutionPolicy Bypass -File `"$stopScript`""
