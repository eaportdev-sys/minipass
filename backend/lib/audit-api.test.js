// Exact HTTP routes with isolated SQLite and synthetic lifecycle I/O. No real
// Docker resources, credentials, site directories or quota allocations are used.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const express = require('express');
const { PanelStore } = require('./panel-store');
const { PanelAccounts } = require('./panel-accounts');
const { deletionQueue } = require('./deletion-queue');
async function main() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'minipass-audit-api-'));
  let store, server, active = 0, peak = 0;
  try {
    const apps = path.join(temp, 'apps'), trash = path.join(apps, '.trash'); fs.mkdirSync(trash, { recursive: true });
    for (const id of ['alpha','beta']) { fs.mkdirSync(path.join(apps,id)); fs.writeFileSync(path.join(apps,id,'docker-compose.yml'), 'services:\n  app:\n    image: fixture\n'); }
    const legacy = path.join(temp, 'apps.json'); fs.writeFileSync(legacy, JSON.stringify({ apps: [{ id:'alpha',name:'Alpha',type:'node' },{ id:'beta',name:'Beta',type:'static' }] }));
    store = new PanelStore({ file:path.join(temp,'panel.sqlite'),legacyFile:legacy });
    const accounts = new PanelAccounts(store), app = express(); app.use(express.json());
    require('../routes/auth').registerAuth({ app,store,accounts,terms:'Fixture terms' }); require('../routes/audit').registerAudit({ app,store });
    const ctx = { app,store,APPS_DIR:apps,TRASH_DIR:trash,TRASH_HOLD_MS:172800000,COMPOSE_BIN:'fixture',DOCKER_BIN:'fixture',TEMPLATES_DIR:temp,fs,path,
      appDir:(root,id)=>path.join(root,id),load:()=>store.load(),save:d=>store.save(d),deletions:deletionQueue(),
      deployOps:new Map(),deployQueues:new Map(),deployLocks:new Set(),deployChildren:new Map(),deployEpochs:new Map(),creatingSites:new Set(),lifecycleLocks:new Set(),
      redactUrl:String,trashKey:r=>r.trashDir||r.id,trashOptions:()=>({}),panelLog:{logEvent(){}},dbTools:{IMAGES:[],stopAll(){}},quotas:{release:async()=>{}},
      pubApp:a=>({id:a.id,name:a.name,type:a.type,deletedAt:a.deletedAt,deletedBy:a.deletedBy}),hostPortsInUse:()=>new Set(),envSetManaged(){},markDirty:async()=>{},
      composeArgv:()=>['fixture'],runOut:async()=>'',repositoryCompose:{},svc:{renderProject(){}},execFileSync(){},
      sh:async()=>{active++;peak=Math.max(peak,active);await new Promise(r=>setTimeout(r,30));active--;},
      trashLib:{rememberImages:async()=>[],stopSiteTools:async()=>{},collectImages:async()=>[],pruneBuildCache:async()=>{},trashPath:(root,r)=>path.join(root,r.trashDir||r.id),
        destroySite:async({record,trashRoot})=>{fs.rmSync(path.join(trashRoot,record.trashDir||record.id),{recursive:true,force:true});return{removedImages:0};}} };
    Object.assign(ctx,require('./site-lifecycle')(ctx));require('../routes/lifecycle')(ctx);
    server=http.createServer(app);await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port;
    const request=async(url,method='GET',body,cookie)=>{const r=await fetch(base+url,{method,headers:{'Content-Type':'application/json',...(cookie?{Cookie:cookie}:{}),'X-Forwarded-For':'forged-address'},...(body!==undefined?{body:JSON.stringify(body)}:{})});return{status:r.status,data:await r.json(),cookie:r.headers.get('set-cookie')?.split(';')[0]};};
    assert.equal((await request('/api/panel/audit')).status,401);
    const admin=await request('/api/panel/setup','POST',{username:'owner',password:'owner-test-password-long',acceptTerms:true});assert.equal(admin.status,200);
    for(const username of ['alice','bob'])assert.equal((await request('/api/panel/operators','POST',{username,password:username+'-long-test-password'},admin.cookie)).status,200);
    const alice=await request('/api/panel/login','POST',{username:'alice',password:'alice-long-test-password'}),bob=await request('/api/panel/login','POST',{username:'bob',password:'bob-long-test-password'});
    assert.equal((await request('/api/panel/operators','POST',{username:'forged',password:'forged-long-password'},alice.cookie)).status,403);
    const results=await Promise.all([request('/api/apps/alpha','DELETE',{deletedBy:'bob'},alice.cookie),request('/api/apps/beta','DELETE',{},bob.cookie)]);
    assert(results.every(r=>r.status===200),JSON.stringify(results));assert.equal(peak,1,'multiple deletion requests are accepted but resource-heavy work is serialized internally');
    const history=await request('/api/panel/audit?action=site.deleted','GET',undefined,admin.cookie);
    assert.equal(history.data.total,2);assert.deepEqual(history.data.rows.map(r=>r.actor_username).sort(),['alice','bob']);assert(history.data.rows.every(r=>r.ip_address!=='forged-address'));
    assert.equal((await request('/api/trash/alpha/restore','POST',{},alice.cookie)).status,200);
    assert.equal((await request('/api/trash/beta','DELETE',{},bob.cookie)).status,200);
    assert.equal((await request('/api/apps/missing','DELETE',{},bob.cookie)).status,404);
    const failure=await request('/api/panel/audit?action=site.deleted&outcome=failure','GET',undefined,admin.cookie);
    assert(failure.data.rows.some(r=>r.site_id==='missing'&&r.actor_username==='bob'));
    const expired=store.load(); const expiredDir='expiry-fixture';fs.mkdirSync(path.join(trash,expiredDir));
    expired.trash.push({id:expiredDir,name:'Expired fixture',trashDir:expiredDir,deletedAt:Date.now()-200000000});store.save(expired);
    await ctx.purgeTrash();
    assert(store.db.prepare("SELECT id FROM audit_events WHERE site_id=? AND action='site.destroyed' AND actor_username='system:expiry'").get(expiredDir));
    const sql=await request('/api/panel/audit/query','POST',{sql:'SELECT name,state,deleted_by FROM panel_sites ORDER BY id'},admin.cookie);
    assert.equal(sql.status,200,JSON.stringify(sql));assert(sql.data.rows.some(r=>r.name==='Beta'&&r.state==='destroyed'&&r.deleted_by==='bob'));
    assert.equal((await request('/api/panel/audit/query','POST',{sql:'SELECT password_hash FROM operators'},admin.cookie)).status,400);
    assert.equal((await request('/api/panel/audit/query','POST',{sql:'DELETE FROM audit_events'},admin.cookie)).status,400);
    assert(!(JSON.stringify((await request('/api/panel/audit','GET',undefined,admin.cookie)).data).includes('long-test-password')),'password bodies never enter audit records');
    const users=(await request('/api/panel/operators','GET',undefined,admin.cookie)).data;
    await request('/api/panel/operators/'+users.find(u=>u.username==='alice').id,'PATCH',{disabled:true},admin.cookie);
    assert.equal((await request('/api/panel/audit','GET',undefined,alice.cookie)).status,401);
    assert.equal((await request('/api/panel/operators/'+admin.data.user.id,'PATCH',{disabled:true},admin.cookie)).status,409);
    console.log('Audit API: named login/accounts, actor-safe parallel deletion requests, durable delete/restore/destroy records, private bounded SQL and revoked sessions: OK');
  } finally { if(server)await new Promise(r=>server.close(r));if(store)store.close();fs.rmSync(temp,{recursive:true,force:true}); }
}
main().catch(e=>{console.error(e);process.exitCode=1});
