const fs = require('fs');
const path = require('path');

// Repo-shipped compose topology, read WITHOUT running anything. Hand parser
// for the common subset only - full YAML is deliberately out of scope.
// Unrecognized shapes are skipped, never throw on odd files: an incomplete
// read beats a crashed one, and callers treat absence as "no topology".
// Purpose: complete the pre-deploy read (service names are DNS, build
// recipes, published ports, env needs, one-shot tasks) instead of inferring
// the topology from scratch and discovering it through failed builds.
const COMPOSE_FILES = ['compose.yaml', 'compose.yml', 'docker-compose.yaml', 'docker-compose.yml'];
const MAX_BYTES = 64 * 1024;
const MAX_SERVICES = 20;

function stripComment(line) {
  // '#' inside quotes or ${} is data, not a comment.
  let out = '', quote = null, depth = 0;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      out += c;
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") { quote = c; out += c; }
    else if (c === '$' && line[i + 1] === '{') { depth++; out += c; }
    else if (c === '}' && depth > 0) { depth--; out += c; }
    else if (c === '#' && depth === 0) break;
    else out += c;
  }
  return out;
}

function unquote(s) {
  const t = String(s || '').trim();
  if (t.length >= 2 && ((t[0] === '"' && t[t.length - 1] === '"') || (t[0] === "'" && t[t.length - 1] === "'"))) return t.slice(1, -1);
  return t;
}

// ${VAR} ${VAR:-default} ${VAR:?message} (and $VAR). '$$' is an escaped
// literal dollar and never a reference.
function envRefs(text) {
  const found = new Map();
  const clean = String(text || '').replace(/\$\$/g, '');
  const braced = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::([-?])([^}]*)?)?\}/g;
  let m;
  while ((m = braced.exec(clean)) && found.size < 40) {
    const key = m[1];
    if (key === 'COMPOSE_PROJECT_NAME' || found.has(key)) continue;
    const op = m[2] || '';
    found.set(key, { key, required: op === '?', message: (op === '?' ? String(m[3] || '').trim() : '') || null, def: (op === '-' ? String(m[3] || '') : '') || null });
  }
  const bare = /(?:^|[^\w$])\$([A-Za-z_][A-Za-z0-9_]*)(?![\w{])/g;
  while ((m = bare.exec(clean)) && found.size < 40) {
    if (!found.has(m[1]) && m[1] !== 'COMPOSE_PROJECT_NAME') found.set(m[1], { key: m[1], required: false, message: null, def: null });
  }
  return [...found.values()];
}

function parsePort(item) {
  const t = unquote(item).replace(/\/(tcp|udp)$/i, '');
  const m = t.match(/^(?:(\[[^\]]+\]|[^:]+):)?(\d+)(?::(\d+))?$/);
  if (!m) return null;
  if (m[3]) return { host: m[1] || null, container: parseInt(m[2], 10) || parseInt(m[3], 10) };
  if (m[1] && /^\d+$/.test(m[1])) return { host: parseInt(m[1], 10), container: parseInt(m[2], 10) };
  return { host: null, container: parseInt(m[2], 10) };
}

function readComposeTopo(codeDir) {
  let file = null, text = '';
  for (const name of COMPOSE_FILES) {
    try {
      const p = path.join(codeDir, name);
      const stat = fs.lstatSync(p);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_BYTES) continue;
      text = fs.readFileSync(p, 'utf8');
      file = name;
      break;
    } catch {}
  }
  if (!file) return null;
  const lines = String(text).split(/\r?\n/).slice(0, 800);
  // Find the services: block (top-level key).
  let svcStart = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^services:\s*(#.*)?$/.test(lines[i])) { svcStart = i; break; }
    if (/^[A-Za-z][A-Za-z0-9_-]*:\s*(#.*)?$/.test(lines[i]) && !/^services:/.test(lines[i])) continue;
  }
  if (svcStart < 0) return { file, services: [], envNeeds: [] };
  const services = [];
  let cur = null, section = null;
  const flush = () => { if (cur) { services.push(cur); cur = null; } section = null; };
  for (let i = svcStart + 1; i < lines.length && services.length < MAX_SERVICES; i++) {
    const raw = stripComment(lines[i]);
    if (!raw.trim()) continue;
    const indent = raw.match(/^ */)[0].length;
    if (indent === 0) { flush(); break; } // next top-level key ends services
    if (indent === 2) {
      const m = raw.match(/^  ([A-Za-z0-9][A-Za-z0-9_-]*):\s*(.*)$/);
      if (!m) { flush(); continue; }
      flush();
      cur = { name: m[1], _inline: m[2].trim(), build: null, image: null, ports: [], env: [], command: null, oneShot: false, dependsOn: [] };
      section = null;
      continue;
    }
    if (!cur || indent < 4) continue;
    if (indent === 4) {
      const m = raw.match(/^    ([A-Za-z0-9_-]+):\s*(.*)$/);
      if (!m) { section = null; continue; }
      const key = m[1], val = m[2].trim();
      section = key;
      if (key === 'build' && val) cur.build = { context: unquote(val), dockerfile: null };
      else if (key === 'build') cur.build = cur.build || { context: null, dockerfile: null };
      else if (key === 'image' && val) cur.image = unquote(val);
      else if (key === 'command' && val) cur.command = unquote(val);
      else if (key === 'entrypoint' && val) cur.command = cur.command || unquote(val);
      else if (key === 'restart' && /^(no|false)$/i.test(unquote(val).replace(/["']/g, ''))) cur.oneShot = true;
      continue;
    }
    // indent >= 6: list items or nested build map
    const item = raw.trim().replace(/^-\s+/, '');
    if (section === 'build' && cur) {
      if (!cur.build) cur.build = { context: null, dockerfile: null };
      const m = raw.match(/^\s+(context|dockerfile|target):\s*(.*)$/);
      if (m) {
        if (m[1] === 'context') cur.build.context = unquote(m[2]);
        if (m[1] === 'dockerfile') cur.build.dockerfile = unquote(m[2]);
      }
      continue;
    }
    if (section === 'ports' && cur) {
      const p = parsePort(item);
      if (p) cur.ports.push(p);
      continue;
    }
    if (section === 'environment' && cur) {
      const pair = item.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s) ||
        item.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/s);
      if (pair) {
        const refs = envRefs(unquote(pair[2]));
        cur.env.push({ key: pair[1], value: pair[2] });
        for (const r of refs) (cur._envNeeds = cur._envNeeds || new Map()).set(r.key, r);
      } else {
        const bare = item.match(/^([A-Za-z_][A-Za-z0-9_]*)$/);
        if (bare) {
          cur.env.push({ key: bare[1], value: null, refs: [] });
          (cur._envNeeds = cur._envNeeds || new Map()).set(bare[1], { key: bare[1], required: true, message: 'passed through from host environment in compose', def: null });
        }
      }
      continue;
    }
    if (section === 'depends_on' && cur) {
      const m = item.match(/^([A-Za-z0-9][A-Za-z0-9_-]*)/);
      if (m && !cur.dependsOn.includes(m[1])) cur.dependsOn.push(m[1]);
      continue;
    }
    if ((section === 'command' || section === 'entrypoint') && cur && item) {
      cur.command = cur.command ? cur.command + ' ' + item : item;
      continue;
    }
  }
  flush();
  // Inline `build: ./dir` shorthand.
  for (const s of services) {
    if (s._inline && !s.build) s.build = { context: unquote(s._inline), dockerfile: null };
    delete s._inline;
  }
  // Aggregate env needs across services (and stray ${} anywhere in the file).
  const agg = new Map();
  for (const s of services) {
    for (const [k, r] of (s._envNeeds || new Map())) {
      if (!agg.has(k)) agg.set(k, { ...r, services: [s.name] });
      else {
        const e = agg.get(k);
        if (!e.services.includes(s.name)) e.services.push(s.name);
        if (r.required) { e.required = true; e.message = e.message || r.message; }
        if (!e.def && r.def) e.def = r.def;
      }
    }
    delete s._envNeeds;
  }
  for (const r of envRefs(text)) {
    if (!agg.has(r.key)) agg.set(r.key, { ...r, services: [] });
  }
  return { file, services, envNeeds: [...agg.values()] };
}

module.exports = { COMPOSE_FILES, readComposeTopo, envRefs, parsePort };
