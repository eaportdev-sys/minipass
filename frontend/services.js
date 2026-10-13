async function loadServices() {
  if (!currentApp) return;
  const appId = currentApp;
  try {
    const r = await (await fetch(`/api/apps/${appId}/services`)).json();
    if (currentApp !== appId) return;
    const list = r.services || [];
    const dirty = !!r.dirty;
    document.getElementById('svcList').innerHTML = list.map(s => {
      const openPath = s.homePath || '';
      const url = s.hostPort ? `http://${location.hostname}:${s.hostPort}${openPath}` : null;
      const label = s.hostPort ? `${location.hostname}:${s.hostPort}${openPath}` : '';
      const enabled = s.enabled !== false;
      const profile = (r.buildProfiles || {})[s.name];
      const dfs = Array.isArray(s.dockerfiles) ? s.dockerfiles : [];
      const dfCurrent = s.dockerfile || 'Dockerfile';
      const dfCell = dfs.length > 1
        ? `<div><span>Build file</span><span class="controlrow"><select id="svcDockerfile-${safeHtml(s.name)}" aria-label="Build file for ${safeHtml(s.name)}">${dfs.map(f => `<option value="${safeHtml(f)}"${f === dfCurrent ? ' selected' : ''}>${safeHtml(f)}</option>`).join('')}${dfs.includes('Dockerfile') ? '' : `<option value="Dockerfile"${dfCurrent === 'Dockerfile' ? ' selected' : ''}>Dockerfile (default)</option>`}</select><button onclick="saveServiceDockerfile('${safeHtml(s.name)}')">use file</button></span></div>`
        : (dfCurrent !== 'Dockerfile' ? `<div><span>Build file</span><b>${safeHtml(dfCurrent)}</b></div>` : '');
      const buildCard = profile && profile.kind === 'jekyll'
        ? `<div class="service-build-profile"><b>Jekyll static build</b><div class="meta">${profile.customDockerfile ? 'Custom Dockerfile preserved. Configure its build steps in that file.' : `Ruby + Node → ${safeHtml(profile.output)} → nginx${profile.modernize ? ' · build-only modernization enabled' : ''}`}</div>${profile.customDockerfile ? '' : `<div class="meta">${safeHtml((profile.warnings || []).filter(w => !profile.modernize || !w.includes('Enable the build-only')).join(' '))}</div><button onclick="configureStaticBuild('${s.name}', ${!!profile.needsModernization})">${s.type !== 'static' ? 'Use Jekyll static build' : profile.needsModernization && !profile.modernize ? 'Enable build modernization' : 'Configure build'}</button>`}</div>` : '';
      return `<div class="service-card" id="svc-${s.name}"><div class="service-card-head"><div><b>${safeHtml(s.name)}</b><span class="badge type">${safeHtml(s.type)}</span>` +
        `<div class="meta">${s.subdir ? `/${safeHtml(s.subdir)}` : 'repository root'}</div></div><span class="badge service-state ${enabled ? 'on' : 'off'}">${enabled ? 'enabled' : 'disabled'}</span></div>` +
        `<div class="service-facts"><div><span>Published port</span><b>${s.hostPort ? `:${s.hostPort} → ${s.port}` : 'not published'}</b></div>` +
        `<div><span>Local URL</span>${url ? `<a href="${url}" target="_blank" rel="noopener noreferrer">${safeHtml(label)}</a>` : '<b>unavailable</b>'}</div>${dfCell}</div>` +
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
      const sug = await (await fetch(`/api/apps/${appId}/suggest`)).json();
      if (currentApp !== appId) return;
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
      const dfPick = document.getElementById('svcDockerfilePick');
      const dfRow = document.getElementById('svcDockerfileRow');
      if (dfPick && dfRow) {
        const cands = r.dockerfiles || [];
        if (r.ok && cands.length > 1) {
          const cur = r.dockerfile || 'Dockerfile';
          dfPick.innerHTML = cands.map(f => `<option value="${safeHtml(f)}"${f === cur ? ' selected' : ''}>${safeHtml(f)}</option>`).join('');
          dfRow.style.display = '';
        } else { dfRow.style.display = 'none'; dfPick.innerHTML = ''; }
      }
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
  const dfRow = document.getElementById('svcDockerfileRow');
  const dfPick = document.getElementById('svcDockerfilePick');
  if (dfRow && dfPick && dfRow.style.display !== 'none' && dfPick.value) body.dockerfile = dfPick.value;
  const r = await (await fetch(`/api/apps/${currentApp}/services`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();
  toast(r.ok ? (`service ${body.name} added as ${r.type || body.type}${r.correctedFrom ? ` (corrected from ${r.correctedFrom})` : ''} - redeploy to start it`) : (r.error || 'failed'), !!r.ok);
  if (r.ok) {
    document.getElementById('svcName').value = '';
    document.getElementById('svcSub').value = '';
    document.getElementById('svcType').value = 'auto';
    document.getElementById('svcModernBuild').checked = false;
    document.getElementById('svcModernBuildRow').style.display = 'none';
    document.getElementById('svcDockerfileRow').style.display = 'none';
    document.getElementById('svcDockerfilePick').innerHTML = '';
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
async function saveServiceDockerfile(name) {
  if (!currentApp) return;
  const appId = currentApp;
  const sel = document.getElementById('svcDockerfile-' + name);
  const value = sel ? sel.value : 'Dockerfile';
  toast('saving build file for ' + name + '…');
  try {
    const r = await (await fetch(`/api/apps/${appId}/services/${name}/dockerfile`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dockerfile: value }) })).json();
    if (currentApp !== appId) return;
    toast(r.ok ? (name + ' builds with ' + (r.dockerfile || value) + ' - redeploy to apply') : (r.error || 'failed'), !!r.ok);
  } catch (e) { toast('save failed: ' + e.message, false); }
  refreshSiteData();
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