# Changelog

## v0.0.3 — 2026-11-09

### Added
- 旧格式 `.doc / .docm / .xls / .xlt / .ppt / .pps`：先经本机 WPS COM 转成 OOXML 再比结构；
  转换结果按源文件 sha256 缓存在 `revision history/<文件名>.edittrail/converted/`，同一字节版本只转一次。
  记录里新增 `sourceFormat` / `convertedBytes`，`sha256` 仍描述源文件。
- `edittrail convert <dir|file> [--recursive] [--force] [--dry]`：批量把旧格式另存为同目录 OOXML。
- `watch --recursive` 递归扫描子目录（默认仍只看一层）。

### Changed
- `tools/launch.mjs` 启动的 watcher 默认带 `--recursive`；日志名对纯中文目录名改用短哈希，避免撞名。

### 升级说明
- 引擎/CLI/MCP 直接换目录即可，记录目录结构没变（仍是 `revision history/`）。
- 旧格式要在装了 WPS 的机器上才能转换；只换引擎不装 WPS，`.doc/.xls/.ppt` 会记一条「转换失败」，
  OOXML 文档不受影响。
- watcher 若由 `tools/launch.mjs` 启动，会自动带 `--recursive`；自己写脚本的话建议也加上。

## v0.0.2 — 2026-11-03

### Added
- WPS 加载项同时挂到 Writer（文字）与 Presentation（演示）：一套包按 `type="et|wps|wpp"` 注册，
  `/<host>/host.js` 注入宿主标识；文字宿主可一键切换 `TrackRevisions`，`edittrail revisions` 可读作者与时间。
- 事件 API 改为三级回退：本机三宿主都只暴露 `wps.ApiEvent`（`Application.ApiEvent` 不存在）。
- 功能区两个按钮各配一个 SVG 图标（`images/checkpoint.svg`、`images/track-changes.svg`），
  通过 `ribbon.xml` 的 `getImage="GetImage"` 返回相对路径。
- 新增 `edittrail migrate [目录] [--dry]`：批量把旧布局的记录目录搬进 `revision history/`。

### Changed
- 变更记录从「文档旁边的 `<文档>.edittrail/`」改为集中存放在文档同目录的 **`revision history/`** 文件夹里，
  一个文档一个子目录；两类旧布局（文档旁 `.edittrail/`、中间版本的 `revised record/`）仍可读，
  首次写入自动搬迁，`edittrail migrate` 可批量迁移。

### Fixed
- 加载项 Ribbon 按钮与日志写入重构为生产版（去掉侦察期的自动建表测试）；安装脚本写三条 publish.xml 并读回校验。

### 升级说明
- 引擎/CLI/MCP 直接换目录即可：读取兼容旧布局，首次写入自动搬迁；想一次性搬完可跑 `edittrail migrate <目录>`。
- WPS 加载项改过 `publish.xml` 与 `ribbon.xml`，升级后需要**完全退出 WPS 再重新打开**才会生效。

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

## v0.0.3（计划）

- Microsoft Office 一侧：Word Add-in（WordApi 1.6 `getTrackedChanges()`）、Excel（事件 + 落盘 diff）。
- 把加载项事件与原生修订作者接成 journal 的 `actor` 证据链（带 `actorConfidence`）。
- WPS 文字加载项内读 `Revisions`（ROUTES.md 的 R3）实测。
