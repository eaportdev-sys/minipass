let createSourcePlan=null;
let createSourceKey='';
let createSourceSeq=0;
let createSourceInFlight=null;
let createSourceChoices=[];
function createSourceBody() {
  const v=id=>document.getElementById(id).value.trim();
  const access=document.querySelector('input[name=access]:checked')?.value || 'local';
  const repo=document.getElementById('ghrepo').value;
  return {name:v('name')||'Repository preview',type:document.querySelector('input[name=apptype]:checked')?.value||'static',
    repoUrl:v('repo'),branch:v('branch'),subdir:v('subdir'),access,domain:access==='domain'?v('domain'):'',storageGB:v('createStorageGB')||'5',
    ...(repo?{ghRepo:{repo}}:{}),...(v('ghModalToken')?{gitToken:v('ghModalToken')}:{}),prepareOnly:true};
}
function createSourceIdentity(body=createSourceBody()) { return JSON.stringify([body.repoUrl,body.ghRepo?.repo||'',body.branch||'',body.subdir||'',body.gitToken||'']); }
function createSourceSelection() {
  const index=Number(document.getElementById('createEntrypoint').value);
  return Number.isInteger(index)&&index>=0?createSourceChoices[index]||null:null;
}
function createSourceNeedsChoice() { return !!createSourcePlan&&(createSourceChoices.length>0&&!createSourceSelection()||(createSourcePlan.blockers||[]).some(b=>['STALE_SELECTION','TOPOLOGY_NOT_FOLLOWED','INVALID_COMPOSE','INCOMPLETE_SCAN','MISSING_COMPOSE_REFERENCE'].includes(b.code))); }
function resetCreateSource() {
  createSourceSeq++;createSourcePlan=null;createSourceKey='';createSourceChoices=[];
  document.getElementById('createDeployment').style.display='none';
  document.getElementById('createEntrypoint').innerHTML='';
  document.getElementById('createSourceState').textContent='';
  document.getElementById('createDeclaredServices').textContent='';
  document.getElementById('createGeneratedData').style.display='';
}
async function discardCreateDraft(id) {
  if(!id)return;
  const r=await(await fetch(`/api/apps/pending/${encodeURIComponent(id)}`,{method:'DELETE',keepalive:true})).json();
  if(!r.ok)throw new Error(r.error||'Unfinished source cleanup failed');
}
function showCreateSource(plan) {
  createSourcePlan=plan;
  const candidates=plan.candidates || [];
  const compose=candidates.filter(c=>c.kind==='compose');
  createSourceChoices=compose.length?compose:candidates.filter(c=>c.kind==='dockerfile'&&!c.generated);
  const selected=plan.selected;
  const index=selected?createSourceChoices.findIndex(c=>c.kind===selected.kind&&c.file===selected.file&&JSON.stringify(c.files||[])===JSON.stringify(selected.files||[])&&JSON.stringify(c.profiles||[])===JSON.stringify(selected.profiles||[])):-1;
  document.getElementById('createDeployment').style.display='';
  const picker=document.getElementById('createEntrypoint');
  picker.innerHTML='<option value="-1">Choose deployment file…</option>'+createSourceChoices.map((c,i)=>`<option value="${i}">${safeHtml((c.files||[c.file]).join(' + '))}${c.profiles?.length?' · '+safeHtml(c.profiles.join(', ')):''}</option>`).join('');
  picker.value=String(index);picker.parentElement.style.display=createSourceChoices.length?'':'none';
  const issue=(plan.blockers||[]).find(b=>b.code!=='REQUIRED_ENV'&&b.code!=='ENTRYPOINT_CHOICE');
  document.getElementById('createSourceState').textContent=issue?issue.message:index<0&&createSourceChoices.length?'Several deployment files were found. Choose the intended one before creating.':'Repository inspected. This choice is saved with the site.';
  document.getElementById('createGeneratedData').style.display=compose.length?'none':'';
  const roots=plan.topology?.services || [];
  const dbs=plan.repositoryDatabases||[],labels={postgres:'PostgreSQL',mysql:'MySQL',mariadb:'MariaDB',mongo:'MongoDB',redis:'Redis'};
  const apps=roots.filter(s=>!s.oneShot&&!dbs.some(d=>d.service===s.name));
  document.getElementById('createDeclaredServices').textContent=compose.length?roots.length?`${apps.length} application service${apps.length===1?'':'s'} · ${dbs.map(d=>labels[d.type]||d.type).join(' + ')||'no database'}${roots.some(s=>s.oneShot)?' · automatic migrations':''}`:'Select a file to see its services and databases.':'';
  if(compose.length)document.getElementById('createDetectState').textContent='The deployment file defines the runtime and databases.';
  createEntrypointChanged(false);
}
function createEntrypointChanged(recheck=true) {
  const selection=createSourceSelection();
  if(recheck&&selection&&createPendingId)return prepareCreateSource({...createSourceBody(),deploymentEntrypoint:selection});
  document.getElementById('createBuildBtn').disabled=createBusyOps>0||createSourceNeedsChoice();
}
async function prepareCreateSource(body=createSourceBody()) {
  const session=createModalSession,seq=++createSourceSeq,key=createSourceIdentity(body);
  const previous=createSourceInFlight;
  const cleanup=createCleanupPromise;
  if(!body.deploymentEntrypoint&&key===createSourceKey&&createSourceSelection())body.deploymentEntrypoint=createSourceSelection();
  setBuildBusy(true);
  document.getElementById('createDeployment').style.display='';
  document.getElementById('createSourceState').textContent='Inspecting the checkout…';
  const operation=(async()=>{
    try {
      if(previous)await previous.catch(()=>{});
      await cleanup.catch(()=>{});
      if(session!==createModalSession||seq!==createSourceSeq)return false;
      if(createPendingId&&createSourceKey&&createSourceKey!==key){await discardCreateDraft(createPendingId);createPendingId=null;}
      if(!body.repoUrl&&!body.ghRepo?.repo){if(createPendingId){await discardCreateDraft(createPendingId);createPendingId=null;}resetCreateSource();return true;}
      const payload={...body,prepareOnly:true};delete payload.pendingId;if(createPendingId)payload.pendingId=createPendingId;
      const r=await(await fetch('/api/apps',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)})).json();
      if(session!==createModalSession||seq!==createSourceSeq){if(r.pendingId)await discardCreateDraft(r.pendingId);return false;}
      if(r.pendingId){createPendingId=r.pendingId;createSourceKey=key;}
      if(!r.prepared||!r.plan)throw new Error(r.error||'Source inspection failed');
      createSourceKey=key;r.plan.repositoryDatabases=r.repositoryDatabases||[];showCreateSource(r.plan);
      return !createSourceNeedsChoice();
    }catch(e){if(session===createModalSession&&seq===createSourceSeq){createSourcePlan=null;document.getElementById('createSourceState').textContent=e.message;}return false;}
    finally{if(session===createModalSession){setBuildBusy(false);document.getElementById('createBuildBtn').disabled=createBusyOps>0||createSourceNeedsChoice();}}
  })();
  createSourceInFlight=operation;
  return operation;
}
function createSourceReady(body) { return !!createSourcePlan&&createSourceKey===createSourceIdentity(body)&&!createSourceNeedsChoice(); }
