const assert=require('assert'),fs=require('fs'),path=require('path'),vm=require('vm');
const elements=new Map();function element(id){if(!elements.has(id))elements.set(id,{value:'',textContent:'',innerHTML:'',style:{},parentElement:{style:{}},classList:{remove(){},add(){}}});return elements.get(id);}
const calls=[];
const context=vm.createContext({document:{getElementById:element,querySelector:q=>({value:q.includes('apptype')?'node':'local'}),querySelectorAll:()=>[]},safeHtml:t=>String(t).replace(/</g,'&lt;'),toast(){},refresh(){},accessChanged(){}});
vm.runInContext('let createModalSession=1,createBusyOps=0,createPendingId=null,createCleanupPromise=Promise.resolve(),createStandardDockerfile=false,createConnectRequest=0,createDetectRequest=0,createDetectRepo="",createDetectedManager="npm",createStorageAvailable=null,modalLogin=null;function setBuildBusy(on){createBusyOps=Math.max(0,createBusyOps+(on?1:-1));}',context);
vm.runInContext(fs.readFileSync(path.join(__dirname,'create-source.js'),'utf8'),context);
const form=fs.readFileSync(path.join(__dirname,'create-form.js'),'utf8');vm.runInContext(form.slice(form.indexOf('function resetCreateForm('),form.indexOf('function toggleTheme(')),context);
const create=fs.readFileSync(path.join(__dirname,'create.js'),'utf8');vm.runInContext(create.slice(0,create.indexOf('async function detectType(')),context);
const run=s=>vm.runInContext(s,context);const tick=()=>new Promise(r=>setImmediate(r));
const choices=[{kind:'compose',file:'production.recipe'},{kind:'compose',file:'development.recipe'}];
async function main(){
  element('repo').value='https://github.com/owner/project';element('name').value='Example';element('createStorageGB').value='5';element('branch').value='main';
  context.fetch=async(url,opts)=>{const body=opts.body&&JSON.parse(opts.body);calls.push({url,body});if(opts.method==='DELETE')return{json:async()=>({ok:true})};return{json:async()=>({prepared:true,pendingId:'site-draft',repositoryDatabases:body.deploymentEntrypoint?[{service:'warehouse',type:'postgres'}]:[],plan:{candidates:choices,selected:body.deploymentEntrypoint||null,topology:body.deploymentEntrypoint?{services:[{name:'warehouse',image:'postgres:17'}]}:null}})}};
  assert.equal(await run('prepareCreateSource()'),false);
  assert(run('createSourceNeedsChoice()'));assert(element('createBuildBtn').disabled);
  assert(calls[0].body.prepareOnly&&calls[0].body.access==='local','real checkout preparation uses the creation access selection');
  element('createEntrypoint').value='0';await run('createEntrypointChanged()');
  assert.equal(calls.at(-1).body.pendingId,'site-draft');assert.equal(calls.at(-1).body.deploymentEntrypoint.file,'production.recipe');
  assert(element('createDeclaredServices').textContent.includes('PostgreSQL'));assert.equal(element('createGeneratedData').style.display,'none','repository data is not mixed with generated database pills');
  assert(!run('createSourceNeedsChoice()'));assert(!element('createBuildBtn').disabled);
  context.fetch=async(url,opts)=>{calls.push({url,body:JSON.parse(opts.body)});return{json:async()=>({id:'site-registered'})}};
  await run('createApp()');assert.equal(calls.at(-1).body.access,'local');assert.equal(calls.at(-1).body.deploymentEntrypoint.file,'production.recipe');assert(!calls.at(-1).body.prepareOnly,'registration is separate from preparation');
  context.fetch=async(url,opts)=>{calls.push({url,body:opts.body&&JSON.parse(opts.body)});return{json:async()=>({ok:true})}};
  run('closeCreate()');await run('createCleanupPromise');assert.equal(run('createSourcePlan'),null);
  element('repo').value='https://github.com/owner/next';let finish;
  context.fetch=(url,opts)=>{calls.push({url,body:opts.body&&JSON.parse(opts.body)});if(opts.method==='DELETE')return Promise.resolve({json:async()=>({ok:true})});return new Promise(resolve=>{finish=()=>resolve({json:async()=>({prepared:true,pendingId:'site-late',plan:{candidates:choices,selected:null}})})})};
  const pending=run('prepareCreateSource()');await tick();run('closeCreate()');finish();await pending;await run('createCleanupPromise');
  assert(calls.some(c=>c.url==='/api/apps/pending/site-late'),'cancel during inspection cleans only the late, unregistered draft');assert.equal(run('createPendingId'),null);assert.equal(run('createSourcePlan'),null);
  console.log('Create source UI: pre-registration file choice, saved local access, declared databases, busy gate, no repeated selection and late-cancel cleanup: OK');
}
main().catch(e=>{console.error(e);process.exitCode=1});
