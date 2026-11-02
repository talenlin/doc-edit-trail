// EditTrail probe: 记录 WPS 编辑事件到本地日志
// 双通道: (1) wps.FileSystem.AppendFile 直接写文件  (2) XHR 到本地探针服务器(取证)
var Trail = (function () {
  var SRV = 'http://127.0.0.1:39871';
  // 日志目录：优先 %APPDATA%\edit-trail\logs（wps.Env 提供），取不到就退回页面相对目录
  var LOG_DIR = (function () {
    try { return String(wps.Env.GetAppDataPath()).replace(/\\/g, '/') + '/edit-trail/logs'; } catch (e) {}
    return 'edit-trail/logs';
  })();
  var LOG_FILE = LOG_DIR + '/addin.log';
  var _seq = 0;
  var _buf = [];
  var _fileMode = null;
  var _app = null;
  var _registered = false;

  function errStr(e) {
    if (!e) return String(e);
    try {
      if (e.message) return 'msg:' + e.message;
      if (e.description) return 'desc:' + e.description + ' num:' + e.number;
      return String(e);
    } catch (x) { return 'unstringifiable'; }
  }

  function safe(fn) {
    try { var v = fn(); return (v === undefined) ? 'undefined' : v; }
    catch (e) { return 'ERR:' + errStr(e); }
  }

  // ET 里 Range.Address / Selection.Address 实测是"函数"而非字符串属性, 必须调用
  function addrOf(rg) {
    if (!rg) return null;
    var a = rg.Address;
    if (typeof a === 'function') return String(a());
    return String(a);
  }
  function textOf(rg) {
    if (!rg) return null;
    try { return String(rg.Text); } catch (e) {
      try { return String(rg.Text()); } catch (e2) { return 'ERR:' + errStr(e); }
    }
  }
  function valOf(rg) {
    if (!rg) return null;
    try { return String(rg.Value2); } catch (e) {
      try { return String(rg.Value2()); } catch (e2) { return 'ERR:' + errStr(e); }
    }
  }

  function httpLog(obj) {
    try {
      var line = JSON.stringify(obj);
      var x = new XMLHttpRequest();
      x.open('GET', SRV + '/log?l=' + encodeURIComponent(line), true);
      x.send(null);
      return true;
    } catch (e) { return false; }
  }

  // 统一记录: HTTP + 文件(两条独立通道, 互不影响)
  function rec(obj) {
    obj.ts = new Date().toISOString();
    obj.seq = ++_seq;
    var line = JSON.stringify(obj);
    _buf.push(line);
    httpLog(obj);
    if (_fileMode) {
      try {
        if (_fileMode === '2arg') wps.FileSystem.AppendFile(LOG_FILE, line + '\r\n');
        else wps.FileSystem.AppendFile(LOG_FILE);
      } catch (e) { }
    }
    return line;
  }

  function fsCall(method, args, note) {
    var out = { k: 'fs_call', method: method, argc: args.length, note: note || '' };
    if (!(window.wps && wps.FileSystem)) { out.r = 'NO_FILE_SYSTEM'; httpLog(out); return out; }
    try {
      var r = wps.FileSystem[method].apply(wps.FileSystem, args);
      if (r === undefined) out.r = 'undefined';
      else if (typeof r === 'boolean') out.r = r;
      else out.r = String(r).substring(0, 400);
    } catch (e) { out.err = errStr(e); }
    httpLog(out);
    return out;
  }

  function probeFileSystem() {
    httpLog({ k: 'host', href: location.href, ua: navigator.userAgent,
              hasWps: typeof wps !== 'undefined',
              hasApplication: typeof Application !== 'undefined',
              wpsKeys: (typeof wps !== 'undefined') ? Object.keys(wps).join(',') : '' });
    fsCall('Exists', [LOG_DIR], 'logs dir exists?');
    fsCall('Mkdir', [LOG_DIR], 'mkdir logs (may fail if exists)');
    var a = fsCall('AppendFile', [LOG_FILE, 'PROBE-2ARG ' + new Date().toISOString() + '\n'], '2-arg append');
    var e1 = fsCall('Exists', [LOG_FILE], 'log file exists after 2arg?');
    var rf = fsCall('ReadFile', [LOG_FILE], 'read back');
    var readBack = (rf && typeof rf.r === 'string') ? rf.r : '';
    if (e1 && e1.r === true) {
      _fileMode = '2arg';
      rec({ k: 'fs_probe_result',
            verdict: (readBack && readBack !== 'undefined') ? 'WRITE_OK_2ARG' : 'WRITE_OK_2ARG_READFILE_UNUSABLE',
            readBackLen: readBack.length, readBackHead: readBack.substring(0, 200) });
    } else {
      var b = fsCall('AppendFile', [LOG_FILE], '1-arg append');
      var e2 = fsCall('Exists', [LOG_FILE], 'log file exists after 1arg?');
      _fileMode = (e2 && e2.r === true) ? '1arg' : null;
      rec({ k: 'fs_probe_result', verdict: _fileMode ? 'WRITE_PARTIAL_1ARG' : 'WRITE_UNAVAILABLE',
            append2: a ? (a.err || a.r) : 'n/a', append1: b ? (b.err || b.r) : 'n/a' });
    }
  }

  function docInfo() {
    var o = {};
    try {
      var wb = _app.ActiveWorkbook;
      if (wb) {
        o.name = safe(function () { return wb.Name; });
        o.fullName = safe(function () { return wb.FullName; });
        o.path = safe(function () { return wb.Path; });
        o.saved = safe(function () { return wb.Saved; });
      } else { o.workbook = 'none'; }
    } catch (e) { o.err = errStr(e); }
    o.selection = safe(function () { return addrOf(_app.Selection); });
    return o;
  }

  function handler(evName) {
    return function () {
      var a = arguments;
      var o = { k: 'event', ev: evName, argc: a.length };
      try {
        if (evName === 'SheetChange' || evName === 'SheetSelectionChange') {
          o.sheet = safe(function () { return a[0] ? a[0].Name : null; });
          var rg = a[1];
          if (rg) {
            o.address = safe(function () { return addrOf(rg); });
            o.text = safe(function () { return textOf(rg); });
            o.value = safe(function () { return valOf(rg); });
          }
        }
        var d = docInfo();
        for (var k in d) o['doc_' + k] = d[k];
      } catch (e) { o.err = errStr(e); }
      rec(o);
    };
  }

  // 注册事件: 只做一次 (实测 OnAddinLoad 会被调用多次, 需去重)
  function registerEvents() {
    var names = ['WorkbookOpen', 'NewWorkbook', 'WorkbookBeforeSave', 'WorkbookAfterSave',
                 'WorkbookBeforeClose', 'SheetActivate', 'SheetChange',
                 'SheetSelectionChange', 'WindowActivate', 'WindowDeactivate',
                 'DocumentOpen', 'PresentationOpen'];
    for (var i = 0; i < names.length; i++) {
      var n = names[i];
      try {
        _app.ApiEvent.AddApiEventListener(n, handler(n));
        rec({ k: 'listen_ok', ev: n });
      } catch (e) { rec({ k: 'listen_fail', ev: n, e: errStr(e) }); }
    }
  }

  function boot(tag) {
    if (_registered) { httpLog({ k: 'boot_skip_dup', tag: tag }); return; }
    _registered = true;
    try { _app = (typeof Application !== 'undefined') ? Application : wps.EtApplication(); }
    catch (e) { rec({ k: 'boot_err', tag: tag, e: errStr(e) }); return; }
    var info = { k: 'boot', tag: tag, hasApp: !!_app };
    info.appName = safe(function () { return _app.Name; });
    info.appVersion = safe(function () { return _app.Version; });
    info.build = safe(function () { return _app.Build; });
    info.hasApiEvent = safe(function () { return !!_app.ApiEvent; });
    info.wbCount = safe(function () { return _app.Workbooks.Count; });
    info.temp = safe(function () { return wps.Env.GetTempPath(); });
    info.appdata = safe(function () { return wps.Env.GetAppDataPath(); });
    info.home = safe(function () { return wps.Env.GetHomePath(); });
    info.installRoot = safe(function () { return wps.Env.GetRootPath(); });
    info.thisAddIn = safe(function () { return String(_app.CurrentWPSAddIn); });
    rec(info);
    registerEvents();
  }

  // 用 ribbonUI 激活自定义标签页(比模拟鼠标点击可靠)
  function activateTab() {
    var o = { k: 'activate_tab' };
    try {
      o.hasRibbonUI = !!_app.ribbonUI;
      o.methods = safe(function () {
        var ks = [], t = _app.ribbonUI;
        for (var k in t) ks.push(k);
        return ks.join(',');
      });
      _app.ribbonUI.ActivateTab('editTrailTab');
      o.r = 'ok';
    } catch (e) { o.err = errStr(e); }
    rec(o);
  }

  // 深度测试: 新建空白工作簿 -> 写单元格(期望 SheetChange) -> 关闭(期望 WorkbookBeforeClose)
  // 只操作自己新建的 Workbook, 不触碰任何已存在文档
  function deepTest(tag) {
    rec({ k: 'deep_start', tag: tag, wbCount: safe(function () { return _app.Workbooks.Count; }) });
    var wb = null;
    try { wb = _app.Workbooks.Add(); }
    catch (e) { rec({ k: 'deep_fail', step: 'add', e: errStr(e) }); return; }
    rec({ k: 'deep_added',
          name: safe(function () { return wb.Name; }),
          path: safe(function () { return wb.Path; }),
          wbCount: safe(function () { return _app.Workbooks.Count; }) });
    var sh = null;
    try { sh = wb.Sheets.Item(1); } catch (e) { rec({ k: 'deep_fail', step: 'sheet', e: errStr(e) }); }
    if (sh) {
      var v = 'editTrail deep ' + new Date().toISOString();
      try {
        sh.Cells.Item(1, 1).Value2 = v;
        rec({ k: 'deep_wrote', sheet: safe(function () { return sh.Name; }), value: v });
      } catch (e) { rec({ k: 'deep_fail', step: 'write', e: errStr(e) }); }
      rec({ k: 'deep_readback', v: safe(function () { return String(sh.Cells.Item(1, 1).Value2); }) });
    }
    setTimeout(function () {
      try { wb.Close(false); rec({ k: 'deep_closed', note: 'Close(false) 不保存' }); }
      catch (e) { rec({ k: 'deep_fail', step: 'close', e: errStr(e) }); }
    }, 2000);
  }

  function buttonAction(control) {
    var o = { k: 'button', id: safe(function () { return (control && (control.Id || control.id)) || 'unknown'; }) };
    o.doc = docInfo();
    _opt = o.doc;
    rec(o);
    if (_fileMode) rec({ k: 'button_filemode', mode: _fileMode });
  }
  var _opt;

  return { boot: boot, rec: rec, httpLog: httpLog, probeFileSystem: probeFileSystem,
           deepTest: deepTest, activateTab: activateTab, buttonAction: buttonAction,
           state: function () { return _buf; } };
})();

// 启动序列
(function () {
  setTimeout(function () { try { Trail.boot('t=0.5s'); } catch (e) { } }, 500);
  setTimeout(function () { try { Trail.probeFileSystem(); } catch (e) { } }, 1500);
  setTimeout(function () { try { Trail.activateTab(); } catch (e) { } }, 5000);
  setTimeout(function () { try { Trail.deepTest('t=9s'); } catch (e) { } }, 9000);
  setTimeout(function () { try { Trail.activateTab(); } catch (e) { } }, 16000);
  setTimeout(function () { try { Trail.rec({ k: 'heartbeat', t: '25s', alive: true }); } catch (e) { } }, 25000);
})();
