let currentApp = null;
async function refresh() {
  const apps = await (await fetch('/api/apps')).json();
  document.getElementById('apps').innerHTML = apps.map(a =>
    `<div class="card appcard"><h3>${a.id}</h3>
    <div class="badges"><span class="badge type">${a.type}</span><span class="badge">db: ${dbLabel(a)}</span>${a.domain ? `<span class="badge">${a.domain}</span>` : ''}</div>
    <div class="meta">local: ${appUrl(a) ? `<a href="${appUrl(a)}" target="_blank">${appUrl(a).replace(/^http:\/\//, '')}</a>` : 'recreate app to get localhost port'}</div>
    <div class="actions"><button class="btn primary" onclick="openSite('${a.id}')">open</button><button onclick="deploy('${a.id}')">redeploy</button><button onclick="stopApp('${a.id}')">stop</button><button onclick="startApp('${a.id}')">start</button><button class="btn danger" onclick="rmApp('${a.id}')">delete</button></div></div>`).join('') || '<div class="card">No websites yet - hit + Create.</div>';
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
  refresh().then(() => { showSiteTab('files'); loadDeployStatus(); loadEnv(); loadServices(); });
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
  refresh();
}
async function loadDeployStatus() {
  if (!currentApp) return;
  const info = document.getElementById('deployInfo');
  const list = document.getElementById('containerList');
  info.textContent = 'loading…';
  try {
    const s = await (await fetch(`/api/apps/${currentApp}/status`)).json();
    if (s.error) { info.textContent = s.error; list.innerHTML = ''; return; }
    const d = s.lastDeploy;
    info.textContent = d
      ? `${d.status === 'ok' ? 'live' : 'FAILED'} @ ${d.sha || '?'} · ${d.at || ''}${d.error ? ' — ' + d.error.split('\n').slice(-2).join(' ') : ''}`
      : 'never deployed by the panel';
    list.innerHTML = (s.containers || []).map(c =>
      `<div class="meta">${c.service} — <b>${c.state || '?'}</b> ${c.status || ''}</div>`).join('') || '<div class="meta">no containers</div>';
    const hp = document.getElementById('homePath');
    if (hp && s.app) hp.value = s.app.homePath || '';
  } catch { info.textContent = 'unreachable'; }
}
function backToSites() { currentApp = null; showView('websites'); refresh(); }
function fillSiteHeader(a) {
  if (!a) return;
  document.getElementById('siteName').textContent = a.id;
  document.getElementById('siteBadges').innerHTML =
    `<span class="badge type">${a.type}</span><span class="badge">db: ${dbLabel(a)}</span>${a.domain ? `<span class="badge">${a.domain}</span>` : ''}${a.hostPort ? `<span class="badge">:${a.hostPort}</span>` : ''}${a.subdir ? `<span class="badge">/${a.subdir}</span>` : ''}${a.github ? `<span class="badge">git: ${a.github.login ? a.github.login + '/' : ''}${a.github.repo}</span>` : ''}`;
  document.getElementById('siteMeta').innerHTML =
    `${appUrl(a) ? `local: <a href="${appUrl(a)}" target="_blank">${appUrl(a).replace(/^http:\/\//, '')}</a><br>` : ''}
    webhook: <code>POST /webhook/${a.id}?token=${a.token}</code>`;
  document.getElementById('siteRedeploy').onclick = () => deploy(a.id);
  document.getElementById('siteStop').onclick = () => stopApp(a.id);
  document.getElementById('siteStart').onclick = () => startApp(a.id);
  document.getElementById('siteDelete').onclick = () => rmApp(a.id);
  document.getElementById('hookUrl').textContent = `${location.origin}/webhook/${a.id}?token=${a.token}`;
  document.getElementById('dbList').textContent = 'attached: ' + dbLabel(a);
  document.getElementById('dbOut').textContent = '';
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
    box.innerHTML = `<code id="localRemote">${remote}</code> <button onclick="copyLocal()">copy</button>` +
      `<div class="meta">on your machine:<br><code>git remote add minipass ${remote}</code><br><code>git push minipass main</code> (or master)</div>`;
  } else {
    box.innerHTML = `<button onclick="initLocalGit()">enable local git push</button>`;
  }
}
async function copyLocal() {
  try { await navigator.clipboard.writeText(document.getElementById('localRemote').textContent); } catch {}
}
async function initLocalGit() {
  if (!currentApp) return;
  const r = await (await fetch(`/api/apps/${currentApp}/git-init`, { method: 'POST' })).json();
  if (r.ok) { toast('local git ready - push to deploy'); refresh(); }
  else toast(r.error || 'failed', false);
}
async function copyHook() {
  try { await navigator.clipboard.writeText(document.getElementById('hookUrl').textContent); } catch {}
}
let envCache = {};
async function loadEnv() {
  if (!currentApp) return;
  const box = document.getElementById('envList');
  box.innerHTML = '<div class="meta">loading…</div>';
  try {
    const r = await (await fetch(`/api/apps/${currentApp}/env`)).json();
    if (r.error) { box.innerHTML = '<div class="meta">' + r.error + '</div>'; return; }
    envCache = {};
    for (const v of (r.vars || [])) envCache[v.key] = v;
    box.innerHTML = (r.vars || []).map(v =>
      `<div class="meta"><code>${v.key}</code> ` +
      ((v.managed && v.key !== 'DOMAIN')
        ? `<span class="badge">managed</span> <code id="envv-${v.key}">${String(v.value).slice(0, 4)}…</code> <button onclick="toggleEnv('${v.key}', this)">show</button>`
        : `<input id="envi-${v.key}" data-envkey="${v.key}" type="password" value="${String(v.value).replace(/"/g, '&quot;')}" style="width:260px"> <button onclick="toggleEnv('${v.key}', this)">show</button>${v.managed ? '' : ` <button onclick="envDel('${v.key}')">delete</button>`}`) +
      `</div>`).join('') || '<div class="meta">(empty env)</div>';
  } catch { box.innerHTML = '<div class="meta">load failed</div>'; }
}
function toggleEnv(key, btn) {
  const v = envCache[key];
  if (!v) return;
  const input = document.getElementById('envi-' + key);
  const code = document.getElementById('envv-' + key);
  const showing = btn.textContent === 'hide';
  if (input) {
    input.type = showing ? 'password' : 'text';
    btn.textContent = showing ? 'show' : 'hide';
  } else if (code) {
    code.textContent = showing ? (String(v.value).slice(0, 4) + '…') : v.value;
    btn.textContent = showing ? 'show' : 'hide';
  }
}
async function saveEnv() {
  if (!currentApp) return;
  const set = {};
  document.querySelectorAll('#envList input[data-envkey]').forEach(i => { set[i.dataset.envkey] = i.value; });
  document.getElementById('envOut').textContent = 'saving + redeploying…';
  try {
    const r = await (await fetch(`/api/apps/${currentApp}/env`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ set }) })).json();
    document.getElementById('envOut').textContent = JSON.stringify(r, null, 2);
    loadEnv();
  } catch (e) { document.getElementById('envOut').textContent = 'failed: ' + e.message; }
}
async function envAdd() {
  if (!currentApp) return;
  const k = document.getElementById('envKey').value.trim();
  const v = document.getElementById('envVal').value;
  if (!k) return;
  const r = await (await fetch(`/api/apps/${currentApp}/env`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ set: { [k]: v } }) })).json();
  document.getElementById('envOut').textContent = JSON.stringify(r, null, 2);
  document.getElementById('envKey').value = '';
  document.getElementById('envVal').value = '';
  loadEnv();
}
async function envDel(key) {
  if (!currentApp) return;
  const ok = await uiConfirm({ title: 'Delete ' + key + '?', body: 'From ' + currentApp + '. Redeploys after.', confirmLabel: 'Delete', danger: true });
  if (!ok) return;
  const r = await (await fetch(`/api/apps/${currentApp}/env`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ delete: [key] }) })).json();
  document.getElementById('envOut').textContent = JSON.stringify(r, null, 2);
  loadEnv();
}
async function addDb() {
  if (!currentApp) return;
  const type = document.getElementById('dbAdd').value;
  document.getElementById('dbOut').textContent = 'adding ' + type + ' + redeploying…';
  try {
    const r = await (await fetch(`/api/apps/${currentApp}/db`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type }) })).json();
    document.getElementById('dbOut').textContent = JSON.stringify(r, null, 2);
    refresh();
  } catch (e) { document.getElementById('dbOut').textContent = 'failed: ' + e.message; }
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
  if (!isWeb) return;
  const ab = a.apiBackend || {};
  const state = document.getElementById('apiState');
  state.textContent = ab.app ? `linked → ${ab.app} (:${ab.port})` : 'not linked';
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
    const others = apps.filter(x => x.id !== a.id && x.hostPort);
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
  } catch {}
}
async function saveApiLink() {
  if (!currentApp) return;
  const target = document.getElementById('apiTarget').value || null;
  const svcRow = document.getElementById('apiSvcRow');
  const service = (svcRow.style.display !== 'none' && document.getElementById('apiService').value) || undefined;
  toast((target ? 'linking to ' + target : 'unlinking') + ' + redeploying…');
  try {
    const r = await (await fetch(`/api/apps/${currentApp}/api-backend`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ target, service }) })).json();
    toast(r.ok ? 'api link saved' : (r.error || 'failed'), !!r.ok);
    refresh();
  } catch (e) { toast('failed: ' + e.message, false); }
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
  el.textContent = 'loading…';
  try {
    const r = await (await fetch(`/api/apps/${currentApp}/repokey`)).json();
    el.textContent = r.pubkey || r.error;
  } catch (e) { el.textContent = 'failed: ' + e.message; }
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
  document.querySelectorAll('.tabbtn').forEach(b => b.classList.toggle('active', b.dataset.tab === t));
  if (!currentApp) return;
  if (t === 'files') listFiles('');
  if (t === 'logs') showLogs();
}
async function createApp() {
  const v = id => document.getElementById(id).value.trim();
  const typeEl = document.querySelector('input[name=apptype]:checked');
  const dbs = [...document.querySelectorAll('input[name=appdb]:checked')].map(e => e.value);
  const accessEl = document.querySelector('input[name=access]:checked');
  const access = accessEl ? accessEl.value : 'local';
  const body = {
    name: v('name'), type: typeEl ? typeEl.value : 'static', dbs,
    repoUrl: v('repo'), domain: access === 'domain' ? v('domain') : '',
    subdir: v('subdir')
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
  const r = await (await fetch('/api/apps', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();
  document.getElementById('out').textContent = JSON.stringify(r, null, 2);
  refresh();
  if (!r.error) closeCreate();
}
async function detectType() {
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
    if (r.frontends && r.frontends.length) {
      hint.style.display = 'block';
      hint.innerHTML = 'frontend folder(s) in this repo: ' + r.frontends.map(f =>
        `<button onclick="setSubdir('${f}')">${f}</button>`).join(' ') + ' — build one as its own site';
    } else hint.style.display = 'none';
  } catch {}
}
function setSubdir(f) {
  document.getElementById('subdir').value = f;
  toast('building subfolder ' + f + ' — set type to react/static for it');
}
async function ghStatus() {
  try {
    const s = await (await fetch('/api/github/status')).json();
    document.getElementById('ghStatus').textContent = s.connected ? ('connected: ' + s.logins.join(', ')) : 'not connected';
    document.getElementById('ghAccounts').innerHTML = (s.logins || []).map(l =>
      `<div class="meta">${l} <button onclick="ghDisconnect('${l}')">disconnect</button></div>`).join('');
    // OAuth is a dead end on LAN (GitHub rejects non-HTTPS callbacks) - only show it when configured
    document.getElementById('oauthRow').style.display = s.oauth ? 'block' : 'none';
  } catch {
    document.getElementById('ghStatus').textContent = 'unknown';
    document.getElementById('ghAccounts').innerHTML = '';
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
async function modalListRepos() {
  // fresh token every build - preview WITHOUT saving to the shared pool
  const token = document.getElementById('ghModalToken').value.trim();
  if (!token) { toast('paste a token first', false); return; }
  const r = await (await fetch('/api/github/preview', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) })).json();
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
  document.getElementById('modal').classList.add('open');
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
  document.getElementById('ghrepo').innerHTML = '<option value="">GitHub repo…</option>';
  document.getElementById('ghRepoRow').style.display = 'none';
  document.getElementById('ghConnectRow').style.display = 'block';
  document.getElementById('ghConnState').textContent = 'paste a fresh token for this site';
  modalLogin = null;
  accessChanged();
}
function closeCreate() { document.getElementById('modal').classList.remove('open'); }
function toggleTheme() {
  const t = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
  document.documentElement.dataset.theme = t;
  try { localStorage.setItem('mp-theme', t); } catch {}
}
try { document.documentElement.dataset.theme = localStorage.getItem('mp-theme') || 'dark'; } catch {}
async function deploy(id) {
  toast('redeploying ' + id + '…');
  try {
    const r = await (await fetch('/api/apps/' + id + '/deploy', { method: 'POST' })).json();
    toast(r.ok ? id + ' redeployed' : ('redeploy failed: ' + (r.error || 'unknown')), !!r.ok);
  } catch (e) { toast('redeploy failed: ' + e.message, false); }
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
  toast('stopping ' + id + '…');
  try {
    const r = await (await fetch('/api/apps/' + id + '/stop', { method: 'POST' })).json();
    toast(r.ok ? id + ' stopped' : ('stop failed: ' + (r.error || 'unknown')), !!r.ok);
    if (id === currentApp) setTimeout(loadDeployStatus, 2000);
  } catch (e) { toast('stop failed: ' + e.message, false); }
}
async function startApp(id) {
  toast('starting ' + id + '…');
  try {
    const r = await (await fetch('/api/apps/' + id + '/start', { method: 'POST' })).json();
    toast(r.ok ? id + ' started' : ('start failed: ' + (r.error || 'unknown')), !!r.ok);
    if (id === currentApp) setTimeout(loadDeployStatus, 2000);
  } catch (e) { toast('start failed: ' + e.message, false); }
}
async function rmApp(id) {
  const ok = await uiConfirm({
    title: 'Delete ' + id + '?',
    body: 'Containers, volumes and files are removed. This cannot be undone.',
    requireText: id, confirmLabel: 'Delete', danger: true
  });
  if (!ok) return;
  try {
    await fetch('/api/apps/' + id, { method: 'DELETE' });
    toast(id + ' deleted');
    if (id === currentApp) backToSites(); else refresh();
  } catch (e) { toast('delete failed: ' + e.message, false); }
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
    document.getElementById('ver').textContent =
      `running ${v.running} · repo ${v.repo}` + (v.upgradeable ? '' : ' (mount ./:/repo to enable upgrade)');
    // landed mid-restart (manual refresh) -> resume watching instead of sitting stale
    if (v.restarting && !restartTimer) watchRestart(300000);
  } catch { document.getElementById('ver').textContent = 'unknown'; }
}
async function upgrade() {
  document.getElementById('upOut').textContent = 'pulling + rebuilding… panel will restart';
  try {
    const r = await (await fetch('/api/panel/upgrade', { method: 'POST' })).json();
    document.getElementById('upOut').textContent = JSON.stringify(r, null, 2);
    if (r.restarting || r.building) watchRestart(300000);
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
async function showKey() {
  const r = await (await fetch('/api/panel/pubkey')).json();
  document.getElementById('keyOut').textContent =
    (r.pubkey || r.error) + '\n\nAdd this as a read-only deploy key on GitHub (repo Settings → Deploy keys) so the panel can pull.';
}
let curDir = '';
async function listFiles(dir) {
  curDir = dir || '';
  if (!dir) { document.getElementById('filePath').value = ''; document.getElementById('fileEdit').value = ''; }
  if (!currentApp) return;
  const files = await (await fetch(`/api/apps/${currentApp}/files?path=${encodeURIComponent(curDir)}`)).json();
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
  if (!id || !fp) return;
  const ok = await uiConfirm({
    title: 'Delete ' + fp + '?', body: 'From ' + id + '. This cannot be undone.',
    confirmLabel: 'Delete', danger: true
  });
  if (!ok) return;
  document.getElementById('fileOut').textContent = 'deleting + redeploying…';
  try {
    const r = await (await fetch(`/api/apps/${id}/file?path=${encodeURIComponent(fp)}`, { method: 'DELETE' })).json();
    document.getElementById('fileOut').textContent = JSON.stringify(r, null, 2);
    document.getElementById('filePath').value = ''; document.getElementById('fileEdit').value = '';
    listFiles(curDir);
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
  out.textContent = `uploading ${mode} (${files.length} file(s)) + redeploying…`;
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
    out.textContent = JSON.stringify(r, null, 2); listFiles('');
  } catch (e) { out.textContent = 'upload failed: ' + e.message; }
  input.value = '';
}
const logsEl = document.getElementById('logs');
const termSlots = {};
function connectTerm(elId, appId, slotKey, svc) {
  // dispose any previous session first - reconnects replace instead of stacking blank terminals
  const old = termSlots[slotKey];
  if (old) {
    try { old.ws.close(); } catch {}
    try { old.term.dispose(); } catch {}
  }
  const el = document.getElementById(elId);
  el.innerHTML = '';
  const t = new Terminal();
  t.open(el);
  t.writeln('connecting to ' + appId + (svc && svc !== 'app' ? '/' + svc : '') + '…');
  const w = new WebSocket(`ws://${location.host}/terminal?app=${appId}&service=${encodeURIComponent(svc || 'app')}`);
  termSlots[slotKey] = { term: t, ws: w };
  w.onopen = () => t.writeln('connected - type commands below.\r\n');
  w.onmessage = e => t.write(e.data);
  w.onerror = () => t.writeln('\r\nconnection error - is the app container running?');
  w.onclose = () => t.writeln('\r\nsession closed. Press connect to reopen.');
  t.onData = d => { try { w.send(d); } catch {} };
}
async function loadServices() {
  if (!currentApp) return;
  try {
    const r = await (await fetch(`/api/apps/${currentApp}/services`)).json();
    const list = r.services || [];
    document.getElementById('svcList').innerHTML = list.map(s =>
      `<div class="meta"><b>${s.name}</b> [${s.type}] ${s.subdir ? `/${s.subdir}` : '(root)'} ` +
      `${s.hostPort ? `:${s.hostPort}→${s.port}` : 'no port'} ` +
      `${s.enabled === false ? '<span class="badge">off</span>' : '<span class="badge">on</span>'} ` +
      `<button onclick="toggleService('${s.name}', ${s.enabled === false})">${s.enabled === false ? 'start' : 'stop'}</button>` +
      (s.name === 'app' ? '' : ` <button class="btn danger" onclick="removeService('${s.name}')">remove</button>`) +
      `</div>`).join('') || '<div class="meta">no services</div>';
    for (const selId of ['logSvc', 'termSvc']) {
      const sel = document.getElementById(selId);
      const prev = sel.value;
      sel.innerHTML = list.filter(s => s.enabled !== false).map(s => `<option value="${s.name}">${s.name}</option>`).join('');
      if ([...sel.options].some(o => o.value === prev)) sel.value = prev;
    }
    try {
      const sug = await (await fetch(`/api/apps/${currentApp}/suggest`)).json();
      document.getElementById('svcSuggest').innerHTML = (sug.suggestions || []).length
        ? 'detected in repo: ' + sug.suggestions.map(f => `<button onclick="fillService('${f}')">${f}</button>`).join(' ')
        : '';
    } catch {}
  } catch {}
}
function fillService(sub) {
  document.getElementById('svcSub').value = sub;
  document.getElementById('svcName').value = sub.replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'web';
}
async function addService() {
  if (!currentApp) return;
  const body = {
    name: document.getElementById('svcName').value.trim().toLowerCase(),
    subdir: document.getElementById('svcSub').value.trim(),
    type: document.getElementById('svcType').value
  };
  const r = await (await fetch(`/api/apps/${currentApp}/services`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();
  toast(r.ok ? ('service ' + body.name + ' added') : (r.error || 'failed'), !!r.ok);
  document.getElementById('svcName').value = '';
  document.getElementById('svcSub').value = '';
  refresh();
  loadServices();
}
async function toggleService(name, enable) {
  const r = await (await fetch(`/api/apps/${currentApp}/services/${name}/enable`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: enable }) })).json();
  toast(r.ok ? (name + (enable ? ' started' : ' stopped')) : (r.error || 'failed'), !!r.ok);
  refresh();
  loadServices();
}
async function removeService(name) {
  const ok = await uiConfirm({ title: 'Remove service ' + name + '?', body: 'Container removed, code and data volumes stay. The folder is untouched.', confirmLabel: 'Remove', danger: true });
  if (!ok) return;
  const r = await (await fetch(`/api/apps/${currentApp}/services/${name}`, { method: 'DELETE' })).json();
  toast(r.ok ? (name + ' removed') : (r.error || 'failed'), !!r.ok);
  refresh();
  loadServices();
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
refresh();
version();
ghStatus();
if (new URLSearchParams(location.search).get('github') === 'connected') {
  toast('github connected - pick a repo at create time');
  showView('panel');
  history.replaceState(null, '', location.pathname);
}
