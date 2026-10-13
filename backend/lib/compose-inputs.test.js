const assert=require('assert');
const fs=require('fs');
const path=require('path');
const os=require('os');
const dotenv=require('dotenv');
const vm=require('vm');
const {provision}=require('./compose-inputs');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'minipass-compose-inputs-'));
function fixture(name,services,values=''){
  const dir=path.join(temp,name),root=path.join(dir,'code');fs.mkdirSync(root,{recursive:true});
  fs.writeFileSync(path.join(root,'production.recipe'),require('yaml').stringify({services}));
  fs.writeFileSync(path.join(dir,'.env'),values);
  return {dir,root,selection:{kind:'compose',file:'production.recipe'},meta:{id:name},fresh:true};
}
const pg={image:'postgres:17-alpine',environment:{POSTGRES_DB:'records',POSTGRES_USER:'appuser',POSTGRES_PASSWORD:'${SQL_SECRET:?set password}'},networks:{private:{}}};
const api={image:'node:24',environment:{DATABASE_URL:'${BACKEND_CONNECTION:?set connection}',APP_ORIGIN:'https://${PUBLIC_HOST:?set hostname}'},depends_on:{migrate:{condition:'service_completed_successfully'}},networks:{private:{}}};
const migrate={image:'node:24',environment:{DATABASE_URL:'${BACKEND_CONNECTION:?set connection}'},depends_on:{database:{condition:'service_healthy'}},networks:{private:{}}};
const read=f=>dotenv.parse(fs.readFileSync(path.join(f.dir,'.env')));
try{
  const f=fixture('fresh',{database:pg,migrate,api});
  const result=provision(f),env=read(f);
  assert.equal(result.issues.length,0);
  assert.equal(env.SQL_SECRET.length,64);
  const url=new URL(env.BACKEND_CONNECTION);
  assert.equal(url.hostname,'database');assert.equal(url.port,'5432');assert.equal(url.username,'appuser');assert.equal(url.password,env.SQL_SECRET);assert.equal(url.pathname,'/records');
  assert(!env.PUBLIC_HOST&&!env.APP_ORIGIN,'no hostname or computed service origin is invented');
  assert(!JSON.stringify(result).includes(env.SQL_SECRET)&&!JSON.stringify(result).includes(env.BACKEND_CONNECTION),'API/report return keys only');
  const before=fs.readFileSync(path.join(f.dir,'.env'),'utf8');
  assert.equal(provision(f).changed.length,0);
  assert.equal(fs.readFileSync(path.join(f.dir,'.env'),'utf8'),before,'retries preserve credentials byte-for-byte');
  assert(!fs.readFileSync(path.join(f.root,'production.recipe'),'utf8').includes(env.SQL_SECRET),'repository instructions are never modified');

  f.meta.publicUrl='https://public.example.test:8443';
  assert(provision(f).changed.includes('PUBLIC_HOST'));assert.equal(read(f).PUBLIC_HOST,'public.example.test:8443');
  assert(!read(f).APP_ORIGIN,'Compose remains responsible for the derived origin');
  const domain=fixture('domain',{database:pg,api:{...api,environment:{APP_ORIGIN:'https://${DOMAIN:?set domain}'}}});domain.meta.publicUrl='https://public.example.test';
  provision(domain);assert.equal(read(domain).DOMAIN,'public.example.test');assert(fs.readFileSync(path.join(domain.dir,'.env'),'utf8').includes('DOMAIN=public.example.test'),'plain canonical domains remain valid/editable in the Environment UI');
  const server=fs.readFileSync(path.resolve(__dirname,'../server.js'),'utf8');
  const stored={id:'domain',domain:'',untouched:'preserved'};
  const context=vm.createContext({fs,path,envDefaults:require('./env-defaults'),cleanDomain:v=>v,load:()=>({apps:[stored]}),save:()=>{}});
  vm.runInContext(server.slice(server.indexOf('function syncProvisionedDomain('),server.indexOf('async function enforceDeploymentPlan(')),context);
  context.syncProvisionedDomain(domain.meta,domain.dir,{changed:['DOMAIN']});
  assert.equal(stored.domain,'public.example.test');assert.equal(domain.meta.domain,stored.domain);assert.equal(stored.untouched,'preserved','generated DOMAIN synchronizes site metadata without replacing unrelated work');
  const http=fixture('http',{database:pg,migrate,api});http.meta.publicUrl='http://10.0.0.1:8000';
  provision(http);assert(!read(http).PUBLIC_HOST,'HTTP routing cannot satisfy an HTTPS declaration');
  const provider=fixture('provider',{database:pg,api:{...api,environment:{EXTERNAL_PROVIDER_URL:'https://${PROVIDER_TOKEN:?set provider}'}}});provider.meta.publicUrl='https://public.example.test';
  provision(provider);assert(!read(provider).PROVIDER_TOKEN,'public website configuration must not invent external-provider credentials');

  const external=fixture('external',{database:pg,migrate,api},'SQL_SECRET=kept\nBACKEND_CONNECTION=postgresql://external:private@outside.example.test:6543/remote\nPUBLIC_HOST=custom.example.test\n');
  assert.equal(provision(external).changed.length,0,'explicit credentials and external URLs always win');
  const fallback=fixture('fallback',{database:pg,api:{...api,depends_on:{database:{}},environment:{DATABASE_URL:'${OPTIONAL_URL:-postgresql://outside.example.test/remote}'}}});
  provision(fallback);assert(!read(fallback).OPTIONAL_URL,'a declared external default must not be overwritten');

  const old=fixture('old',{database:pg,migrate,api});old.fresh=false;
  old.containers=[{Config:{Image:'postgres:17-alpine',Labels:{'com.docker.compose.service':'database'},Env:['POSTGRES_DB=records','POSTGRES_USER=appuser','POSTGRES_PASSWORD=recovered-private-password']}}];
  const recovered=provision(old);assert(recovered.changed.includes('SQL_SECRET'));assert.equal(read(old).SQL_SECRET,'recovered-private-password');
  assert.equal(new URL(read(old).BACKEND_CONNECTION).password,'recovered-private-password','matching existing database credentials are reused, not rotated');
  assert(!JSON.stringify(recovered).includes('recovered-private-password'));

  const volume=fixture('volume',{database:pg,migrate,api});volume.fresh=false;volume.volumes=['volume_state'];
  assert(provision(volume).issues.length);assert(!read(volume).SQL_SECRET,'unverified retained volumes cannot authorize a new password');
  fs.writeFileSync(path.join(f.dir,'.env'),'');f.meta.publicUrl=null;
  assert(provision(f).issues.length);assert(!read(f).SQL_SECRET,'lost credentials cannot be silently rotated using an initialization retry');
  const corrupt=fixture('corrupt',{database:pg,migrate,api});fs.writeFileSync(path.join(corrupt.dir,'.compose-inputs.json'),'invalid JSON');
  assert(provision(corrupt).issues.length);assert(!read(corrupt).SQL_SECRET,'corrupt initialization state cannot authorize new passwords');
  corrupt.meta.publicUrl='https://public.example.test';provision(corrupt);
  assert(provision(corrupt).issues.length);assert(!read(corrupt).SQL_SECRET,'hostname preparation must not erase a corrupt database-history guard');

  const second={...pg,environment:{...pg.environment,POSTGRES_PASSWORD:'${OTHER_SECRET:?set password}'}};
  const ambiguous=fixture('ambiguous',{database:pg,second,api:{...api,depends_on:{},environment:{DATABASE_URL:'${CHOOSE_CONNECTION:?choose}'}}});
  assert(provision(ambiguous).issues.some(i=>i.message.includes('several reachable')));assert(!read(ambiguous).CHOOSE_CONNECTION,'multiple databases require an explicit association');
  const separate=fixture('separate',{database:pg,api:{...api,depends_on:{database:{}},networks:{other:{}}}});
  provision(separate);assert(!read(separate).BACKEND_CONNECTION,'network isolation is respected');
  const arrayNetwork=fixture('network-list',{database:{...pg,networks:['private']},api:{...api,depends_on:['database'],networks:['other']}});
  provision(arrayNetwork);assert(!read(arrayNetwork).BACKEND_CONNECTION,'short-form network names are not confused with array indexes');
  const bind=fixture('bound-data',{database:{...pg,volumes:['./retained-data:/var/lib/postgresql/data']},migrate,api});
  assert(provision(bind).issues.length);assert(!read(bind).SQL_SECRET,'unverified bind-mounted data cannot authorize a new password');

  const mysql=fixture('mysql',{database:{image:'mysql:8',environment:{MYSQL_DATABASE:'records',MYSQL_USER:'apiuser',MYSQL_PASSWORD:'${APP_DB_PW:?}',MYSQL_ROOT_PASSWORD:'${ADMIN_DB_PW:?}'}},api:{image:'node:24',depends_on:['database'],environment:{DATABASE_URL:'${DB_CONNECTION:?}'}}});
  provision(mysql);const mysqlEnv=read(mysql);assert(mysqlEnv.APP_DB_PW&&mysqlEnv.ADMIN_DB_PW&&mysqlEnv.APP_DB_PW!==mysqlEnv.ADMIN_DB_PW);assert.equal(new URL(mysqlEnv.DB_CONNECTION).password,mysqlEnv.APP_DB_PW);
  const maria=fixture('mariadb',{database:{image:'mariadb:11.8',environment:{MARIADB_ROOT_PASSWORD:'${ROOT_PASSWORD:?}',MYSQL_DATABASE:'records',MYSQL_USER:'apiuser',MYSQL_PASSWORD:'${APP_PASSWORD:?}'}},api:{image:'node:24',depends_on:['database'],environment:{MYSQL_URL:'${DATABASE_CONNECTION:?}'}}});
  provision(maria);assert.equal(new URL(read(maria).DATABASE_CONNECTION).username,'apiuser');assert.equal(new URL(read(maria).DATABASE_CONNECTION).password,read(maria).APP_PASSWORD,'MariaDB compatibility aliases are honored');
  const mongo=fixture('mongo',{database:{image:'mongo:7',environment:{MONGO_INITDB_ROOT_USERNAME:'operator',MONGO_INITDB_ROOT_PASSWORD:'${MONGO_PASSWORD:?}',MONGO_INITDB_DATABASE:'records'}},api:{image:'node:24',depends_on:['database'],environment:{MONGO_URL:'${MONGO_CONNECTION:?}'}}});
  provision(mongo);assert.equal(new URL(read(mongo).MONGO_CONNECTION).searchParams.get('authSource'),'admin');
  const redis=fixture('redis',{cache:{image:'redis:7',command:['redis-server','--requirepass','${CACHE_PASSWORD:?}']},api:{image:'node:24',depends_on:['cache'],environment:{REDIS_URL:'${CACHE_CONNECTION:?}'}}});
  provision(redis);assert(read(redis).CACHE_PASSWORD);assert.equal(new URL(read(redis).CACHE_CONNECTION).password,read(redis).CACHE_PASSWORD);
  const noAuthRedis=fixture('redis-no-auth',{cache:{image:'redis:7'},api:{image:'node:24',depends_on:['cache'],environment:{REDIS_URL:'${CACHE_CONNECTION:?}'}}});
  provision(noAuthRedis);assert.equal(read(noAuthRedis).CACHE_CONNECTION,'redis://cache:6379/0','an explicitly unauthenticated Redis server is not silently given password authentication');
  const quoted=fixture('quoted',{database:pg,migrate,api});quoted.fresh=false;quoted.containers=[{Config:{Image:'postgres:17-alpine',Labels:{'com.docker.compose.service':'database'},Env:["POSTGRES_PASSWORD=quo'te$#space ", 'POSTGRES_USER=appuser','POSTGRES_DB=records']}}];
  provision(quoted);assert.equal(provision(quoted).changed.length,0,'quoted credentials also round-trip without regeneration');

  const overlays=fixture('overlay',{database:pg,api:{...api,depends_on:{database:{}},environment:{DATABASE_URL:'${BASE_URL:?}'}}});
  fs.writeFileSync(path.join(overlays.root,'overlay.yaml'),require('yaml').stringify({services:{api:{environment:{DATABASE_URL:'${PRODUCTION_URL:?}'}}}}));
  overlays.selection.files=['production.recipe','overlay.yaml'];provision(overlays);assert(read(overlays).PRODUCTION_URL&&!read(overlays).BASE_URL,'later overlay environment wins');
  const include=fixture('includes',{database:pg,migrate,api});fs.appendFileSync(path.join(include.root,'production.recipe'),'include: [other.yaml]\n');
  const included=provision(include);assert(included.warnings.length);assert(!included.changed.length,'partial include models cannot authorize automatic database inputs');
  const sourceDefault=fixture('source-default',{database:pg,migrate,api});fs.writeFileSync(path.join(sourceDefault.root,'.env'),'SQL_SECRET=source-password\nBACKEND_CONNECTION=postgresql://explicit.example.test/source\n');
  assert(!provision(sourceDefault).changed.length,'repository .env credentials and URLs are preserved');
  const short=fixture('short-reference',{database:{...pg,environment:{...pg.environment,POSTGRES_PASSWORD:'$DB_SECRET'}},api:{...api,depends_on:['database'],environment:{DATABASE_URL:'$DB_LINK'}}});
  provision(short);assert.equal(new URL(read(short).DB_LINK).password,read(short).DB_SECRET,'unbraced interpolation references are also supported');
  console.log('Compose input provisioning: declared passwords/URLs, fresh/retry/recovery safety, external defaults, ambiguity, networks, overlays and configured origins: OK');
}finally{fs.rmSync(temp,{recursive:true,force:true});}
