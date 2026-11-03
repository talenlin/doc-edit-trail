# edit-trail 引擎（L0 核心）

本目录是「文档落盘 → 结构化快照 → 差异 → 追加式变更日志 → 模型可读简报」的完整实现。
全部零依赖（只用 `node:fs` / `node:zlib` / `node:crypto`），不解析宿主进程，不装 Office SDK。

## 模块

| 文件 | 职责 |
|---|---|
| `zip.mjs` | 只读 zip：stored/deflate、data descriptor、ZIP64、UTF-8 名、CRC 校验；另含 `buildZip` 用于测试 fixture |
| `xml.mjs` | 极简 XML 遍历（够 OOXML 用），带字节偏移以便定位 |
| `xlsx.mjs` | workbook/rels/sharedStrings/sheet → 单元格值、类型、样式索引、合并区、行高/隐藏、分页符、drawing→chart、media |
| `docx.mjs` | `w14:paraId` 段落锚点、段落样式/标题级别、表格、页眉页脚 |
| `pptx.mjs` | 幻灯片顺序与形状文本 |
| `revisions.mjs` | docx 原生修订（`w:ins` / `w:del` / `moveFrom` / `moveTo` / `*PrChange`）→ 作者、时间、段落锚点、文本 |
| `snapshot.mjs` | 类型识别、sha256、原子写、`snapshotBuffer` |
| `diff.mjs` | 行/段落/表格/图表锚点对齐、长文本摘要、噪声聚合、`classifyChange` |
| `initial.mjs` | 跨版本：找到同族前驱快照后，第一条记录直接是「上一版 → 这一版」的差异 |
| `journal.mjs` | 每文档一个 `revision history/<文档>.edittrail/` 目录：锁、原子追加、坏行容错、`--no-content` 裁剪、旧布局自动搬迁 |
| `lineage.mjs` | 文件名归一化（去扩展名 → 去「（打印版）」/副本 → 去 `_v<num>` / `-<6位日期>`）与同族聚合 |
| `report.mjs` | markdown 简报渲染，>200 条折叠 |
| `watch.mjs` | 轮询目录、等落盘稳定、按 sha 去重、逐文件追加 |

## 快照格式（节选）

```json
{
  "contractVersion": 1,
  "docType": "xlsx",
  "sha256": "…64 hex…",
  "size": 12345,
  "snapshot": {
    "sheetCount": 2,
    "sheets": [
      {
        "name": "总览", "order": 0, "state": "visible", "sheetId": 1,
        "cells": {
          "A1": { "v": "示例报告 总览", "t": "s", "s": 1 },
          "B2": { "v": "12", "t": "n", "s": 0 }
        },
        "merges": ["A1:B1", "A2:B2"],
        "rowMeta": { "12": { "ht": 20, "customHeight": true } },
        "pageBreaks": { "rows": [12, 34], "cols": [] },
        "charts": [{ "name": "chart1", "type": "barChart", "series": 2, "points": 6 }]
      }
    ]
  }
}
```

## journal 记录（节选）

```json
{
  "seq": 1,
  "ts": "2026-01-15T08:12:31.480Z",
  "file": "示例报告_v2.0.xlsx",
  "docType": "xlsx",
  "actor": "wps-user",
  "actorConfidence": "medium",
  "source": "cli",
  "size": 12345,
  "sha256": "…",
  "prevSha256": "…",
  "seqInLineage": 2,
  "changeCount": 10,
  "counts": { "cell.removed": 7, "merge.changed": 3 },
  "summary": "v1.0 → v2.0：用户手改，10 处（结构 3 / 文本 7）",
  "lineageFrom": { "file": "示例报告_v1.0.xlsx", "version": "v1.0", "sha256": "…" },
  "changes": [
    { "kind": "cell.removed", "anchor": "总览!A2", "sheet": "总览", "cell": "A2", "before": "条目清单（按类别）", "after": null }
  ]
}
```

- `journal.jsonl` **只追加**，每行一个 JSON 对象；写入用「写临时文件 + rename」原子替换整个文件（读放大可接受，一份大文档一版最多几千条）。
- 单条记录的 `changes` 超过 500 条时截断为 `truncated: true` + `totalChanges`，摘要与计数仍是全量。
- `lineageFrom` 表示「这条记录是相对上一版算出来的」，`prevSha256` 可为 `null`；没有前驱时是基线记录，`changeCount: 0`。
- **`changeCount: 0` 不等于「文档没被改过」**：它只说明这个文件在本次落盘时与上一条记录相同。消费者要区分「基线」与「真的没变」。

## CLI

```bash
node src/cli/edittrail.mjs snapshot <file> [-o snap.json]
node src/cli/edittrail.mjs diff <a> <b> [--json|--md <out>]
node src/cli/edittrail.mjs init <file> [--actor wps-user]     # 首次建基线；同族有前驱时直接记跨版本差异
node src/cli/edittrail.mjs watch <dir|file> [--interval 1500] [--once] [--actor wps-user]
node src/cli/edittrail.mjs report <file> [--md] [--limit 200]
node src/cli/edittrail.mjs lineage <file>
node src/cli/edittrail.mjs revisions <file.docx> [--limit 50] [--json]
```

通用参数：`--actor <wps-user|model|script|unknown>`、`--source <watcher|addin|cli|manual>`、`--no-content`（不落单元格原文，只留计数与锚点）。

## 对齐策略（为什么不能直接按行号比）

同一份文档的两个版本之间，插一行会让后面所有行号漂移；删一个 sheet 会让所有 `sheet!ref` 失效。
所以：

| 文档类型 | 对齐键 | 退化方案 |
|---|---|---|
| xlsx | `sheet 名 + 单元格 ref` | sheet 改名按顺序+名称相似度配对；行高/分页符/合并区作为结构面单独比 |
| docx | `w14:paraId` | 无 paraId 时按 `para:#<index>` 加文本相似度 |
| pptx | slide 序号 + 形状顺序 | 形状文本指纹 |

如果不做对齐，一次「插一行」会被报成「后面每个单元格都变了」。

| 场景 | 不对齐 | 对齐后 |
|---|---|---|
| 删掉总览里一整块（含合并区取消） | 只看到零散单元格消失 | 10 处：7 个单元格 + 3 个合并区；若块里还带自定义行高/分页符，各自聚合成一条结构改动 |
| 表格插一行 | 后面所有行都报「变了」 | 只报插入的那一行 |

## 已知局限

- 图表只比缓存值与指纹（系列数、数据点数、锚点/尺寸位移），不逐点 diff。
- 图片只比 sha256，能发现「换了/多了图」，不描述图像内容。
- WPS 重存会整体重排 `styles.xml`，样式差异按阈值聚合；≤10 处仍逐条列。
- 条件格式、数据验证、批注、超链接、Excel 表格对象未采集。
- pptx 只取形状文本，无真实样本回归。
- 加密文档不支持。
- `actor` 默认由调用方传入；「谁改的」更可靠的证据是 docx 原生修订（`revisions`）与 WPS 加载项事件。

## 测试

```bash
node --test          # 48 项（Node 24 下不要用 `node --test test/`，它会把目录当模块）
```

覆盖：zip 解析/CRC/deflate、xlsx 单元格改增删、sheet 增删改名、docx 段落与表格、长文本截断、
journal 追加/幂等/损坏行/锁、跨版本 diff、lineage 归一化、report 折叠、CLI 端到端、原生修订。
