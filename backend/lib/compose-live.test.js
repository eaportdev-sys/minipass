// Explicit Linux/Docker integration test. Uses only a fresh fixture project,
// private metadata and random free publication ports. Never touches real sites.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { execFileSync, spawn } = require('child_process');
const { once } = require('events');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'minipass-live-'));
const id = 'test-live-' + require('crypto').randomBytes(5).toString('hex');
const dir = path.join(tmp, 'apps', id), code = path.join(dir, 'code');
const docker = args => execFileSync('docker', args, { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
const put = (file, text) => { const p = path.join(code, file); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); };
const compose = () => `services:
  db:
    image: redis:7-alpine
    healthcheck: {test: [CMD, redis-cli, ping], interval: 1s, retries: 30}
    volumes: [state:/data]
    networks: [private]
  migrate:
    image: redis:7-alpine
    command: [sh, -c, "redis-cli -h db INCR release_tasks; redis-cli -h db SET migrated yes"]
    depends_on: {db: {condition: service_healthy}}
    restart: "no"
    networks: [private]
  api:
    build: {context: ./api, dockerfile: recipe.production}
    environment:
      APP_ORIGIN: https://\${PUBLIC_DOMAIN:?Set PUBLIC_DOMAIN}
      PORT: "4000"
    expose: ["4000"]
    depends_on: {migrate: {condition: service_completed_successfully}}
    networks: [private]
  web:
    build: {context: ./web, dockerfile: build.instructions}
    ports: ["8080:8080"]
    depends_on: {api: {condition: service_started}}
    networks: [private]
networks: {private: {}}
volumes: {state: {}}
`;
async function main() {
  let child, exit, watcher;
  fs.mkdirSync(dir, { recursive: true });
  put('compose.dockerfile', compose());
  put('production.overlay', 'services:\n  api:\n    environment:\n      MODE: production\n');
  put('release.sh', 'docker compose -f compose.dockerfile -f production.overlay up -d\n');
  put('api/recipe.production', 'FROM minipass/node:22-runtime\nWORKDIR /app\nCOPY . .\nEXPOSE 4000\nCMD ["node","server.js"]\n');
  put('api/package.json', '{"name":"fixture-api","scripts":{"start":"node server.js"}}');
  put('api/server.js', `const http=require('http'),net=require('net');const routes=new Map();const app={get:(p,f)=>routes.set(p,f)};
app.get('/api/health',async(req,res)=>{const migrated=await new Promise((resolve,reject)=>{const c=net.connect(6379,'db');let b='';c.on('connect',()=>c.write('*2\\r\\n$3\\r\\nGET\\r\\n$8\\r\\nmigrated\\r\\n'));c.on('data',d=>{b+=d;c.end();resolve(b.includes('yes'))});c.on('error',reject)});res.setHeader('Content-Type','application/json');res.end(JSON.stringify({ok:migrated,origin:process.env.APP_ORIGIN}))});
http.createServer((req,res)=>{const f=routes.get(req.url);if(!f){res.statusCode=404;res.end('not found');return}Promise.resolve(f(req,res)).catch(e=>{res.statusCode=500;res.end('database not ready')})}).listen(4000,'0.0.0.0');
`);
  put('web/build.instructions', 'FROM minipass/node:22-runtime\nWORKDIR /app\nCOPY . .\nRUN node build.js\nEXPOSE 8080\nCMD ["node","server.js"]\n');
  put('web/package.json', '{"name":"fixture-web","scripts":{"build":"node build.js","start":"node server.js"},"dependencies":{"react":"19"}}');
  const build = (missing = false, csp = false) => `const fs=require('fs');fs.mkdirSync('dist',{recursive:true});fs.writeFileSync('dist/index.html','<!doctype html><html><head>${csp ? '<meta http-equiv="Content-Security-Policy" content="upgrade-insecure-requests">' : ''}<link rel="stylesheet" href="/${missing ? 'missing' : 'app'}.css"></head><body><h1>Repository fixture</h1><div id="status">Loading</div><script src="/app.js"></script></body></html>');fs.writeFileSync('dist/app.css','body{background:#123;color:#def}');fs.writeFileSync('dist/app.js',"fetch('/api/health').then(r=>r.json()).then(x=>{document.getElementById('status').textContent=x.ok?'API and migrations ready':'FAILED';if(!x.ok)throw Error('migration not applied')})");`;
  put('web/build.js', build());
  put('web/server.js', `const http=require('http'),fs=require('fs');const routes=new Map();const app={get:(p,f)=>routes.set(p,f)};
app.get('/',(req,res)=>{res.setHeader('Content-Type','text/html');res.end(fs.readFileSync('dist/index.html'))});
app.get('/app.css',(req,res)=>{res.setHeader('Content-Type','text/css');res.end(fs.readFileSync('dist/app.css'))});
app.get('/app.js',(req,res)=>{res.setHeader('Content-Type','text/javascript');res.end(fs.readFileSync('dist/app.js'))});
app.get('/api/health',async(req,res)=>{const r=await fetch('http://api:4000/api/health');res.setHeader('Content-Type','application/json');res.end(await r.text())});
http.createServer((req,res)=>{const f=routes.get(req.url);if(!f){res.statusCode=404;res.end('not found');return}Promise.resolve(f(req,res)).catch(e=>{res.statusCode=500;res.end('upstream failed')})}).listen(8080,'0.0.0.0');`);
  fs.writeFileSync(path.join(dir, '.env'), 'PUBLIC_DOMAIN=fixture.example.test\nCOMPOSE_PROJECT_NAME=' + id + '\n');
  fs.writeFileSync(path.join(dir, 'docker-compose.yml'), 'services:\n  app:\n    image: nginx:alpine\n');
  fs.writeFileSync(path.join(tmp, 'apps.json'), JSON.stringify({ apps: [{ id, name: 'isolated fixture', type: 'node', hostPort: 8800, db: [], repoUrl: '' }] }));
  const inspect = () => { const ids = docker(['ps', '-a', '-q', '--filter', 'label=com.docker.compose.project=' + id]).trim().split(/\s+/).filter(Boolean); return ids.length ? JSON.parse(docker(['inspect', ...ids])) : []; };
  try {
    const listener=net.createServer();listener.listen(0,'127.0.0.1');await once(listener,'listening');const port=listener.address().port;await new Promise(r=>listener.close(r));
    child=spawn(process.execPath,['server.js'],{cwd:path.resolve(__dirname,'..'),env:{...process.env,PORT:String(port),APPS_DIR:path.join(tmp,'apps'),DATA_FILE:path.join(tmp,'apps.json')},stdio:['ignore','pipe','pipe']});exit=once(child,'exit');
    let logs='';child.stdout.on('data',d=>{logs=(logs+d).slice(-15000)});child.stderr.on('data',d=>{logs=(logs+d).slice(-15000)});
    const base='http://127.0.0.1:'+port;
    for(let i=0;;i++){try{if((await fetch(base+'/health')).ok)break}catch{}if(i>100)throw Error(logs);await new Promise(r=>setTimeout(r,100))}
    const setup=await fetch(base+'/api/panel/setup',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:'fixture-only-password',acceptTerms:true})});assert.equal(setup.status,200);
    const headers={Cookie:setup.headers.get('set-cookie').split(';')[0],'Content-Type':'application/json'};
    let offset=0;watcher=fs.watch(dir,(event,file)=>{if(file==='deploy.log'){try{const data=fs.readFileSync(path.join(dir,'deploy.log'));if(data.length<offset)offset=0;if(data.length>offset){process.stdout.write(data.subarray(offset));offset=data.length}}catch{}}});
    const request=async(endpoint,method='GET',body)=>new Promise((resolve,reject)=>{
      const data=body!==undefined?JSON.stringify(body):null;
      const req=require('http').request(base+'/api/apps/'+id+endpoint,{method,headers:{...headers,...(data?{'Content-Length':Buffer.byteLength(data)}:{})},timeout:900000},res=>{
        let text='';res.setEncoding('utf8');res.on('data',d=>{text+=d});res.on('end',()=>{try{resolve({status:res.statusCode,body:JSON.parse(text)})}catch(e){reject(e)}});
      });
      req.on('timeout',()=>req.destroy(Error('15-minute integration request timeout')));
      req.on('error',e=>{let log='';try{log=fs.readFileSync(path.join(dir,'deploy.log'),'utf8').slice(-12000)}catch{}reject(Error(e.message+'\n'+log+'\n'+logs))});
      if(data)req.write(data);req.end();
    });
    let response=await request('/deploy','POST',{source:'local'});
    if(response.status!==200)throw Error(JSON.stringify(response)+'\n'+fs.readFileSync(path.join(dir,'deploy.log'),'utf8').slice(-12000));
    let status=(await request('/status')).body;
    assert.equal(status.app.executor,'repository-compose');
    assert.deepEqual(status.app.deploymentEntrypoint.files,['compose.dockerfile','production.overlay']);
    assert.deepEqual(status.services.map(s=>s.name).sort(),['api','web']);
    assert.equal(status.lastDeploy.status,'ok');assert(status.lastDeploy.verification.ok);
    assert(status.lastDeploy.verification.pages.some(p=>p.service==='web'&&p.assets.length>=2&&p.api.some(a=>a.status===200)));
    assert(status.lastDeploy.verification.pages.find(p=>p.service==='web').releaseMatched,'public verification reaches the exact new release');
    assert(status.lastDeploy.verification.probes.some(p=>p.service==='api'&&p.ok),'unpublished API is probed on repository DNS/network');
    const db=inspect().find(c=>c.Config.Labels['com.docker.compose.service']==='db');
    assert.equal(docker(['exec',db.Id,'redis-cli','GET','release_tasks']).trim(),'1','migration executed once');
    assert.equal(docker(['exec',db.Id,'redis-cli','GET','migrated']).trim(),'yes');
    console.log('LIVE PASS: real API deploy, declared build files, Compose-derived origin, database health -> migration -> API -> web, Chromium CSS/JS/API checks');
    const goodSha=status.app.lastGoodDeploy.at;
    put('web/build.js',build(true));
    response=await request('/deploy','POST',{source:'local'});assert.notEqual(response.status,200);assert(/verification|stylesheet|CSS|404/i.test(response.body.error),JSON.stringify(response));
    status=(await request('/status')).body;assert.equal(status.app.lastGoodDeploy.at,goodSha);assert.equal(status.lastDeploy.status,'error');
    assert((await request('/deployment-plan')).body.verification.errors.some(e=>/stylesheet|404/i.test(e)));
    assert.equal(inspect().find(c=>c.Config.Labels['com.docker.compose.service']==='db').Id,db.Id,'application rollback does not recreate the database');
    assert.equal(docker(['exec',db.Id,'redis-cli','GET','release_tasks']).trim(),'2','new migration ran once; rollback does not replay it');
    console.log('LIVE PASS: missing stylesheet fails deployment and restores previous release; database data and last-good history retained');
    put('web/build.js',build(false,true));
    response=await request('/deploy','POST',{source:'local'});assert.notEqual(response.status,200);
    const csp=(await request('/deployment-plan')).body.verification;assert(!csp.ok);assert(csp.errors.some(e=>/SSL|https|stylesheet|script/i.test(e)));
    console.log('LIVE PASS: upgrade-insecure-requests on HTTP is rejected by the real browser, not falsely passed by curl');
    const before=inspect().find(c=>c.Config.Labels['com.docker.compose.service']==='web').Id;
    put('compose.dockerfile',compose().replace('redis-cli -h db INCR release_tasks; redis-cli -h db SET migrated yes','exit 9'));
    response=await request('/deploy','POST',{source:'local'});assert.notEqual(response.status,200);assert(/migrate|exit 9/i.test(response.body.error));
    assert.equal(inspect().find(c=>c.Config.Labels['com.docker.compose.service']==='web').Id,before,'migration failure leaves old web container untouched');
    console.log('LIVE PASS: migration exit 9 aborts before application swap');
    assert.equal((await request('/stop','POST',{})).status,200);
    assert(!inspect().some(c=>c.State.Running),'site stop stops repository containers');
    const start=await request('/start','POST',{});assert.equal(start.status,200,JSON.stringify(start));
    assert.equal(docker(['exec',db.Id,'redis-cli','GET','release_tasks']).trim(),'3','start/rollback never replay release migrations');
    console.log('LIVE PASS: stop/start restores the verified release without rerunning migrations');
    assert.equal((await request('/services','POST',{name:'wrong',type:'node',subdir:'api'})).status,409,'generated service mutations cannot corrupt repository topology');
    console.log('All isolated live execution tests passed.');
  } finally {
    if(child&&child.exitCode===null)child.kill();if(exit)await exit;
    if(watcher)watcher.close();
    try { const ids=inspect().map(c=>c.Id);if(ids.length)docker(['rm','-f',...ids]); }catch{}
    for(const kind of ['network','volume']){try{const names=docker([kind,'ls','-q','--filter','label=com.docker.compose.project='+id]).trim().split(/\s+/).filter(Boolean);for(const name of names)docker([kind,'rm',name]);}catch{}}
    try{const images=docker(['image','ls','-q','--filter','label=com.docker.compose.project='+id]).trim().split(/\s+/).filter(Boolean);if(images.length)docker(['image','rm',...new Set(images)]);}catch{}
    fs.rmSync(tmp,{recursive:true,force:true});
  }
}
main().catch(e=>{console.error(e);process.exitCode=1});
