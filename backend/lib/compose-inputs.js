// Provision only inputs whose meaning is declared by a database service and
// its consumers. No customer names, no account fallback, no external secrets.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const YAML = require('yaml');
const { sourceFile, readSource } = require('./repository-files');
const dotenvParser = require('dotenv');

const SPECS = {
  postgres: { user: 'POSTGRES_USER', name: 'POSTGRES_DB', password: 'POSTGRES_PASSWORD', defaultUser: 'postgres', port: 5432, scheme: 'postgresql' },
  mysql: { user: 'MYSQL_USER', name: 'MYSQL_DATABASE', password: 'MYSQL_PASSWORD', root: 'MYSQL_ROOT_PASSWORD', defaultUser: 'root', port: 3306, scheme: 'mysql' },
  mariadb: { user: 'MARIADB_USER', name: 'MARIADB_DATABASE', password: 'MARIADB_PASSWORD', root: 'MARIADB_ROOT_PASSWORD', defaultUser: 'root', port: 3306, scheme: 'mysql' },
  mongo: { user: 'MONGO_INITDB_ROOT_USERNAME', name: 'MONGO_INITDB_DATABASE', password: 'MONGO_INITDB_ROOT_PASSWORD', defaultUser: null, port: 27017, scheme: 'mongodb' },
  redis: { user:null,name:null,password:'__REDIS_PASSWORD',defaultUser:'',port:6379,scheme:'redis' }
};
function entries(value) {
  if (!Array.isArray(value)) return value && typeof value === 'object' ? value : {};
  return Object.fromEntries(value.map(item => { const at = String(item).indexOf('='); return at < 0 ? [String(item), null] : [String(item).slice(0, at), String(item).slice(at + 1)]; }));
}
function reference(value, key) {
  if (value == null) return key;
  if(/^\$[A-Za-z_][A-Za-z0-9_]*$/.test(String(value)))return String(value).slice(1);
  const match = /^\$\{([A-Za-z_][A-Za-z0-9_]*)(?::?[-?][^{}]*)?\}$/.exec(String(value));
  return match ? match[1] : null;
}
function literal(value, env, key) {
  if (value == null) return key in env ? env[key] : null;
  let unknown = false;
  const text = String(value).replace(/\$\$/g, '\u0000').replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?:(:?[-?])([^{}]*))?\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (_, braced, op, fallback, bare) => {
    const name = braced || bare;
    const have = name in env && (op && op.startsWith(':') ? String(env[name]) !== '' : true);
    if (have) return env[name];
    if (op === '-' || op === ':-') return fallback;
    unknown = true; return '';
  });
  return unknown || /\$\{/.test(text) ? null : text.replace(/\u0000/g, '$');
}
function typeOf(image) {
  const match = /(?:^|\/)(postgres|mysql|mariadb|mongo|redis)(?=[:@]|$)/i.exec(image || '');
  return match ? match[1].toLowerCase() : null;
}
function dotenv(file) {
  if(!file||!fs.existsSync(file))return {};
  const source=readSource(file);
  if(typeof source.text!=='string')throw new Error('Compose environment input could not be read safely; saved credentials were not changed');
  const text = source.text;
  const result = dotenvParser.parse(text);
  // Compose accepts escaped apostrophes inside single-quoted literals; dotenv
  // strips the quotes but otherwise preserves their backslashes.
  for(const match of text.matchAll(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*'((?:\\'|[^'\r\n])*)'\s*(?:#.*)?$/gm)) result[match[1]]=match[2].replace(/\\'/g,"'");
  return result;
}
function declarations(root, selection) {
  const services = {}, unresolved = [], profiles = selection.profiles || [];
  for (const relative of selection.files || [selection.file]) {
    const file = sourceFile(root, relative);
    if (!file) throw new Error('Selected Compose input is missing or outside the checkout');
    const text = readSource(file).text;
    if (text === undefined) throw new Error('Selected Compose input cannot be read');
    const doc = YAML.parseDocument(text, { uniqueKeys: true, merge: true });
    if (doc.errors.length) throw new Error('Selected Compose input has invalid YAML');
    if (doc.warnings.length) { unresolved.push(relative); continue; }
    const data = doc.toJS({ maxAliasCount: 100 });
    if (data.include) unresolved.push(relative);
    for (const [name, value] of Object.entries(data.services || {})) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid Compose service declaration');
      if (value.extends) unresolved.push(relative);
      const old = services[name] || {};
      services[name] = { ...old, ...value, environment: { ...entries(old.environment), ...entries(value.environment) },
        depends_on: { ...entries(old.depends_on), ...entries(value.depends_on) },
        _file: relative };
    }
  }
  // Includes/extends and custom YAML tags still deploy through Compose, but a
  // partial model cannot authorize generation of database credentials.
  if (unresolved.length) return { services: {}, unresolved };
  for (const [name, service] of Object.entries(services)) if ((service.profiles || []).length && !service.profiles.some(p => profiles.includes(p) || profiles.includes('*'))) delete services[name];
  return { services, unresolved };
}
function hasData(dir) {
  for (const name of ['.dbdata', '.volumes']) {
    try { if (fs.readdirSync(path.join(dir, name)).length) return true; } catch {}
  }
  return false;
}
function networks(service) {
  if(service.network_mode)return [];
  return Array.isArray(service.networks)?service.networks:Object.keys(service.networks || {default:null});
}
function boundData(service) {
  return (service.volumes || []).some(v=>typeof v==='object'?v.type==='bind':/^(?:\.{1,2}\/|\/|~|[A-Za-z]:[\\/])/.test(String(v)));
}
function provision({ dir, root, selection, meta, containers = [], volumes = [], fresh = false, replaceOrigins = false, mint = () => crypto.randomBytes(32).toString('hex') }) {
  const model = declarations(root, selection);
  const file = path.join(dir, '.env');
  const source = dotenv(sourceFile(root, path.posix.join(path.posix.dirname(selection.file), '.env')) || '');
  const saved = dotenv(file), env = { ...source, ...saved };
  const changes = {}, actions = [], issues = [], warnings = [];
  let history = {}, invalidHistory=false;
  const historyFile=path.join(dir,'.compose-inputs.json');
  try { history = JSON.parse(fs.readFileSync(historyFile, 'utf8')); if(!history||typeof history!=='object'||Array.isArray(history)){history={};invalidHistory=true;} }
  catch { invalidHistory=fs.existsSync(historyFile); }
  invalidHistory=invalidHistory||history.invalid===true;
  const histories = { ...(history.databases || {}) };
  const origins = { ...(history.origins || {}) };
  const identifiers = String(meta.id || 'app').replace(/[^a-z0-9_]/gi, '_').slice(0, 48);
  const existingData = hasData(dir) || volumes.length > 0;
  const usable = k => k in env && String(env[k]).trim().length > 0;
  const set = (key, value, reason, service, replace = false) => {
    if (key in changes && changes[key] !== String(value)) throw new Error('Conflicting generated Compose inputs require explicit selection');
    if (!key || usable(key)&&!replace || value == null || String(value) === '' || /[\r\n\u0000]/.test(String(value))) return false;
    if(env[key]===String(value))return false;
    env[key] = String(value); changes[key] = String(value); actions.push({ key, reason, service }); return true;
  };
  const issue = (service, message) => issues.push({ code: 'DATABASE_INPUT_REVIEW', service, message });
  if (model.unresolved.length) warnings.push({ code: 'DATABASE_INPUT_REVIEW', message: 'Automatic input generation requires an unambiguous database model. Includes/extends need explicit inputs; Compose execution remains supported.' });
  const databases = [];
  const tasks=new Set(Object.values(model.services).flatMap(s=>Object.entries(s.depends_on || {}).filter(([,d])=>d&&d.condition==='service_completed_successfully').map(([name])=>name)));
  for (const [name, service] of Object.entries(model.services)) {
    if(tasks.has(name))continue;
    const type = typeOf(literal(service.image, env) || service.image);
    if (!type) continue;
    let spec = SPECS[type];
    const declaration = entries(service.environment);
    const command = Array.isArray(service.command) ? service.command.join(' ') : String(service.command || '');
    const redisAuth = type==='redis'&&/(?:^|\s)--requirepass(?:=|\s+)(\$\{[A-Za-z_][A-Za-z0-9_]*(?::?[-?][^{}]*)?\}|[^\s]+)/.exec(command);
    if(redisAuth)declaration.__REDIS_PASSWORD=redisAuth[1];
    if (type === 'mariadb' && !Object.keys(declaration).some(k => k.startsWith('MARIADB_'))) spec = SPECS.mysql;
    const inherited = {};
    for (const entry of [].concat(service.env_file || [])) {
      const relative = typeof entry === 'string' ? entry : entry.path;
      if (!relative || /[$~]/.test(relative)) continue;
      const safe = sourceFile(root, path.posix.normalize(path.posix.join(path.posix.dirname(service._file), relative)));
      if (safe) Object.assign(inherited, dotenv(safe));
    }
    if(type==='mariadb')spec={...SPECS.mariadb,...Object.fromEntries(['user','name','password','root'].map(field=>{
      const key=SPECS.mariadb[field],compatible=key.replace(/^MARIADB_/,'MYSQL_');
      return[field,key in declaration||key in inherited?key:compatible in declaration||compatible in inherited?compatible:key];
    }))};
    const own = Object.fromEntries(Object.entries(declaration).map(([k,v]) => [k, literal(v, env, k)]));
    const current = { ...inherited, ...own };
    const old = containers.find(c => c.Config && c.Config.Labels && c.Config.Labels['com.docker.compose.service'] === name && typeOf(c.Config.Image) === type);
    const actual = old ? Object.fromEntries((old.Config.Env || []).map(e => { const at=e.indexOf('=');return[e.slice(0,at),e.slice(at+1)]; })) : {};
    if(type==='redis'&&old){const args=old.Config.Cmd || [];const at=args.indexOf('--requirepass');if(at>=0)actual.__REDIS_PASSWORD=args[at+1];}
    const safeNew = !old && !existingData && !boundData(service) && !invalidHistory && !histories[name] && (fresh || !meta.lastGoodDeploy && !containers.length);
    const generate = field => {
      if (current[field]) return;
      const key = field in declaration ? reference(declaration[field], field) : null;
      if (!key || usable(key)) return;
      const existing = actual[field];
      if (existing) set(key, existing, 'existing database credential reused', name);
      else if (safeNew) set(key, mint(), 'database password generated', name);
      else issue(name, `Missing input ${key} belongs to an existing/unverified database. Restore its credential; Minipass will not rotate it or reinitialize its data.`);
      current[field] = literal(declaration[field], env, field);
    };
    for (const field of [spec.user, spec.name]) {
      const key = field in declaration ? reference(declaration[field], field) : null;
      if (key && !current[field]) {
        if (actual[field]) set(key, actual[field], 'existing database identity reused', name);
        else if (safeNew) set(key, identifiers, 'declared database identity initialized', name);
        current[field] = literal(declaration[field], env, field);
      }
    }
    generate(spec.password);
    if (spec.root) generate(spec.root);
    const user = current[spec.user] || actual[spec.user] || spec.defaultUser;
    const database = current[spec.name] || actual[spec.name] || (type === 'postgres' ? user : type === 'mongo' ? 'admin' : type==='redis'?'0':null);
    const password = current[spec.password] || actual[spec.password] || (user === 'root' && spec.root ? current[spec.root] || actual[spec.root] : null);
    const explicitPort = /(?:^|\s)(?:--port(?:=|\s+)|-p\s+)(\d+)(?:\s|$)/.exec(command);
    const port = explicitPort ? Number(explicitPort[1]) : type === 'postgres' && current.PGPORT ? Number(current.PGPORT) : spec.port;
    if ((user && password || type==='redis'&&(!redisAuth||password)) && Number.isInteger(port) && port > 0 && port < 65536) {
      databases.push({ name, type, user, password, database, port, scheme:spec.scheme, networks:networks(service) });
      if (Object.keys(changes).some(k=>actions.some(a=>a.key===k&&a.service===name))) histories[name]={type,keys:actions.filter(a=>a.service===name).map(a=>a.key)};
    }
  }
  const dependencies = service => {
    const names = new Set(), pending = Object.keys(service.depends_on || {});
    while(pending.length){const name=pending.pop();if(names.has(name))continue;names.add(name);pending.push(...Object.keys(model.services[name]&&model.services[name].depends_on || {}));}
    return names;
  };
  for (const [name, service] of Object.entries(model.services)) {
    if (databases.some(d=>d.name===name)) continue;
    const linked = dependencies(service);
    const ownNetworks = networks(service);
    const reachable = databases.filter(d=>d.networks.some(n=>ownNetworks.includes(n)));
    for (const [field,value] of Object.entries(entries(service.environment))) {
      const key = reference(value,field);
      if (!key || usable(key) && !(key in changes) || literal(value,env,field) && !(key in changes)) continue;
      const expectedType = /REDIS/i.test(field)?'redis':/MONGO/i.test(field) ? 'mongo' : /POSTGRES|PG_/i.test(field) ? 'postgres' : /MARIADB/i.test(field) ? 'mariadb' : /MYSQL/i.test(field) ? 'mysql' : null;
      if (!/^(?:(?:[A-Z0-9]+_)*(?:DATABASE|DB|POSTGRES|POSTGRESQL|MYSQL|MARIADB|MONGO|MONGODB|REDIS)_(?:URL|URI|HOST|PORT|NAME|USER|USERNAME|PASSWORD)|DATABASE_URL)$/.test(field)) continue;
      let candidates=reachable.filter(d=>!expectedType||d.type===expectedType||expectedType==='mysql'&&d.type==='mariadb');
      const declared=candidates.filter(d=>linked.has(d.name));
      if(declared.length)candidates=declared;
      if(candidates.length!==1){if(candidates.length>1)issue(name,`Input ${key} has several reachable databases. Declare its database dependency or supply an explicit connection.`);continue;}
      const db=candidates[0];
      let result;
      if(/_(?:URL|URI)$/.test(field)) {
        if(!db.database) {issue(name,`Input ${key} needs a declared database name before its connection can be generated.`);continue;}
        const auth=db.password?`${encodeURIComponent(db.user)}:${encodeURIComponent(db.password)}@`:'';
        result=`${db.scheme}://${auth}${db.name}:${db.port}/${encodeURIComponent(db.database)}${db.type==='mongo'?'?authSource=admin':''}`;
      } else if(/_HOST$/.test(field))result=db.name;
      else if(/_PORT$/.test(field))result=String(db.port);
      else if(/_NAME$/.test(field))result=db.database;
      else if(/_(?:USER|USERNAME)$/.test(field))result=db.user;
      else if(/_PASSWORD$/.test(field))result=db.password;
      set(key,result,'repository database connection linked',name);
    }
    // Only an explicitly configured hostname can satisfy a derived HTTP origin.
    // Never turn an optional origin into a made-up localhost/public URL.
    let configured = null;
    try { if(meta.accessMode==='local'&&meta.localUrl)configured=new URL(meta.localUrl);else if(meta.publicUrl)configured=new URL(meta.publicUrl);else if(meta.domain)configured=new URL('https://'+meta.domain);else if(meta.localUrl)configured=new URL(meta.localUrl); } catch {}
    for(const [field,value] of Object.entries(entries(service.environment))) {
      if(!/^(?:APP|SITE|PUBLIC|FRONTEND|CLIENT|WEB|CORS)(?:_BASE)?_(?:URL|ORIGIN|ORIGINS)$/.test(field))continue;
      const direct=typeof value==='string'&&/^\$\{([A-Za-z_][A-Za-z0-9_]*)(?::?\?[^{}]*)?\}$/.exec(value);
      if(direct&&configured) {
        const key=direct[1],local=meta.accessMode==='local',replace=local&&replaceOrigins||origins[key]&&origins[key]===env[key];
        if(set(key,configured.origin,local?'application origin linked to allocated local address':'application origin derived from configured public URL',name,replace))origins[key]=configured.origin;
      }
      const match=typeof value==='string'&&/^(https?):\/\/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::?\?[^{}]*)?\}\/?$/.exec(value);
      if(match&&configured&&(configured.protocol===match[1]+':'||meta.accessMode==='local'&&configured.protocol==='https:')&&!configured.username&&!configured.password) {
        const key=match[2],local=meta.accessMode==='local';
        const replace=local&&replaceOrigins||origins[key]&&origins[key]===env[key];
        const target=key==='DOMAIN'?configured.hostname:configured.host;
        if(key==='DOMAIN'&&!/^[A-Za-z0-9.-]+$/.test(target))continue;
        if(set(key,target,local?'hostname linked to allocated local address':'hostname derived from configured public URL',name,replace))origins[key]=target;
        if(usable(key)&&/[:/]/.test(env[key].replace(/:\d+$/,''))&&!(env[key].startsWith('[')&&env[key].includes(']')))issue(name,`Origin hostname input ${key} must contain a hostname/IP, not http:// or https://. Select local/LAN access to configure this site's allocated address automatically.`);
      }
    }
  }
  if(Object.keys(changes).length) {
    let lines=fs.existsSync(file)?fs.readFileSync(file,'utf8').split(/\r?\n/):[];
    for(const [key,value] of Object.entries(changes)) {
      // Plain values remain easy to edit. Quote only when $, #, spaces or quote
      // characters need protection; retries never mint over a saved secret.
      const escaped=String(value).replace(/'/g,"\\'");
      const plain=/^[A-Za-z0-9_./:@%+?=&,\[\]-]+$/.test(String(value));
      const line=plain?`${key}=${value}`:`${key}='${escaped}'`;
      const pattern=new RegExp('^\\s*(?:export\\s+)?'+key+'\\s*=');
      const index=lines.findIndex(l=>pattern.test(l));
      if(index<0)lines.push(line);else lines[index]=line;
      lines=lines.filter((l,i)=>i===index||!pattern.test(l)||index<0&&l===line);
    }
    const temporary=file+'.compose-inputs.tmp';
    fs.writeFileSync(temporary,lines.join('\n').replace(/\s*$/,'')+'\n',{mode:0o600});
    fs.renameSync(temporary,file);fs.chmodSync(file,0o600);
    fs.writeFileSync(path.join(dir,'.compose-inputs.json'),JSON.stringify({version:1,...(invalidHistory?{invalid:true}:{}),databases:histories,origins,actions:[...(history.actions || []),...actions]}),{mode:0o600});
  }
  return { changed:Object.keys(changes), actions, issues, warnings };
}
module.exports={provision,declarations,reference,literal};
