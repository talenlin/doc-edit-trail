# Stop everything start-trail.ps1 started.
param([switch]$Quiet)
$ErrorActionPreference = 'SilentlyContinue'
$root = Split-Path -Parent $PSScriptRoot
$logDir = Join-Path $root 'logs'
$pidFile = Join-Path $logDir 'service-pids.json'

if (-not (Test-Path $pidFile)) {
  if (-not $Quiet) { Write-Host '[stop] nothing to stop (no pid file)' }
  return
}

$info = Get-Content $pidFile -Encoding UTF8 | ConvertFrom-Json
foreach ($e in $info.entries) {
  $p = Get-Process -Id $e.pid -ErrorAction SilentlyContinue
  if ($p) {
    Stop-Process -Id $e.pid -Force -ErrorAction SilentlyContinue
    if (-not $Quiet) { Write-Host "[stop] $($e.role) pid=$($e.pid) killed" }
  } elseif (-not $Quiet) {
    Write-Host "[stop] $($e.role) pid=$($e.pid) already gone"
  }
}
Remove-Item $pidFile -Force
if (-not $Quiet) { Write-Host '[stop] done' }
