const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');
const { gitEnv } = require('./ssh');

const DB_IMAGES = {
  postgres: 'postgres:16-alpine',
  mysql: 'mysql:8',
  mongo: 'mongo:7',
  redis: 'redis:7-alpine'
};

// Default in-container port per type
const TYPE_PORT = { node: 3000, react: 3000, php: 80, static: 80 };

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

function createApp({ appsDir, templatesDir, name, type, repoUrl, db = 'none', port, domain, hostPort }) {
  const dir = appDir(appsDir, name);
  if (fs.existsSync(dir)) throw new Error('app exists');
  fs.mkdirSync(dir, { recursive: true });

  // 1. code: clone or copy template starter
  if (repoUrl) {
    execSync(`git clone --depth 1 ${repoUrl} "${dir}/code"`, { stdio: 'inherit', env: gitEnv() });
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
  const d = dbEnv(db, name.replace(/[^a-z0-9]/gi, '').toLowerCase() || 'app');
  const envLines = [
    `APP_NAME=${name}`, `APP_TYPE=${type}`, `PORT=${appPort}`, `HOST_PORT=${host}`,
    `DOMAIN=${domain || ''}`, ...d.lines
  ];
  fs.writeFileSync(path.join(dir, '.env'), envLines.join('\n') + '\n');

  // 3. docker-compose.yml per app (ports: reachable via localhost + tunnel; expose: inter-container)
  const dbBlock = d.compose ? d.compose + '\n' : '';
  const volBlock = d.compose ? '\nvolumes:\n  dbdata:' : '';
  const compose = `services:\n  app:\n    build: ./code\n    restart: unless-stopped\n    env_file: .env\n    ports:\n      - "${host}:${appPort}"\n    expose:\n      - "${appPort}"\n${dbBlock}${volBlock}\n`;
  fs.writeFileSync(path.join(dir, 'docker-compose.yml'), compose);
  return { dir, appPort, hostPort: host };
}

module.exports = { createApp, appDir, TYPE_PORT, pw };
