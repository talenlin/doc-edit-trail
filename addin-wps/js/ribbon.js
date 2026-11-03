// ribbon callbacks: names must match onLoad / onAction in ribbon.xml
var _ribbonUI = null;

function OnAddinLoad(ribbonUI) {
  try { _ribbonUI = ribbonUI; } catch (e) {}
  try {
    if (typeof Trail !== 'undefined' && Trail.boot) {
      Trail.boot('OnAddinLoad');
    } else {
      // trail.js not loaded yet: leave a trace through the plain event channel
      try {
        var x = new XMLHttpRequest();
        x.open('POST', 'http://127.0.0.1:39871/log', true);
        x.send('{"k":"ribbon_no_trail"}');
      } catch (e) {}
    }
  } catch (e) {}
  return true;
}

function OnAction(control) {
  var msg = '';
  try {
    if (typeof Trail !== 'undefined' && Trail.buttonAction) {
      msg = Trail.buttonAction(control);
    }
  } catch (e) {}
  try { if (msg) alert(msg); } catch (e) {}
}

function OnGetEnabled(control) { return true; }
function OnGetVisible(control) { return true; }
function OnGetLabel(control) { try { return control.Id; } catch (e) { return ''; } }

// icon paths are resolved relative to index.html, i.e. http://127.0.0.1:39871/<host>/images/*.svg
function GetImage(control) {
  var id = '';
  try { id = control.Id || control.id || ''; } catch (e) {}
  switch (id) {
    case 'btnCheckpoint': return 'images/checkpoint.svg';
    case 'btnTrackChanges': return 'images/track-changes.svg';
    default: return 'images/checkpoint.svg';
  }
}
