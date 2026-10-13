// Execute the repository's resolved Compose model, not a translated set of
// guessed panel services. All processes use argv; config secrets stay in 0600
// release manifests, never metadata/API responses. Compose owns interpolation,
// command/entrypoint semantics, health dependencies and networking.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const YAML = require('yaml');
const { sourceFile } = require('./repository-files');
const { nextFreePort } = require('./ports');
const { detectServiceType } = require('./services');
const { inferPort } = require('./generator');

const validName = n => /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(n || '');
const databaseImage = image => /(?:^|\/)(?:postgres|mysql|mariadb|mongo|redis)(?=[:@]|$)/i.test(image || '');
const adminImage = image => /^(?:dpage\/pgadmin4|phpmyadmin|mongo-express|rediscommander\/redis-commander)(?=[:@]|$)/.test(image || '');
const slash = p => p.replace(/\\/g, '/');
function cliEnv() {
  return Object.fromEntries(Object.entries(process.env).filter(([k]) => /^(?:PATH|HOME|USERPROFILE|SystemRoot|COMSPEC|PATHEXT|TEMP|TMP|LANG|LC_ALL|DOCKER_.*|BUILDKIT_.*|HTTP_PROXY|HTTPS_PROXY|NO_PROXY)$/i.test(k)));
}
function composeArgs(compose, id, file, directory) {
  return [...compose.slice(1), '-p', id, '--project-directory', directory, '-f', file];
}
function roles(config) {
  const shots = new Set();
  for (const s of Object.values(config.services)) for (const [name, dep] of Object.entries(s.depends_on || {})) {
    if (dep && dep.condition === 'service_completed_successfully') shots.add(name);
  }
  return Object.fromEntries(Object.entries(config.services).map(([name, s]) => [name, s['x-minipass'] && s['x-minipass'].role === 'routing' ? 'routing' : shots.has(name) ? 'task' : databaseImage(s.image) ? 'database' : 'application']));
}
function publicServices(config, root) {
  const categories = roles(config);
  return Object.entries(config.services).map(([name, s]) => {
    const folder = s.build && typeof s.build.context === 'string' ? path.relative(root, s.build.context) : '';
    let type = 'node';
    try { type = s.build ? detectServiceType(s.build.context).type || 'node' : /nginx|httpd|caddy/.test(s.image || '') ? 'static' : 'node'; } catch {}
    const published = (s.ports || []).find(p => (p.protocol || 'tcp') === 'tcp');
    let frontend = ['static', 'react', 'php'].includes(type);
    try { const pkg = JSON.parse(fs.readFileSync(path.join(s.build.context, 'package.json'), 'utf8')); const d = { ...pkg.dependencies, ...pkg.devDependencies }; frontend = frontend || !!(d.next || d.nuxt || d.react || d.vue || d.svelte || d['@angular/core']); } catch {}
    return { name, role: categories[name], type, subdir: slash(folder), dockerfile: s.build && s.build.dockerfile || null,
      port: published ? Number(published.target) : Number((s.expose || [])[0]) || null,
      hostPort: published ? Number(published.published) : null, enabled: true, repositoryOwned: true, frontend,
      scheme: published && published.app_protocol === 'https' ? 'https' : 'http',
      publishedPorts: (s.ports || []).map(p => ({ target: Number(p.target), published: Number(p.published), protocol: p.protocol || 'tcp' })) };
  });
}
function privateWrite(file, config) { fs.writeFileSync(file, YAML.stringify(config), { mode: 0o600 }); fs.chmodSync(file, 0o600); }
function safeModel(config, root) {
  if (!config || !config.services || !Object.keys(config.services).length) throw new Error('Compose resolved no services');
  const visiting = new Set(), visited = new Set();
  const dependencies = name => {
    if (visited.has(name)) return;
    if (visiting.has(name)) throw new Error('Cyclic repository service dependencies');
    const s = config.services[name];
    if (!s) throw new Error(`Repository dependency '${name}' is not enabled`);
    visiting.add(name);
    for (const [dep, requirement] of Object.entries(s.depends_on || {})) {
      const condition = requirement.condition || 'service_started';
      if (!['service_started','service_healthy','service_completed_successfully'].includes(condition)) throw new Error(`Service '${name}' declares an unsupported dependency condition`);
      dependencies(dep);
      if (condition === 'service_healthy' && (!config.services[dep].healthcheck || config.services[dep].healthcheck.disable)) throw new Error(`Dependency '${dep}' requires health but has no enabled healthcheck`);
    }
    visiting.delete(name);visited.add(name);
  };
  for (const name of Object.keys(config.services)) dependencies(name);
  for (const [name, s] of Object.entries(config.services)) {
    if (!validName(name)) throw new Error('Unsupported Compose service name');
    if (s.privileged || s.network_mode === 'host' || s.pid === 'host' || s.ipc === 'host' || s.devices && s.devices.length || s.cap_add && s.cap_add.length || (s.security_opt || []).some(o => /unconfined/i.test(o))) throw new Error(`Service '${name}' requests host privileges/devices; this requires a separate explicitly approved host setup`);
    if (s.build && s.build.context && (!path.isAbsolute(s.build.context) || !path.resolve(s.build.context).startsWith(path.resolve(root) + path.sep) && path.resolve(s.build.context) !== path.resolve(root))) throw new Error(`Service '${name}' build context is outside the checkout`);
    if (s.build && (s.build.network === 'host' || (s.build.entitlements || []).length)) throw new Error(`Service '${name}' build requests host/insecure entitlements; it needs explicit host approval`);
    if (s.build && !s.build.dockerfile_inline) {
      const recipe = path.resolve(s.build.context, s.build.dockerfile || 'Dockerfile');
      if (!sourceFile(root, slash(path.relative(root, recipe)))) throw new Error(`Service '${name}' references a missing or out-of-checkout Dockerfile`);
    }
    for (const context of Object.values(s.build && s.build.additional_contexts || {})) {
      if (typeof context === 'string' && !/^(?:service:|docker-image:|https:\/\/)/.test(context)) {
        let real = null; try { real = fs.realpathSync(context); } catch {}
        if (!real || real !== fs.realpathSync(root) && !real.startsWith(fs.realpathSync(root)+path.sep)) throw new Error(`Service '${name}' has an additional build context outside the checkout`);
      }
    }
    for (const v of s.volumes || []) {
      if (v.type === 'bind') {
        const resolved = path.resolve(v.source);
        if (resolved !== path.resolve(root) && !resolved.startsWith(path.resolve(root) + path.sep)) throw new Error(`Service '${name}' binds a path outside the checkout; the panel will not mount host secrets or Docker sockets`);
      }
    }
  }
  for (const [name, n] of Object.entries(config.networks || {})) if (n.external) throw new Error(`External network '${name}' requires explicit cross-site networking; use repository-owned networks`);
  for (const [name, v] of Object.entries(config.volumes || {})) {
    if (!validName(name)) throw new Error('Unsupported volume name');
    if (v.external) throw new Error(`External volume '${name}' requires an explicit data import; site volumes are isolated`);
    if (v.driver && v.driver !== 'local' || v.driver_opts && Object.keys(v.driver_opts).length) throw new Error(`Custom storage driver/options for '${name}' require an explicitly approved storage import; repository Compose cannot mount arbitrary host data`);
  }
  for (const [name, d] of [...Object.entries(config.configs || {}), ...Object.entries(config.secrets || {})]) {
    if (d.external) throw new Error(`External config/secret '${name}' must be imported into the site explicitly`);
    if (d.file && (!path.resolve(d.file).startsWith(path.resolve(root) + path.sep))) throw new Error(`Config/secret '${name}' refers to a file outside the checkout`);
  }
}
async function inferImagePorts(config, { docker, run, logged }) {
  const categories = roles(config);
  for (const [name, s] of Object.entries(config.services)) {
    if (s.build || categories[name] !== 'application' || (s.ports || []).length || (s.expose || []).length || s.environment && s.environment.PORT) continue;
    let inspected;
    try { inspected = JSON.parse(String(await run(docker, ['image', 'inspect', s.image])))[0]; }
    catch {
      if (adminImage(s.image) || s.pull_policy === 'never') throw new Error(`Image '${s.image}' must be installed explicitly before deployment`);
      await logged(docker, ['pull', s.image]);
      inspected = JSON.parse(String(await run(docker, ['image', 'inspect', s.image])))[0];
    }
    const ports = Object.keys(inspected.Config.ExposedPorts || {}).filter(p => p.endsWith('/tcp')).map(p => Number(p.split('/')[0]));
    if (ports.length === 1) s.expose = [String(ports[0])];
    else if (ports.length > 1) throw new Error(`Image '${name}' exposes several ports; declare the intended ports/expose/PORT rather than guessing`);
  }
}
function prepare(config, { id, dir, root, meta, occupied = [] }) {
  safeModel(config, root);
  const release = crypto.randomBytes(8).toString('hex');
  config.name = id;
  config['x-minipass'] = { executor: 'repository-compose' };
  const used = new Set(occupied.map(Number));
  const prior = meta.composePorts || [];
  const published = [];
  const categories = roles(config);
  const descriptions = publicServices(config, root);
  const ordered = Object.entries(config.services).sort(([a], [b]) => {
    const score = n => categories[n] === 'application' ? descriptions.find(s => s.name === n).frontend ? 0 : 1 : 2;
    return score(a) - score(b);
  });
  const hasPublicApp = ordered.some(([n, s]) => categories[n] === 'application' && (s.ports || []).length);
  const autoPublic = !hasPublicApp ? (ordered.find(([n]) => categories[n] === 'application') || [])[0] : null;
  for (const [name, s] of ordered) {
    if (s.container_name) s.container_name = `${id}-${name}`;
    // Build tags are site/release owned. Never overwrite a repository's global
    // image tag (which might also be used by another site's live containers).
    if (s.build && categories[name]==='database') throw new Error(`Database '${name}' uses a built image; pin a versioned database image or perform an explicit database image/data upgrade instead of silently replacing it`);
    if (s.build) s.image = `${id}-${name.toLowerCase()}-${crypto.createHash('sha256').update(name).digest('hex').slice(0, 6)}:${release}`;
    if (name === autoPublic && !(s.ports || []).length) {
      let port = Number((s.expose || [])[0]) || Number(s.environment && s.environment.PORT) || 0;
      if (!port && s.build) port = inferPort(s.build.context, 0, s.build.dockerfile || 'Dockerfile');
      if (port) s.ports = [{ target: port, protocol: 'tcp', published: '0' }];
    }
    for (let i = 0; i < (s.ports || []).length; i++) {
      const port = s.ports[i];
      if (!Number.isInteger(Number(port.target)) || Number(port.target) < 1 || Number(port.target) > 65535) throw new Error(`Service '${name}' has an invalid/unresolved container port`);
      const protocol = port.protocol || 'tcp';
      const old = prior.find(p => p.service === name && p.target === Number(port.target) && p.protocol === protocol && p.index === i);
      const want = old ? old.published : published.length === 0 ? meta.hostPort || 8000 : Number(port.published) || 8000;
      const paired = published.find(p => p.service === name && p.target === Number(port.target) && p.protocol !== protocol && p.declared === port.published);
      const host = paired ? paired.published : nextFreePort(want, used, 8000, 8999);
      if (!host) throw new Error('No free app publication port remains in 8000–8999');
      used.add(host);
      const declared = port.published;
      port.published = String(host);
      published.push({ service: name, target: Number(port.target), published: host, protocol, index: i, declared: old ? old.declared : declared });
    }
  }
  // Force only resource isolation, not service DNS/aliases or topology.
  for (const [name, n] of Object.entries(config.networks || {})) n.name = `${id}_${name}`;
  for (const [name, v] of Object.entries(config.volumes || {})) {
    v.name = `${id}_${name}`;
    if (meta.storageQuota && meta.storageQuota.projectId) {
      if (v.driver && v.driver !== 'local' || v.driver_opts && Object.keys(v.driver_opts).length) throw new Error(`Volume '${name}' has custom storage options that cannot be charged to the site's storage allowance`);
      const folder = path.join(dir, '.volumes', name);
      fs.mkdirSync(folder, { recursive: true });
      v.driver = 'local'; v.driver_opts = { type: 'none', o: 'bind', device: slash(folder) };
    }
  }
  const releases = path.join(dir, '.compose-releases');
  fs.mkdirSync(releases, { recursive: true });
  const file = path.join(releases, release + '.yaml');
  privateWrite(file, config);
  const services = publicServices(config, root);
  return { file, config, release, categories, ports: published, services, root, charged:!!(meta.storageQuota && meta.storageQuota.projectId), directory: path.dirname(sourceFile(root, meta.deploymentEntrypoint.file) || root) };
}
async function resolve({ compose, id, dir, root, entrypoint, run }) {
  const file = sourceFile(root, entrypoint.file);
  if (!file) throw new Error('Selected Compose entrypoint disappeared');
  const directory = path.dirname(file);
  // Validate every Compose input before Compose can read it. In particular,
  // interpolation must not make env_file/include/secret load panel/host secrets.
  const checked = new Set();
  const checkInputs = relative => {
    if (checked.has(relative)) return;
    checked.add(relative);
    const target = sourceFile(root, relative);
    if (!target) throw new Error('Compose input is missing or outside the checkout');
    const doc = YAML.parseDocument(fs.readFileSync(target, 'utf8'), { uniqueKeys: true, merge: true });
    if (doc.errors.length || doc.warnings.length) throw new Error('Compose input has invalid YAML');
    const value = doc.toJS({ maxAliasCount: 100 });
    const inputPath = (p, required = true) => {
      if (typeof p !== 'string' || /[$~]/.test(p) || path.isAbsolute(p)) throw new Error('Compose file inputs must use literal paths inside the checkout');
      const normalized = path.posix.normalize(path.posix.join(path.posix.dirname(relative), p));
      if (!sourceFile(root, normalized) && required) throw new Error(`Compose file input '${normalized}' is missing or outside the checkout`);
      return normalized;
    };
    for (const s of Object.values(value.services || {})) {
      for (const item of [].concat(s.env_file || [])) inputPath(typeof item === 'string' ? item : item.path, typeof item === 'string' || item.required !== false);
      if (s.extends && s.extends.file) checkInputs(inputPath(s.extends.file));
    }
    for (const item of [].concat(value.include || [])) for (const p of [].concat(typeof item === 'string' ? item : item.path || [])) checkInputs(inputPath(p));
    for (const d of [...Object.values(value.configs || {}), ...Object.values(value.secrets || {})]) {
      if (d.file) inputPath(d.file);
      if (d.environment) throw new Error('Compose secret/config inputs must be site-owned files, not panel process environment');
    }
  };
  for (const selected of entrypoint.files || [entrypoint.file]) checkInputs(selected);
  const args = [...compose.slice(1), '-p', id, '--project-directory', directory];
  const repoEnv = sourceFile(directory, '.env');
  if (repoEnv) args.push('--env-file', repoEnv);
  args.push('--env-file', path.join(dir, '.env'));
  for (const profile of entrypoint.profiles || []) args.push('--profile', profile);
  for (const selected of entrypoint.files || [entrypoint.file]) {
    const target = sourceFile(root, selected);
    if (!target) throw new Error('Selected Compose overlay disappeared');
    args.push('-f', target);
  }
  args.push('config', '--format', 'json');
  // Compose, rather than a handwritten interpolator, is authoritative here.
  let output;
  try { output=await run(compose[0],args,{cwd:directory,env:cliEnv()}); }
  catch(e){if(/error while interpolating|missing a value|required variable/i.test(e.message))e.status=409;throw e;}
  const config = JSON.parse(String(output));
  for (const s of Object.values(config.services)) delete s['x-minipass']; // platform roles cannot be supplied by untrusted source
  const profiles = entrypoint.profiles || [];
  for (const [name, s] of Object.entries(config.services)) {
    if (s.profiles && s.profiles.length && !s.profiles.some(p => profiles.includes(p) || profiles.includes('*'))) delete config.services[name];
    else delete s.profiles; // active profile captured in the immutable release
  }
  for (const s of Object.values(config.services)) for (const name of Object.keys(s.depends_on || {})) if (!config.services[name]) {
    if (s.depends_on[name].required === false) delete s.depends_on[name];
    else throw new Error(`An active service depends on '${name}' in an inactive profile; select that profile before deploying`);
  }
  safeModel(config, root);
  return config;
}
async function inspectProject({ id, docker, run }) {
  const ids = String(await run(docker, ['ps', '-a', '-q', '--filter', 'label=com.docker.compose.project=' + id])).trim().split(/\s+/).filter(Boolean);
  if (!ids.length) return [];
  if (ids.some(cid => !/^[a-f0-9]{12,64}$/.test(cid))) throw new Error('Docker returned invalid project container IDs');
  return JSON.parse(String(await run(docker, ['inspect', ...ids])));
}
function gate(containers, model, previous) {
  const current = new Map();
    for (const [name, s] of Object.entries(model.config.services)) {
    const rel = containers.filter(c => c.Config.Labels['com.docker.compose.service'] === name);
    const c = rel[0];
    const replicas = Number(s.deploy && s.deploy.replicas) || 1;
    if (rel.length < replicas) return { ok: false, pending: true, detail: `${name} has ${rel.length}/${replicas} replicas` };
    if (!c) return { ok: false, pending: true, detail: name + ' is missing' };
    if (model.categories[name] === 'task') {
      if (c.State.Status === 'exited' && c.State.ExitCode === 0) continue;
      if (c.State.Status === 'exited') return { ok: false, detail: `${name} failed with exit ${c.State.ExitCode}` };
      return { ok: false, pending: true, detail: name + ' is still running' };
    }
    if (rel.some(c => !c.State.Running || c.State.Restarting || c.State.Health && c.State.Health.Status !== 'healthy')) {
      return { ok: false, pending: !['dead', 'exited'].includes(c.State.Status), detail: `${name}: ${c.State.Health ? c.State.Health.Status : c.State.Status}` };
    }
    for (const c of rel) current.set(c.Id, c.State.StartedAt);
  }
  const steady = previous && current.size === previous.size && [...current].every(([k, v]) => previous.get(k) === v);
  return { ok: !!steady, pending: !steady, current, detail: steady ? 'all runtime services steady and completion tasks exited successfully' : 'waiting for a second steady observation' };
}
async function deploy({ model, compose, docker, id, dir, run, logged, verify, check = () => {}, sleep = ms => new Promise(r => setTimeout(r, ms)), notify = () => {} }) {
  const base = composeArgs(compose, id, model.file, model.directory);
  const action = args => { check(); return logged(compose[0], [...base, ...args], { cwd: dir }); };
  const before = await inspectProject({ id, docker, run });
  const oldFile = path.join(dir, 'docker-compose.yml');
  const oldText = fs.existsSync(oldFile) ? fs.readFileSync(oldFile, 'utf8') : null;
  let swapped = false;
  const tasks = Object.keys(model.categories).filter(n => model.categories[n] === 'task');
  const databases = Object.keys(model.categories).filter(n => model.categories[n] === 'database');
  try {
    for (const s of Object.values(model.config.services)) if (adminImage(s.image)) {
      try { await run(docker, ['image', 'inspect', s.image]); }
      catch { throw new Error('Repository database-admin image is not installed. Install it explicitly first; ordinary deployments never download admin images'); }
      s.pull_policy = 'never';
    }
    privateWrite(model.file, model.config);
    const previousRoles = oldText ? roles(YAML.parse(oldText)) : {};
    for (const old of before.filter(c=>databaseImage(c.Config.Image) && previousRoles[c.Config.Labels['com.docker.compose.service']] !== 'task')) {
      const name = old.Config.Labels['com.docker.compose.service'];
      if (!model.config.services[name] || model.categories[name] !== 'database') throw new Error(`Existing database '${name}' would be removed/replaced by this topology. Import/adopt its data explicitly before changing database service names`);
    }
    // Never silently create a new empty database in place of an existing one,
    // or run a different database version against a kept data directory.
    for (const name of databases) {
      const old = before.find(c => c.Config.Labels['com.docker.compose.service'] === name);
      if (!old) continue;
      const s = model.config.services[name];
      if (old.Config.Image !== s.image) throw new Error(`Database '${name}' image/version changed; use an explicit database upgrade/data migration before deploying`);
      const oldEnv = Object.fromEntries((old.Config.Env || []).map(e=>{const at=e.indexOf('=');return[e.slice(0,at),e.slice(at+1)];}));
      for (const [key,value] of Object.entries(s.environment || {})) if (/PASSWORD|(?:^|_)USER$|(?:^|_)DB$|(?:^|_)DATABASE$|INITDB/i.test(key) && oldEnv[key] !== String(value)) throw new Error(`Database '${name}' initialization/credential input ${key} changed. Use an explicit database credential/data migration; running databases are not silently reinitialized`);
      for (const v of s.volumes || []) if (v.type === 'volume') {
        const actual = (old.Mounts || []).find(m => m.Destination === v.target);
        const expected = model.config.volumes[v.source] && model.config.volumes[v.source].name;
        if (actual && actual.Name !== expected) throw new Error(`Database '${name}' data-volume mapping changed; import/adopt its existing data explicitly (no volume has been erased)`);
      }
    }
    const existingVolumes = new Set(String(await run(docker, ['volume', 'ls', '-q'])).trim().split(/\s+/));
    for (const v of Object.values(model.config.volumes || {})) if (existingVolumes.has(v.name) && v.driver_opts) {
      const actual = JSON.parse(String(await run(docker, ['volume', 'inspect', v.name])))[0];
      if (Object.keys(actual.Options || {}).length !== Object.keys(v.driver_opts).length || Object.entries(v.driver_opts).some(([k,v]) => actual.Options[k] !== v)) throw new Error('Existing volume storage options differ from the site allowance; an explicit data migration is required');
    }
    notify('build');
    await action(['build']); // no injected npm command, build arg or Dockerfile
    const images = Object.entries(model.config.services).filter(([, s]) => !s.build && !adminImage(s.image) && s.pull_policy !== 'never').map(([n]) => n);
    if (images.length) await action(['pull', ...images]);
    if (model.charged) {
      for (const [name,s] of Object.entries(model.config.services)) {
        const info = JSON.parse(String(await run(docker,['image','inspect',s.image])))[0];
        const mounts = s.volumes || (s.volumes=[]);
        const targets = new Set([...Object.keys(info.Config.Volumes || {}),...mounts.filter(v=>v.type==='volume'&&!v.source).map(v=>v.target)]);
        for (const target of targets) {
          const mount = mounts.find(v=>v.target===target);
          if (mount && (mount.type!=='volume'||mount.source)) continue;
          const key = 'image-data-'+crypto.createHash('sha256').update(name+':'+target).digest('hex').slice(0,16);
          const actual = before.find(c=>c.Config.Labels['com.docker.compose.service']===name);
          const existing = actual && (actual.Mounts || []).find(m=>m.Destination===target);
          if (existing && existing.Name!==`${id}_${key}`) throw new Error(`Image-declared data for '${name}' is outside its site allowance; migrate it explicitly before deploying`);
          const folder=path.join(dir,'.volumes',key);fs.mkdirSync(folder,{recursive:true});
          if(existing){const volume=JSON.parse(String(await run(docker,['volume','inspect',existing.Name])))[0];if(!volume.Options||volume.Options.type!=='none'||volume.Options.o!=='bind'||volume.Options.device!==slash(folder))throw new Error(`Image-declared volume for '${name}' is not charged to this site; explicit storage migration is required`);}
          model.config.volumes=model.config.volumes || {};
          model.config.volumes[key]={name:`${id}_${key}`,driver:'local',driver_opts:{type:'none',o:'bind',device:slash(folder)}};
          if(mount)mount.source=key;else mounts.push({type:'volume',source:key,target});
        }
      }
      privateWrite(model.file,model.config);
    }
    check();
    // Topologically start each service once, enforcing the declared dependency
    // condition before its dependent. --no-deps prevents Compose from rerunning
    // an already-completed migration during a later application startup.
    notify('migrations');
    if (tasks.length) await action(['rm', '-s', '-f', ...tasks]);
    const started = new Set(), visiting = new Set();
    const waitFor = async (name, condition) => {
      for (let i = 0; ; i++) {
        check();
        const found = (await inspectProject({ id, docker, run })).find(c => c.Config.Labels['com.docker.compose.service'] === name);
        if (found) {
          if (condition === 'service_completed_successfully' && found.State.Status === 'exited' && found.State.ExitCode === 0) return;
          if (condition === 'service_started' && (found.State.Running || model.categories[name] === 'task' && found.State.Status === 'exited' && found.State.ExitCode === 0)) return;
          if (condition === 'service_healthy' && found.State.Health && found.State.Health.Status === 'healthy') return;
          if (['exited', 'dead'].includes(found.State.Status)) throw new Error(`Repository dependency/task '${name}' failed (${found.State.Status}, exit ${found.State.ExitCode})`);
          if (found.State.Health && found.State.Health.Status === 'unhealthy') throw new Error(`Repository dependency '${name}' is unhealthy`);
          if (condition === 'service_healthy' && !found.State.Health) throw new Error(`Repository dependency '${name}' requires health but declares no healthcheck`);
        }
        if (i >= 120) throw new Error(`Repository dependency '${name}' did not satisfy ${condition} within 240 seconds`);
        await sleep(2000);
      }
    };
    const start = async name => {
      if (started.has(name)) return;
      if (visiting.has(name)) throw new Error('Cyclic repository service dependencies');
      const s = model.config.services[name];
      if (!s) throw new Error(`Repository dependency '${name}' is not enabled`);
      visiting.add(name);
      for (const [dep, requirement] of Object.entries(s.depends_on || {})) {
        await start(dep);
        await waitFor(dep, requirement.condition || 'service_started');
      }
      if (model.categories[name] === 'application') { notify('swap'); swapped = true; }
      await action(['up', '-d', '--no-deps', '--no-build', ...(model.categories[name] === 'database' ? ['--no-recreate'] : []), name]);
      if (model.categories[name] === 'task') await waitFor(name, 'service_completed_successfully');
      visiting.delete(name); started.add(name);
    };
    for (const name of tasks) await start(name);
    for (const name of databases) await start(name);
    for (const name of Object.keys(model.categories).filter(n => !['database', 'task'].includes(model.categories[n]))) await start(name);
    notify('verify');
    let previous;
    for (let i = 0; ; i++) {
      check();
      const state = gate(await inspectProject({ id, docker, run }), model, previous);
      if (state.ok) break;
      if (!state.pending || i >= 40) throw new Error('Repository service verification failed: ' + state.detail);
      previous = state.current;
      await sleep(3000);
    }
    const verification = await verify(model);
    if (!verification.ok) throw new Error('Application verification failed: ' + verification.errors.join('; '));
    privateWrite(oldFile, model.config);
    const orphans = (await inspectProject({ id, docker, run })).filter(c => !model.config.services[c.Config.Labels['com.docker.compose.service']]);
    if (orphans.length) await run(docker, ['rm', '-f', ...orphans.map(c => c.Id)]); // no -v: data retained
    return { verification, tasks };
  } catch (error) {
    // Include task/container output in the persisted deploy log, not credentials
    // in metadata. The adapter redacts all process output before writing it.
    try { await action(['logs', '--no-color', '--tail', '80']); } catch {}
    check(); // a user Stop must never be undone by rollback
    if (swapped) {
      if (before.length && oldText) {
        const rollback = YAML.parse(oldText);
        const oldRoles = roles(rollback);
        for (const c of before) {
          const name = c.Config.Labels['com.docker.compose.service'];
          if (rollback.services[name] && !['database','task'].includes(oldRoles[name])) {
            rollback.services[name].image = c.Image;
            // Legacy generated layouts read the currently edited .env. Restore
            // the old container's actual environment rather than new credentials.
            rollback.services[name].environment = Object.fromEntries((c.Config.Env || []).map(e => { const at = e.indexOf('='); return [e.slice(0, at), e.slice(at + 1)]; }));
            delete rollback.services[name].env_file;
          }
        }
        const rollbackFile = path.join(dir, '.compose-releases', model.release + '-rollback.yaml');
        privateWrite(rollbackFile, rollback);
        const runtimes = Object.keys(rollback.services).filter(n => !['database','task'].includes(oldRoles[n]));
        await logged(compose[0], [...composeArgs(compose, id, rollbackFile, dir), 'up', '-d', '--no-deps', '--no-build', '--pull', 'never', ...runtimes], { cwd: dir });
        const extra = (await inspectProject({ id, docker, run })).filter(c => !rollback.services[c.Config.Labels['com.docker.compose.service']] && model.categories[c.Config.Labels['com.docker.compose.service']] !== 'database');
        if (extra.length) await run(docker, ['rm', '-f', ...extra.map(c => c.Id)]);
        fs.copyFileSync(rollbackFile, oldFile);
        fs.chmodSync(oldFile, 0o600);
        error.message += ' (previous release restored; database migrations are not reversible automatically)';
      } else {
        await action(['stop']);
        error.message += ' (first release stopped; data volumes retained)';
      }
    } else error.message += ' (application containers were not swapped)';
    throw error;
  }
}
function syncPublishedPorts(dir, meta) {
  const file = path.join(dir, 'docker-compose.yml');
  const config = YAML.parse(fs.readFileSync(file, 'utf8'));
  for (const s of meta.services || []) if (s.hostPort && config.services[s.name]) {
    const route = (config['x-minipass'] && config['x-minipass'].routes || []).find(r => r.service === s.name);
    const owner = route ? config.services[route.route] : config.services[s.name];
    const p = (owner.ports || []).find(p => (p.protocol || 'tcp') === 'tcp');
    if (p) p.published = String(s.hostPort);
    if (route) route.published = Number(s.hostPort);
    if (s.publishedPorts && s.publishedPorts.length) s.publishedPorts[0].published = Number(s.hostPort);
    const tracked = (meta.composePorts || []).find(p => p.service === s.name && p.protocol === 'tcp');
    if (tracked) tracked.published = Number(s.hostPort);
  }
  privateWrite(file, config);
  return { normalized: meta.services, services: meta.services.length };
}
module.exports = { resolve, prepare, deploy, gate, roles, publicServices, inspectProject, composeArgs, syncPublishedPorts, cliEnv, inferImagePorts };
