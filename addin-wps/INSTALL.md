# EditTrail WPS 加载项 — 安装手册（文字 / 表格 / 演示，三合一）

> 适用: **WPS Office 12.1.0.29680 个人版**（本机实测三宿主全部加载成功）。其它版本未测。
> 形态: **开发形态**——不需要开发者账号、不改注册表、不重装 WPS。
> 全部改动只落在两处: `%APPDATA%\kingsoft\wps\jsaddons\publish.xml` 与本目录。卸载脚本可精确还原。

---

## 0. 它现在能做什么

一套加载项包，同时挂到三个宿主（`et` 表格 / `wps` 文字 / `wpp` 演示），打开 `.xlsx`、`.docx`、`.pptx`
时功能区都会出现 **`EditTrail`** 标签页（在 `WPS AI` 右边），内含两个按钮：

| 按钮 | 作用 |
|---|---|
| **记检查点** | 把当前文档的 名称 / 完整路径 / 目录 / 是否已保存（文字另加 `TrackRevisions`、修订条数；演示另加幻灯片数）写进 `logs\addin.log` 与 `logs\server.log` |
| **修订开关** | 仅 WPS 文字可用：切换 `ActiveDocument.TrackRevisions`，把之后的编辑记成 Word 原生修订（带作者），`edittrail revisions` 能读 |

两个按钮各配一个 SVG 图标（`images\checkpoint.svg` 页面+对勾、`images\track-changes.svg` 页面+红色删除线），
由 `ribbon.xml` 的 `getImage="GetImage"` 回调返回相对路径。图标只在标签页**第一次渲染**时请求，
所以 `logs\http.log` 里出现 `GET /<host>/images/*.svg` 就说明图标已经生效（`images\` 目录必须随加载项一起部署）。

自动监听的事件（注册成功由 `logs\addin-events.jsonl` 的 `listeners` 记录确认）：

| 宿主 | 事件 |
|---|---|
| 表格 `et` | `NewWorkbook` `WorkbookOpen` `WorkbookBeforeSave` `WorkbookAfterSave` `WorkbookBeforeClose` `SheetChange` `SheetActivate` `WindowActivate` `WindowDeactivate` |
| 文字 `wps` | `DocumentOpen` `DocumentBeforeSave` `DocumentBeforeClose` `DocumentAfterClose` `WindowActivate` `WindowDeactivate` |
| 演示 `wpp` | `NewPresentation` `PresentationOpen` `PresentationBeforeSave` `PresentationBeforeClose` `PresentationSave` |

> 加载项只是**增量信号源**。权威修改轨迹来自文件级监听（`edittrail watch`），
> 加载项挂了或没开，轨迹不会丢——见根目录 `README.md` 的三层说明。

---

## 1. 前置条件

| 需要 | 说明 |
|---|---|
| Node.js | ≥ 20（本机 v24.15.0）。只用来跑静态服务器与 watcher。 |
| 一个空闲端口 | 默认 `39871`。要换端口，安装时 `-Port` 一起改。 |

**关键约束**: 加载项页面必须由 **http** 提供。`file://` 和"本地目录名"两种写法实测都**静默不加载**
（`RECON.md` 事实 #5）。所以第 2 步的服务器是必需的，不是可选优化。

---

## 2. 启动静态服务器（必须常驻）

一条命令拉起加载项服务 + 所有目录监听（真正后台，关掉终端也不停）：

```powershell
node <repo>\tools\launch.mjs
```

它读 `tools\watch-dirs.txt` 里的目录逐个起 watcher，把 pid 记到 `logs\service-pids.json`。配套命令：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File <repo>\tools\status-trail.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File <repo>\tools\stop-trail.ps1
```

开机自启：把 `node ... launch.mjs` 做成快捷方式放进
`%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\`（本机已建 `EditTrail.lnk`，删掉即取消）。

**只想单跑加载项服务**：`node <repo>\addin-wps\tools\serve.js 39871`。
看到 `[serve] http://127.0.0.1:39871 -> ...\addin-wps` 即成功。该进程同时托管页面、接收上报。
健康检查：`Invoke-WebRequest http://127.0.0.1:39871/health` → `{"ok":true,"hosts":["et","wps","wpp"],...}`。

> 关掉这个进程 = 加载项下次启动时不会加载；已打开窗口内的加载项不受影响。
> 注意 `serve.js` 的真实路径是 `addin-wps\tools\serve.js`，不是 `tools\serve.js`。

---

## 3. 写清单（安装）

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File <repo>\addin-wps\tools\install.ps1
```

它会:
1. 把安装前的原始状态记到 `logs\orig-state.txt`（第一次才记）；
2. 建 `%APPDATA%\kingsoft\wps\jsaddons\` 并写 **三条** `publish.xml`（同一份包、三个 URL）：

```xml
<jsplugins>
  <jspluginonline name="EditTrail" type="et"  url="http://127.0.0.1:39871/"     enable="enable_dev" .../>
  <jspluginonline name="EditTrail" type="wps" url="http://127.0.0.1:39871/wps/" enable="enable_dev" .../>
  <jspluginonline name="EditTrail" type="wpp" url="http://127.0.0.1:39871/wpp/" enable="enable_dev" .../>
</jsplugins>
```

3. 读回校验三个 `type` 都在；
4. `GET /health` 报告服务状态。

宿主由 `type` 决定，`/<host>/manifest.xml` 指向同一份 `manifest.xml`；
`/<host>/host.js` 会返回 `var EDIT_TRAIL_HOST = '<host>';`，页面据此选对象模型与事件表。

---

## 4. 验证（三宿主各一次）

**必须完全关闭 WPS**（所有 wps/wpp/et 窗口）再重开——WPS 只在组件启动时读 `publish.xml`。

```powershell
Get-Content <repo>\addin-wps\logs\http.log -Tail 20
Get-Content <repo>\addin-wps\logs\addin-events.jsonl -Tail 20
```

| 宿主 | 打开文件后应看到 | 实测证据（2026-11-03） |
|---|---|---|
| 表格 | `GET /et/manifest.xml → /et/ribbon.xml → /et/index.html → /et/host.js → trail.js → ribbon.js`；`listeners` 9 个事件全 ok | 关闭窗口时记到 `WorkbookBeforeClose`、`WindowDeactivate` |
| 文字 | `GET /wps/...` 同一序列；`listeners` 6 个事件全 ok；`boot.appName="Microsoft Word"` | `Ctrl+S` 后记到 `DocumentBeforeSave`；`open.doc.trackRevisions` 可读 |
| 演示 | `GET /wpp/...` 同一序列；`listeners` 5 个事件全 ok；`boot.appName="Microsoft PowerPoint"` | 关闭窗口时记到 `PresentationBeforeClose` |

补充：
- 功能区 `EditTrail` 标签页在三个宿主都应出现（本机已分别截图确认：文字、演示、表格各一张）。
- 演示宿主的 `open.doc.saved` 是 `-1`（WPS 该属性为三态：-1 未知 / 0 未保存 / true 已保存），不是错误。
- 只开"开始页"、没有打开文档时不会加载——这是实测行为。
- 加载项在文档打开**之前**就 boot（`open` 记录晚 1 秒左右）。

---

## 5. 卸载 / 回滚

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File <repo>\addin-wps\tools\uninstall.ps1
```

规则:
- 首次安装前 `jsaddons` 目录**不存在** → 整棵删掉（本机就是这种情况，精确还原）；
- 原本就有 → 只删 `publish.xml` 里 name 为 `EditTrail` 的三条，或用 `logs\publish.xml.bak` 还原，其它插件条目保留。

然后关掉服务器。不需要重启 WPS；下次启动时加载项就不在了（当前进程里的标签页是缓存，重启即消失）。

**手工兜底**：`Remove-Item "$env:APPDATA\kingsoft\wps\jsaddons" -Recurse -Force`。

---

## 6. 风险

| 风险 | 影响 | 处置 |
|---|---|---|
| 服务器没开 | 加载项静默不加载，WPS 不报错 | 检查端口 / `logs\http.log` 有没有请求 |
| 端口 39871 被占 | 同上 | 换端口：`install.ps1 -Port`、`serve.js` 参数、`launch.mjs` 一起改 |
| 个人版日后更新移除该机制 | 加载项失效 | 增量能力；主路径走文件级监听（L0），不受影响 |
| `publish.xml` 被别的插件覆盖 | 本加载项消失 | 该文件是共享清单；装前已备份，`uninstall.ps1` 只删自己三条 |
| 加载项有写本地文件权限 | 理论上能写任意路径 | 只往 `GetAppDataPath()/edit-trail/logs` 追加；代码在 `js\trail.js`，可逐行审 |
| 改了 `%APPDATA%` 下的文件 | 不影响 WPS 安装本体 | 卸载即还原；不碰 `office6` 安装目录 |

**回滚成本**：一条 `Remove-Item` 或一次 `uninstall.ps1`。没有注册表改动，没有系统级安装。

---

## 7. 排错

| 现象 | 先查什么 |
|---|---|
| 功能区没有 `EditTrail` | ①`logs\http.log` 有没有 `GET /<host>/manifest.xml` ②`publish.xml` 里对应 `type` 在不在 ③是否只开了开始页 ④端口对不对 ⑤改完 `publish.xml` 后是否**完全重启**了 WPS |
| 只有一个宿主有标签页 | 看 `%APPDATA%\kingsoft\wps\jsaddons\authaddin.json` 里有没有该宿主的条目；缺的那个宿主可能还没真正打开过文档（组件没起来就不会注册） |
| http.log 有请求但页面报错 | 看 `logs\server.log` 尾部；WPS 会吞 JS 报错，用标签页里的调试入口看 console |
| 有事件日志但中文乱码 | `server.log` 是 URL 编码中转，可能乱码；`addin-events.jsonl` / `addin.log` 是直写，以它们为准 |
| 同一次编辑多条重复日志 | `OnAddinLoad` 会被调用多次，代码里 `_ready` 已去重；改代码要保留 |
| 事件回调里 `Address` 报错 | `Range.Address` 是**函数**，要 `Address()`；`Selection` 可能为 null |
| 改过 `.ps1` 后报语法错 | 这两个脚本必须存成 **UTF-8 带 BOM**；无 BOM 时 PS5.1 按 GBK 解码会吞引号 |
