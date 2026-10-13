let deploymentPlanSeq = 0;
let deploymentPlanChoices = [];
let deploymentPlanApp = null;
function deploymentPlanDetails(plan) {
  const h = safeHtml;
  const blockers = (plan.blockers || []).map(b => `<li><b>${h(b.code)}</b>${b.file ? ` · ${h(b.file)}` : ''}<div>${h(b.message)}</div></li>`).join('');
  const scan = plan.scan || {};
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
  const checks = report ? `<details open><summary>Last browser/API verification — ${report.ok ? 'passed' : 'failed'}</summary><div class="meta">${h(report.at || '')}</div><ul>${(report.errors || []).map(e => `<li class="field-error">${h(e)}</li>`).join('')}${(report.pages || []).map(p => `<li><b>${h(p.service)}</b> · ${h(p.url)} · ${h(p.status || '')} · ${p.ok ? 'passed' : 'failed'} · ${(p.assets || []).length} asset requests${p.screenshotIndex !== undefined ? ` · <a href="/api/apps/${encodeURIComponent(currentApp)}/verification/screenshot/${p.screenshotIndex}" target="_blank" rel="noopener">browser screenshot</a>` : ''}</li>`).join('')}${(report.probes || []).map(p => `<li><b>${h(p.service)}</b> internal API: ${p.ok ? 'passed' : 'failed'}</li>`).join('')}</ul></details>` : '<div class="meta">No application verification has run yet. A release is successful only after runtime, task, browser/asset and API checks pass.</div>';
  return `<div class="plan-state ${plan.ready ? 'plan-ready' : 'field-error'}"><b>${plan.ready ? 'Source plan checks passed' : 'Deployment blocked'}</b></div><div class="meta">${scan.files || 0} source files inventoried · ${scan.textFiles || 0} text files inspected · ${scan.complete ? 'scan complete within disclosed exclusions' : 'scan incomplete'}</div>` +
    `<p>${entry}<br><span class="meta">${h(plan.reason || 'Review the choices below.')}${plan.resolved ? ' · Compose-resolved combined model' : ''}</span></p>` +
    (blockers ? `<ul class="plan-blockers">${blockers}</ul>` : '<p class="meta">This is source analysis, not proof that the website works. Deploy manually and verify the application.</p>') +
    (rows ? `<details><summary>${plan.topology ? 'Repository-declared services and tasks' : 'Configured service execution'}</summary><ul>${rows}</ul></details>` : '') +
    (plan.topology && plan.topology.envNeeds.length ? `<p>Compose inputs: ${h(plan.topology.envNeeds.map(e => e.key + (e.required ? ' (required)' : '')).join(', '))}. Literal environment values are not displayed.</p>` : '') +
    (manifests ? `<details><summary>Manifest build/launch instructions</summary><ul>${manifests}</ul></details>` : '') +
    (evidence ? `<details><summary>Entrypoint references</summary><ul>${evidence}</ul></details>` : '') +
    (exclusions ? `<details><summary>Excluded or unreadable files</summary><ul>${exclusions}</ul></details>` : '') +
    (provisioning?`<details><summary>Prepared repository inputs (values kept private)</summary><ul>${provisioning}</ul></details>`:'')+checks;
}
function deploymentPlanMarkup(plan) {
  const h=safeHtml,local=plan.accessMode==='local',url=local?plan.localUrl:plan.publicUrl;
  const labels={postgres:'PostgreSQL',mysql:'MySQL',mariadb:'MariaDB',mongo:'MongoDB',redis:'Redis'};
  const databases=[...new Set((plan.repositoryDatabases||[]).map(d=>labels[d.type]||d.type))];
  const issues=(plan.blockers||[]).filter(b=>b.code!=='REQUIRED_ENV');
  const required=(plan.blockers||[]).filter(b=>b.code==='REQUIRED_ENV');
  const status=issues.length?'Needs attention':required.length?'Settings pending':'Ready to deploy';
  return `<div class="deployment-summary"><div class="plan-state ${issues.length?'field-error':'plan-ready'}"><b>${status}</b></div>`+
    `<div class="deployment-summary-row"><span>Access</span><b>${local?'Local / LAN':'Custom domain'}</b>${url?`<a href="${h(url)}" target="_blank" rel="noopener">${h(url)}</a>`:''}</div>`+
    `<div class="deployment-summary-row"><span>Source</span><b>${h(plan.selected?(plan.selected.files||[plan.selected.file]).join(' + '):'Complete source setup')}</b></div>`+
    `<div class="deployment-summary-row"><span>Databases</span><b>${h(databases.join(' + ')||'None declared')}</b>${databases.length?'<small>Initialized on first deploy</small>':''}</div>`+
    (issues.length?`<div class="field-error">${h(issues[0].message)}</div><button onclick="showSiteTab('setup')">review source setup</button>`:'')+
    (required.length?'<div class="meta">Deployment prepares database and local settings before building. Retained data and saved values are preserved.</div>':'')+
    (local&&url?.startsWith('https:')?`<div class="meta">This repository uses local HTTPS.${plan.localCaReady?` <a href="/api/apps/${encodeURIComponent(currentApp)}/local-ca">Trust certificate</a>`:''}</div>`:'')+
    `<div class="meta">Last check: ${plan.verification?plan.verification.pending?'waiting':plan.verification.ok?'passed':'failed':'not deployed yet'}</div></div>`+
    `<details class="deployment-advanced" data-record="deployment-details"><summary>Technical details</summary>${deploymentPlanDetails(plan)}</details>`;
}
function deploymentSourceMarkup(plan) {
  const selected=plan.selection||plan.selected;
  const compose=(plan.candidates||[]).filter(c=>c.kind==='compose');
  const candidates=compose.length?compose:plan.candidates||[];
  return candidates.length?`<label>Deployment file<select id="deploymentEntrypoint">${candidates.map(c=>`<option value="${(plan.candidates||[]).indexOf(c)}"${selected&&selected.file===c.file&&JSON.stringify(selected.files||[])===JSON.stringify(c.files||[])&&JSON.stringify(selected.profiles||[])===JSON.stringify(c.profiles||[])?' selected':''}>${safeHtml((c.files||[c.file]).join(' + '))}</option>`).join('')}</select></label><button onclick="saveDeploymentEntrypoint()">save source change</button>`:'<div class="meta">No alternate deployment file.</div>';
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
    const setup=document.getElementById('deploymentFileSetup');if(setup)renderDeployMarkup(setup,deploymentSourceMarkup(plan));
    const localChoices=document.getElementById('deployLocalChoices');if(localChoices)localChoices.style.display=plan.accessMode==='local'?'none':'';
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
