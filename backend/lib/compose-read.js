const YAML = require('yaml');
const { sourceFile, readSource } = require('./repository-files');

const COMPOSE_FILES = ['compose.yaml', 'compose.yml', 'docker-compose.yaml', 'docker-compose.yml'];
const object = v => v && typeof v === 'object' && !Array.isArray(v);
function envRefs(text) {
  const found = new Map();
  // Mask $$ rather than deleting it (deletion incorrectly exposes a literal).
  const clean = String(text || '').replace(/\$\$/g, '\u0000');
  const add = (key, op = '', value = '') => {
    if (key === 'COMPOSE_PROJECT_NAME') return;
    const old = found.get(key);
    const required = op === '?' || op === ':?';
    found.set(key, { key, required: required || !!(old && old.required),
      allowEmpty: required ? op === '?' && !(old && old.required && !old.allowEmpty) : !!(old && old.allowEmpty),
      message: required ? value.trim() || (old && old.message) || null : (old && old.message) || null, def: op === '-' || op === ':-' ? value : (old && old.def) || null });
  };
  for (const m of clean.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?:(:?[-?+])([^}]*))?\}/g)) add(m[1], m[2] || '', m[3] || '');
  for (const m of clean.matchAll(/\$([A-Za-z_][A-Za-z0-9_]*)/g)) add(m[1]);
  return [...found.values()];
}
function parsePort(value) {
  if (object(value)) return { host: value.published == null ? null : Number(value.published), container: Number(value.target), address: value.host_ip || null, protocol: value.protocol || 'tcp' };
  const raw = String(value).replace(/^["']|["']$/g, '').replace(/\/(tcp|udp)$/i, '');
  const m = /^(?:(.+):)?(\d+):(\d+)$/.exec(raw);
  if (m) return { host: Number(m[2]), container: Number(m[3]) };
  if (/^\d+$/.test(raw)) return { host: null, container: Number(raw) };
  return null;
}
function parseCompose(text, file) {
  const doc = YAML.parseDocument(text, { uniqueKeys: true, merge: true });
  if (doc.errors.length || doc.warnings.length) return { file, complete: false, errors: [...doc.errors, ...doc.warnings].map(e => e.code || 'INVALID_YAML'), services: [], envNeeds: [] };
  let data;
  try { data = doc.toJS({ maxAliasCount: 100 }); }
  catch { return { file, complete: false, errors: ['YAML_ALIAS_LIMIT'], services: [], envNeeds: [] }; }
  if (!object(data) || !object(data.services)) return null;
  const services = [], errors = [], agg = new Map();
  const tasks = new Set();
  for (const definition of Object.values(data.services)) {
    if (object(definition) && object(definition.depends_on)) {
      for (const [name, dep] of Object.entries(definition.depends_on)) if (object(dep) && dep.condition === 'service_completed_successfully') tasks.add(name);
    }
  }
  for (const [name, s] of Object.entries(data.services)) {
    if (!object(s)) { errors.push('INVALID_SERVICE:' + name); continue; }
    let build = null;
    if (typeof s.build === 'string') build = { context: s.build, dockerfile: null };
    else if (object(s.build)) build = { context: s.build.context || '.', dockerfile: s.build.dockerfile || null, target: s.build.target || null,
      args: Object.keys(object(s.build.args) ? s.build.args : Object.fromEntries((Array.isArray(s.build.args) ? s.build.args : []).map(a => [String(a).split('=')[0], null]))),
      inline: s.build.dockerfile_inline != null };
    const env = [];
    const entries = Array.isArray(s.environment) ? s.environment.map(e => { const i = String(e).indexOf('='); return i < 0 ? [String(e), null] : [String(e).slice(0, i), String(e).slice(i + 1)]; }) : Object.entries(object(s.environment) ? s.environment : {});
    for (const [key, value] of entries) {
      env.push({ key, refs: envRefs(value).map(r => r.key), derived: envRefs(value).length > 0 });
    }
    let refs;
    try { refs = envRefs(JSON.stringify(s)); }
    catch { return { file, complete: false, errors: ['CYCLIC_YAML_ALIAS'], services: [], envNeeds: [] }; }
    for (const [key, value] of entries) if (value == null) refs.push({ key, required: true, allowEmpty: true, message: null, def: null });
    for (const r of refs) {
      const old = agg.get(r.key);
      agg.set(r.key, { ...r, required: r.required || !!(old && old.required),
        allowEmpty: old && old.required ? old.allowEmpty && (!r.required || r.allowEmpty) : r.allowEmpty,
        services: [...new Set([...(old ? old.services : []), name])] });
    }
    const dependsOn = Array.isArray(s.depends_on) ? s.depends_on : Object.keys(object(s.depends_on) ? s.depends_on : {});
    services.push({ name, build, image: typeof s.image === 'string' ? s.image : null,
      ports: (Array.isArray(s.ports) ? s.ports : []).map(parsePort).filter(Boolean),
      expose: Array.isArray(s.expose) ? s.expose : [], env,
      command: s.command == null ? null : s.command, entrypoint: s.entrypoint == null ? null : s.entrypoint,
      workingDir: s.working_dir || null, oneShot: tasks.has(name), dependsOn,
      dependencyConditions: object(s.depends_on) ? Object.fromEntries(Object.entries(s.depends_on).map(([k, v]) => [k, object(v) ? v.condition || 'service_started' : 'service_started'])) : {},
      healthcheck: s.healthcheck != null, profiles: Array.isArray(s.profiles) ? s.profiles : [],
      envFiles: [].concat(s.env_file || []).map(v => typeof v === 'string' ? { path: v, required: true } : { path: v.path, required: v.required !== false }) });
  }
  if (!services.length) errors.push('NO_SERVICES');
  const references = [];
  for (const include of [].concat(data.include || [])) for (const value of [].concat(typeof include === 'string' ? include : include.path || [])) references.push({ file: value, kind: 'include' });
  for (const s of Object.values(data.services)) if (object(s) && object(s.extends) && s.extends.file) references.push({ file: s.extends.file, kind: 'extends' });
  return { file, complete: errors.length === 0, errors, services, envNeeds: [...agg.values()], references };
}
function readComposeTopo(codeDir, selected) {
  const names = selected ? [selected] : COMPOSE_FILES;
  for (const name of names) {
    const file = sourceFile(codeDir, name);
    if (!file) continue;
    let result;
    try { result = readSource(file); } catch { result = { reason: 'file could not be read' }; }
    if (result.text === undefined) return { file: name, complete: false, errors: ['UNREADABLE_COMPOSE'], services: [], envNeeds: [] };
    return parseCompose(result.text, name) || { file: name, complete: false, errors: ['NO_SERVICES'], services: [], envNeeds: [] };
  }
  return null;
}
module.exports = { COMPOSE_FILES, readComposeTopo, parseCompose, envRefs, parsePort };
