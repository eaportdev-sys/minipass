const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const net = require('net');
const http = require('http');
const { spawn, execFileSync } = require('child_process');
const { once } = require('events');

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'minipass-workflow-api-'));
  let child, exit,quotaServer;
  const apps = path.join(tmp, 'apps');
  const recipe = 'FROM nginx:alpine\nEXPOSE 80\n';
  const compose = 'services:\n  app:\n    build: ./code\n    ports:\n      - "8000:80"\n';
  const metadata = { apps: [] };
  const fixture = (id, repoUrl = '') => {
    const dir = path.join(apps, id);
    fs.mkdirSync(path.join(dir, 'code'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'docker-compose.yml'), compose);
    fs.writeFileSync(path.join(dir, '.env'), `APP_NAME=${id}\nPORT=80\n`);
    metadata.apps.push({ id, name: id, type: 'static', hostPort: 8000, db: [], repoUrl });
    return path.join(dir, 'code');
  };
  const code = fixture('test-upload');
  fs.writeFileSync(path.join(code, 'Dockerfile'), recipe);
  fs.writeFileSync(path.join(code, 'index.html'), '<h1>fixture</h1>');
  const remote = path.join(tmp, 'source');
  fs.mkdirSync(remote);
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, stdio: 'pipe', encoding: 'utf8' });
  git(remote, 'init', '-b', 'main');
  git(remote, 'config', 'user.name', 'Workflow fixture');
  git(remote, 'config', 'user.email', 'fixture@example.test');
  fs.writeFileSync(path.join(remote, 'Dockerfile'), recipe);
  fs.writeFileSync(path.join(remote, 'index.html'), '<h1>fixture</h1>');
  git(remote, 'add', '.'); git(remote, 'commit', '-m', 'initial fixture');
  const checkout = fixture('test-pull', remote.replace(/\\/g, '/'));
  git(tmp, 'clone', remote, checkout);
  fs.writeFileSync(path.join(tmp, 'apps.json'), JSON.stringify(metadata));
  try {
    const quotaSocket=process.platform==='win32'?`\\\\.\\pipe\\minipass-quota-${require('crypto').randomBytes(8).toString('hex')}`:path.join(tmp,'quotas.sock');
    const allocations=new Map(),quotaAttempts=[];let nextProject=100000;
    quotaServer=http.createServer((req,res)=>{
      let input='';req.on('data',c=>input+=c);req.on('end',()=>{
        const reply=(status,data)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(data));};
        if(req.url==='/status')return reply(200,{ready:true,availableBytes:1e12});
        const id=req.url.split('/').pop(),dir=path.join(apps,id),old=allocations.get(id);
        if(req.method==='GET')return reply(old?200:404,old||{error:'no allowance'});
        if(req.method==='DELETE'){if(fs.existsSync(dir))return reply(409,{error:'site files still exist'});allocations.delete(id);return reply(200,{ok:true,released:!!old});}
        const body=JSON.parse(input);quotaAttempts.push({id,children:fs.existsSync(dir)?fs.readdirSync(dir):[]});
        if(body.limitBytes>1e12)return reply(409,{error:'Not enough unallocated disk space'});
        if(!old&&fs.existsSync(dir)&&fs.readdirSync(dir).some(n=>!['deploy-key','deploy-key.pub'].includes(n)))return reply(409,{error:'Existing site data is not quota-managed. Cancel the unfinished checkout or migrate it explicitly.'});
        fs.mkdirSync(dir,{recursive:true});const record=old||{projectId:nextProject++,limitBytes:body.limitBytes,enforced:true,usedBytes:0};allocations.set(id,record);reply(200,record);
      });
    });
    await new Promise(resolve=>quotaServer.listen(quotaSocket,resolve));
    const listener = net.createServer(); listener.listen(0, '127.0.0.1'); await once(listener, 'listening');
    const port = listener.address().port;
    await new Promise(resolve => listener.close(resolve));
    const base = `http://127.0.0.1:${port}`;
    child = spawn(process.execPath, ['server.js'], { cwd: path.resolve(__dirname, '..'), env: { ...process.env, PORT: String(port), APPS_DIR: apps, DATA_FILE: path.join(tmp, 'apps.json'),QUOTA_SOCKET:quotaSocket }, stdio: ['ignore', 'pipe', 'pipe'] });
    exit = once(child, 'exit');
    let log = ''; const capture = b => { log = (log + b).slice(-10000); };
    child.stdout.on('data', capture); child.stderr.on('data', capture);
    let ready = false;
    for (let i = 0; i < 100; i++) {
      if (child.exitCode !== null) throw new Error('Server exited: ' + log);
      try { ready = (await fetch(base + '/health')).ok; } catch {}
      if (ready) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert(ready, log);
    assert.equal((await fetch(base + '/api/apps/test-upload/deployment-plan')).status, 401);
    const setup = await fetch(base + '/api/panel/setup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'isolated-workflow-test-only', acceptTerms: true }) });
    assert.equal(setup.status, 200);
    const cookie = setup.headers.get('set-cookie').split(';')[0];
    const screenshot=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l2sAAAAASUVORK5CYII=','base64');
    fs.writeFileSync(path.join(apps,'test-upload','.verification-0.png'),screenshot);
    const screenshotResponse=await fetch(base+'/api/apps/test-upload/verification/screenshot/0',{headers:{Cookie:cookie}});
    assert.equal(screenshotResponse.status,200,'panel-owned hidden screenshots are served explicitly, not rejected as dotfiles');
    assert(Buffer.from(await screenshotResponse.arrayBuffer()).equals(screenshot));
    assert.equal((await fetch(base+'/api/apps/test-upload/verification/screenshot/99',{headers:{Cookie:cookie}})).status,404);
    const headers = { Cookie: cookie, 'Content-Type': 'application/json' };
    const call = async (url, method = 'GET', body) => {
      const response = await fetch(base + url, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
      return { status: response.status, data: await response.json() };
    };
    for (const name of ['', '   ']) {
      const before = fs.readdirSync(apps);
      const r = await call('/api/apps', 'POST', { name, type: 'static', storageGB: '1' });
      assert.equal(r.status, 400); assert.equal(r.data.field, 'name');
      assert.deepEqual(fs.readdirSync(apps), before, 'name validation creates nothing');
    }
    const created = await call('/api/apps', 'POST', { name: 'Manual creation fixture', type: 'static', storageGB: '1' });
    assert.equal(created.status, 200);
    assert(created.data.plan && created.data.plan.scan.complete);
    assert(!created.data.lastDeploy, 'creation does not deploy');
    let plan = (await call('/api/apps/test-upload/deployment-plan')).data;
    assert(plan.ready);
    const oldFingerprint = plan.fingerprint;
    const fd = new FormData();
    fd.append('files', new Blob(['services:\n  web:\n    image: nginx:alpine\n']), 'compose.dockerfile');
    fd.append('paths', 'compose.dockerfile');
    fd.append('files', new Blob(['services:\n  other:\n    image: nginx:alpine\n']), 'Dockerfile.compose');
    fd.append('paths', 'Dockerfile.compose');
    fd.append('files', new Blob(['docker compose -f compose.dockerfile up -d\n']), 'release.sh');
    fd.append('paths', 'release.sh');
    const uploaded = await fetch(base + '/api/apps/test-upload/upload-files', { method: 'POST', headers: { Cookie: cookie }, body: fd });
    assert.equal(uploaded.status, 200);
    assert((await uploaded.json()).pending);
    assert.equal(fs.readFileSync(path.join(code, 'Dockerfile'), 'utf8'), recipe);
    plan = (await call('/api/apps/test-upload/deployment-plan')).data;
    assert.equal(plan.selected.file, 'compose.dockerfile');
    assert(plan.candidates.some(c => c.kind === 'compose' && c.file === 'Dockerfile.compose'), 'upload classification follows content, not a Dockerfile-looking name');
    assert.notEqual(plan.fingerprint, oldFingerprint);
    assert(!plan.blockers.some(b => b.code === 'COMPOSE_EXECUTOR_UNSUPPORTED'));
    assert(fs.existsSync(path.join(apps, 'test-upload/.deployment-plan.json')), 'upload persists shared analysis');
    const picked = await call('/api/apps/test-upload/deployment-plan', 'POST', { selection: { kind: 'compose', file: 'compose.dockerfile' } });
    assert.equal(picked.status, 200);
    assert.equal(picked.data.plan.selection.file, 'compose.dockerfile');
    assert.equal((await call('/api/apps/test-upload/deployment-plan', 'POST', { selection: { kind: 'dockerfile', file: 'Dockerfile' } })).status, 409, 'no single-service escape from declared topology');
    const unchanged = fs.readFileSync(path.join(apps, 'test-upload/docker-compose.yml'), 'utf8');
    const blocked = await call('/api/apps/test-upload/deploy', 'POST', { source: 'local' });
    assert.equal(blocked.status, 500, JSON.stringify(blocked));
    assert(/docker|ENOENT/i.test(blocked.data.error), 'Windows has no Docker: actual Compose resolution is attempted, not a blanket executor refusal');
    assert.equal(fs.readFileSync(path.join(apps, 'test-upload/docker-compose.yml'), 'utf8'), unchanged);
    assert(!fs.readFileSync(path.join(apps, 'test-upload/deploy.log'), 'utf8').includes('Docker image build'));

    // Pull a real new commit with unconventional deployment instructions. It
    // must be read after sync, before generated-project edits or Docker calls.
    fs.writeFileSync(path.join(remote, 'new.instructions'), 'services:\n  database:\n    image: postgres:17\n  api:\n    image: node:24\n');
    git(remote, 'add', '.'); git(remote, 'commit', '-m', 'declare deployment topology');
    const pulled = await call('/api/apps/test-pull/deploy', 'POST', {});
    assert.equal(pulled.status, 500, JSON.stringify(pulled));
    assert(fs.existsSync(path.join(checkout, 'new.instructions')), 'real pull completes before revalidation');
    assert.equal((await call('/api/apps/test-pull/deployment-plan')).data.selected.file, 'new.instructions');
    assert.equal(fs.readFileSync(path.join(apps, 'test-pull/docker-compose.yml'), 'utf8'), compose);

    // Editing/deleting instructions also refreshes; a saved disappearing choice
    // is explicit, not silently reassigned to a different discovered file.
    assert.equal((await call('/api/apps/test-upload/file', 'PUT', { path: 'another.plan', content: 'services:\n  web:\n    image: nginx\n' })).status, 200);
    assert.equal((await call('/api/apps/test-upload/file?path=compose.dockerfile', 'DELETE')).status, 200);
    plan = (await call('/api/apps/test-upload/deployment-plan')).data;
    assert(plan.blockers.some(b => b.code === 'STALE_SELECTION'));
    assert.equal(plan.selection.file, 'compose.dockerfile');
    assert.equal((await call('/api/apps/test-upload/deployment-plan', 'POST', { selection: { kind: 'compose', file: '../outside' } })).status, 400);
    const publicRoute=await call('/api/apps/test-pull/verification','POST',{url:'https://public.example.test'});
    assert.equal(publicRoute.status,200);
    assert(publicRoute.data.saved&&publicRoute.data.provisioningError,'public URL remains saved when Docker-based input preparation is unavailable on Windows');
    const copiedPort=await call('/api/apps/test-pull/verification','POST',{url:'http://localhost:8000/'});
    assert.equal(copiedPort.status,409,'a URL copied from another local site is rejected before saving/building');
    assert(copiedPort.data.error.includes('another site'));
    assert.equal((await call('/api/apps/test-pull/compose-inputs','POST',{})).status,500,'explicit preparation fails closed when existing Docker state cannot be checked');
    await call('/api/apps/test-upload/file?path=another.plan', 'DELETE');
    await call('/api/apps/test-upload/file?path=Dockerfile.compose', 'DELETE');
    await call('/api/apps/test-upload/file?path=release.sh', 'DELETE');
    await call('/api/apps/test-upload/deployment-plan', 'POST', { selection: null });
    const custom = new FormData();
    custom.append('files', new Blob([recipe]), 'recipe.production');
    custom.append('paths', 'recipe.production');
    assert.equal((await fetch(base + '/api/apps/test-upload/upload-files', { method: 'POST', headers: { Cookie: cookie }, body: custom })).status, 200);
    const customPick = await call('/api/apps/test-upload/deployment-plan', 'POST', { selection: { kind: 'dockerfile', file: 'recipe.production' } });
    assert.equal(customPick.status, 200, JSON.stringify(customPick));
    assert(customPick.data.plan.ready);
    assert(fs.readFileSync(path.join(apps, 'test-upload/docker-compose.yml'), 'utf8').includes('dockerfile: recipe.production'));
    assert.equal((await call('/api/apps/test-upload/file', 'PUT', { path: 'recipe.production', content: 'overwrite' })).status, 409);
    const overwrite = new FormData(); overwrite.append('files', new Blob(['overwrite']), 'recipe.production'); overwrite.append('paths', 'recipe.production');
    assert.equal((await fetch(base + '/api/apps/test-upload/upload-files', { method: 'POST', headers: { Cookie: cookie }, body: overwrite })).status, 400);
    assert.equal(fs.readFileSync(path.join(code, 'recipe.production'), 'utf8'), recipe, 'arbitrary selected build files retain infrastructure overwrite protection');
    const declaredRepo=path.join(tmp,'declared-source');fs.mkdirSync(declaredRepo);
    const declared=`services:\n  warehouse:\n    image: postgres:17-alpine\n    environment:\n      POSTGRES_USER: service_user\n      POSTGRES_DB: records\n      POSTGRES_PASSWORD: \${SQL_PASSWORD:?}\n  api:\n    image: node:24\n    depends_on: [warehouse]\n    environment:\n      DATABASE_URL: \${API_CONNECTION:?}\n      APP_ORIGIN: https://\${LOCAL_HOST:?}\n`;
    fs.writeFileSync(path.join(declaredRepo,'production.recipe'),declared);fs.writeFileSync(path.join(declaredRepo,'development.recipe'),declared.replace('postgres:17-alpine','postgres:16-alpine'));
    git(declaredRepo,'init','-b','main');git(declaredRepo,'config','user.name','Fixture');git(declaredRepo,'config','user.email','fixture@example.test');git(declaredRepo,'add','.');git(declaredRepo,'commit','-m','declared deployment files');
    const createBody={name:'Creation choice fixture',type:'node',repoUrl:declaredRepo,branch:'main',access:'local',domain:'ignored.example.test',storageGB:'1'};
    const draft=await call('/api/apps','POST',{...createBody,prepareOnly:true});assert.equal(draft.status,200,JSON.stringify(draft));assert(draft.data.prepared&&draft.data.needsEntrypoint);
    const draftId=draft.data.pendingId,draftDir=path.join(apps,draftId),stagingDir=path.join(apps,'.drafts',draftId);
    assert(!fs.existsSync(draftDir)&&fs.existsSync(path.join(stagingDir,'code')),'inspection stays outside the future quota-managed site directory');
    assert(!fs.existsSync(path.join(draftDir,'.env'))&&!fs.existsSync(path.join(draftDir,'docker-compose.yml')),'inspection does not create database/env/compose scaffolding');
    assert(!(await call('/api/apps')).data.some(a=>a.id===draftId),'ambiguous draft is not a registered website');
    fs.renameSync(stagingDir,draftDir); // reproduce an uncharged preview from the previous panel
    const choice={kind:'compose',file:'production.recipe'};
    const pickedDraft=await call('/api/apps','POST',{...createBody,pendingId:draftId,prepareOnly:true,deploymentEntrypoint:choice});assert.equal(pickedDraft.status,200);assert.equal(pickedDraft.data.repositoryDatabases[0].type,'postgres');
    assert(!fs.existsSync(draftDir)&&fs.existsSync(stagingDir),'retry safely stages the older preview instead of asking the host to adopt existing data');
    const tooLarge=await call('/api/apps','POST',{...createBody,pendingId:draftId,deploymentEntrypoint:choice,storageGB:'1000000'});assert.equal(tooLarge.status,409);assert.equal(tooLarge.data.pendingId,draftId);assert(fs.existsSync(path.join(stagingDir,'code','production.recipe')),'capacity refusal preserves the inspected checkout for retry');
    const registered=await call('/api/apps','POST',{...createBody,pendingId:draftId,deploymentEntrypoint:choice,dbs:['mysql']});assert.equal(registered.status,200,JSON.stringify(registered));
    assert(!fs.existsSync(stagingDir),'successful creation removes only its temporary source preview');
    assert(registered.data.storageEnforced&&registered.data.storageQuota.projectId>=100000,'creation succeeds with enforcement enabled, not an unavailable-bridge fallback');
    assert(quotaAttempts.filter(a=>a.id===draftId).every(a=>a.children.length===0),'the host allocates an empty site before source is copied into it');
    assert.equal(registered.data.accessMode,'local');assert.equal(registered.data.domain,'');assert.equal(registered.data.deploymentEntrypoint.file,'production.recipe');assert.equal(registered.data.repositoryDatabases[0].type,'postgres');
    assert(!registered.data.plan.blockers.some(b=>b.code==='REQUIRED_ENV'),'chosen source prepares all declared database and local inputs during creation');
    const variables=require('dotenv').parse(fs.readFileSync(path.join(draftDir,'.env')));assert(variables.SQL_PASSWORD&&variables.API_CONNECTION&&variables.LOCAL_HOST);assert(!JSON.stringify(registered.data).includes(variables.SQL_PASSWORD));
    const pendingDbs=(await call('/api/apps/'+draftId+'/databases')).data;assert.equal(pendingDbs.databases[0].state,'prepared');assert(pendingDbs.repositoryOwned);
    const cancelled=await call('/api/apps','POST',{...createBody,prepareOnly:true});assert.equal((await call('/api/apps/pending/'+cancelled.data.pendingId,'DELETE')).status,200);assert(!fs.existsSync(path.join(apps,'.drafts',cancelled.data.pendingId)),'Cancel cleans only the unregistered draft');
    console.log('Workflow API: name validation, manual create, uploads, saved/stale choices, real Git pull, shared persistent analysis and pre-Docker blocking: OK');
  } finally {
    if (child && child.exitCode === null) child.kill();
    if (exit) await exit;
    if(quotaServer)await new Promise(resolve=>quotaServer.close(resolve));
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
main().catch(e => { console.error(e); process.exitCode = 1; });
