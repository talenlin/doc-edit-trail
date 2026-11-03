# WPS 加载项侦察报告 (RECON)

> 目标: 判断能否在用户这台 WPS 上安装自定义 JS 加载项, 以及在加载项里能拿到什么事件/什么写入能力。
> 机器: WPS Office **12.1.0.29680 个人版** (x86), `%LOCALAPPDATA%\Kingsoft\WPS Office\12.1.0.29680`
> 侦察时间: 2026-11-02 15:5x–16:0x (Asia/Shanghai)
> 所有"实测"项都在本机真跑过, 证据文件见末尾索引。

---

## 0. 一句话结论

**能装, 而且不用改注册表、不用开发者账号、不用重装 WPS。** 往
`%APPDATA%\kingsoft\wps\jsaddons\publish.xml` 写一条清单, 指向一个**本地 HTTP 服务**托管的加载项包即可;
WPS 个人版会正常加载并在功能区出现自定义标签页。加载项里可以监听 `SheetChange` 等事件、可以直接用
`wps.FileSystem.AppendFile` 往任意本地路径追加日志 —— 不需要外部守护进程帮忙写文件。

**唯一硬约束: `url` 必须是 http(s)。** `file://` 与"相对目录名"两种形态实测都静默不加载, 所以必须有一个
常驻的本地静态服务器 (端口无限制, 本机用 39871)。

---

## 1. 事实表

置信度: **高** = 实测跑通并看到证据; **中** = 从官方源码/类型定义读出但未逐条实测; **低** = 推断。

| # | 结论 | 证据 | 怎么验证的 | 置信 |
|---|---|---|---|---|
| 1 | 清单路径是 `%APPDATA%\kingsoft\wps\jsaddons\publish.xml` | `office6\addons\jsapi\jsapisubserver.dll` 内含字符串 `/wps/jsaddons/publish.xml`; 官方 `wpsjs` 源码 `src\lib\debug_publish.js` 里 `path.resolve(process.env.APPDATA,'kingsoft/wps/jsaddons/publish.xml')` | 二进制串扫描 + 官方源码, 再实写该文件验证生效 | 高 |
| 2 | 清单格式 `<jsplugins><jspluginonline name type url debug enable="enable_dev" install="null" customDomain=""/>` | `wpsjs\src\lib\debug_publish.js` 的 `configPublish()` 拼装属性; 实写后加载成功 | 抄官方形状写入, 亲眼看到加载项加载 | 高 |
| 3 | 本机会走 `publish.xml` 新机制 (不是老的 `jsplugins.xml`) | `office6\cfgs\setup.cfg`: `FirstVersion=1`、`Version=29680`; `wpsjs\src\lib\debug.js` 的 `needPublishDebug()` 判据 `firstVer=='1' && version>='16910'` | 读 setup.cfg + 读官方判据源码 | 高 |
| 4 | **个人版可以加载自定义 JS 加载项** | UA `... WpsOfficeApp/12.1.0.29680 (per,windows)`; 加载后 `Application.Name`='Microsoft Excel'、`Version`='12.0'、`Build`=29680 | 加载项自己把 UA 和 `Application.Build` 回传, 同时屏幕截图看到自定义标签页 | 高 |
| 5 | **`url` 必须是 http(s)** —— `file://` 与相对目录名都不加载, 且无报错 | 三种形态同机对比: `file:///D:/...` delta=0、`url="EditTrail_0.1.0/"` delta=0、`http://127.0.0.1:39871/` delta=15 条日志 | 同一份代码换 3 种 `url` 各重启一次 et 观察 | 高 |
| 6 | 加载顺序: `GET /manifest.xml` → `/ribbon.xml` → `/index.html` → `/main.js` → `/js/*.js` | `logs/http.log` 逐条 200 | 静态服务器访问日志 | 高 |
| 7 | **只有打开了真实文档才会加载加载项**; 空白"开始页"不会 | 无参启动 et: 探针服务器 0 请求; 带 `probe.xlsx` 启动: 立即 6 条请求 | 两次对照启动 | 高 |
| 8 | 加载项包需要: `manifest.xml`、`ribbon.xml`、`index.html`、`main.js`、`js/*.js`; `package.json` 只是给 `wpsjs` CLI 用的 | 删掉 `manifest.xml`/`ribbon.xml` 会 404; 模板 `packages\@wps-jsapi\et\` 结构; 我的包里 `package.json` 运行期未被请求 | 观察访问日志里实际被 GET 的文件 | 高 |
| 9 | `manifest.xml` 字段: `<JsPlugin><ApiVersion>1.0.0</ApiVersion><Name>EditTrailProbe</Name><Description>…</Description></JsPlugin>` | 模板同名文件; 实跑通过 | 实跑 | 高 |
| 10 | `ribbon.xml` 是 Office customUI 2006/01 命名空间, `onLoad="OnAddinLoad"` | `<customUI xmlns="http://schemas.microsoft.com/office/2006/01/customui" onLoad="OnAddinLoad">` 实跑后 `OnAddinLoad` 被调用, 标签页出现 | 实跑 + 截图 | 高 |
| 11 | WPS 会给 JS 加载项**自动追加一个「打开JS调试器」按钮** | 截图里我的 tab 下有 `写探针日志`(我定义的) + `打开JS调试器`(WPS 自动加的) | 屏幕截图 | 高 |
| 12 | `ribbonUI` 方法集: `Invalidate, ActivateTab, InvalidateControl, ActivateTabQ, ActivateTabInvalidate, ActivateTabMso, InvalidateControlMso, ExpandOrCollapseRibbon, SetEnabledCloudSync` | `{"k":"activate_tab","hasRibbonUI":true,"methods":"…","r":"ok"}` | 枚举 `Application.ribbonUI` 的键 | 高 |
| 13 | **ET 可注册的 10 个事件全部成功**: `WorkbookOpen`/`NewWorkbook`/`WorkbookBeforeSave`/`WorkbookAfterSave`/`WorkbookBeforeClose`/`SheetActivate`/`SheetChange`/`SheetSelectionChange`/`WindowActivate`/`WindowDeactivate` | 10 条 `{"k":"listen_ok","ev":…}` | `AddApiEventListener` 逐个注册 | 高 |
| 14 | 注册**别的宿主的**事件会抛明确错误: `"DocumentOpen is not a valid event name."` / `"PresentationOpen is not a valid event name."` | `listen_fail` 两条, 错误原文见上 | 故意注册 wps/wpp 事件 | 高 |
| 15 | **`SheetChange` 真实触发**, 带 sheet 名 + 单元格文本/值 | `{"k":"event","ev":"SheetChange","argc":2,"sheet":"Sheet1","text":"editTrail deep …","value":"editTrail deep …"}` | 程序内 `Workbooks.Add()` → `Cells.Item(1,1).Value2='…'` | 高 |
| 16 | `NewWorkbook`、`WindowActivate`、`WindowDeactivate`、`WorkbookBeforeClose` 也真实触发 | 同批日志 seq 16–25 | 同上 | 高 |
| 17 | 回调实参: `SheetChange(WorkSheet, Range)`; `a[0].Name`=表名, `a[1].Text`/`a[1].Value2` 可读 | 同 #15 | 同上 | 高 |
| 18 | **`Range.Address` / `Selection.Address` 是函数, 必须 `Address()` 调用**; 直接拼字符串会得到 `function Address() { [native code] }` | 探针第一版输出 `"address":"function Address() { [native code] }"` | 试错对比 | 高 |
| 19 | `Application.Selection` 在某些时机是 null, 调用 `.Address()` 报 `Address called on null or undefined` | `"selection":"ERR:msg:Address called on null or undefined"` | 按钮回调里取 Selection | 高 |
| 20 | **`wps.FileSystem.AppendFile(path, data)` 双参数可用**, 返回 `true`; `ReadFile` 能读回; `Exists` 正常; 支持 `D:/...` 绝对路径 | `{"method":"AppendFile","argc":2,"r":true}`、`{"method":"ReadFile","r":"PROBE-2ARG …"}`; `logs\addin.log` 里中文正常 | 直接调用并读回比对 | 高 |
| 21 | `Mkdir` 对已存在目录返回 `false` 而不抛异常 | `{"method":"Mkdir","r":false}` | 同上 | 高 |
| 22 | 类型定义里**没有** `WriteFile` (被注释 + 标 todo), 只有 AppendFile —— 追加够用, 覆盖写不可用 | `wps-jsapi@1.0.5` 的 `src/index.d.ts`: `// export function WriteFile(path, data): void;` | 读官方类型包 | 高 |
| 23 | **没有 `require` / node 内置模块 / `process` / `__dirname`**; 但有浏览器 `XMLHttpRequest` | `index.d.ts` 全文 0 命中; 我的 XHR 上报一直正常 | 读类型定义 + 实跑 | 高 |
| 24 | `wps.Env` 路径: `GetAppDataPath()`=`%APPDATA%`、`GetTempPath()`=`…/AppData/Local/Temp`、`GetHomePath()`=`%USERPROFILE%`、`GetRootPath()`=`C:/` | boot 日志 | 直接调用 | 高 |
| 25 | **`OnAddinLoad` 会被调用不止一次** (实测 2 次), 事件注册必须自己去重, 否则重复回调 | 第一版日志里 10 个事件出现两遍 (seq 2–11 与 16–25) | 数日志 | 高 |
| 26 | 部署**不需要改注册表**; `HKCU\Software\Kingsoft\Office\6.0` 下没有任何 jsaddons 键, 也能装 | 安装前后注册表无变化, 加载项正常工作 | 实装 | 高 |
| 27 | 本构建**没有**为"本地目录形态"启动内置 HTTP 服务 (et 进程无监听端口) | `Get-NetTCPConnection -State Listen` 过滤 et 进程 PID → 空 | 端口枚举 | 高 |
| 28 | `OnAddinLoad` 里拿不到 `Application` 之外的 node 能力; 但 `Application.ExecFunc`/`DebugTools`/`JSIDE` 等存在 | Application 暴露 500+ 成员, 完整键名见 `logs/server.log` 的 `k:"host"` 行 | 枚举 `Application` 键 | 中 |
| 29 | 加载项自身的名字/ID 从 `Application.CurrentWPSAddIn` 可取 | boot 日志 `"thisAddIn":"[object Object]"` | 实跑 (只证明存在) | 中 |
| 30 | `wps`（文字）宿主事件集: `DocumentOpen`/`DocumentBeforeClose`/`DocumentBeforeSave`/`DocumentAfterClose`/`WindowActivate`/`WindowDeactivate`/`WindowSelectionChange`/`SelectionAfterStyleChange` | 官方 `wps-jsapi@1.0.5` `index.d.ts` | 读类型定义 | 中 |
| 31 | `wpp`（演示）宿主事件集: `NewPresentation`/`PresentationOpen`/`PresentationBeforeClose`/`PresentationBeforeSave`/`PresentationSave` | 同上 | 读类型定义 | 中 |
| 32 | 用官方 `wpsjs` CLI 一键装 (`wpsjs debug`) 需要 `npm i -g wpsjs` + 起 vite; 不必用, 手写 publish.xml 等价 | `wpsjs@2.2.3` 源码 | 读源码 (未跑 CLI) | 中 |

---

## 2. 部署格式 (可直接抄)

### 2.1 清单: `%APPDATA%\kingsoft\wps\jsaddons\publish.xml`

```xml
<jsplugins>
  <jspluginonline name="EditTrail" type="et" url="http://127.0.0.1:39871/" debug="" enable="enable_dev" install="null" customDomain=""/>
</jsplugins>
```

- `type`: `et`(表格) / `wps`(文字) / `wpp`(演示); 一个加载项只服务一种宿主, 三种要装三条。
- `url`: **必须 http(s)**, 末尾斜杠建议带上。它是"网页根", WPS 自己按下面顺序去取:
  `manifest.xml` → `ribbon.xml` → `index.html` → `index.html` 里 `<script src>` 引的脚本。
- `enable="enable_dev"`: 官方脚手架就用这个值; 其它取值未实测。
- XML 声明 `<?xml …?>` **不是必需**; 文件请存成 **UTF-8 无 BOM**。
- 目录 `jsaddons` 原本不需要存在, 建出来写这一个文件即可。

### 2.2 加载项包

```
<任意目录, 由你的静态服务器托管>
├── manifest.xml     <JsPlugin><ApiVersion>1.0.0</ApiVersion><Name>…</Name><Description>…</Description></JsPlugin>
├── ribbon.xml       customUI 2006/01, onLoad="OnAddinLoad", 定义 tab/group/button
├── index.html       入口页
├── main.js          document.write 注入 js/*.js
├── js/ribbon.js     OnAddinLoad / OnAction 等回调
└── js/trail.js      事件监听与写日志
```

`index.html` 极简示例:

```html
<!DOCTYPE html><html><head><meta charset="utf-8"><title>EditTrail</title></head>
<body><script src="./main.js"></script></body></html>
```

`main.js`:

```js
document.write('<script language="javascript" src="js/ribbon.js"></script>');
document.write('<script language="javascript" src="js/trail.js"></script>');
```

---

## 3. 运行时能力清单

### 3.1 事件 (`Application.ApiEvent`)
```js
Application.ApiEvent.AddApiEventListener('SheetChange', function (sheet, range) { … });
Application.ApiEvent.RemoveApiEventListener('SheetChange', fn);
```
- 事件名**按宿主白名单**校验, 写错/跨宿主直接抛 `"<name> is not a valid event name."`。
- ET 实测可注册 10 个 (见事实表 #13), 其中 5 个实测真实触发。
- **`SheetChange` 只给"改完之后"的表名+范围+新值, 不给旧值** → 要做"版本变化"必须自己在内存里维护
  每个单元格的上一次值 (`Map<book!sheet!addr, value>`), 事件到达时比对后再写日志。
- 文字 (.docx) 没有"边打字边触发"的事件, 只有 `DocumentBeforeSave` 这类保存时机事件 →
  **docx 的实时修改流拿不到, 只能保存时快照 + 外部 diff** (正好落在 L0 那层)。

### 3.2 文件写入
```js
wps.FileSystem.Exists(p)        // boolean
wps.FileSystem.Mkdir(p)         // 已存在返回 false, 不抛
wps.FileSystem.AppendFile(p, s) // true; 路径可以是 D:/... 绝对路径
wps.FileSystem.ReadFile(p)      // string
wps.FileSystem.Remove(p)
```
没有 `WriteFile`。日志就用 `AppendFile` 追加 JSONL。

### 3.3 其它有用面
- `wps.Env.GetAppDataPath()` 等 4 个路径。
- `wps.PluginStorage.setItem/getItem` 跨页面持久化小状态。
- `wps.OAAssist.WebNotify(msg, force)` 弹提示; `wps.CreateTaskPane(url,title)` 侧边任务窗格;
  `wps.ShowDialog(url,…)` 弹窗; `Application.ShowDevTools` / `JSIDE` 调试。
- **没有 node**: 不能直接读注册表、不能起进程、不能 require 任何东西。要"干重活"只能
  ① XHR 打给自己的本地服务 ② `OAAssist.ShellExecute` 起外部程序 (未实测)。

---

## 4. 卡点与风险

| 风险 | 说明 | 缓解 |
|---|---|---|
| **必须有常驻 HTTP 服务** | `file://`/相对目录都不加载, 服务停了加载项就静默消失 | 把静态服务和日志收集器合并成一个小 Node 进程, 开机自启 |
| 静默失败 | 服务没起 / xml 写错 / 端口占用 → 不报错, 只是没加载 | 安装脚本做读回校验; 提供自检按钮 |
| 加载时机 | 只有"打开文档"才加载; 空白开始页不加载 | 正常使用无影响; 但"从开始页新建"要注意 |
| `SheetChange` 无旧值 | 见 3.1 | 加载项内维护影子缓存 |
| `OnAddinLoad` 重复调用 | 事件会被注册多次 → 日志重复 | `_registered` 标志去重 |
| `Address` 是函数 | 见 #18 | 统一 `addrOf()` 封装 |
| `Selection` 可能 null | 见 #19 | try/catch |
| 个人版未来更新可能变 | 官方脚手架是"开发模式"用途, 属半公开能力 | 只当增量信号源, 不当作唯一真相源; L0 文件级监听兜底 |
| 端口冲突 | 39871 被占则加载项全灭 | 端口写进配置, 启动前检测 |

---

## 5. 对 edit-trail 架构的含义

1. **L1 (宿主内) 在本机可行**, 但它是"增强项", 不是必需品: 一旦服务没起就完全失效。
   所以 **L0 (文件级监听 + OOXML 快照 diff) 仍应是主路径**, L1 用来补"还停在内存里没保存"的那部分。
2. L1 最有价值的输出不是"完整的修改流", 而是**廉价的高质量锚点**:
   `WorkbookBeforeSave` / `WorkbookAfterSave` 给出的"某次保存发生了 + 文件路径 + 时间"。
   有了这个, 外部 diff 引擎不用轮询猜。
3. 表格(.xlsx)是 L1 收益最大的场景 (`SheetChange` 给到单元格级); docx 只有保存时机, 收益小。
4. 落地形态建议: 一个 Node 进程同时做 ①静态托管 ②接收加载项事件写 JSONL ③可选地触发快照。
   加载项自身再用 `AppendFile` 写一份本地副本, 两条通道互为备份。

---

## 6. 未确证 / 不要当结论用

- ~~wps.exe / wpp.exe 的加载项是否同样顺畅~~ —— **已实测跑通**，见 §8。三宿主共用一套包，
  `type` 决定宿主，`/<host>/host.js` 注入宿主标识；三宿主的事件 API 都只在 `wps.ApiEvent` 上，
  `trail.js` 做了 `Application.ApiEvent → wps.ApiEvent → 全局 ApiEvent` 三级回退。
- `DocumentBeforeSave` / `DocumentAfterSave` 之外的保存时机事件在 wps 宿主上的真实触发 (仅从类型定义读到)。
- `OAAssist.ShellExecute` 能否真的起外部 exe (未实测)。
- `PluginStorage` 的容量与持久化位置 (未实测)。
- 官方 `wpsjs` CLI 全流程 (未运行, 只读源码)。
- 非 12.1.0.29680 版本的兼容性 (只本机这一版验证过)。

---

## 7. 证据与复现

侦察时的原始证据（运行日志、屏幕截图、DLL 字符串扫描结果、官方 SDK 解包）没有随仓库发布：
日志里含本机路径与用户文档名，SDK 解包是第三方代码，都不适合放进公开仓库。

上表的每条"高置信"结论都可以在 10 分钟内自己复现：

1. `node addin-wps/tools/serve.js 39871` 起服务，看 `logs/http.log` 是否出现
   `GET /manifest.xml → /ribbon.xml → /index.html → /main.js → /js/*.js`（对应 #6、#8）；
2. 跑 `addin-wps/tools/install.ps1`，重启 WPS 表格并打开任意 `.xlsx`，功能区应出现
   `EditTrail` 标签页（对应 #4、#7、#10、#11）；
3. 点「记检查点」（文字宿主点「修订开关」）、改一个单元格或保存一次，看 `logs/addin-events.jsonl` 里的 `button` / `event` 行
   （对应 #15–#19、#20、#25）；
4. 把 `publish.xml` 的 `url` 改成 `file:///…` 重启一次 et，观察加载项不再加载且无报错（对应 #5）。

---

## 8. 三宿主实测（2026-11-03，加载项 v0.2.0）

一套包挂三个 `type`，同一 HTTP 服务按 `/<host>/` 路由；`/<host>/host.js` 返回
`var EDIT_TRAIL_HOST = '<host>';`，页面据此选对象模型与事件表。

| 宿主 | `publish.xml` url | boot `appName` | 注册成功的事件 | 实测触发 |
|---|---|---|---|---|
| 表格 et | `http://127.0.0.1:39871/` | `Microsoft Excel` | 9 个：NewWorkbook / WorkbookOpen / WorkbookBeforeSave / WorkbookAfterSave / WorkbookBeforeClose / SheetChange / SheetActivate / WindowActivate / WindowDeactivate | `WorkbookBeforeClose`、`WindowDeactivate`（关闭窗口） |
| 文字 wps | `http://127.0.0.1:39871/wps/` | `Microsoft Word` | 6 个：DocumentOpen / DocumentBeforeSave / DocumentBeforeClose / DocumentAfterClose / WindowActivate / WindowDeactivate | `DocumentBeforeSave`（Ctrl+S） |
| 演示 wpp | `http://127.0.0.1:39871/wpp/` | `Microsoft PowerPoint` | 5 个：NewPresentation / PresentationOpen / PresentationBeforeSave / PresentationBeforeClose / PresentationSave | `PresentationBeforeClose`（关闭窗口） |

请求顺序（三宿主一致，见 `logs/http.log`）：
`GET /<host>/manifest.xml → /<host>/ribbon.xml (499B) → /<host>/index.html (460B) → /<host>/host.js → /<host>/js/trail.js → /<host>/js/ribbon.js`

### 新发现（在 §1–§3 之外）

1. **`Application.ApiEvent` 在本机三宿主都不存在**。ET 侦察期用的是 `_app.ApiEvent`（当时可用），
   现在 ET/Writer/Presentation 一致只有 `wps.ApiEvent` → `trail.js` 的 `apiEvent()` 做
   `Application.ApiEvent → wps.ApiEvent → 全局 ApiEvent` 三级回退，`listeners.source` 字段记录命中的是哪一层。
2. **`authaddin.json` 按宿主惰性生成**：`%APPDATA%\kingsoft\wps\jsaddons\authaddin.json` 里
   `et` / `wps` / `wpp` 分别是独立条目，某宿主第一次真正启动（组件进程起来）才登记。
   Presentation 首次启动到加载项真正被请求之间隔了约 90 秒（被第三方 iSlide 面板拖慢），
   期间 `http.log` 无任何 `/wpp/` 请求——**不要据此判定加载失败**，看 `addin-events.jsonl` 更可靠。
3. **演示宿主的 `Saved` 是三态**：`-1` 未知 / `0` 未保存 / `true` 已保存。`open.doc.saved = -1` 不是错误。
4. `publish.xml` 只在组件启动时读一次；改完必须**完全退出 WPS**（所有 wps/et/wpp 进程）再开。
5. 关闭窗口用 `WM_CLOSE` 是验证关闭类事件最稳的办法（不需要 UI 自动化，也不会真的丢内容）。

### 仍未验证

- 演示宿主的保存事件（`PresentationBeforeSave` / `PresentationSave`）没有直接观测到（只观测了关闭）。
- 功能区按钮的真实点击（「记检查点」「修订开关」）未做 UI 自动化；`TrackRevisions` 切换后
  文档是否带 `w:ins` 作者标记，尚未端到端验证。
- Excel `SheetChange` 在新代码路径下未重新触发（侦察期用旧版验证过，事件名相同）。
- 非 12.1.0.29680 版本的兼容性。
