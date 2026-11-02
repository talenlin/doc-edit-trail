# 卸载/还原 install.ps1 做的改动
# 规则:
#   - 若首次安装前 jsaddons 目录不存在 -> 本目录内容全部由我们创建, 直接整棵删掉 (精确还原)
#   - 若原本就有 jsaddons -> 只删 publish.xml (或用备份还原), 保留目录与其它插件
$ErrorActionPreference = 'Stop'
$JsAddons   = Join-Path $env:APPDATA 'kingsoft\wps\jsaddons'
$PublishXml = Join-Path $JsAddons 'publish.xml'
$StateDir   = Join-Path (Split-Path -Parent $PSScriptRoot) 'logs'
$StateFile  = Join-Path $StateDir 'orig-state.txt'
$Bak        = Join-Path $StateDir 'publish.xml.bak'

if (-not (Test-Path $StateFile)) {
    Write-Host '[warn] 找不到 orig-state.txt, 按"原本不存在"处理'
    $origExisted = $false; $origXml = $false
} else {
    $lines = Get-Content $StateFile
    $origExisted = [bool]($lines | Where-Object { $_ -eq 'jsaddons_existed=True' })
    $origXml     = [bool]($lines | Where-Object { $_ -eq 'publish_xml_existed=True' })
}
Write-Host "[state] jsaddons_existed(原始)=$origExisted  publish_xml_existed(原始)=$origXml"

if (-not $origExisted) {
    # 原本没有 jsaddons: 整棵删掉即可精确回到安装前
    if (Test-Path $JsAddons) {
        Remove-Item $JsAddons -Recurse -Force
        Write-Host "[remove] $JsAddons (递归, 原本不存在)"
    }
} else {
    if ($origXml -and (Test-Path $Bak)) {
        Copy-Item $Bak $PublishXml -Force
        Write-Host "[restore] publish.xml <- logs\publish.xml.bak"
    } elseif (Test-Path $PublishXml) {
        Remove-Item $PublishXml -Force
        Write-Host "[remove] $PublishXml"
    }
    # 我们额外放的 payload 目录 (若有) 单独清掉, 不动其它插件
    $payload = Join-Path $JsAddons 'EditTrail_0.1.0'
    if (Test-Path $payload) { Remove-Item $payload -Recurse -Force; Write-Host "[remove] $payload" }
}

Write-Host "[verify] jsaddons exists = $(Test-Path $JsAddons)"
Write-Host "[verify] publish.xml exists = $(Test-Path $PublishXml)"
if (Test-Path $JsAddons) {
    Write-Host "[verify] jsaddons contents = $(((Get-ChildItem $JsAddons -Force | ForEach-Object { $_.Name }) -join ';'))"
}
