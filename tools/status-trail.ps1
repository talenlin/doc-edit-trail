# Show whether the watchers are alive, what they last saw, and the journal footprint.
$ErrorActionPreference = 'SilentlyContinue'
$root = Split-Path -Parent $PSScriptRoot
$logDir = Join-Path $root 'logs'
$pidFile = Join-Path $logDir 'service-pids.json'

if (-not (Test-Path $pidFile)) {
  Write-Host '[status] NOT RUNNING (no pid file) - start with tools\start-trail.ps1'
  return
}

$info = Get-Content $pidFile -Raw -Encoding UTF8 | ConvertFrom-Json
$localStart = ([datetime]$info.startedAt).ToLocalTime().ToString('yyyy-MM-dd HH:mm:ss')
Write-Host "[status] started $localStart  actor=$($info.actor)  port=$($info.port)"
foreach ($e in $info.entries) {
  $p = Get-Process -Id $e.pid -ErrorAction SilentlyContinue
  $state = if ($p) { 'RUNNING' } else { 'DEAD   ' }
  Write-Host ("  {0} pid={1,-7} {2} {3}" -f $state, $e.pid, $e.role, $e.arg)
}

Write-Host ''
Write-Host '[journals]'
$dirs = @()
if ($info.entries) { $dirs = @($info.entries | Where-Object { $_.role -eq 'watch' } | ForEach-Object { $_.arg }) }
foreach ($d in $dirs) {
  if (-not (Test-Path $d)) { continue }
  $j = @(Get-ChildItem -Path $d -Recurse -Directory -Filter '*.edittrail' -ErrorAction SilentlyContinue)
  $files = @(Get-ChildItem -Path $d -Recurse -File -Include *.xlsx,*.docx,*.pptx -ErrorAction SilentlyContinue)
  Write-Host ("  {0}  tracked={1}/{2}" -f $d, $j.Count, $files.Count)
  foreach ($x in ($j | Select-Object -First 6)) {
    $jf = Join-Path $x.FullName 'journal.jsonl'
    if (Test-Path $jf) {
      $n = @(Get-Content $jf -Encoding UTF8).Count
      $last = Get-Content $jf -Encoding UTF8 -Tail 1 | ConvertFrom-Json
      Write-Host ("    - {0}  records={1}  last: seq {2} {3}" -f $x.Name, $n, $last.seq, $last.summary)
    }
  }
}

Write-Host ''
Write-Host '[tail watch log]'
$logs = @(Get-ChildItem -Path $logDir -Filter 'watch-*.out.log' | Sort-Object LastWriteTime -Descending)
if ($logs.Count -gt 0) { Get-Content $logs[0].FullName -Encoding UTF8 -Tail 5 }
