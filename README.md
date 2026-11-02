# edit-trail

**Local-first edit trail for Office documents** — 让大模型读到「这一版改了什么」，而不是每次重新做一遍 diff。

`edit-trail` 在你的文档落盘时做快照、和上一版对齐、把差异追加进一个只增不改的 journal。
之后无论是人还是模型，一条命令就能拿到结构化的变更简报：改了哪个 sheet 的哪个格、
删了哪一段、合并区少了几个、图表锚点挪到哪里、这一版相对上一版总共几处。

```
> 共 10 处实质改动：结构 3 / 文本 7
### 总览（10 处）
- `总览!A2` 删除：`条目清单（按类别）`
- `总览!B2` 删除：`12`
- `总览!A2:B2` 删除：`合并且 A2:B2`
```

## 它解决什么问题

多轮改稿里最贵的一步不是改，而是**确认上一版改了什么**：文件名是 `_v2.3` / `_v2.9-250101`，
`mtime` 在同步盘和批量导出后完全不可信，模型每次都要重新写脚本比 xlsx、比 docx，
而且经常漏掉「删了一整块」「合并区取消」「行高没了」这类结构变化。

`edit-trail` 把这件事一次性做成基础设施：

- **落盘即可记录**：不要求用户改工作方式，不需要一直开着某个编辑器。
- **结构面也记**：合并区、行高、分页符、图表锚点/尺寸，不只是单元格文本。
- **版本族（lineage）**：`报告_v2.3.xlsx` 和 `报告_v2.4.xlsx` 是两个文件，也能算成「同一份文档的下一版」。
- **谁改的**：docx 原生修订（`w:ins/w:del` 的 `w:author`）零依赖可读；WPS 加载项可补实时事件。
- **模型友好**：MCP 工具直接返回中文简报，模型不用再写 diff 脚本。

## 三条通道

| 通道 | 作用 | 依赖 |
|---|---|---|
| **L0 落盘层**（权威） | 快照 → 对齐 → diff → journal；xlsx/docx/pptx | 无，纯文件 |
| **docx 原生修订** | 回答「谁改的」：author + date + 段落 `w14:paraId` | 无 |
| **WPS 加载项**（可选） | `SheetChange` 等实时事件、保存前增量信号 | WPS + 本地 http 服务 |

为什么权威层放在落盘而不是加载项：宿主加载项的生命周期不受控（崩溃、升级、被禁用都会断），
而文件不会骗人。加载项只是**增量信号源**，装不装都不影响轨迹完整性。
详见 [docs/ROUTES.md](docs/ROUTES.md)。

## 快速开始

要求 Node.js ≥ 20（零第三方依赖，不需要 npm install）。

```bash
# 1) 给一份文档建基线（之后每次落盘都会被记录）
node src/cli/edittrail.mjs init "D:\docs\报告_v2.3.xlsx" --actor wps-user

# 2) 守着整个目录（放后台或开机启动）
node src/cli/edittrail.mjs watch "D:\docs" --interval 1500

# 3) 人看/模型看的变更简报
node src/cli/edittrail.mjs report "D:\docs\报告_v2.4.xlsx"

# 4) 直接比较任意两个版本（不需要先 watch）
node src/cli/edittrail.mjs diff "D:\docs\报告_v2.3.xlsx" "D:\docs\报告_v2.4.xlsx" --md out.md

# 5) docx 原生修订：谁改的
node src/cli/edittrail.mjs revisions "D:\docs\报告_v2.4.docx"
```

跨版本是自动的：`init v2.3` 建基线后，`init v2.4`（或 watcher 发现 v2.4 落盘）的第一条记录
就是「v2.3 → v2.4」的差异，带 `lineageFrom` 指向上一版。

## 接到 MCP（给模型用）

`src/mcp/server.mjs` 是零依赖的 stdio MCP server，暴露 5 个工具：

| 工具 | 用途 |
|---|---|
| `doc_changes` | 「这个文件上次之后改了什么」；带 reader 游标，模型读过就自动推进 |
| `doc_trail` | 全部历史（每条一行摘要） |
| `doc_versions` | 同族版本 + 是否已追踪 + mtime |
| `doc_scan` | 现在扫一次落盘（不用等 watcher） |
| `doc_revisions` | docx 原生修订（作者/时间/段落） |

DSH（DeepSeek Harness）配置示例，`cordis.patch.yml`：

```yaml
- id: mcp-edit-trail
  name: '@deepseek-ai/dsh-mcp-client'
  config:
    serverName: edit-trail
    transport: stdio
    command: 'C:\Program Files\nodejs\node.exe'
    args: ['C:\path\to\edit-trail\src\mcp\server.mjs']
```

Claude Desktop / 其他 MCP 客户端同理。细节见 [docs/INTEGRATION-MCP.md](docs/INTEGRATION-MCP.md)。

**系统提示词加一句就够**：

> 读 Office 文档前，先调用 `doc_changes` 看有没有新的编辑轨迹；有就只针对变化部分回答，
> 不要重新通读全文，也不要用 mtime 判断「谁改的」。

## WPS 加载项（可选，v0.0.1 只有表格）

`addin-wps/` 是一个最小的 WPS 表格加载项：功能区多一个 `EditTrail` 标签页，
`SheetChange` 等事件通过本地服务写日志。

```powershell
# 1) 起服务（必须常驻：加载项 url 只能是 http(s)）
node addin-wps/tools/serve.js 39871

# 2) 写 publish.xml（装完重启 WPS 才生效）
powershell -NoProfile -ExecutionPolicy Bypass -File addin-wps/tools/install.ps1

# 3) 打开任意 .xlsx，功能区出现 EditTrail 标签页
```

实测结论（WPS 12.1.0.29680 个人版）：可加载、可触发；`url` 必须 http(s)，
`SheetChange` 无旧值，docx 无实时编辑事件。完整事实表见 [addin-wps/RECON.md](addin-wps/RECON.md)，
安装/卸载/回滚见 [addin-wps/INSTALL.md](addin-wps/INSTALL.md)。

## 数据落在哪

每个被追踪的文件旁边一个目录：

```
报告_v2.4.xlsx
报告_v2.4.xlsx.edittrail/
  journal.jsonl     # 一段落盘 → 一行 JSON，只追加
  snapshot.json     # 当前版本的结构化快照
  lineage.json      # 同族版本索引
  readers.json      # 各消费者读到哪了（MCP reader 游标）
```

字段级契约见 [docs/CONTRACT.md](docs/CONTRACT.md)。`*.edittrail/` 建议加进 `.gitignore`。

## 隐私

- **全本地**：不联网、不上传，没有账号。MCP server 只读本地文件。
- `--no-content` 只记锚点与计数，不记单元格/段落原文。
- 不想让某个目录被记录，就不把它加进 watch 列表；journal 目录可以随时删，下次落盘会重建基线。

## 已知边界

- 只在**落盘之后**记录：改了没保存就关掉，这段轨迹不存在。
- 图表只比缓存值与锚点/尺寸，不逐点 diff；图片只比 sha256。
- 条件格式、数据验证、批注、超链接未采集。
- docx 无 `w14:paraId` 时回退到「段落序号 + 文本相似度」对齐。
- pptx 只取形状文本，暂无真实样本回归。
- 加密文档不支持。

## 开发与测试

```bash
node --test                 # 48 项（Node 24 下不要用 `node --test test/`）
node src/mcp/selftest.mjs   # 17 项：MCP 协议 + 渲染 + 原生修订，不需要 WPS
node tools/probe-mcp.mjs <file>   # 用同一套 stdio 协议看模型会收到什么
```

引擎内部结构、快照/journal 格式、对齐策略见 [src/core/README.md](src/core/README.md)。

## 路线图

- **v0.0.1**（本版）：落盘层 + lineage + docx 原生修订 + MCP 5 工具 + WPS 表格加载项。
- **v0.0.2**：Microsoft Office 一侧 —— Word Add-in（WordApi 1.6 `getTrackedChanges()` 读修订）、
  Excel（事件 + 落盘 diff，Excel 无修订对象模型）、`lib/` 内共享事件上报协议。
- 之后：把加载项事件 / 原生修订作者接成 journal 的 `actor` 直接证据链（含置信度），
  WPS 文字加载项内读 `Revisions`（R3）实测。

## License

MIT，见 [LICENSE](LICENSE)。
