// site-configuration: extracted from the original backend without changing route semantics.
module.exports = function createHelpers(ctx) {
  const { APPS_DIR, RELATIONAL_DBS, TEMPLATES_DIR, appDir, dbService, envDefaults, findDockerfiles, fs, normDbs, path, quotas, readEnvVars, resolveServiceDockerfile, svc } = ctx;
  const load = (...args) => ctx.load(...args);
  const refreshDeploymentPlan = (...args) => ctx.refreshDeploymentPlan(...args);
  const save = (...args) => ctx.save(...args);
function cleanDomain(value) {
  const domain = String(value || '').trim().toLowerCase().replace(/\.$/, '');
  if (!domain) return '';
  if (domain.length > 253 || !domain.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) {
    throw new Error('domain must be a hostname only, for example app.example.com (no protocol, path, port, or spaces)');
  }
  return domain;
}

function envMergeManaged(dir, lines) {
  const envPath = path.join(dir, '.env');
  let envText = '';
  try { envText = fs.readFileSync(envPath, 'utf8'); } catch {}
  const have = new Set();
  for (const line of envText.split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=/);
    if (m) have.add(m[1]);
  }
  const fresh = [];
  for (const line of lines) {
    const k = String(line).split('=')[0];
    if (!k || have.has(k)) continue;
    have.add(k);
    fresh.push(line);
  }
  if (!fresh.length) return [];
  fs.writeFileSync(envPath, envText.replace(/\s*$/, '') + '\n' + fresh.join('\n') + '\n');
  try { fs.appendFileSync(path.join(dir, '.env.managed'), fresh.map(l => l.split('=')[0]).join('\n') + '\n'); } catch {}
  return fresh.map(l => l.split('=')[0]);
}

function dbAliasLines(block) {
  if (!block || !block.info || !block.url) return [];
  return [`DB_HOST=${block.info.host}`, `DB_PORT=${block.info.port}`, `DB_NAME=${block.info.name}`, `DB_USER=${block.info.user}`, `DB_PASSWORD=${block.info.pass}`, `DATABASE_URL=${block.url}`];
}

function attachDatabase(meta, type) {
  type = normDbs(type)[0];
  if (!type) throw new Error('unknown database type');
  const db_ = load();
  const stored = db_.apps.find(a => a.id === meta.id);
  if (!stored) throw new Error('unknown app');
  const dir = appDir(APPS_DIR, stored.id);
  const ymlPath = path.join(dir, 'docker-compose.yml');
  if (!fs.existsSync(ymlPath)) throw new Error('app has no compose file');
  const current = normDbs(stored.db);
  if (current.includes(type)) {
    Object.assign(meta, stored);
    return { attached: false, keys: ensureDatabaseAliases(stored) };
  }
  const yml = fs.readFileSync(ymlPath, 'utf8');
  if (yml.includes(`db-${type}:`)) {
    stored.db = [...current, type];
    save(db_);
    Object.assign(meta, stored);
    return { attached: false, keys: ensureDatabaseAliases(stored) };
  }
  const hadRelational = current.some(t => RELATIONAL_DBS.includes(t));
  const safe = stored.id.replace(/[^a-z0-9]/gi, '').toLowerCase() || 'app';
  const b = dbService(type, safe, `db-${type}`, `dbdata-${type}`);
  let out = yml.replace(/\nvolumes:\n/, `\n${b.compose}\nvolumes:\n`);
  if (out === yml) out = yml.replace(/\s*$/, `\n${b.compose}\nvolumes:\n  ${b.vol}:\n`);
  else {
    const start = out.search(/^volumes:[ \t]*\r?$/m);
    const next = out.slice(start).search(/\n(?=[A-Za-z_][A-Za-z0-9_-]*:)/);
    const end = next < 0 ? out.length : start + next + 1;
    out = out.slice(0, end).replace(/\s*$/, '\n') + `  ${b.vol}:\n` + out.slice(end);
  }
  fs.writeFileSync(ymlPath, out);
  if (stored.storageQuota) quotas.bindDatabases(dir);
  const lines = [...b.lines, ...(!hadRelational && RELATIONAL_DBS.includes(type) ? dbAliasLines(b) : [])];
  const keys = envMergeManaged(dir, lines);
  stored.db = [...current, type];
  save(db_);
  Object.assign(meta, stored);
  return { attached: true, keys };
}

function ensureDatabaseAliases(meta) {
  const current = normDbs(meta.db);
  const first = current.find(t => RELATIONAL_DBS.includes(t));
  if (!first) return [];
  const dir = appDir(APPS_DIR, meta.id);
  const env = parseEnvFile(path.join(dir, '.env'));
  if (env.DATABASE_URL && env.DB_HOST && env.DB_USER && env.DB_PASSWORD) return [];
  const prefix = first.toUpperCase();
  const host = env[`${prefix}_HOST`] || (current.length === 1 ? 'db' : `db-${first}`);
  const port = env[`${prefix}_PORT`] || (first === 'postgres' ? '5432' : '3306');
  const name = env[`${prefix}_DB`] || env[`${prefix}_DATABASE`] || meta.id.replace(/[^a-z0-9]/gi, '').toLowerCase() || 'app';
  const user = env[`${prefix}_USER`] || name;
  const pass = env[`${prefix}_PASSWORD`] || env.DB_PASSWORD || '';
  if (!pass) return [];
  const scheme = first === 'postgres' ? 'postgresql' : 'mysql';
  return envMergeManaged(dir, [`DB_HOST=${host}`, `DB_PORT=${port}`, `DB_NAME=${name}`, `DB_USER=${user}`, `DB_PASSWORD=${pass}`, `DATABASE_URL=${scheme}://${user}:${pass}@${host}:${port}/${name}`]);
}

function serviceNameFromSubdir(subdir, used) {
  const base = (subdir || 'app').split('/').filter(Boolean).slice(-2).join('-').toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '') || 'app';
  let name = base === 'app' || !used.has(base) ? base : base + '-svc';
  let i = 2;
  while (used.has(name)) name = `${base}-${i++}`;
  used.add(name);
  return name;
}

function hostPortsInUse() {
  const used = new Set();
  try {
    for (const a of load().apps) {
      if (a.hostPort) used.add(a.hostPort);
      for (const s of (a.services || [])) if (s.hostPort) used.add(s.hostPort);
      for (const t of Object.values(a.dbTools || {})) if (t && t.port) used.add(t.port);
    }
  } catch {}
  return used;
}

function serviceCandidate(meta, dir, input, requireSubdir = false) {
  const name = String((input && input.name) || '').trim().toLowerCase();
  const requestedType = String((input && input.type) || 'auto').trim();
  const rawSubdir = String((input && input.subdir) || '').trim().replace(/\\/g, '/');
  const subdir = rawSubdir.replace(/^\/+|\/+$/g, '');
  if (!svc.validSvcName(name) || name === 'app') return { error: 'use a unique name with lowercase letters, numbers, or dashes' };
  if (!['auto', 'static', 'react', 'node', 'php'].includes(requestedType)) return { error: 'choose a valid service type' };
  if (requireSubdir && !subdir) return { error: 'enter the existing repository subfolder' };
  if (subdir && (subdir.split('/').includes('..') || !/^[A-Za-z0-9._/-]+$/.test(subdir))) return { error: 'subfolder contains unsupported characters' };
  const ctxDir = path.resolve(dir, 'code', subdir);
  const codeRoot = path.resolve(dir, 'code');
  if (ctxDir !== codeRoot && !ctxDir.startsWith(codeRoot + path.sep)) return { error: 'subfolder must stay inside the repository' };
  try { if (!fs.statSync(ctxDir).isDirectory()) return { error: `subfolder '${subdir}' is not a directory` }; }
  catch { return { error: `subfolder '${subdir}' does not exist in the repository` }; }
  const services = svc.fullServices(meta, dir);
  if (services.some(s => s.name === name)) return { error: `service name '${name}' is already used` };
  const folderOwner = services.find(s => (s.subdir || '') === subdir);
  if (folderOwner) return { error: `folder '${subdir || '.'}' already runs as ${folderOwner.name}` };
  const detected = svc.detectServiceType(ctxDir);
  const type = detected.type || (requestedType === 'auto' ? null : requestedType);
  if (!type) return { error: `could not detect a runnable service: ${detected.reason}` };
  // Build file candidates for this folder. An explicit pick is validated;
  // otherwise the effective file resolves automatically (exact Dockerfile,
  // lone variant, legacy-seed heal) or fails loud with names when ambiguous.
  const inputDockerfile = input && input.dockerfile != null && String(input.dockerfile) !== '' ? String(input.dockerfile) : null;
  let dockerfiles = [];
  let dockerfile = null, dockerSource = null;
  try {
    dockerfiles = findDockerfiles(ctxDir);
    const r = resolveServiceDockerfile(ctxDir, inputDockerfile, type, TEMPLATES_DIR);
    if (r) { dockerfile = r.file; dockerSource = r.source; }
  } catch (e) { return { error: e.message, dockerfiles }; }
  return { name, requestedType, subdir, ctxDir, services, detected, type, dockerfiles, dockerfile, dockerSource };
}

function suggestedDefaults(meta) {
  return { ...envDefaults.BUILT_INS };
}

function managedKeys(dir) {
  try {
    const keys = fs.readFileSync(path.join(dir, '.env.managed'), 'utf8').split('\n').map(s => s.trim()).filter(Boolean);
    if (keys.length) return new Set(keys);
  } catch {}
  // legacy apps predate .env.managed: fall back to the closed set of generated names
  return new Set(['APP_NAME', 'APP_TYPE', 'PORT', 'HOST_PORT', 'DOMAIN',
    'DB_HOST', 'DB_PORT', 'DB_NAME', 'DB_USER', 'DB_PASSWORD', 'DATABASE_URL',
    'POSTGRES_HOST', 'POSTGRES_PORT', 'POSTGRES_DB', 'POSTGRES_USER', 'POSTGRES_PASSWORD',
    'MYSQL_HOST', 'MYSQL_PORT', 'MYSQL_DB', 'MYSQL_USER', 'MYSQL_PASSWORD',
    'MONGO_HOST', 'MONGO_PORT', 'MONGO_DB', 'MONGO_USER', 'MONGO_PASSWORD', 'MONGO_URL',
    'REDIS_HOST', 'REDIS_PORT', 'REDIS_PASSWORD', 'REDIS_URL',
    'API_HOST', 'API_PORT']);
}

function envSetManaged(dir, obj) {
  const envPath = path.join(dir, '.env');
  let arr = [];
  try { arr = fs.readFileSync(envPath, 'utf8').split('\n'); } catch {}
  for (const [k, v] of Object.entries(obj)) {
    const i = arr.findIndex(l => new RegExp(`^\\s*${k}\\s*=`).test(l));
    if (i >= 0) arr[i] = `${k}=${v}`;
    else arr.push(`${k}=${v}`);
  }
  fs.writeFileSync(envPath, arr.join('\n').replace(/\s*$/, '') + '\n');
  const mp = path.join(dir, '.env.managed');
  let have = new Set();
  try { have = new Set(fs.readFileSync(mp, 'utf8').split('\n').map(s => s.trim()).filter(Boolean)); } catch {}
  for (const k of Object.keys(obj)) have.add(k);
  try { fs.writeFileSync(mp, [...have].join('\n') + '\n'); } catch {}
}

function envDeleteKeys(dir, keys) {
  const envPath = path.join(dir, '.env');
  let arr = [];
  try { arr = fs.readFileSync(envPath, 'utf8').split('\n'); } catch {}
  const gone = new Set(keys);
  arr = arr.filter(l => {
    const m = l.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    return !(m && gone.has(m[1]));
  });
  fs.writeFileSync(envPath, arr.join('\n').replace(/\s*$/, '') + '\n');
  const mp = path.join(dir, '.env.managed');
  try {
    const kept = fs.readFileSync(mp, 'utf8').split('\n').map(s => s.trim()).filter(s => s && !gone.has(s));
    fs.writeFileSync(mp, kept.join('\n') + '\n');
  } catch {}
}

function applyEnvDefaults(meta, dir, hostname, protocol, requestedKeys) {
  const ownedPlan = refreshDeploymentPlan(meta, dir);
  if (ownedPlan.selected && ownedPlan.selected.kind === 'compose') {
    const folder = path.posix.dirname(ownedPlan.selected.file);
    const snapshot = envDefaults.snapshotDefaults(dir, path.join(dir,'code'), [{ name:'compose-inputs', subdir:folder==='.'?'':folder, type:meta.type, enabled:true }]);
    const envPath = path.join(dir,'.env');
    const present = new Set(readEnvVars(envPath).map(v=>v.key));
    const managed = managedKeys(dir);
    const allowed = Object.keys(snapshot.values).filter(k=>!present.has(k)&&!managed.has(k)&&(!Array.isArray(requestedKeys)||!requestedKeys.length||requestedKeys.includes(k)));
    if (allowed.length) fs.appendFileSync(envPath, '\n# Repository-declared Compose input defaults (review values)\n'+allowed.map(k=>`${k}=${snapshot.values[k]}`).join('\n')+'\n');
    return { added:allowed, updated:[], origins:{frontend:null,backend:null}, defaultSources:snapshot.sources, pending:true, repositoryOwned:true };
  }
  const services = svc.fullServices(meta, dir);
  const origins = envDefaults.publishedOrigins(services, hostname, protocol);
  if (meta && meta.apiBackend && origins.frontend) {
    const target = String(meta.apiBackend.app || '').replace(/^svc:/, '');
    if (services.some(s => s.name === target && s.enabled !== false && !['static', 'react'].includes(s.type))) origins.backend = origins.frontend;
  }
  const snapshot = envDefaults.snapshotDefaults(dir, path.join(dir, 'code'), services);
  const envPath = path.join(dir, '.env');
  const valOf = new Map(readEnvVars(envPath).map(v => [v.key, v.value]));
  const runtimeValues = Object.fromEntries(valOf);
  const resolved = envDefaults.resolvedDefaults(path.join(dir, 'code'), services, origins, snapshot.values, snapshot.originals, runtimeValues);
  const managed = managedKeys(dir);
  const allowed = { ...resolved.values, ...suggestedDefaults(meta) };
  for (const key of managed) delete allowed[key];
  const asked = Array.isArray(requestedKeys) && requestedKeys.length
    ? requestedKeys.filter(k => Object.prototype.hasOwnProperty.call(allowed, k))
    : Object.keys(allowed);
  // Fill missing/empty values. Also repair captured local-development placeholders
  // once the corresponding published frontend/backend service is known.
  const fill = asked.filter(k => !valOf.has(k) || (!String(valOf.get(k)).trim() && String(allowed[k]).trim()));
  const corrected = {};
  for (const k of asked.filter(k => valOf.has(k) && String(valOf.get(k)).trim())) {
    const value = envDefaults.correctedValue(k, valOf.get(k), resolved, origins);
    if (value != null) corrected[k] = value;
  }
  const update = Object.keys(corrected);
  const change = [...new Set([...fill, ...update])];
  if (change.length) {
    let arr = [];
    try { arr = fs.readFileSync(envPath, 'utf8').split('\n'); } catch {}
    for (const k of change) {
      const i = arr.findIndex(l => new RegExp(`^\\s*${k}\\s*=`).test(l));
      const value = Object.prototype.hasOwnProperty.call(corrected, k) ? corrected[k] : allowed[k];
      if (i >= 0) arr[i] = `${k}=${value}`;
      else arr.push(`${k}=${value}`);
    }
    fs.writeFileSync(envPath, arr.join('\n').replace(/\s*$/, '') + '\n');
  }
  return { added: fill, updated: update, origins, defaultSources: snapshot.sources, pending: true };
}

function parseEnvFile(p) {
  const out = {};
  try {
    for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
      const m = line.match(/^([A-Z_]+)=(.*)$/);
      if (m) out[m[1]] = m[2].trim();
    }
  } catch {}
  return out;
}
  return { cleanDomain, envMergeManaged, dbAliasLines, attachDatabase, ensureDatabaseAliases, serviceNameFromSubdir, hostPortsInUse, serviceCandidate, suggestedDefaults, managedKeys, envSetManaged, envDeleteKeys, applyEnvDefaults, parseEnvFile };
};
