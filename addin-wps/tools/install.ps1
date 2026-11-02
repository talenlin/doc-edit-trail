# 安装 EditTrail 探针加载项 (et / 表格)
# 用法:
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools\install.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools\install.ps1 -Port 39871
# 做的事:
#   1) 把原始状态 (jsaddons 是否存在 / publish.xml 是否存在 / 备份) 记到 logs\orig-state.txt
#   2) 写 %APPDATA%\kingsoft\wps\jsaddons\publish.xml, 指向 http://127.0.0.1:<Port>/
#   3) 读回校验, 确认文件真的写成
# 注意: 相对目录 / file:// 形态实测不被加载, 所以必须走 http。
param([int]$Port = 39871)

$ErrorActionPreference = 'Stop'
$JsAddons   = Join-Path $env:APPDATA 'kingsoft\wps\jsaddons'
$PublishXml = Join-Path $JsAddons 'publish.xml'
$StateDir   = Join-Path (Split-Path -Parent $PSScriptRoot) 'logs'
New-Item -ItemType Directory -Force -Path $StateDir | Out-Null
$StateFile  = Join-Path $StateDir 'orig-state.txt'
$Bak        = Join-Path $StateDir 'publish.xml.bak'

# 只在第一次安装时记录原始状态, 避免二次安装把"已安装状态"当成原始状态
if (Test-Path $StateFile) {
    Write-Host "[state] 已存在 orig-state.txt, 保留首次记录 (不会覆盖)"
} else {
    $state = @()
    $state += "captured=$((Get-Date).ToString('o'))"
    $state += "jsaddons_existed=$(Test-Path $JsAddons)"
    if (Test-Path $JsAddons) {
        $state += "jsaddons_contents=" + ((Get-ChildItem $JsAddons -Force | ForEach-Object { $_.Name }) -join ';')
    }
    $state += "publish_xml_existed=$(Test-Path $PublishXml)"
    if (Test-Path $PublishXml) {
        Copy-Item $PublishXml $Bak -Force
        $state += "publish_xml_backup=logs\publish.xml.bak"
        $state += "publish_xml_sha256=" + (Get-FileHash $PublishXml -Algorithm SHA256).Hash
    }
    Set-Content -Path $StateFile -Value $state -Encoding UTF8
    Write-Host "[state] $StateFile"
    $state | ForEach-Object { Write-Host "  $_" }
}

# 写 publish.xml (无 BOM: 有 BOM 时个别解析器会把它当内容)
New-Item -ItemType Directory -Force -Path $JsAddons | Out-Null
$xml = @"
<jsplugins>
  <jspluginonline name="EditTrailProbe" type="et" url="http://127.0.0.1:$Port/" debug="" enable="enable_dev" install="null" customDomain=""/>
</jsplugins>
"@
[System.IO.File]::WriteAllText($PublishXml, $xml, (New-Object System.Text.UTF8Encoding($false)))

# 读回校验: 不做这一步时, 曾出现"目录建了但文件没写"的静默失败
if (-not (Test-Path $PublishXml)) { throw "[FAIL] publish.xml 未写成: $PublishXml" }
$readBack = Get-Content $PublishXml -Raw
if ($readBack -notmatch 'jspluginonline') { throw "[FAIL] publish.xml 内容异常: $readBack" }
Write-Host "[write] OK $PublishXml ($((Get-Item $PublishXml).Length)B)"
Get-Content $PublishXml

Write-Host ""
Write-Host "下一步:"
Write-Host "  1) 启动静态服务:  node addin-wps\tools\serve.js $Port     (必须一直开着)"
Write-Host "  2) 启动 WPS 表格并打开任意 .xlsx (空白开始页不会加载加载项)"
Write-Host "  3) 看 logs\server.log 与 logs\addin.log"
