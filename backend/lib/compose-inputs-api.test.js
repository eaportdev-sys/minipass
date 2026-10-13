// Explicit Linux/Docker integration: fresh repository clone with no secret or
// connection supplied. Only this fixture's project, files and volumes are used.
const assert=require('assert');
const fs=require('fs');
const path=require('path');
const os=require('os');
const net=require('net');
const {spawn,execFileSync}=require('child_process');
const {once}=require('events');
const dotenv=require('dotenv');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'minipass-provision-live-'));
const docker=args=>execFileSync('docker',args,{encoding:'utf8',maxBuffer:10*1024*1024});
const repo=path.join(temp,'repository'),apps=path.join(temp,'apps'),data=path.join(temp,'apps.json');
function put(relative,text){const file=path.join(repo,relative);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,text);}
async function main(){
  let child,exit,id;
  try{
    fs.mkdirSync(repo);fs.mkdirSync(apps);fs.writeFileSync(data,'{"apps":[]}');
    put('deploy.definition',`services:
  warehouse:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: fixture_user
      POSTGRES_DB: fixture_records
      POSTGRES_PASSWORD: \${WAREHOUSE_SECRET:?Set database password}
    healthcheck:
      test: [CMD-SHELL, pg_isready -U fixture_user -d fixture_records]
      interval: 1s
      retries: 40
    volumes: [records:/var/lib/postgresql/data]
  initialize:
    image: postgres:16-alpine
    environment:
      DATABASE_URL: \${SQL_CONNECTION:?Set connection}
    command: [sh, -c, 'psql "$$DATABASE_URL" -v ON_ERROR_STOP=1 -c "CREATE TABLE IF NOT EXISTS fixture_runs (id integer PRIMARY KEY, total integer NOT NULL); INSERT INTO fixture_runs VALUES (1,1) ON CONFLICT (id) DO UPDATE SET total=fixture_runs.total+1;"']
    depends_on: {warehouse: {condition: service_healthy}}
    restart: "no"
  api:
    build: {context: ./api, dockerfile: production.recipe}
    environment:
      DATABASE_URL: \${SQL_CONNECTION:?Set connection}
      APP_ORIGIN: https://\${PUBLIC_HOST:?Set public hostname}
    ports: ["8000:4000"]
    depends_on: {initialize: {condition: service_completed_successfully}}
volumes: {records: {}}
`);
    put('api/production.recipe','FROM minipass/node:22-runtime\nWORKDIR /app\nCOPY package.json ./\nRUN npm install --omit=dev --ignore-scripts\nCOPY server.js ./\nEXPOSE 4000\nCMD ["node","server.js"]\n');
    put('api/package.json','{"name":"fixture-api","scripts":{"start":"node server.js"},"dependencies":{"pg":"8.16.3"}}');
    put('api/server.js',`const http=require('http'),{Pool}=require('pg');const pool=new Pool({connectionString:process.env.DATABASE_URL});const handlers=new Map();const app={get:(p,f)=>handlers.set(p,f)};
app.get('/',(req,res)=>{res.setHeader('Content-Type','text/html');res.end('<!doctype html><html><head><link rel="stylesheet" href="/style.css"></head><body><h1>Database fixture</h1><div id="state">Loading</div><script src="/client.js"></script></body></html>')});
app.get('/style.css',(req,res)=>{res.setHeader('Content-Type','text/css');res.end('body{color:#234;background:#eee}')});
app.get('/client.js',(req,res)=>{res.setHeader('Content-Type','text/javascript');res.end("fetch('/api/health').then(r=>r.json()).then(x=>{document.getElementById('state').textContent=x.ok?'Database linked and migrated':'FAILED';if(!x.ok)throw Error('Database query failed')})")});
app.get('/api/health',async(req,res)=>{const r=await pool.query('SELECT total FROM fixture_runs WHERE id=1');res.setHeader('Content-Type','application/json');res.end(JSON.stringify({ok:r.rows.length===1,total:r.rows[0].total,origin:process.env.APP_ORIGIN}))});
http.createServer((req,res)=>{const f=handlers.get(req.url);if(!f){res.statusCode=404;res.end('not found');return}Promise.resolve(f(req,res)).catch(e=>{res.statusCode=500;res.end('database query failed')})}).listen(4000,'0.0.0.0');`);
    const git=args=>execFileSync('git',args,{cwd:repo,stdio:'pipe'});
    git(['init','-b','main']);git(['config','user.email','fixture@example.test']);git(['config','user.name','Fixture']);git(['add','.']);git(['commit','-m','fixture']);
    const listener=net.createServer();listener.listen(0,'127.0.0.1');await once(listener,'listening');const port=listener.address().port;await new Promise(r=>listener.close(r));
    child=spawn(process.execPath,['server.js'],{cwd:path.resolve(__dirname,'..'),env:{...process.env,PORT:String(port),APPS_DIR:apps,DATA_FILE:data},stdio:['ignore','pipe','pipe']});exit=once(child,'exit');
    let log='';child.stdout.on('data',d=>{log=(log+d).slice(-10000)});child.stderr.on('data',d=>{log=(log+d).slice(-10000)});
    const base='http://127.0.0.1:'+port;
    for(let i=0;;i++){try{if((await fetch(base+'/health')).ok)break}catch{}if(i>100)throw Error(log);await new Promise(r=>setTimeout(r,100))}
    const setup=await fetch(base+'/api/panel/setup',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:'fixture-password-only',acceptTerms:true})});assert.equal(setup.status,200);
    const headers={Cookie:setup.headers.get('set-cookie').split(';')[0],'Content-Type':'application/json'};
    const call=async(url,method='GET',body)=>new Promise((resolve,reject)=>{const payload=body===undefined?null:JSON.stringify(body);const request=require('http').request(base+url,{method,headers:{...headers,...(payload?{'Content-Length':Buffer.byteLength(payload)}:{})},timeout:600000},res=>{let text='';res.on('data',d=>{text+=d});res.on('end',()=>{try{resolve({status:res.statusCode,body:JSON.parse(text)})}catch(e){reject(e)}})});request.on('error',reject);request.on('timeout',()=>request.destroy(Error('fixture timeout')));request.end(payload);});
    const created=await call('/api/apps','POST',{name:'Fresh database fixture',type:'node',repoUrl:repo,branch:'main',storageGB:'1'});
    assert.equal(created.status,200,JSON.stringify(created));id=created.body.id;
    const dir=path.join(apps,id),read=()=>dotenv.parse(fs.readFileSync(path.join(dir,'.env')));
    const first=read();assert.equal(first.WAREHOUSE_SECRET.length,64);assert(first.SQL_CONNECTION);assert(!first.PUBLIC_HOST);
    const parsed=new URL(first.SQL_CONNECTION);assert.equal(parsed.hostname,'warehouse');assert.equal(parsed.password,first.WAREHOUSE_SECRET);assert.equal(parsed.pathname,'/fixture_records');
    assert(!JSON.stringify(created.body).includes(first.WAREHOUSE_SECRET));
    assert.deepEqual(created.body.plan.blockers.filter(b=>b.code==='REQUIRED_ENV').map(b=>b.message.match(/requires (\w+)/)[1]),['PUBLIC_HOST']);
    assert(!created.body.lastDeploy,'creation seeds inputs without launching a database/migration');
    const url='/api/apps/'+id;
    let prepared=await call(url+'/compose-inputs','POST',{});assert.equal(prepared.status,200,JSON.stringify(prepared));assert.equal(prepared.body.changed.length,0);
    const before=fs.readFileSync(path.join(dir,'.env'),'utf8');
    const blocked=await call(url+'/deploy','POST',{source:'local'});assert.equal(blocked.status,409,JSON.stringify(blocked));assert(blocked.body.error.includes('PUBLIC_HOST'));assert(!blocked.body.error.includes('WAREHOUSE_SECRET is missing'));
    assert.equal(fs.readFileSync(path.join(dir,'.env'),'utf8'),before,'hostname failure does not regenerate the database password');
    const configured=await call(url+'/verification','POST',{url:'https://fixture.example.test'});
    assert.equal(configured.status,200,JSON.stringify(configured));assert(!configured.body.provisioningError);
    assert.equal(read().PUBLIC_HOST,'fixture.example.test','configured HTTPS URL automatically satisfies the repository hostname input');
    assert.equal(read().WAREHOUSE_SECRET,first.WAREHOUSE_SECRET);
    // This isolated fixture has no public DNS/TLS endpoint. Remove only that
    // browser target; retain its already prepared hostname for internal checks.
    assert.equal((await call(url+'/verification','POST',{url:null})).status,200);
    let deployed=await call(url+'/deploy','POST',{source:'local'});
    if(deployed.status!==200)throw Error(JSON.stringify(deployed)+'\n'+fs.readFileSync(path.join(dir,'deploy.log'),'utf8').slice(-8000));
    const ids=docker(['ps','-a','-q','--filter','label=com.docker.compose.project='+id]).trim().split(/\s+/);let cs=JSON.parse(docker(['inspect',...ids]));
    const db=cs.find(c=>c.Config.Labels['com.docker.compose.service']==='warehouse');
    assert(db.Config.Env.includes('POSTGRES_PASSWORD='+first.WAREHOUSE_SECRET));
    assert.equal(docker(['exec',db.Id,'psql','-U','fixture_user','-d','fixture_records','-Atc','SELECT total FROM fixture_runs']).trim(),'1');
    let status=(await call(url+'/status')).body;assert(status.lastDeploy.verification.ok);assert(status.lastDeploy.verification.pages[0].api.some(r=>r.status===200));
    assert((await call(url+'/deployment-plan')).body.provisioning.some(a=>a.key==='SQL_CONNECTION'));
    const encodedReport=JSON.stringify((await call(url+'/deployment-plan')).body);
    assert(!encodedReport.includes(first.WAREHOUSE_SECRET)&&!encodedReport.includes(first.SQL_CONNECTION),'plan responses never echo generated credentials');
    console.log('LIVE PASS: create seeded a private password/URL; PostgreSQL initialized, migration ran once, API authenticated and browser verification passed');
    deployed=await call(url+'/deploy','POST',{source:'local'});assert.equal(deployed.status,200,JSON.stringify(deployed));
    assert.equal(read().WAREHOUSE_SECRET,first.WAREHOUSE_SECRET);assert.equal(read().SQL_CONNECTION,first.SQL_CONNECTION);
    assert.equal(docker(['exec',db.Id,'psql','-U','fixture_user','-d','fixture_records','-Atc','SELECT total FROM fixture_runs']).trim(),'2');
    console.log('LIVE PASS: redeploy preserved the same database, password and URI; no credential rotation or extra migration replay');
  }finally{
    if(child&&child.exitCode===null)child.kill();if(exit)await exit;
    if(id){try{const ids=docker(['ps','-a','-q','--filter','label=com.docker.compose.project='+id]).trim().split(/\s+/).filter(Boolean);if(ids.length)docker(['rm','-f',...ids]);}catch{}
      for(const kind of ['network','volume'])try{for(const name of docker([kind,'ls','-q','--filter','label=com.docker.compose.project='+id]).trim().split(/\s+/).filter(Boolean))docker([kind,'rm',name]);}catch{}
      try{const images=docker(['image','ls','-q','--filter','label=com.docker.compose.project='+id]).trim().split(/\s+/).filter(Boolean);if(images.length)docker(['image','rm',...new Set(images)]);}catch{}
    }
    fs.rmSync(temp,{recursive:true,force:true});
  }
}
main().catch(e=>{console.error(e);process.exitCode=1});
