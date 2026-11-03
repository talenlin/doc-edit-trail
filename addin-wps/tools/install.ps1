# Install the EditTrail add-in for all three WPS components.
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File addin-wps\tools\install.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File addin-wps\tools\install.ps1 -Port 39871
#
# What it does:
#   1) records the original state (jsaddons / publish.xml / backup) into logs\orig-state.txt
#   2) writes %APPDATA%\kingsoft\wps\jsaddons\publish.xml with three entries:
#        type="et"  -> http://127.0.0.1:<Port>/       (Spreadsheets)
#        type="wps" -> http://127.0.0.1:<Port>/wps/   (Writer)
#        type="wpp" -> http://127.0.0.1:<Port>/wpp/   (Presentation)
#   3) reads the file back and checks the local service answers /health
#
# WPS only loads add-ins over http(s): file:// and relative paths are ignored
# silently, so the local service must be running and stay running.
param([int]$Port = 39871)

$ErrorActionPreference = 'Stop'
$RepoRoot   = Split-Path -Parent $PSScriptRoot
$JsAddons   = Join-Path $env:APPDATA 'kingsoft\wps\jsaddons'
$PublishXml = Join-Path $JsAddons 'publish.xml'
$StateDir   = Join-Path $RepoRoot 'logs'
New-Item -ItemType Directory -Force -Path $StateDir | Out-Null
$StateFile  = Join-Path $StateDir 'orig-state.txt'
$Bak        = Join-Path $StateDir 'publish.xml.bak'

if (Test-Path $StateFile) {
    Write-Host '[state] orig-state.txt already exists; keeping the first record'
} else {
    $state = @()
    $state += "captured=$((Get-Date).ToString('o'))"
    $state += "jsaddons_existed=$(Test-Path $JsAddons)"
    if (Test-Path $JsAddons) {
        $state += 'jsaddons_contents=' + ((Get-ChildItem $JsAddons -Force | ForEach-Object { $_.Name }) -join ';')
    }
    $state += "publish_xml_existed=$(Test-Path $PublishXml)"
    if (Test-Path $PublishXml) {
        Copy-Item $PublishXml $Bak -Force
        $state += 'publish_xml_backup=logs\publish.xml.bak'
        $state += 'publish_xml_sha256=' + (Get-FileHash $PublishXml -Algorithm SHA256).Hash
    }
    Set-Content -Path $StateFile -Value $state -Encoding UTF8
    Write-Host "[state] $StateFile"
}

$base = "http://127.0.0.1:$Port"
$xml = @"
<jsplugins>
  <jspluginonline name="EditTrail" type="et" url="$base/" debug="" enable="enable_dev" install="null" customDomain=""/>
  <jspluginonline name="EditTrail" type="wps" url="$base/wps/" debug="" enable="enable_dev" install="null" customDomain=""/>
  <jspluginonline name="EditTrail" type="wpp" url="$base/wpp/" debug="" enable="enable_dev" install="null" customDomain=""/>
</jsplugins>
"@

New-Item -ItemType Directory -Force -Path $JsAddons | Out-Null
# no BOM: some parsers treat the BOM as content
[System.IO.File]::WriteAllText($PublishXml, $xml, (New-Object System.Text.UTF8Encoding($false)))

if (-not (Test-Path $PublishXml)) { throw "[FAIL] publish.xml was not written: $PublishXml" }
$readBack = Get-Content $PublishXml -Raw
foreach ($t in 'et', 'wps', 'wpp') {
    if ($readBack -notmatch ('type="' + $t + '"')) { throw "[FAIL] publish.xml missing type=$t" }
}
Write-Host "[write] OK $PublishXml ($((Get-Item $PublishXml).Length)B, 3 hosts)"

$health = 'down'
try {
    $r = Invoke-WebRequest -UseBasicParsing -Uri "$base/health" -TimeoutSec 3
    if ($r.StatusCode -eq 200) { $health = 'up' }
} catch {
    $health = 'down'
}
Write-Host "[service] $base/health = $health"
if ($health -ne 'up') {
    Write-Host '[warn] start the service first: node addin-wps\tools\serve.js ' + $Port
}

Write-Host ''
Write-Host 'Next steps:'
Write-Host '  1) keep the service running:  node addin-wps\tools\serve.js ' + $Port
Write-Host '  2) close WPS completely, then reopen it (add-ins are read at component start)'
Write-Host '  3) open an .xlsx / .docx / .pptx; each component shows an "EditTrail" tab'
Write-Host "  4) events land in logs\addin-events.jsonl and $(Join-Path $env:APPDATA 'kingsoft\wps\jsaddons')..\edit-trail\logs\addin.log"
