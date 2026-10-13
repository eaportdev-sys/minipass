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
  createBusyOps = 0;
  createStandardDockerfile = false;
  createPendingId = null;
  createStorageAvailable = null;
  document.getElementById('createStorageGB').value = '5';
  document.getElementById('createStorageState').textContent = 'Checking host quota setup…';
  document.getElementById('createStorageHint').textContent = '';
  document.getElementById('createRepoSize').textContent = 'Repository size: choose a GitHub repository.';
  document.getElementById('name').value = '';
  document.getElementById('createNameError').textContent = '';
  document.getElementById('name').setAttribute?.('aria-invalid', 'false');
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
  createDetectedManager = 'npm';
  document.getElementById('createDetectState').textContent = 'Auto-detect from GitHub, or select manually.';
  document.getElementById('createDetectState').classList?.remove?.('inline-dots');
  document.getElementById('createDetectState').title = '';
  document.getElementById('ghConnState').textContent = 'Paste a site-only token.';
  document.getElementById('ghConnState').classList?.remove?.('inline-dots');
  document.getElementById('ghStoreNote').textContent = 'Saved to this site only.';
  document.getElementById('ghModalConnect').disabled = false;
  document.getElementById('ghModalConnect').textContent = 'List repos';
  document.getElementById('ghModalToken').disabled = false;
  document.getElementById('ghrepo').disabled = false;
  document.getElementById('createBuildBtn').disabled = false;
  document.getElementById('createCancelBtn').disabled = false;
  document.getElementById('createDockerAction').style.display = 'none';
  modalLogin = null;
  accessChanged();
}
function useCreateStandardDockerfile() {
  createStandardDockerfile = true;
  document.getElementById('createDockerAction').style.display = 'none';
  return createApp({ standardDockerfile: true });
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
