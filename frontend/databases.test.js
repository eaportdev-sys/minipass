const assert=require('assert'),fs=require('fs'),path=require('path'),vm=require('vm');
const els=new Map();const element=id=>{if(!els.has(id))els.set(id,{innerHTML:'',textContent:'',style:{}});return els.get(id)};
const context=vm.createContext({currentApp:'test',document:{getElementById:element},location:{hostname:'localhost'},fetch:async()=>({json:async()=>({repositoryOwned:true,databases:[{type:'postgres',label:'PostgreSQL',service:'warehouse',state:'running',repositoryOwned:true,tool:'pgAdmin'}]})})});
vm.runInContext(fs.readFileSync(path.join(__dirname,'databases.js'),'utf8'),context);vm.runInContext(fs.readFileSync(path.join(__dirname,'migrations.js'),'utf8'),context);
const deploy=fs.readFileSync(path.join(__dirname,'deploy.js'),'utf8');vm.runInContext(deploy.slice(deploy.indexOf('function runtimeKind('),deploy.indexOf('function runtimeVersion(')),context);
async function main(){
  await vm.runInContext('loadDatabases()',context);assert.equal(element('dbAddRow').style.display,'none');assert(element('dbRuntimeList').innerHTML.includes('PostgreSQL')&&element('dbRuntimeList').innerHTML.includes('launch pgAdmin'));
  assert(!element('dbRuntimeList').innerHTML.includes('No managed databases'));
  context.fetch=async()=>({json:async()=>({repositoryOwned:true,suggestions:[],tasks:[{name:'initialize',command:'["node","migrate.js"]',state:'exited',exitCode:0,completed:true}]})});
  await vm.runInContext('loadMigrateSuggest()',context);assert.equal(element('manualMigrationControls').style.display,'none');assert(element('migrateSuggest').innerHTML.includes('completed successfully')&&element('migrateSuggest').innerHTML.includes('migrate.js'));assert(!element('migrateSuggest').innerHTML.includes('run now'));
  assert.equal(vm.runInContext('runtimeKind({role:"task"},null)',context),'Deployment task','completed jobs are not misidentified as broken supporting containers');
  console.log('Database UI: real repository PostgreSQL/admin action, no generated add form, and completed declared migrations instead of guessed runners: OK');
}
main().catch(e=>{console.error(e);process.exitCode=1});
