# EditTrail WPS 加载项 — 安装手册

> 适用: WPS Office **12.1.0.29680 个人版** 实测通过。其它版本未测。
> 形态: **开发/探针形态** —— 不需要开发者账号、不需要改注册表、不需要重装 WPS。
> 全部改动只落在两个地方: `%APPDATA%\kingsoft\wps\jsaddons\publish.xml`(一个新建文件)
> 和本目录。卸载脚本可精确还原。
> 下文 `<repo>` 指本仓库根目录。

---

## 0. 它现在能做什么

装上后打开任意 `.xlsx`, WPS 表格功能区会多一个 **`EditTrail`** 标签页, 里面有:

- **「写探针日志」** 按钮: 把当前工作簿的 `名称 / 完整路径 / 路径 / 是否已保存` + 时间戳写进
  `logs\addin.log` 和 `logs\server.log`。用来验证"加载项活着、能写文件"。
- 自动监听 10 个表格事件 (`WorkbookOpen`、`NewWorkbook`、`WorkbookBeforeSave`、`WorkbookAfterSave`、
  `WorkbookBeforeClose`、`SheetActivate`、`SheetChange`、`SheetSelectionChange`、`WindowActivate`、
  `WindowDeactivate`) 并逐条记日志 —— **改单元格的内容会实时落盘**, 这就是后续"修改日志"的原型。

---

## 1. 前置条件

| 需要 | 说明 |
|---|---|
| Node.js | ≥ 20。只用来跑静态服务器(`tools/serve.js`)。 |
| 一个空闲端口 | 默认 `39871`。要换端口, 安装时 `-Port` 一起改。 |
| WPS 表格能正常打开 xlsx | 就是这样。 |

**关键约束**: 加载项页面必须由 **http** 提供。`file://` 和"本地目录名"两种写法在本机实测都**静默不加载**
(详见 `RECON.md` 事实表 #5)。所以第 2 步的服务器是必需的, 不是可选优化。

---

## 2. 启动静态服务器(必须常驻)

**推荐：一条命令把加载项服务和所有目录监听一起拉起来（真正的后台，关掉终端也不停）：**

```powershell
node <repo>\tools\launch.mjs
```

它读取 `tools\watch-dirs.txt` 里的目录，逐个起 watcher，并把 pid 记到 `logs\service-pids.json`。
配套命令：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File <repo>\tools\status-trail.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File <repo>\tools\stop-trail.ps1
```

开机自启：把上面那条 `node ... launch.mjs` 做成快捷方式放进
`%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\`（不用就删掉那个 `.lnk`）。

**只想单跑加载项服务时**（旧方式，前台窗口）：

```powershell
node <repo>\addin-wps\tools\serve.js 39871
```

看到 `[serve] http://127.0.0.1:39871 -> <repo>\addin-wps` 即成功。
这个进程同时干两件事: 托管加载项页面 + 接收加载项上报并写 `logs\server.log`。

> 关掉这个进程 = 加载项下次启动时不会加载。已有窗口内正在跑的加载项不受影响。
> 注意 `tools\start-trail.ps1` / `launch.mjs` 里的 `serve.js` 路径是 `addin-wps\tools\serve.js`，不是 `tools\serve.js`。

---

## 3. 写清单(安装)

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File <repo>\addin-wps\tools\install.ps1
```

它会:
1. 把**安装前的原始状态**记到 `logs\orig-state.txt`(第一次运行才记, 之后不覆盖);
2. 建 `%APPDATA%\kingsoft\wps\jsaddons\` 并写 `publish.xml`;
3. 读回校验, 打印内容。

预期输出包含:

```
[state] ...logs\orig-state.txt
  captured=...
  jsaddons_existed=False
  publish_xml_existed=False
[write] OK ...\jsaddons\publish.xml
<jsplugins>
  <jspluginonline name="EditTrailProbe" type="et" url="http://127.0.0.1:39871/" .../>
</jsplugins>
```

---

## 4. 验证

1. **完全关闭** WPS 表格(所有 xlsx 窗口), 否则加载项不会重新加载。
2. 用 WPS 表格打开一个 `.xlsx`（任意一个小工作簿即可）。
   ⚠️ 只打开"开始页"、没有打开任何文档时 **不会加载**加载项 —— 这是实测行为, 不是故障。
3. 功能区应出现 **`EditTrail`** 标签页(在 `WPS AI` 右边)。点它 → 看到「写探针日志」「打开JS调试器」。
4. 点「写探针日志」, 然后看:

```powershell
Get-Content <repo>\addin-wps\logs\addin.log -Tail 5 -Encoding UTF8
```

应出现:

```json
{"k":"button","id":"btnTrailProbe","doc":{"name":"probe.xlsx","fullName":"D:\\...\\probe.xlsx","path":"D:\\...\\test","saved":true}}
```

5. 随便改一个单元格(输入内容后回车), 应立刻多一条 `{"k":"event","ev":"SheetChange",...}`。

---

## 5. 卸载 / 回滚

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File <repo>\addin-wps\tools\uninstall.ps1
```

规则:
- 首次安装前 `jsaddons` 目录**不存在** → 整棵删掉(精确还原);
- 原本就有 `jsaddons` → 只删 `publish.xml`(或用 `logs\publish.xml.bak` 还原), 保留目录与其它插件。

然后关掉服务器窗口。**不需要**重启 WPS; 下次启动 WPS 时加载项就不在了。
如果卸载后功能区还留着标签页, 是当前进程的缓存, 重启 WPS 即可。

**手工兜底**(连脚本都不想跑):

```powershell
Remove-Item "$env:APPDATA\kingsoft\wps\jsaddons" -Recurse -Force
```

---

## 6. 可选: 开机自动起服务器

把下面的快捷方式放进启动目录即可(不做也行, 只是每次手动跑):

```powershell
$lnk = "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Startup\edit-trail-serve.lnk"
$ws = New-Object -ComObject WScript.Shell
$s = $ws.CreateShortcut($lnk)
$s.TargetPath = 'node.exe'
$s.Arguments = '"<repo>\addin-wps\tools\serve.js" 39871'
$s.WindowStyle = 7          # 最小化
$s.Save()
```

取消自启: 删掉那个 `.lnk`。

---

## 7. 风险

| 风险 | 影响 | 处置 |
|---|---|---|
| 服务器没开 | 加载项静默不加载, WPS 不报错 | 检查端口 / 看 `logs\http.log` 有没有请求 |
| 端口 39871 被占 | 同上 | 换端口: 两个脚本 + `serve.js` 参数一起改 |
| 个人版日后更新移除该机制 | 加载项失效 | 属增量能力; `edit-trail` 主路径仍走文件级监听(L0), 不受影响 |
| `publish.xml` 被别的插件覆盖 | 本加载项消失 | 该文件是共享清单, 多插件应共存; 装前已备份 |
| 加载项有写本地文件的权限 | 理论上能写任意路径 | 本加载项只往 `logs\` 追加; 代码就在 `js\trail.js`, 可逐行审 |
| 改了 `%APPDATA%` 下的文件 | 不影响 WPS 安装本体 | 卸载即还原; 不碰 `office6` 安装目录 |

**回滚成本**: 一条 `Remove-Item` 或一次 `uninstall.ps1`。没有注册表改动, 没有系统级安装。

---

## 8. 排错

| 现象 | 先查什么 |
|---|---|
| 功能区没有 `EditTrail` | ①`logs\http.log` 有没有 `GET /manifest.xml` ②`publish.xml` 内容对不对(`install.ps1` 会打印) ③是不是只开了开始页没开文档 ④端口对不上 |
| http.log 有请求但页面报错 | 看 `logs\server.log` 尾部; 加载项 JS 报错会被 WPS 吞掉, 用 `EditTrail` 标签里的「打开JS调试器」看 console |
| 有事件日志但中文乱码 | `server.log` 是 URL 编码中转, 会有乱码; `addin.log` 是文件直写, 中文正常 —— 以 `addin.log` 为准 |
| 同一次编辑出现多条重复日志 | `OnAddinLoad` 可能被调用多次; 代码里 `_registered` 已去重, 若自己改代码记得保留 |
| 事件回调里 `Address` 报错 | `Range.Address` 是**函数**, 要 `Address()` 调用; `Selection` 可能为 null |
| 改过 `install.ps1` / `uninstall.ps1` 后报 `Unexpected token '}'` | 这两个脚本含中文, **必须存成 UTF-8 带 BOM**。无 BOM 时 PowerShell 5.1 会按 GBK 解码, 中文串码后可能吞掉引号导致语法错。用记事本的"另存为 → UTF-8 带 BOM", 或 `[System.IO.File]::WriteAllText($p,$t,(New-Object System.Text.UTF8Encoding $true))` |
