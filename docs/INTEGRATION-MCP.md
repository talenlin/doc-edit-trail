# 把 edit-trail 接进大模型（MCP / CLI / 提示词）

三条消费路径，按"零配置→全自动"排序：

| 路径 | 需要什么 | 适合 |
|---|---|---|
| A. 直接读 journal | 无 | 任何 agent，只要能读文件 |
| B. CLI 查询 | Node | 命令行/脚本，或 agent 的 bash 工具 |
| C. MCP 工具 | 一次配置 + 重启 harness | 日常对话里"它自己知道文档被改过" |

---

## A. 直接读 journal（最省事）

每个被追踪文件旁边：

```
<dir>/revised record/<name>.xlsx.edittrail/journal.jsonl      ← 每行一次落盘，含 changes[]
<dir>/revised record/<name>.xlsx.edittrail/snapshot.json      ← 当前内容快照（可 --no-content 关掉）
<dir>/revised record/<name>.xlsx.edittrail/readers.json       ← 各 reader 读到哪个 sha
```

模型只需读 `journal.jsonl` 的后 N 行。字段见 [CONTRACT.md](CONTRACT.md)。
**这是唯一权威来源**——插件、CLI、MCP 都只是它的写入者/读者。

## B. CLI

```powershell
node <repo>\src\cli\edittrail.mjs init   "D:\docs\out\报告_v2.4.xlsx"
node <repo>\src\cli\edittrail.mjs watch  "D:\docs\out"
node <repo>\src\cli\edittrail.mjs diff   a.xlsx b.xlsx
node <repo>\src\cli\edittrail.mjs report "D:\docs\out\报告_v2.4.xlsx"
```

`report` 打印的就是给模型看的变更简报（与 MCP `doc_changes` 同一渲染器）。

## C. MCP（DSH / Claude Desktop / 任何 MCP 宿主）

### C.1 先验证 stdio 服务本身

```powershell
node <repo>\src\mcp\selftest.mjs
```

17 项全 PASS 才说明协议与渲染没问题（不依赖 WPS）。
接好之前想先看真效果，可直接跑 `node tools\probe-mcp.mjs "<任意被追踪的文件>"`——它走同一套 stdio JSON-RPC。

### C.2 DSH 注册

编辑 `%USERPROFILE%\.dsh\profiles\<profile>\cordis.patch.yml`，在已有的 `- insert:` 列表里加一条（位置随意）：

```yaml
    - id: mcp-edit-trail
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: edit-trail
        transport: stdio
        command: 'C:\Program Files\nodejs\node.exe'
        args:
          - '<repo>\src\mcp\server.mjs'
        reconnect:
          maxAttempts: 20
```

两个坑（实测踩过）：

1. **不要用 `cmd /c` 包**——Windows 上 `cmd /c` 不是可被整体 kill 的进程组，node 子进程存活 →
   传输层永远收不到关闭信号 → mcp-client 不再重连。直接用 node 绝对路径。
2. **改完必须重启 harness**（`cordis.patch.yml` 是启动时加载的），当前会话不会热加载。

### C.3 Claude Desktop / 其他 MCP 宿主

```json
{
  "mcpServers": {
    "edit-trail": {
      "command": "C:\\Program Files\\nodejs\\node.exe",
      "args": ["<repo>\\src\\mcp\\server.mjs"]
    }
  }
}
```

### C.4 工具一览

| 工具 | 何时调 | 返回 |
|---|---|---|
| `doc_changes` | **改文档之前必调**；用户说"我自己改过"时 | 自上此读取以来的变更简报（markdown），并推进 reader 游标 |
| `doc_trail` | 想知道"改了几轮、什么时候改的" | 落盘时间线表 |
| `doc_versions` | 想区分 v2.3/v2.4 文档族 | 版本表 + 追踪状态 |
| `doc_scan` | 用户刚保存、守护进程还没捕获 | 立刻快照并返回本次差异 |
| `doc_revisions` | 用户说"我自己在 Word/WPS 里改的"，且文档开着「修订」 | 原生修订条目：作者、时间、`para:<w14:paraId>` 锚点、文本 |

`doc_changes` 的 `reader` 是"读到哪"的游标键：不传时取 `EDITTRAIL_SESSION_ID` / `DSH_SESSION_ID`
（形如 `llm:<sessionId>`），都没有则用 `human:default`。
显式覆盖用 `since`，支持四种写法：`"v2.3"`（从该版本起）、`"abc1234"`（sha 前缀，表示"我已看过这个状态"，
只返回其后）、`"12"`（seq 之后）、`"2026-01-14T18:00+08:00"` 或 `"1d"`/`"30m"`（相对时间）。

---

## D. 提示词（让模型真的会用）

MCP 工具描述里已经写了"改文档前先调 `doc_changes`"，但模型仍可能跳过。给 agent 的
系统提示里加一段最稳：

```text
处理 xlsx/docx/pptx 时，先调 edit-trail 的 doc_changes(文件路径)：
- 若返回"没有新的落盘改动"，说明文档自上次读取以来没被改过，直接继续。
- 若有改动，先读变更简报：每行给出 sheet!单元格/段落号、修改前后文字、以及 actor
  （用户手改 vs 模型写回）。据此理解用户的意图调整，不要重新通读全文做 diff。
- 用户提到"我改了一版/v2.x/我自己改的"而 doc_changes 说没变化时，再调 doc_scan。
- 想确认「谁改的」且文件是 .docx：调 doc_revisions（只有开着「修订」才有内容，空结果不代表没改过）。
改完文件后无需手动记 log：落盘层会自动记录。
```

## E. 隐私开关

- `EDITTRAIL_NO_CONTENT=1`（或 CLI `--no-content`）：journal 只记哈希、锚点、字符增减，
  不存修改前后的文字。适合涉密文档；代价是模型看不到具体改了什么，只能看到"哪里改了"。
- 所有轨迹都在文档同目录的 `revised record/` 里，不上传、不联网。删掉该目录即彻底清除轨迹。
