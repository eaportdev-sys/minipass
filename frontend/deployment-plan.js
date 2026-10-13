let deploymentPlanSeq = 0;
let deploymentPlanChoices = [];
let deploymentPlanApp = null;
function deploymentPlanMarkup(plan) {
  const h = safeHtml;
  const blockers = (plan.blockers || []).map(b => `<li><b>${h(b.code)}</b>${b.file ? ` · ${h(b.file)}` : ''}<div>${h(b.message)}</div></li>`).join('');
  const scan = plan.scan || {};
  const selection = plan.selection || plan.selected;
  const choices = (plan.candidates || []).map((c, i) => `<option value="${i}"${selection && selection.kind === c.kind && selection.file === c.file && JSON.stringify(selection.files || []) === JSON.stringify(c.files || []) ? ' selected' : ''}>${h(c.kind)} · ${h((c.files || [c.file]).join(' + '))}${c.profiles && c.profiles.length ? ' · profiles ' + h(c.profiles.join(', ')) : ''}${c.complete ? '' : ' (incomplete)'}</option>`).join('');
  const entry = plan.selected ? `${h(plan.selected.kind)} · <code>${h((plan.selected.files || [plan.selected.file]).join(' + '))}</code>` : 'No single deployment entrypoint selected';
  const services = plan.topology ? plan.topology.services : plan.services || [];
  const rows = services.map(s => plan.topology
    ? `<li><b>${h(s.name)}</b>${s.oneShot ? ' · required one-shot task' : ''}${s.image ? ` · image ${h(s.image)}` : ''}<div>${s.build ? `Build context: ${h(s.build.context)} · file: ${h(s.build.dockerfile || 'Dockerfile')}${s.build.target ? ` · target: ${h(s.build.target)}` : ''}` : 'Image service'}</div>${s.command ? `<div>Command: <code>${h(s.command)}</code></div>` : ''}${s.entrypoint ? `<div>Entrypoint: <code>${h(s.entrypoint)}</code></div>` : ''}<div>Dependencies: ${h(Object.entries(s.dependencyConditions || {}).map(([name, condition]) => name + ' (' + condition + ')').join(', ') || (s.dependsOn || []).join(', ') || 'none')}</div><div>Environment: ${h((s.env || []).map(e => e.key + (e.derived ? ' ← ' + e.refs.join(', ') : '')).join(', ') || 'none')} · Healthcheck: ${s.healthcheck ? 'declared' : 'not declared'}</div></li>`
    : `<li><b>${h(s.name)}</b> · ${h(s.type)} · ${h(s.folder)}<div>Build file: ${h(s.recipe || 'not prepared')}${s.generated ? ' (panel-provided build environment)' : ''}</div><div>Published port: ${h(s.hostPort || 'not published')} → ${h(s.port || 'not configured')}</div></li>`).join('');
  const manifests = (plan.manifests || []).map(m => `<li><b>${h(m.file)}</b> · ${h(m.manager)}${m.commands.length ? '<ul>' + m.commands.map(c => `<li>${h(c.name)}: <code>${h(c.command)}</code></li>`).join('') + '</ul>' : ''}</li>`).join('');
  const evidence = (plan.evidence || []).map(e => `<li>${h(e.source)} → ${h(e.files.join(', ') || 'unresolved reference')}${e.documentation ? ' (documentation; not executed)' : ''}</li>`).join('');
  const exclusions = [...(scan.issues || []), ...(scan.skipped || [])].map(e => `<li>${h(e.file)} — ${h(e.reason)}</li>`).join('');
  const provisioning=(plan.provisioning||[]).map(a=>`<li><b>${h(a.key)}</b> · ${h(a.service)} — ${h(a.reason)}</li>`).join('');
  const report = plan.verification;
  const local=plan.localUrl?`<div class="meta"><b>Allocated local address:</b> <a href="${h(plan.localUrl)}" target="_blank" rel="noopener">${h(plan.localUrl)}</a>${plan.localUrl.startsWith('https:')?`<br>Local HTTPS needs no public domain. ${plan.localCaReady?`<a href="/api/apps/${encodeURIComponent(currentApp)}/local-ca">Download this site's CA certificate</a> and trust it on your device to avoid certificate warnings.`:'Deploy first to generate the downloadable CA certificate, then trust it on your device.'} CSP and secure cookies stay enabled.`:''}</div>`:'';
  const checks = report ? `<details open><summary>Last browser/API verification — ${report.ok ? 'passed' : 'failed'}</summary><div class="meta">${h(report.at || '')}</div><ul>${(report.errors || []).map(e => `<li class="field-error">${h(e)}</li>`).join('')}${(report.pages || []).map(p => `<li><b>${h(p.service)}</b> · ${h(p.url)} · ${h(p.status || '')} · ${p.ok ? 'passed' : 'failed'} · ${(p.assets || []).length} asset requests${p.screenshotIndex !== undefined ? ` · <a href="/api/apps/${encodeURIComponent(currentApp)}/verification/screenshot/${p.screenshotIndex}" target="_blank" rel="noopener">browser screenshot</a>` : ''}</li>`).join('')}${(report.probes || []).map(p => `<li><b>${h(p.service)}</b> internal API: ${p.ok ? 'passed' : 'failed'}</li>`).join('')}</ul></details>` : '<div class="meta">No application verification has run yet. A release is successful only after runtime, task, browser/asset and API checks pass.</div>';
  return `<div class="plan-state ${plan.ready ? 'plan-ready' : 'field-error'}"><b>${plan.ready ? 'Source plan checks passed' : 'Deployment blocked'}</b></div><div class="meta">${scan.files || 0} source files inventoried · ${scan.textFiles || 0} text files inspected · ${scan.complete ? 'scan complete within disclosed exclusions' : 'scan incomplete'}</div>` +
    `<p>${entry}<br><span class="meta">${h(plan.reason || 'Review the choices below.')}${plan.resolved ? ' · Compose-resolved combined model' : ''}</span></p>` +
    (choices ? `<div class="controlrow"><select id="deploymentEntrypoint" aria-label="Deployment entrypoint">${choices}</select><button onclick="saveDeploymentEntrypoint()">save selection</button><button onclick="saveDeploymentEntrypoint(true)">automatic selection</button></div>` : '') +
    (blockers ? `<ul class="plan-blockers">${blockers}</ul>` : '<p class="meta">This is source analysis, not proof that the website works. Deploy manually and verify the application.</p>') +
    (rows ? `<details open><summary>${plan.topology ? 'Repository-declared services and tasks' : 'Configured service execution'}</summary><ul>${rows}</ul></details>` : '') +
    (plan.topology && plan.topology.envNeeds.length ? `<p>Compose inputs: ${h(plan.topology.envNeeds.map(e => e.key + (e.required ? ' (required)' : '')).join(', '))}. Literal environment values are not displayed.</p>` : '') +
    (manifests ? `<details><summary>Manifest build/launch instructions</summary><ul>${manifests}</ul></details>` : '') +
    (evidence ? `<details><summary>Entrypoint references</summary><ul>${evidence}</ul></details>` : '') +
    (exclusions ? `<details><summary>Excluded or unreadable files</summary><ul>${exclusions}</ul></details>` : '') +
    (provisioning?`<details open><summary>Prepared repository inputs (values kept private)</summary><ul>${provisioning}</ul></details>`:'')+local+checks;
}
async function prepareComposeInputs() {
  const id=currentApp;
  if(!id)return;
  try {
    const r=await(await fetch(`/api/apps/${id}/compose-inputs`,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).json();
    if(currentApp!==id)return;
    toast(r.ok?(r.issues&&r.issues.length?r.issues.map(i=>i.message).join(' '):r.changed&&r.changed.length?'Repository inputs prepared: '+r.changed.join(', ')+' — deploy manually.':'Repository inputs checked; saved values preserved.'):(r.error||'input preparation failed'),!!r.ok&&!(r.issues&&r.issues.length));
    loadEnv();loadDeploymentPlan();
  }catch(e){if(currentApp===id)toast('Input preparation failed: '+e.message,false);}
}
async function loadDeploymentPlan() {
  const id = currentApp;
  if (!id) return;
  const seq = ++deploymentPlanSeq;
  const box = document.getElementById('deploymentPlan');
  if (deploymentPlanApp !== id) { box.textContent = 'Reading source instructions…'; deploymentPlanChoices = []; deploymentPlanApp = id; }
  try {
    const response = await fetch(`/api/apps/${id}/deployment-plan`);
    const plan = await response.json();
    if (seq !== deploymentPlanSeq || currentApp !== id) return;
    if (!response.ok || plan.error) throw new Error(plan.error || 'analysis failed');
    deploymentPlanChoices = plan.candidates || [];
    const url = document.getElementById('verificationUrl');
    if (document.activeElement !== url) url.value = plan.publicUrl || '';
    renderDeployMarkup(box, deploymentPlanMarkup(plan));
  } catch (e) {
    if (seq !== deploymentPlanSeq || currentApp !== id) return;
    deploymentPlanChoices = [];
    box.textContent = 'Deployment plan unavailable: ' + e.message + '. Deployment still revalidates source before building.';
  }
}
async function saveVerificationUrl(local = false, scheme = null) {
  if (!currentApp) return;
  const id = currentApp;
  try {
    const r = await (await fetch(`/api/apps/${id}/verification`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(local?{access:'local',...(scheme?{scheme}:{})}:{ url: document.getElementById('verificationUrl').value.trim() }) })).json();
    if (currentApp !== id) return;
    toast(r.ok ? r.provisioningError ? 'Address saved; input preparation needs review: '+r.provisioningError : r.accessMode==='local'?'Local address configured — redeploy to apply. No public domain needed.':'Public URL saved — deployment will verify this route in Chromium.' : (r.error || 'save failed'), !!r.ok&&!r.provisioningError);
    loadDeploymentPlan();loadEnv();
  } catch (e) { toast(e.message, false); }
}
async function saveDeploymentEntrypoint(automatic = false) {
  const id = currentApp;
  if (!id || deploymentPlanApp !== id) return;
  const select = document.getElementById('deploymentEntrypoint');
  const selection = automatic ? null : deploymentPlanChoices[Number(select && select.value)];
  if (!automatic && !selection) return;
  try {
    const r = await (await fetch(`/api/apps/${id}/deployment-plan`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ selection: selection ? { kind: selection.kind, file: selection.file, ...(selection.files ? { files: selection.files, profiles: selection.profiles || [] } : {}) } : null }) })).json();
    if (currentApp !== id) return;
    toast(r.ok ? 'Deployment entrypoint saved — review the plan, then deploy manually.' : (r.error || 'selection failed'), !!r.ok);
    await refreshSiteData(id);
  } catch (e) { if (currentApp === id) toast('selection failed: ' + e.message, false); }
}
