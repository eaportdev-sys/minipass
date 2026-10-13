async function createApp(options = {}) {
  const session = createModalSession;
  // Snapshot one-click approvals before awaiting prior-modal cleanup. Detection
  // or reset work finishing during that await must not erase the user's click.
  const approvedStandardDockerfile = options.standardDockerfile === true || createStandardDockerfile;
  await createCleanupPromise.catch(() => {});
  if (session !== createModalSession) return;
  const v = id => document.getElementById(id).value.trim();
  const nameField = document.getElementById('name');
  const nameError = document.getElementById('createNameError');
  nameError.textContent = '';
  nameField.setAttribute?.('aria-invalid', 'false');
  if (!v('name')) {
    nameError.textContent = 'Site name is required.';
    nameField.setAttribute?.('aria-invalid', 'true');
    nameField.focus?.();
    return;
  }
  if (typeof createBusyOps !== 'undefined' && createBusyOps > 0) { toast('Wait for repository listing and detection to finish.', false); return; }
  const storageGB = v('createStorageGB');
  if (!/^(?:[1-9]\d*|0)(?:\.\d{1,3})?$/.test(storageGB) || Number(storageGB) < 0.1 || Number(storageGB) > 1000000) { toast('Enter a storage allowance from 0.1 to 1,000,000 GB (up to 3 decimal places).', false); return; }
  const typeEl = document.querySelector('input[name=apptype]:checked');
  const dbs = [...document.querySelectorAll('input[name=appdb]:checked')].map(e => e.value);
  const accessEl = document.querySelector('input[name=access]:checked');
  const access = accessEl ? accessEl.value : 'local';
  const body = {
    name: v('name'), type: typeEl ? typeEl.value : 'static', dbs, storageGB,
    repoUrl: v('repo'), access,domain: access === 'domain' ? v('domain') : '',
    subdir: v('subdir'), standardDockerfile: approvedStandardDockerfile,
    packageManager: createDetectedManager,
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
  if((body.repoUrl||body.ghRepo)&&typeof prepareCreateSource==='function') {
    if(!createSourceReady(body)&&!await prepareCreateSource({...body,prepareOnly:true}))return;
    const choice=createSourceSelection();if(choice)body.deploymentEntrypoint=choice;
    if(createPendingId)body.pendingId=createPendingId;
  }
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
  if(r.needsEntrypoint&&r.plan&&typeof showCreateSource==='function')showCreateSource(r.plan);
  document.getElementById('out').textContent = r.error||'';
  if (r.field === 'name') { nameError.textContent = r.error; nameField.setAttribute?.('aria-invalid', 'true'); nameField.focus?.(); }
  if (r.needsDockerfile) document.getElementById('createDockerAction').style.display = 'flex';
  if (r.needsModernization) {
    document.getElementById('createBuildProfile').style.display = 'block';
    document.getElementById('createModernBuildRow').style.display = 'flex';
    document.getElementById('createBuildNote').textContent = r.error;
  }
  buildBtn.disabled = typeof createSourceNeedsChoice==='function'&&createSourceNeedsChoice();
  cancelBtn.disabled = false;
  refresh();
  if (!r.error) {
    if (r.storageWarning) toast('Site created, but the storage allowance is NOT enforced on this host: ' + r.storageWarning, false);
    if (Array.isArray(r.envNeeds) && r.envNeeds.length) toast(`Site created - code references unset variables (${r.envNeeds.join(', ')}) - add values in Environment before deploying`, false);
    closeCreate(true);
    if (r.id && typeof openSite === 'function') openSite(r.id, 'deploy');
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
      createDetectedManager = 'npm';
      if(typeof prepareCreateSource==='function')await prepareCreateSource();
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
  // Detection reads the repo tree + package.json: lock the picker so a
  // second selection cannot race the in-flight read. Build waits too.
  sel.disabled = true;
  setBuildBusy(true);
  try { state.classList.add('inline-dots'); } catch {}
  try {
    const r = await (await fetch('/api/github/detect', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ repo, branch, ...(token ? { token } : {}) }) })).json();
    if (session !== createModalSession) return;
    if (request !== createDetectRequest) { setBuildBusy(false); return; }
    sel.disabled = false;
    setBuildBusy(false);
    try { state.classList.remove('inline-dots'); } catch {}
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
      createDetectedManager = ['npm', 'pnpm', 'yarn', 'bun'].includes(r.packageManager) ? r.packageManager : 'npm';
      state.textContent = `Detected ${types[r.type] || r.type}${dbs.length ? ' + ' + dbs.join(', ') : ''}${createDetectedManager !== 'npm' ? ` · installs with ${createDetectedManager}` : ''}${r.branch ? ' on ' + r.branch : ''}. Check the selections below.`;
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
    sel.disabled = false;
    if(typeof prepareCreateSource==='function')await prepareCreateSource();
  } catch {
    if (session !== createModalSession) return;
    if (request !== createDetectRequest) { setBuildBusy(false); return; }
    sel.disabled = false;
    setBuildBusy(false);
    try { state.classList.remove('inline-dots'); } catch {}
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
