# edit-trail 接口契约 v1

本文件是三层之间的**唯一接口约定**。`src/core`（引擎）、`src/mcp`（消费端）、`addin-wps`（宿主侧）各自实现，改契约必须先改这里。

## 1. 落盘布局

对每个被追踪的文档 `<dir>/<name>.xlsx`（docx/pptx 同）：

```
<dir>/revised record/<name>.edittrail/
  journal.jsonl     # 追加式变更记录（权威）
  snapshot.json     # 最近一次快照（可选，便于快速 diff）
  lineage.json      # 文档族索引（记录本族其它版本文件）
  readers.json      # 各 reader 的读取游标（谁读到哪个 sha）
  journal.lock      # 并发写锁（内容：pid + 起始时间 ms）
```

- 记录集中放在文档同目录的 `revised record/` 下，子目录名固定 `<文件名含扩展名>.edittrail`，避免与用户文件混淆。
- **旧布局兼容**：v0.0.1 及更早把 `<dir>/<name>.edittrail/` 放在文档旁边；读取时新位置优先、回退旧位置，写入会把旧目录搬进 `revised record/`（`edittrail migrate` 批量迁移）。
- `journal.jsonl` **只追加**，每行一个 JSON 对象；写入用「写临时文件 + rename」原子替换整个文件（读放大可接受，一版最多几千条）。
- 任何消费者只依赖 `journal.jsonl` 与 `readers.json`。

## 2. journal 记录（每行）

```json
{
  "seq": 7,
  "ts": "2026-01-14T10:24:22+08:00",
  "tsMs": 1768385122000,
  "file": "示例报告_v2.4.xlsx",
  "docType": "xlsx",
  "actor": "wps-user",
  "actorConfidence": "high",
  "source": "watcher",
  "size": 12345,
  "sha256": "…",
  "prevSha256": "…",
  "seqInLineage": 4,
  "changeCount": 10,
  "counts": { "cell.changed": 7, "merge.changed": 3 },
  "summary": "用户手改 10 处，集中在『明细表』计数口径",
  "changes": [
    {
      "kind": "cell.changed",
      "anchor": "明细表!C7",
      "sheet": "明细表",
      "cell": "C7",
      "before": "12 项",
      "after": "10 项",
      "beforeFull": "12 项（含 1 项综合）",
      "afterFull": "10 项",
      "styleChanged": false,
      "charDelta": -1,
      "firstDiffAt": 0
    }
  ]
}
```

字段约定：
- `actor` ∈ `wps-user | model | script | unknown`；`actorConfidence` ∈ `high|medium|low`。
- `source` ∈ `watcher | addin | cli | manual`。
- `lineageFrom`（可选）：**跨版本对照**。当某版本文件第一次被追踪、且同族存在前一版快照时，第一条记录是「相对上一版」的 diff：
  ```json
  "lineageFrom": { "file": "…_v2.3.xlsx", "version": "2.3", "sha256": "…" }
  ```
  此时 `changeCount`/`changes`/`counts` 都描述 v2.3 → 当前版本的差异，`prevSha256` 可为 `null`。
  若找不到前驱快照，退回普通基线：`changeCount: 0`、`changes: []`、无 `lineageFrom`。
  消费者必须区分这两态：**「基线，0 改动」不等于「文档未被修改」**。
- `changes` 超过 500 条时，记录里只放前 500 条并加 `truncated: true, totalChanges: N`（避免 journal 爆炸）。
- `before`/`after` 是**给模型看的摘要**（≤120 字，超长用 `…` 截断 + `firstDiffAt`）；`beforeFull/afterFull` 仅当原文 ≤1000 字时给出。
- 无法读取内容时（如 `--no-content`）：省略 `before/after`，保留 `anchor/kind/sha256`。

## 3. 变更类型（kind）

| 层 | kind |
|---|---|
| 通用 | `doc.version.created`、`sheet.added/removed/renamed/moved`、`style.changed` |
| xlsx | `cell.changed/added/removed`、`merge.changed`、`chart.changed`、`media.changed`、`formula.changed`、`row.height`、`row.hidden`、`pagebreak.changed` |
| docx | `para.changed/added/removed`、`table.changed`、`heading.level` |
| pptx | `slide.added/removed`、`slide.changed`、`shape.text.changed` |

分类（摘要里的「结构/文本/图表/样式」同口径，见 `src/core/diff.mjs:classifyChange`）：
`sheet.* merge.* row.* col.* pagebreak.* slide.added/removed doc.version*` → 结构；
`cell.* para.* table.* formula.* shape.* heading.* slide.changed` → 文本；
`chart.* media.*` → 图表；其余 → 样式/其他。
`row.height` 超过 10 处时会聚合成一条 `Sheet!rows`（避免删一段产生几十条噪声）；同理样式重排超过阈值聚合为一条。

`anchor` 形式：xlsx `Sheet!A1`；docx `para:<paraId>` 或 `para:#<index>`；pptx `slide:<n>/shape:<name or idx>`。

## 4. 文档族（lineage）

`lineage.json`：

```json
{
  "lineageId": "示例报告",
  "members": [
    { "file": "..._v2.3.xlsx", "version": "2.3", "sha256": "…", "mtime": "2026-01-14T09:00:00+08:00", "journalSeqMax": 3 },
    { "file": "..._v2.4.xlsx", "version": "2.4", "sha256": "…", "mtime": "2026-01-14T10:24:25+08:00", "journalSeqMax": 7 }
  ]
}
```

归一化（lineage key）规则，按顺序应用：
1. 去扩展名；
2. 去 `（打印版）`/`(打印版)`/`-打印版`/`-副本`/`-copy`/` copy`；
3. 去 `_v<num>(.<num>)*(-<6位日期>)?` 与 ` v<num>(.<num>)*`；
4. 去尾部空白与分隔符 `_ -`。

版本号取第 3 步抓到的 `v<num>`，取不到则按 mtime 排序并用 `sha8` 作版本标识。

## 5. reader cursor（"我上次读到哪"）

`readers.json`：

```json
{
  "readers": {
    "llm:session-a1b2c3": { "sha256": "…", "seq": 5, "ts": "2026-01-15T15:50:00+08:00", "file": "..._v2.8.xlsx" },
    "human:default": { "sha256": "…", "seq": 5, "ts": "…", "file": "…" }
  }
}
```

语义：某 reader 调用 `doc_changes(reader=…)` 时，默认 `since` = 该 reader 上次返回的 `sha256`；返回后**自动推进**游标（可用 `advance:false` 关闭）。这样模型第二次读同一文档只看到「上次之后的新改动」。

reader 命名：`llm:<dsh-session-id>`（MCP 客户端传入或落盘推导）、`human:default`。

## 6. MCP 工具面（stdio，JSON-RPC 2.0）

server 名 `edit-trail`，零依赖实现（`src/mcp/server.mjs`）。

| tool | 入参 | 出参（`content[0].text` 为 markdown 简报，`structuredContent` 为同数据） |
|---|---|---|
| `doc_changes` | `file`（绝对/相对）、`reader?`、`since?`（sha 或 seq）、`advance?`、`maxChanges?` | 「自 <sha8|seq> 以来 N 处改动」简报 + 变更数组 |
| `doc_trail` | `file`、`limit?`、`includeChanges?` | 时间线（每次落盘一条） |
| `doc_versions` | `file` | 文档族成员 + 每版 sha/mtime/改动数 |
| `doc_scan` | `file`（可选：立刻快照并记录，若已有基线） | 本次 diff 结果（用于"用户改完让我看"） |
| `doc_revisions` | `file`（仅 .docx）、`limit?` | 原生修订条目（`w:ins/w:del/*PrChange`）：author、date、anchor、text |

错误一律返回 `isError: true` + 文本说明（文件不存在 / 无基线 / journal 损坏行数）。

## 7. 与引擎 CLI 的对接（不改引擎职责）

引擎 CLI 必须提供机器可读输出：

- `edittrail snapshot <file> -o <json>`
- `edittrail diff <a> <b> --json` → `{ a:{sha256,size}, b:{…}, docType, changes:[…], counts:{…} }`
- `edittrail watch <dir|file>` → 落 journal（含 `actor`，可由 `--actor` 覆盖）
- `edittrail report <file> --since <sha|seq> --md` → 简报
- `edittrail lineage <file>` → 文档族索引（引擎可选实现；MCP 侧有兜底实现）
- `edittrail migrate [dir] [--dry]` → 把旧布局 `<doc>.edittrail/` 搬进 `revised record/`

MCP server 通过 `child_process` 调 CLI（而非 import core），保证两套消费路径解耦；若 import 更稳则退化为 import（实现时二选一，以契约字段为准）。

## 8. 隐私与开关

- 默认把 `before/after` 写入 journal（本地）。
- `--no-content`：只存 `anchor/kind/lengths/sha256`，适合敏感文档；MCP `doc_changes` 自动降级为「只报位置与类型」。
- 一律不联网。

---

契约版本：v1（2026-01-15）
