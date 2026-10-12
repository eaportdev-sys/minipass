async function panelSetup() {
  const out = document.getElementById('setupOut');
  const pw = document.getElementById('setupPass').value;
  if (!document.getElementById('setupTerms').checked) { out.textContent = 'tick the terms checkbox first'; return; }
  out.textContent = 'creating…';
  const r = await (await fetch('/api/panel/setup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: pw, acceptTerms: true }) })).json();
  if (r.ok) { document.getElementById('setupPass').value = ''; authBoot(); }
  else out.textContent = r.error || 'setup failed';
}
async function panelLogin() {
  const out = document.getElementById('loginOut');
  const input = document.getElementById('loginPass');
  out.textContent = 'checking…';
  const r = await (await fetch('/api/panel/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: input.value }) })).json();
  input.value = '';
  if (!r.ok) { out.textContent = r.error || 'login failed'; return; }
  out.textContent = '';
  if (!r.termsAccepted) {
    const t = await (await fetch('/api/panel/terms-text')).text();
    const ok = await uiConfirm({ title: 'Operator terms', body: t, confirmLabel: 'I accept' });
    if (!ok) { panelLogout(); return; }
    await fetch('/api/panel/terms', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ accepted: true }) });
    toast('terms accepted');
  }
  authBoot();
}
async function panelLogout() {
  try { await fetch('/api/panel/logout', { method: 'POST' }); } catch {}
  currentApp = null;
  showLogin();
}
async function panelChangePassword() {
  const out = document.getElementById('maintOut');
  const cur = document.getElementById('pwCurrent').value;
  const next = document.getElementById('pwNext').value;
  out.textContent = 'changing…';
  const r = await (await fetch('/api/panel/password', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ current: cur, next }) })).json();
  out.textContent = r.ok ? 'password changed' : (r.error || 'failed');
  document.getElementById('pwCurrent').value = '';
  document.getElementById('pwNext').value = '';
}
async function showTerms() {
  const t = await (await fetch('/api/panel/terms-text')).text();
  await uiConfirm({ title: 'Operator terms', body: t, confirmLabel: 'close' });
}
async function showLogin() {
  currentApp = null;
  showView('login');
  try {
    const s = await (await fetch('/api/panel/auth-status')).json();
    document.getElementById('setupBox').style.display = s.setupRequired ? 'block' : 'none';
    document.getElementById('loginBox').style.display = s.setupRequired ? 'none' : 'block';
    if (s.setupRequired) {
      try { document.getElementById('termsPreview').textContent = await (await fetch('/api/panel/terms-text')).text(); } catch {}
    }
  } catch {}
}
function downloadSiteBackup() {
  if (!currentApp) return;
  location.href = `/api/apps/${currentApp}/backup`;
}
function downloadDbDump(type) {
  if (!currentApp) return;
  location.href = `/api/apps/${currentApp}/databases/${type}/dump`;
}
async function authBoot() {
  let s = null;
  try { s = await (await fetch('/api/panel/auth-status')).json(); } catch {}
  if (!s || !s.authenticated) { showLogin(); return; }
  if (new URLSearchParams(location.search).get('github') === 'connected') {
    toast('github connected - pick a repo at create time');
    showView('panel');
    history.replaceState(null, '', location.pathname);
  }
  const apps = await refresh();
  const route = siteRoute();
  if (route && apps.some(a => a.id === route.id)) openSite(route.id, route.tab, false);
  version();
  ghStatus();
}
authBoot();
