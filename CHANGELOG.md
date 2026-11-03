# Changelog

## Unreleased

### Added
- WPS 加载项同时挂到 Writer（文字）与 Presentation（演示）：一套包按 `type="et|wps|wpp"` 注册，
  `/<host>/host.js` 注入宿主标识；文字宿主可一键切换 `TrackRevisions`，`edittrail revisions` 可读作者与时间。
- 事件 API 改为三级回退：本机三宿主都只暴露 `wps.ApiEvent`（`Application.ApiEvent` 不存在）。
- 功能区两个按钮各配一个 SVG 图标（`images/checkpoint.svg`、`images/track-changes.svg`），
  通过 `ribbon.xml` 的 `getImage="GetImage"` 返回相对路径。

### Fixed
- 加载项 Ribbon 按钮与日志写入重构为生产版（去掉侦察期的自动建表测试）；安装脚本写三条 publish.xml 并读回校验。

## v0.0.1 — 2026-11-02

首个可发布版本：本地优先的文档修改轨迹记录器。

### 引擎（零依赖）

- `src/core/zip.mjs`：只读 zip（stored/deflate、data descriptor、ZIP64、UTF-8 名、CRC 校验）+ `buildZip`（测试用）。
- `xlsx`：单元格值/类型/样式索引、sheet 状态、合并区、行高与隐藏、分页符、drawing→chart 指纹、media hash。
- `docx`：`w14:paraId` 段落锚点、段落样式与标题级别、表格、页眉页脚。
- `pptx`：幻灯片顺序与形状文本。
- `diff`：按锚点对齐后产出 24 种 kind；结构面（`merge.changed` / `row.height` / `row.hidden` /
  `pagebreak.changed` / `chart.changed` / `media.changed`）与文本面分开统计；长文本摘要 + 噪声聚合。
- `lineage`：文件名归一化（`（打印版）`、副本、`_v2.3`、`-250101`）→ 同族版本索引。
- `initial`：新版本首次被追踪且同族有前驱快照时，第一条记录直接是跨版本 diff（`lineageFrom`）。
- `journal`：每文档 `.edittrail/journal.jsonl`，锁 + 原子追加 + 坏行容错 + `--no-content` 裁剪。
- `revisions`：docx 原生修订（`w:ins/w:del/moveFrom/moveTo/*PrChange`）→ 作者、时间、`para:<paraId>`、文本。

### 接口

- CLI：`snapshot / diff / init / watch / report / lineage / revisions`。
- MCP（stdio，零依赖）：`doc_changes`（带 reader 游标）、`doc_trail`、`doc_versions`、`doc_scan`、`doc_revisions`。
- WPS 表格加载项（`addin-wps/`）：功能区标签页 + `SheetChange` 等事件上报，安装/卸载脚本可逆。
- `demo.mjs`：合成两版文件跑通全链路，产物写到 `examples/`。

### 测试

- `node --test`：48 项。
- `node src/mcp/selftest.mjs`：17 项（含原生修订读写与拒绝路径）。

### 已知边界

图表只比缓存值/锚点，图片只比 sha256；条件格式、数据验证、批注、超链接未采集；
pptx 仅形状文本；加密文档不支持；只在落盘后记录。

## v0.0.2（计划）

- Microsoft Office 一侧：Word Add-in（WordApi 1.6 `getTrackedChanges()`）、Excel（事件 + 落盘 diff）。
- 把加载项事件与原生修订作者接成 journal 的 `actor` 证据链（带 `actorConfidence`）。
- WPS 文字加载项内读 `Revisions`（ROUTES.md 的 R3）实测。
