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
  const row = document.getElementById('gitRepoRow');
  const source = g.repo ? `${g.repo}${g.branch ? '@' + g.branch : ''}` : '';
  const hasSource = !!source || (a.repoUrl && /^(git@|ssh:\/\/)/i.test(a.repoUrl));
  if (row) row.style.display = hasSource ? 'none' : '';
  gitStoredCredential = !!(g.hasToken || g.login);
  try {
    const badge = document.getElementById('gitTokenState');
    if (badge) badge.style.display = g.hasToken ? '' : 'none';
  } catch {}
  await credentialListed();
  if (g.hasToken && source) state.innerHTML = `site token stored •••• (used first) → ${safeHtml(source)} <button onclick="unhideRepoRow()">switch repo</button>`;
  else if (g.hasToken) state.textContent = 'site token stored •••• (used first)';
  else if (g.login && source) state.innerHTML = `panel account: ${safeHtml(g.login)} → ${safeHtml(source)} <button onclick="unhideRepoRow()">switch repo</button>`;
  else if (g.login) state.textContent = 'panel account: ' + g.login;
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
function unhideRepoRow() {
  const row = document.getElementById('gitRepoRow');
  if (row) row.style.display = '';
}
let gitStoredCredential = false;
function credentialReady() {
  try {
    if (document.getElementById('gitSiteToken').value.trim()) return true;
    const acc = document.getElementById('gitAccount');
    if (acc && acc.value) return true;
  } catch {}
  return gitStoredCredential;
}
function updatePickerVisibility() {
  try {
    const row = document.getElementById('gitPickerRow');
    if (row) row.style.display = credentialReady() ? '' : 'none';
    if (!credentialReady()) {
      const sel = document.getElementById('gitRepoPick');
      if (sel) sel.innerHTML = '<option value="">— pick one —</option>';
    }
  } catch {}
}
async function credentialListed() {
  updatePickerVisibility();
  try {
    const row = document.getElementById('gitRepoRow');
    const sel = document.getElementById('gitRepoPick');
    if (row && row.style.display !== 'none' && credentialReady() && sel && sel.options && sel.options.length <= 1) await listSiteRepos();
  } catch {}
}
async function useAccount() {
  if (!currentApp) return;
  const login = document.getElementById('gitAccount').value;
  const r = await (await fetch(`/api/apps/${currentApp}/git-account`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ login }) })).json();
  if (!r.ok) { toast(r.error || 'failed', false); return; }
  if (!login) { toast('account unlinked', true); refresh(); return; }
  const want = wantedRepoLink();
  const hasSiteToken = !!(siteById(currentApp).github && siteById(currentApp).github.hasToken);
  if (r.repo && (!want.repo || want.repo === r.repo)) {
    const detail = hasSiteToken
      ? 'site token still used first'
      : (r.verified ? 'connected to ' + r.repo : 'cannot read ' + r.repo + (r.verifyError ? ': ' + r.verifyError : ''));
    toast('account ' + login + ' saved (' + detail + ')' + (hasSiteToken || r.verified ? ' — redeploy pulls ' + r.repo + ' with it' : ''), hasSiteToken || !!r.verified);
    refresh(); return;
  }
  if (!want.ok) { toast('account saved, but ' + want.error, false); refresh(); return; }
  if (!want.repo) { toast('using account ' + login, true); refresh(); return; }
  toast('using account ' + login + '… connecting ' + want.repo);
  const link = await linkSiteRepo(want.repo);
  if (link.ok) { document.getElementById('gitRepoLink').value = ''; const t = linkDone(link, want.repo); toast('account ' + login + ' connected, ' + t.text, t.ok); if (link.pulled) loadServices(); }
  else toast('account saved, but ' + link.error, false);
  refresh();
}
function wantedRepoLink() {
  const repo = document.getElementById('gitRepoLink').value.trim();
  if (!repo) return { ok: true, repo: null };
  if (!/^[^/\s]+\/[^/\s]+$/.test(repo)) return { ok: false, error: 'repo must be owner/name — not linked' };
  return { ok: true, repo };
}
let lastAutoConnect = '';
async function pickSiteRepo() {
  const v = document.getElementById('gitRepoPick').value;
  if (!v) return;
  document.getElementById('gitRepoLink').value = v;
  if (v === lastAutoConnect) { toast('picked ' + v + ' — press connect to download its files', true); return; }
  lastAutoConnect = v;
  if (document.getElementById('gitSiteToken').value.trim()) { await saveSiteToken(); return; }
  if (gitStoredCredential || ((document.getElementById('gitAccount') || {}).value)) { await connectPickedRepo(v); return; }
  toast('picked ' + v + ' — add a credential above, then connect', true);
}
async function connectPickedRepo(repo) {
  if (!currentApp) return;
  toast('connecting ' + repo + '…');
  const link = await linkSiteRepo(repo);
  if (link.ok) { document.getElementById('gitRepoLink').value = ''; const t = linkDone(link, repo); toast(t.text, t.ok); if (link.pulled) loadServices(); }
  else toast(link.error, false);
  refresh();
}
async function listSiteRepos() {
  if (!currentApp) return;
  const sel = document.getElementById('gitRepoPick');
  toast('listing repos this credential can see…');
  try {
    const r = await (await fetch(`/api/apps/${currentApp}/git-repos`, { method: 'POST' })).json();
    if (!r.ok && r.error) { toast(r.error, false); return; }
    const list = r.repos || [];
    if (!list.length) { toast('no repos visible to this credential', false); return; }
    sel.innerHTML = '<option value="">— pick one —</option>' + list.map(x => `<option value="${safeHtml(x.full_name)}">${safeHtml(x.full_name)}${x.private ? ' (private)' : ''}</option>`).join('');
    sel.style.display = '';
    toast(list.length + ' repos — pick one, then connect', true);
  } catch (e) { toast('list failed: ' + e.message, false); }
}
async function linkSiteRepo(repo) {
  const login = (document.getElementById('gitAccount') || {}).value || undefined;
  try {
    const r = await (await fetch('/api/github/link', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ appId: currentApp, repo, login }) })).json();
    return r.ok ? { ok: true, pulled: !!r.pulled, codePresent: !!r.codePresent, pullNote: r.pullNote || null } : { ok: false, error: r.error || 'link failed' };
  } catch (e) { return { ok: false, error: e.message }; }
}
function linkDone(link, repo) {
  if (link.pulled) return { text: repo + ' downloaded — confirm services below', ok: true };
  if (link.codePresent) return { text: repo + ' connected — ' + (link.pullNote || 'code already on disk'), ok: true };
  return { text: repo + ' connected, but files not downloaded: ' + (link.pullNote || 'unknown error'), ok: false };
}
async function saveSiteToken() {
  if (!currentApp) return;
  const input = document.getElementById('gitSiteToken');
  if (!input.value.trim()) { toast('paste a site token first', false); return; }
  const r = await (await fetch(`/api/apps/${currentApp}/git-token`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: input.value }) })).json();
  if (!r.ok) { toast(r.error || 'failed', false); return; }
  input.value = '';
  const want = wantedRepoLink();
  if (r.repo && (!want.repo || want.repo === r.repo)) {
    toast(r.verified
      ? 'token saved — connected to ' + r.repo + ', redeploy pulls with it'
      : 'token saved, but it cannot read ' + r.repo + (r.verifyError ? ': ' + r.verifyError : ''), !!r.verified);
    refresh(); return;
  }
  if (!want.ok) { toast('token saved, but ' + want.error, false); refresh(); return; }
  if (!want.repo) { toast('site token saved', true); refresh(); return; }
  const link = await linkSiteRepo(want.repo);
  if (link.ok) { document.getElementById('gitRepoLink').value = ''; const t = linkDone(link, want.repo); toast('token saved, ' + t.text, t.ok); if (link.pulled) loadServices(); }
  else toast('token saved, but ' + link.error, false);
  refresh();
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