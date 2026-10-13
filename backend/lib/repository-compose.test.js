const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const YAML = require('yaml');
const executor = require('./repository-compose');
const browser = require('./browser-verification');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'minipass-execution-'));
const root = path.join(tmp, 'code'); fs.mkdirSync(root);
fs.writeFileSync(path.join(root, 'instructions'), 'services:\n  web:\n    image: nginx\n');
fs.writeFileSync(path.join(tmp, '.env'), 'PUBLIC_DOMAIN=example.test\n');
const id = 'test-executor';
function config() { return { services: {
  db: { image: 'redis:7-alpine', healthcheck: { test: ['CMD', 'redis-cli', 'ping'] }, networks: { internal: null } },
  migrate: { image: 'redis:7-alpine', command: ['redis-cli', '-h', 'db', 'INCR', 'schema'], depends_on: { db: { condition: 'service_healthy' } }, networks: { internal: null } },
  web: { image: 'nginx:alpine', environment: { APP_ORIGIN: 'https://example.test', SECRET: 'private' }, ports: [{ target: 80, published: '3000' }], depends_on: { migrate: { condition: 'service_completed_successfully' } }, networks: { internal: null } }
}, networks: { internal: { name: 'arbitrary-global' } }, volumes: {} }; }
function container(name, status = 'running', exit = 0) { return { Id: name.padEnd(64, 'a'), Image: 'sha256:' + 'a'.repeat(64), Config: { Image: name === 'db' ? 'redis:7-alpine' : 'nginx:alpine', Env: ['SECRET=old-secret'], Labels: { 'com.docker.compose.service': name } }, Mounts: [], State: { Status: status, Running: status === 'running', Restarting: false, StartedAt: 'fixed', ExitCode: exit, Health: name === 'db' ? { Status: 'healthy' } : undefined } }; }
async function scenario({ failingTask = false, badBrowser = false, before = [], charged = false } = {}) {
  const commands = [], live = new Map(before.map(c => [c.Config.Labels['com.docker.compose.service'], c]));
  const model = executor.prepare(config(), { id, dir: tmp, root, meta: { hostPort: 8000, ...(charged?{storageQuota:{projectId:77}}:{}), deploymentEntrypoint: { file: 'instructions' } }, occupied: [8000] });
  const run = async (bin, args) => {
    commands.push(args);
    if(args[0]==='image'&&args[1]==='inspect')return JSON.stringify([{Config:{Volumes:{'/image-declared':{}}}}]);
    if (args[0] === 'volume') return '';
    if (args[0] === 'ps') return [...live.keys()].map((_, i) => (i + 1).toString(16).padStart(64, '0')).join('\n');
    if (args[0] === 'inspect') return JSON.stringify([...live.values()]);
    return '';
  };
  const logged = async (bin, args) => {
    commands.push(args);
    if (args.includes('up')) {
      const name = args.at(-1);
      if (model.config.services[name]) live.set(name, container(name, name === 'migrate' ? 'exited' : 'running', name === 'migrate' && failingTask ? 1 : 0));
    }
  };
  let result, error;
  try { result = await executor.deploy({ model, compose: ['docker', 'compose'], docker: 'docker', id, dir: tmp, run, logged, sleep: async () => {}, verify: async () => ({ ok: !badBrowser, errors: badBrowser ? ['CSS request failed'] : [], pages: [] }) }); } catch (e) { error = e; }
  return { commands, result, error, model };
}
async function main() {
  let resolvedArgs;
  const resolved = await executor.resolve({ compose: ['docker', 'compose'], id, dir: tmp, root, entrypoint: { file: 'instructions' }, run: async (bin, args, opts) => { resolvedArgs = args; assert(!opts.env.GITHUB_CLIENT_SECRET); return JSON.stringify(config()); } });
  assert(resolvedArgs.includes('--env-file') && resolvedArgs.includes('config') && resolvedArgs.includes('--format'));
  assert.equal(resolved.services.web.environment.APP_ORIGIN, 'https://example.test');
  const good = await scenario();
  assert(!good.error, good.error && good.error.message);
  assert(good.result.verification.ok);
  assert.equal(good.model.config.networks.internal.name, id + '_internal');
  assert.equal(good.model.config.services.web.ports[0].published, '8001');
  assert.deepEqual(good.model.config.services.migrate.command, config().services.migrate.command);
  const starts = good.commands.filter(a => a.includes('up')).map(a => a.at(-1));
  assert.deepEqual(starts, ['db', 'migrate', 'web']);
  assert.equal(starts.filter(n => n === 'migrate').length, 1, 'release task runs exactly once');
  fs.writeFileSync(path.join(tmp,'docker-compose.yml'),YAML.stringify(config()));
  const reused = await scenario({before:[container('db'),{...container('migrate','exited',0),Config:{...container('migrate','exited',0).Config,Image:'redis:7-alpine'}}]});
  assert(!reused.error,reused.error&&reused.error.message);
  assert(reused.result.verification.ok,'a completed task using a database image is not mistaken for the persistent database during redeploy');
  const taskFailure = await scenario({ failingTask: true });
  assert(taskFailure.error && taskFailure.error.message.includes('migrate'));
  assert(!taskFailure.commands.some(a => a.includes('up') && a.at(-1) === 'web'), 'failed migrations cannot start application containers');
  const old = YAML.stringify(config()); fs.writeFileSync(path.join(tmp, 'docker-compose.yml'), old);
  const rollback = await scenario({ badBrowser: true, before: [container('web')] });
  assert(rollback.error.message.includes('previous release restored'));
  assert(rollback.commands.some(a => a.includes('--pull') && a.includes('never')), 'rollback cannot download a different image');
  assert(rollback.commands.some(a=>a.includes('--pull')&&a.includes('--no-deps')), 'rollback cannot restart migration dependencies');
  assert.equal(YAML.parse(fs.readFileSync(path.join(tmp, 'docker-compose.yml'), 'utf8')).services.web.environment.SECRET, 'old-secret');
  fs.writeFileSync(path.join(tmp,'docker-compose.yml'),YAML.stringify({services:{app:{image:'never-built-placeholder'}}}));
  const firstRetry=await scenario({badBrowser:true,before:[container('web')]});
  assert(firstRetry.error.message.includes('CSS request failed'),'first-deploy verification error is retained');
  assert(!firstRetry.commands.some(a=>a.includes('up')&&a.includes('app')),'an unbuilt generated scaffold is not a previous runtime to restore');
  assert(firstRetry.commands.some(a=>a.includes('stop')&&a.includes('web')&&!a.includes('db')),'only failed application/routing services stop; database data remains available');
  const pending = config();
  pending.services.db.container_name = 'global-database';
  const isolated = executor.prepare(pending, { id, dir: tmp, root, meta: { deploymentEntrypoint: { file: 'instructions' } } });
  assert.equal(isolated.config.services.db.container_name, id+'-db');
  const replicated = { config: { services: { web: { deploy: { replicas: 2 } } } }, categories: { web: 'application' } };
  assert.equal(executor.gate([container('web')], replicated).ok,false,'every requested replica must be present');
  const pub = require('./publication');
  const published = executor.prepare(config(), { id, dir: tmp, root, meta: {hostPort:8000,deploymentEntrypoint:{file:'instructions'}} });
  const forwarding = pub.add(published,'minipass/publisher:test',id);
  assert.equal(published.config.services.web.ports.length,0,'publication boundary owns the host port without changing application DNS');
  assert.equal(forwarding[0].service,'web');
  assert.equal(published.config.services[forwarding[0].route].environment.UPSTREAM,'http://web:80');
  assert.equal(published.config.services[forwarding[0].route].environment.RELEASE_ID,published.release);
  fs.copyFileSync(published.file,path.join(tmp,'docker-compose.yml'));
  executor.syncPublishedPorts(tmp,{services:[{name:'web',hostPort:8011}],composePorts:[{service:'web',protocol:'tcp',published:8000}]});
  assert.equal(YAML.parse(fs.readFileSync(path.join(tmp,'docker-compose.yml'),'utf8')).services[forwarding[0].route].ports[0].published,'8011','restore/rebinding updates platform route publication, not the internal service');
  const data = config(); data.services.web.privileged = true;
  assert.throws(() => executor.prepare(data, { id, dir: tmp, root, meta: {} }), /host privileges/);
  const circular = config(); circular.services.db.depends_on = { web: { condition:'service_started' } };
  assert.throws(() => executor.prepare(circular,{id,dir:tmp,root,meta:{}}), /Cyclic/, 'dependency cycles fail before building');
  const noHealth = config(); delete noHealth.services.db.healthcheck;
  assert.throws(() => executor.prepare(noHealth,{id,dir:tmp,root,meta:{}}), /healthcheck/, 'missing readiness rules fail before building');
  const stored = config();stored.volumes.state={};stored.services.db.volumes=[{type:'volume',source:'state',target:'/data'}];
  const charged = executor.prepare(stored,{id,dir:tmp,root,meta:{hostPort:8000,storageQuota:{projectId:77},deploymentEntrypoint:{file:'instructions'}}});
  assert.equal(charged.config.volumes.state.driver_opts.device,path.join(tmp,'.volumes','state').replace(/\\/g,'/'));
  assert(charged.charged,'repository named-volume data belongs to the enforced site allowance');
  assert.throws(() => browser.validPublicUrl('https://user:secret@example.test'), /credentials/);
  const inputs = browser.targetsFor({ services: [{ name: 'web', type: 'static', hostPort: 8000, primary: true }], root, originHost: '10.0.0.1', publicUrl: 'https://example.test' });
  assert.equal(inputs.targets[0].url, 'https://example.test/');
  const overlayFile = path.join(root, 'production.instructions');
  fs.writeFileSync(overlayFile, 'services:\n  web:\n    environment:\n      MODE: production\n');
  let orderedArgs;
  await executor.resolve({ compose: ['docker', 'compose'], id, dir: tmp, root, entrypoint: { file: 'instructions', files: ['instructions', 'production.instructions'] }, run: async (bin, args) => { orderedArgs=args;return JSON.stringify(config()); } });
  assert(orderedArgs.indexOf(overlayFile)>orderedArgs.indexOf(path.join(root,'instructions')), 'overlay order is passed to Compose unchanged');
  fs.writeFileSync(path.join(root,'unsafe'), 'services:\n  web:\n    env_file: ../../panel-private.env\n');
  await assert.rejects(executor.resolve({ compose: ['docker','compose'], id, dir: tmp, root, entrypoint: { file:'unsafe' }, run: async()=>{throw Error('must not execute')} }), /missing or outside/);
  const implicit=await scenario({charged:true});
  assert(!implicit.error,implicit.error&&implicit.error.message);
  assert.equal(Object.keys(implicit.model.config.volumes).length,3,'image-declared anonymous data for every service gets site-owned volumes');
  assert(Object.values(implicit.model.config.volumes).every(v=>v.driver_opts.device.startsWith(path.join(tmp,'.volumes').replace(/\\/g,'/'))));
  console.log('Repository executor: authoritative config, isolated ports/networks, exact commands, migration ordering/failure, browser-failure rollback and host privilege refusal: OK');
}
main().catch(e => { console.error(e); process.exitCode = 1; }).finally(() => fs.rmSync(tmp, { recursive: true, force: true }));
