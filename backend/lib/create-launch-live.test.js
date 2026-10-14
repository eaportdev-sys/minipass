// Linux-only: real Create -> declared base+production Compose -> npm install,
// database/migration -> API, with actual quota assignment and isolated metadata.
const assert=require('assert'),fs=require('fs'),path=require('path'),os=require('os'),net=require('net');
const {spawn,execFileSync}=require('child_process'),{once}=require('events');
const quotas=require('./quotas');
async function main(){
 if(process.platform!=='linux'||process.env.APPS_DIR!=='/srv/apps'||!process.env.QUOTA_SOCKET)throw Error('Use the explicit Linux fixture with real quota socket and site mounts');
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'minipass-create-launch-')),repo=path.join(temp,'source');
 let child,exit,id;
 const docker=args=>execFileSync('docker',args,{encoding:'utf8',maxBuffer:10*1024*1024});
 const put=(file,text)=>{const p=path.join(repo,file);fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,text);};
 try{
  docker(['image','inspect','redis:7-alpine']);docker(['image','inspect','minipass-panel:latest']);assert((await quotas.status()).ready);
  put('package.json',JSON.stringify({name:'generic-fixture',version:'1.0.0',scripts:{start:'node server.js','docker:dev':'docker-compose -f docker-compose.yml -f docker-compose.dev.yml up','docker:prod':'docker-compose -f docker-compose.yml -f docker-compose.prod.yml up','docker:test':'docker-compose -f docker-compose.yml -f docker-compose.test.yml up'}}));
  put('package-lock.json',JSON.stringify({name:'generic-fixture',version:'1.0.0',lockfileVersion:3,requires:true,packages:{'':{name:'generic-fixture',version:'1.0.0'}}}));
  put('.env.example','REPO_SETTING=preserved-from-repository\n');
  put('Dockerfile','FROM minipass-panel:latest\nWORKDIR /app\nCOPY package.json package-lock.json ./\nRUN npm ci --omit=dev --ignore-scripts\nCOPY server.js ./\nEXPOSE 4187\nCMD ["node","server.js"]\n');
  put('server.js',`const http=require('http'),net=require('net');http.createServer((req,res)=>{if(req.url!='/api/ready'){res.statusCode=404;return res.end('not found')}const c=net.connect(6379,'db');c.on('connect',()=>c.write('*2\\r\\n$3\\r\\nGET\\r\\n$8\\r\\nmigrated\\r\\n'));c.on('data',data=>{c.end();res.setHeader('Content-Type','application/json');res.end(JSON.stringify({databaseReady:String(data).includes('yes'),mode:process.env.MODE,setting:process.env.REPO_SETTING}))});c.on('error',()=>{res.statusCode=500;res.end('database unavailable')})}).listen(4187,'0.0.0.0');`);
  put('docker-compose.yml',`services:\n  db:\n    image: redis:7-alpine\n    healthcheck: {test: [CMD, redis-cli, ping], interval: 1s, retries: 30}\n    volumes: [state:/data]\n  migrate:\n    image: redis:7-alpine\n    command: [sh, -c, "redis-cli -h db SET migrated yes"]\n    depends_on: {db: {condition: service_healthy}}\n    restart: "no"\n  api:\n    build: .\n    environment:\n      MODE: base\n      REPO_SETTING: \${REPO_SETTING:?}\n    expose: ["4187"]\n    depends_on: {migrate: {condition: service_completed_successfully}}\nvolumes: {state: {}}\n`);
  put('docker-compose.prod.yml','services:\n  api:\n    environment: {MODE: production}\n    command: [node, server.js]\n');
  put('docker-compose.dev.yml','services:\n  api:\n    environment: {MODE: development}\n');put('docker-compose.test.yml','services:\n  api:\n    command: [sh, -c, "exit 9"]\n');
  const git=args=>execFileSync('git',args,{cwd:repo,stdio:'pipe'});git(['init','-b','main']);git(['config','user.name','Fixture']);git(['config','user.email','fixture@example.test']);git(['add','.']);git(['commit','-m','synthetic declared production launch']);
  const listener=net.createServer();listener.listen(0,'127.0.0.1');await once(listener,'listening');const port=listener.address().port;await new Promise(r=>listener.close(r));
  child=spawn(process.execPath,['server.js'],{cwd:path.resolve(__dirname,'..'),env:{...process.env,PORT:String(port),DATA_FILE:path.join(temp,'apps.json'),PANEL_DB_FILE:path.join(temp,'panel.sqlite')},stdio:['ignore','pipe','pipe']});exit=once(child,'exit');let output='';const capture=b=>output=(output+b).slice(-10000);child.stdout.on('data',capture);child.stderr.on('data',capture);
  const base='http://127.0.0.1:'+port;for(let i=0;;i++){try{if((await fetch(base+'/health')).ok)break}catch{}if(i>100)throw Error(output);await new Promise(r=>setTimeout(r,100));}
  const setup=await fetch(base+'/api/panel/setup',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:'fixture-create-launch-password',acceptTerms:true})});assert.equal(setup.status,200);const headers={Cookie:setup.headers.get('set-cookie').split(';')[0],'Content-Type':'application/json'};
  const response=await fetch(base+'/api/apps',{method:'POST',headers,body:JSON.stringify({name:'Initial launch fixture',type:'node',repoUrl:repo,branch:'main',access:'local',storageGB:'0.1'})});const created=await response.json();assert.equal(response.status,200,JSON.stringify(created));id=created.id;assert(created.deploying&&created.storageQuota.enforced);
  assert.deepEqual(created.plan.selected.files,['docker-compose.yml','docker-compose.prod.yml']);
  let status;for(let i=0;i<600;i++){status=await(await fetch(base+'/api/apps/'+id+'/status',{headers})).json();if(status.lastDeploy&&!status.deploying)break;await new Promise(r=>setTimeout(r,500));}
  assert.equal(status.lastDeploy?.status,'ok',JSON.stringify(status.lastDeploy)+'\n'+fs.readFileSync('/srv/apps/'+id+'/deploy.log','utf8').slice(-10000));assert.equal(status.lastDeploy.source,'create');
  const host=process.env.FIXTURE_HOST||'host.docker.internal';const result=await(await fetch('http://'+host+':'+status.app.hostPort+'/api/ready')).json();assert(result.databaseReady&&result.mode==='production'&&result.setting==='preserved-from-repository',JSON.stringify(result));
  const events=(await(await fetch(base+'/api/apps/'+id+'/events',{headers})).json()).events;assert(events.some(e=>e.area==='launch-path'&&e.message.includes('docker-compose.yml + docker-compose.prod.yml')));assert(events.some(e=>e.area==='deploy-create'&&e.message.includes('completed')));
  assert((await quotas.usage(id)).enforced);console.log('LIVE PASS: one Create request, complete production invocation, npm install/build, real quota, completed database task, preserved repository env and database-backed API response; no second Deploy click');
 }finally{
  if(child&&child.exitCode===null)child.kill();if(exit)await exit;
  if(id){try{docker(['compose','-p',id,'-f','/srv/apps/'+id+'/docker-compose.yml','down','-v','--remove-orphans']);}catch{}const images=docker(['image','ls','--format','{{.Repository}}:{{.Tag}}']).trim().split('\n').filter(name=>name.startsWith(id+'-'));for(const image of images){try{docker(['image','rm',image]);}catch{}}for(const dir of ['/srv/apps/'+id,'/srv/apps/.drafts/'+id])if(fs.existsSync(dir))fs.rmSync(dir,{recursive:true,force:true});await quotas.release(id);}
  fs.rmSync(temp,{recursive:true,force:true});
 }
}
main().catch(e=>{console.error(e);process.exitCode=1});
