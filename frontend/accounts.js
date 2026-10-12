async function ghStatus() {
  try {
    const s = await (await fetch('/api/github/status')).json();
    const status = document.getElementById('ghStatus');
    const logins = s.logins || [];
    status.className = 'panel-state ' + (s.connected ? 'is-ok' : 'is-off');
    status.textContent = s.connected ? `${logins.length} connected` : 'not connected';
    document.getElementById('ghAccounts').innerHTML = logins.length ? logins.map(l =>
      `<div class="github-account-row"><span class="github-account-mark">GH</span><div><b>${safeHtml(l)}</b><small>Shared panel account</small></div><button class="btn danger" data-login="${safeHtml(l)}" onclick="ghDisconnect(this.dataset.login)">disconnect</button></div>`).join('')
      : '<div class="settings-empty">No shared GitHub accounts.</div>';
    // OAuth is a dead end on LAN (GitHub rejects non-HTTPS callbacks) - only show it when configured
    document.getElementById('oauthRow').style.display = s.oauth ? 'block' : 'none';
  } catch {
    const status = document.getElementById('ghStatus');
    status.className = 'panel-state is-failed';
    status.textContent = 'unreachable';
    document.getElementById('ghAccounts').innerHTML = '<div class="settings-empty">Could not load GitHub connections.</div>';
  }
}
let ghPoll = null;
function ghConnect() {
  // new tab: panel stays open; poll until the handshake lands, then refresh state
  window.open('/api/github/login', '_blank');
  if (ghPoll) clearInterval(ghPoll);
  const end = Date.now() + 180000;
  ghPoll = setInterval(async () => {
    try {
      const s = await (await fetch('/api/github/status')).json();
      if (s.connected) {
        clearInterval(ghPoll); ghPoll = null;
        ghStatus();
        toast('github connected: ' + s.logins.join(', '));
        return;
      }
    } catch {}
    if (Date.now() > end) { clearInterval(ghPoll); ghPoll = null; }
  }, 3000);
}
async function ghSaveToken() {
  const input = document.getElementById('ghToken');
  const r = await saveToken(input.value);
  if (r && r.ok) { input.value = ''; toast('github connected as ' + r.login); ghStatus(); }
  else if (r) toast(r.error || 'failed', false);
}
async function saveToken(token) {
  token = String(token || '').trim();
  if (!token) return null;
  return await (await fetch('/api/github/token', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) })).json();
}
let modalLogin = null;
let createModalSession = 0;
let createConnectRequest = 0;
let createDetectRequest = 0;
let createDetectRepo = '';
let createDetectedManager = 'npm';
let createStandardDockerfile = false;
let createStorageAvailable = null;
let createCleanupPromise = Promise.resolve();
let createPendingId = null;
async function modalListRepos() {
  const session = createModalSession;
  const request = ++createConnectRequest;
  // fresh token every build - preview WITHOUT saving to the shared pool
  const token = document.getElementById('ghModalToken').value.trim();
  if (!token) { toast('paste a token first', false); return; }
  const button = document.getElementById('ghModalConnect');
  button.disabled = true;
  button.textContent = 'Loading…';
  let r;
  try {
    r = await (await fetch('/api/github/preview', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) })).json();
  } catch (e) { r = { error: e.message }; }
  if (session !== createModalSession || request !== createConnectRequest) return;
  button.disabled = false;
  button.textContent = 'List repos';
  if (r.error) { toast(r.error, false); return; }
  modalLogin = r.login;
  const sel = document.getElementById('ghrepo');
  sel.innerHTML = '<option value="">GitHub repo…</option>' + (r.repos || []).map(x =>
    `<option value="${x.full_name}" data-login="${r.login}">${x.full_name}${x.private ? ' (private)' : ''}</option>`).join('');
  document.getElementById('ghRepoRow').style.display = 'block';
  const nm = document.getElementById('name').value.trim() || 'the new site';
  document.getElementById('ghStoreNote').textContent = `Saved to ${nm} only.`;
  document.getElementById('ghConnState').textContent = `Connected as ${r.login}. Choose a repository.`;
  toast('token ok as ' + r.login + ' - pick a repo');
}
async function ghDisconnect(login) {
  await fetch('/api/github/disconnect', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ login: login || undefined }) });
  ghStatus();
}
function dbLabel(a) { return [].concat(a.db || []).join('+') || 'none'; }
function dirtyBadge(a) {
  if (!a.dirty) return '';
  const reason = typeof a.dirty === 'object' ? (a.dirty.reason || '') : '';
  const tip = reason ? `saved change not yet deployed: ${reason} — press the power button to redeploy` : 'saved change not yet deployed — press the power button to redeploy';
  const short = reason ? ` ● ${reason}` : ' ● changes pending';
  return `<span class="badge pending" title="${safeHtml(tip)}">${safeHtml(short.length > 42 ? short.slice(0, 42) + '…' : short)}</span>`;
}
function showView(view) {
  document.querySelectorAll('.view').forEach(s => s.classList.toggle('active', s.id === 'view-' + view));
  document.querySelectorAll('.navitem').forEach(n => n.classList.toggle('active', n.dataset.view === view));
  if (view === 'trash') loadTrash();
  if (view === 'errors') loadPanelErrors();
  if (view === 'storage') loadHostStorage();
}