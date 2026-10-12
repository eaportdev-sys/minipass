function hostCandidateRows(bridge) {
  if (!bridge || bridge.error) return `<div class="meta">${safeHtml(bridge && bridge.error ? bridge.error : 'Discovery unavailable — complete host quota setup and retry.')}</div>`;
  const vgs = Object.entries(bridge.vgFree || {}).map(([vg, free]) => `<div class="storage-row"><b>VG free: ${safeHtml(vg)}</b><span>${storageSize(free)} — <button onclick="fillProvisionTarget('vg:${safeHtml(vg)}')">use vg:${safeHtml(vg)}</button></span></div>`).join('');
  const spares = (bridge.spares || []).map(d => `<div class="storage-row"><b>Spare: ${safeHtml(d)}</b><span>formatting destroys data — <button onclick="fillProvisionTarget('device:${safeHtml(d)}')">use device:${safeHtml(d)}</button></span></div>`).join('');
  const regions = (bridge.freeRegions || []).map(r => `<div class="storage-row"><b>Free space: ${safeHtml(r.disk)}</b><span>${storageSize(r.bytes)} — <button onclick="fillProvisionTarget('region:${safeHtml(r.disk)}:${r.start}:${r.end}')">use region:${safeHtml(r.disk)}:${r.start}:${r.end}</button></span></div>`).join('');
  return vgs + spares + regions || '<div class="meta">No unallocated VG space, spare disks or free regions found. Attach storage, then refresh.</div>';
}
function fillProvisionTarget(target) {
  const input = document.getElementById('provisionTarget');
  if (input) { input.value = target; input.focus(); }
}
function hostCapacityMarkup(d, approval) {
  const b = (d && d.bridge) || {};
  const q = (d && d.quota) || {};
  const setup = (d && d.setup) || {};
  const mount = b.mount || {};
  const where = mount.source ? ` (${safeHtml(mount.source)} on ${safeHtml(mount.target || '/srv/apps')})` : '';
  const disk = Number.isFinite(b.appsTotalBytes) && Number.isFinite(b.appsFreeBytes)
    ? `Host filesystem${where}: ${storageSize(b.appsTotalBytes)} total · ${storageSize(b.appsTotalBytes - b.appsFreeBytes)} used · ${storageSize(b.appsFreeBytes)} free.`
    : `Host filesystem size unavailable${where}.`;
  if (q.ready) return `<div>${disk}</div><div class="meta">Quotas active — ${storageSize(q.availableBytes)} available for new allowances (Trash and host headroom reserved).</div>`;

  const status = setup.message || q.error || 'Quota enforcement is not active on /srv/apps.';
  const target = approval && approval.target;
  const command = target ? `sudo bash install-linux.sh --provision-storage=${target}` : '';
  let next = '';
  if (/containers are running/i.test(status)) {
    next = `<div class="meta"><b>Finish setup:</b><br>` +
      `1. Copy the approved installer command shown below.<br>` +
      `2. In Websites, stop every running site.<br>` +
      `3. On the host, open the Minipass repository and run <code>docker compose -p minipass down</code>.<br>` +
      `4. Run the approved installer command. It will safely move the site data and start the panel again.<br>` +
      `5. Return here and press refresh.</div>`;
  } else if (/reboot/i.test(status)) {
    next = `<div class="meta"><b>Next:</b> reboot during maintenance, rerun the installer from the Minipass repository, then refresh this page.</div>`;
  } else if (command) {
    next = `<div class="meta"><b>Next:</b> run this approved command from the Minipass repository on the host:<br><code>${safeHtml(command)}</code></div>`;
  } else {
    next = `<div class="meta"><b>Next:</b> choose an expansion candidate, approve its exact target, then run the host command shown below.</div>`;
  }
  return `<div>${disk}</div><div class="meta"><b>Not enforced:</b> ${safeHtml(status)}</div>${next}`;
}
async function loadHostStorage() {
  const box = document.getElementById('hostStorageBox');
  const list = document.getElementById('hostCandidates');
  const state = document.getElementById('hostQuotaState');
  const provisionOut = document.getElementById('provisionOut');
  if (box) box.textContent = 'loading…';
  if (list) list.innerHTML = '';
  try {
    const [d, p] = await Promise.all([
      fetch('/api/panel/storage/discovery').then(r => r.json()),
      fetch('/api/panel/storage/provision').then(r => r.json()).catch(() => ({ approval: null }))
    ]);
    const q = d.quota || {};
    if (state) { state.textContent = q.ready ? 'quotas active' : 'unenforced'; state.className = 'panel-state ' + (q.ready ? 'is-ok' : 'is-busy'); }
    if (box) box.innerHTML = hostCapacityMarkup(d, p && p.approval);
    if (list) list.innerHTML = hostCandidateRows(d.bridge);
    if (provisionOut) {
      provisionOut.textContent = q.ready
        ? 'Storage setup complete — quotas are active.'
        : p && p.approval
          ? `Pending host approval: ${p.approval.target} — run: sudo bash install-linux.sh --provision-storage=${p.approval.target} — then answer the installer's confirmation prompt.`
          : '';
    }
    loadRemotes();
  } catch { if (box) box.textContent = 'Storage discovery unavailable.'; }
}
async function loadRemotes() {
  const box = document.getElementById('remoteList');
  if (!box) return;
  try {
    const remotes = await (await fetch('/api/panel/storage/remotes')).json();
    box.innerHTML = remotes.length ? remotes.map(r => `<div class="storage-row"><b>${safeHtml(r.type)} · ${safeHtml(r.address)}</b><span>${r.hasPassword ? 'password stored · ' : ''}backup-only, never quota-capable <button onclick="showRemoteSetup('${r.id}')">connect</button> <button onclick="removeRemote('${r.id}')">remove</button></span></div><div id="remote-setup-${r.id}"></div>`).join('') : '<div class="meta">No remotes registered.</div>';
  } catch { box.textContent = 'Remotes unavailable.'; }
}
async function addRemote() {
  const body = { type: document.getElementById('remoteType').value, address: document.getElementById('remoteAddress').value.trim(), username: document.getElementById('remoteUser').value.trim(), password: document.getElementById('remotePass').value, mount: document.getElementById('remoteMount').value.trim() };
  try {
    const r = await (await fetch('/api/panel/storage/remotes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();
    toast(r.error || `remote added (${r.id}) — backup-class only`, !r.error);
    document.getElementById('remotePass').value = '';
    loadRemotes();
  } catch (e) { toast('add remote failed: ' + e.message, false); }
}
async function showRemoteSetup(id) {
  const box = document.getElementById('remote-setup-' + id);
  if (!box) return;
  box.innerHTML = '<div class="meta">loading connect steps…</div>';
  try {
    const r = await (await fetch('/api/panel/storage/remotes/' + encodeURIComponent(id) + '/setup')).json();
    if (r.error) { box.innerHTML = `<div class="meta">${safeHtml(r.error)}</div>`; return; }
    box.innerHTML = `<div class="meta">Run once as root on the host. ${safeHtml(r.persist)}</div>` +
      `<pre tabindex="0">${safeHtml(r.steps.join('\n'))}</pre>` +
      `<div class="meta">Verify: <code>${safeHtml(r.verify)}</code>. ${safeHtml(r.note)}</div>`;
  } catch { box.innerHTML = '<div class="meta">setup unavailable</div>'; }
}
async function removeRemote(id) {
  const ok = await uiConfirm({ title: 'Remove remote?', body: 'Removes the registry entry only. Mounted storage is left untouched.', confirmLabel: 'Remove' });
  if (!ok) return;
  await fetch('/api/panel/storage/remotes/' + encodeURIComponent(id), { method: 'DELETE' });
  loadRemotes();
}
async function requestProvision() {
  const target = document.getElementById('provisionTarget').value.trim();
  const out = document.getElementById('provisionOut');
  const ok = await uiConfirm({ title: 'Prepare host storage setup?', body: `This records ${target} as the exact target and creates the host command. Nothing is formatted from this browser. The sudo installer will describe the operation and wait for your final yes/no answer.`, requireText: target, confirmLabel: 'Prepare', danger: true });
  if (!ok) return;
  try {
    const r = await (await fetch('/api/panel/storage/provision', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ target, confirm: target }) })).json();
    out.textContent = r.error || `On the host run: ${r.hostCommand} — then answer the installer's confirmation prompt.`;
    toast(r.error || 'host command ready — run it and answer the prompt', !r.error);
  } catch (e) { out.textContent = 'approval failed: ' + e.message; }
}
function panelErrorText(e) {
  return `${String(e.at || '').replace('T', ' ').slice(0, 19)} [${e.level || 'error'}] ${e.area || 'panel'}${e.site ? ' (' + e.site + ')' : ''}: ${e.message || ''}`;
}
async function loadPanelErrors() {
  const box = document.getElementById('panelErrors');
  if (!box) return;
  box.textContent = 'loading…';
  try {
    const r = await (await fetch('/api/panel/errors?limit=100')).json();
    const list = Array.isArray(r) ? r : [];
    box.textContent = list.length ? list.map(panelErrorText).join('\n\n') : 'No recorded errors. Deployment failures, site creation and Trash cleanup problems are saved here with timestamps.';
  } catch { box.textContent = 'Could not load the error log.'; }
}
async function copyPanelErrors() {
  const text = document.getElementById('panelErrors').textContent;
  if (!text.trim() || text === 'loading…' || text.startsWith('No recorded errors') || text.startsWith('Could not load')) {
    toast('load the error log before copying', false);
    return;
  }
  const ok = await copyText(text);
  toast(ok ? 'errors copied' : 'copy failed - select and copy manually', ok);
}