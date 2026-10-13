const assert=require('assert');const fs=require('fs');const path=require('path');const os=require('os');const YAML=require('yaml');
const tools=require('./db-tools');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'minipass-repo-db-tools-'));
const meta={id:'test-repo-db',db:[]};
const config={name:meta.id,'x-minipass':{executor:'repository-compose'},networks:{private:{name:meta.id+'_private'}},services:{
  warehouse:{image:'postgres:17-alpine',environment:{POSTGRES_USER:'appuser',POSTGRES_DB:'records',POSTGRES_PASSWORD:'existing-password'},networks:{private:null}},
  initialize:{image:'postgres:17-alpine',command:['psql'],depends_on:{warehouse:{condition:'service_healthy'}}},api:{image:'node:24',depends_on:{initialize:{condition:'service_completed_successfully'}}}
}};
function save(){fs.writeFileSync(path.join(dir,'docker-compose.yml'),YAML.stringify(config));}
try{
  save();const connection=tools.databaseConfig(meta,dir,'postgres');
  assert.equal(connection.service,'warehouse');assert.equal(connection.host,'warehouse');assert.equal(connection.network,'test-repo-db_private');
  assert.equal(connection.user,'appuser');assert.equal(connection.db,'records');assert.equal(connection.pass,'existing-password');
  const rows=tools.describe(meta,dir,[{service:'warehouse',state:'running',status:'healthy',image:'postgres:17-alpine'}]);
  assert.equal(rows.length,1);assert.equal(rows[0].state,'running');assert.equal(rows[0].tool,'pgAdmin');assert(rows[0].repositoryOwned);
  assert(!JSON.stringify(rows).includes('existing-password'),'database listing never leaks resolved credentials');
  config.services.other={...config.services.warehouse};save();assert.throws(()=>tools.databaseConfig(meta,dir,'postgres'),/Several postgres/);
  delete config.services.other;config.name='another-site';save();assert.throws(()=>tools.databaseConfig(meta,dir,'postgres'),/not attached/,'a foreign project manifest cannot supply credentials/networks');
  console.log('Repository database UI: actual declared database, credentials/network, completed-task exclusion, runtime state, ambiguity and secret-safe listings: OK');
}finally{fs.rmSync(dir,{recursive:true,force:true});}
