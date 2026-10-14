let deploymentPlanSeq = 0;
let deploymentPlanChoices = [];
let deploymentPlanApp = null;
function deploymentPlanMarkup(plan) {
  const h = safeHtml;
  const local = plan.accessMode === 'local';
  const url = local ? plan.localUrl : plan.publicUrl;
  const source = plan.selected ? (plan.selected.files || [plan.selected.file]).join(' + ') : 'Detected services';
  const services = plan.topology ? plan.topology.services : plan.services || [];
  const rows = services.map(s => `<li><b>${h(s.name)}</b>${s.oneShot ? ' · repository task' : ''} · ${h(s.image || s.type || '')}${s.build ? ` · ${h(s.build.context)} / ${h(s.build.dockerfile || 'Dockerfile')}` : s.folder ? ` · ${h(s.folder)}` : ''}${s.command ? `<div>Command: <code>${h(s.command)}</code></div>` : ''}</li>`).join('');
  const notes = [...(plan.warnings || []), ...(plan.blockers || [])].map(n => `<li>${h(n.message)}</li>`).join('');
  return `<div class="deployment-summary"><div class="deployment-summary-row"><span>Source</span><b>${h(source)}</b></div>` +
    `<div class="deployment-summary-row"><span>Access</span><b>${local ? 'Local / LAN' : 'Custom domain'}</b>${url ? `<a href="${h(url)}" target="_blank" rel="noopener">${h(url)}</a>` : ''}</div>` +
    `<div class="meta">Detection helps configure the launch; it does not approve or block deployment. A running container is not proof that every application feature works.</div>` +
    (local && url?.startsWith('https:') && plan.localCaReady ? `<a href="/api/apps/${encodeURIComponent(currentApp)}/local-ca">Trust certificate</a>` : '') +
    `</div><details class="deployment-advanced" data-record="deployment-details"><summary>Detected services and notes</summary><div class="meta">${h(plan.reason || '')}</div>${rows ? `<ul>${rows}</ul>` : ''}${notes ? `<ul>${notes}</ul>` : ''}</details>`;
}
function deploymentSourceMarkup(plan) {
  const selected = plan.selection || plan.selected;
  const candidates = plan.candidates || [];
  return candidates.length ? `<label>Deployment file<select id="deploymentEntrypoint">${candidates.map((c, i) => `<option value="${i}"${selected && selected.file === c.file && JSON.stringify(selected.files || []) === JSON.stringify(c.files || []) && JSON.stringify(selected.profiles || []) === JSON.stringify(c.profiles || []) ? ' selected' : ''}>${safeHtml((c.files || [c.file]).join(' + '))}</option>`).join('')}</select></label><button onclick="saveDeploymentEntrypoint()">save source change</button><button onclick="saveDeploymentEntrypoint(true)">auto-detect</button>` : '<div class="meta">Using detected service build files.</div>';
}
async function prepareComposeInputs() {
  const id = currentApp;
  if (!id) return;
  try {
    const r = await (await fetch(`/api/apps/${id}/compose-inputs`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json();
    if (currentApp !== id) return;
    toast(r.ok ? (r.issues || []).map(i => i.message).join(' ') || 'Repository settings prepared; saved values preserved.' : r.error || 'Preparation failed', !!r.ok && !(r.issues || []).length);
    loadEnv(); loadDeploymentPlan();
  } catch (e) { if (currentApp === id) toast(e.message, false); }
}
async function loadDeploymentPlan() {
  const id = currentApp;
  if (!id) return;
  const seq = ++deploymentPlanSeq;
  const box = document.getElementById('deploymentPlan');
  if (deploymentPlanApp !== id) { box.textContent = 'Reading repository configuration…'; deploymentPlanChoices = []; deploymentPlanApp = id; }
  try {
    const response = await fetch(`/api/apps/${id}/deployment-plan`);
    const plan = await response.json();
    if (seq !== deploymentPlanSeq || currentApp !== id) return;
    if (!response.ok || plan.error) throw new Error(plan.error || 'Detection unavailable');
    deploymentPlanChoices = plan.candidates || [];
    const url = document.getElementById('siteAccessUrl');
    if (document.activeElement !== url) url.value = plan.publicUrl || '';
    renderDeployMarkup(document.getElementById('deploymentFileSetup'), deploymentSourceMarkup(plan));
    document.getElementById('deployLocalChoices').style.display = plan.accessMode === 'local' ? 'none' : '';
    renderDeployMarkup(box, deploymentPlanMarkup(plan));
  } catch (e) {
    if (seq !== deploymentPlanSeq || currentApp !== id) return;
    deploymentPlanChoices = [];
    box.textContent = 'Repository details unavailable: ' + e.message + '. You can still deploy.';
  }
}
async function saveSiteAccess(local = false, scheme = null) {
  const id = currentApp;
  if (!id) return;
  try {
    const body = local ? { access: 'local', ...(scheme ? { scheme } : {}) } : { url: document.getElementById('siteAccessUrl').value.trim() };
    const r = await (await fetch(`/api/apps/${id}/access`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();
    if (currentApp !== id) return;
    toast(r.ok ? 'Address saved — redeploy to apply.' : r.error || 'Save failed', !!r.ok);
    loadDeploymentPlan(); loadEnv();
  } catch (e) { if (currentApp === id) toast(e.message, false); }
}
async function saveDeploymentEntrypoint(automatic = false) {
  const id = currentApp;
  if (!id || deploymentPlanApp !== id) return;
  const choice = deploymentPlanChoices[Number(document.getElementById('deploymentEntrypoint').value)];
  if (!automatic && !choice) return;
  const selection = automatic ? null : { kind: choice.kind, file: choice.file, ...(choice.files ? { files: choice.files, profiles: choice.profiles || [] } : {}) };
  try {
    const r = await (await fetch(`/api/apps/${id}/deployment-plan`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ selection }) })).json();
    if (currentApp !== id) return;
    toast(r.ok ? 'Source setting saved — redeploy to apply.' : r.error || 'Save failed', !!r.ok);
    await refreshSiteData(id);
  } catch (e) { if (currentApp === id) toast(e.message, false); }
}
