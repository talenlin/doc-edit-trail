param(
  [Parameter(Mandatory = $true)][ValidateSet('docx', 'xlsx', 'pptx')][string]$Kind,
  [Parameter(Mandatory = $true)][string]$Src,
  [Parameter(Mandatory = $true)][string]$Dst
)

# convert-legacy.ps1 - save .doc/.xls/.ppt as OOXML via WPS COM.
# Usage: powershell -File convert-legacy.ps1 -Kind docx -Src <in> -Dst <out>
#
# Safety rules:
# - Never assume a fresh COM instance. Count open documents first.
#   If we attached to the user's instance (count > 0), only Open/SaveAs/Close;
#   never Quit it and never touch Visible.
# - Only an empty instance we created ourselves may be hidden and quit.
$ErrorActionPreference = 'Stop'

$progMap = @{ docx = 'KWPS.Application'; xlsx = 'KET.Application'; pptx = 'KWPP.Application' }
$prog = $progMap[$Kind]
if (-not (Test-Path -LiteralPath $Src)) { throw "source not found: $Src" }
$dstDir = Split-Path -Parent $Dst
if ($dstDir -and -not (Test-Path -LiteralPath $dstDir)) { New-Item -ItemType Directory -Path $dstDir -Force | Out-Null }

$app = $null
$doc = $null
$ownInstance = $false
try {
  $app = New-Object -ComObject $prog
  if ($Kind -eq 'docx') { $existing = $app.Documents.Count }
  elseif ($Kind -eq 'xlsx') { $existing = $app.Workbooks.Count }
  else { $existing = $app.Presentations.Count }

  $ownInstance = ($existing -eq 0)
  if ($ownInstance) {
    try { $app.Visible = $false } catch { }
    if ($Kind -eq 'docx') { try { $app.DisplayAlerts = 0 } catch { } }
    if ($Kind -eq 'xlsx') { try { $app.DisplayAlerts = $false } catch { } }
  }

  switch ($Kind) {
    'docx' {
      $doc = $app.Documents.Open($Src, $false, $true)
      $doc.SaveAs2($Dst, 16)
      $doc.Close(0)
    }
    'xlsx' {
      $doc = $app.Workbooks.Open($Src, 0, $true)
      $doc.SaveAs($Dst, 51)
      $doc.Close($false)
    }
    'pptx' {
      $doc = $app.Presentations.Open($Src, -1, 0, 0)
      $doc.SaveAs($Dst, 24)
      $doc.Close()
    }
  }
  $doc = $null
  Write-Output 'OK'
}
finally {
  if ($doc) { try { $doc.Close(0) } catch { } }
  if ($app -and $ownInstance) {
    try {
      $left = 0
      if ($Kind -eq 'docx') { $left = $app.Documents.Count }
      elseif ($Kind -eq 'xlsx') { $left = $app.Workbooks.Count }
      else { $left = $app.Presentations.Count }
      if ($left -eq 0) { $app.Quit() }
    } catch { }
  }
  if ($app) { try { [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($app) } catch { } }
}
