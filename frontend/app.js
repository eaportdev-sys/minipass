let currentApp = null;
async function refresh() {
  const apps = await (await fetch('/api/apps')).json();
  document.getElementById('apps').innerHTML = apps.map(a =>
    `<div class="card appcard"><h3>${a.id}</h3>
    <div class="badges"><span class="badge type">${a.type}</span><span class="badge">db: ${a.db}</span>${a.domain ? `<span class="badge">${a.domain}</span>` : ''}</div>
    <div class="meta">local: ${a.hostPort ? `<a href="http://${location.hostname}:${a.hostPort}" target="_blank">http://${location.hostname}:${a.hostPort}</a>` : 'recreate app to get localhost port'}</div>
    <div class="meta">webhook: <code>POST /webhook/${a.id}?token=${a.token}</code></div>
    <div class="actions"><button class="btn primary" onclick="openSite('${a.id}')">open</button><button onclick="deploy('${a.id}')">redeploy</button><button class="btn danger" onclick="rmApp('${a.id}')">delete</button></div></div>`).join('') || '<div class="card">No websites yet - hit + Create.</div>';
  // keep detail header + global terminal picker in sync
  if (currentApp && !apps.some(a => a.id === currentApp)) backToSites();
  else if (currentApp) fillSiteHeader(apps.find(a => a.id === currentApp));
  const tsel = document.getElementById('termApp');
  if (tsel) {
    const prev = tsel.value;
    tsel.innerHTML = apps.map(a => `<option value="${a.id}">${a.id}</option>`).join('');
    if (apps.some(a => a.id === prev)) tsel.value = prev;
  }
}
function openSite(id) {
  currentApp = id;
  showView('site');
  document.getElementById('filePath').value = '';
  document.getElementById('fileEdit').value = '';
  document.getElementById('fileOut').textContent = '';
  refresh().then(() => showSiteTab('files'));
}
function backToSites() { currentApp = null; showView('websites'); refresh(); }
function fillSiteHeader(a) {
  if (!a) return;
  document.getElementById('siteName').textContent = a.id;
  document.getElementById('siteBadges').innerHTML =
    `<span class="badge type">${a.type}</span><span class="badge">db: ${a.db}</span>${a.domain ? `<span class="badge">${a.domain}</span>` : ''}${a.hostPort ? `<span class="badge">:${a.hostPort}</span>` : ''}`;
  document.getElementById('siteMeta').innerHTML =
    `${a.hostPort ? `local: <a href="http://${location.hostname}:${a.hostPort}" target="_blank">http://${location.hostname}:${a.hostPort}</a><br>` : ''}
    webhook: <code>POST /webhook/${a.id}?token=${a.token}</code>`;
  document.getElementById('siteRedeploy').onclick = () => deploy(a.id);
  document.getElementById('siteDelete').onclick = () => rmApp(a.id);
}
function showSiteTab(t) {
  document.querySelectorAll('.sitetab').forEach(s => s.style.display = 'none');
  document.getElementById('tab-' + t).style.display = 'block';
  document.querySelectorAll('.tabbtn').forEach(b => b.classList.toggle('active', b.dataset.tab === t));
  if (!currentApp) return;
  if (t === 'files') listFiles('');
  if (t === 'logs') showLogs();
}
async function createApp() {
  const v = id => document.getElementById(id).value;
  const typeEl = document.querySelector('input[name=apptype]:checked');
  const body = { name: v('name'), type: typeEl ? typeEl.value : 'static', db: v('db'), repoUrl: v('repo'), domain: v('domain') };
  const r = await (await fetch('/api/apps', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();
  document.getElementById('out').textContent = JSON.stringify(r, null, 2);
  refresh();
  if (!r.error) closeCreate();
}
function showView(view) {
  document.querySelectorAll('.view').forEach(s => s.classList.toggle('active', s.id === 'view-' + view));
  document.querySelectorAll('.navitem').forEach(n => n.classList.toggle('active', n.dataset.view === view));
}
function openCreate() { document.getElementById('modal').classList.add('open'); }
function closeCreate() { document.getElementById('modal').classList.remove('open'); }
function toggleTheme() {
  const t = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
  document.documentElement.dataset.theme = t;
  try { localStorage.setItem('mp-theme', t); } catch {}
}
try { document.documentElement.dataset.theme = localStorage.getItem('mp-theme') || 'dark'; } catch {}
async function deploy(id) { await fetch('/api/apps/' + id + '/deploy', { method: 'POST' }); alert('deploying'); }
async function rmApp(id) { if (confirm('delete?')) { await fetch('/api/apps/' + id, { method: 'DELETE' }); refresh(); } }
async function showLogs() {
  if (!currentApp) { logsEl.textContent = 'open a website first'; return; }
  logsEl.textContent = 'loading…';
  logsEl.textContent = await (await fetch('/api/apps/' + currentApp + '/logs')).text();
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
      let log = '';
      try { log = await (await fetch('/api/panel/upgrade-log')).text(); } catch {}
      out.textContent = `restarting… running ${v.running}, target ${v.repo} (${left}s left)\n--- build log ---\n${log}`;
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
  if (!currentApp) return;
  const files = await (await fetch(`/api/apps/${id}/files?path=${encodeURIComponent(curDir)}`)).json();
  const up = curDir ? `<button onclick="listFiles('${curDir.split('/').slice(0, -1).join('/')}')">.. up</button><br>` : '';
  document.getElementById('fileList').innerHTML = up + (files.error || files.map(f =>
    f.dir ? `<button onclick="listFiles('${(curDir ? curDir + '/' : '') + f.name}')">${f.name}/</button>`
          : `<button onclick="openFile('${(curDir ? curDir + '/' : '') + f.name}')">${f.name}</button>`).join(' ') || '(empty)');
}
async function openFile(p) {
  const id = currentApp;
  const fp = p || document.getElementById('filePath').value.trim() || 'index.html';
  if (!id) { document.getElementById('fileEdit').value = 'no app selected'; return; }
  document.getElementById('filePath').value = fp;
  try {
    const r = await (await fetch(`/api/apps/${id}/file?path=${encodeURIComponent(fp)}`)).json();
    document.getElementById('fileEdit').value = r.content || JSON.stringify(r);
  } catch (e) { document.getElementById('fileEdit').value = 'open failed: ' + e.message; }
}
async function saveFile() {
  const id = currentApp;
  const body = { path: document.getElementById('filePath').value, content: document.getElementById('fileEdit').value };
  document.getElementById('fileOut').textContent = 'saving + redeploying…';
  try {
    const r = await (await fetch(`/api/apps/${id}/file`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();
    document.getElementById('fileOut').textContent = JSON.stringify(r, null, 2); listFiles(curDir);
  } catch (e) { document.getElementById('fileOut').textContent = 'save failed: ' + e.message; }
}
async function deleteFile() {
  const id = currentApp;
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
  const id = currentApp;
  const f = document.getElementById('zipFile').files[0];
  if (!id || !f) { document.getElementById('fileOut').textContent = 'pick an app and a zip file'; return; }
  const fd = new FormData(); fd.append('zip', f);
  document.getElementById('fileOut').textContent = 'uploading + redeploying…';
  try {
    const r = await (await fetch(`/api/apps/${id}/upload`, { method: 'POST', body: fd })).json();
    document.getElementById('fileOut').textContent = JSON.stringify(r, null, 2); listFiles('');
  } catch (e) { document.getElementById('fileOut').textContent = 'upload failed: ' + e.message; }
}
async function uploadPicked(folder) {
  const id = currentApp;
  const input = document.getElementById(folder ? 'pickFolder' : 'pickFiles');
  const files = [...input.files];
  if (!id || !files.length) { document.getElementById('fileOut').textContent = 'pick an app and ' + (folder ? 'a folder' : 'one or more files'); return; }
  const fd = new FormData();
  for (const f of files) {
    // folder mode: drop the picked folder's own name so contents land at site root
    const rel = folder ? (f.webkitRelativePath.split('/').slice(1).join('/') || f.name) : f.name;
    fd.append('files', f);
    fd.append('paths', rel);
  }
  document.getElementById('fileOut').textContent = `uploading ${files.length} file(s) + redeploying…`;
  try {
    const r = await (await fetch(`/api/apps/${id}/upload-files`, { method: 'POST', body: fd })).json();
    document.getElementById('fileOut').textContent = JSON.stringify(r, null, 2); listFiles('');
  } catch (e) { document.getElementById('fileOut').textContent = 'upload failed: ' + e.message; }
  input.value = '';
}
const logsEl = document.getElementById('logs');
let term, ws;
function openTerm() {
  if (!currentApp) return;
  const id = currentApp;
  term = new Terminal(); term.open(document.getElementById('term')); term.clear();
  ws = new WebSocket(`ws://${location.host}/terminal?app=${id}`);
  ws.onmessage = e => term.write(e.data);
  term.onData = d => ws.send(d);
}
function openTermGlobal() {
  const id = document.getElementById('termApp').value;
  if (!id) return;
  const t = new Terminal(); t.open(document.getElementById('termGlobal'));
  const w = new WebSocket(`ws://${location.host}/terminal?app=${id}`);
  w.onmessage = e => t.write(e.data);
  t.onData = d => w.send(d);
}
refresh();
version();
