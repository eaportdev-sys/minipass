async function refresh() {
  const apps = await (await fetch('/api/apps')).json();
  document.getElementById('apps').innerHTML = apps.map(a =>
    `<div class="card"><b>${a.id}</b> [${a.type}] db:${a.db} ${a.domain||''}<br>
    local: ${a.hostPort ? `<a href="http://${location.hostname}:${a.hostPort}" target="_blank">http://${location.hostname}:${a.hostPort}</a> (no domain needed)` : 'recreate app to get localhost port'}<br>
    webhook: <code>POST /webhook/${a.id}?token=${a.token}</code> - paste into GitHub Settings-&gt;Webhooks for auto-deploy on push<br>
    <button onclick="deploy('${a.id}')">redeploy</button>
    <button onclick="rmApp('${a.id}')">delete</button></div>`).join('');
  // keep terminal/logs/files dropdowns in sync
  for (const selId of ['termApp', 'logApp', 'fileApp']) {
    const sel = document.getElementById(selId);
    const prev = sel.value;
    sel.innerHTML = apps.map(a => `<option value="${a.id}">${a.id}</option>`).join('');
    if (apps.some(a => a.id === prev)) sel.value = prev;
  }
}
async function createApp() {
  const v = id => document.getElementById(id).value;
  const body = { name: v('name'), type: v('type'), db: v('db'), repoUrl: v('repo'), domain: v('domain') };
  const r = await (await fetch('/api/apps', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();
  document.getElementById('out').textContent = JSON.stringify(r, null, 2); refresh();
}
async function deploy(id) { await fetch('/api/apps/' + id + '/deploy', { method: 'POST' }); alert('deploying'); }
async function rmApp(id) { if (confirm('delete?')) { await fetch('/api/apps/' + id, { method: 'DELETE' }); refresh(); } }
async function showLogs() {
  const id = document.getElementById('logApp').value.trim();
  if (!id) { logsEl.textContent = 'no apps yet - build one first'; return; }
  logsEl.textContent = 'loading…';
  logsEl.textContent = await (await fetch('/api/apps/' + id + '/logs')).text();
}
async function version() {
  try {
    const v = await (await fetch('/api/panel/version')).json();
    document.getElementById('ver').textContent =
      `running ${v.running} · repo ${v.repo}` + (v.upgradeable ? '' : ' (mount ./:/repo to enable upgrade)');
    // landed mid-restart (manual refresh) -> resume watching instead of sitting stale
    if (v.restarting && !restartTimer) watchRestart(180000);
  } catch { document.getElementById('ver').textContent = 'unknown'; }
}
async function upgrade() {
  document.getElementById('upOut').textContent = 'pulling + rebuilding… panel will restart';
  try {
    const r = await (await fetch('/api/panel/upgrade', { method: 'POST' })).json();
    document.getElementById('upOut').textContent = JSON.stringify(r, null, 2);
    if (r.restarting) watchRestart(180000);
  } catch (e) { document.getElementById('upOut').textContent = 'upgrade failed: ' + e.message; }
}
let restartTimer = null;
async function watchRestart(deadlineMs) {
  if (restartTimer) clearInterval(restartTimer);
  const out = document.getElementById('upOut');
  const end = Date.now() + (deadlineMs || 180000);
  restartTimer = setInterval(async () => {
    const left = Math.max(0, Math.ceil((end - Date.now()) / 1000));
    try {
      const v = await (await fetch('/api/panel/version')).json();
      document.getElementById('ver').textContent = `running ${v.running} · repo ${v.repo}`;
      if (!v.restarting) { clearInterval(restartTimer); restartTimer = null; location.reload(); return; }
      out.textContent = `restarting… running ${v.running}, target ${v.repo} (${left}s left)`;
    } catch (e) {
      out.textContent = `restarting… panel unreachable, retrying (${left}s left)`;
    }
    if (left <= 0) { clearInterval(restartTimer); restartTimer = null; out.textContent += '\nTimed out - refresh the page manually.'; }
  }, 3000);
}
async function scan() {
  const r = await (await fetch('/api/panel/scan', { method: 'POST' })).json();
  document.getElementById('upOut').textContent = JSON.stringify(r, null, 2); refresh();
}
let curDir = '';
async function listFiles(dir) {
  curDir = dir || '';
  if (!dir) { document.getElementById('filePath').value = ''; document.getElementById('fileEdit').value = ''; }
  const id = document.getElementById('fileApp').value;
  if (!id) return;
  const files = await (await fetch(`/api/apps/${id}/files?path=${encodeURIComponent(curDir)}`)).json();
  const up = curDir ? `<button onclick="listFiles('${curDir.split('/').slice(0, -1).join('/')}')">.. up</button><br>` : '';
  document.getElementById('fileList').innerHTML = up + (files.error || files.map(f =>
    f.dir ? `<button onclick="listFiles('${(curDir ? curDir + '/' : '') + f.name}')">${f.name}/</button>`
          : `<button onclick="openFile('${(curDir ? curDir + '/' : '') + f.name}')">${f.name}</button>`).join(' ') || '(empty)');
}
async function openFile(p) {
  const id = document.getElementById('fileApp').value;
  const fp = p || document.getElementById('filePath').value.trim() || 'index.html';
  if (!id) { document.getElementById('fileEdit').value = 'no app selected'; return; }
  document.getElementById('filePath').value = fp;
  try {
    const r = await (await fetch(`/api/apps/${id}/file?path=${encodeURIComponent(fp)}`)).json();
    document.getElementById('fileEdit').value = r.content || JSON.stringify(r);
  } catch (e) { document.getElementById('fileEdit').value = 'open failed: ' + e.message; }
}
async function saveFile() {
  const id = document.getElementById('fileApp').value;
  const body = { path: document.getElementById('filePath').value, content: document.getElementById('fileEdit').value };
  document.getElementById('fileOut').textContent = 'saving + redeploying…';
  try {
    const r = await (await fetch(`/api/apps/${id}/file`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();
    document.getElementById('fileOut').textContent = JSON.stringify(r, null, 2); listFiles(curDir);
  } catch (e) { document.getElementById('fileOut').textContent = 'save failed: ' + e.message; }
}
async function deleteFile() {
  const id = document.getElementById('fileApp').value;
  const fp = document.getElementById('filePath').value;
  if (!id || !fp || !confirm('delete ' + fp + '?')) return;
  document.getElementById('fileOut').textContent = 'deleting + redeploying…';
  try {
    const r = await (await fetch(`/api/apps/${id}/file?path=${encodeURIComponent(fp)}`, { method: 'DELETE' })).json();
    document.getElementById('fileOut').textContent = JSON.stringify(r, null, 2);
    document.getElementById('filePath').value = ''; document.getElementById('fileEdit').value = '';
    listFiles(curDir);
  } catch (e) { document.getElementById('fileOut').textContent = 'delete failed: ' + e.message; }
}
async function uploadZip() {
  const id = document.getElementById('fileApp').value;
  const f = document.getElementById('zipFile').files[0];
  if (!id || !f) { document.getElementById('fileOut').textContent = 'pick an app and a zip file'; return; }
  const fd = new FormData(); fd.append('zip', f);
  document.getElementById('fileOut').textContent = 'uploading + redeploying…';
  try {
    const r = await (await fetch(`/api/apps/${id}/upload`, { method: 'POST', body: fd })).json();
    document.getElementById('fileOut').textContent = JSON.stringify(r, null, 2); listFiles('');
  } catch (e) { document.getElementById('fileOut').textContent = 'upload failed: ' + e.message; }
}
const logsEl = document.getElementById('logs');
let term, ws;
function openTerm() {
  const id = document.getElementById('termApp').value.trim();
  if (!id) return;
  term = new Terminal(); term.open(document.getElementById('term')); term.clear();
  ws = new WebSocket(`ws://${location.host}/terminal?app=${id}`);
  ws.onmessage = e => term.write(e.data);
  term.onData = d => ws.send(d);
}
refresh();
version();
