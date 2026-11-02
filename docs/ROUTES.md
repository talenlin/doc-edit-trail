# 接入路线：每个宿主到底能拿到什么

> 目的：把「谁改的 / 改成了什么」拆成可分别验证的通道，说明每条通道的实测结论，
> 以及为什么最终架构是「落盘层（L0）权威 + 原生修订补 actor + 加载项只做增量信号」。

## 结论表

| 通道 | 能回答 | 依赖 | 状态 |
|---|---|---|---|
| **R0** 落盘快照 + diff | 改成了什么、版本族 lineage、结构面（合并区/行高/分页符/图表锚点） | 无（纯文件） | ✅ 权威通道，完整实现与测试 |
| **R1** WPS 表格 JS 加载项 | 保存/切窗/关窗事件、`SheetChange`（sheet 名 + Range + 新值，**无旧值**） | WPS + 常驻 http 服务 | ✅ 实测可装、可触发（WPS 12.1.0.29680） |
| **R2** docx 原生修订 | **谁改的**（author + date + 段落 paraId + 文本） | 无（读 `w:ins/w:del/*PrChange`） | ✅ `edittrail revisions` / MCP `doc_revisions` |
| **R3** WPS 文字加载项内 `Revisions` | 保存前就能读到修订；`WpsRevision{Author, Date, Type, Range}` | WPS 文字加载项 | ⏳ 类型定义已确认，未实测 |
| **R4** Office.js Word Add-in | WordApi 1.6 `getTrackedChanges()` → `TrackedChange{author, date, text, type}` | Microsoft Word + 加载项宿主 | ⏳ 官方 API 已核实，未实测 |
| **R5** WPS COM / VBA | 理论同 R3 | 注册表里可用 CLSID 的 Office 安装 | ❌ 本机实测不可用（ProgID 在、CLSID 未注册） |

**L0 永远开着**：R1/R3/R4 只提升 actor 置信度与实时性，一个都不装也不会丢轨迹——这是刻意的取舍，
因为宿主加载项的生命周期不受我们控制（宿主崩溃、升级、用户禁用都会让「插件内日志」断掉）。

## R0：落盘快照 + diff

- 实现：`src/core/`，每次文件落盘（sha 变化）就快照 → 与上一条记录对齐 → 追加 journal。
- 覆盖：xlsx / docx / pptx；同一目录下多个版本靠 **文件名 lineage** 归族（`_v2.3`、`_v2.9-250101`、`（打印版）`、`副本` 都能归一）。
- 为什么它是权威：不依赖宿主在线、插件崩了轨迹不丢、模型/脚本/人改都能覆盖；
  也不依赖 mtime（`mtime` 在复制、同步盘、批量导出时完全不可信）。
- 代价：只能在**落盘之后**记录；用户改了没保存就关掉，这一段轨迹不存在。

## R1：WPS 表格 JS 加载项

实测环境：WPS Office 12.1.0.29680 个人版（x86）。

加载方式（不需要开发者账号、不改注册表）：

1. `%APPDATA%\kingsoft\wps\jsaddons\publish.xml` 写一条 `<jspluginonline name="…" type="et" url="http://127.0.0.1:<port>/" enable="enable_dev"/>`；
2. WPS 按 `manifest.xml → ribbon.xml → index.html → main.js → js/*.js` 从该 url 拉取；
3. 打开任意 `.xlsx` 触发加载（空白开始页不加载）。

关键约束：

- `url` **必须是 http(s)**。`file://` 与「相对目录」两种形态实测**静默不加载**（无报错、delta=0）。
  所以必须有常驻本地静态服务——这是整套方案唯一的硬依赖。
- `SheetChange` 只给 **新值**，没有旧值；要记「改前 → 改后」必须自己维护影子缓存。
- docx 没有实时编辑事件，只有保存时机事件；所以文字场景的实时流拿不到，回落 L0。
- `wps.FileSystem.AppendFile(path, data)` 可用；没有 `WriteFile`。
- 事件注册函数 `OnAddinLoad` 会被调用多次，必须自己去重（否则同一事件重复上报）。
- `Range.Address` / `Selection.Address` 是**函数**，要写 `Address()`。

细节与 32 条实测事实见 [`../addin-wps/RECON.md`](../addin-wps/RECON.md)，安装/回滚见
[`../addin-wps/INSTALL.md`](../addin-wps/INSTALL.md)。

## R2：docx 原生修订（零依赖，回答「谁改的」）

Word/WPS 开着「修订」时，改动会以 `w:ins` / `w:del` / `w:moveFrom` / `w:moveTo` / `*PrChange`
写进 `word/document.xml`（页眉页脚、脚注尾注也各有一份）。每个标记带 `w:author`、`w:date`、`w:id`。

```bash
node src/cli/edittrail.mjs revisions 示例报告_v2.3.docx
```

```
示例报告_v2.3.docx · 2 条原生修订（作者：张三、wps-user）
- [新增] para:2D375F6B · 张三 · 2026-01-14T14:12 +08:00 · 新增的一句话
- [删除] para:2D375F6C · wps-user · 被删掉的一句话
```

限制：

- 只有**当时开着修订**才有内容；事后打开修订不会追溯生成。
- 用户点过「接受所有修订」后，文件里什么都不剩。
- 修订条目是「编辑动作」，不是「净变化」：同一段被改三次会有三条。
- 覆盖 `document.xml` + `header*/footer*` + `footnotes` + `endnotes`；批注（comments）不算修订。
- 与 journal 的关系：现在 `revisions` 是按需查询，不写进 ledger；把 `w:author` 接成 journal 的
  `actor` 直接证据源是下一步。

## R3：WPS 文字加载项内读 `Revisions`

WPS 文字 JSAPI 有完整的修订对象模型（`lib.wps.d.ts`）：

```ts
interface WpsRevisions {
  Count: number;
  Item(Index?: number, prop?: WpsRevision): void;
  AcceptAll(): void;
  RejectAll(): void;
}
interface WpsRevision {
  Author: string; Date: string; Type: number;
  Range: WpsRange; Reject(): void;
  FormatDescription: string; MovedRange; Cells;
}
```

也就是说，在 WPS 文字里加载加载项，**不用保存**就能拿到「谁在什么时候改了哪段」。
没实测的原因：需要在用户正编辑的文档上做自动化操作，风险不对等（可能干扰未保存内容）；
类型定义已确认，实现路径与 R1 同构。

## R4：Office.js Word Add-in（v0.0.2 方向）

WordApi 1.6（[requirement set 1.6](https://learn.microsoft.com/en-us/javascript/api/requirement-sets/word/word-api-1-6-requirement-set)）提供：

```ts
Body.getTrackedChanges(): TrackedChangeCollection              // 也有 Paragraph / Range / ContentControl 版本
TrackedChange { accept(); reject(); author; date; text; type; getRange(rangeLocation?); getNext() }
TrackedChangeCollection { acceptAll(); rejectAll(); getFirst(); items }
```

同版还加了 `onParagraphAdded / onParagraphChanged / onParagraphDeleted` 与 `uniqueLocalId`
（会话内段落锚点，类似 docx 的 `w14:paraId`）。

限制：官方 issue [#6246](https://github.com/officedev/office-js/issues/6246) 指出，
当前 API 拿不到「修订显示为内联还是批注」这类视图设置；不同平台的能力集也有差异。

v0.0.2 计划：先落一个最小 Word 加载项（读修订 + 保存时上报），Excel 侧走「事件 + 落盘 diff」
（Excel 没有修订对象模型，Office.js 只给单元格新值/事件）。

## R5：WPS COM / VBA（放弃）

实测：`HKCR` 里 `KWPS.Application`、`KET.Application`、`KWPP.Application` 的 ProgID 存在，
但这些 CLSID 在 `HKCU\Software\Classes\CLSID` 与 `HKLM\Software\Classes\CLSID` 下**都没有注册**，
`New-Object -ComObject` 不可用；`WPS.Application` 这个 ProgID 根本不存在。
即使注册成功，COM 自动化会附着到用户正在编辑的实例上，风险高于收益。**不采用。**

## actor 证据优先级

```
加载项事件（R1/R3，最接近「人操作」）
  > 原生修订作者（R2，含 author + 时间，但只在开修订时）
    > 文件锁 / 宿主进程推断（弱证据：只说明"某人在编辑"）
      > unknown（默认）
```

`actorConfidence` 记在每条 journal 记录里，消费端（模型）应该按置信度决定要不要追问，
而不是把 `unknown` 当成「不是用户改的」。
