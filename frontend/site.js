const SITE_TABS = new Set(['overview', 'setup', 'database', 'environment', 'deploy', 'files', 'logs', 'terminal']);
function siteRoute() {
  const p = new URLSearchParams(String(location.hash || '').replace(/^#/, ''));
  const id = p.get('site');
  if (!/^[a-z0-9-]+$/.test(id || '')) return null;
  const tab = SITE_TABS.has(p.get('tab')) ? p.get('tab') : 'overview';
  return { id, tab };
}
function siteHash(id, tab) {
  return `site=${encodeURIComponent(id)}&tab=${encodeURIComponent(tab)}`;
}
function rememberSiteRoute(id, tab, push = false) {
  const hash = siteHash(id, tab);
  const url = `${location.pathname}${location.search}#${hash}`;
  if (push) {
    // A repeat click on the open site must not stack duplicate entries.
    if (location.hash.replace(/^#/, '') === hash) return;
    history.pushState({ site: id, tab }, '', url);
  } else {
    history.replaceState({ site: id, tab }, '', url);
  }
}
// Browser Back/Forward restores the panel route without adding entries.
if (typeof window !== 'undefined' && window.addEventListener) {
  window.addEventListener('popstate', () => {
    const route = siteRoute();
    if (route) openSite(route.id, route.tab, false);
    else backToSites(false);
  });
}
function openSite(id, tab = 'overview', remember = true) {
  currentApp = id;
  const openedId = id;
  remediateSeq++;
  remediateCache = [];
  document.getElementById('remediateCard').style.display = 'none';
  document.getElementById('remediateBox').innerHTML = '';
  document.getElementById('deployHist').innerHTML = '';
  siteEventSeq++;
  document.getElementById('siteEvents').textContent = '';
  deployLogSeq++;
  document.getElementById('deployFullLog').textContent = '';
  document.getElementById('deployFullLog').style.display = 'none';
  showView('site');
  tab = SITE_TABS.has(tab) ? tab : 'overview';
  // Site visits are history entries (Back returns to the list/previous site);
  // tab switches only update the current entry (see showSiteTab).
  if (remember) rememberSiteRoute(id, tab, true);
  document.getElementById('filePath').value = '';
  document.getElementById('fileEdit').value = '';
  document.getElementById('fileOut').textContent = '';
  fileTreeApp = null;
  fileTreeNodes = new Map();
  selectedFile = '';
  lastOpen = null;
  document.getElementById('svcName').value = '';
  document.getElementById('svcSub').value = '';
  document.getElementById('svcType').value = 'auto';
  document.getElementById('svcModernBuild').checked = false;
  document.getElementById('svcModernBuildRow').style.display = 'none';
  document.getElementById('svcAddBtn').disabled = true;
  document.getElementById('svcAddCheck').textContent = 'Enter a unique name and an existing repository subfolder.';
  document.getElementById('migrateOut').textContent = '';
  serviceCheckSeq++;
  if (serviceCheckTimer) clearTimeout(serviceCheckTimer);
  refresh().then(() => { if (currentApp !== openedId) return; showSiteTab(tab, false); loadDeployStatus(); loadEnv(); loadServices(); loadDatabases(); loadMigrateSuggest(); });
}
function appUrl(a) {
  if (!a.hostPort) return null;
  return publishedServiceUrl(a, { hostPort: a.hostPort, primary: true, homePath: a.homePath || '' });
}
async function deployCurrent() {
  if (!currentApp) return;
  await deploy(currentApp);
  loadDeployStatus();
}
async function deployLocal() {
  if (!currentApp) return;
  await runDeploy(currentApp, null, true);
  loadDeployStatus();
}
async function syncGithub() {
  if (!currentApp) return;
  const ok = await uiConfirm({ title: 'Sync checkout to GitHub?', body: `Use this only for recovery. Tracked and untracked box edits are saved in a git stash, then code/ resets to GitHub. Databases and volumes are untouched. Site ID: ${currentApp}. Type the site name to confirm.`, requireText: siteName(siteById(currentApp)), confirmLabel: 'Sync', danger: true });
  if (!ok) return;
  toast('syncing to GitHub…');
  try {
    const r = await (await fetch(`/api/apps/${currentApp}/sync-github`, { method: 'POST' })).json();
    toast(r.ok ? (`synced to ${r.sha}${r.backup ? ` (box edits saved in stash ${r.backup})` : ''} - redeploy to apply`) : ('sync failed: ' + (r.error || 'unknown')), !!r.ok);
    refresh(); loadDeployStatus(); loadServices();
  } catch (e) { toast('sync failed: ' + e.message, false); }
}
async function deploySvc(name) {
  if (!currentApp) return;
  return runDeploy(currentApp, [name]);
}
async function diagnose() {
  if (!currentApp) return;
  const out = document.getElementById('doctorOut');
  out.innerHTML = '<div class="meta">diagnosing…</div>';
  try {
    const r = await (await fetch(`/api/apps/${currentApp}/doctor`)).json();
    if (r.error) { out.innerHTML = '<div class="meta">' + r.error + '</div>'; return; }
    const dot = s => s === 'ok' ? '[ok]' : s === 'warn' ? '[warn]' : '[FAIL]';
    out.innerHTML = `<div class="meta"><b>doctor: ${r.summary}</b></div>` +
      (r.checks || []).map(c => `<div class="meta">${dot(c.status)} <b>${c.name}</b> — ${c.detail}</div>`).join('');
  } catch { out.innerHTML = '<div class="meta">diagnose failed</div>'; }
}
async function saveHome() {
  if (!currentApp) return;
  const p = document.getElementById('homePath').value;
  const r = await (await fetch(`/api/apps/${currentApp}/home`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: p }) })).json();
  toast(r.ok ? 'open path saved' : (r.error || 'failed'), !!r.ok);
  refresh(); loadDeployStatus(); loadServices();
}
function selectHomePath(path) {
  const selected = path === '/' ? '' : path;
  document.getElementById('homePath').value = selected;
  document.querySelectorAll('#routeChoices button[data-path]').forEach(button => {
    button.classList.toggle('selected', button.dataset.path === (selected || '/'));
  });
}
function renderRouteChoices(app) {
  const box = document.getElementById('routeChoices');
  if (!box || !app) return;
  const raw = Array.isArray(app.openPaths) ? app.openPaths : [];
  const items = raw.map(item => typeof item === 'string'
    ? { path: item, live: null, code: null, source: 'source' }
    : item).filter(item => item && /^\/[A-Za-z0-9._~!&'()+,;=@%/-]*$/.test(item.path || ''));
  if (!items.length) {
    box.innerHTML = '<div class="meta">No routes recorded yet. Redeploy to scan source declarations and live endpoints.</div>';
    return;
  }
  const input = document.getElementById('homePath');
  const selected = input ? (input.value || '/') : (app.homePath || '/');
  box.innerHTML = '<div class="route-choice-label">Detected routes — select the default, then save</div><div class="route-choice-list">' + items.map(item => {
    const available = item.live !== false;
    const state = item.live === true ? String(item.code || 'live') : (item.live === false ? String(item.code || 'failed') : 'source');
    return `<button data-path="${safeHtml(item.path)}" onclick="selectHomePath(this.dataset.path)" class="${item.path === selected ? 'selected' : ''}${available ? '' : ' unavailable'}"><code>${safeHtml(item.path)}</code><span>${safeHtml(state)}</span></button>`;
  }).join('') + '</div>';
}
async function refreshSiteData(expectedApp = currentApp) {
  if (!expectedApp || currentApp !== expectedApp) return;
  // Header/list refreshes can rebuild parts of the active site. Finish that
  // first, then render status/history from the completed deployment record.
  await refresh();
  if (currentApp !== expectedApp) return;
  await loadDeployStatus();
  await Promise.allSettled([loadServices(), loadDatabases(), loadMigrateSuggest()]);
}
