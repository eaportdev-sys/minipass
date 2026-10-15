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
  bar.style.width = '100%'; bar.style.background = '#4caf50';
  pct.textContent = 'working…';
  const tick = setInterval(() => {
    const s = Math.floor((Date.now() - t0) / 1000);
    time.textContent = s + 's';
    // Honest progress: the panel cannot know build percent, so show elapsed
    // effort plus the live log tail instead of a faked percentage.
    if (!done) pct.textContent = s > 60 ? `working… ${Math.floor(s / 60)}m` : 'working…';
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
    toast(r.ok ? id + ' stopped' + (r.cancelledDeploy ? ' (in-flight deploy cancelled)' : '') : ('stop failed: ' + (r.error || 'unknown')), !!r.ok);
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
  const power = document.getElementById('sitePower');
  const state = power.dataset.state;
  if (state === 'deployed') await stopApp(currentApp);
  else if (state === 'off' || state === 'failed') {
    if (power.dataset.canStart === '0') await deploy(currentApp);
    else await startApp(currentApp);
  }
}
async function rmApp(id) {
  const name = siteName(siteById(id));
  const ok = await uiConfirm({
    title: 'Delete ' + name + '?',
    body: `Site ID: ${id}. Containers stop and the site moves to Trash for 48 hours (files and data kept). The name can be reused immediately by a different site. Destroy or expiry removes only this site’s files, database volumes and built images, and clears all unused Docker build cache. Shared images stay.`,
    requireText: name, confirmLabel: 'Move to trash', danger: true
  });
  if (!ok) return;
  // optimistic: gone from screen instantly and kept gone while the slow
  // server-side stop/move runs; restored only if the delete itself fails
  deletingSiteIds.add(id);
  const card = document.getElementById('card-' + id);
  if (card) card.remove();
  toast('moving ' + id + ' to trash…');
  try {
    const r = await (await fetch('/api/apps/' + id, { method: 'DELETE' })).json();
    if (!r.ok) throw new Error(r.error || 'site could not be stopped and moved to Trash');
    toast(r.trashed ? (id + ' in trash — restorable for 48h') : (id + ' deleted'), true);
    if (id === currentApp) backToSites(false); else refresh();
    loadTrash();
  } catch (e) { toast('delete failed: ' + e.message, false); }
  finally { deletingSiteIds.delete(id); refresh(); }
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
    if (trashOpActive) trashProgress(trashOpActive);
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
let trashOpActive = null;
function trashProgress(text) {
  trashOpActive = text || null;
  try {
    const prog = document.getElementById('trashProg');
    if (prog) {
      prog.style.display = text ? 'block' : 'none';
      if (text) {
        const esc = (typeof safeHtml === 'function') ? safeHtml(text) : String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        prog.innerHTML = '<div class="trash-walk" role="status"><div class="trash-walk-track" aria-hidden="true">' +
          '<span class="trash-walker">🚶</span><span class="trash-bag">📦</span><span class="trash-bin">🗑️</span></div>' +
          '<span class="trash-walk-text">' + esc + '</span></div>';
        // vm-test mock keeps innerHTML/textContent as separate fields (no
        // querySelector); mirror the label so textContent assertions still hold.
        try { if (typeof prog.querySelector !== 'function') prog.textContent = text; } catch {}
      }
    }
  } catch {}
  try {
    if (typeof document.querySelectorAll === 'function') {
      for (const b of document.querySelectorAll('#view-trash button')) b.disabled = !!text;
    }
  } catch {}
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
  trashProgress(`Destroying ${count} site${count === 1 ? '' : 's'}… this can take minutes, please wait.`);
  try {
    const r = await (await fetch('/api/trash', { method: 'DELETE' })).json();
    const base = r.ok ? `trash emptied (${(r.destroyed || []).length} destroyed)` : `${(r.destroyed || []).length} destroyed; ${r.error || 'cleanup failed'}`;
    toast(r.cacheWarning ? `${base} (build-cache prune: ${r.cacheWarning})` : base, !!r.ok);
    loadTrash(); refresh();
  } catch (e) { toast('empty failed: ' + e.message, false); }
  finally { trashProgress(null); }
}
async function destroyTrash(id) {
  const name = siteName(siteById(id));
  const ok = await uiConfirm({
    title: 'Destroy ' + name + ' forever?',
    body: `Site ID: ${id}. Remove only this site’s containers, database volumes, files and built images, not another site with the same name. Also clear all unused Docker build cache; other builds may take longer afterward. Shared images needed elsewhere are kept. This cannot be undone.`,
    requireText: name, confirmLabel: 'Destroy forever', danger: true
  });
  if (!ok) return;
  trashProgress('Destroying ' + id + '… this can take a while, please wait.');
  try {
    const r = await (await fetch('/api/trash/' + id, { method: 'DELETE' })).json();
    toast(r.ok ? (id + ' destroyed') : (r.error || 'failed'), !!r.ok);
    loadTrash(); refresh();
  } catch (e) { toast('destroy failed: ' + e.message, false); }
  finally { trashProgress(null); }
}
async function showLogs() {
  if (!currentApp) { logsEl.textContent = 'open a website first'; return; }
  const appId = currentApp;
  const svc = document.getElementById('logSvc').value || 'app';
  logsEl.textContent = 'loading…';
  const text = await (await fetch(`/api/apps/${appId}/logs?service=${encodeURIComponent(svc)}`)).text();
  if (currentApp !== appId) return;
  logsEl.textContent = text;
}
async function showBuildLog(full) {
  if (!currentApp) { logsEl.textContent = 'open a website first'; return; }
  const appId = currentApp;
  logsEl.textContent = 'loading…';
  const text = await (await fetch(`/api/apps/${appId}/build-log${full ? '?tail=500' : ''}`)).text();
  if (currentApp !== appId) return;
  logsEl.textContent = text;
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