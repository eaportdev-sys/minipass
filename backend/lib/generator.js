const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');
const { appGitEnv } = require('./ssh');
const { readBuildProfile, prepareStaticBuild } = require('./build-profile');

const DB_IMAGES = {
  postgres: 'postgres:16-alpine',
  mysql: 'mysql:8',
  mariadb: 'mariadb:11.8',
  mongo: 'mongo:7',
  redis: 'redis:7-alpine'
};

// Default in-container port per type
const TYPE_PORT = { node: 3000, react: 80, php: 80, static: 80 };
const VALID_DBS = ['postgres', 'mysql', 'mariadb', 'mongo', 'redis'];

function normDbs(db) {
  const arr = Array.isArray(db) ? db : String(db == null ? 'none' : db).split(/[+,]/);
  return [...new Set(arr.map(s => String(s).trim().toLowerCase()).filter(s => VALID_DBS.includes(s)))];
}

// Seed a Dockerfile only when the repo shape makes the choice unambiguous.
// Anything else fails loud with exactly what's missing - never a bare build error.
function ensureDockerfile(ctxDir, type, templatesDir, options = {}) {
  if (type === 'static' && readBuildProfile(ctxDir).kind === 'jekyll') {
    const result = prepareStaticBuild(ctxDir, templatesDir, options);
    if (result.prepared) {
      const nginx = path.join(ctxDir, 'nginx.conf');
      if (!fs.existsSync(nginx)) fs.writeFileSync(nginx, nginxConf(null));
      return 'seeded-jekyll';
    }
  }
  try {
    const files = fs.readdirSync(ctxDir);
    if (files.some(f => /^dockerfile$/i.test(f))) return 'present';
  } catch { return 'no-context'; }
  const has = (...names) => names.some(n => {
    try { return fs.existsSync(path.join(ctxDir, n)); } catch { return false; }
  });
  const seed = (...files) => {
    for (const f of files) {
      const src = path.join(templatesDir, type, f);
      const dst = path.join(ctxDir, f);
      if (fs.existsSync(src) && !fs.existsSync(dst)) fs.copyFileSync(src, dst);
    }
  };
  const readPkg = () => {
    try { return JSON.parse(fs.readFileSync(path.join(ctxDir, 'package.json'), 'utf8')); }
    catch { return null; }
  };
  if (type === 'static' && (has('index.html') || has('index.htm'))) { seed('Dockerfile', 'nginx.conf'); return 'seeded-static'; }
  if (type === 'react') {
    const pkg = readPkg();
    if (pkg && pkg.scripts && pkg.scripts.build) { seed('Dockerfile', 'nginx.conf'); return 'seeded-react'; }
    throw new Error(`no Dockerfile and package.json has no build script - add a Dockerfile or a "build" script emitting dist/`);
  }
  if (type === 'php' && (has('index.php') || has('composer.json'))) { seed('Dockerfile'); return 'seeded-php'; }
  if (type === 'node' && has('index.js')) { seed('Dockerfile'); return 'seeded-node'; }
  throw new Error(`no Dockerfile in build context and type '${type}' has no safe default here - add a Dockerfile (with EXPOSE + CMD) to the repo`);
}

// Mirrors ensureDockerfile's safe auto-seed cases without writing anything.
// Used by validation so an explicit-standard-template button can be shown
// before Add is clicked, and can survive background UI refreshes.
function needsDockerfileOptIn(ctxDir, type) {
  let files = [];
  try { files = fs.readdirSync(ctxDir); } catch { return false; }
  if (files.some(f => /^dockerfile$/i.test(f))) return false;
  if (type === 'static' && readBuildProfile(ctxDir).kind === 'jekyll') return false;
  const has = (...names) => names.some(n => {
    try { return fs.existsSync(path.join(ctxDir, n)); } catch { return false; }
  });
  if (type === 'static' && (has('index.html') || has('index.htm'))) return false;
  if (type === 'react') {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(ctxDir, 'package.json'), 'utf8'));
      if (pkg && pkg.scripts && pkg.scripts.build) return false;
    } catch {}
  }
  if (type === 'php' && (has('index.php') || has('composer.json'))) return false;
  if (type === 'node' && has('index.js')) return false;
  return true;
}

// Seed missing keys from the repo's .env.example WITH their example values - those are
// the author's declared defaults, so a fresh deploy behaves until customized.
// Generated keys are never overwritten; review placeholders (keys, domains) after.
function seedEnvExample(ctxDir, haveKeys) {
  const added = [];
  try {
    const ex = require('fs').readFileSync(require('path').join(ctxDir, '.env.example'), 'utf8');
    for (const line of ex.split(/\r?\n/)) {
      const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s?(.*)$/);
      if (m && !haveKeys.has(m[1]) && !added.some(a => a.key === m[1])) {
        added.push({ key: m[1], value: m[2].trim().replace(/^["']|["']$/g, '') });
      }
    }
  } catch {}
  return added;
}

// Read the build context's Dockerfile for EXPOSE - any repo, any stack.
// First EXPOSE wins; falls back when absent or unreadable.
function inferPort(codeDir, fallback) {
  try {
    const m = fs.readFileSync(path.join(codeDir, 'Dockerfile'), 'utf8').match(/^\s*EXPOSE\s+(\d+)/im);
    if (m) {
      const p = parseInt(m[1], 10);
      if (p > 0 && p < 65536) return p;
    }
  } catch {}
  return fallback;
}

function pw(n = 24) {
  return crypto.randomBytes(n).toString('base64url').slice(0, n);
}

function appDir(appsDir, name) {
  return path.join(appsDir, name);
}

function dbEnv(db, name) {
  const rootPw = pw(24);
  const appPw = pw(24);
  if (db === 'postgres') return {
    lines: [`DB_HOST=db`, `DB_PORT=5432`, `DB_NAME=${name}`, `DB_USER=${name}`, `DB_PASSWORD=${appPw}`, `POSTGRES_PASSWORD=${rootPw}`],
    compose: `  db:\n    image: ${DB_IMAGES.postgres}\n    restart: unless-stopped\n    environment:\n      POSTGRES_DB: ${name}\n      POSTGRES_USER: ${name}\n      POSTGRES_PASSWORD: ${appPw}\n    volumes:\n      - dbdata:/var/lib/postgresql/data`
  };
  if (db === 'mysql') return {
    lines: [`DB_HOST=db`, `DB_PORT=3306`, `DB_NAME=${name}`, `DB_USER=${name}`, `DB_PASSWORD=${appPw}`, `MYSQL_ROOT_PASSWORD=${rootPw}`],
    compose: `  db:\n    image: ${DB_IMAGES.mysql}\n    restart: unless-stopped\n    environment:\n      MYSQL_DATABASE: ${name}\n      MYSQL_USER: ${name}\n      MYSQL_PASSWORD: ${appPw}\n      MYSQL_ROOT_PASSWORD: ${rootPw}\n    volumes:\n      - dbdata:/var/lib/mysql`
  };
  if (db === 'mariadb') return {
    lines: [`DB_HOST=db`, `DB_PORT=3306`, `DB_NAME=${name}`, `DB_USER=${name}`, `DB_PASSWORD=${appPw}`, `MARIADB_ROOT_PASSWORD=${rootPw}`],
    compose: `  db:\n    image: ${DB_IMAGES.mariadb}\n    restart: unless-stopped\n    environment:\n      MARIADB_DATABASE: ${name}\n      MARIADB_USER: ${name}\n      MARIADB_PASSWORD: ${appPw}\n      MARIADB_ROOT_PASSWORD: ${rootPw}\n    volumes:\n      - dbdata:/var/lib/mysql`
  };
  if (db === 'mongo') return {
    lines: [`MONGO_URL=mongodb://${name}:${appPw}@db:27017/${name}`],
    compose: `  db:\n    image: ${DB_IMAGES.mongo}\n    restart: unless-stopped\n    environment:\n      MONGO_INITDB_ROOT_USERNAME: ${name}\n      MONGO_INITDB_ROOT_PASSWORD: ${appPw}\n      MONGO_INITDB_DATABASE: ${name}\n    volumes:\n      - dbdata:/data/db`
  };
  if (db === 'redis') return {
    lines: [`REDIS_URL=redis://:${appPw}@db:6379`],
    compose: `  db:\n    image: ${DB_IMAGES.redis}\n    restart: unless-stopped\n    command: redis-server --requirepass ${appPw}\n    volumes:\n      - dbdata:/data`
  };
  return { lines: [], compose: '' };
}

// Multi-DB service block with prefixed vars (svc `db-<type>`, volume `dbdata-<type>`).
function dbService(db, name, svc, vol) {
  const rootPw = pw(24);
  const appPw = pw(24);
  const safe = name.replace(/[^a-z0-9]/gi, '').toLowerCase() || 'app';
  if (db === 'postgres') return {
    lines: [`POSTGRES_HOST=${svc}`, `POSTGRES_PORT=5432`, `POSTGRES_DB=${safe}`, `POSTGRES_USER=${safe}`, `POSTGRES_PASSWORD=${appPw}`],
    compose: `  ${svc}:\n    image: ${DB_IMAGES.postgres}\n    restart: unless-stopped\n    environment:\n      POSTGRES_DB: ${safe}\n      POSTGRES_USER: ${safe}\n      POSTGRES_PASSWORD: ${appPw}\n    volumes:\n      - ${vol}:/var/lib/postgresql/data`,
    vol, url: `postgresql://${safe}:${appPw}@${svc}:5432/${safe}`,
    info: { host: svc, port: 5432, name: safe, user: safe, pass: appPw }
  };
  if (db === 'mysql') return {
    lines: [`MYSQL_HOST=${svc}`, `MYSQL_PORT=3306`, `MYSQL_DB=${safe}`, `MYSQL_USER=${safe}`, `MYSQL_PASSWORD=${appPw}`],
    compose: `  ${svc}:\n    image: ${DB_IMAGES.mysql}\n    restart: unless-stopped\n    environment:\n      MYSQL_DATABASE: ${safe}\n      MYSQL_USER: ${safe}\n      MYSQL_PASSWORD: ${appPw}\n      MYSQL_ROOT_PASSWORD: ${rootPw}\n    volumes:\n      - ${vol}:/var/lib/mysql`,
    vol, url: `mysql://${safe}:${appPw}@${svc}:3306/${safe}`,
    info: { host: svc, port: 3306, name: safe, user: safe, pass: appPw }
  };
  if (db === 'mariadb') return {
    lines: [`MARIADB_HOST=${svc}`, `MARIADB_PORT=3306`, `MARIADB_DB=${safe}`, `MARIADB_USER=${safe}`, `MARIADB_PASSWORD=${appPw}`],
    compose: `  ${svc}:\n    image: ${DB_IMAGES.mariadb}\n    restart: unless-stopped\n    environment:\n      MARIADB_DATABASE: ${safe}\n      MARIADB_USER: ${safe}\n      MARIADB_PASSWORD: ${appPw}\n      MARIADB_ROOT_PASSWORD: ${rootPw}\n    volumes:\n      - ${vol}:/var/lib/mysql`,
    vol, url: `mysql://${safe}:${appPw}@${svc}:3306/${safe}`,
    info: { host: svc, port: 3306, name: safe, user: safe, pass: appPw }
  };
  if (db === 'mongo') return {
    lines: [`MONGO_HOST=${svc}`, `MONGO_PORT=27017`, `MONGO_DB=${safe}`, `MONGO_USER=${safe}`, `MONGO_PASSWORD=${appPw}`, `MONGO_URL=mongodb://${safe}:${appPw}@${svc}:27017/${safe}`],
    compose: `  ${svc}:\n    image: ${DB_IMAGES.mongo}\n    restart: unless-stopped\n    environment:\n      MONGO_INITDB_ROOT_USERNAME: ${safe}\n      MONGO_INITDB_ROOT_PASSWORD: ${appPw}\n      MONGO_INITDB_DATABASE: ${safe}\n    volumes:\n      - ${vol}:/data/db`,
    vol, url: `mongodb://${safe}:${appPw}@${svc}:27017/${safe}`,
    info: { host: svc, port: 27017, name: safe, user: safe, pass: appPw }
  };
  if (db === 'redis') return {
    lines: [`REDIS_HOST=${svc}`, `REDIS_PORT=6379`, `REDIS_PASSWORD=${appPw}`, `REDIS_URL=redis://:${appPw}@${svc}:6379`],
    compose: `  ${svc}:\n    image: ${DB_IMAGES.redis}\n    restart: unless-stopped\n    command: redis-server --requirepass ${appPw}\n    volumes:\n      - ${vol}:/data`,
    vol, url: `redis://:${appPw}@${svc}:6379`,
    info: null
  };
  return { lines: [], compose: '', vol, url: null, info: null };
}

function createApp({ appsDir, templatesDir, name, type, repoUrl, db = 'none', port, domain, hostPort, gitToken, subdir, gitBranch, standardDockerfile = false, modernizeBuild = false }) {
  const dir = appDir(appsDir, name);
  // resume allowed when a previous create died before writing compose (keys preserved)
  const resume = fs.existsSync(dir) && !fs.existsSync(path.join(dir, 'docker-compose.yml'));
  if (fs.existsSync(dir) && !resume) throw new Error('app exists');
  fs.mkdirSync(dir, { recursive: true });

  // 1. code: clone or copy template starter
  if (repoUrl) {
    // A missing-Dockerfile create deliberately leaves the checkout resumable.
    // On the opt-in retry, keep that checkout byte-for-byte; the old combined
    // if/else skipped the clone and then copied the template starter over the
    // repository's package.json.
    const haveCheckout = resume && fs.existsSync(path.join(dir, 'code', '.git'));
    const branch = String(gitBranch || '').trim();
    if (branch && !/^[A-Za-z0-9._\/-]+$/.test(branch)) throw new Error(`bad branch name '${branch}'`);
    if (haveCheckout && branch) {
      let checkedOut = '';
      try { checkedOut = execSync('git branch --show-current', { cwd: path.join(dir, 'code'), stdio: 'pipe' }).toString().trim(); } catch {}
      if (checkedOut !== branch) throw new Error('pending checkout uses a different branch - cancel creation and reopen before changing branches');
    }
    if (!haveCheckout) {
      const isSsh = /^(git@|ssh:\/\/)/i.test(repoUrl);
      // token injected in-memory only (stored repo URLs stay clean)
      const { authUrl, authUrlWith } = require('./github');
      const cloneUrl = isSsh ? repoUrl : (gitToken ? authUrlWith(repoUrl, gitToken) : authUrl(repoUrl));
      const redact = s => String(s).replace(/x-access-token:[^@]+@/g, 'x-access-token:***@');
      try {
        execSync(`git clone --depth 1 ${branch ? `-b ${branch} ` : ''}${cloneUrl} "${dir}/code"`, { stdio: 'pipe', env: isSsh ? appGitEnv(dir) : process.env });
      } catch (e) {
        // don't leave a half-created app behind (retry would hit "app exists");
        // keep per-app deploy keys so the key can still be shown + registered
        try {
          for (const f of fs.readdirSync(dir)) {
            if (f === 'deploy-key' || f === 'deploy-key.pub' || f === '.storage-quota.json' || f === '.pending-create.json') continue;
            fs.rmSync(path.join(dir, f), { recursive: true, force: true });
          }
        } catch {}
        const detail = redact(String((e.stderr || e.message || '')).split('\n').filter(Boolean).slice(-4).join(' | '));
        throw new Error(`git clone failed (${isSsh ? 'SSH remote - is the app deploy key registered on that repo?' : 'HTTPS remote - private repo? connect GitHub or embed a token'}): ${detail}`);
      }
    }
  } else {
    const tpl = path.join(templatesDir, type);
    fs.cpSync(path.join(tpl, 'starter'), path.join(dir, 'code'), { recursive: true });
    // copy all template top-level files (Dockerfile, nginx.conf, etc.) into build context
    for (const f of fs.readdirSync(tpl)) {
      const src = path.join(tpl, f);
      if (fs.statSync(src).isFile()) fs.copyFileSync(src, path.join(dir, 'code', f));
    }
  }

  // 1b. understand the code: validate subfolder, infer container port.
  // Explicit `port` always wins; otherwise the build context's Dockerfile EXPOSE
  // (whatever stack wrote it) beats the type default.
  const wantSub = String(subdir || '').replace(/^\/+|\/+$/g, '').replace(/\.\./g, '');
  // A requested subfolder that isn't in the code is NEVER silently dropped (that
  // builds repo root instead and serves the wrong app with zero warning).
  if (wantSub && repoUrl && !fs.existsSync(path.join(dir, 'code', wantSub))) {
    throw new Error(`subfolder '${wantSub}' not found in the cloned repo - push it first?`);
  }
  let sub = wantSub;
  if (sub && !fs.existsSync(path.join(dir, 'code', sub))) sub = '';
  const buildDir = sub ? path.join(dir, 'code', sub) : path.join(dir, 'code');
  // Only the selected context owns this profile; nested sites never retype APIs.
  const profile = readBuildProfile(buildDir);
  if (profile.kind === 'jekyll') type = 'static';
  // Explicit create-modal opt-in. Never replace a repository Dockerfile; this
  // only fills the missing file after the first validation explains why it is
  // needed. A failed first create remains resumable, so retry does not reclone.
  if (standardDockerfile && profile.kind !== 'jekyll' && !fs.existsSync(path.join(buildDir, 'Dockerfile'))) {
    const tpl = path.join(templatesDir, type);
    fs.copyFileSync(path.join(tpl, 'Dockerfile'), path.join(buildDir, 'Dockerfile'));
    if ((type === 'react' || type === 'static') && !fs.existsSync(path.join(buildDir, 'nginx.conf')) && fs.existsSync(path.join(tpl, 'nginx.conf')))
      fs.copyFileSync(path.join(tpl, 'nginx.conf'), path.join(buildDir, 'nginx.conf'));
  }
  // No Dockerfile anywhere is a loud, specific error - unless the repo shape makes
  // a template choice unambiguous (static index, spa build script, php entry, node index).
  // Never invent an entrypoint: node without index.js must bring its own Dockerfile.
  ensureDockerfile(buildDir, type, templatesDir, { modernize: modernizeBuild });
  let appPort = port || TYPE_PORT[type] || 3000;
  if (!port) appPort = inferPort(sub ? path.join(dir, 'code', sub) : path.join(dir, 'code'), appPort);
  // static/react always need our nginx.conf (SPA fallback; proxy added on link).
  // Never overwrite a repo's own conf - only fill the gap (react template has none).
  if (type === 'static' || type === 'react') {
    const ctxDir = sub ? path.join(dir, 'code', sub) : path.join(dir, 'code');
    try {
      if (!fs.existsSync(path.join(ctxDir, 'nginx.conf'))) fs.writeFileSync(path.join(ctxDir, 'nginx.conf'), nginxConf(null));
    } catch {}
  }

  // 2. .env auto-generated
  const host = hostPort || 8000;
  const dbs = normDbs(db);
  const safeName = name.replace(/[^a-z0-9]/gi, '').toLowerCase() || 'app';
  let dbBlock = '', volBlock = '', extraLines = [];
  if (dbs.length <= 1) {
    // legacy single-db path: byte-identical output to before
    const d = dbEnv(dbs[0] || 'none', safeName);
    extraLines = d.lines;
    dbBlock = d.compose ? d.compose + '\n' : '';
    volBlock = d.compose ? '\nvolumes:\n  dbdata:' : '';
  } else {
    // multi-db: one service + volume per database, prefixed vars,
    // plus DB_*/DATABASE_URL aliases to the first relational db for compat
    const blocks = dbs.map(t => dbService(t, name, `db-${t}`, `dbdata-${t}`));
    extraLines = blocks.flatMap(b => b.lines);
    const rel = blocks.find(b => b.info);
    if (rel) {
      extraLines.push(`DB_HOST=${rel.info.host}`, `DB_PORT=${rel.info.port}`, `DB_NAME=${rel.info.name}`, `DB_USER=${rel.info.user}`, `DB_PASSWORD=${rel.info.pass}`, `DATABASE_URL=${rel.url}`);
    }
    dbBlock = blocks.map(b => b.compose).join('\n') + '\n';
    volBlock = '\nvolumes:\n' + blocks.map(b => `  ${b.vol}:`).join('\n');
  }
  const envLines = [
    `APP_NAME=${name}`, `APP_TYPE=${type}`, `PORT=${appPort}`, `HOST_PORT=${host}`,
    `DOMAIN=${domain || ''}`, ...extraLines
  ];
  fs.writeFileSync(path.join(dir, '.env'), envLines.join('\n') + '\n');
  // track managed keys so the env editor knows what's safe to delete
  try {
    fs.writeFileSync(path.join(dir, '.env.managed'), envLines.map(l => l.split('=')[0]).join('\n') + '\n');
  } catch {}
  // seed app-specific keys from the repo's .env.example (never overwrite generated)
  try {
    const exDir = sub ? path.join(dir, 'code', sub) : path.join(dir, 'code');
    const have = new Set(envLines.map(l => l.split('=')[0]));
    const missing = seedEnvExample(exDir, have);
    if (missing.length) {
      fs.appendFileSync(path.join(dir, '.env'), '# --- from repo .env.example (defaults - review secrets/domains) ---\n' + missing.map(a => `${a.key}=${a.value}`).join('\n') + '\n');
    }
  } catch {}

  // 3. docker-compose.yml per app (ports: reachable via localhost + tunnel; expose: inter-container)
  // monorepo: build a subfolder, seeding the type template Dockerfile when the folder lacks one.
  // Only applies to cloned repos - template starters have no subfolders, ignore it there.
  if (sub) {
    const tpl = path.join(templatesDir, type);
    for (const f of ['Dockerfile', 'nginx.conf']) {
      const dst = path.join(dir, 'code', sub, f);
      try {
        if (!fs.existsSync(dst) && fs.existsSync(path.join(tpl, f))) {
          fs.mkdirSync(path.dirname(dst), { recursive: true });
          fs.copyFileSync(path.join(tpl, f), dst);
        }
      } catch {}
    }
  }
  const ctx = sub ? `./code/${sub}` : './code';
  const compose = `services:\n${serviceBlock({ svcName: 'app', ctx, port: appPort, host, portEnv: null })}${dbBlock}${volBlock}\n`;
  fs.writeFileSync(path.join(dir, 'docker-compose.yml'), compose);
  return { dir, appPort, hostPort: host, subdir: sub, type };
}

// One app-service block. Primary ('app') renders exactly the legacy shape;
// secondaries add a PORT override from their own PORT_<NAME> env key.
// Build arg for BuildKit inline cache (helps cache import/export on rebuild).
// Uses minipass base images for faster builds.
function serviceBlock({ svcName, ctx, port, host, portEnv, type }) {
  const build = ctx === './code'
    ? '    build: ./code\n'
    : `    build:\n      context: ./${ctx}\n      dockerfile: Dockerfile\n`;
  const buildArgs = '    build:\n      args:\n        BUILDKIT_INLINE_CACHE: 1\n';
  const env = portEnv ? `    environment:\n      PORT: \${${portEnv}}\n` : '';
  const ports = host ? `    ports:\n      - "${host}:${port}"\n` : '';
  return `  ${svcName}:\n${build}${buildArgs}    restart: unless-stopped\n    env_file: .env\n${env}${ports}    expose:\n      - "${port}"\n`;
}

// nginx for static/react frontends. With a proxy target it forwards same-origin
// /api/* to the backend preserving the /api prefix (Express convention:
// backends mount their router at /api, e.g. app.use('/api', routes)).
function nginxConf(proxy) {
  const api = proxy
    ? `  location /api/ {\n    proxy_pass http://${proxy.host}:${proxy.port};\n    proxy_set_header Host $host;\n    proxy_set_header X-Real-IP $remote_addr;\n  }\n`
    : '';
  return `# minipass-managed (rewritten on link/unlink/redeploy - keep custom confs unmarked)\nserver {\n  listen 80;\n  root /usr/share/nginx/html;\n  index index.html;\n${api}  location / {\n    try_files $uri $uri/ /index.html;\n  }\n}\n`;
}

module.exports = { createApp, appDir, TYPE_PORT, pw, normDbs, dbEnv, dbService, DB_IMAGES, inferPort, nginxConf, ensureDockerfile, needsDockerfileOptIn, serviceBlock };
