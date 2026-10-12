async function loadEnv() {
  if (!currentApp) return;
  const appId = currentApp;
  const box = document.getElementById('envList');
  box.innerHTML = '<div class="meta">loading…</div>';
  try {
    const r = await (await fetch(`/api/apps/${appId}/env`)).json();
    if (currentApp !== appId) return;
    if (r.error) { box.innerHTML = '<div class="meta">' + safeHtml(r.error) + '</div>'; return; }
    box.innerHTML = (r.vars || []).map(v => {
      const key = safeHtml(v.key);
      const value = safeHtml(v.value);
      const protectedKey = v.key === 'NODE_ENV';
      const keyInput = `<input class="env-name" value="${key}" ${v.managed || protectedKey ? 'readonly' : ''} aria-label="Environment key">`;
      const badge = v.managed ? '<span class="badge">managed</span>' : '';
      const canEditValue = !v.managed || v.key === 'DOMAIN';
      const isDomain = v.key === 'DOMAIN';
      if (v.key === 'NODE_ENV' && !v.managed) {
        const cur = String(v.value).trim();
        return `<div class="env-row" data-env-original="${key}" data-env-managed="0"><div class="env-key-cell">${keyInput}${badge}</div>` +
          `<select class="env-value" aria-label="${key} value"><option value="development"${cur === 'development' ? ' selected' : ''}>development</option><option value="production"${cur === 'production' ? ' selected' : ''}>production</option></select>` +
          `<div class="env-row-actions"><span class="meta">required</span></div></div>`;
      }
      return `<div class="env-row" data-env-original="${key}" data-env-managed="${v.managed ? '1' : '0'}"><div class="env-key-cell">${keyInput}${badge}</div>` +
        `<input class="env-value" type="${isDomain ? 'text' : 'password'}" value="${value}" ${canEditValue ? '' : 'readonly'} ${isDomain ? 'placeholder="app.example.com"' : ''} aria-label="${key} value">` +
        `<div class="env-row-actions">${isDomain ? '<span class="meta">hostname</span>' : `<button onclick="toggleEnv(this)">show</button>${canEditValue ? `<button onclick="genEnvRow(this)">generate</button>` : ''}`}${v.managed ? '' : ` <button class="btn danger" onclick="envDel('${v.key}')">delete</button>`}</div></div>`;
    }).join('') || '<div class="meta">(empty env)</div>';
  } catch { if (currentApp === appId) box.innerHTML = '<div class="meta">load failed</div>'; }
}
function toggleEnv(btn) {  const input = btn.closest('.env-row').querySelector('input.env-value');
  if (!input) return;
  const showing = btn.textContent === 'hide';
  input.type = showing ? 'password' : 'text';
  btn.textContent = showing ? 'show' : 'hide';
}
async function saveEnv() {
  if (!currentApp) return;
  const set = {};
  const del = [];
  const rename = {};
  const seen = new Set();
  for (const row of document.querySelectorAll('#envList .env-row')) {
    const original = row.dataset.envOriginal;
    const managed = row.dataset.envManaged === '1';
    const key = row.querySelector('.env-name').value.trim();
    const value = row.querySelector('.env-value').value;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      toast(`invalid environment key: ${key || '(empty)'}`, false);
      return;
    }
    if (seen.has(key)) {
      toast(`duplicate environment key: ${key}`, false);
      return;
    }
    seen.add(key);
    if (!managed || original === 'DOMAIN') set[key] = value;
    if (!managed && key !== original) { del.push(original); rename[original] = key; }
  }
  document.getElementById('envOut').textContent = 'saving… (redeploy to apply)';
  try {
    const r = await (await fetch(`/api/apps/${currentApp}/env`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ set, delete: del, rename }) })).json();
    document.getElementById('envOut').textContent = JSON.stringify(r, null, 2);
    if (!r.ok) { toast(r.error || 'save failed', false); return; }
    toast('environment saved - redeploy to apply');
    loadEnv(); refresh(); loadServices();
  } catch (e) { document.getElementById('envOut').textContent = 'failed: ' + e.message; toast('environment save failed', false); }
}
async function fillEnvDefaults() {
  if (!currentApp) return;
  document.getElementById('envOut').textContent = 'adding defaults… (redeploy to apply)';
  try {
    const r = await (await fetch(`/api/apps/${currentApp}/env/defaults`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json();
    document.getElementById('envOut').textContent = JSON.stringify(r, null, 2);
    const changed = [...(r.added || []), ...(r.updated || [])];
    toast(r.ok ? (changed.length ? ('defaults loaded: ' + changed.join(', ') + ' - redeploy to apply') : 'defaults already correct') : (r.error || 'failed'), !!r.ok);
    loadEnv(); refresh(); loadServices();
  } catch (e) { document.getElementById('envOut').textContent = 'failed: ' + e.message; }
}
async function genToken() {
  const format = document.getElementById('tokFormat').value;
  const bytes = parseInt(document.getElementById('tokLen').value, 10) || 32;
  const out = document.getElementById('tokOut');
  out.value = 'generating…';
  try {
    const r = await (await fetch('/api/tools/token', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ format, bytes }) })).json();
    if (!r.ok && !r.value) { toast(r.error || 'generate failed', false); out.value = ''; return; }
    out.value = r.value;
  } catch (e) { out.value = ''; toast('generate failed: ' + e.message, false); }
}
async function copyToken() {
  const el = document.getElementById('tokOut');
  const v = el.value;
  if (!v) { toast('generate a secret first', false); return; }
  if (await copyText(v)) { toast('secret copied - paste it somewhere safe'); return; }
  el.focus();
  el.select();
  toast('copy failed - value selected, press Ctrl+C', false);
}
function tokenToNew() {
  const v = document.getElementById('tokOut').value;
  if (!v) { toast('generate a secret first', false); return; }
  document.getElementById('envVal').value = v;
  document.getElementById('envKey').focus();
  toast('secret placed in the new-variable value field');
}
async function genEnvRow(btn) {
  const input = btn.closest('.env-row').querySelector('.env-value');
  if (!input) return;
  const format = document.getElementById('tokFormat').value;
  const bytes = parseInt(document.getElementById('tokLen').value, 10) || 32;
  btn.disabled = true;
  try {
    const r = await (await fetch('/api/tools/token', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ format, bytes }) })).json();
    if (!r.ok && !r.value) { toast(r.error || 'generate failed', false); return; }
    input.value = r.value;
    input.type = 'text';
    toast('fresh secret filled - save changes to apply');
  } catch (e) { toast('generate failed: ' + e.message, false); }
  finally { btn.disabled = false; }
}
async function envDownload(example) {
  if (!currentApp) return;
  const r = await (await fetch(`/api/apps/${currentApp}/env`)).json();
  if (r.error) { toast(r.error, false); return; }
  const text = example
    ? '# copy to .env and fill in - generated for redeploy elsewhere\n' + (r.vars || []).map(v => `${v.key}=`).join('\n') + '\n'
    : (r.vars || []).map(v => `${v.key}=${v.value}`).join('\n') + '\n';
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
  a.download = currentApp + (example ? '.env.example' : '.env');
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
async function envAdd() {
  if (!currentApp) return;
  const k = document.getElementById('envKey').value.trim();
  const v = document.getElementById('envVal').value;
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) { toast('enter a valid environment key', false); return; }
  try {
    const r = await (await fetch(`/api/apps/${currentApp}/env`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ set: { [k]: v } }) })).json();
    document.getElementById('envOut').textContent = JSON.stringify(r, null, 2);
    if (!r.ok) { toast(r.error || 'add failed', false); return; }
    if ((r.skipped || []).includes(k)) { toast(`${k} is managed and cannot be replaced`, false); return; }
    document.getElementById('envKey').value = '';
    document.getElementById('envVal').value = '';
    toast(`${k} added - redeploy to apply`);
    loadEnv(); refresh(); loadServices();
  } catch (e) { toast('add failed: ' + e.message, false); }
}
async function envDel(key) {
  if (!currentApp) return;
  const ok = await uiConfirm({ title: 'Delete ' + key + '?', body: 'Remove it from ' + currentApp + '. Redeploy afterward to apply.', confirmLabel: 'Delete', danger: true });
  if (!ok) return;
  const r = await (await fetch(`/api/apps/${currentApp}/env`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ delete: [key] }) })).json();
  document.getElementById('envOut').textContent = JSON.stringify(r, null, 2);
  loadEnv();
}
async function addDb() {
  if (!currentApp) return;
  const type = document.getElementById('dbAdd').value;
  document.getElementById('dbOut').textContent = 'adding ' + type + '… (redeploy to apply)';
  try {
    const r = await (await fetch(`/api/apps/${currentApp}/db`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type }) })).json();
    document.getElementById('dbOut').textContent = JSON.stringify(r, null, 2);
    refresh(); loadServices(); loadDatabases();
  } catch (e) { document.getElementById('dbOut').textContent = 'failed: ' + e.message; }
}