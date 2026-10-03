async function refresh() {
  const apps = await (await fetch('/api/apps')).json();
  document.getElementById('apps').innerHTML = apps.map(a =>
    `<div class="card"><b>${a.id}</b> [${a.type}] db:${a.db} ${a.domain||''}<br>
    webhook: <code>POST /webhook/${a.id}?token=${a.token}</code> - paste into GitHub Settings-&gt;Webhooks for auto-deploy on push<br>
    <button onclick="deploy('${a.id}')">redeploy</button>
    <button onclick="rmApp('${a.id}')">delete</button></div>`).join('');
}
async function createApp() {
  const v = id => document.getElementById(id).value;
  const body = { name: v('name'), type: v('type'), db: v('db'), repoUrl: v('repo'), domain: v('domain') };
  const r = await (await fetch('/api/apps', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();
  document.getElementById('out').textContent = JSON.stringify(r, null, 2); refresh();
}
async function deploy(id) { await fetch('/api/apps/' + id + '/deploy', { method: 'POST' }); alert('deploying'); }
async function rmApp(id) { if (confirm('delete?')) { await fetch('/api/apps/' + id, { method: 'DELETE' }); refresh(); } }
async function logs() { logsEl.textContent = await (await fetch('/api/apps/' + document.getElementById('logApp').value + '/logs')).text(); }
const logsEl = document.getElementById('logs');
let term, ws;
function openTerm() {
  term = new Terminal(); term.open(document.getElementById('term')); term.clear();
  ws = new WebSocket(`ws://${location.host}/terminal?app=${document.getElementById('termApp').value}`);
  ws.onmessage = e => term.write(e.data);
  term.onData = d => ws.send(d);
}
refresh();
