const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');
const { appGitEnv } = require('./ssh');

const DB_IMAGES = {
  postgres: 'postgres:16-alpine',
  mysql: 'mysql:8',
  mongo: 'mongo:7',
  redis: 'redis:7-alpine'
};

// Default in-container port per type
const TYPE_PORT = { node: 3000, react: 3000, php: 80, static: 80 };
const VALID_DBS = ['postgres', 'mysql', 'mongo', 'redis'];

function normDbs(db) {
  const arr = Array.isArray(db) ? db : String(db == null ? 'none' : db).split(/[+,]/);
  return [...new Set(arr.map(s => String(s).trim().toLowerCase()).filter(s => VALID_DBS.includes(s)))];
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

function createApp({ appsDir, templatesDir, name, type, repoUrl, db = 'none', port, domain, hostPort, gitToken }) {
  const dir = appDir(appsDir, name);
  // resume allowed when a previous create died before writing compose (keys preserved)
  const resume = fs.existsSync(dir) && !fs.existsSync(path.join(dir, 'docker-compose.yml'));
  if (fs.existsSync(dir) && !resume) throw new Error('app exists');
  fs.mkdirSync(dir, { recursive: true });

  // 1. code: clone or copy template starter
  if (repoUrl) {
    const isSsh = /^(git@|ssh:\/\/)/i.test(repoUrl);
    // token injected in-memory only (stored repo URLs stay clean)
    const { authUrl, authUrlWith } = require('./github');
    const cloneUrl = isSsh ? repoUrl : (gitToken ? authUrlWith(repoUrl, gitToken) : authUrl(repoUrl));
    const redact = s => String(s).replace(/x-access-token:[^@]+@/g, 'x-access-token:***@');
    try {
      execSync(`git clone --depth 1 ${cloneUrl} "${dir}/code"`, { stdio: 'pipe', env: isSsh ? appGitEnv(dir) : process.env });
    } catch (e) {
      // don't leave a half-created app behind (retry would hit "app exists");
      // keep per-app deploy keys so the key can still be shown + registered
      try {
        for (const f of fs.readdirSync(dir)) {
          if (f === 'deploy-key' || f === 'deploy-key.pub') continue;
          fs.rmSync(path.join(dir, f), { recursive: true, force: true });
        }
      } catch {}
      const detail = redact(String((e.stderr || e.message || '')).split('\n').filter(Boolean).slice(-4).join(' | '));
      throw new Error(`git clone failed (${isSsh ? 'SSH remote - is the app deploy key registered on that repo?' : 'HTTPS remote - private repo? connect GitHub or embed a token'}): ${detail}`);
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

  // 2. .env auto-generated
  const appPort = port || TYPE_PORT[type] || 3000;
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

  // 3. docker-compose.yml per app (ports: reachable via localhost + tunnel; expose: inter-container)
  const compose = `services:\n  app:\n    build: ./code\n    restart: unless-stopped\n    env_file: .env\n    ports:\n      - "${host}:${appPort}"\n    expose:\n      - "${appPort}"\n${dbBlock}${volBlock}\n`;
  fs.writeFileSync(path.join(dir, 'docker-compose.yml'), compose);
  return { dir, appPort, hostPort: host };
}

module.exports = { createApp, appDir, TYPE_PORT, pw, normDbs, dbService, DB_IMAGES };
