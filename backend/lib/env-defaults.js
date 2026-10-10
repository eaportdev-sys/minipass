const fs = require('fs');
const path = require('path');
const net = require('net');
const crypto = require('crypto');

const BUILT_INS = {
  NODE_ENV: 'production',
  HOST: '0.0.0.0',
  TRUST_PROXY: '1'
};

const FRONTEND_ORIGIN_KEYS = /^(?:CORS_(?:ALLOWED_)?ORIGINS?|ALLOWED_ORIGINS?|WHITE_LIST_(?:URLS?|ORIGINS?)|FRONTEND_(?:URL|ORIGIN)|CLIENT_(?:URL|ORIGIN)|WEB_(?:URL|ORIGIN))$/i;
const BACKEND_ORIGIN_KEYS = /(?:^|_)(?:API|BACKEND|SERVER)(?:_BASE)?_(?:URL|ORIGIN)$/i;
const LOCAL_SECRET_KEYS = /^(?:(?:JWT|SESSION|COOKIE|AUTH|NEXTAUTH|CSRF|APP|ACCESS_TOKEN|REFRESH_TOKEN)(?:_[A-Z0-9]+)*_SECRET|SECRET_KEY|ENCRYPTION_KEY|SIGNING_KEY)$/i;
const SECRET_PLACEHOLDER = /^(?:|secret|changeme|change[-_ ]?me|change[-_ ]?this.*|replace[-_ ]?(?:me|with).*|your[-_ ].*(?:secret|key)|.*random[-_ ]?secret.*|.*secret[-_ ]?here)$/i;
const MAX_SOURCE_BYTES = 256 * 1024;

function parseExample(text) {
  const out = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s?(.*)$/);
    if (!m || out.some(x => x.key === m[1])) continue;
    let value = m[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    else value = value.replace(/\s+#.*$/, '').trim();
    out.push({ key: m[1], value });
  }
  return out;
}

// Recognize conventional generic and mode-specific examples without scanning
// nested files. Lower-priority development variants fill gaps; generic and
// production variants win when the same key is declared more than once.
function exampleFiles(dir) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  const rank = name => {
    const m = name.match(/^\.env(?:\.([A-Za-z0-9_-]{1,32}))?\.example$/);
    if (!m) return null;
    const mode = String(m[1] || '').toLowerCase();
    if (mode === 'dev' || mode === 'development') return 0;
    if (mode === 'prod' || mode === 'production') return 3;
    return mode ? 1 : 2;
  };
  return names.map(name => ({ name, rank: rank(name) })).filter(x => x.rank != null)
    .filter(x => {
      try {
        const stat = fs.lstatSync(path.join(dir, x.name));
        return stat.isFile() && !stat.isSymbolicLink() && stat.size <= MAX_SOURCE_BYTES;
      } catch { return false; }
    })
    .sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name)).map(x => x.name);
}

// Read every enabled service's own examples. Runtime .env stays outside code/
// and is never treated as a source of defaults; repository secrets should not
// be copied merely because an operator clicked Load defaults.
function exampleDefaults(codeDir, services) {
  const values = {};
  const seenDirs = new Set();
  for (const service of services || []) {
    if (service.enabled === false) continue;
    const dir = path.resolve(codeDir, service.subdir || '');
    if (seenDirs.has(dir)) continue;
    seenDirs.add(dir);
    for (const name of exampleFiles(dir)) {
      try {
        for (const item of parseExample(fs.readFileSync(path.join(dir, name), 'utf8'))) values[item.key] = item.value;
      } catch {}
    }
  }
  return values;
}

// Keep repository configuration immutable after first discovery. The snapshot
// belongs to the panel (outside code/) and may contain secrets, so it is never
// committed and is written owner-only where the filesystem supports chmod.
// A newly added service/source file is captured once; already-recorded files
// are never reread after pulls or repository edits.
function snapshotDefaults(appDir, codeDir, services) {
  const snapshotPath = path.join(appDir, '.env.defaults.json');
  let snapshot = { version: 1, capturedAt: null, sources: [], values: {}, originals: {} };
  try {
    const saved = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
    if (saved && saved.version === 1 && Array.isArray(saved.sources) && saved.values && typeof saved.values === 'object') snapshot = saved;
  } catch {}
  if (!snapshot.originals || typeof snapshot.originals !== 'object') snapshot.originals = {};
  const seen = new Set(snapshot.sources);
  const root = path.resolve(codeDir);
  let changed = false;
  for (const service of services || []) {
    if (service.enabled === false) continue;
    const subdir = String(service.subdir || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    const dir = path.resolve(codeDir, subdir);
    if (dir !== root && !dir.startsWith(root + path.sep)) continue;
    const discovered = {};
    // Examples first (production-specific last), then repository .env wins
    // within the same service. Each source path is captured at most once.
    for (const name of [...exampleFiles(dir), '.env']) {
      const source = (subdir ? subdir + '/' : '') + name;
      if (seen.has(source)) continue;
      try {
        const file = path.join(dir, name);
        const stat = fs.lstatSync(file);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_SOURCE_BYTES) continue;
        for (const item of parseExample(fs.readFileSync(file, 'utf8'))) {
          discovered[item.key] = item.value;
          if (!Array.isArray(snapshot.originals[item.key])) snapshot.originals[item.key] = [];
          if (!snapshot.originals[item.key].includes(item.value)) snapshot.originals[item.key].push(item.value);
        }
        snapshot.sources.push(source);
        seen.add(source);
        changed = true;
      } catch {}
    }
    for (const [key, value] of Object.entries(discovered)) {
      if (!Object.prototype.hasOwnProperty.call(snapshot.values, key)) snapshot.values[key] = secureDefault(key, value) || value;
    }
  }
  // Upgrade an early/partial snapshot that still contains a known secret
  // placeholder. The generated value is persisted once and restored unchanged.
  for (const [key, value] of Object.entries(snapshot.values)) {
    const secure = secureDefault(key, value);
    if (secure) { snapshot.values[key] = secure; changed = true; }
  }
  if (changed || !snapshot.capturedAt) {
    snapshot.capturedAt = snapshot.capturedAt || new Date().toISOString();
    fs.writeFileSync(snapshotPath, JSON.stringify(snapshot, null, 2) + '\n', { mode: 0o600 });
    try { fs.chmodSync(snapshotPath, 0o600); } catch {}
  }
  return snapshot;
}

function safeHost(value) {
  const host = String(value || '').trim().replace(/^\[|\]$/g, '');
  if (net.isIP(host)) return host;
  return /^[A-Za-z0-9.-]+$/.test(host) ? host : 'localhost';
}

function frontendOrigin(services, hostname, protocol) {
  return publishedOrigins(services, hostname, protocol).frontend;
}

function serviceOrigin(service, hostname, protocol) {
  if (!service || !service.hostPort) return null;
  const host = safeHost(hostname);
  const shownHost = net.isIP(host) === 6 ? `[${host}]` : host;
  const scheme = protocol === 'https' ? 'https' : 'http';
  return `${scheme}://${shownHost}:${service.hostPort}`;
}

function publishedOrigins(services, hostname, protocol) {
  const enabled = (services || []).filter(s => s.enabled !== false && s.hostPort);
  const frontend = enabled.find(s => ['static', 'react'].includes(s.type));
  const backend = enabled.find(s => !['static', 'react'].includes(s.type));
  return {
    frontend: serviceOrigin(frontend, hostname, protocol),
    backend: serviceOrigin(backend, hostname, protocol),
    services: enabled.map(s => ({ ...s, origin: serviceOrigin(s, hostname, protocol) }))
  };
}

function localViteUrl(value) {
  try {
    const u = new URL(String(value || '').trim());
    return ['localhost', '127.0.0.1', '::1'].includes(u.hostname) && ['4173', '5173', '5174'].includes(u.port);
  } catch { return false; }
}

function pointsAtFrontend(key, exampleValue) {
  return FRONTEND_ORIGIN_KEYS.test(String(key || '')) || (String(key).toUpperCase() === 'APP_URL' && localViteUrl(exampleValue));
}

function localUrl(value) {
  try {
    const url = new URL(String(value || '').trim());
    return ['localhost', '127.0.0.1', '::1'].includes(url.hostname) ? url : null;
  } catch { return null; }
}

function rewriteUrl(value, target, originOnly) {
  if (!target) return null;
  const url = localUrl(value);
  if (!url) return null;
  return target + (originOnly ? '' : `${url.pathname === '/' ? '' : url.pathname}${url.search}${url.hash}`);
}

function rewriteDefault(key, value, origins) {
  const name = String(key || '');
  // CORS lists can contain more than one origin. Keep declared non-local
  // entries, replacing only local-development entries with the live frontend.
  if (/^(?:CORS_(?:ALLOWED_)?ORIGINS?|ALLOWED_ORIGINS?|WHITE_LIST_(?:URLS?|ORIGINS?))$/i.test(name) && (origins.frontend || origins.backend)) {
    const target = origins.frontend || origins.backend;
    let changed = false;
    const list = String(value || '').split(',').map(item => {
      const next = rewriteUrl(item.trim(), target, true);
      if (next) changed = true;
      return next || item.trim();
    });
    return changed ? [...new Set(list)].join(',') : null;
  }
  if (pointsAtFrontend(name, value)) return rewriteUrl(value, origins.frontend, true);
  if (BACKEND_ORIGIN_KEYS.test(name)) return rewriteUrl(value, origins.backend, false);

  // For less conventional names, an exact development/container port provides
  // a safe mapping to the corresponding published service. Vite's standard
  // ports map to the frontend even though production serves it on port 80.
  const url = localUrl(value);
  if (!url) return null;
  if (['4173', '5173', '5174'].includes(url.port)) return rewriteUrl(value, origins.frontend, false);
  const matches = (origins.services || []).filter(s => String(s.port || '') === url.port);
  return matches.length === 1 ? rewriteUrl(value, matches[0].origin, false) : null;
}

function secureDefault(key, value) {
  if (!LOCAL_SECRET_KEYS.test(String(key || '')) || !SECRET_PLACEHOLDER.test(String(value || '').trim())) return null;
  return crypto.randomBytes(32).toString('base64url');
}

// Repositories frequently prefix their database variables (DEV_DB_NAME,
// APP_DATABASE_USER, etc.). When the semantic suffix is unambiguous, map it to
// the panel-managed local database credentials rather than retaining example
// placeholders. Host is mapped only when the repository actually declares a
// host variable; source code that omits host configuration still needs fixing.
function databaseAlias(key, runtimeValues) {
  const name = String(key || '').toUpperCase();
  const values = runtimeValues && typeof runtimeValues === 'object' ? runtimeValues : {};
  const aliases = [
    [/(?:^|_)(?:DB|DATABASE)_(?:HOST|HOSTNAME)$/, 'DB_HOST'],
    [/(?:^|_)(?:DB|DATABASE)_PORT$/, 'DB_PORT'],
    [/(?:^|_)(?:DB|DATABASE)_(?:NAME|DATABASE)$/, 'DB_NAME'],
    [/(?:^|_)(?:DB|DATABASE)_(?:USER|USERNAME)$/, 'DB_USER'],
    [/(?:^|_)(?:DB|DATABASE)_(?:PASSWORD|PASS|PSW)$/, 'DB_PASSWORD']
  ];
  for (const [pattern, source] of aliases) {
    if (name !== source && pattern.test(name) && Object.prototype.hasOwnProperty.call(values, source)) return String(values[source]);
  }
  return null;
}

function resolvedDefaults(codeDir, services, origins, savedValues, savedOriginals, runtimeValues) {
  const examples = savedValues && typeof savedValues === 'object' ? { ...savedValues } : exampleDefaults(codeDir, services);
  const values = { ...examples, ...BUILT_INS };
  const rewritten = new Set();
  const generated = new Set();
  const published = typeof origins === 'string' ? { frontend: origins, backend: null, services: [] } : (origins || { frontend: null, backend: null, services: [] });
  if (published.frontend || published.backend) {
    for (const [key, value] of Object.entries(values)) {
      const replacement = rewriteDefault(key, value, published);
      if (replacement != null && replacement !== value) {
        values[key] = replacement;
        rewritten.add(key);
      }
    }
  }
  for (const key of Object.keys(examples)) {
    const replacement = databaseAlias(key, runtimeValues);
    if (replacement != null) values[key] = replacement;
  }
  for (const [key, value] of Object.entries(values)) {
    const replacement = secureDefault(key, value);
    if (replacement) {
      values[key] = replacement;
      generated.add(key);
    }
  }
  return { values, examples, originals: savedOriginals || {}, rewritten, generated };
}

function correctedValue(key, current, resolved, origins) {
  const value = String(current || '').trim();
  if (resolved.generated.has(key) && SECRET_PLACEHOLDER.test(value)) return resolved.values[key];
  if (resolved.rewritten.has(key)) {
    const replacement = rewriteDefault(key, value, origins);
    if (replacement != null && replacement !== value) return replacement;
  }
  const originals = Array.isArray(resolved.originals[key]) ? resolved.originals[key] : [];
  if (/^(?:https?|wss?):\/\//i.test(value) && !localUrl(value)) return null;
  return originals.includes(value) && resolved.values[key] !== value ? resolved.values[key] : null;
}

module.exports = { BUILT_INS, parseExample, exampleFiles, exampleDefaults, snapshotDefaults, frontendOrigin, publishedOrigins, pointsAtFrontend, secureDefault, databaseAlias, resolvedDefaults, correctedValue };
