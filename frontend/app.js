let currentApp = null;
let serviceCheckTimer = null;
let serviceCheckSeq = 0;
let appsRefreshSeq = 0;
let deployStatusSeq = 0;
// Global 401 tripwire: any data call that comes back unauthorized drops to the
// login view. Login/setup endpoints are excluded so wrong passwords just show
// their own error instead of looping.
const _fetch = window.fetch.bind(window);
window.fetch = (...a) => _fetch(...a).then(r => {
  if (r.status === 401 && !String(a[0] || '').includes('/api/panel/')) showLogin();
  return r;
});
const dbPopupSlots = new Map();
let websiteApps = [];
let trashApps = [];
function siteName(site) { return (site && (site.name || site.id)) || ''; }
function siteById(id) { return websiteApps.find(a => a.id === id) || trashApps.find(a => a.id === id) || { id }; }
let websiteVisibleApps = [];
let websitePage = 1;
let websiteRenderSeq = 0;
const websiteStates = new Map();
const websiteStateSeq = new Map();
let websiteStatusActive = 0;
const websiteStatusWaiters = [];
async function refresh() {
  const seq = ++appsRefreshSeq;
  const apps = await (await fetch('/api/apps')).json();
  if (seq !== appsRefreshSeq || !Array.isArray(apps)) return apps;
  websiteApps = apps;
  const ids = new Set(apps.map(a => a.id));
  for (const id of websiteStates.keys()) if (!ids.has(id)) { websiteStates.delete(id); websiteStateSeq.delete(id); }
  renderWebsites();
  // keep detail header + global terminal picker in sync
  if (currentApp && !apps.some(a => a.id === currentApp)) backToSites();
  else if (currentApp) fillSiteHeader(apps.find(a => a.id === currentApp));
  const tsel = document.getElementById('termApp');
  if (tsel) {
    const prev = tsel.value;
    tsel.innerHTML = apps.map(a => `<option value="${a.id}">${safeHtml(siteName(a))} (${a.id})</option>`).join('');
    if (apps.some(a => a.id === prev)) tsel.value = prev;
  }
  return apps;
}
function appCardMarkup(a) {
  const services = appPublishedServices(a);
  const facts = [a.domain, dbLabel(a) !== 'none' ? 'DB: ' + dbLabel(a) : '', services.length > 1 ? services.length + ' services' : ''].filter(Boolean).join(' · ');
  return `<div class="website-row" id="card-${a.id}" role="row">` +
    `<div class="website-name" role="cell"><button class="website-name-link" onclick="openSite('${a.id}')">${safeHtml(siteName(a))}</button>${a.dirty ? '<span class="website-pending" title="Saved changes — redeploy to apply" aria-label="Changes pending">●</span>' : ''}<div class="website-facts" title="${safeHtml(facts)}">${safeHtml(facts || 'No managed database')}</div>${a.name && a.name !== a.id ? `<div class="website-facts" title="Internal site ID">${safeHtml(a.id)}</div>` : ''}</div>` +
    `<div class="website-runtime" role="cell"><span class="badge type">${safeHtml(a.type === 'node' ? 'Node.js' : a.type === 'php' ? 'PHP' : a.type === 'react' ? 'React' : a.type === 'static' ? 'Static' : a.type)}</span></div>` +
    `<div role="cell"><span id="appState-${a.id}" class="website-state is-checking">Checking</span></div>` +
    `<div class="website-urls" role="cell">${appLinksMarkup(a, services)}</div>` +
    `<div class="website-actions" role="cell"><button id="appPower-${a.id}" class="power-control website-power is-checking" onclick="deploy('${a.id}')" title="Checking deployment state" aria-label="Checking ${safeHtml(a.id)}" disabled><span class="power-symbol">⏻</span></button><span id="appLifecycle-${a.id}"><button disabled>…</button></span><details class="website-menu"><summary aria-label="More actions for ${safeHtml(a.id)}">⋯</summary><div><button onclick="openSite('${a.id}')">Manage site</button><button class="btn danger" onclick="rmApp('${a.id}')">Move to Trash</button></div></details></div></div>`;
}
function websitePageData(apps, { search = '', type = '', sort = 'name', page = 1, size = 10 } = {}) {
  const words = search.toLowerCase().trim().split(/\s+/).filter(Boolean);
  const filtered = apps.filter(a => {
    const text = [a.id, a.name, a.domain, a.repoUrl, a.github && a.github.repo, a.type, dbLabel(a), ...appPublishedServices(a).map(s => s.name)].filter(Boolean).join(' ').toLowerCase();
    return (!type || a.type === type) && words.every(word => text.includes(word));
  }).sort((a, b) => (sort === 'type' ? String(a.type).localeCompare(String(b.type)) : 0) || (siteName(a).localeCompare(siteName(b)) || a.id.localeCompare(b.id)) * (sort === 'name-desc' ? -1 : 1));
  size = [10, 25, 50].includes(Number(size)) ? Number(size) : 10;
  const pages = Math.max(1, Math.ceil(filtered.length / size));
  page = Math.max(1, Math.min(pages, Number(page) || 1));
  const start = (page - 1) * size;
  return { apps: filtered.slice(start, start + size), total: filtered.length, page, pages, start };
}
function filterWebsites() { websitePage = 1; renderWebsites(); }
function changeWebsitePage(delta) { websitePage += delta; renderWebsites(); }
function renderWebsites() {
  const seq = ++websiteRenderSeq;
  const data = websitePageData(websiteApps, {
    search: document.getElementById('websiteSearch').value,
    type: document.getElementById('websiteType').value,
    sort: document.getElementById('websiteSort').value,
    size: document.getElementById('websitePageSize').value,
    page: websitePage
  });
  websitePage = data.page;
  websiteVisibleApps = data.apps;
  document.getElementById('websiteCount').textContent = `${websiteApps.length} site${websiteApps.length === 1 ? '' : 's'}`;
  document.getElementById('apps').innerHTML = !websiteApps.length
    ? '<div class="websites-empty"><b>No websites yet</b><span>Create your first site to get started.</span><button class="btn primary" onclick="openCreate()">+ Create website</button></div>'
    : !data.total ? '<div class="websites-empty"><b>No matching sites</b><span>Try another search or runtime.</span></div>'
      : '<div role="table" aria-label="Websites"><div class="website-columns" role="row"><span role="columnheader">Website</span><span role="columnheader">Runtime</span><span role="columnheader">Status</span><span role="columnheader">Published URLs</span><span role="columnheader">Actions</span></div>' + data.apps.map(appCardMarkup).join('') + '</div>';
  document.getElementById('websitePagination').style.display = websiteApps.length ? 'flex' : 'none';
  document.getElementById('websiteRange').textContent = data.total ? `${data.start + 1}–${data.start + data.apps.length} of ${data.total}${data.total !== websiteApps.length ? ' matches' : ' sites'}` : '0 matches';
  document.getElementById('websitePage').textContent = `${data.page} / ${data.pages}`;
  document.getElementById('websitePrev').disabled = data.page <= 1;
  document.getElementById('websiteNext').disabled = data.page >= data.pages;
  for (const a of data.apps) {
    const cached = websiteStates.get(a.id);
    if (cached) setAppCardState(a.id, cached.state, cached.running);
  }
  if (document.getElementById('view-websites').classList.contains('active') && !document.hidden) hydrateAppCards(data.apps, appsRefreshSeq, seq);
}
function appPublishedServices(a) {
  const list = Array.isArray(a.services) && a.services.length
    ? a.services
    : [{ name: 'app', type: a.type, hostPort: a.hostPort, enabled: true }];
  return list.filter(s => s.enabled !== false && s.hostPort);
}
function appLinksMarkup(a, services) {
  if (!services.length) return '<span class="website-facts">Not published</span>';
  return services.map(s => {
    const path = s.homePath != null ? s.homePath : (s.name === 'app' ? (a.homePath || '') : '');
    const url = `http://${location.hostname}:${s.hostPort}${path}`;
    return `<a class="website-url" href="${safeHtml(url)}" title="${safeHtml((s.name || 'app') + ': ' + url)}" target="_blank" rel="noopener noreferrer">${services.length > 1 ? '<span>' + safeHtml(s.name) + '</span>' : ''}<span>${safeHtml(url.replace(/^http:\/\//, ''))}</span><span aria-hidden="true">↗</span></a>`;
  }).join('');
}
function setAppCardState(id, state, running) {
  websiteStates.set(id, { state, running });
  websiteStateSeq.set(id, (websiteStateSeq.get(id) || 0) + 1);
  const power = document.getElementById('appPower-' + id);
  const lifecycle = document.getElementById('appLifecycle-' + id);
  if (!power || !lifecycle) return;
  const label = state === 'deploying' ? 'Deploying' : state === 'checking' ? 'Checking' : running ? 'Redeploy' : state === 'failed' ? 'Retry' : 'Deploy';
  setPowerState('appPower-' + id, state, label);
  power.disabled = state === 'deploying' || state === 'checking';
  power.title = state === 'deploying' ? 'Deployment in progress' : running ? 'Rebuild and redeploy this site' : 'Build and deploy this site';
  power.setAttribute('aria-label', label + ' ' + id);
  const status = document.getElementById('appState-' + id);
  if (status) { status.className = 'website-state is-' + state; status.textContent = state === 'deploying' ? 'Deploying' : state === 'checking' ? 'Checking' : state === 'failed' ? 'Unavailable' : running ? 'Running' : 'Off'; }
  lifecycle.innerHTML = state === 'deploying' || state === 'checking'
    ? '<button disabled>…</button>'
    : running ? `<button onclick="stopApp('${id}')" aria-label="Stop ${safeHtml(id)}">Stop</button>` : `<button onclick="startApp('${id}')" aria-label="Start ${safeHtml(id)}">Start</button>`;
}
async function websiteStatusRequest(id, current) {
  if (websiteStatusActive < 4) websiteStatusActive++;
  else await new Promise(resolve => websiteStatusWaiters.push(resolve));
  try {
    if (!current()) return null;
    return await (await fetch(`/api/apps/${encodeURIComponent(id)}/status`)).json();
  } finally {
    const next = websiteStatusWaiters.shift();
    if (next) next(); else websiteStatusActive--;
  }
}
async function hydrateAppCards(apps, seq, renderSeq = websiteRenderSeq) {
  let index = 0;
  const current = () => seq === appsRefreshSeq && renderSeq === websiteRenderSeq && document.getElementById('view-websites').classList.contains('active');
  // Only the visible page is probed; cap simultaneous Docker status lookups.
  await Promise.all(Array.from({ length: Math.min(4, apps.length) }, async () => {
    while (index < apps.length && current()) {
      const a = apps[index++];
      const version = websiteStateSeq.get(a.id) || 0;
      try {
        const st = await websiteStatusRequest(a.id, current);
        if (!current() || version !== (websiteStateSeq.get(a.id) || 0)) continue;
        if (!st || st.error) throw new Error('status unavailable');
        const running = appIsRunning(st);
        setAppCardState(a.id, st.deploying ? 'deploying' : (running ? 'deployed' : 'off'), running);
      } catch {
        if (current() && version === (websiteStateSeq.get(a.id) || 0)) setAppCardState(a.id, 'failed', false);
      }
    }
  }));
}
const SITE_TABS = new Set(['overview', 'setup', 'database', 'environment', 'deploy', 'files', 'logs', 'terminal']);
function siteRoute() {
  const p = new URLSearchParams(String(location.hash || '').replace(/^#/, ''));
  const id = p.get('site');
  if (!/^[a-z0-9-]+$/.test(id || '')) return null;
  const tab = SITE_TABS.has(p.get('tab')) ? p.get('tab') : 'overview';
  return { id, tab };
}
function rememberSiteRoute(id, tab) {
  const hash = `site=${encodeURIComponent(id)}&tab=${encodeURIComponent(tab)}`;
  history.replaceState(null, '', `${location.pathname}${location.search}#${hash}`);
}
function openSite(id, tab = 'overview', remember = true) {
  currentApp = id;
  remediateSeq++;
  remediateCache = [];
  document.getElementById('remediateCard').style.display = 'none';
  document.getElementById('remediateBox').innerHTML = '';
  document.getElementById('deployHist').innerHTML = '';
  deployLogSeq++;
  document.getElementById('deployFullLog').textContent = '';
  document.getElementById('deployFullLog').style.display = 'none';
  showView('site');
  tab = SITE_TABS.has(tab) ? tab : 'overview';
  if (remember) rememberSiteRoute(id, tab);
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
  refresh().then(() => { showSiteTab(tab, false); loadDeployStatus(); loadEnv(); loadServices(); loadDatabases(); loadMigrateSuggest(); });
}
function appUrl(a) {
  if (!a.hostPort) return null;
  return `http://${location.hostname}:${a.hostPort}${a.homePath || ''}`;
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
async function saveMigrate() {
  if (!currentApp) return;
  const body = {
    command: document.getElementById('migrateCmd').value,
    service: document.getElementById('migrateSvc').value,
    dir: document.getElementById('migrateDir').value,
    check: document.getElementById('migrateCheck').value
  };
  const r = await (await fetch(`/api/apps/${currentApp}/migrate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();
  toast(r.ok ? (body.command.trim() ? 'migration saved — it runs automatically before every deploy' : 'automatic pre-deploy migration disabled') : (r.error || 'failed'), !!r.ok);
  loadDeployStatus();
}
function fillMigrate(cmd, dir, svc, check) {
  document.getElementById('migrateCmd').value = cmd || '';
  if (dir !== undefined) document.getElementById('migrateDir').value = dir || '';
  if (svc) {
    const sel = document.getElementById('migrateSvc');
    if ([...sel.options].some(o => o.value === svc)) sel.value = svc;
  }
  if (check !== undefined) document.getElementById('migrateCheck').value = check || '';
}
function useMigrateDetection(button) {
  fillMigrate(button.dataset.command, button.dataset.dir, button.dataset.service, button.dataset.check);
  const where = button.dataset.dir ? `/${button.dataset.dir}` : 'service root';
  const message = button.dataset.phase === 'initial'
    ? `Initial-setup command selected in ${button.dataset.service} · ${where}. Run it manually; do not save it as a recurring pre-deploy migration unless the project guarantees that is safe.`
    : `Detected runner selected in ${button.dataset.service} · ${where}. Review the command, then save or run it.`;
  document.getElementById('migrateOut').textContent = message + (button.dataset.warning ? `\n\nConfiguration warning: ${button.dataset.warning}` : '');
}
async function runMigrateNow() {
  if (!currentApp) return;
  const out = document.getElementById('migrateOut');
  out.textContent = 'running migration…';
  const body = {
    command: document.getElementById('migrateCmd').value,
    service: document.getElementById('migrateSvc').value,
    dir: document.getElementById('migrateDir').value
  };
  try {
    const r = await (await fetch(`/api/apps/${currentApp}/migrate-run`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();
    out.textContent = r.ok ? `ok in ${r.service}:\n${r.output}` : ('failed: ' + (r.error || 'unknown'));
  } catch (e) { out.textContent = 'run failed: ' + e.message; }
}
async function verifyMigrate() {
  if (!currentApp) return;
  const out = document.getElementById('migrateOut');
  out.textContent = 'verifying…';
  const body = {
    check: document.getElementById('migrateCheck').value,
    service: document.getElementById('migrateSvc').value,
    dir: document.getElementById('migrateDir').value
  };
  try {
    const r = await (await fetch(`/api/apps/${currentApp}/migrate-check`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();
    out.textContent = r.ok ? `ok in ${r.service}:\n${r.output}` : ('failed: ' + (r.error || 'unknown'));
  } catch (e) { out.textContent = 'verify failed: ' + e.message; }
}
function fillMigrateServiceOptions(services, saved) {
  const sel = document.getElementById('migrateSvc');
  if (!sel) return;
  const prev = sel.value || saved || 'app';
  sel.innerHTML = (services || []).map(s => `<option value="${safeHtml(s.name)}">${safeHtml(s.name)}${s.subdir ? ` (/${safeHtml(s.subdir)})` : ''}</option>`).join('')
    || '<option value="app">app</option>';
  sel.value = [...sel.options].some(o => o.value === prev) ? prev : (sel.options[0] ? sel.options[0].value : 'app');
  if (saved && [...sel.options].some(o => o.value === saved)) sel.value = saved;
}
async function loadMigrateSuggest() {
  if (!currentApp) return;
  const box = document.getElementById('migrateSuggest');
  try {
    const r = await (await fetch(`/api/apps/${currentApp}/migrate-suggest`)).json();
    const list = r.suggestions || [];
    box.innerHTML = list.length ? `<div class="migrate-suggest-label">Detected migration runners</div><div class="migrate-suggest-list">${list.map(s => {
      const location = s.runnable
        ? `${s.service} · ${s.dir ? `/${s.dir}` : 'service root'}`
        : `${s.repoDir || 'repository'} · not runnable yet`;
      const phase = s.phase === 'initial' ? 'initial setup' : 'deployment';
      if (!s.runnable) return `<div class="migrate-detect unavailable"><div><b>${safeHtml(s.framework || 'Migration')}</b><span>${safeHtml(phase)}</span></div><small>${safeHtml(s.problem || s.why || 'Needs configuration')}</small><em>${safeHtml(location)}</em></div>`;
      return `<button class="migrate-detect${s.warning ? ' has-warning' : ''}" data-command="${safeHtml(s.command || s.cmd)}" data-dir="${safeHtml(s.dir || '')}" data-service="${safeHtml(s.service || s.svc || '')}" data-check="${safeHtml(s.check || '')}" data-phase="${safeHtml(s.phase || 'deploy')}" data-warning="${safeHtml(s.warning || '')}" onclick="useMigrateDetection(this)" title="${safeHtml(s.why || '')}"><div><b>${safeHtml(s.framework || 'Migration')}</b><span>${safeHtml(phase)}</span></div><code>${safeHtml(s.command || s.cmd)}</code>${s.warning ? `<small>${safeHtml(s.warning)}</small>` : ''}<em>${safeHtml(location)}</em></button>`;
    }).join('')}</div>` : '<div class="migrate-suggest-label">No migration runner detected — enter the service, folder, and project command manually.</div>';
  } catch { box.innerHTML = ''; }
}
function deploySourceName(source) {
  return ({ manual: 'Manual', local: 'Local files', webhook: 'GitHub webhook', poll: 'GitHub poll', 'local-push': 'Local push' })[source] || source || 'Unknown';
}
function renderDeployMarkup(box, html) {
  if (box.dataset.rendered === html && box.innerHTML) return;
  const scrollTop = box.scrollTop;
  const expanded = new Map([...box.querySelectorAll('details[data-record]')].map(d => [d.dataset.record, d.open]));
  box.innerHTML = html;
  box.dataset.rendered = html;
  for (const detail of box.querySelectorAll('details[data-record]')) if (expanded.has(detail.dataset.record)) detail.open = expanded.get(detail.dataset.record);
  box.scrollTop = scrollTop;
}
function deployRecordParts(h) {
  const when = (h.at || '').replace('T', ' ').slice(0, 19) || 'time unavailable';
  const duration = h.durationMs != null ? `${Math.round(h.durationMs / 1000)}s` : '';
  const sha = h.sha ? String(h.sha).slice(0, 7) : '';
  const error = h.error ? String(h.error).trim() : '';
  return { when, duration, sha, error, ok: h.status === 'ok' };
}
function deployHistoryMarkup(hist) {
  if (!hist.length) return '<div class="deploy-empty">No deployments recorded yet.</div>';
  return hist.map(h => {
    const p = deployRecordParts(h);
    return `<div class="deploy-history-item ${p.ok ? 'is-ok' : 'is-failed'}">` +
      `<div class="deploy-history-title"><b>${safeHtml(deploySourceName(h.source))}</b><span class="deploy-result">${p.ok ? 'success' : 'failed'}</span></div>` +
      `<div class="deploy-history-details"><span>${safeHtml(p.when)}</span>${p.sha ? `<code>${safeHtml(p.sha)}</code>` : ''}${p.duration ? `<span>${safeHtml(p.duration)}</span>` : ''}</div>` +
      (p.error ? `<details class="deploy-history-failure" data-record="${safeHtml(h.at || p.error)}"><summary>${safeHtml(p.error.split('\n')[0].slice(0, 140))}${p.error.length > 140 ? '…' : ''}</summary><div class="deploy-history-error">${safeHtml(p.error)}</div></details>` : '') + `</div>`;
  }).join('');
}
let remediateSeq = 0;
let remediateCache = [];
let deployLogSeq = 0;
async function loadRemediations(failed) {
  const card = document.getElementById('remediateCard');
  const box = document.getElementById('remediateBox');
  if (!card || !box) return;
  const seq = ++remediateSeq;
  if (!currentApp) { remediateCache = []; card.style.display = 'none'; box.innerHTML = ''; return; }
  const appId = currentApp;
  try {
    const list = await (await fetch(`/api/apps/${appId}/remediations`)).json();
    if (seq !== remediateSeq || currentApp !== appId) return;
    if (!Array.isArray(list)) throw new Error(list.error || 'invalid fixes response');
    remediateCache = Array.isArray(list) ? list : [];
    card.style.display = remediateCache.length ? 'block' : 'none';
    renderDeployMarkup(box, remediateCache.map((s, i) =>
      `<div class="remediate-item"><div class="remediate-head"><div><b>${safeHtml(s.title)}</b><div class="meta">Service: ${safeHtml(s.service || 'app')} · ${safeHtml(s.subdir || 'repository root')}</div></div>` +
      (s.key ? `<button class="btn primary" onclick="applyRemediation(${i})">${s.kind === 'dockerfile-restore' ? 'restore original Dockerfile' : s.kind === 'import-repair' ? 'apply import correction' : 'apply fix'}</button>` : s.protectionKey ? `<button onclick="removeImportProtection(${i})">remove protection</button>` : '') + '</div>' +
      `<details class="remediate-review" data-record="${safeHtml((s.service || '') + ':' + (s.key || s.protectionKey || s.title))}"${s.key ? ' open' : ''}><summary>${s.preview ? 'Review files and exact diff' : 'Details'}</summary><div class="meta">${safeHtml(s.detail)}</div>` +
      ((s.files || []).length ? `<ul class="remediate-files">${s.files.map(f => `<li>${safeHtml(f)}</li>`).join('')}</ul>` : '') +
      (s.preview ? `<pre tabindex="0" aria-label="Proposed changes">${safeHtml(s.preview)}</pre>` : '') + '</details></div>'
    ).join(''));
  } catch (e) {
    if (seq === remediateSeq && currentApp === appId) {
      remediateCache = [];
      card.style.display = 'block';
      box.innerHTML = `<div class="meta">Could not load fixes: ${safeHtml(e.message)}</div>`;
    }
  }
}
async function loadDeployLog() {
  if (!currentApp) return;
  const box = document.getElementById('deployFullLog');
  if (!box) return;
  const appId = currentApp;
  const seq = ++deployLogSeq;
  box.style.display = 'block';
  if (!box.textContent) box.textContent = 'loading…';
  try {
    const text = await (await fetch(`/api/apps/${appId}/build-log?tail=500`)).text();
    if (seq === deployLogSeq && currentApp === appId && box.textContent !== text) {
      const scrollTop = box.scrollTop;
      box.textContent = text;
      box.scrollTop = scrollTop;
    }
  } catch { if (seq === deployLogSeq && currentApp === appId) box.textContent = 'log unavailable'; }
}
async function applyRemediation(i) {
  const s = remediateCache[i];
  if (!s || !s.key || !currentApp) return;
  const appId = currentApp;
  const ok = await uiConfirm({
    title: s.kind === 'import-repair' ? 'Apply import correction?' : 'Apply fix?',
    body: s.kind === 'import-repair'
      ? `${s.title}. Files: ${(s.files || []).join(', ')}. The approved import-only repair is retained outside Git and revalidated on redeploy. Changed or ambiguous source stops for review. Your remote repo stays untouched. Use local rebuild now.\n\n${s.preview || ''}`
      : `${s.title}. Writes box files only (${(s.files || []).join(', ')}) — use local rebuild afterwards to preserve box edits. Your remote repo stays untouched until you commit.`,
    confirmLabel: s.kind === 'import-repair' ? 'Apply imports' : 'Apply fix'
  });
  if (!ok || currentApp !== appId) return;
  try {
    const r = await (await fetch(`/api/apps/${appId}/remediate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: s.key, service: s.service, revision: s.revision }) })).json();
    toast(r.ok ? `${r.protected ? 'saved with redeploy protection' : 'saved'} (${(r.applied || []).join(', ')}) — use local rebuild to apply` : (r.error || 'failed'), !!r.ok);
  } catch (e) { toast('apply failed: ' + e.message, false); }
  await refresh();
  if (currentApp === appId) loadDeployStatus();
}
async function removeImportProtection(i) {
  const s = remediateCache[i];
  if (!s || !s.protectionKey || !currentApp) return;
  const appId = currentApp;
  const ok = await uiConfirm({ title: 'Remove redeploy protection?', body: `Stop retaining this approved correction for ${s.service}: ${(s.files || []).join(', ')}. Current source files are not changed. Future checkouts will use repository source; commit the correction there if it is still needed.`, confirmLabel: 'Remove protection', danger: true });
  if (!ok || currentApp !== appId) return;
  try {
    const r = await (await fetch(`/api/apps/${appId}/import-protection`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: s.protectionKey, service: s.service, revision: s.revision }) })).json();
    toast(r.ok ? 'protection removed — current files unchanged' : (r.error || 'failed'), !!r.ok);
    if (currentApp === appId) await loadRemediations(true);
  } catch (e) { toast('remove protection failed: ' + e.message, false); }
}
function deployLastMarkup(label, h) {
  if (!h) return `<div class="source-last-empty">${safeHtml(label)}: no deployment recorded</div>`;
  const p = deployRecordParts(h);
  return `<div class="source-last-head"><span>${safeHtml(label)}</span><span class="deploy-result ${p.ok ? 'is-ok' : 'is-failed'}">${p.ok ? 'success' : 'failed'}</span></div>` +
    `<div class="source-last-detail"><span>${safeHtml(p.when)}</span>${p.sha ? `<code>${safeHtml(p.sha)}</code>` : ''}${p.duration ? `<span>${safeHtml(p.duration)}</span>` : ''}</div>`;
}
function storageSize(value) {
  if (!Number.isFinite(value) || value < 0) return 'unavailable';
  if (value < 1024) return `${value} B`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let size = value / 1024, unit = 0;
  while (size >= 1024 && unit < units.length - 1) { size /= 1024; unit++; }
  return `${size.toFixed(1)} ${units[unit]}`;
}
function storageMarkup(report) {
  const disk = report.disk;
  const q = report.quota;
  const allowance = q ? `<div class="storage-disk${q.enforced ? '' : ' is-low'}"><b>${Number(q.limitBytes / 1e9).toLocaleString()} GB allowance · ${q.enforced ? 'enforced' : 'not confirmed'}</b><div>${storageSize(q.usedBytes)} used · ${storageSize(q.remainingBytes)} remaining</div><div class="meta">Site files + managed database data.${q.error ? ' ' + safeHtml(q.error) : ''}</div></div>` : '<div class="meta">Legacy site: no enforced storage allowance. Existing files/databases have not been migrated.</div>';
  return allowance + (disk ? `<div class="meta${disk.low ? ' is-low' : ''}">Host: ${storageSize(disk.freeBytes)} free of ${storageSize(disk.totalBytes)} · ${Number(disk.usedPercent)}% used${disk.low ? ' · low disk space' : ''}. Shared Docker storage may use another filesystem.</div>` : '') +
    (report.containers || []).map(c => `<div class="storage-row"><b>${safeHtml(c.service || c.name)} · ${safeHtml(c.state)}</b><span>Filesystem: ${storageSize(c.rootFsBytes)} · writable layer: ${storageSize(c.writableBytes)}</span></div>`).join('') +
    (report.dockerAvailable && !(report.containers || []).length ? '<div class="meta">No containers present. Site files or retained images may still use disk space.</div>' : '') +
    (report.warnings || []).map(w => `<div class="meta">${safeHtml(w)}</div>`).join('');
}
let storageRequestSeq = 0;
async function loadStorage() {
  const id = currentApp;
  if (!id) return;
  const seq = ++storageRequestSeq;
  const box = document.getElementById('siteStorage');
  box.innerHTML = '<div class="meta">Measuring storage…</div>';
  try {
    const response = await fetch(`/api/apps/${id}/storage`);
    const report = await response.json();
    if (seq !== storageRequestSeq || id !== currentApp) return;
    box.innerHTML = response.ok ? storageMarkup(report) : `<div class="meta">${safeHtml(report.error || 'Storage unavailable.')}</div>`;
  } catch {
    if (seq === storageRequestSeq && id === currentApp) box.innerHTML = '<div class="meta">Storage unavailable. Try refresh sizes.</div>';
  }
}
function runtimeKind(container, service) {
  if (service) return ({ node: 'Node.js service', react: 'React web app', static: 'Static website', php: 'PHP web app' })[service.type] || `${service.type || 'app'} service`;
  const hint = `${container.service || ''} ${container.image || ''}`.toLowerCase();
  if (hint.includes('postgres')) return 'PostgreSQL database';
  if (hint.includes('redis')) return 'Redis cache';
  if (hint.includes('mariadb')) return 'MariaDB database';
  if (hint.includes('mysql')) return 'MySQL database';
  if (hint.includes('mongo')) return 'MongoDB database';
  return 'Supporting container';
}
function runtimeVersion(container, service, liveDeploy) {
  if (!service) return container.image ? `image ${container.image}` : 'image version unavailable';
  const location = service.subdir ? `/${service.subdir}` : 'repository root';
  const ports = service.hostPort ? ` · :${service.hostPort}→${service.port || '?'}` : (service.port ? ` · port ${service.port}` : '');
  const source = liveDeploy && liveDeploy.sha ? `commit ${String(liveDeploy.sha).slice(0, 7)}` : 'source version unavailable';
  return `${source} · ${location}${ports}`;
}
async function loadDeployStatus() {
  if (!currentApp) return;
  const appId = currentApp;
  const seq = ++deployStatusSeq;
  const info = document.getElementById('deployInfo');
  const list = document.getElementById('containerList');
  if (!info.dataset.live) info.textContent = 'loading…';
  try {
    const s = await (await fetch(`/api/apps/${appId}/status`)).json();
    if (seq !== deployStatusSeq || currentApp !== appId) return;
    if (s.error) { info.textContent = s.error; list.innerHTML = ''; return; }
    info.dataset.live = '1';
    const d = s.lastDeploy;
    info.textContent = d
      ? `${d.status === 'ok' ? 'live' : 'FAILED'} @ ${d.sha || '?'} · ${d.at || ''}${d.error ? ' — ' + d.error : ''}`
      : 'never deployed by the panel';
    const containers = s.containers || [];
    const running = containers.filter(c => /^running/i.test(c.state || '')).length;
    document.getElementById('runtimeHeading').textContent = running === 1
      ? 'The version currently running for this site'
      : running > 1 ? `The ${running} versions currently running for this site` : 'No versions are currently running for this site';
    const live = s.liveDeploy;
    document.getElementById('runtimeSummary').textContent = live && live.sha
      ? `Application source commit ${String(live.sha).slice(0, 7)}, deployed via ${live.source || 'panel'}${live.at ? ` on ${String(live.at).replace('T', ' ').slice(0, 19)}` : ''}. Database rows show their image versions.`
      : 'Application source version is not recorded yet. Database rows show their image versions.';
    const services = new Map((s.services || []).map(x => [x.name, x]));
    list.innerHTML = containers.map(c => {
      const service = services.get(c.service);
      const up = /^running/i.test(c.state || '');
      return `<div class="runtime-row"><div><span class="opdot ${up ? 'ok' : 'fail'}"></span> <b>${c.service}</b> <span class="badge type">${runtimeKind(c, service)}</span></div>` +
        `<div class="runtime-version">${runtimeVersion(c, service, live)}</div>` +
        `<div class="runtime-state"><b>${c.state || '?'}</b>${c.status ? ` · ${c.status}` : ''}</div></div>`;
    }).join('') || '<div class="meta">No application or database containers are present.</div>';
    const hp = document.getElementById('homePath');
    if (hp && s.app) hp.value = s.app.homePath || '';
    if (s.app) renderRouteChoices(s.app);
    const mc = document.getElementById('migrateCmd');
    if (mc && s.app) mc.value = s.app.migrateCmd || '';
    if (s.app) {
      document.getElementById('migrateDir').value = s.app.migrateDir || '';
      document.getElementById('migrateCheck').value = s.app.migrateCheck || '';
      fillMigrateServiceOptions(s.services, s.app.migrateSvc);
    }
    // persistent per-trigger record: visible anytime, no open page needed
    const hist = s.history || [];
    const lastSrc = (...srcs) => hist.find(h => srcs.includes(h.source));
    const hookLast = lastSrc('webhook', 'poll');
    document.getElementById('hookHist').innerHTML = deployLastMarkup('Last GitHub deploy', hookLast);
    const localLast = lastSrc('local-push');
    document.getElementById('localHist').innerHTML = deployLastMarkup('Last local push', localLast);
    renderDeployMarkup(document.getElementById('deployHist'), deployHistoryMarkup(hist));
    const failed = !s.deploying && s.lastDeploy && s.lastDeploy.status !== 'ok';
    loadRemediations(failed);
    if (failed) loadDeployLog();
    updatePowerStates(s);
  } catch {
    if (seq !== deployStatusSeq || currentApp !== appId) return;
    if (!info.dataset.live) info.textContent = 'unreachable';
    setPowerState('sitePower', 'failed', 'Unreachable');
    setPowerState('hookPower', 'failed', 'Unknown');
    setPowerState('localPower', 'failed', 'Unknown');
  }
}
function backToSites() {
  currentApp = null;
  history.replaceState(null, '', `${location.pathname}${location.search}`);
  showView('websites');
  refresh();
  loadTrash();
}
function fillSiteHeader(a) {
  if (!a) return;
  document.getElementById('siteName').textContent = siteName(a);
  document.getElementById('siteName').title = 'Site ID: ' + a.id;
  document.getElementById('siteBadges').innerHTML =
    `<span class="badge type">${a.type}</span><span class="badge">db: ${dbLabel(a)}</span>${a.domain ? `<span class="badge">${a.domain}</span>` : ''}${a.hostPort ? `<span class="badge">:${a.hostPort}</span>` : ''}${a.subdir ? `<span class="badge">/${a.subdir}</span>` : ''}${a.github ? `<span class="badge">git: ${a.github.login ? a.github.login + '/' : ''}${a.github.repo}${a.github.branch ? '@' + a.github.branch : ''}</span>` : ''}`;
  const url = appUrl(a);
  document.getElementById('siteMeta').innerHTML = (url ? `live URL: <a href="${url}" target="_blank">${url.replace(/^http:\/\//, '')}</a>` : 'no published port') + ` · ID: ${safeHtml(a.id)}`;
  document.getElementById('siteRedeploy').onclick = () => { showSiteTab('deploy'); deploy(a.id); };
  document.getElementById('siteStop').onclick = () => stopApp(a.id);
  document.getElementById('siteStart').onclick = () => startApp(a.id);
  document.getElementById('siteDelete').onclick = () => rmApp(a.id);
  const power = document.getElementById('sitePower');
  if (power && power.dataset.app !== a.id) {
    power.dataset.app = a.id;
    setPowerState('sitePower', 'checking', 'Checking');
  }
  fillGithubAutomation(a);
  document.getElementById('dbList').textContent = 'attached: ' + dbLabel(a);
  document.getElementById('dbOut').textContent = '';
  const keyOut = document.getElementById('repoKeyOut');
  const keyToggle = document.getElementById('repoKeyToggle');
  if (keyOut.dataset.app !== a.id) {
    keyOut.dataset.app = a.id;
    keyOut.dataset.open = '0';
    keyOut.textContent = '';
    keyToggle.textContent = 'show key';
  }
  fillApiLink(a);
  fillGitConn(a);
  document.getElementById('homePath').value = a.homePath || '';
  renderRouteChoices(a);
  const box = document.getElementById('localGitBox');
  if (a.localGit) {
    const remote = `root@${location.hostname}:/srv/apps/${a.id}/repo.git`;
    const remoteCommand = `git remote add minipass ${remote}`;
    box.innerHTML = `<div class="local-git-status"><div><b>Direct push is enabled</b><div class="meta">Run these commands in your local repository.</div></div><span class="badge service-state on">enabled</span></div>` +
      `<div class="local-git-toggle"><button class="btn danger" onclick="disableLocalGit()">disable direct push</button></div>` +
      `<div class="local-command"><span>1 · Add the remote once</span><div class="deploy-copy-row"><code id="localRemote">${safeHtml(remoteCommand)}</code><button onclick="copyLocal()">copy</button></div></div>` +
      `<div class="local-command"><span>2 · Push your branch</span><code>git push minipass main</code><small>Use <b>master</b> instead when that is your branch.</small></div>`;
  } else {
    box.innerHTML = `<div class="local-git-disabled"><b>Direct push is not configured</b><div class="meta">Create a private bare Git remote and its deploy hook on this server.</div><button class="btn primary" onclick="initLocalGit()">enable local git push</button></div>`;
  }
}
function fillGithubAutomation(a) {
  const off = document.getElementById('githubAutomationOff');
  const on = document.getElementById('githubAutomationOn');
  const title = document.getElementById('githubAutomationOffTitle');
  const meta = document.getElementById('githubAutomationOffMeta');
  const enable = document.getElementById('githubAutomationEnable');
  if (!off || !on || !title || !meta || !enable) return;
  if (!a.github || !a.github.repo) {
    off.style.display = 'block'; on.style.display = 'none'; enable.style.display = 'none';
    title.textContent = 'No GitHub repository linked';
    meta.textContent = 'Connect a repository in Setup before enabling automatic deployments.';
    return;
  }
  if (a.github.enabled !== true) {
    off.style.display = 'block'; on.style.display = 'none'; enable.style.display = '';
    title.textContent = 'GitHub automation is disabled';
    meta.textContent = `${a.github.repo}${a.github.branch ? '@' + a.github.branch : ''} stays linked for manual repository redeploys. No webhook or polling deploys will run.`;
    return;
  }
  off.style.display = 'none'; on.style.display = 'block';
  const minutes = parseInt(a.github.pollMinutes, 10) || 0;
  document.getElementById('hookUrl').textContent = `${location.origin}/webhook/${a.id}?token=${a.token}`;
  document.getElementById('pollSel').value = String(minutes);
  document.getElementById('pollState').textContent = `tracking ${a.github.repo}${a.github.branch ? '@' + a.github.branch : ''} · ${String(a.github.sha || '?').slice(0, 7)}${minutes > 0 ? ` — checked every ${minutes}m` : ' — polling off'}`;
}
async function copyText(text) {
  // navigator.clipboard needs a secure context (https/localhost) - plain LAN
  // http falls back to the legacy execCommand path, which still works there.
  try {
    if (navigator.clipboard && navigator.clipboard.writeText && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {}
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, ta.value.length);
    const ok = document.execCommand('copy');
    ta.remove();
    return !!ok;
  } catch { return false; }
}
async function copyLocal() {
  const ok = await copyText(document.getElementById('localRemote').textContent);
  toast(ok ? 'remote command copied' : 'copy failed - select and copy manually', ok);
}
async function initLocalGit() {
  if (!currentApp) return;
  const r = await (await fetch(`/api/apps/${currentApp}/git-init`, { method: 'POST' })).json();
  if (r.ok) { toast('local git ready - push to deploy'); refresh(); }
  else toast(r.error || 'failed', false);
}
// Disable = remove the hook, keep the repo: pushes land but no longer rebuild.
// One click re-enables (rewrites the hook).
async function disableLocalGit() {
  if (!currentApp) return;
  const r = await (await fetch(`/api/apps/${currentApp}/git-init`, { method: 'DELETE' })).json();
  if (r.ok) { toast('local git disabled - pushes land without rebuilding'); refresh(); }
  else toast(r.error || 'failed', false);
}
async function copyHook() {
  const el = document.getElementById('hookUrl');
  if (el) await copyText(el.textContent);
}
async function loadEnv() {
  if (!currentApp) return;
  const box = document.getElementById('envList');
  box.innerHTML = '<div class="meta">loading…</div>';
  try {
    const r = await (await fetch(`/api/apps/${currentApp}/env`)).json();
    if (r.error) { box.innerHTML = '<div class="meta">' + safeHtml(r.error) + '</div>'; return; }
    box.innerHTML = (r.vars || []).map(v => {
      const key = safeHtml(v.key);
      const value = safeHtml(v.value);
      const protectedKey = v.key === 'NODE_ENV';
      const keyInput = `<input class="env-name" value="${key}" ${v.managed || protectedKey ? 'readonly' : ''} aria-label="Environment key">`;
      const badge = v.managed ? '<span class="badge">managed</span>' : '';
      const canEditValue = !v.managed || v.key === 'DOMAIN';
      const isDomain = v.key === 'DOMAIN';
      if (v.key === 'NODE_ENV' && !v.managed) {
        const cur = String(v.value).trim();
        return `<div class="env-row" data-env-original="${key}" data-env-managed="0"><div class="env-key-cell">${keyInput}${badge}</div>` +
          `<select class="env-value" aria-label="${key} value"><option value="development"${cur === 'development' ? ' selected' : ''}>development</option><option value="production"${cur === 'production' ? ' selected' : ''}>production</option></select>` +
          `<div class="env-row-actions"><span class="meta">required</span></div></div>`;
      }
      return `<div class="env-row" data-env-original="${key}" data-env-managed="${v.managed ? '1' : '0'}"><div class="env-key-cell">${keyInput}${badge}</div>` +
        `<input class="env-value" type="${isDomain ? 'text' : 'password'}" value="${value}" ${canEditValue ? '' : 'readonly'} ${isDomain ? 'placeholder="app.example.com"' : ''} aria-label="${key} value">` +
        `<div class="env-row-actions">${isDomain ? '<span class="meta">hostname</span>' : `<button onclick="toggleEnv(this)">show</button>${canEditValue ? `<button onclick="genEnvRow(this)">generate</button>` : ''}`}${v.managed ? '' : ` <button class="btn danger" onclick="envDel('${v.key}')">delete</button>`}</div></div>`;
    }).join('') || '<div class="meta">(empty env)</div>';
  } catch { box.innerHTML = '<div class="meta">load failed</div>'; }
}
function toggleEnv(btn) {
  const input = btn.closest('.env-row').querySelector('input.env-value');
  if (!input) return;
  const showing = btn.textContent === 'hide';
  input.type = showing ? 'password' : 'text';
  btn.textContent = showing ? 'show' : 'hide';
}
async function saveEnv() {
  if (!currentApp) return;
  const set = {};
  const del = [];
  const rename = {};
  const seen = new Set();
  for (const row of document.querySelectorAll('#envList .env-row')) {
    const original = row.dataset.envOriginal;
    const managed = row.dataset.envManaged === '1';
    const key = row.querySelector('.env-name').value.trim();
    const value = row.querySelector('.env-value').value;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      toast(`invalid environment key: ${key || '(empty)'}`, false);
      return;
    }
    if (seen.has(key)) {
      toast(`duplicate environment key: ${key}`, false);
      return;
    }
    seen.add(key);
    if (!managed || original === 'DOMAIN') set[key] = value;
    if (!managed && key !== original) { del.push(original); rename[original] = key; }
  }
  document.getElementById('envOut').textContent = 'saving… (redeploy to apply)';
  try {
    const r = await (await fetch(`/api/apps/${currentApp}/env`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ set, delete: del, rename }) })).json();
    document.getElementById('envOut').textContent = JSON.stringify(r, null, 2);
    if (!r.ok) { toast(r.error || 'save failed', false); return; }
    toast('environment saved - redeploy to apply');
    loadEnv(); refresh(); loadServices();
  } catch (e) { document.getElementById('envOut').textContent = 'failed: ' + e.message; toast('environment save failed', false); }
}
async function fillEnvDefaults() {
  if (!currentApp) return;
  document.getElementById('envOut').textContent = 'adding defaults… (redeploy to apply)';
  try {
    const r = await (await fetch(`/api/apps/${currentApp}/env/defaults`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json();
    document.getElementById('envOut').textContent = JSON.stringify(r, null, 2);
    const changed = [...(r.added || []), ...(r.updated || [])];
    toast(r.ok ? (changed.length ? ('defaults loaded: ' + changed.join(', ') + ' - redeploy to apply') : 'defaults already correct') : (r.error || 'failed'), !!r.ok);
    loadEnv(); refresh(); loadServices();
  } catch (e) { document.getElementById('envOut').textContent = 'failed: ' + e.message; }
}
async function genToken() {
  const format = document.getElementById('tokFormat').value;
  const bytes = parseInt(document.getElementById('tokLen').value, 10) || 32;
  const out = document.getElementById('tokOut');
  out.value = 'generating…';
  try {
    const r = await (await fetch('/api/tools/token', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ format, bytes }) })).json();
    if (!r.ok && !r.value) { toast(r.error || 'generate failed', false); out.value = ''; return; }
    out.value = r.value;
  } catch (e) { out.value = ''; toast('generate failed: ' + e.message, false); }
}
async function copyToken() {
  const el = document.getElementById('tokOut');
  const v = el.value;
  if (!v) { toast('generate a secret first', false); return; }
  if (await copyText(v)) { toast('secret copied - paste it somewhere safe'); return; }
  el.focus();
  el.select();
  toast('copy failed - value selected, press Ctrl+C', false);
}
function tokenToNew() {
  const v = document.getElementById('tokOut').value;
  if (!v) { toast('generate a secret first', false); return; }
  document.getElementById('envVal').value = v;
  document.getElementById('envKey').focus();
  toast('secret placed in the new-variable value field');
}
async function genEnvRow(btn) {
  const input = btn.closest('.env-row').querySelector('.env-value');
  if (!input) return;
  const format = document.getElementById('tokFormat').value;
  const bytes = parseInt(document.getElementById('tokLen').value, 10) || 32;
  btn.disabled = true;
  try {
    const r = await (await fetch('/api/tools/token', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ format, bytes }) })).json();
    if (!r.ok && !r.value) { toast(r.error || 'generate failed', false); return; }
    input.value = r.value;
    input.type = 'text';
    toast('fresh secret filled - save changes to apply');
  } catch (e) { toast('generate failed: ' + e.message, false); }
  finally { btn.disabled = false; }
}
async function envDownload(example) {
  if (!currentApp) return;
  const r = await (await fetch(`/api/apps/${currentApp}/env`)).json();
  if (r.error) { toast(r.error, false); return; }
  const text = example
    ? '# copy to .env and fill in - generated for redeploy elsewhere\n' + (r.vars || []).map(v => `${v.key}=`).join('\n') + '\n'
    : (r.vars || []).map(v => `${v.key}=${v.value}`).join('\n') + '\n';
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
  a.download = currentApp + (example ? '.env.example' : '.env');
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
async function envAdd() {
  if (!currentApp) return;
  const k = document.getElementById('envKey').value.trim();
  const v = document.getElementById('envVal').value;
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) { toast('enter a valid environment key', false); return; }
  try {
    const r = await (await fetch(`/api/apps/${currentApp}/env`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ set: { [k]: v } }) })).json();
    document.getElementById('envOut').textContent = JSON.stringify(r, null, 2);
    if (!r.ok) { toast(r.error || 'add failed', false); return; }
    if ((r.skipped || []).includes(k)) { toast(`${k} is managed and cannot be replaced`, false); return; }
    document.getElementById('envKey').value = '';
    document.getElementById('envVal').value = '';
    toast(`${k} added - redeploy to apply`);
    loadEnv(); refresh(); loadServices();
  } catch (e) { toast('add failed: ' + e.message, false); }
}
async function envDel(key) {
  if (!currentApp) return;
  const ok = await uiConfirm({ title: 'Delete ' + key + '?', body: 'Remove it from ' + currentApp + '. Redeploy afterward to apply.', confirmLabel: 'Delete', danger: true });
  if (!ok) return;
  const r = await (await fetch(`/api/apps/${currentApp}/env`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ delete: [key] }) })).json();
  document.getElementById('envOut').textContent = JSON.stringify(r, null, 2);
  loadEnv();
}
async function addDb() {
  if (!currentApp) return;
  const type = document.getElementById('dbAdd').value;
  document.getElementById('dbOut').textContent = 'adding ' + type + '… (redeploy to apply)';
  try {
    const r = await (await fetch(`/api/apps/${currentApp}/db`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type }) })).json();
    document.getElementById('dbOut').textContent = JSON.stringify(r, null, 2);
    refresh(); loadServices(); loadDatabases();
  } catch (e) { document.getElementById('dbOut').textContent = 'failed: ' + e.message; }
}
function safeHtml(v) {
  return String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
async function loadDatabases() {
  if (!currentApp) return;
  const box = document.getElementById('dbRuntimeList');
  if (!box) return;
  box.innerHTML = '<div class="meta">checking database services…</div>';
  try {
    const r = await (await fetch(`/api/apps/${currentApp}/databases`)).json();
    if (r.error) { box.innerHTML = `<div class="meta">${safeHtml(r.error)}</div>`; return; }
    box.innerHTML = (r.databases || []).map(d => {
      const running = /^running/i.test(d.state || '');
      const toolPort = parseInt(d.toolPort, 10);
      const toolRunning = d.toolState === 'running' && toolPort >= 8900 && toolPort <= 8999;
      const action = toolRunning
        ? `<button class="btn primary" onclick="openDbTool('${d.type}', ${toolPort})">open ${safeHtml(d.tool)}</button><button onclick="stopDbTool('${d.type}')">stop UI</button>`
        : `<button class="btn primary" onclick="launchDbTool('${d.type}')" ${running ? '' : 'disabled'}>launch ${safeHtml(d.tool)}</button>`;
      const dumpBtn = `<button onclick="downloadDbDump('${d.type}')" ${running ? '' : 'disabled'} title="download a full dump of this database">dump</button>`;
      let toolStatus = `${safeHtml(d.tool)} is stopped`;
      if (toolRunning) {
        const mins = d.toolExpiresAt ? Math.max(1, Math.ceil((new Date(d.toolExpiresAt).getTime() - Date.now()) / 60000)) : (r.toolTtlMinutes || 30);
        toolStatus = `${safeHtml(d.tool)} running on port ${toolPort} · stops in about ${Number.isFinite(mins) ? mins : (r.toolTtlMinutes || 30)} min`;
      } else if (d.toolState && d.toolState !== 'stopped') toolStatus = `${safeHtml(d.tool)}: ${safeHtml(d.toolState)}`;
      return `<div class="db-runtime-card"><div class="db-runtime-title"><span class="opdot ${running ? 'ok' : 'fail'}"></span><b>${safeHtml(d.label)}</b><span class="badge">${safeHtml(d.service)}</span></div>` +
        `<div class="meta">${safeHtml(d.image || 'image unavailable')}</div><div class="meta"><b>${safeHtml(d.state)}</b>${d.status ? ` · ${safeHtml(d.status)}` : ''}</div>` +
        `<div class="db-tool-status">${toolStatus}</div><div class="db-runtime-actions">${action}${dumpBtn}</div></div>`;
    }).join('') || '<div class="meta">No managed databases are attached.</div>';
  } catch (e) { box.innerHTML = '<div class="meta">database status unavailable</div>'; }
}
function dbPopupKey(appId, type) { return `${appId}:${type}`; }
function watchDbPopup(appId, type, popup) {
  const key = dbPopupKey(appId, type);
  const old = dbPopupSlots.get(key);
  if (old) clearInterval(old.timer);
  const timer = setInterval(() => {
    if (!popup.closed) return;
    clearInterval(timer);
    dbPopupSlots.delete(key);
    stopDbTool(type, appId, true);
  }, 1000);
  dbPopupSlots.set(key, { popup, timer });
}
function openDbTool(type, port) {
  if (!currentApp) return;
  const appId = currentApp;
  const key = dbPopupKey(appId, type);
  const old = dbPopupSlots.get(key);
  if (old && !old.popup.closed) { old.popup.focus(); return; }
  const popup = window.open(`http://${location.hostname}:${port}`, `dbui-${appId}-${type}`);
  if (!popup) { toast('allow popups to open the database UI', false); return; }
  watchDbPopup(appId, type, popup);
}
async function launchDbTool(type) {
  if (!currentApp) return;
  const appId = currentApp;
  const popup = window.open('', `dbui-${appId}-${type}`);
  if (popup) popup.document.body.innerHTML = '<p style="font-family:system-ui">Starting the database UI from this server…</p>';
  toast('starting database UI…');
  try {
    const r = await (await fetch(`/api/apps/${appId}/databases/${type}/tool`, { method: 'POST' })).json();
    if (!r.ok) {
      if (popup) popup.close();
      toast(r.error || 'database UI failed to start', false);
      return;
    }
    const url = `http://${location.hostname}:${r.port}`;
    toast(`${r.tool} started on port ${r.port}`, true);
    if (currentApp === appId) loadDatabases();
    if (popup && popup.closed) await stopDbTool(type, appId, true);
    else if (popup) { popup.location.href = url; watchDbPopup(appId, type, popup); }
    else toast('database UI started - allow popups, then use the open button', false);
  } catch (e) {
    if (popup) popup.close();
    toast('database UI failed: ' + e.message, false);
  }
}
async function pullDbToolImages() {
  const out = document.getElementById('dbToolImgOut');
  if (out) out.textContent = 'installing / upgrading admin images…';
  toast('installing / upgrading database admin images…');
  try {
    const r = await (await fetch('/api/panel/db-tools/pull', { method: 'POST' })).json();
    if (r.results) {
      const failed = r.results.filter(x => !x.ok);
      if (out) out.textContent = failed.length ? `done with ${failed.length} failure(s): ${failed.map(x => x.image).join(', ')}` : 'admin images installed on this server';
      toast(failed.length ? `image install finished with ${failed.length} failure(s)` : 'database admin images installed', !failed.length);
    } else {
      if (out) out.textContent = r.error || 'failed';
      toast(r.error || 'image download failed', false);
    }
  } catch (e) {
    if (out) out.textContent = 'failed: ' + e.message;
    toast('image download failed: ' + e.message, false);
  }
}
async function stopDbTool(type, appId = currentApp, popupClosed = false) {
  if (!appId) return;
  const key = dbPopupKey(appId, type);
  const slot = dbPopupSlots.get(key);
  if (slot) {
    clearInterval(slot.timer);
    dbPopupSlots.delete(key);
    if (!popupClosed && !slot.popup.closed) slot.popup.close();
  }
  try {
    const r = await (await fetch(`/api/apps/${appId}/databases/${type}/tool`, { method: 'DELETE', keepalive: true })).json();
    toast(r.ok ? (popupClosed ? 'database UI stopped after its tab closed' : 'database UI stopped') : (r.error || 'failed'), !!r.ok);
    if (currentApp === appId) loadDatabases();
  } catch (e) { toast('database UI stop failed: ' + e.message, false); }
}
async function fillApiLink(a) {
  const card = document.getElementById('apiCard');
  let services = [];
  try {
    const svcR = await (await fetch(`/api/apps/${a.id}/services`)).json();
    services = svcR.services || [];
  } catch {}
  const fronts = services.filter(s => (s.type === 'static' || s.type === 'react') && s.enabled !== false);
  const isWeb = a.type === 'static' || a.type === 'react' || fronts.length > 0;
  card.style.display = isWeb ? 'block' : 'none';
  document.getElementById('allowBackend').value = a.allowBackend ? '1' : '0';
  if (!isWeb) return;
  const ab = a.apiBackend || {};
  const state = document.getElementById('apiState');
  if (ab.app) {
    const sibName = String(ab.app).replace(/^svc:/, '');
    const sibs = (JSON.parse(document.getElementById('apiTarget').dataset.sibs || '[]'));
    if (sibs.includes(sibName)) {
      state.textContent = `${ab.auto ? 'auto-linked' : 'linked'} → ${sibName} (same network, no public port)`;
    } else {
      state.innerHTML = `${ab.auto ? 'auto-linked' : 'linked'} → <a class="openlink" href="http://${location.hostname}:${ab.port}" target="_blank">${ab.app} (:${ab.port})</a>`;
    }
  } else state.textContent = 'not linked';
  const svcRow = document.getElementById('apiSvcRow');
  if (fronts.length > 1) {
    svcRow.style.display = 'block';
    const sel = document.getElementById('apiService');
    const prev = ab.service || fronts[0].name;
    sel.innerHTML = fronts.map(s => `<option value="${s.name}">${s.name} (${s.subdir || 'root'})</option>`).join('');
    if (fronts.some(s => s.name === prev)) sel.value = prev;
  } else svcRow.style.display = 'none';
  try {
    const apps = await (await fetch('/api/apps')).json();
    const sibs = services.filter(s => s.name !== 'app' && s.hostPort && (s.enabled !== false));
    const others = apps.filter(x => x.id !== a.id && x.hostPort && x.allowBackend);
    const sel = document.getElementById('apiTarget');
    const prev = ab.app || '';
    let html = '<option value="">— no link —</option>';
    if (sibs.length) html += `<optgroup label="this site">` + sibs.map(s => `<option value="svc:${s.name}">${s.name} (:${s.hostPort})</option>`).join('') + '</optgroup>';
    if (others.length) html += `<optgroup label="other sites">` + others.map(x => `<option value="${x.id}">${safeHtml(siteName(x))} (${x.id}, :${x.hostPort})</option>`).join('') + '</optgroup>';
    sel.innerHTML = html;
    const prevSib = prev.replace(/^svc:/, '');
    if (sibs.some(s => s.name === prevSib)) sel.value = 'svc:' + prevSib;
    else if (others.some(x => x.id === prev)) sel.value = prev;
    else sel.value = '';
    if (prev && !sibs.some(s => s.name === prevSib) && !others.some(x => x.id === prev)) {
      state.textContent += ' — legacy cross-site link (target has not opted in)';
    }
  } catch {}
}
async function saveApiLink() {
  if (!currentApp) return;
  const target = document.getElementById('apiTarget').value || null;
  const svcRow = document.getElementById('apiSvcRow');
  const service = (svcRow.style.display !== 'none' && document.getElementById('apiService').value) || undefined;
  toast((target ? 'linking to ' + target : 'unlinking') + '… (redeploy to apply)');
  try {
    const r = await (await fetch(`/api/apps/${currentApp}/api-backend`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ target, service }) })).json();
    toast(r.ok ? 'api link saved' : (r.error || 'failed'), !!r.ok);
    refresh();
  } catch (e) { toast('failed: ' + e.message, false); }
}
async function saveAllow() {
  if (!currentApp) return;
  const allow = document.getElementById('allowBackend').value === '1';
  const r = await (await fetch(`/api/apps/${currentApp}/allow-backend`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ allow }) })).json();
  toast(r.ok ? ('offer as backend ' + (allow ? 'on' : 'off')) : (r.error || 'failed'), !!r.ok);
}
async function fillGitConn(a) {
  const g = a.github || {};
  const state = document.getElementById('gitConnState');
  const source = g.repo ? `${g.repo}${g.branch ? '@' + g.branch : ''}` : '';
  if (g.hasToken) state.textContent = 'site token stored •••• (used first)' + (source ? ' → ' + source : '');
  else if (g.login) state.textContent = 'panel account: ' + g.login + (source ? ' → ' + source : '');
  else if (source) state.textContent = 'public GitHub repository: ' + source;
  else if (a.repoUrl && /^(git@|ssh:\/\/)/i.test(a.repoUrl)) state.textContent = 'ssh deploy key (see repo key in webhook section)';
  else state.textContent = 'not connected';
  try {
    const s = await (await fetch('/api/github/status')).json();
    const sel = document.getElementById('gitAccount');
    const prev = sel.value;
    sel.innerHTML = '<option value="">—</option>' + (s.logins || []).map(l => `<option value="${l}">${l}</option>`).join('');
    sel.value = [...sel.options].some(o => o.value === (prev || g.login)) ? (prev || g.login) : '';
  } catch {}
}
async function useAccount() {
  if (!currentApp) return;
  const login = document.getElementById('gitAccount').value;
  const r = await (await fetch(`/api/apps/${currentApp}/git-account`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ login }) })).json();
  toast(r.ok ? (login ? 'using account ' + login : 'account unlinked') : (r.error || 'failed'), !!r.ok);
  refresh();
}
async function saveSiteToken() {
  if (!currentApp) return;
  const input = document.getElementById('gitSiteToken');
  const r = await (await fetch(`/api/apps/${currentApp}/git-token`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: input.value }) })).json();
  if (r.ok) { input.value = ''; toast('site token saved'); refresh(); }
  else toast(r.error || 'failed', false);
}
async function clearSiteToken() {
  if (!currentApp) return;
  const r = await (await fetch(`/api/apps/${currentApp}/git-token`, { method: 'DELETE' })).json();
  toast(r.ok ? 'site token cleared' : (r.error || 'failed'), !!r.ok);
  refresh();
}
async function setPoll() {
  if (!currentApp) return;
  const minutes = parseInt(document.getElementById('pollSel').value, 10) || 0;
  const r = await (await fetch(`/api/apps/${currentApp}/poll`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ minutes }) })).json();
  toast(r.ok ? (minutes ? `polling every ${minutes}m` : 'polling off') : (r.error || 'failed'), !!r.ok);
  refresh();
}
async function showRepoKey() {
  if (!currentApp) return;
  const el = document.getElementById('repoKeyOut');
  const btn = document.getElementById('repoKeyToggle');
  if (el.dataset.open === '1') {
    el.dataset.open = '0';
    el.textContent = '';
    btn.textContent = 'show key';
    return;
  }
  el.textContent = 'loading…';
  btn.disabled = true;
  try {
    const r = await (await fetch(`/api/apps/${currentApp}/repokey`)).json();
    el.textContent = r.pubkey || r.error;
    if (r.pubkey) {
      el.dataset.open = '1';
      btn.textContent = 'hide key';
    }
  } catch (e) { el.textContent = 'failed: ' + e.message; }
  finally { btn.disabled = false; }
}
async function regenHook() {
  if (!currentApp) return;
  const ok = await uiConfirm({
    title: 'Regenerate webhook?',
    body: 'The old webhook URL stops working immediately. Update GitHub after.',
    confirmLabel: 'Regenerate'
  });
  if (!ok) return;
  const r = await (await fetch(`/api/apps/${currentApp}/regenerate`, { method: 'POST' })).json();
  if (r.token) { refresh(); toast('webhook regenerated - update GitHub'); }
  else toast(r.error || 'failed', false);
}
async function setGithubAutomation(enabled) {
  if (!currentApp) return;
  if (!enabled) {
    const ok = await uiConfirm({
      title: 'Disable GitHub automation?',
      body: 'Stops webhook and polling deployments. The repository stays linked and manual repo redeploys still pull from it.',
      confirmLabel: 'Disable', danger: true
    });
    if (!ok) return;
  }
  const r = await (await fetch(`/api/apps/${currentApp}/github/automation`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled })
  })).json();
  toast(r.ok
    ? (enabled ? 'github automation enabled' : 'github automation disabled - repository still linked')
    : (r.error || 'failed'), !!r.ok);
  await refresh();
  loadDeployStatus();
}
function showSiteTab(t, remember = true) {
  if (!SITE_TABS.has(t)) t = 'overview';
  document.querySelectorAll('.sitetab').forEach(s => s.style.display = 'none');
  document.getElementById('tab-' + t).style.display = 'block';
  document.querySelectorAll('.tabbtn').forEach(b => {
    const active = b.dataset.tab === t;
    b.classList.toggle('active', active);
    b.setAttribute('aria-selected', active ? 'true' : 'false');
  });
  if (!currentApp) return;
  if (remember) rememberSiteRoute(currentApp, t);
  if (t === 'overview') loadStorage();
  if (t === 'database') { loadDatabases(); loadMigrateSuggest(); }
  if (t === 'environment') loadEnv();
  if (t === 'files') listFiles('');
  if (t === 'logs') showLogs();
}
async function createApp() {
  const session = createModalSession;
  await createCleanupPromise.catch(() => {});
  if (session !== createModalSession) return;
  const v = id => document.getElementById(id).value.trim();
  const storageGB = v('createStorageGB');
  if (!/^(?:[1-9]\d*|0)(?:\.\d{1,3})?$/.test(storageGB) || Number(storageGB) < 0.1 || Number(storageGB) > 1000000) { toast('Enter a storage allowance from 0.1 to 1,000,000 GB (up to 3 decimal places).', false); return; }
  const typeEl = document.querySelector('input[name=apptype]:checked');
  const dbs = [...document.querySelectorAll('input[name=appdb]:checked')].map(e => e.value);
  const accessEl = document.querySelector('input[name=access]:checked');
  const access = accessEl ? accessEl.value : 'local';
  const body = {
    name: v('name'), type: typeEl ? typeEl.value : 'static', dbs, storageGB,
    repoUrl: v('repo'), domain: access === 'domain' ? v('domain') : '',
    subdir: v('subdir'), standardDockerfile: createStandardDockerfile,
    modernizeBuild: document.getElementById('createModernBuild').checked
  };
  if (createPendingId) body.pendingId = createPendingId;
  // site-owned connection: fresh token travels with this build only
  const ghSel = document.getElementById('ghrepo');
  if (ghSel.value) {
    body.ghRepo = { repo: ghSel.value };
    body.gitToken = document.getElementById('ghModalToken').value.trim();
  } else if (v('repo')) {
    const tok = document.getElementById('ghModalToken').value.trim();
    if (tok) body.gitToken = tok;
  }
  const br = v('branch');
  if (br) body.branch = br;
  const buildBtn = document.getElementById('createBuildBtn');
  const cancelBtn = document.getElementById('createCancelBtn');
  buildBtn.disabled = true;
  cancelBtn.disabled = true;
  document.getElementById('createDockerAction').style.display = 'none';
  let r;
  try {
    r = await (await fetch('/api/apps', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();
  } catch (e) { r = { error: e.message }; }
  if (session !== createModalSession) return;
  if (r.pendingId) createPendingId = r.pendingId;
  document.getElementById('out').textContent = JSON.stringify(r, null, 2);
  if (r.needsDockerfile) document.getElementById('createDockerAction').style.display = 'flex';
  if (r.needsModernization) {
    document.getElementById('createBuildProfile').style.display = 'block';
    document.getElementById('createModernBuildRow').style.display = 'flex';
    document.getElementById('createBuildNote').textContent = r.error;
  }
  buildBtn.disabled = false;
  cancelBtn.disabled = false;
  refresh();
  if (!r.error) {
    if (r.storageWarning) toast('Site created, but the storage allowance is NOT enforced on this host: ' + r.storageWarning, false);
    closeCreate(true);
  }
}
async function detectType() {
  const session = createModalSession;
  const request = ++createDetectRequest;
  const sel = document.getElementById('ghrepo');
  const state = document.getElementById('createDetectState');
  const dbNote = document.getElementById('dbDetectNote');
  dbNote.style.display = 'none';
  dbNote.textContent = '';
  document.getElementById('subdirHint').style.display = 'none';
  state.title = '';
  document.getElementById('createBuildProfile').style.display = 'none';
  document.getElementById('createModernBuildRow').style.display = 'none';
  document.getElementById('createModernBuild').checked = false;
  document.getElementById('createRepoSize').textContent = 'Repository size: choose a GitHub repository.';
  let repo = sel.value;
  // create flow prefers its own fresh token but never requires one: public
  // repos detect fine without it (shared unauthenticated quota, no account used)
  const token = document.getElementById('ghModalToken').value.trim();
  const branchInput = document.getElementById('branch');
  if (!repo) {
    const m = document.getElementById('repo').value.trim().match(/github\.com[:/]([^/]+)\/([^/]+?)(\.git)?\/?$/i);
    if (!m) {
      state.textContent = 'Auto-detect from GitHub, or select manually.';
      if (createDetectRepo) branchInput.value = '';
      branchInput.title = '';
      document.getElementById('createBranches').innerHTML = '';
      document.getElementById('branchDefault').textContent = '';
      createDetectRepo = '';
      return;
    }
    repo = m[1] + '/' + m[2];
  }
  if (createDetectRepo && createDetectRepo !== repo) branchInput.value = '';
  if (createDetectRepo !== repo) {
    document.getElementById('createBranches').innerHTML = '';
    document.getElementById('branchDefault').textContent = '';
  }
  createDetectRepo = repo;
  const branch = branchInput.value.trim();
  state.textContent = 'Detecting runtime and databases…';
  try {
    const r = await (await fetch('/api/github/detect', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ repo, branch, ...(token ? { token } : {}) }) })).json();
    if (session !== createModalSession || request !== createDetectRequest) return;
    if (branchInput.value.trim() !== branch) return;
    const size = r.repositorySize;
    document.getElementById('createRepoSize').textContent = size && Number.isFinite(size.bytes)
      ? `Repository source: ${size.complete ? 'approximately ' : 'at least '}${storageSize(size.bytes)} on this branch. Excludes Git history, LFS downloads, dependencies, build output and database growth.`
      : 'Repository size unavailable. Leave room for dependencies, uploads and database growth.';
    if (r.branch) {
      branchInput.value = r.branch;
      document.getElementById('branchDefault').textContent = r.branch === r.defaultBranch ? '(default)' : '';
      branchInput.title = `Default: ${r.defaultBranch || 'unknown'}. Choose a suggested branch or type a name.`;
      document.getElementById('createBranches').innerHTML = (r.branches || []).map(b => `<option value="${safeHtml(b)}">${b === r.defaultBranch ? 'default' : ''}</option>`).join('');
    }
    if (r.buildProfile && r.buildProfile.kind === 'jekyll') {
      document.getElementById('createBuildProfile').style.display = 'block';
      document.getElementById('createBuildNote').textContent = `Jekyll → ${r.buildProfile.output}. Ruby 3.3 + Node 24 build; nginx serves the result. ` + (r.buildProfile.warnings || []).join(' ');
      document.getElementById('createModernBuildRow').style.display = r.buildProfile.needsModernization ? 'flex' : 'none';
    }
    if (r.type) {
      const radio = document.querySelector(`input[name=apptype][value=${r.type}]`);
      if (radio) radio.checked = true;
      const dbs = r.dbs || [];
      document.querySelectorAll('input[name=appdb]').forEach(c => { c.checked = dbs.includes(c.value); });
      const types = { static: 'Static', react: 'React', node: 'Node.js', php: 'PHP' };
      state.textContent = `Detected ${types[r.type] || r.type}${dbs.length ? ' + ' + dbs.join(', ') : ''}${r.branch ? ' on ' + r.branch : ''}. Check the selections below.`;
      state.title = r.reason || '';
      if (r.dbNote) { dbNote.style.display = 'block'; dbNote.textContent = r.dbNote; }
    } else {
      state.textContent = r.error || (r.detected ? `No template for ${r.detected}.` : 'Detection unavailable. Select the runtime manually.');
      state.title = r.reason || '';
    }
    const hint = document.getElementById('subdirHint');
    const fb = (r.frontends || []).map(f => `<button onclick="setSubdir('${f}', 'react')">${f} (web)</button>`).join(' ');
    const bb = (r.backends || []).map(b => `<button onclick="setSubdir('${b}', 'node')">${b} (api)</button>`).join(' ');
    const sb = (r.staticFrontends || []).map(f => `<button onclick="setSubdir('${f}', 'static')">${f} (static)</button>`).join(' ');
    if (fb || bb || sb) {
      hint.style.display = 'block';
      hint.innerHTML = 'Choose a build folder: ' + fb + ' ' + sb + ' ' + bb;
    } else hint.style.display = 'none';
  } catch {
    if (session === createModalSession && request === createDetectRequest) state.textContent = 'Detection unavailable. Select the runtime manually.';
  }
}
function setSubdir(f, type) {
  createStandardDockerfile = false;
  document.getElementById('createModernBuild').checked = false;
  document.getElementById('createBuildProfile').style.display = 'none';
  document.getElementById('createModernBuildRow').style.display = 'none';
  document.getElementById('createDockerAction').style.display = 'none';
  document.getElementById('subdir').value = f;
  if (type) {
    const radio = document.querySelector(`input[name=apptype][value=${type}]`);
    if (radio) radio.checked = true;
  }
  toast('building subfolder ' + f + (type ? ' as ' + type : ''));
}
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
}
function panelErrorText(e) {
  return `${String(e.at || '').replace('T', ' ').slice(0, 19)} [${e.level || 'error'}] ${e.area || 'panel'}${e.site ? ' (' + e.site + ')' : ''}: ${e.message || ''}`;
}
async function loadPanelErrors() {
  const box = document.getElementById('panelErrors');
  if (!box) return;
  box.textContent = 'loading…';
  try {
    const r = await (await fetch('/api/panel/errors?limit=100')).json();
    const list = Array.isArray(r) ? r : [];
    box.textContent = list.length ? list.map(panelErrorText).join('\n\n') : 'No recorded errors. Deployment failures, site creation and Trash cleanup problems are saved here with timestamps.';
  } catch { box.textContent = 'Could not load the error log.'; }
}
async function copyPanelErrors() {
  const text = document.getElementById('panelErrors').textContent;
  if (!text.trim() || text === 'loading…' || text.startsWith('No recorded errors') || text.startsWith('Could not load')) {
    toast('load the error log before copying', false);
    return;
  }
  const ok = await copyText(text);
  toast(ok ? 'errors copied' : 'copy failed - select and copy manually', ok);
}
function accessChanged() {
  const accessEl = document.querySelector('input[name=access]:checked');
  const isDomain = accessEl && accessEl.value === 'domain';
  document.getElementById('domain').style.display = isDomain ? 'block' : 'none';
  document.getElementById('createAccessNote').textContent = isDomain ? 'Configure DNS and a reverse proxy or tunnel.' : 'Use the assigned port on this host.';
  // OAuth redirect only exists on the public path - hide it on localhost
  const ob = document.getElementById('oauthBtnRow');
  if (ob) ob.style.display = isDomain ? 'block' : 'none';
}
function openCreate() {
  resetCreateForm();
  document.getElementById('modal').classList.add('open');
  document.getElementById('modal').querySelector('.create-body').scrollTop = 0;
  document.getElementById('name').focus();
  loadCreateStorage();
}
function setCreateStorage(value) {
  document.getElementById('createStorageGB').value = String(value);
  updateCreateStorageHint();
}
function updateCreateStorageHint() {
  const value = Number(document.getElementById('createStorageGB').value);
  const hint = document.getElementById('createStorageHint');
  hint.textContent = createStorageAvailable !== null && value * 1e9 > createStorageAvailable
    ? 'This allowance exceeds unallocated capacity. Choose a smaller size or expand the host disk.' : '';
}
async function loadCreateStorage() {
  const session = createModalSession;
  const state = document.getElementById('createStorageState');
  try {
    const r = await (await fetch('/api/panel/storage')).json();
    if (session !== createModalSession) return;
    createStorageAvailable = r.ready && Number.isFinite(r.availableBytes) ? r.availableBytes : null;
    state.textContent = r.ready ? `${storageSize(r.availableBytes)} available for new allowances, after existing allocations, Trash and host headroom.` : ((r.error || 'Host quota setup is not ready.') + ' The allowance will be recorded but NOT enforced until quota setup completes.');
    updateCreateStorageHint();
  } catch {
    if (session === createModalSession) state.textContent = 'Host quota setup unavailable. The allowance will be recorded but NOT enforced until the Linux installer completes quota setup.';
  }
}
function resetCreateForm() {
  createModalSession++;
  createConnectRequest++;
  createDetectRequest++;
  createStandardDockerfile = false;
  createPendingId = null;
  createStorageAvailable = null;
  document.getElementById('createStorageGB').value = '5';
  document.getElementById('createStorageState').textContent = 'Checking host quota setup…';
  document.getElementById('createStorageHint').textContent = '';
  document.getElementById('createRepoSize').textContent = 'Repository size: choose a GitHub repository.';
  document.getElementById('name').value = '';
  document.getElementById('repo').value = '';
  document.getElementById('domain').value = '';
  document.getElementById('out').textContent = '';
  document.querySelector('input[name=access][value=local]').checked = true;
  // never inherit the previous app: reset type, dbs, token and repo picker every open.
  // Every build connects fresh - the pool is never consulted here.
  document.querySelector('input[name=apptype][value=static]').checked = true;
  document.querySelectorAll('input[name=appdb]').forEach(c => { c.checked = false; });
  document.getElementById('ghModalToken').value = '';
  document.getElementById('branch').value = '';
  document.getElementById('branch').title = '';
  document.getElementById('branchDefault').textContent = '';
  document.getElementById('createBranches').innerHTML = '';
  createDetectRepo = '';
  document.getElementById('createModernBuild').checked = false;
  document.getElementById('createBuildProfile').style.display = 'none';
  document.getElementById('createModernBuildRow').style.display = 'none';
  document.getElementById('createBuildNote').textContent = '';
  document.getElementById('subdir').value = '';
  document.getElementById('subdirHint').style.display = 'none';
  document.getElementById('subdirHint').innerHTML = '';
  document.getElementById('ghrepo').innerHTML = '<option value="">GitHub repo…</option>';
  const dbNote = document.getElementById('dbDetectNote');
  if (dbNote) { dbNote.style.display = 'none'; dbNote.textContent = ''; }
  document.getElementById('ghRepoRow').style.display = 'none';
  document.getElementById('ghConnectRow').style.display = 'block';
  document.getElementById('createGitDetails').open = false;
  document.getElementById('createDetectState').textContent = 'Auto-detect from GitHub, or select manually.';
  document.getElementById('createDetectState').title = '';
  document.getElementById('ghConnState').textContent = 'Paste a site-only token.';
  document.getElementById('ghStoreNote').textContent = 'Saved to this site only.';
  document.getElementById('ghModalConnect').disabled = false;
  document.getElementById('ghModalConnect').textContent = 'List repos';
  document.getElementById('createBuildBtn').disabled = false;
  document.getElementById('createCancelBtn').disabled = false;
  document.getElementById('createDockerAction').style.display = 'none';
  modalLogin = null;
  accessChanged();
}
function useCreateStandardDockerfile() {
  createStandardDockerfile = true;
  document.getElementById('createDockerAction').style.display = 'none';
  createApp();
}
function closeCreate(created = false) {
  const id = createPendingId;
  document.getElementById('modal').classList.remove('open');
  resetCreateForm();
  if (!created && id) {
    createCleanupPromise = fetch(`/api/apps/pending/${encodeURIComponent(id)}`, { method: 'DELETE', keepalive: true })
      .then(async response => { const result = await response.json(); if (!result.ok) toast('Unfinished site cleanup failed: ' + (result.error || 'retry cleanup for ' + id), false); })
      .catch(e => toast('Unfinished site cleanup failed: ' + e.message, false));
  }
}
function toggleTheme() {
  const t = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
  document.documentElement.dataset.theme = t;
  try { localStorage.setItem('mp-theme', t); } catch {}
}
try { document.documentElement.dataset.theme = localStorage.getItem('mp-theme') || 'dark'; } catch {}
async function deploy(id) {
  const siteView = document.getElementById('view-site');
  if (id === currentApp && siteView && siteView.classList.contains('active')) return runDeploy(id, null);
  setAppCardState(id, 'deploying', false);
  toast('redeploying ' + id + '…');
  try {
    const r = await (await fetch('/api/apps/' + id + '/deploy', { method: 'POST' })).json();
    toast(r.ok ? id + ' redeployed' : ('redeploy failed: ' + (r.error || 'unknown')), !!r.ok);
  } catch (e) { toast('redeploy failed: ' + e.message, false); }
  await refresh();
}
// Deploy with live notice: elapsed timer, progress bar to 100%, stage + log tail,
// success/fail at the end. Polls /status (deploying flag) + build log; the bar
// eases toward 95% on elapsed time and snaps to 100% when the server finishes.
async function runDeploy(id, services, local = false) {
  const prog = document.getElementById('deployProg');
  const bar = document.getElementById('deployBar');
  const pct = document.getElementById('deployPct');
  const time = document.getElementById('deployTime');
  const stage = document.getElementById('deployStage');
  const tail = document.getElementById('deployTail');
  const t0 = Date.now();
  let done = false;
  let outcome = null;
  manualDeployActive = id;
  if (id === currentApp) setPowerState('sitePower', 'deploying', 'Deploying');
  prog.style.display = 'block';
  bar.style.width = '2%'; bar.style.background = '#4caf50';
  const tick = setInterval(() => {
    const s = Math.floor((Date.now() - t0) / 1000);
    time.textContent = s + 's';
    if (!done) {
      const p = Math.min(95, 2 + (Date.now() - t0) / 90000 * 93);
      bar.style.width = p.toFixed(0) + '%';
      pct.textContent = p.toFixed(0) + '%';
    }
  }, 1000);
  const poll = setInterval(async () => {
    try {
      const st = await (await fetch(`/api/apps/${id}/status`)).json();
      if (st.deploying === false && done) { clearInterval(poll); return; }
      const log = await (await fetch(`/api/apps/${id}/build-log?tail=8`)).text();
      const last = log.split('\n').filter(l => l.trim()).slice(-1)[0] || '';
      stage.textContent = st.deploying === false ? stage.textContent : 'deploying…';
      tail.textContent = last.slice(-160);
    } catch {}
  }, 2500);
  stage.textContent = services && services.length ? ('redeploying ' + services.join(',') + '… (others untouched)') : (local ? ('rebuilding ' + id + ' from local files… (no repo pull)') : ('redeploying ' + id + '…'));
  try {
    const r = await (await fetch(`/api/apps/${id}/deploy`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(services && services.length ? { services, source: local ? 'local' : 'manual' } : { source: local ? 'local' : 'manual' }) })).json();
    outcome = r;
  } catch (e) { outcome = { ok: false, error: e.message }; }
  done = true;
  clearInterval(tick); clearInterval(poll);
  bar.style.width = '100%'; pct.textContent = '100%';
  time.textContent = Math.floor((Date.now() - t0) / 1000) + 's';
  if (outcome && outcome.ok) {
    bar.style.background = '#4caf50';
    stage.textContent = 'done — live';
    toast(id + ' redeployed', true);
  } else {
    bar.style.background = 'var(--danger)';
    stage.textContent = 'failed';
    tail.textContent = (outcome && (outcome.error || '')) || 'failed';
    toast('redeploy failed: ' + ((outcome && outcome.error) || 'unknown'), false);
  }
  manualDeployActive = null;
  await refreshSiteData(id);
  setTimeout(() => { prog.style.display = 'none'; }, 15000);
}
function toast(msg, ok = true) {
  const box = document.getElementById('toasts');
  const d = document.createElement('div');
  d.className = 'toast' + (ok ? '' : ' err');
  d.textContent = msg;
  box.appendChild(d);
  setTimeout(() => d.remove(), 6000);
}
// In-app confirm modal (no browser dialogs). requireText forces typing to confirm.
function uiConfirm({ title, body, requireText, confirmLabel, danger }) {
  return new Promise(resolve => {
    const m = document.getElementById('confirmModal');
    document.getElementById('cmTitle').textContent = title || 'confirm';
    document.getElementById('cmBody').textContent = body || '';
    const label = document.getElementById('cmLabel');
    const input = document.getElementById('cmInput');
    const okBtn = document.getElementById('cmOk');
    document.getElementById('cmNeed').textContent = requireText || '';
    label.style.display = requireText ? 'block' : 'none';
    input.value = '';
    okBtn.textContent = confirmLabel || 'confirm';
    okBtn.classList.toggle('danger', !!danger);
    const done = val => {
      document.getElementById('cmOk').onclick = null;
      document.getElementById('cmCancel').onclick = null;
      m.classList.remove('open');
      resolve(val);
    };
    okBtn.onclick = () => {
      if (requireText && input.value.trim() !== requireText) {
        input.focus();
        input.style.borderColor = 'var(--danger)';
        return;
      }
      done(true);
    };
    document.getElementById('cmCancel').onclick = () => done(false);
    m.classList.add('open');
    (requireText ? input : okBtn).focus();
  });
}
async function stopApp(id) {
  if (id === currentApp) setPowerState('sitePower', 'checking', 'Stopping');
  setAppCardState(id, 'checking', true);
  toast('stopping ' + id + '…');
  try {
    const r = await (await fetch('/api/apps/' + id + '/stop', { method: 'POST' })).json();
    toast(r.ok ? id + ' stopped' : ('stop failed: ' + (r.error || 'unknown')), !!r.ok);
  } catch (e) { toast('stop failed: ' + e.message, false); }
  await refresh();
  if (id === currentApp) await loadDeployStatus();
}
async function startApp(id) {
  if (id === currentApp) setPowerState('sitePower', 'checking', 'Starting');
  setAppCardState(id, 'checking', false);
  toast('starting ' + id + '…');
  try {
    const r = await (await fetch('/api/apps/' + id + '/start', { method: 'POST' })).json();
    toast(r.ok ? id + ' started' : ('start failed: ' + (r.error || 'unknown')), !!r.ok);
  } catch (e) { toast('start failed: ' + e.message, false); }
  await refresh();
  if (id === currentApp) await loadDeployStatus();
}
async function toggleSitePower() {
  if (!currentApp) return;
  const state = document.getElementById('sitePower').dataset.state;
  if (state === 'deployed') await stopApp(currentApp);
  else if (state === 'off' || state === 'failed') await startApp(currentApp);
}
async function rmApp(id) {
  const name = siteName(siteById(id));
  const ok = await uiConfirm({
    title: 'Delete ' + name + '?',
    body: `Site ID: ${id}. Containers stop and the site moves to Trash for 48 hours (files and data kept). The name can be reused immediately by a different site. Destroy or expiry removes only this site’s files, database volumes and built images, and clears all unused Docker build cache. Shared images stay.`,
    requireText: name, confirmLabel: 'Move to trash', danger: true
  });
  if (!ok) return;
  // optimistic: gone from screen instantly, restored on failure
  const card = document.getElementById('card-' + id);
  if (card) card.remove();
  toast('moving ' + id + ' to trash…');
  try {
    const r = await (await fetch('/api/apps/' + id, { method: 'DELETE' })).json();
    if (!r.ok) throw new Error(r.error || 'site could not be stopped and moved to Trash');
    toast(r.trashed ? (id + ' in trash — restorable for 48h') : (id + ' deleted'), true);
    if (id === currentApp) backToSites(); else refresh();
    loadTrash();
  } catch (e) { toast('delete failed: ' + e.message, false); refresh(); }
}
function trashLeft(ms) {
  if (ms == null) return 'time unknown';
  const h = Math.floor(ms / 3600000), m = Math.ceil((ms % 3600000) / 60000);
  return h > 0 ? `${h}h ${m}m left` : `${m}m left`;
}
async function loadTrash() {
  const box = document.getElementById('trashList');
  const count = document.getElementById('trashCount');
  try {
    const list = await (await fetch('/api/trash')).json();
    trashApps = list;
    if (count) { count.style.display = list.length ? '' : 'none'; count.textContent = list.length; }
    if (!box) return;
    box.innerHTML = list.length ? list.map(t => {
      const when = (t.deletedAt ? new Date(t.deletedAt).toISOString().replace('T', ' ').slice(0, 19) : '?');
      return `<div class="card appcard"><div class="appcard-layout"><div class="appcard-main">` +
        `<div class="appcard-title"><div><h3>${safeHtml(siteName(t))}</h3><div class="meta">ID: ${safeHtml(t.id)}</div><div class="badges"><span class="badge type">${safeHtml(t.type || '?')}</span><span class="badge">db: ${safeHtml(dbLabel(t))}</span><span class="badge">${safeHtml(trashLeft(t.msLeft))}</span></div></div></div>` +
        `<div class="meta">deleted ${safeHtml(when)} · cleanup due ${safeHtml((t.restoreBy || '?').replace('T', ' ').slice(0, 19))}</div>${t.cleanupError ? `<div class="meta trash-cleanup-error">Cleanup incomplete: ${safeHtml(t.cleanupError)}</div>` : ''}</div>` +
        `<div class="appcard-actions"><button class="btn primary" onclick="restoreTrash('${safeHtml(t.id)}')" ${t.cleanupStartedAt || t.msLeft === 0 ? 'disabled' : ''}>restore</button><button class="btn danger" onclick="destroyTrash('${safeHtml(t.id)}')">${t.cleanupStartedAt || t.cleanupError ? 'retry cleanup' : 'delete forever'}</button></div>` +
        `</div></div>`;
    }).join('') : '<div class="card">Trash is empty.</div>';
  } catch { if (box) box.innerHTML = '<div class="card">trash unreachable</div>'; }
}
async function restoreTrash(id) {
  toast('restoring ' + id + '… (ports re-checked first)');
  try {
    const r = await (await fetch(`/api/trash/${id}/restore`, { method: 'POST' })).json();
    if (!r.ok) { toast(r.error || 'restore failed', false); return; }
    const moved = (r.movedPorts || []).map(m => `${m.service ? m.service + ':' : ''}${m.from}→${m.to}`).join(', ');
    toast(id + ' restored' + (moved ? ` — port taken, moved ${moved}` : '') + (r.restarted ? '' : ' (restart it from Websites)'), true);
    refresh(); loadTrash();
  } catch (e) { toast('restore failed: ' + e.message, false); }
}
async function emptyTrash() {
  let count = 0;
  try { count = (await (await fetch('/api/trash')).json()).length; } catch {}
  if (!count) { toast('trash is already empty'); return; }
  const ok = await uiConfirm({
    title: `Empty trash (${count} site${count === 1 ? '' : 's'})?`,
    body: 'Permanently remove every trashed site’s files, database volumes and built images. Also clear all unused Docker build cache; other builds may take longer afterward. Shared images needed elsewhere are kept. This cannot be undone.',
    requireText: 'empty', confirmLabel: 'Empty trash', danger: true
  });
  if (!ok) return;
  try {
    const r = await (await fetch('/api/trash', { method: 'DELETE' })).json();
    toast(r.ok ? `trash emptied (${(r.destroyed || []).length} destroyed)` : `${(r.destroyed || []).length} destroyed; ${r.error || 'cleanup failed'}`, !!r.ok);
    loadTrash(); refresh();
  } catch (e) { toast('empty failed: ' + e.message, false); }
}
async function destroyTrash(id) {
  const name = siteName(siteById(id));
  const ok = await uiConfirm({
    title: 'Destroy ' + name + ' forever?',
    body: `Site ID: ${id}. Remove only this site’s containers, database volumes, files and built images, not another site with the same name. Also clear all unused Docker build cache; other builds may take longer afterward. Shared images needed elsewhere are kept. This cannot be undone.`,
    requireText: name, confirmLabel: 'Destroy forever', danger: true
  });
  if (!ok) return;
  try {
    const r = await (await fetch('/api/trash/' + id, { method: 'DELETE' })).json();
    toast(r.ok ? (id + ' destroyed') : (r.error || 'failed'), !!r.ok);
    loadTrash(); refresh();
  } catch (e) { toast('destroy failed: ' + e.message, false); }
}
async function showLogs() {
  if (!currentApp) { logsEl.textContent = 'open a website first'; return; }
  const svc = document.getElementById('logSvc').value || 'app';
  logsEl.textContent = 'loading…';
  logsEl.textContent = await (await fetch(`/api/apps/${currentApp}/logs?service=${encodeURIComponent(svc)}`)).text();
}
async function showBuildLog(full) {
  if (!currentApp) { logsEl.textContent = 'open a website first'; return; }
  logsEl.textContent = 'loading…';
  logsEl.textContent = await (await fetch(`/api/apps/${currentApp}/build-log${full ? '?tail=500' : ''}`)).text();
}
async function copyLogs() {
  const text = document.getElementById('logs').textContent;
  if (!text.trim() || text === 'loading…' || text === 'open a website first') {
    toast('load logs before copying', false);
    return;
  }
  const ok = await copyText(text);
  toast(ok ? 'logs copied' : 'copy failed - select and copy manually', ok);
}
async function version() {
  try {
    const v = await (await fetch('/api/panel/version')).json();
    renderPanelVersion(v);
    // landed mid-restart (manual refresh) -> resume watching instead of sitting stale
    if (v.restarting && !restartTimer) watchRestart(300000);
  } catch {
    const status = document.getElementById('ver');
    status.className = 'panel-state is-failed';
    status.textContent = 'unreachable';
    document.getElementById('upgradeState').textContent = 'Could not read panel version information.';
  }
}
function renderPanelVersion(v, secondsLeft = null) {
  document.getElementById('verRunning').textContent = v.running || 'unknown';
  document.getElementById('verRepo').textContent = v.repo || 'unknown';
  const status = document.getElementById('ver');
  const state = document.getElementById('upgradeState');
  const countdown = document.getElementById('upgradeCountdown');
  const button = document.getElementById('upgradeBtn');
  if (!v.upgradeable) {
    status.className = 'panel-state is-failed';
    status.textContent = 'upgrade unavailable';
    state.textContent = 'Repository is not mounted. Add the /repo volume before using self-upgrade.';
  } else if (v.restarting) {
    status.className = 'panel-state is-busy';
    status.textContent = 'restart pending';
    state.textContent = 'The current panel remains online while the host applies the newly built image.';
  } else if (v.running === 'dev') {
    status.className = 'panel-state is-checking';
    status.textContent = 'development';
    state.textContent = 'Development build is running. You can still sync and rebuild from Git.';
  } else {
    status.className = 'panel-state is-ok';
    status.textContent = 'up to date';
    state.textContent = 'The running image matches the checked-out repository version.';
  }
  button.disabled = !v.upgradeable || !!v.restarting;
  countdown.textContent = secondsLeft == null ? '' : `${secondsLeft}s left`;
}
async function upgrade() {
  document.getElementById('upgradeBtn').disabled = true;
  document.getElementById('upgradeState').textContent = 'Fetching origin/main and starting a background image build…';
  document.getElementById('upOut').textContent = 'Waiting for build output…';
  try {
    const r = await (await fetch('/api/panel/upgrade', { method: 'POST' })).json();
    if (r.error) {
      document.getElementById('upgradeState').textContent = r.error;
      document.getElementById('upOut').textContent = 'Upgrade did not start.';
      document.getElementById('upgradeBtn').disabled = false;
      return;
    }
    document.getElementById('upgradeState').textContent = `Building target ${r.target || 'from origin/main'}; the running panel stays online.`;
    if (r.restarting || r.building) watchRestart(300000);
  } catch (e) {
    document.getElementById('upgradeState').textContent = 'Upgrade failed to start.';
    document.getElementById('upOut').textContent = e.message;
    document.getElementById('upgradeBtn').disabled = false;
  }
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
      renderPanelVersion(v, left);
      if (!v.restarting) { clearInterval(restartTimer); restartTimer = null; location.reload(); return; }
      let log = '';
      try { log = await (await fetch('/api/panel/upgrade-log')).text(); } catch {}
      out.textContent = log || 'Waiting for build output…';
      out.scrollTop = out.scrollHeight;
      if (/BUILD FAILED/i.test(log)) {
        const status = document.getElementById('ver');
        status.className = 'panel-state is-failed';
        status.textContent = 'build failed';
        document.getElementById('upgradeState').textContent = 'Image build failed. The currently running panel was left untouched.';
      } else if (/build ok - restart flagged/i.test(log)) {
        document.getElementById('upgradeState').textContent = 'Build complete. Waiting for the host restart job to activate the new image.';
      }
    } catch (e) {
      const status = document.getElementById('ver');
      status.className = 'panel-state is-busy';
      status.textContent = 'reconnecting';
      document.getElementById('upgradeState').textContent = 'Panel is restarting. Reconnecting automatically…';
      document.getElementById('upgradeCountdown').textContent = `${left}s left`;
    }
    if (left <= 0) {
      clearInterval(restartTimer); restartTimer = null;
      document.getElementById('upgradeCountdown').textContent = 'timed out';
      document.getElementById('upgradeState').textContent = 'Automatic reconnect timed out. Refresh the page manually.';
    }
  }, 3000);
}
async function scan() {
  const out = document.getElementById('maintOut');
  out.textContent = 'Scanning /srv/apps…';
  const r = await (await fetch('/api/panel/scan', { method: 'POST' })).json();
  out.textContent = r.error ? r.error : `${r.found && r.found.length ? r.found.join('\n') : 'No orphaned sites found.'}\n${r.total != null ? `Total sites: ${r.total}` : ''}`.trim();
  refresh();
}
async function showKey() {
  document.getElementById('keyOut').textContent = 'Loading panel key…';
  const r = await (await fetch('/api/panel/pubkey')).json();
  document.getElementById('keyOut').textContent =
    (r.pubkey || r.error) + '\n\nOnly needed for SSH remotes (git@github.com:…) — skip this if your sites pull over HTTPS + token.';
}
let fileTreeApp = null;
let fileTreeNodes = new Map();
let selectedFile = '';
let lastOpen = null;
function joinFilePath(dir, name) { return dir ? `${dir}/${name}` : name; }
async function loadFileDir(dir, force) {
  if (!currentApp) return;
  const appId = currentApp;
  let node = fileTreeNodes.get(dir);
  if (!node) { node = { open: dir === '', items: null, loading: false, error: '' }; fileTreeNodes.set(dir, node); }
  if (!force && node.items) return;
  node.loading = true;
  node.error = '';
  renderFileTree();
  try {
    const files = await (await fetch(`/api/apps/${appId}/files?path=${encodeURIComponent(dir)}`)).json();
    if (appId !== currentApp || fileTreeApp !== appId) return;
    if (files.error) { node.error = files.error; node.items = []; }
    else node.items = files;
  } catch (e) {
    if (appId === currentApp && fileTreeApp === appId) { node.error = e.message; node.items = []; }
  }
  node.loading = false;
  renderFileTree();
}
function renderFileTreeDir(dir, depth) {
  const node = fileTreeNodes.get(dir);
  if (!node) return '';
  if (node.loading && !node.items) return `<div class="file-tree-note" style="padding-left:${10 + depth * 16}px">loading…</div>`;
  if (node.error) return `<div class="file-tree-note error" style="padding-left:${10 + depth * 16}px">${safeHtml(node.error)}</div>`;
  if (!node.items || !node.items.length) return `<div class="file-tree-note" style="padding-left:${10 + depth * 16}px">(empty)</div>`;
  return node.items.map(item => {
    const full = joinFilePath(dir, item.name);
    const encoded = safeHtml(full);
    if (item.dir) {
      const child = fileTreeNodes.get(full);
      const open = !!(child && child.open);
      return `<div class="file-tree-branch"><button class="file-tree-row folder" style="padding-left:${8 + depth * 16}px" data-path="${encoded}" onclick="toggleFileDir(this.dataset.path)" aria-expanded="${open}">` +
        `<span class="tree-chevron">${open ? '▾' : '▸'}</span><span class="tree-icon">▰</span><span>${safeHtml(item.name)}</span></button>` +
        (open ? `<div>${renderFileTreeDir(full, depth + 1)}</div>` : '') + `</div>`;
    }
    return `<button class="file-tree-row file${selectedFile === full ? ' active' : ''}" style="padding-left:${8 + depth * 16}px" data-path="${encoded}" onclick="openFile(this.dataset.path)">` +
      `<span class="tree-chevron"></span><span class="tree-icon">▪</span><span>${safeHtml(item.name)}</span></button>`;
  }).join('');
}
function renderFileTree() {
  const box = document.getElementById('fileList');
  if (box) box.innerHTML = renderFileTreeDir('', 0) || '<div class="file-tree-note">(empty)</div>';
}
async function listFiles(dir = '') {
  if (!currentApp) return;
  if (fileTreeApp !== currentApp) {
    fileTreeApp = currentApp;
    fileTreeNodes = new Map([['', { open: true, items: null, loading: false, error: '' }]]);
    selectedFile = '';
    lastOpen = null;
    document.getElementById('filePath').value = '';
    document.getElementById('fileEdit').value = '';
  }
  const path = dir || '';
  let node = fileTreeNodes.get(path);
  if (!node) { node = { open: true, items: null, loading: false, error: '' }; fileTreeNodes.set(path, node); }
  node.open = true;
  await loadFileDir(path, path === '');
}
async function toggleFileDir(dir) {
  let node = fileTreeNodes.get(dir);
  if (!node) { node = { open: false, items: null, loading: false, error: '' }; fileTreeNodes.set(dir, node); }
  node.open = !node.open;
  renderFileTree();
  if (node.open && !node.items) await loadFileDir(dir, false);
}
async function refreshFileTree() {
  if (!currentApp) return;
  if (fileTreeApp !== currentApp) return listFiles('');
  const loaded = [...fileTreeNodes.entries()].filter(([, node]) => node.items).map(([dir]) => dir);
  if (!loaded.includes('')) loaded.unshift('');
  await Promise.all(loaded.map(dir => loadFileDir(dir, true)));
}
async function openFile(p) {
  const id = currentApp;
  const fp = p || document.getElementById('filePath').value.trim() || 'index.html';
  if (!id) { document.getElementById('fileEdit').value = 'no app selected'; return; }
  selectedFile = fp;
  lastOpen = { path: fp, ok: false };
  document.getElementById('filePath').value = fp;
  document.getElementById('fileOut').textContent = 'opening ' + fp + '…';
  renderFileTree();
  try {
    const r = await (await fetch(`/api/apps/${id}/file?path=${encodeURIComponent(fp)}`)).json();
    if (r.error) { document.getElementById('fileEdit').value = ''; document.getElementById('fileOut').textContent = r.error; return; }
    document.getElementById('fileEdit').value = r.content || '';
    document.getElementById('fileOut').textContent = `opened ${fp}`;
    lastOpen = { path: fp, ok: true };
  } catch (e) { document.getElementById('fileEdit').value = 'open failed: ' + e.message; }
}
async function saveFile() {
  const id = currentApp;
  const filePath = document.getElementById('filePath').value.trim();
  if (!id || !filePath) { toast('enter a file path first', false); return; }
  // Never save over a file that failed to open (too large, binary, missing):
  // the editor is empty and saving would wipe the real content.
  if (lastOpen && lastOpen.path === filePath && !lastOpen.ok) {
    toast('that file did not open - refusing to save over it', false);
    return;
  }
  const body = { path: filePath, content: document.getElementById('fileEdit').value };
  document.getElementById('fileOut').textContent = 'saving… (redeploy to apply)';
  try {
    const r = await (await fetch(`/api/apps/${id}/file`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();
    document.getElementById('fileOut').textContent = JSON.stringify(r, null, 2);
    selectedFile = filePath;
    await refreshFileTree(); refresh(); loadServices();
  } catch (e) { document.getElementById('fileOut').textContent = 'save failed: ' + e.message; }
}
async function deleteFile() {
  const id = currentApp;
  const fp = document.getElementById('filePath').value;
  if (!id || !fp) return;
  const ok = await uiConfirm({
    title: 'Delete ' + fp + '?', body: 'From ' + id + '. This cannot be undone.',
    confirmLabel: 'Delete', danger: true
  });
  if (!ok) return;
  document.getElementById('fileOut').textContent = 'deleting… (redeploy to apply)';
  try {
    const r = await (await fetch(`/api/apps/${id}/file?path=${encodeURIComponent(fp)}`, { method: 'DELETE' })).json();
    document.getElementById('fileOut').textContent = JSON.stringify(r, null, 2);
    document.getElementById('filePath').value = ''; document.getElementById('fileEdit').value = '';
    selectedFile = '';
    lastOpen = null;
    await refreshFileTree(); refresh(); loadServices();
  } catch (e) { document.getElementById('fileOut').textContent = 'delete failed: ' + e.message; }
}
function upModeChange() {
  const mode = document.getElementById('upMode').value;
  const pick = document.getElementById('upPick');
  pick.value = '';
  pick.removeAttribute('multiple');
  pick.removeAttribute('webkitdirectory');
  pick.removeAttribute('accept');
  if (mode === 'zip') pick.setAttribute('accept', '.zip');
  if (mode === 'files') pick.setAttribute('multiple', '');
  if (mode === 'folder') pick.setAttribute('webkitdirectory', '');
}
async function uploadUnified() {
  const id = currentApp;
  const mode = document.getElementById('upMode').value;
  const input = document.getElementById('upPick');
  const files = [...input.files];
  const out = document.getElementById('fileOut');
  if (!id || !files.length) { out.textContent = 'open a website and pick something to upload'; return; }
  out.textContent = `uploading ${mode} (${files.length} file(s))… (redeploy after)`;
  try {
    let url, fd = new FormData();
    if (mode === 'zip') {
      url = `/api/apps/${id}/upload`;
      fd.append('zip', files[0]);
    } else {
      url = `/api/apps/${id}/upload-files`;
      for (const f of files) {
        const rel = mode === 'folder' ? (f.webkitRelativePath.split('/').slice(1).join('/') || f.name) : f.name;
        fd.append('files', f);
        fd.append('paths', rel);
      }
    }
    const r = await (await fetch(url, { method: 'POST', body: fd })).json();
    out.textContent = JSON.stringify(r, null, 2); refreshFileTree(); refresh(); loadServices();
  } catch (e) { out.textContent = 'upload failed: ' + e.message; }
  input.value = '';
}
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
async function loadServices() {
  if (!currentApp) return;
  try {
    const r = await (await fetch(`/api/apps/${currentApp}/services`)).json();
    const list = r.services || [];
    const dirty = !!r.dirty;
    document.getElementById('svcList').innerHTML = list.map(s => {
      const openPath = s.homePath || '';
      const url = s.hostPort ? `http://${location.hostname}:${s.hostPort}${openPath}` : null;
      const label = s.hostPort ? `${location.hostname}:${s.hostPort}${openPath}` : '';
      const enabled = s.enabled !== false;
      const profile = (r.buildProfiles || {})[s.name];
      const buildCard = profile && profile.kind === 'jekyll'
        ? `<div class="service-build-profile"><b>Jekyll static build</b><div class="meta">${profile.customDockerfile ? 'Custom Dockerfile preserved. Configure its build steps in that file.' : `Ruby + Node → ${safeHtml(profile.output)} → nginx${profile.modernize ? ' · build-only modernization enabled' : ''}`}</div>${profile.customDockerfile ? '' : `<div class="meta">${safeHtml((profile.warnings || []).filter(w => !profile.modernize || !w.includes('Enable the build-only')).join(' '))}</div><button onclick="configureStaticBuild('${s.name}', ${!!profile.needsModernization})">${s.type !== 'static' ? 'Use Jekyll static build' : profile.needsModernization && !profile.modernize ? 'Enable build modernization' : 'Configure build'}</button>`}</div>` : '';
      return `<div class="service-card" id="svc-${s.name}"><div class="service-card-head"><div><b>${safeHtml(s.name)}</b><span class="badge type">${safeHtml(s.type)}</span>` +
        `<div class="meta">${s.subdir ? `/${safeHtml(s.subdir)}` : 'repository root'}</div></div><span class="badge service-state ${enabled ? 'on' : 'off'}">${enabled ? 'enabled' : 'disabled'}</span></div>` +
        `<div class="service-facts"><div><span>Published port</span><b>${s.hostPort ? `:${s.hostPort} → ${s.port}` : 'not published'}</b></div>` +
        `<div><span>Local URL</span>${url ? `<a href="${url}" target="_blank" rel="noopener noreferrer">${safeHtml(label)}</a>` : '<b>unavailable</b>'}</div></div>` +
        buildCard +
        `<div class="service-card-actions"><button onclick="deploySvc('${s.name}')" ${dirty ? '' : 'disabled'}>redeploy</button>` +
        `<button onclick="toggleService('${s.name}', ${!enabled})">${enabled ? 'stop' : 'start'}</button>` +
        (s.name === 'app' ? '' : `<button class="btn danger" onclick="removeService('${s.name}')">remove</button>`) + `</div></div>`;
    }).join('') || '<div class="meta">no services</div>';
    for (const selId of ['logSvc', 'termSvc']) {
      const sel = document.getElementById(selId);
      const prev = sel.value;
      sel.innerHTML = list.filter(s => s.enabled !== false).map(s => `<option value="${s.name}">${s.name}</option>`).join('');
      if ([...sel.options].some(o => o.value === prev)) sel.value = prev;
    }
    try {
      const sug = await (await fetch(`/api/apps/${currentApp}/suggest`)).json();
      const candidate = (folder, type, role) => `<button class="service-suggestion" data-folder="${safeHtml(folder)}" data-type="${type}" onclick="fillService(this.dataset.folder, this.dataset.type)"><span><b>${safeHtml(folder)}</b><small>${role}</small></span><span class="badge">${type}</span></button>`;
      const fronts = (sug.suggestions || []).map(f => candidate(f, 'react', 'Web frontend')).join('');
      const backs = (sug.backends || []).map(b => candidate(b, 'node', 'API or worker')).join('');
      const statics = (sug.staticSuggestions || []).map(f => candidate(f, 'static', 'Static site build')).join('');
      document.getElementById('svcSuggest').innerHTML = (fronts || backs || statics)
        ? `<div class="service-suggestion-label">Detected runnable folders</div><div class="service-suggestion-list">${fronts}${statics}${backs}</div>`
        : '<div class="service-suggestion-empty">No additional runnable folders detected.</div>';
    } catch {}
    scheduleServiceCheck();
  } catch {}
}
async function configureStaticBuild(name, needsModernization) {
  const id = currentApp;
  if (!id) return;
  const ok = await uiConfirm({
    title: 'Use Jekyll static build?',
    body: 'Build with Ruby 3.3 and Node 24, then serve the generated site on nginx. ' + (needsModernization ? 'This opts into replacing node-sass with Sass, updating legacy Webpack 5, and refreshing Ruby gems within Gemfile constraints inside the build only. ' : '') + 'Repository manifests stay unchanged. Save now, redeploy to apply.',
    confirmLabel: 'Save build setup'
  });
  if (!ok || currentApp !== id) return;
  try {
    const r = await (await fetch(`/api/apps/${id}/services/${name}/build-profile`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ modernize: needsModernization }) })).json();
    toast(r.ok ? 'Jekyll build saved — redeploy to apply' : (r.error || 'failed'), !!r.ok);
    await refreshSiteData(id);
  } catch (e) { toast('build setup failed: ' + e.message, false); }
}
function fillService(sub, type) {
  document.getElementById('svcModernBuild').checked = false;
  document.getElementById('svcSub').value = sub;
  document.getElementById('svcName').value = sub.replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'web';
  if (type) document.getElementById('svcType').value = type;
  scheduleServiceCheck();
}
function showStandardDockerfile(out, message) {
  out.innerHTML = '';
  out.appendChild(document.createTextNode(message + ' '));
  const button = document.createElement('button');
  button.textContent = 'use standard Dockerfile';
  button.onclick = seedStandardDockerfile;
  out.appendChild(button);
}
function scheduleServiceCheck() {
  const btn = document.getElementById('svcAddBtn');
  const out = document.getElementById('svcAddCheck');
  if (!btn || !out) return;
  if (serviceCheckTimer) clearTimeout(serviceCheckTimer);
  const seq = ++serviceCheckSeq;
  btn.disabled = true;
  const name = document.getElementById('svcName').value.trim().toLowerCase();
  const subdir = document.getElementById('svcSub').value.trim();
  if (!name || !subdir) {
    out.textContent = 'Enter a unique name and an existing repository subfolder.';
    return;
  }
  if (!/^[a-z0-9][a-z0-9-]{0,30}$/.test(name) || name === 'app') {
    out.textContent = 'Name must use lowercase letters, numbers, or dashes.';
    return;
  }
  out.textContent = 'checking folder…';
  const appId = currentApp;
  serviceCheckTimer = setTimeout(async () => {
    try {
      const q = new URLSearchParams({ name, subdir, type: document.getElementById('svcType').value });
      const r = await (await fetch(`/api/apps/${appId}/services/check?${q}`)).json();
      if (seq !== serviceCheckSeq || appId !== currentApp) return;
      const modern = r.buildProfile && r.buildProfile.needsModernization;
      document.getElementById('svcModernBuildRow').style.display = modern ? 'flex' : 'none';
      btn.disabled = !r.ok || !!r.needsDockerfile || (modern && !document.getElementById('svcModernBuild').checked);
      if (r.ok && r.needsDockerfile)
        showStandardDockerfile(out, `${r.subdir} was detected as ${r.type}, but it needs a Dockerfile.`);
      else out.textContent = r.ok ? modern && !document.getElementById('svcModernBuild').checked ? 'Enable build-only modernization for this static site.' : `Ready: ${r.subdir} will run as ${r.type}.` : (r.error || 'folder cannot be added');
    } catch (e) {
      if (seq !== serviceCheckSeq || appId !== currentApp) return;
      out.textContent = 'could not validate folder';
    }
  }, 300);
}
async function addService() {
  if (!currentApp) return;
  const btn = document.getElementById('svcAddBtn');
  const check = document.getElementById('svcAddCheck');
  btn.disabled = true;
  check.textContent = 'adding service…';
  const body = {
    name: document.getElementById('svcName').value.trim().toLowerCase(),
    subdir: document.getElementById('svcSub').value.trim(),
    type: document.getElementById('svcType').value,
    modernizeBuild: document.getElementById('svcModernBuild').checked
  };
  const r = await (await fetch(`/api/apps/${currentApp}/services`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();
  toast(r.ok ? (`service ${body.name} added as ${r.type || body.type}${r.correctedFrom ? ` (corrected from ${r.correctedFrom})` : ''} - redeploy to start it`) : (r.error || 'failed'), !!r.ok);
  if (r.ok) {
    document.getElementById('svcName').value = '';
    document.getElementById('svcSub').value = '';
    document.getElementById('svcType').value = 'auto';
    document.getElementById('svcModernBuild').checked = false;
    document.getElementById('svcModernBuildRow').style.display = 'none';
    check.textContent = 'Enter a unique name and an existing repository subfolder.';
  } else {
    const msg = r.error || 'service could not be added';
    if (/no Dockerfile in build context/.test(msg)) {
      showStandardDockerfile(check, msg);
    } else {
      check.textContent = msg;
      scheduleServiceCheck();
    }
  }
  refreshSiteData();
}
async function seedStandardDockerfile() {
  if (!currentApp) return;
  const check = document.getElementById('svcAddCheck');
  const subdir = document.getElementById('svcSub').value.trim();
  let type = document.getElementById('svcType').value;
  check.textContent = 'writing standard Dockerfile…';
  try {
    if (type === 'auto') {
      const q = new URLSearchParams({ name: document.getElementById('svcName').value.trim().toLowerCase(), subdir, type: 'auto' });
      const c = await (await fetch(`/api/apps/${currentApp}/services/check?${q}`)).json();
      if (!c.type) throw new Error(c.error || 'could not detect type');
      type = c.type;
    }
    const r = await (await fetch(`/api/apps/${currentApp}/services/dockerfile`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subdir, type }) })).json();
    if (!r.ok) throw new Error(r.error || 'failed');
    toast(`standard ${type} Dockerfile added (${r.seeded.join(', ')}) - commit it to the repo so clones keep it`, true);
    check.textContent = 'Dockerfile added - rechecking…';
  } catch (e) { check.textContent = e.message; return; }
  scheduleServiceCheck();
}
async function toggleService(name, enable) {
  toast((enable ? 'starting ' : 'stopping ') + name + '… (applies on redeploy)');
  const r = await (await fetch(`/api/apps/${currentApp}/services/${name}/enable`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: enable }) })).json();
  toast(r.ok ? (name + (enable ? ' will start' : ' will stop') + ' on redeploy') : (r.error || 'failed'), !!r.ok);
  refreshSiteData();
}
async function removeService(name) {
  const ok = await uiConfirm({ title: 'Remove service ' + name + '?', body: 'Container removed on next redeploy, code and data volumes stay. The folder is untouched.', confirmLabel: 'Remove', danger: true });
  if (!ok) return;
  const row = document.getElementById('svc-' + name);
  if (row) row.remove();
  toast('removing ' + name + '…');
  const r = await (await fetch(`/api/apps/${currentApp}/services/${name}`, { method: 'DELETE' })).json();
  toast(r.ok ? (name + ' removed - redeploy to apply') : (r.error || 'failed'), !!r.ok);
  refreshSiteData();
}
function openTerm() {
  if (!currentApp) return;
  const svc = document.getElementById('termSvc').value || 'app';
  connectTerm('term', currentApp, 'site', svc);
}
function openTermGlobal() {
  const id = document.getElementById('termApp').value;
  if (!id) return;
  connectTerm('termGlobal', id, 'global');
}
// Remote-trigger watcher: webhook/poll/local-push deploys happen with no browser
// involved, so poll /status while a site is open and mirror the progress UI into
// the card the trigger came from (webhook card vs local-git card). Manual ops
// stay with runDeploy to avoid double toasts.
// Power states are source-specific: only the trigger handling the current deploy
// pulses yellow. The persistent site control reflects the whole deployment.
function setPowerState(id, state, label) {
  const el = document.getElementById(id);
  if (!el) return;
  for (const s of ['checking', 'deployed', 'deploying', 'off', 'failed', 'idle']) el.classList.remove('is-' + s);
  el.classList.add('is-' + state);
  el.dataset.state = state;
  const text = el.querySelector('.power-label');
  if (text) text.textContent = label;
  if (id === 'sitePower') {
    el.disabled = state === 'deploying' || state === 'checking';
    el.title = state === 'deployed' ? 'Site is deployed — click to stop' : state === 'off' || state === 'failed' ? 'Site is off — click to start' : label;
  }
}
function sourceSlot(source) {
  if (source === 'local-push') return 'local';
  if (source === 'webhook' || source === 'poll') return 'hook';
  return null;
}
function appIsRunning(st) {
  const containers = (st && st.containers) || [];
  const enabled = ((st && st.services) || []).filter(s => s.enabled !== false);
  if (enabled.length) return enabled.every(s => containers.some(c => c.service === s.name && /^running/i.test(c.state || '')));
  const appContainers = containers.filter(c => !/^db(-|$)/i.test(c.service || ''));
  return appContainers.length > 0 && appContainers.every(c => /^running/i.test(c.state || ''));
}
function updatePowerStates(st) {
  const receiving = st && !st.deployOp && st.pushEvent && (Date.now() - st.pushEvent.at) < 120000;
  const activeSlot = st && st.deployOp ? sourceSlot(st.deployOp.source) : (receiving ? 'local' : null);
  const deploying = !!(st && st.deploying) || !!receiving;
  const running = appIsRunning(st);
  setPowerState('sitePower', deploying ? 'deploying' : (running ? 'deployed' : 'off'), deploying ? 'Deploying' : (running ? 'Deployed' : 'Off'));
  const liveSlot = sourceSlot(st && st.liveDeploy && st.liveDeploy.source);
  const failedSlot = st && st.lastDeploy && st.lastDeploy.status !== 'ok' ? sourceSlot(st.lastDeploy.source) : null;
  const githubEnabled = !!(st && st.app && st.app.github && st.app.github.enabled === true);
  for (const slot of ['hook', 'local']) {
    if (activeSlot) setPowerState(slot + 'Power', slot === activeSlot ? 'deploying' : 'idle', slot === activeSlot ? 'Deploying' : 'Idle');
    else if (slot === 'hook' && !githubEnabled) setPowerState('hookPower', 'off', 'Disabled');
    else if (!running) setPowerState(slot + 'Power', 'off', 'Off');
    else if (failedSlot === slot) setPowerState(slot + 'Power', 'failed', 'Failed');
    else if (liveSlot === slot) setPowerState(slot + 'Power', 'deployed', 'Deployed');
    else setPowerState(slot + 'Power', 'idle', 'Idle');
  }
}
let remoteOp = null;
let manualDeployActive = null;
let manualOpShown = null;
// The Websites list has no open site, so the 3s detail poller below stays
// idle there. Poll visible cards on a slower cadence instead, or a background
// create-build looks stuck at "checking…/busy…" for its whole run.
let siteListPoll = false;
async function pollSiteList() {
  if (siteListPoll || document.hidden) return;
  const view = document.getElementById('view-websites');
  if (!view || !view.classList.contains('active')) return;
  const ids = [...document.querySelectorAll('[id^="appPower-"]')].map(el => el.id.slice('appPower-'.length));
  if (!ids.length) return;
  siteListPoll = true;
  try {
    await hydrateAppCards(websiteVisibleApps.filter(a => ids.includes(a.id)), appsRefreshSeq);
  } finally { siteListPoll = false; }
}
setInterval(() => { if (!currentApp) pollSiteList(); }, 10000);
setInterval(async () => {
  if (!currentApp) return;
  let st;
  try { st = await (await fetch(`/api/apps/${currentApp}/status`)).json(); } catch { return; }
  const op = st.deployOp && st.deployOp.source !== 'manual' ? st.deployOp : null;
  const slot = !op ? null : (op.source === 'local-push' ? 'local' : 'hook');
  const recv = !op && st.pushEvent && (Date.now() - st.pushEvent.at) < 120000;
  updatePowerStates(st);
  if (st.app) renderRouteChoices(st.app);
  // Server-side manual builds (create's background build, list-view redeploys)
  // have no browser-side tracker, unlike runDeploy. Surface them in the main
  // progress box so an opened site shows elapsed time instead of a bare pulse.
  const mop = st.deployOp && (st.deployOp.source === 'manual' || st.deployOp.source === 'local') && manualDeployActive !== currentApp ? st.deployOp : null;
  if (mop) {
    manualOpShown = { app: currentApp, startedAt: mop.startedAt };
    const box = document.getElementById('deployProg');
    if (box) {
      box.style.display = 'block';
      const s = Math.floor((Date.now() - mop.startedAt) / 1000);
      const bar = document.getElementById('deployBar');
      const pctv = Math.min(95, 2 + (Date.now() - mop.startedAt) / 90000 * 93);
      bar.style.width = pctv.toFixed(0) + '%';
      bar.style.background = '#4caf50';
      document.getElementById('deployPct').textContent = pctv.toFixed(0) + '%';
      document.getElementById('deployTime').textContent = s + 's';
      document.getElementById('deployStage').textContent = 'deploying… (started in background)';
    }
  } else if (manualOpShown && manualOpShown.app === currentApp) {
    manualOpShown = null;
    const d = st.lastDeploy;
    const box = document.getElementById('deployProg');
    if (box && box.style.display !== 'none') {
      document.getElementById('deployBar').style.width = '100%';
      document.getElementById('deployPct').textContent = '100%';
      if (d && d.status === 'ok') {
        document.getElementById('deployBar').style.background = '#4caf50';
        document.getElementById('deployStage').textContent = 'done — live';
        toast('background deploy finished', true);
      } else {
        document.getElementById('deployBar').style.background = 'var(--danger)';
        document.getElementById('deployStage').textContent = 'failed';
        toast('background deploy failed: ' + ((d && d.error) || 'unknown'), false);
      }
      setTimeout(() => { box.style.display = 'none'; }, 15000);
    }
    refreshSiteData();
  }
  for (const p of ['hook', 'local']) {
    const box = document.getElementById(p + 'Prog');
    if (!box) continue;
    if (p !== slot && remoteOp && remoteOp.slot === p) {
      const bar = document.getElementById(p + 'Bar');
      const pct = document.getElementById(p + 'Pct');
      const stage = document.getElementById(p + 'Stage');
      const d = st.lastDeploy;
      const secs = d && d.durationMs != null ? Math.round(d.durationMs / 1000) : null;
      bar.style.width = '100%'; pct.textContent = '100%';
      if (d && d.status === 'ok') {
        bar.style.background = '#4caf50';
        stage.textContent = `done — live via ${remoteOp.source}${secs != null ? ` in ${secs}s` : ''}`;
        toast(`deployed via ${remoteOp.source}${secs != null ? ` in ${secs}s` : ''}`, true);
      } else {
        bar.style.background = 'var(--danger)';
        stage.textContent = `failed via ${remoteOp.source}`;
        toast(`deploy via ${remoteOp.source} failed: ` + ((d && d.error) || 'unknown'), false);
      }
      refreshSiteData();
      setTimeout(() => { box.style.display = 'none'; }, 15000);
    }
    if (p !== slot && !(p === 'local' && recv)) box.style.display = 'none';
  }
  if (recv && !remoteOp) {
    const box = document.getElementById('localProg');
    if (box) {
      box.style.display = 'block';
      document.getElementById('localStage').textContent = 'receiving push…';
      document.getElementById('localBar').style.width = '4%';
      document.getElementById('localPct').textContent = '';
      document.getElementById('localTime').textContent = Math.floor((Date.now() - st.pushEvent.at) / 1000) + 's';
    }
  }
  if (!op) { remoteOp = null; return; }
  remoteOp = { app: currentApp, source: op.source, startedAt: op.startedAt, slot };
  const box = document.getElementById(slot + 'Prog');
  if (!box) return;
  box.style.display = 'block';
  const s = Math.floor((Date.now() - op.startedAt) / 1000);
  document.getElementById(slot + 'Time').textContent = s + 's';
  const pctv = Math.min(95, 2 + (Date.now() - op.startedAt) / 90000 * 93);
  document.getElementById(slot + 'Bar').style.width = pctv.toFixed(0) + '%';
  document.getElementById(slot + 'Pct').textContent = pctv.toFixed(0) + '%';
  document.getElementById(slot + 'Stage').textContent = `deploying via ${op.source}…`;
}, 3000);
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
