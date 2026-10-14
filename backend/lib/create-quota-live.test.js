// Explicit Linux verification against the real host quota socket. Synthetic
// source only; never deploys containers or reads/migrates another site's data.
const assert=require('assert'),fs=require('fs'),path=require('path'),os=require('os'),net=require('net');
const {spawn,execFileSync}=require('child_process'),{once}=require('events');
const quotas=require('./quotas');
async function main(){
  if(process.platform!=='linux'||process.env.APPS_DIR!=='/srv/apps'||!process.env.QUOTA_SOCKET)throw new Error('Run inside the isolated Linux quota fixture with its explicit host mounts');
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'minipass-create-quota-')),data=path.join(temp,'apps.json'),repo=path.join(temp,'source');
  let child,exit,id;const apps=process.env.APPS_DIR;
  try{
    assert((await quotas.status()).ready,'real host quota enforcement must be active');
    fs.mkdirSync(repo);fs.writeFileSync(data,'{"apps":[]}');
    fs.writeFileSync(path.join(repo,'Dockerfile'),'FROM nginx:alpine\nEXPOSE 80\n');fs.writeFileSync(path.join(repo,'index.html'),'<h1>Synthetic quota fixture</h1>');
    fs.mkdirSync(path.join(repo,'nested'));fs.writeFileSync(path.join(repo,'nested','source.bin'),Buffer.alloc(1024*1024,65));
    const git=args=>execFileSync('git',args,{cwd:repo,stdio:'pipe'});git(['init','-b','main']);git(['config','user.name','Fixture']);git(['config','user.email','fixture@example.test']);git(['add','.']);git(['commit','-m','synthetic source']);
    const listener=net.createServer();listener.listen(0,'127.0.0.1');await once(listener,'listening');const port=listener.address().port;await new Promise(r=>listener.close(r));
    child=spawn(process.execPath,['server.js'],{cwd:path.resolve(__dirname,'..'),env:{...process.env,PORT:String(port),DATA_FILE:data,PANEL_DB_FILE:path.join(temp,'panel.sqlite')},stdio:['ignore','pipe','pipe']});exit=once(child,'exit');
    let output='';child.stdout.on('data',b=>output=(output+b).slice(-10000));child.stderr.on('data',b=>output=(output+b).slice(-10000));
    const base='http://127.0.0.1:'+port;
    for(let i=0;;i++){try{if((await fetch(base+'/health')).ok)break;}catch{}if(i>100)throw Error(output);await new Promise(r=>setTimeout(r,100));}
    const setup=await fetch(base+'/api/panel/setup',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:'synthetic-quota-fixture-only',acceptTerms:true})});assert.equal(setup.status,200);
    const headers={Cookie:setup.headers.get('set-cookie').split(';')[0],'Content-Type':'application/json'};
    const call=async(url,body)=>{const r=await fetch(base+url,{method:'POST',headers,body:JSON.stringify(body)});return {status:r.status,data:await r.json()};};
     const body={name:'Quota source fixture',type:'static',repoUrl:repo,branch:'main',access:'local',enforceStorage:true,storageGB:'0.1',launch:false};
    const prepared=await call('/api/apps',{...body,prepareOnly:true});assert.equal(prepared.status,200,JSON.stringify(prepared));id=prepared.data.pendingId;
    const dir=path.join(apps,id),staged=path.join(apps,'.drafts',id);
    assert(!fs.existsSync(dir)&&fs.existsSync(path.join(staged,'code','index.html')));
    await assert.rejects(quotas.usage(id),e=>e.status===404,'preview has no site allocation yet');
    // Exactly reproduce the older panel's untracked in-place preview.
    fs.renameSync(staged,dir);
    await assert.rejects(quotas.reserve(id,100000000),e=>e.status===409&&e.message.includes('Existing site data'),'the unchanged host guard must still reject this layout');
    const created=await call('/api/apps',{...body,pendingId:id});assert.equal(created.status,200,JSON.stringify(created));
    assert(created.data.storageEnforced&&created.data.storageQuota.projectId,'this cannot pass through an unenforced fallback');
    const usage=await quotas.usage(id);assert(usage.enforced&&usage.usedBytes>=1024*1024);
    const getProjects=execFileSync('python3',['-c',
      "import os,fcntl,struct,json,sys;out=[]\nfor p in sys.argv[1:]:\n fd=os.open(p,os.O_RDONLY|os.O_NOFOLLOW);out.append(struct.unpack('=IIIII8s',fcntl.ioctl(fd,0x801c581f,bytes(28)))[3]);os.close(fd)\nprint(json.dumps(out))",
      dir,path.join(dir,'code'),path.join(dir,'code','nested','source.bin')],{encoding:'utf8'});
    assert.deepEqual(JSON.parse(getProjects),[usage.projectId,usage.projectId,usage.projectId],'source descendants must inherit the actual kernel project quota, not remain uncharged');
    assert(!fs.existsSync(staged));assert(fs.readFileSync(path.join(dir,'code','nested','source.bin')).equals(Buffer.alloc(1024*1024,65)));
    assert(!created.data.lastDeploy&&!created.data.deploying,'this explicit save-only quota fixture does not launch containers');
    console.log('LIVE PASS: reproduced the exact enforced-host refusal, recovered a legacy source-only draft, created the site, verified source-file kernel project IDs and shared hard-limit accounting; no migration/container deployment');
  }finally{
    if(child&&child.exitCode===null)child.kill();if(exit)await exit;
    if(id){for(const dir of [path.join(apps,id),path.join(apps,'.drafts',id)])if(fs.existsSync(dir))fs.rmSync(dir,{recursive:true,force:true});await quotas.release(id);}
    fs.rmSync(temp,{recursive:true,force:true});
  }
}
main().catch(e=>{console.error(e);process.exitCode=1});
