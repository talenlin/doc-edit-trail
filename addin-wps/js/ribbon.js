// ribbon 回调: 函数名必须与 ribbon.xml 里的 onLoad / onAction 一致
var _ribbonUI = null;

function OnAddinLoad(ribbonUI) {
  try { _ribbonUI = ribbonUI; } catch (e) {}
  try {
    if (typeof Trail !== 'undefined' && Trail.boot) Trail.boot('OnAddinLoad');
    else if (typeof Trail === 'undefined') {
      // trail.js 尚未加载时, 用极简通道留痕
      try {
        var x = new XMLHttpRequest();
        x.open('GET', 'http://127.0.0.1:39871/log?l=' + encodeURIComponent('{"k":"ribbon_no_trail"}'), true);
        x.send(null);
      } catch (e) {}
    }
  } catch (e) {}
  return true;
}

function OnAction(control) {
  try { if (typeof Trail !== 'undefined') Trail.buttonAction(control); } catch (e) {}
}

function OnGetEnabled(control) { return true; }
function OnGetVisible(control) { return true; }
function OnGetLabel(control) { try { return control.Id; } catch (e) { return ''; } }
