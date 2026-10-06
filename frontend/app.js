let currentApp = null;
let serviceCheckTimer = null;
let serviceCheckSeq = 0;
let appsRefreshSeq = 0;
// Global 401 tripwire: any data call that comes back unauthorized drops to the
// login view. Login/setup endpoints are excluded so wrong passwords just show
// their own error instead of looping.
const _fetch = window.fetch.bind(window);
window.fetch = (...a) => _fetch(...a).then(r => {
  if (r.status === 401 && !String(a[0] || '').includes('/api/panel/')) showLogin();
  return r;
});
const dbPopupSlots = new Map();
async function refresh() {
  const seq = ++appsRefreshSeq;
  const apps = await (await fetch('/api/apps')).json();
  document.getElementById('apps').innerHTML = appsGroupedMarkup(apps);
  hydrateAppCards(apps, seq);
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
function appCardMarkup(a) {
  const services = appPublishedServices(a);
  return `<div class="card appcard" id="card-${a.id}"><div class="appcard-layout"><div class="appcard-main">` +
    `<div class="appcard-title"><div><h3>${safeHtml(a.id)}</h3><div class="badges"><span class="badge type">${safeHtml(a.type)}</span><span class="badge">db: ${safeHtml(dbLabel(a))}</span>` +
    (services.length > 1 ? `<span class="badge">${services.length} services</span>` : '') + (a.domain ? `<span class="badge">${safeHtml(a.domain)}</span>` : '') +
    dirtyBadge(a) + `</div></div></div>` +
    `<div class="app-links">${appLinksMarkup(a, services)}</div>` +
    `<div class="appcard-actions"><button class="btn primary" onclick="openSite('${a.id}')">open details</button><span id="appLifecycle-${a.id}"><button disabled>checking…</button></span><button class="btn danger" onclick="rmApp('${a.id}')">delete</button></div></div>` +
    `<button id="appPower-${a.id}" class="power-control app-card-power is-checking" onclick="deploy('${a.id}')" title="Checking deployment state"><span class="power-symbol">⏻</span><span class="power-label">Checking</span></button>` +
    `</div></div>`;
}
function appsGroupedMarkup(apps) {
  if (!apps.length) return '<div class="card">No websites yet - hit + Create.</div>';
  const order = ['static', 'react', 'node', 'php'];
  const labels = { static: 'Static sites', react: 'React apps', node: 'Node.js APIs', php: 'PHP sites' };
  const groups = new Map();
  for (const a of apps) {
    const t = order.includes(a.type) ? a.type : 'other';
    if (!groups.has(t)) groups.set(t, []);
    groups.get(t).push(a);
  }
  const keys = [...groups.keys()].sort((x, y) => {
    const ix = order.includes(x) ? order.indexOf(x) : 99;
    const iy = order.includes(y) ? order.indexOf(y) : 99;
    return ix - iy || x.localeCompare(y);
  });
  return keys.map(k => {
    const list = groups.get(k).slice().sort((a, b) => a.id.localeCompare(b.id));
    const title = labels[k] || 'Other sites';
    return `<section class="app-group"><div class="app-group-head"><b>${safeHtml(title)}</b><span class="badge">${list.length}</span></div>` +
      `<div class="app-group-grid">${list.map(appCardMarkup).join('')}</div></section>`;
  }).join('');
}
function appPublishedServices(a) {
  const list = Array.isArray(a.services) && a.services.length
    ? a.services
    : [{ name: 'app', type: a.type, hostPort: a.hostPort, enabled: true }];
  return list.filter(s => s.enabled !== false && s.hostPort);
}
function appLinksMarkup(a, services) {
  if (!services.length) return '<div class="app-links-empty">No published local service.</div>';
  return services.map(s => {
    const path = s.homePath != null ? s.homePath : (s.name === 'app' ? (a.homePath || '') : '');
    const url = `http://${location.hostname}:${s.hostPort}${path}`;
    return `<div class="app-link-row"><span>${safeHtml(s.name || 'app')}</span><a href="${safeHtml(url)}" target="_blank" rel="noopener noreferrer">${safeHtml(url.replace(/^http:\/\//, ''))}</a></div>`;
  }).join('');
}
function setAppCardState(id, state, running) {
  const power = document.getElementById('appPower-' + id);
  const lifecycle = document.getElementById('appLifecycle-' + id);
  if (!power || !lifecycle) return;
  const label = state === 'deploying' ? 'Deploying' : state === 'checking' ? 'Checking' : running ? 'Redeploy' : state === 'failed' ? 'Retry' : 'Deploy';
  setPowerState('appPower-' + id, state, label);
  power.disabled = state === 'deploying' || state === 'checking';
  power.title = state === 'deploying' ? 'Deployment in progress' : running ? 'Rebuild and redeploy this site' : 'Build and deploy this site';
  lifecycle.innerHTML = state === 'deploying' || state === 'checking'
    ? '<button disabled>busy…</button>'
    : running ? `<button onclick="stopApp('${id}')">stop</button>` : `<button onclick="startApp('${id}')">start</button>`;
}
async function hydrateAppCards(apps, seq) {
  await Promise.all(apps.map(async a => {
    try {
      const st = await (await fetch(`/api/apps/${a.id}/status`)).json();
      if (seq !== appsRefreshSeq) return;
      const running = appIsRunning(st);
      setAppCardState(a.id, st.deploying ? 'deploying' : (running ? 'deployed' : 'off'), running);
    } catch {
      if (seq === appsRefreshSeq) setAppCardState(a.id, 'failed', false);
    }
  }));
}
function openSite(id) {
  currentApp = id;
  showView('site');
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
  document.getElementById('svcAddBtn').disabled = true;
  document.getElementById('svcAddCheck').textContent = 'Enter a unique name and an existing repository subfolder.';
  document.getElementById('migrateOut').textContent = '';
  serviceCheckSeq++;
  if (serviceCheckTimer) clearTimeout(serviceCheckTimer);
  refresh().then(() => { showSiteTab('overview'); loadDeployStatus(); loadEnv(); loadServices(); loadDatabases(); loadMigrateSuggest(); });
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
async function syncGithub() {
  if (!currentApp) return;
  const ok = await uiConfirm({ title: 'Sync checkout to GitHub?', body: 'Use this only for recovery. Tracked and untracked box edits are saved in a git stash, then code/ resets to GitHub. Databases and volumes are untouched. Type the site name to confirm.', requireText: currentApp, confirmLabel: 'Sync', danger: true });
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
async function refreshSiteData() {
  if (!currentApp) return;
  await Promise.allSettled([
    refresh(), loadDeployStatus(), loadServices(), loadDatabases(), loadMigrateSuggest()
  ]);
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
  document.getElementById('migrateOut').textContent = button.dataset.phase === 'initial'
    ? `Initial-setup command selected in ${button.dataset.service} · ${where}. Run it manually; do not save it as a recurring pre-deploy migration unless the project guarantees that is safe.`
    : `Detected runner selected in ${button.dataset.service} · ${where}. Review the command, then save or run it.`;
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
      return `<button class="migrate-detect" data-command="${safeHtml(s.command || s.cmd)}" data-dir="${safeHtml(s.dir || '')}" data-service="${safeHtml(s.service || s.svc || '')}" data-check="${safeHtml(s.check || '')}" data-phase="${safeHtml(s.phase || 'deploy')}" onclick="useMigrateDetection(this)" title="${safeHtml(s.why || '')}"><div><b>${safeHtml(s.framework || 'Migration')}</b><span>${safeHtml(phase)}</span></div><code>${safeHtml(s.command || s.cmd)}</code><em>${safeHtml(location)}</em></button>`;
    }).join('')}</div>` : '<div class="migrate-suggest-label">No migration runner detected — enter the service, folder, and project command manually.</div>';
  } catch { box.innerHTML = ''; }
}
function deploySourceName(source) {
  return ({ manual: 'Manual', webhook: 'GitHub webhook', poll: 'GitHub poll', 'local-push': 'Local push' })[source] || source || 'Unknown';
}
function deployRecordParts(h) {
  const when = (h.at || '').replace('T', ' ').slice(0, 19) || 'time unavailable';
  const duration = h.durationMs != null ? `${Math.round(h.durationMs / 1000)}s` : '';
  const sha = h.sha ? String(h.sha).slice(0, 7) : '';
  const error = h.error ? String(h.error).split('\n').filter(Boolean).slice(-1)[0] : '';
  return { when, duration, sha, error, ok: h.status === 'ok' };
}
function deployHistoryMarkup(hist) {
  if (!hist.length) return '<div class="deploy-empty">No deployments recorded yet.</div>';
  return hist.map(h => {
    const p = deployRecordParts(h);
    return `<div class="deploy-history-item ${p.ok ? 'is-ok' : 'is-failed'}">` +
      `<div class="deploy-history-title"><b>${safeHtml(deploySourceName(h.source))}</b><span class="deploy-result">${p.ok ? 'success' : 'failed'}</span></div>` +
      `<div class="deploy-history-details"><span>${safeHtml(p.when)}</span>${p.sha ? `<code>${safeHtml(p.sha)}</code>` : ''}${p.duration ? `<span>${safeHtml(p.duration)}</span>` : ''}</div>` +
      (p.error ? `<div class="deploy-history-error" title="${safeHtml(p.error)}">${safeHtml(p.error)}</div>` : '') + `</div>`;
  }).join('');
}
function deployLastMarkup(label, h) {
  if (!h) return `<div class="source-last-empty">${safeHtml(label)}: no deployment recorded</div>`;
  const p = deployRecordParts(h);
  return `<div class="source-last-head"><span>${safeHtml(label)}</span><span class="deploy-result ${p.ok ? 'is-ok' : 'is-failed'}">${p.ok ? 'success' : 'failed'}</span></div>` +
    `<div class="source-last-detail"><span>${safeHtml(p.when)}</span>${p.sha ? `<code>${safeHtml(p.sha)}</code>` : ''}${p.duration ? `<span>${safeHtml(p.duration)}</span>` : ''}</div>`;
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
  const info = document.getElementById('deployInfo');
  const list = document.getElementById('containerList');
  if (!info.dataset.live) info.textContent = 'loading…';
  try {
    const s = await (await fetch(`/api/apps/${currentApp}/status`)).json();
    if (s.error) { info.textContent = s.error; list.innerHTML = ''; return; }
    info.dataset.live = '1';
    const d = s.lastDeploy;
    info.textContent = d
      ? `${d.status === 'ok' ? 'live' : 'FAILED'} @ ${d.sha || '?'} · ${d.at || ''}${d.error ? ' — ' + d.error.split('\n').slice(-2).join(' ') : ''}`
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
    document.getElementById('deployHist').innerHTML = deployHistoryMarkup(hist);
    updatePowerStates(s);
  } catch {
    if (!info.dataset.live) info.textContent = 'unreachable';
    setPowerState('sitePower', 'failed', 'Unreachable');
    setPowerState('hookPower', 'failed', 'Unknown');
    setPowerState('localPower', 'failed', 'Unknown');
  }
}
function backToSites() { currentApp = null; showView('websites'); refresh(); }
function fillSiteHeader(a) {
  if (!a) return;
  document.getElementById('siteName').textContent = a.id;
  document.getElementById('siteBadges').innerHTML =
    `<span class="badge type">${a.type}</span><span class="badge">db: ${dbLabel(a)}</span>${a.domain ? `<span class="badge">${a.domain}</span>` : ''}${a.hostPort ? `<span class="badge">:${a.hostPort}</span>` : ''}${a.subdir ? `<span class="badge">/${a.subdir}</span>` : ''}${a.github ? `<span class="badge">git: ${a.github.login ? a.github.login + '/' : ''}${a.github.repo}</span>` : ''}`;
  const url = appUrl(a);
  document.getElementById('siteMeta').innerHTML = url ? `live URL: <a href="${url}" target="_blank">${url.replace(/^http:\/\//, '')}</a>` : 'no published port';
  document.getElementById('siteRedeploy').onclick = () => { showSiteTab('deploy'); deploy(a.id); };
  document.getElementById('siteStop').onclick = () => stopApp(a.id);
  document.getElementById('siteStart').onclick = () => startApp(a.id);
  document.getElementById('siteDelete').onclick = () => rmApp(a.id);
  const power = document.getElementById('sitePower');
  if (power && power.dataset.app !== a.id) {
    power.dataset.app = a.id;
    setPowerState('sitePower', 'checking', 'Checking');
  }
  document.getElementById('hookUrl').textContent = `${location.origin}/webhook/${a.id}?token=${a.token}`;
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
  const ps = document.getElementById('pollSel');
  if (ps) ps.value = String((a.github && a.github.pollMinutes) || 0);
  const pst = document.getElementById('pollState');
  if (pst) pst.textContent = a.github
    ? `tracking ${a.github.repo}@${String(a.github.sha || '?').slice(0, 7)}${a.github.pollMinutes > 0 ? ` — checked every ${a.github.pollMinutes}m` : ' (webhook only)'}`
    : 'no github repo linked';
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
  await copyText(document.getElementById('hookUrl').textContent);
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
      if (v.key === 'NODE_ENV' && !v.managed) {
        const cur = String(v.value).trim();
        return `<div class="env-row" data-env-original="${key}" data-env-managed="0"><div class="env-key-cell">${keyInput}${badge}</div>` +
          `<select class="env-value" aria-label="${key} value"><option value="development"${cur === 'development' ? ' selected' : ''}>development</option><option value="production"${cur === 'production' ? ' selected' : ''}>production</option></select>` +
          `<div class="env-row-actions"><span class="meta">required</span></div></div>`;
      }
      return `<div class="env-row" data-env-original="${key}" data-env-managed="${v.managed ? '1' : '0'}"><div class="env-key-cell">${keyInput}${badge}</div>` +
        `<input class="env-value" type="password" value="${value}" ${canEditValue ? '' : 'readonly'} aria-label="${key} value">` +
        `<div class="env-row-actions"><button onclick="toggleEnv(this)">show</button>${canEditValue ? `<button onclick="genEnvRow(this)">generate</button>` : ''}${v.managed ? '' : ` <button class="btn danger" onclick="envDel('${v.key}')">delete</button>`}</div></div>`;
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
  if (popup) popup.document.body.innerHTML = '<p style="font-family:system-ui">Starting database UI… the first image download can take a minute.</p>';
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
    if (others.length) html += `<optgroup label="other sites">` + others.map(x => `<option value="${x.id}">${x.id} (:${x.hostPort})</option>`).join('') + '</optgroup>';
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
  if (g.hasToken) state.textContent = 'site token stored •••• (used first)';
  else if (g.login) state.textContent = 'panel account: ' + g.login + (g.repo ? ' → ' + g.repo : '');
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
function showSiteTab(t) {
  document.querySelectorAll('.sitetab').forEach(s => s.style.display = 'none');
  document.getElementById('tab-' + t).style.display = 'block';
  document.querySelectorAll('.tabbtn').forEach(b => {
    const active = b.dataset.tab === t;
    b.classList.toggle('active', active);
    b.setAttribute('aria-selected', active ? 'true' : 'false');
  });
  if (!currentApp) return;
  if (t === 'setup') loadDatabases();
  if (t === 'environment') loadEnv();
  if (t === 'files') listFiles('');
  if (t === 'logs') showLogs();
}
async function createApp() {
  const session = createModalSession;
  await createCleanupPromise.catch(() => {});
  if (session !== createModalSession) return;
  const v = id => document.getElementById(id).value.trim();
  const typeEl = document.querySelector('input[name=apptype]:checked');
  const dbs = [...document.querySelectorAll('input[name=appdb]:checked')].map(e => e.value);
  const accessEl = document.querySelector('input[name=access]:checked');
  const access = accessEl ? accessEl.value : 'local';
  const body = {
    name: v('name'), type: typeEl ? typeEl.value : 'static', dbs,
    repoUrl: v('repo'), domain: access === 'domain' ? v('domain') : '',
    subdir: v('subdir'), standardDockerfile: createStandardDockerfile
  };
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
  document.getElementById('out').textContent = JSON.stringify(r, null, 2);
  if (r.needsDockerfile) document.getElementById('createDockerAction').style.display = 'block';
  buildBtn.disabled = false;
  cancelBtn.disabled = false;
  refresh();
  if (!r.error) closeCreate(true);
}
async function detectType() {
  const session = createModalSession;
  const request = ++createDetectRequest;
  const sel = document.getElementById('ghrepo');
  const opt = sel.selectedOptions.length ? sel.selectedOptions[0] : null;
  let repo = sel.value;
  // create flow always uses the fresh pasted token - stored accounts are never consulted
  const token = document.getElementById('ghModalToken').value.trim();
  if (!repo) {
    const m = document.getElementById('repo').value.trim().match(/github\.com[:/]([^/]+)\/([^/]+?)(\.git)?\/?$/i);
    if (!m) return;
    repo = m[1] + '/' + m[2];
  }
  if (!token) { toast('paste a token first - detection never uses stored accounts', false); return; }
  try {
    const r = await (await fetch('/api/github/detect', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ repo, token }) })).json();
    if (session !== createModalSession || request !== createDetectRequest) return;
    if (r.type) {
      const radio = document.querySelector(`input[name=apptype][value=${r.type}]`);
      if (radio) radio.checked = true;
      let msg = 'detected ' + r.type + ' (' + r.reason + ')';
      if (r.dbs && r.dbs.length) {
        document.querySelectorAll('input[name=appdb]').forEach(c => { c.checked = r.dbs.includes(c.value); });
        msg += ' + db: ' + r.dbs.join('+');
      }
      toast(msg);
    } else {
      toast((r.detected ? r.detected + ' has no template yet. ' : 'could not detect type. ') + (r.reason || r.error || ''), false);
    }
    const hint = document.getElementById('subdirHint');
    const fb = (r.frontends || []).map(f => `<button onclick="setSubdir('${f}', 'react')">${f} (web)</button>`).join(' ');
    const bb = (r.backends || []).map(b => `<button onclick="setSubdir('${b}', 'node')">${b} (api)</button>`).join(' ');
    if (fb || bb) {
      hint.style.display = 'block';
      hint.innerHTML = 'repo folders: ' + fb + ' ' + bb;
    } else hint.style.display = 'none';
  } catch {}
}
function setSubdir(f, type) {
  createStandardDockerfile = false;
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
let createStandardDockerfile = false;
let createCleanupPromise = Promise.resolve();
async function modalListRepos() {
  const session = createModalSession;
  const request = ++createConnectRequest;
  // fresh token every build - preview WITHOUT saving to the shared pool
  const token = document.getElementById('ghModalToken').value.trim();
  if (!token) { toast('paste a token first', false); return; }
  const button = document.getElementById('ghModalConnect');
  button.disabled = true;
  button.textContent = 'connecting…';
  let r;
  try {
    r = await (await fetch('/api/github/preview', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) })).json();
  } catch (e) { r = { error: e.message }; }
  if (session !== createModalSession || request !== createConnectRequest) return;
  button.disabled = false;
  button.textContent = 'connect';
  if (r.error) { toast(r.error, false); return; }
  modalLogin = r.login;
  const sel = document.getElementById('ghrepo');
  sel.innerHTML = '<option value="">GitHub repo…</option>' + (r.repos || []).map(x =>
    `<option value="${x.full_name}" data-login="${r.login}">${x.full_name}${x.private ? ' (private)' : ''}</option>`).join('');
  document.getElementById('ghRepoRow').style.display = 'block';
  const nm = document.getElementById('name').value.trim() || 'the new site';
  document.getElementById('ghStoreNote').textContent = `Stored on "${nm}" only — never shared, never pooled.`;
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
}
function accessChanged() {
  const accessEl = document.querySelector('input[name=access]:checked');
  const isDomain = accessEl && accessEl.value === 'domain';
  document.getElementById('domain').style.display = isDomain ? 'block' : 'none';
  // OAuth redirect only exists on the public path - hide it on localhost
  const ob = document.getElementById('oauthBtnRow');
  if (ob) ob.style.display = isDomain ? 'block' : 'none';
}
function openCreate() {
  resetCreateForm();
  document.getElementById('modal').classList.add('open');
}
function resetCreateForm() {
  createModalSession++;
  createConnectRequest++;
  createDetectRequest++;
  createStandardDockerfile = false;
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
  document.getElementById('subdir').value = '';
  document.getElementById('subdirHint').style.display = 'none';
  document.getElementById('subdirHint').innerHTML = '';
  document.getElementById('ghrepo').innerHTML = '<option value="">GitHub repo…</option>';
  document.getElementById('ghRepoRow').style.display = 'none';
  document.getElementById('ghConnectRow').style.display = 'block';
  document.getElementById('ghConnState').textContent = 'paste a fresh token for this site';
  document.getElementById('ghStoreNote').textContent = 'This token will be stored on the new site only — never shared, never pooled.';
  document.getElementById('ghModalConnect').disabled = false;
  document.getElementById('ghModalConnect').textContent = 'connect';
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
  const rawName = document.getElementById('name').value.trim();
  document.getElementById('modal').classList.remove('open');
  resetCreateForm();
  if (!created && rawName) {
    const id = rawName.toLowerCase().replace(/[^a-z0-9-]/g, '-');
    if (id) createCleanupPromise = fetch(`/api/apps/pending/${encodeURIComponent(id)}`, { method: 'DELETE', keepalive: true }).catch(() => {});
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
async function runDeploy(id, services) {
  const prog = document.getElementById('deployProg');
  const bar = document.getElementById('deployBar');
  const pct = document.getElementById('deployPct');
  const time = document.getElementById('deployTime');
  const stage = document.getElementById('deployStage');
  const tail = document.getElementById('deployTail');
  const t0 = Date.now();
  let done = false;
  let outcome = null;
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
  stage.textContent = services && services.length ? ('redeploying ' + services.join(',') + '… (others untouched)') : ('redeploying ' + id + '…');
  try {
    const r = await (await fetch(`/api/apps/${id}/deploy`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(services && services.length ? { services, source: 'manual' } : { source: 'manual' }) })).json();
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
  refreshSiteData();
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
  const ok = await uiConfirm({
    title: 'Delete ' + id + '?',
    body: 'Containers, volumes and files are removed. This cannot be undone.',
    requireText: id, confirmLabel: 'Delete', danger: true
  });
  if (!ok) return;
  // optimistic: gone from screen instantly, restored on failure
  const card = document.getElementById('card-' + id);
  if (card) card.remove();
  toast('deleting ' + id + '…');
  try {
    await fetch('/api/apps/' + id, { method: 'DELETE' });
    toast(id + ' deleted');
    if (id === currentApp) backToSites(); else refresh();
  } catch (e) { toast('delete failed: ' + e.message, false); refresh(); }
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
      return `<div class="service-card" id="svc-${s.name}"><div class="service-card-head"><div><b>${safeHtml(s.name)}</b><span class="badge type">${safeHtml(s.type)}</span>` +
        `<div class="meta">${s.subdir ? `/${safeHtml(s.subdir)}` : 'repository root'}</div></div><span class="badge service-state ${enabled ? 'on' : 'off'}">${enabled ? 'enabled' : 'disabled'}</span></div>` +
        `<div class="service-facts"><div><span>Published port</span><b>${s.hostPort ? `:${s.hostPort} → ${s.port}` : 'not published'}</b></div>` +
        `<div><span>Local URL</span>${url ? `<a href="${url}" target="_blank" rel="noopener noreferrer">${safeHtml(label)}</a>` : '<b>unavailable</b>'}</div></div>` +
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
      document.getElementById('svcSuggest').innerHTML = (fronts || backs)
        ? `<div class="service-suggestion-label">Detected runnable folders</div><div class="service-suggestion-list">${fronts}${backs}</div>`
        : '<div class="service-suggestion-empty">No additional runnable folders detected.</div>';
    } catch {}
    scheduleServiceCheck();
  } catch {}
}
function fillService(sub, type) {
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
      btn.disabled = !r.ok || !!r.needsDockerfile;
      if (r.ok && r.needsDockerfile)
        showStandardDockerfile(out, `${r.subdir} was detected as ${r.type}, but it needs a Dockerfile.`);
      else out.textContent = r.ok ? `Ready: ${r.subdir} will run as ${r.type}.` : (r.error || 'folder cannot be added');
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
    type: document.getElementById('svcType').value
  };
  const r = await (await fetch(`/api/apps/${currentApp}/services`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();
  toast(r.ok ? (`service ${body.name} added as ${r.type || body.type}${r.correctedFrom ? ` (corrected from ${r.correctedFrom})` : ''} - redeploy to start it`) : (r.error || 'failed'), !!r.ok);
  if (r.ok) {
    document.getElementById('svcName').value = '';
    document.getElementById('svcSub').value = '';
    document.getElementById('svcType').value = 'auto';
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
  for (const slot of ['hook', 'local']) {
    if (activeSlot) setPowerState(slot + 'Power', slot === activeSlot ? 'deploying' : 'idle', slot === activeSlot ? 'Deploying' : 'Idle');
    else if (!running) setPowerState(slot + 'Power', 'off', 'Off');
    else if (failedSlot === slot) setPowerState(slot + 'Power', 'failed', 'Failed');
    else if (liveSlot === slot) setPowerState(slot + 'Power', 'deployed', 'Deployed');
    else setPowerState(slot + 'Power', 'idle', 'Idle');
  }
}
let remoteOp = null;
setInterval(async () => {
  if (!currentApp) return;
  let st;
  try { st = await (await fetch(`/api/apps/${currentApp}/status`)).json(); } catch { return; }
  const op = st.deployOp && st.deployOp.source !== 'manual' ? st.deployOp : null;
  const slot = !op ? null : (op.source === 'local-push' ? 'local' : 'hook');
  const recv = !op && st.pushEvent && (Date.now() - st.pushEvent.at) < 120000;
  updatePowerStates(st);
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
  refresh();
  version();
  ghStatus();
}
authBoot();
