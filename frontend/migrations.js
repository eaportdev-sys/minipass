async function saveMigrate() {
  if (!currentApp) return;
  const body = {
    command: document.getElementById('migrateCmd').value,
    service: document.getElementById('migrateSvc').value,
    dir: document.getElementById('migrateDir').value,
    check: document.getElementById('migrateCheck').value
  };
  const r = await (await fetch(`/api/apps/${currentApp}/migrate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();
  toast(r.ok ? (body.command.trim() ? 'migration saved — it runs automatically before every deploy' : 'automatic pre-deploy migration disabled') : (r.error || 'failed'), !!r.ok);
  loadDeployStatus();
}
function fillMigrate(cmd, dir, svc, check) {
  document.getElementById('migrateCmd').value = cmd || '';
  if (dir !== undefined) document.getElementById('migrateDir').value = dir || '';
  if (svc) {
    const sel = document.getElementById('migrateSvc');
    if ([...sel.options].some(o => o.value === svc)) sel.value = svc;
  }
  if (check !== undefined) document.getElementById('migrateCheck').value = check || '';
}
function useMigrateDetection(button) {
  fillMigrate(button.dataset.command, button.dataset.dir, button.dataset.service, button.dataset.check);
  const where = button.dataset.dir ? `/${button.dataset.dir}` : 'service root';
  const message = button.dataset.phase === 'initial'
    ? `Initial-setup command selected in ${button.dataset.service} · ${where}. Run it manually; do not save it as a recurring pre-deploy migration unless the project guarantees that is safe.`
    : `Detected runner selected in ${button.dataset.service} · ${where}. Review the command, then save or run it.`;
  document.getElementById('migrateOut').textContent = message + (button.dataset.warning ? `\n\nConfiguration warning: ${button.dataset.warning}` : '');
}
function runMigrateSuggestion(btn) {
  const box = btn.closest('.migrate-detect-wrap');
  const src = box && box.querySelector('.migrate-detect');
  if (!src) return;
  useMigrateDetection(src);
  runMigrateNow();
}
async function runMigrateNow() {
  if (!currentApp) return;
  const out = document.getElementById('migrateOut');
  out.textContent = 'running migration…';
  const body = {
    command: document.getElementById('migrateCmd').value,
    service: document.getElementById('migrateSvc').value,
    dir: document.getElementById('migrateDir').value
  };
  try {
    const r = await (await fetch(`/api/apps/${currentApp}/migrate-run`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();
    out.textContent = r.ok ? `ok in ${r.service}:\n${r.output}` : ('failed: ' + (r.error || 'unknown'));
  } catch (e) { out.textContent = 'run failed: ' + e.message; }
}
async function verifyMigrate() {
  if (!currentApp) return;
  const out = document.getElementById('migrateOut');
  out.textContent = 'verifying…';
  const body = {
    check: document.getElementById('migrateCheck').value,
    service: document.getElementById('migrateSvc').value,
    dir: document.getElementById('migrateDir').value
  };
  try {
    const r = await (await fetch(`/api/apps/${currentApp}/migrate-check`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();
    out.textContent = r.ok ? `ok in ${r.service}:\n${r.output}` : ('failed: ' + (r.error || 'unknown'));
  } catch (e) { out.textContent = 'verify failed: ' + e.message; }
}
function fillMigrateServiceOptions(services, saved) {
  const sel = document.getElementById('migrateSvc');
  if (!sel) return;
  const prev = sel.value || saved || 'app';
  sel.innerHTML = (services || []).map(s => `<option value="${safeHtml(s.name)}">${safeHtml(s.name)}${s.subdir ? ` (/${safeHtml(s.subdir)})` : ''}</option>`).join('')
    || '<option value="app">app</option>';
  sel.value = [...sel.options].some(o => o.value === prev) ? prev : (sel.options[0] ? sel.options[0].value : 'app');
  if (saved && [...sel.options].some(o => o.value === saved)) sel.value = saved;
}
async function loadMigrateSuggest() {
  if (!currentApp) return;
  const appId = currentApp;
  const box = document.getElementById('migrateSuggest');
  try {
    const r = await (await fetch(`/api/apps/${appId}/migrate-suggest`)).json();
    if (currentApp !== appId) return;
    const list = r.suggestions || [];
    box.innerHTML = list.length ? `<div class="migrate-suggest-label">Detected migration runners</div><div class="migrate-suggest-list">${list.map(s => {
      const location = s.runnable
        ? `${s.service} · ${s.dir ? `/${s.dir}` : 'service root'}`
        : `${s.repoDir || 'repository'} · not runnable yet`;
      const phase = s.phase === 'initial' ? 'initial setup' : 'deployment';
      if (!s.runnable) return `<div class="migrate-detect unavailable"><div><b>${safeHtml(s.framework || 'Migration')}</b><span>${safeHtml(phase)}</span></div><small>${safeHtml(s.problem || s.why || 'Needs configuration')}</small><em>${safeHtml(location)}</em></div>`;
      return `<div class="migrate-detect-wrap"><button class="migrate-detect${s.warning ? ' has-warning' : ''}" data-command="${safeHtml(s.command || s.cmd)}" data-dir="${safeHtml(s.dir || '')}" data-service="${safeHtml(s.service || s.svc || '')}" data-check="${safeHtml(s.check || '')}" data-phase="${safeHtml(s.phase || 'deploy')}" data-warning="${safeHtml(s.warning || '')}" onclick="useMigrateDetection(this)" title="${safeHtml(s.why || '')}"><div><b>${safeHtml(s.framework || 'Migration')}</b><span>${safeHtml(phase)}</span></div><code>${safeHtml(s.command || s.cmd)}</code>${s.warning ? `<small>${safeHtml(s.warning)}</small>` : ''}<em>${safeHtml(location)}</em></button><button class="btn primary" onclick="runMigrateSuggestion(this)">run now</button></div>`;
    }).join('')}</div>` : '<div class="migrate-suggest-label">No migration runner detected — enter the service, folder, and project command manually.</div>';
  } catch { if (currentApp === appId) box.innerHTML = ''; }
}