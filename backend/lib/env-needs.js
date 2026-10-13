const fs = require('fs');
const path = require('path');
const { readComposeTopo } = require('./compose-read');

const ENV_SCAN_SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'vendor', '__pycache__', '.venv', 'venv']);
const ENV_SCAN_NOISE = new Set(['PATH', 'HOME', 'USER', 'SHELL', 'PWD', 'OLDPWD', 'LANG', 'LC_ALL', 'TZ', 'TMPDIR', 'TEMP', 'TMP', 'NODE_PATH']);

// Code-referenced env vars (process.env.X, getenv(), $_ENV[] …), bounded walk.
// Cannot tell required from optional - callers report, never block or invent.
function scanEnvNeeds(dir) {
  const codeDir = path.join(dir, 'code');
  const files = [];
  const walk = (d, depth) => {
    if (depth > 4 || files.length > 300) return;
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (files.length > 300) return;
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (!ENV_SCAN_SKIP_DIRS.has(e.name)) walk(p, depth + 1); }
      else if (e.isFile()) {
        if (e.name === '.env' || e.name === '.env.example') continue;
        if (/\.(js|ts|jsx|tsx|mjs|cjs|php|py)$/.test(e.name)) {
          try { if (fs.statSync(p).size > 200 * 1024) continue; } catch { continue; }
          files.push(p);
        }
      }
    }
  };
  walk(codeDir, 0);
  const pats = [
    /process\.env\.([A-Za-z_][A-Za-z0-9_]*)/g,
    /process\.env\[\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]\s*\]/g,
    /getenv\(\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]\s*\)/g,
    /\$_(?:ENV|SERVER)\[\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]\s*\]/g,
    /os\.environ(?:\.get)?\(\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]\s*\)/g,
    /os\.getenv\(\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]\s*\)/g
  ];
  const found = new Set();
  for (const f of files) {
    let text = '';
    try { text = fs.readFileSync(f, 'utf8'); } catch { continue; }
    for (const re of pats) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(text)) && found.size < 50) {
        const k = m[1];
        if (k && !ENV_SCAN_NOISE.has(k)) found.add(k);
      }
    }
    if (found.size >= 50) break;
  }
  return [...found].sort();
}

function readEnvVars(envPath) {
  const vars = [];
  try {
    for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s?(.*)$/);
      if (m) vars.push({ key: m[1], value: m[2] });
    }
  } catch {}
  return vars;
}

// Code-referenced vars missing (or empty) in the site .env. Empty counts as
// unset: a referenced key with no value can't function. Compose-required vars
// (${VAR:?}) join the unset list with their messages - the repo authors marked
// them non-optional, so silence would just defer the crash.
function missingEnvVars(dir) {
  const need = scanEnvNeeds(dir);
  const valOf = new Map(readEnvVars(path.join(dir, '.env')).map(v => [v.key, v.value]));
  const missing = need.filter(k => !valOf.has(k));
  const empty = need.filter(k => valOf.has(k) && !String(valOf.get(k)).trim());
  const unset = [...missing, ...empty];
  let compose = [];
  try {
    compose = composeEnvNeeds(path.join(dir, 'code'));
  } catch { compose = []; }
  const composeRequired = [];
  for (const e of compose) {
    if (!e.required) continue;
    if (valOf.has(e.key) && String(valOf.get(e.key)).trim()) continue;
    if (!unset.includes(e.key)) unset.push(e.key);
    composeRequired.push(e);
  }
  return { need, missing, empty, unset, compose: composeRequired };
}

// Env needs declared by the repo compose file(s). Only :?-required keys join
// the unset list (:- defaults work without the operator); messages ride along
// so surfaces can quote the repo's own words instead of guessing.
function composeEnvNeeds(codeDir) {
  let topo = null;
  try { topo = readComposeTopo(codeDir); } catch { return []; }
  if (!topo) return [];
  return (topo.envNeeds || []).map(e => ({ ...e, file: topo.file }));
}

module.exports = { ENV_SCAN_SKIP_DIRS, ENV_SCAN_NOISE, scanEnvNeeds, readEnvVars, missingEnvVars, composeEnvNeeds };
