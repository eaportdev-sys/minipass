function safeHtml(v) {
  return String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
async function loadDatabases() {
  if (!currentApp) return;
  const appId = currentApp;
  const box = document.getElementById('dbRuntimeList');
  if (!box) return;
  box.innerHTML = '<div class="meta">checking database services…</div>';
  try {
    const r = await (await fetch(`/api/apps/${appId}/databases`)).json();
    if (currentApp !== appId) return;
    if (r.error) { box.innerHTML = `<div class="meta">${safeHtml(r.error)}</div>`; return; }
    const add=document.getElementById('dbAddRow');if(add)add.style.display=r.repositoryOwned?'none':'';
    const attached=document.getElementById('dbList');if(attached)attached.textContent=r.repositoryOwned?'Defined by the selected deployment file':'';
    box.innerHTML = (r.databases || []).map(d => {
      const running = /^running/i.test(d.state || '');
      if(d.repositoryOwned&&!d.tool)return `<div class="db-runtime-card"><div class="db-runtime-title"><span class="opdot ${running?'ok':'warn'}"></span><b>${safeHtml(d.label)}</b><span class="badge">${safeHtml(d.service)}</span></div><div class="meta">${running?'Running':d.state==='prepared'?'Prepared — initializes on first deploy':safeHtml(d.state)} · repository-managed</div>${d.status?`<div class="meta">${safeHtml(d.status)}</div>`:''}</div>`;
      const toolPort = parseInt(d.toolPort, 10);
      const toolRunning = d.toolState === 'running' && toolPort >= 8900 && toolPort <= 8999;
      const toolUrl = toolRunning ? `http://${location.hostname}:${toolPort}` : null;
      const action = toolRunning
        ? `<button class="btn primary" onclick="openDbTool('${d.type}', ${toolPort})">open ${safeHtml(d.tool)}</button><a class="btn" href="${safeHtml(toolUrl)}" target="_blank" rel="noopener">open in tab</a><button onclick="stopDbTool('${d.type}')">stop UI</button>`
        : `<button class="btn primary" onclick="launchDbTool('${d.type}')" ${running&&!d.toolError ? '' : 'disabled'}>launch ${safeHtml(d.tool)}</button>`;
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
  } catch (e) { if (currentApp === appId) box.innerHTML = '<div class="meta">database status unavailable</div>'; }
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
    // The admin UI takes up to a minute to boot. A tab closed before first
    // paint must not kill the tool - leave it running for the open button.
    if (popup && !popup.closed) { popup.location.href = url; watchDbPopup(appId, type, popup); }
    else toast('database UI is starting - use the open button (or the link below) when ready', true);
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
