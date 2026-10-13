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
      (s.key ? `<button class="btn primary" onclick="applyRemediation(${i})">${s.kind === 'dockerfile-restore' ? 'restore original Dockerfile' : s.kind === 'import-repair' ? 'apply import correction' : s.kind === 'dockerfile-fix' ? 'apply Dockerfile fix' : 'apply fix'}</button>` : s.protectionKey ? `<button onclick="${s.kind === 'dockerfile-protection' ? 'removeDockerfileProtection' : 'removeImportProtection'}(${i})">remove protection</button>` : '') + '</div>' +
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
    title: s.kind === 'import-repair' ? 'Apply import correction?' : s.kind === 'dockerfile-fix' ? 'Apply Dockerfile fix?' : 'Apply fix?',
    body: s.kind === 'import-repair'
      ? `${s.title}. Files: ${(s.files || []).join(', ')}. The approved import-only repair is retained outside Git and revalidated on redeploy. Changed or ambiguous source stops for review. Your remote repo stays untouched. Use local rebuild now.\n\n${s.preview || ''}`
      : s.kind === 'dockerfile-fix'
      ? `${s.title}. Files: ${(s.files || []).join(', ')}. The approved build-environment adaptation is retained outside Git and revalidated on redeploy. Only the previewed build recipe changes (base image, build tools, or build-time placeholders); application source stays untouched. Your remote repo stays untouched. Use local rebuild now.\n\n${s.preview || ''}`
      : `${s.title}. Writes box files only (${(s.files || []).join(', ')}) — use local rebuild afterwards to preserve box edits. Your remote repo stays untouched until you commit.`,
    confirmLabel: s.kind === 'import-repair' ? 'Apply imports' : s.kind === 'dockerfile-fix' ? 'Apply Dockerfile fix' : 'Apply fix'
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
async function removeDockerfileProtection(i) {
  const s = remediateCache[i];
  if (!s || !s.protectionKey || !currentApp) return;
  const appId = currentApp;
  const ok = await uiConfirm({ title: 'Remove redeploy protection?', body: `Stop retaining this approved Dockerfile adaptation for ${s.service}: ${(s.files || []).join(', ')}. The current build recipe is not changed. Future checkouts will use the repository Dockerfile; fix the repository itself if the adaptation is still needed.`, confirmLabel: 'Remove protection', danger: true });
  if (!ok || currentApp !== appId) return;
  try {
    const r = await (await fetch(`/api/apps/${appId}/dockerfile-fix`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: s.protectionKey, service: s.service, revision: s.revision }) })).json();
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
  if(container.role==='task')return 'Deployment task';
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
      const completed=c.role==='task'&&c.state==='exited'&&c.exitCode===0;
      return `<div class="runtime-row"><div><span class="opdot ${up||completed ? 'ok' : 'fail'}"></span> <b>${c.service}</b> <span class="badge type">${runtimeKind(c, service)}</span></div>` +
        `<div class="runtime-version">${runtimeVersion(c, service, live)}</div>` +
        `<div class="runtime-state"><b>${completed?'completed successfully':c.state || '?'}</b>${completed?' · exit 0':c.status ? ` · ${c.status}` : ''}</div></div>`;
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
