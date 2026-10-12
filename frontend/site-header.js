function backToSites(push = true) {
  currentApp = null;
  const url = `${location.pathname}${location.search}`;
  if (push && location.hash) history.pushState(null, '', url);
  else history.replaceState(null, '', url);
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
      `<div class="local-command"><span>2 · Push your branch</span><code>git push minipass main</code><small>Use <b>master</b> instead when that is your branch.</small></div>` +
      (a.autoDeploy === false ? '<div class="meta">Automatic deploys are disabled — pushes land without rebuilding until re-enabled.</div>' : '');
  } else if (a.autoDeploy === false) {
    box.innerHTML = `<div class="local-git-disabled"><b>Direct push is parked</b><div class="meta">Automatic deploys are disabled — pushes would land without rebuilding. Manual redeploys still work.</div></div>`;
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
  const resetEnable = () => { enable.textContent = 'enable github automation'; enable.onclick = () => setGithubAutomation(true); };
  if (!a.github || !a.github.repo) {
    off.style.display = 'block'; on.style.display = 'none'; enable.style.display = 'none'; resetEnable();
    title.textContent = 'No GitHub repository linked';
    meta.textContent = 'Connect a repository in Setup before enabling automatic deployments.';
    return;
  }
  const where = `${a.github.repo}${a.github.branch ? '@' + a.github.branch : ''}`;
  const staleEnabled = a.github.enabled === true;
  if (a.autoDeploy === false) {
    off.style.display = 'block'; on.style.display = 'none';
    title.textContent = 'Automatic deploys disabled';
    meta.textContent = where + ' stays linked for manual redeploys. Triggers are parked while automatic deploys are disabled.' +
      (staleEnabled ? ' This site still has automation switched on — switch it off below to remove its GitHub webhook.' : '');
    if (staleEnabled) { enable.style.display = ''; enable.textContent = 'disable leftover automation'; enable.onclick = () => setGithubAutomation(false); }
    else { enable.style.display = 'none'; resetEnable(); }
    return;
  }
  if (!staleEnabled) {
    off.style.display = 'block'; on.style.display = 'none'; enable.style.display = ''; resetEnable();
    title.textContent = 'GitHub automation is disabled';
    meta.textContent = where + ' stays linked for manual repository redeploys. No webhook or polling deploys will run.';
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