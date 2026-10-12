const logsEl = document.getElementById('logs');
const termSlots = {};
function connectTerm(elId, appId, slotKey, svc) {
  // dispose any previous session first - reconnects replace instead of stacking blank terminals
  const old = termSlots[slotKey];
  if (old) {
    old.ws.onopen = old.ws.onmessage = old.ws.onerror = old.ws.onclose = null;
    if (old.resize) window.removeEventListener('resize', old.resize);
    try { old.input.dispose(); } catch {}
    try { old.ws.close(); } catch {}
    try { old.term.dispose(); } catch {}
  }
  const el = document.getElementById(elId);
  el.innerHTML = '';
  if (typeof Terminal === 'undefined') {
    el.textContent = 'terminal library failed to load - check this panel can reach cdn.jsdelivr.net';
    return;
  }
  const initialCols = Math.max(20, Math.floor(((el.clientWidth || 720) - 12) / 9));
  const t = new Terminal({ cursorBlink: true, convertEol: true, scrollback: 3000, cols: initialCols });
  const fit = typeof FitAddon !== 'undefined' ? new FitAddon.FitAddon() : null;
  if (fit) t.loadAddon(fit);
  t.open(el);
  const resize = () => { if (fit) { try { fit.fit(); } catch {} } };
  resize();
  t.writeln('connecting to ' + appId + (svc && svc !== 'app' ? '/' + svc : '') + '…');
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const w = new WebSocket(`${protocol}//${location.host}/terminal?app=${encodeURIComponent(appId)}&service=${encodeURIComponent(svc || 'app')}`);
  const session = { term: t, ws: w, input: null, resize };
  termSlots[slotKey] = session;
  window.addEventListener('resize', resize);
  const active = () => termSlots[slotKey] === session;
  session.input = t.onData(d => {
    if (active() && w.readyState === WebSocket.OPEN) w.send(d);
  });
  w.onopen = () => {
    if (!active()) return;
    t.writeln('connected - type commands below.\r\n');
    t.focus();
  };
  w.onmessage = e => { if (active()) t.write(e.data); };
  w.onerror = () => { if (active()) t.writeln('\r\nconnection error - is the app container running?'); };
  w.onclose = e => {
    if (!active()) return;
    const reason = e.reason ? ' (' + e.reason + ')' : '';
    t.writeln(`\r\nsession closed${reason}. Press connect to reopen.`);
  };
}