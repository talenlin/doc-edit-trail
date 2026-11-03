// EditTrail add-in — records editing / save events from inside WPS.
//
// One package serves all three WPS components. serve.js injects
// /<host>/host.js so this page knows whether it runs in
//   et  = WPS Spreadsheets
//   wps = WPS Writer
//   wpp = WPS Presentation
// and registers only the events that host actually supports.
//
// Channels (both best-effort, neither can block editing):
//   1) HTTP POST to the local EditTrail service. The service is required anyway
//      because WPS only loads add-ins over http(s).
//   2) wps.FileSystem.AppendFile -> <AppData>/edit-trail/logs/addin.log
//
// Privacy: records carry file name / path / counters / event names only.
// Document text is never sent, except the single cell value an ET SheetChange
// event already hands to the callback.
var Trail = (function () {
  var VERSION = '0.2.0';
  var SRV = 'http://127.0.0.1:39871';

  var HOSTS = {
    wps: {
      label: 'Word',
      docProp: 'ActiveDocument',
      docNoun: '文档',
      events: ['DocumentOpen', 'DocumentBeforeSave', 'DocumentBeforeClose',
               'DocumentAfterClose', 'WindowActivate', 'WindowDeactivate']
    },
    et: {
      label: 'Excel',
      docProp: 'ActiveWorkbook',
      docNoun: '工作簿',
      events: ['NewWorkbook', 'WorkbookOpen', 'WorkbookBeforeSave', 'WorkbookAfterSave',
               'WorkbookBeforeClose', 'SheetChange', 'SheetActivate',
               'WindowActivate', 'WindowDeactivate']
    },
    wpp: {
      label: 'PowerPoint',
      docProp: 'ActivePresentation',
      docNoun: '演示文稿',
      events: ['NewPresentation', 'PresentationOpen', 'PresentationBeforeSave',
               'PresentationBeforeClose', 'PresentationSave']
    }
  };

  var HOST = (typeof EDIT_TRAIL_HOST === 'string' && EDIT_TRAIL_HOST)
    ? EDIT_TRAIL_HOST : detectHost();
  var def = HOSTS[HOST] || HOSTS.et;

  var _seq = 0;
  var _buf = [];
  var _app = null;
  var _ready = false;
  var _fileMode = null;
  var _logDir = '';
  var _logFile = '';
  var _last = '';

  function errStr(e) {
    if (!e) return String(e);
    try {
      if (e.message) return 'msg:' + e.message;
      if (e.description) return 'desc:' + e.description + ' num:' + e.number;
      return String(e);
    } catch (x) { return 'unstringifiable'; }
  }

  function safe(fn) {
    try {
      var v = fn();
      return (v === undefined) ? 'undefined' : v;
    } catch (e) { return 'ERR:' + errStr(e); }
  }

  // host.js is authoritative; this is only a fallback for hand-opened pages.
  function detectHost() {
    try {
      if (typeof wps !== 'undefined') {
        if (Application && Application.ActivePresentation) return 'wpp';
        if (Application && Application.ActiveDocument) return 'wps';
        if (Application && Application.ActiveWorkbook) return 'et';
      }
    } catch (e) {}
    try {
      if (typeof wps !== 'undefined' && wps.WppApplication && wps.WppApplication()) return 'wpp';
    } catch (e) {}
    return 'et';
  }

  function getApp() {
    try {
      if (typeof wps !== 'undefined') {
        if (HOST === 'wps' && wps.WpsApplication) return wps.WpsApplication();
        if (HOST === 'wpp' && wps.WppApplication) return wps.WppApplication();
        if (HOST === 'et' && wps.EtApplication) return wps.EtApplication();
      }
    } catch (e) {}
    try { if (typeof Application !== 'undefined') return Application; } catch (e) {}
    return null;
  }

  function appDataPath() {
    try {
      var p = wps.Env.GetAppDataPath();
      if (p) return String(p);
    } catch (e) {}
    return '';
  }

  function initFileLog() {
    if (_fileMode !== null) return _fileMode;
    _fileMode = 'off';
    try {
      if (typeof wps === 'undefined' || !wps.FileSystem) return _fileMode;
      var base = appDataPath().replace(/\\/g, '/');
      // only use absolute paths; a relative one would land in an unknown cwd
      if (!base || base.charAt(1) !== ':') return _fileMode;
      _logDir = base + '/edit-trail/logs';
      _logFile = _logDir + '/addin.log';
      try { wps.FileSystem.Mkdir(_logDir); } catch (e) {}
      _fileMode = '2arg';
    } catch (e) { _fileMode = 'off'; }
    return _fileMode;
  }

  function fileAppend(line) {
    if (initFileLog() !== '2arg') return false;
    try {
      wps.FileSystem.AppendFile(_logFile, line + '\r\n');
      return true;
    } catch (e) {
      _fileMode = 'off';
      return false;
    }
  }

  function httpPost(line) {
    try {
      var x = new XMLHttpRequest();
      x.open('POST', SRV + '/log', true);
      x.setRequestHeader('Content-Type', 'application/json; charset=utf-8');
      x.send(line);
      return true;
    } catch (e) { return false; }
  }

  function rec(obj) {
    obj.ts = new Date().toISOString();
    obj.seq = ++_seq;
    obj.host = obj.host || HOST;
    obj.hostLabel = obj.hostLabel || def.label;
    obj.addin = VERSION;
    var line = JSON.stringify(obj);
    _buf.push(line);
    if (_buf.length > 200) _buf.splice(0, _buf.length - 200);
    httpPost(line);
    fileAppend(line);
    return line;
  }

  function docInfo() {
    var o = { host: HOST };
    var a = _app || getApp();
    if (!a) { o.state = 'no-app'; return o; }
    var d = null;
    try { d = a[def.docProp]; } catch (e) { o.err = errStr(e); }
    if (!d) { o.state = 'no-doc'; return o; }
    o.state = 'ok';
    o.name = safe(function () { return d.Name; });
    o.fullName = safe(function () { return d.FullName; });
    o.path = safe(function () { return d.Path; });
    o.saved = safe(function () { return d.Saved; });
    if (HOST === 'wps') {
      o.trackRevisions = safe(function () { return d.TrackRevisions; });
      o.revisions = safe(function () { return d.Revisions ? d.Revisions.Count : null; });
    } else if (HOST === 'wpp') {
      o.slides = safe(function () { return d.Slides ? d.Slides.Count : null; });
    } else {
      o.sheets = safe(function () { return d.Sheets ? d.Sheets.Count : null; });
    }
    return o;
  }

  function handler(name) {
    return function () {
      var a = arguments;
      var o = { k: 'event', ev: name, argc: a.length };
      try {
        if (HOST === 'et') {
          if (name === 'SheetChange' || name === 'SheetActivate') {
            o.sheet = safe(function () { return a[0] ? a[0].Name : null; });
            var rg = a[1];
            if (rg) {
              o.address = safe(function () {
                var v = rg.Address;
                return (typeof v === 'function') ? String(v()) : String(v);
              });
              o.text = safe(function () {
                try { return String(rg.Text); }
                catch (e) { return String(rg.Text()); }
              });
            }
          }
        } else if (HOST === 'wps' && (name === 'DocumentBeforeSave' || name === 'DocumentAfterClose')) {
          // Word has no text-change event; the save is the useful checkpoint.
          o.doc = docInfo();
        }
        if (!o.doc) o.doc = docInfo();
      } catch (e) { o.err = errStr(e); }
      rec(o);
    };
  }

  // ApiEvent lives on Application in Spreadsheets, but is exposed on the
  // wps namespace in Writer/Presentation; try all three before giving up.
  function apiEvent() {
    try { if (_app && _app.ApiEvent) return { api: _app.ApiEvent, src: 'Application.ApiEvent' }; } catch (e) {}
    try { if (typeof wps !== 'undefined' && wps.ApiEvent) return { api: wps.ApiEvent, src: 'wps.ApiEvent' }; } catch (e) {}
    try { if (typeof ApiEvent !== 'undefined' && ApiEvent) return { api: ApiEvent, src: 'global.ApiEvent' }; } catch (e) {}
    return null;
  }

  function register() {
    var ok = [], fail = [];
    var found = apiEvent();
    if (!found) {
      rec({ k: 'listeners', ok: ok, fail: ['NO_API_EVENT'] });
      return;
    }
    for (var i = 0; i < def.events.length; i++) {
      var n = def.events[i];
      try {
        found.api.AddApiEventListener(n, handler(n));
        ok.push(n);
      } catch (e) {
        fail.push(n + ':' + errStr(e));
      }
    }
    rec({ k: 'listeners', ok: ok, fail: fail, source: found.src });
  }

  function boot(tag) {
    if (_ready) {
      rec({ k: 'boot_dup', tag: tag });
      return;
    }
    _ready = true;
    _app = getApp();
    rec({
      k: 'boot',
      tag: tag,
      appName: safe(function () { return _app ? _app.Name : null; }),
      appVersion: safe(function () { return _app ? _app.Version : null; }),
      hasApiEvent: safe(function () { return !!(_app && _app.ApiEvent); }),
      hasNamespaceApiEvent: safe(function () { return (typeof wps !== 'undefined') && !!wps.ApiEvent; }),
      hasGlobalApiEvent: safe(function () { return (typeof ApiEvent !== 'undefined') && !!ApiEvent; }),
      appdata: appDataPath(),
      fileMode: initFileLog(),
      href: String(location.href),
      ua: String(navigator.userAgent)
    });
    register();
    // One snapshot once the document is really there.
    setTimeout(function () {
      try { rec({ k: 'open', doc: docInfo() }); } catch (e) {}
    }, 900);
  }

  function checkpoint(note) {
    var info = docInfo();
    rec({ k: 'checkpoint', note: note || '', doc: info });
    return 'EditTrail 已记检查点' + (info.name ? '：' + info.name : '');
  }

  function toggleTrackRevisions() {
    if (HOST !== 'wps') {
      return def.label + ' 侧没有“修订”开关；改动会在保存时按文件比对记录';
    }
    var a = _app || getApp();
    var d = null;
    try { d = a.ActiveDocument; } catch (e) {}
    if (!d) return '没有打开的文档';
    var cur = false;
    try { cur = !!d.TrackRevisions; } catch (e) {}
    var next = !cur;
    try { d.TrackRevisions = next; }
    catch (e) { return '切换修订失败：' + errStr(e); }
    rec({ k: 'track_revisions', value: next, doc: docInfo() });
    return next
      ? '已开启修订：之后的修改都会带作者名'
      : '已关闭修订';
  }

  function buttonAction(control) {
    var id = '';
    try { id = String(control.Id || control.id || ''); } catch (e) {}
    var msg;
    if (id === 'btnCheckpoint') {
      msg = checkpoint('ribbon');
      rec({ k: 'button', id: id, doc: docInfo() });
    } else if (id === 'btnTrackChanges') {
      msg = toggleTrackRevisions();
    } else {
      rec({ k: 'button', id: id, doc: docInfo() });
      msg = 'EditTrail: ' + (id || 'unknown');
    }
    return msg;
  }

  // Boot shortly after load; OnAddinLoad calls boot() again and is de-duped.
  setTimeout(function () { try { boot('load+300ms'); } catch (e) {} }, 300);

  return {
    version: VERSION,
    host: HOST,
    boot: boot,
    rec: rec,
    docInfo: docInfo,
    checkpoint: checkpoint,
    toggleTrackRevisions: toggleTrackRevisions,
    buttonAction: buttonAction,
    records: function () { return _buf.slice(0); }
  };
})();
