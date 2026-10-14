const { isJekyll } = require('./build-profile');
// Stack detection from a repo file listing. Pure function - unit-testable.
// Returns { type|null, detected, reason, dbs[] }. Types match templates/*.
function decideType(paths, pkg) {
  const list = (paths || []).filter(Boolean);
  const root = name => list.includes(name);
  const any = re => list.some(p => re.test(p));
  const shallowest = re => {
    const hit = list.filter(p => re.test(p)).sort((a, b) => a.length - b.length);
    return hit[0] || null;
  };

  // database hints from driver deps (confident packages only)
  const deps = { ...(((pkg || {}).dependencies) || {}), ...(((pkg || {}).devDependencies) || {}) };
  const dbs = [];
  if (deps.pg || deps.postgres || deps['pg-hstore'] || deps['@neondatabase/serverless']) dbs.push('postgres');
  if (deps.mysql || deps.mysql2) dbs.push('mysql');
  if (deps.mariadb) dbs.push('mariadb');
  if (deps.mongoose || deps.mongodb) dbs.push('mongo');
  if (deps.redis || deps.ioredis || deps.bull || deps.bullmq) dbs.push('redis');

  const pkgPath = shallowest(/(^|\/)package\.json$/);
  if (isJekyll(list, pkg)) return { type: 'static', detected: 'jekyll', dbs: [], reason: 'Jekyll static site - Ruby/Node build, nginx serves the generated output' };
  // Laravel/full-stack PHP apps ship a root package.json that is only the
  // Vite asset pipeline (laravel-vite-plugin, tailwind). The framework
  // markers win so the app is not misread as a standalone React frontend.
  if (root('composer.json') && (root('artisan') || deps['laravel-vite-plugin'])) {
    return { type: 'php', detected: 'php', dbs, reason: 'composer.json + Laravel console (artisan) - root package.json is the Vite asset pipeline' };
  }
  if (pkgPath && pkg && typeof pkg === 'object') {
    const scripts = (pkg && pkg.scripts) || {};
    // A declared production start script IS the runtime. This is the generic
    // rule, so present and future server frameworks need no per-framework
    // patch: dev-server commands (react-scripts start, vite, next dev, ...)
    // are not production runtimes and fall through to the markers below.
    if (scripts.start && !DEV_SERVER_START.some(re => re.test(String(scripts.start)))) {
      return { type: 'node', detected: 'start-script', dbs, reason: `${pkgPath} runs "${scripts.start}"` };
    }
    // Next.js/Nuxt run as Node servers (build + start), never as nginx-static
    // output. They must not fall into the React static template below.
    if (deps.next || deps.nuxt || any(/next\.config\.(js|mjs|cjs|ts)$/) || any(/nuxt\.config\.(js|mjs|cjs|ts)$/)) {
      return { type: 'node', detected: deps.next || any(/next\.config\.(js|mjs|cjs|ts)$/) ? 'next' : 'nuxt', dbs, reason: `${pkgPath} + Next/Nuxt markers - runs as a Node server (build + start)` };
    }
    const reactish = deps.react || deps['react-dom'] || deps['react-scripts'] || deps.gatsby || deps['@vitejs/plugin-react'] || deps['@vitejs/plugin-react-swc'];
    if (reactish) {
      if (!scripts.build) return { type: 'react', detected: 'react', dbs, reason: `${pkgPath} uses React but has no build script - react template needs "npm run build" -> dist/ or build/` };
      return { type: 'react', detected: 'react', dbs, reason: `${pkgPath} + React deps` };
    }
    if (any(/vite\.config\.(js|ts|mjs|cjs)/)) {
      if (!scripts.build) return { type: null, detected: 'vite', dbs, reason: 'vite project without a build script - add "build" emitting dist/ or build/, or pick manually' };
      return { type: 'react', detected: 'vite', dbs, reason: 'vite project (built + served as static)' };
    }
    return { type: 'node', detected: 'node', dbs, reason: `${pkgPath} with no frontend markers` };
  }
  if (root('composer.json') || shallowest(/(^|\/)index\.php$/) || any(/\.php$/)) {
    return { type: 'php', detected: 'php', dbs, reason: 'composer.json / php files present' };
  }
  if (root('index.html') || root('index.htm')) {
    return { type: 'static', detected: 'static', dbs, reason: 'index.html at root' };
  }
  // A server entry with no manifest still runs on the Node template
  // (npm start falls back to node server.js/index.js).
  if (root('server.js') || root('index.js') || root('server.cjs') || root('index.cjs') || root('server.mjs') || root('index.mjs')) {
    return { type: 'node', detected: 'server-entry', dbs, reason: 'server.js/index.js at root with no package.json' };
  }
  if (root('requirements.txt') || root('pyproject.toml') || root('setup.py') || any(/\.py$/)) {
    return { type: null, detected: 'python', dbs, reason: 'python apps have no template yet - pick manually' };
  }
  if (any(/\.rb$/)) return { type: null, detected: 'ruby', dbs, reason: 'ruby apps have no template yet - pick manually' };
  if (any(/go\.mod$/)) return { type: null, detected: 'go', dbs, reason: 'go apps have no template yet - pick manually' };
  return { type: null, detected: null, dbs, reason: 'no recognizable markers (package.json, composer.json, index.php, index.html) - pick manually' };
}

// Runnable-entry gate: does this folder have what the type template needs to
// start a server? Mirrors ensureDockerfile seeding so the gate and the seeder
// never disagree. Pure - unit-test with fixtures.
const RUNNABLE_START = ['start', 'start:prod', 'start:production', 'start:built', 'serve'];
const RUNNABLE_NODE_FILES = ['index.js', 'server.js', 'index.cjs', 'server.cjs', 'index.mjs', 'server.mjs'];
function hasRunnableEntry(relPaths, pkg, type) {
  const rel = Array.isArray(relPaths) ? relPaths.filter(p => typeof p === 'string' && p) : [];
  const direct = new Set(rel.filter(p => !p.includes('/')));
  const lower = new Set([...direct].map(f => f.toLowerCase()));
  if (type === 'static') {
    if (lower.has('index.html') || lower.has('index.htm')) return { runnable: true, why: 'index.html present' };
    return { runnable: false, why: 'static sites need index.html in the build folder' };
  }
  if (type === 'php') {
    if (lower.has('composer.json') || lower.has('index.php')) return { runnable: true, why: 'composer.json/index.php present' };
    return { runnable: false, why: 'PHP sites need index.php or composer.json in the build folder' };
  }
  if (type === 'react') {
    const scripts = (pkg && pkg.scripts) || {};
    if (scripts.build) return { runnable: true, why: 'package.json build script present' };
    return { runnable: false, why: 'React sites need a package.json "build" script emitting dist/' };
  }
  if (type === 'node') {
    const scripts = (pkg && pkg.scripts) || {};
    for (const k of RUNNABLE_START) {
      if (scripts[k] && !DEV_SERVER_START.some(re => re.test(String(scripts[k])))) return { runnable: true, why: `package.json "${k}" script present` };
    }
    const main = pkg && typeof pkg.main === 'string' ? pkg.main.replace(/\\/g, '/').replace(/^\.\//, '') : null;
    if (main && /\.(?:js|cjs|mjs)$/.test(main) && rel.includes(main)) return { runnable: true, why: `package.json main ${main} present` };
    for (const f of RUNNABLE_NODE_FILES) {
      if (direct.has(f)) return { runnable: true, why: `${f} present` };
    }
    return { runnable: false, why: 'Node sites need a production start script, a main entry, or server.js/index.js in the build folder' };
  }
  return { runnable: false, why: `unknown runtime type '${type}'` };
}
// One canonical package-manager read for every detector: the packageManager
// field wins, then lockfiles, then npm. Takes { pkg, files } where files are
// basenames or relative paths. Pure - unit-test with fixtures.
function detectPackageManager({ pkg, files } = {}) {
  const field = pkg && typeof pkg.packageManager === 'string' ? pkg.packageManager.trim() : '';
  const named = /^(npm|pnpm|yarn|bun)(?:@(.+))?$/i.exec(field);
  if (named) return { manager: named[1].toLowerCase(), version: named[2] || null, source: 'packageManager' };
  const list = Array.isArray(files) ? files : [];
  const has = n => list.some(p => String(p).replace(/\\/g, '/').split('/').pop() === n);
  if (has('pnpm-lock.yaml')) return { manager: 'pnpm', version: null, source: 'lockfile' };
  if (has('yarn.lock')) return { manager: 'yarn', version: null, source: 'lockfile' };
  if (has('bun.lockb') || has('bun.lock')) return { manager: 'bun', version: null, source: 'lockfile' };
  if (has('package-lock.json') || has('npm-shrinkwrap.json')) return { manager: 'npm', version: null, source: 'lockfile' };
  return { manager: 'npm', version: null, source: 'default' };
}

// Monorepo sub-apps from workspace manifests (npm/pnpm/lerna) or tooling
// conventions (turbo/nx), resolved against dirs that actually hold a package.json.
// Pure - unit-test with fixtures.
function expandWorkspaces(tree, rootPkg) {
  const patterns = [];
  if (rootPkg && rootPkg.workspaces) {
    const w = Array.isArray(rootPkg.workspaces) ? rootPkg.workspaces : rootPkg.workspaces.packages;
    if (Array.isArray(w)) patterns.push(...w);
  }
  return patterns;
}

function matchWorkspaces(tree, patterns) {
  const found = [];
  const dirsWithPkg = new Set(tree.filter(p => /(^|\/)package\.json$/.test(p)).map(p => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '')));
  for (const pat of patterns) {
    if (typeof pat !== 'string' || !pat) continue;
    if (pat.includes('*')) {
      const prefix = pat.split('*')[0];
      for (const d of dirsWithPkg) {
        if (d && d.startsWith(prefix) && !d.slice(prefix.length).includes('/')) found.push(d);
      }
    } else {
      const base = pat.replace(/\/$/, '');
      if (base && dirsWithPkg.has(base)) found.push(base);
    }
  }
  return [...new Set(found)];
}

// Backend sub-app folders: package.json with a runnable start script or main
// entry, not a frontend, depth <= 2. pkgs maps dir -> parsed package.json
// (null when unreadable). skip lists dirs already classified as frontends.
// Pure - unit-test with fixtures.
function findBackends(tree, pkgs, skip = []) {
  const skipSet = new Set(skip || []);
  const found = [];
  const dirs = new Set(
    tree.filter(p => /(^|\/)package\.json$/.test(p))
      .map(p => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : ''))
      .filter(d => d && d.split('/').length <= 2 && !skipSet.has(d))
  );
  for (const d of dirs) {
    const pkg = pkgs[d];
    if (!pkg || typeof pkg !== 'object') continue;
    if (isJekyll(tree.filter(p => p.startsWith(d + '/')).map(p => p.slice(d.length + 1)), pkg)) continue;
    const scripts = pkg.scripts || {};
    // dev-server start scripts (CRA, vite, ng, vue-cli, nuxt/next dev) are not
    // production backends - the panel builds + serves those as frontends.
    if (scripts.start && DEV_SERVER_START.some(re => re.test(String(scripts.start)))) continue;
    if (scripts.start || pkg.main) found.push(d);
  }
  return [...new Set(found)];
}

// Frontend sub-app folders, depth <= 2: framework config markers (vite,
// Angular, Vue), CRA layout (public/index.html + src entry), or a
// package.json with UI deps + a build script and no server deps. Next/Nuxt
// are deliberately absent: they run as Node servers, not static output.
// pkgs is optional - markers alone classify without any extra API reads.
// Pure - unit-test with fixtures.
const FRONTEND_CONFIG_MARKERS = [
  /^vite\.config\.(js|mjs|cjs|ts)$/,
  /^angular\.json$/,
  /^vue\.config\.js$/,
  /^craco\.config\.js$/
];
const FRONTEND_DEPS = ['react', 'react-dom', 'vue', '@angular/core', 'gatsby',
  'svelte', '@sveltejs/kit', 'solid-js', 'preact', '@solidjs/start'];
const NEXT_NUXT_DEPS = ['next', 'nuxt'];
const NEXT_NUXT_CONFIG = [/^next\.config\.(js|mjs|cjs|ts)$/, /^nuxt\.config\.(js|mjs|cjs|ts)$/];
const SERVER_DEPS = ['express', 'fastify', 'koa', '@nestjs/core', 'hapi', '@hapi/hapi', 'restify'];
const DEV_SERVER_START = [/^react-scripts start/, /^vite(\s|$)/, /^ng serve/, /^vue-cli-service serve/, /^nuxt dev/, /^next dev/];
const CLIENT_ENTRIES = ['src/index.js', 'src/index.jsx', 'src/index.ts', 'src/index.tsx',
  'src/main.js', 'src/main.jsx', 'src/main.ts', 'src/main.tsx', 'src/App.js', 'src/App.tsx'];

function findFrontends(tree, pkgs = {}) {
  const found = [];
  const byDir = new Map();
  for (const p of tree || []) {
    if (typeof p !== 'string' || !p) continue;
    const d = p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '';
    if (!d || d.split('/').length > 2) continue;
    if (!byDir.has(d)) byDir.set(d, []);
    byDir.get(d).push(p.slice(d.length + 1));
  }
  for (const [d, files] of byDir) {
    const roots = files.filter(f => !f.includes('/'));
    if (isJekyll(tree.filter(p => p.startsWith(d + '/')).map(p => p.slice(d.length + 1)), pkgs[d])) { found.push(d); continue; }
    if (roots.some(f => FRONTEND_CONFIG_MARKERS.some(re => re.test(f)))) { found.push(d); continue; }
    if (files.includes('package.json') && files.includes('public/index.html') &&
        CLIENT_ENTRIES.some(e => files.includes(e))) { found.push(d); continue; }
    const pkg = pkgs[d];
    if (pkg && typeof pkg === 'object') {
      const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
      const scripts = pkg.scripts || {};
      // Next/Nuxt run as Node servers - never static frontends, even with
      // React deps and a build script present.
      if (NEXT_NUXT_DEPS.some(k => deps[k]) || roots.some(f => NEXT_NUXT_CONFIG.some(re => re.test(f)))) continue;
      if (scripts.build && FRONTEND_DEPS.some(k => deps[k]) && !SERVER_DEPS.some(k => deps[k])) { found.push(d); continue; }
    }
  }
  return [...new Set(found)];
}

// Driver use inside JS/TS sources: require('mariadb') / import ... from 'pg'
// when there is no package.json to read deps from (sample repos, vendored
// scripts). Comment-only mentions are ignored; the call must look like code.
function jsDriverHints(text) {
  const dbs = [];
  const src = String(text || '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');
  const mods = new Set();
  for (const m of src.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)) mods.add(m[1].toLowerCase());
  for (const m of src.matchAll(/from\s+['"]([^'"]+)['"]/g)) mods.add(m[1].toLowerCase());
  const has = (...names) => names.some(n => mods.has(n) || [...mods].some(m => m === n || m.startsWith(n + '/')));
  if (has('mariadb')) dbs.push('mariadb');
  else if (has('mysql', 'mysql2')) dbs.push('mysql');
  if (has('pg', 'postgres', 'pg-hstore', '@neondatabase/serverless')) dbs.push('postgres');
  if (has('mongoose', 'mongodb')) dbs.push('mongo');
  if (has('redis', 'ioredis', 'bull', 'bullmq')) dbs.push('redis');
  return [...new Set(dbs)];
}
// A MariaDB export can be consumed through MySQL-compatible drivers, so
// package dependencies alone often say mysql/mysql2. Schema syntax is the
// stronger signal when it names MariaDB or a MariaDB-only UCA 1400 collation.
function sqlDatabaseHints(text) {
  const sql = String(text || '');
  if (/\bMariaDB\b/i.test(sql) || /utf8mb4_uca1400_[a-z0-9_]+/i.test(sql)) return ['mariadb'];
  if (/--\s*PostgreSQL database dump/i.test(sql) || /\bCREATE\s+EXTENSION\b/i.test(sql) ||
      /\b(?:BIG|SMALL)?SERIAL\b/i.test(sql) || /\bSET\s+search_path\b/i.test(sql) ||
      /\bLANGUAGE\s+plpgsql\b/i.test(sql) || /::(?:uuid|jsonb|regclass)\b/i.test(sql) ||
      /\bGENERATED\s+(?:BY DEFAULT|ALWAYS)\s+AS\s+IDENTITY\b/i.test(sql)) return ['postgres'];
  if (/--\s*MySQL dump/i.test(sql) || /\bENGINE\s*=\s*(?:InnoDB|MyISAM)\b/i.test(sql) ||
      /\bAUTO_INCREMENT\b/i.test(sql) || /\bDEFAULT\s+CHARSET\s*=/i.test(sql) ||
      /utf8mb4_0900_[a-z0-9_]+/i.test(sql) || /\bLOCK TABLES\b/i.test(sql)) return ['mysql'];
  return [];
}

const DB_ALIASES = {
  postgres: 'postgres', postgresql: 'postgres', pg: 'postgres', pgsql: 'postgres',
  mysql: 'mysql', mysql2: 'mysql', mariadb: 'mariadb',
  mongo: 'mongo', mongodb: 'mongo', redis: 'redis', ioredis: 'redis',
  sqlite: 'sqlite', sqlite3: 'sqlite', 'better-sqlite3': 'sqlite'
};

function literalSettings(text, key) {
  const source = String(text || '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*(?:\/\/|#).*$/gm, '');
  const re = new RegExp(`["']?${key}["']?\\s*[:=]\\s*["']([^"']+)["']`, 'gi');
  return [...source.matchAll(re)].map(match => match[1].trim().toLowerCase());
}

// Infer only from explicit literals in conventional ORM/framework config
// files. Dynamic process.env values are intentionally ignored: selecting a
// database from a variable name would be a guess rather than repository fact.
function databaseConfigHints(filePath, text) {
  const file = String(filePath || '').replace(/\\/g, '/').toLowerCase();
  const body = String(text || '');
  let values = [];
  if (/(^|\/)drizzle\.config\.(?:js|cjs|mjs|ts)$/.test(file)) values = literalSettings(body, 'dialect');
  else if (/(^|\/)knexfile\.(?:js|cjs|mjs|ts)$/.test(file)) values = literalSettings(body, 'client');
  else if (/(^|\/)(?:ormconfig|data-source|typeorm\.config)\.(?:json|js|cjs|mjs|ts)$/.test(file)) values = literalSettings(body, 'type');
  else if (/(^|\/)(?:config\/config|sequelize\.config)\.(?:json|js|cjs|mjs|ts)$/.test(file)) values = literalSettings(body, 'dialect');
  else if (/(^|\/)\.env\.(?:example|sample)$/.test(file)) {
    const match = body.match(/^\s*DB_CONNECTION\s*=\s*["']?([A-Za-z0-9_-]+)["']?\s*(?:#.*)?$/mi);
    values = match ? [match[1].toLowerCase()] : [];
  } else if (/(^|\/)config\/database\.php$/.test(file)) {
    const fallback = body.match(/['"]default['"]\s*=>\s*env\(\s*['"]DB_CONNECTION['"]\s*,\s*['"]([^'"]+)['"]/i);
    const direct = body.match(/['"]default['"]\s*=>\s*['"]([^'"]+)['"]/i);
    values = [(fallback && fallback[1] || direct && direct[1] || '').toLowerCase()];
  }
  const dbs = [...new Set(values.map(value => DB_ALIASES[value]).filter(Boolean))];
  return dbs.length === 1 ? dbs : [];
}

// Prisma's client package is database-neutral, so dependency inspection cannot
// identify the managed service. The datasource provider is explicit and is a
// safe signal for the database choices the panel supports.
function prismaDatabaseHints(text) {
  const schema = String(text || '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  const dbs = [];
  const providers = { postgresql: 'postgres', mysql: 'mysql', mongodb: 'mongo' };
  for (const match of schema.matchAll(/datasource\s+[A-Za-z_][A-Za-z0-9_]*\s*\{([\s\S]*?)\}/g)) {
    const provider = match[1].match(/\bprovider\s*=\s*["']([^"']+)["']/i);
    const db = provider && providers[provider[1].toLowerCase()];
    if (db && !dbs.includes(db)) dbs.push(db);
  }
  return dbs;
}

// Deep runnable-root search: read every downloaded file path and find the
// correct build folder so a nested app (htdocs/, public/, app/ wrapper)
// succeeds without manual subdir entry. Pure - unit-test with fixtures.
const SKIP_ROOT_DIRS = new Set(['.git', 'node_modules', 'vendor', '.next', '.nuxt', '.venv', '__pycache__', 'dist', 'build']);
function findRunnableRoot(tree, pkgs = {}) {
  const list = Array.isArray(tree) ? tree.filter(p => typeof p === 'string' && p) : [];
  if (!list.length) return null;
  const inSkipped = p => String(p).split('/').some(seg => SKIP_ROOT_DIRS.has(seg));
  const usable = list.filter(p => !inSkipped(p));
  if (!usable.length) return null;
  const dirs = new Set(['']);
  for (const p of usable) {
    const parts = p.split('/');
    parts.pop();
    for (let i = 1; i <= parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
  }
  const found = [];
  for (const d of dirs) {
    const prefix = d ? d + '/' : '';
    const rel = [];
    for (const p of usable) {
      if (p === d) continue;
      if (d === '' || p.startsWith(prefix)) rel.push(p.slice(prefix.length));
    }
    if (!rel.length) continue;
    // Direct markers only: a parent is not runnable because a child is.
    // decideType itself matches nested php/static, so gate on direct files
    // first (mirrors ensureDockerfile seeding: index.html / index.php /
    // composer.json / package.json at the folder root).
    const direct = new Set(rel.filter(p => !p.includes('/')).map(p => p.toLowerCase()));
    if (!direct.size) continue;
    const hasPkg = direct.has('package.json');
    const hasPhp = direct.has('composer.json') || direct.has('index.php');
    const hasStatic = direct.has('index.html') || direct.has('index.htm');
    if (!hasPkg && !hasPhp && !hasStatic) continue;
    const raw = pkgs[d] !== undefined ? pkgs[d] : (d === '' && pkgs['.'] !== undefined ? pkgs['.'] : (d === '.' && pkgs[''] !== undefined ? pkgs[''] : undefined));
    const pkg = raw;
    // Private workspace roots without a runtime are folders, not apps.
    if (pkg && pkg.private === true && !((pkg.scripts || {}).start) && !pkg.main) continue;
    const r = decideType(rel, pkg || null);
    if (r && r.type) found.push({ subdir: d, type: r.type, detected: r.detected, reason: r.reason, dbs: r.dbs || [] });
  }
  if (!found.length) return null;
  found.sort((a, b) => {
    if ((a.subdir === '') !== (b.subdir === '')) return a.subdir === '' ? -1 : 1;
    const da = a.subdir ? a.subdir.split('/').length : 0;
    const db = b.subdir ? b.subdir.split('/').length : 0;
    if (da !== db) return da - db;
    if (a.subdir.length !== b.subdir.length) return a.subdir.length - b.subdir.length;
    return a.subdir.localeCompare(b.subdir);
  });
  return found[0];
}

module.exports = { decideType, detectPackageManager, expandWorkspaces, matchWorkspaces, findBackends, findFrontends, sqlDatabaseHints, prismaDatabaseHints, databaseConfigHints, findRunnableRoot, jsDriverHints, hasRunnableEntry };
