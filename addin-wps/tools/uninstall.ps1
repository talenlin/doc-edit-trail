# Undo what install.ps1 did.
#
# Rules:
#   - if jsaddons did not exist before install -> the whole directory is ours, delete it
#   - if it did exist -> remove only our publish.xml entries (or restore the backup)
$ErrorActionPreference = 'Stop'
$RepoRoot   = Split-Path -Parent $PSScriptRoot
$JsAddons   = Join-Path $env:APPDATA 'kingsoft\wps\jsaddons'
$PublishXml = Join-Path $JsAddons 'publish.xml'
$StateDir   = Join-Path $RepoRoot 'logs'
$StateFile  = Join-Path $StateDir 'orig-state.txt'
$Bak        = Join-Path $StateDir 'publish.xml.bak'

if (-not (Test-Path $StateFile)) {
    Write-Host '[warn] orig-state.txt not found; treating jsaddons as pre-existing-empty'
    $origExisted = $false
    $origXml = $false
} else {
    $lines = Get-Content $StateFile
    $origExisted = [bool]($lines | Where-Object { $_ -eq 'jsaddons_existed=True' })
    $origXml = [bool]($lines | Where-Object { $_ -eq 'publish_xml_existed=True' })
}
Write-Host "[state] jsaddons_existed(original)=$origExisted  publish_xml_existed(original)=$origXml"

if (-not $origExisted) {
    if (Test-Path $JsAddons) {
        Remove-Item $JsAddons -Recurse -Force
        Write-Host "[remove] $JsAddons (did not exist before install)"
    }
} else {
    if ($origXml -and (Test-Path $Bak)) {
        Copy-Item $Bak $PublishXml -Force
        Write-Host '[restore] publish.xml <- logs\publish.xml.bak'
    } elseif (Test-Path $PublishXml) {
        # keep foreign entries, drop ours
        try {
            [xml]$doc = Get-Content $PublishXml -Raw
            $kept = @($doc.jsplugins.jspluginonline | Where-Object { $_.name -ne 'EditTrail' })
            if ($kept.Count -eq 0) {
                Remove-Item $PublishXml -Force
                Write-Host "[remove] $PublishXml (no foreign entries left)"
            } else {
                $out = New-Object System.Text.StringBuilder
                [void]$out.AppendLine('<jsplugins>')
                foreach ($e in $kept) {
                    [void]$out.AppendLine('  <jspluginonline name="' + $e.name + '" type="' + $e.type + '" url="' + $e.url + '" debug="" enable="enable_dev" install="null" customDomain=""/>')
                }
                [void]$out.AppendLine('</jsplugins>')
                [System.IO.File]::WriteAllText($PublishXml, $out.ToString(), (New-Object System.Text.UTF8Encoding($false)))
                Write-Host "[edit] removed EditTrail entries, kept $($kept.Count) foreign entry(s)"
            }
        } catch {
            Remove-Item $PublishXml -Force
            Write-Host "[remove] $PublishXml (parse failed, removed)"
        }
    }
    $payload = Join-Path $JsAddons 'EditTrail_0.2.0'
    if (Test-Path $payload) { Remove-Item $payload -Recurse -Force; Write-Host "[remove] $payload" }
}

Write-Host "[verify] jsaddons exists = $(Test-Path $JsAddons)"
Write-Host "[verify] publish.xml exists = $(Test-Path $PublishXml)"
if (Test-Path $JsAddons) {
    Write-Host "[verify] jsaddons contents = $(((Get-ChildItem $JsAddons -Force | ForEach-Object { $_.Name }) -join ';'))"
}
