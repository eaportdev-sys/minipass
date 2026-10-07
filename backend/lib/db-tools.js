const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile, execFileSync } = require('child_process');
const { normDbs } = require('./generator');

const TOOLS = {
  postgres: { label: 'pgAdmin', image: 'dpage/pgadmin4:9.18.0', port: 80 },
  mysql: { label: 'phpMyAdmin', image: 'phpmyadmin:5.2.3-apache', port: 80 },
  mariadb: { label: 'phpMyAdmin', image: 'phpmyadmin:5.2.3-apache', port: 80 },
  mongo: { label: 'mongo-express', image: 'mongo-express:1.0.2-20-alpine3.19', port: 8081 },
  redis: { label: 'Redis Commander', image: 'rediscommander/redis-commander:latest', port: 8081 }
};
const DOCKER_BIN = process.env.DOCKER_BIN || 'docker';
const DOCKER_ARG = process.env.DOCKER_ARG ? [process.env.DOCKER_ARG] : [];

function docker(args, opts = {}) {
  return execFileSync(DOCKER_BIN, [...DOCKER_ARG, ...args], opts);
}

function dockerAsync(args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(DOCKER_BIN, [...DOCKER_ARG, ...args], opts, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
      } else resolve(stdout);
    });
  });
}

function dockerOutput(args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(DOCKER_BIN, [...DOCKER_ARG, ...args], opts, (error, stdout, stderr) => {
      if (error) reject(error);
      else resolve(String(stdout || '') + String(stderr || ''));
    });
  });
}

function readEnv(dir) {
  const out = {};
  try {
    for (const line of fs.readFileSync(path.join(dir, '.env'), 'utf8').split(/\r?\n/)) {
      const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
      if (m) out[m[1]] = m[2].trim();
    }
  } catch {}
  return out;
}

function parsedUrl(raw) {
  try {
    const u = new URL(raw);
    return {
      host: u.hostname,
      port: u.port ? parseInt(u.port, 10) : null,
      user: decodeURIComponent(u.username),
      pass: decodeURIComponent(u.password),
      db: decodeURIComponent(u.pathname.replace(/^\//, ''))
    };
  } catch { return {}; }
}

function databaseConfig(meta, dir, type) {
  const types = normDbs(meta && meta.db);
  if (!types.includes(type) || !TOOLS[type]) throw new Error(`${type} is not attached to this site`);
  const env = readEnv(dir);
  const fallback = types.length > 1 ? `db-${type}` : 'db';
  if (type === 'postgres') {
    const prefixed = !!env.POSTGRES_USER;
    const host = env.POSTGRES_HOST || (!prefixed && env.DB_HOST) || fallback;
    return { service: host, host, port: parseInt(env.POSTGRES_PORT || (!prefixed && env.DB_PORT), 10) || 5432,
      user: env.POSTGRES_USER || env.DB_USER, pass: prefixed ? env.POSTGRES_PASSWORD : (env.DB_PASSWORD || env.POSTGRES_PASSWORD), db: env.POSTGRES_DB || env.DB_NAME };
  }
  if (type === 'mysql') {
    const prefixed = !!env.MYSQL_USER;
    const host = env.MYSQL_HOST || (!prefixed && env.DB_HOST) || fallback;
    return { service: host, host, port: parseInt(env.MYSQL_PORT || (!prefixed && env.DB_PORT), 10) || 3306,
      user: env.MYSQL_USER || env.DB_USER, pass: env.MYSQL_PASSWORD || env.DB_PASSWORD, db: env.MYSQL_DB || env.DB_NAME };
  }
  if (type === 'mariadb') {
    const prefixed = !!env.MARIADB_USER;
    const host = env.MARIADB_HOST || (!prefixed && env.DB_HOST) || fallback;
    return { service: host, host, port: parseInt(env.MARIADB_PORT || (!prefixed && env.DB_PORT), 10) || 3306,
      user: env.MARIADB_USER || env.DB_USER, pass: env.MARIADB_PASSWORD || env.DB_PASSWORD, db: env.MARIADB_DB || env.DB_NAME };
  }
  if (type === 'mongo') {
    const u = parsedUrl(env.MONGO_URL);
    const host = env.MONGO_HOST || u.host || fallback;
    return { service: host, host, port: parseInt(env.MONGO_PORT, 10) || u.port || 27017, user: env.MONGO_USER || u.user, pass: env.MONGO_PASSWORD || u.pass, db: env.MONGO_DB || u.db };
  }
  const u = parsedUrl(env.REDIS_URL);
  const host = env.REDIS_HOST || u.host || fallback;
  return { service: host, host, port: parseInt(env.REDIS_PORT, 10) || u.port || 6379, pass: env.REDIS_PASSWORD || u.pass, db: '0' };
}

function safeName(id, type) {
  return `minipass-${String(id).replace(/[^a-z0-9_-]/gi, '-')}-dbui-${type}`.toLowerCase();
}

function containerState(name) {
  try { return docker(['inspect', '--format', '{{.State.Status}}', name], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { return 'stopped'; }
}

function delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function startupError(name, tool, secrets, fallback) {
  let detail = '';
  try { detail = String(await dockerOutput(['logs', '--tail', '20', name], { encoding: 'utf8', timeout: 10000, maxBuffer: 256 * 1024 })).trim(); } catch {}
  detail = detail.split(/\r?\n/).slice(-8).join(' ');
  for (const secret of secrets.filter(Boolean)) detail = detail.split(secret).join('***');
  return new Error(detail || fallback || `${tool.label} failed to start`);
}

async function waitForReady(name, type, tool, secrets) {
  let runningChecks = 0;
  const attempts = type === 'postgres' ? 60 : 15;
  for (let i = 0; i < attempts; i++) {
    await delay(1000);
    let state = '';
    try { state = String(await dockerAsync(['inspect', '--format', '{{.State.Status}}', name], { encoding: 'utf8', timeout: 5000 })).trim(); }
    catch { throw await startupError(name, tool, secrets, `${tool.label} container disappeared during startup`); }
    if (state !== 'running') {
      if (['exited', 'dead', 'restarting'].includes(state)) throw await startupError(name, tool, secrets, `${tool.label} container is ${state}`);
      runningChecks = 0;
      continue;
    }
    if (type === 'postgres') {
      try {
        await dockerAsync(['exec', name, '/venv/bin/python3', '-c', "import urllib.request; urllib.request.urlopen('http://127.0.0.1:80/misc/ping', timeout=2).read()"],
          { encoding: 'utf8', timeout: 5000, maxBuffer: 64 * 1024 });
        return;
      } catch { continue; }
    }
    if (++runningChecks >= 2) return;
  }
  throw await startupError(name, tool, secrets, `${tool.label} did not become ready in time`);
}

function describe(meta, dir, containers) {
  const types = normDbs(meta && meta.db);
  return types.map(type => {
    let service = types.length > 1 ? `db-${type}` : 'db';
    try { service = databaseConfig(meta, dir, type).service; } catch {}
    const c = (containers || []).find(x => x.service === service);
    const saved = meta.dbTools && meta.dbTools[type];
    const name = safeName(meta.id, type);
    return {
      type, service, label: ({ postgres: 'PostgreSQL', mysql: 'MySQL', mariadb: 'MariaDB', mongo: 'MongoDB', redis: 'Redis' })[type],
      state: c ? c.state : 'not running', status: c ? c.status : '', image: c ? c.image : null,
      tool: TOOLS[type].label, toolPort: saved && saved.port, toolState: containerState(name),
      toolExpiresAt: saved && saved.expiresAt
    };
  });
}

function ensurePgAdminFiles(dir, config) {
  const base = path.join(dir, '.db-tools', 'postgres');
  const data = path.join(base, 'data');
  fs.mkdirSync(data, { recursive: true });
  try { fs.chownSync(data, 5050, 5050); } catch {}
  const servers = path.join(base, 'servers.json');
  const pgpass = path.join(base, 'pgpass');
  // The previous launch leaves these read-only for the pgAdmin container.
  // Make them writable briefly so refreshed managed credentials can replace them.
  try { fs.chmodSync(servers, 0o600); } catch {}
  try { fs.chmodSync(pgpass, 0o600); } catch {}
  fs.writeFileSync(servers, JSON.stringify({ Servers: { 1: {
    Name: 'MiniPaaS PostgreSQL', Group: 'MiniPaaS', Host: config.host, Port: config.port,
    MaintenanceDB: config.db, Username: config.user, SSLMode: 'prefer', PassFile: '/config/pgpass'
  } } }, null, 2));
  fs.writeFileSync(pgpass, `${config.host}:${config.port}:*:${config.user}:${config.pass}\n`);
  try { fs.chownSync(pgpass, 5050, 5050); fs.chmodSync(pgpass, 0o400); } catch {}
  try { fs.chmodSync(servers, 0o444); } catch {}
  const secretFile = path.join(base, 'tool-secret');
  let secret = '';
  try { secret = fs.readFileSync(secretFile, 'utf8').trim(); } catch {}
  if (!secret) {
    secret = crypto.randomBytes(18).toString('base64url');
    fs.writeFileSync(secretFile, secret, { mode: 0o600 });
  }
  return { base, data, servers, pgpass, secret };
}

async function launch(id, meta, dir, type, hostPort) {
  const tool = TOOLS[type];
  if (!tool) throw new Error('unsupported database tool');
  const config = databaseConfig(meta, dir, type);
  if (!config.host || !config.port || (type !== 'redis' && (!config.user || !config.db)) || !config.pass) {
    throw new Error(`${type} connection details are incomplete in the managed environment`);
  }
  const name = safeName(id, type);
  const secrets = [config.pass];
  try { docker(['rm', '-f', name], { stdio: 'ignore' }); } catch {}
  // --pull missing makes the guarantee explicit: a launch never re-downloads,
  // it only fetches when the image is genuinely absent (warmer missed it).
  const args = ['run', '--pull', 'missing', '-d', '--name', name, '--restart', 'unless-stopped', '--network', `${id}_default`, '-p', `${hostPort}:${tool.port}`];
  if (type === 'postgres') {
    const f = ensurePgAdminFiles(dir, config);
    secrets.push(f.secret);
    args.push('-e', 'PGADMIN_DEFAULT_EMAIL=admin@minipass.dev', '-e', `PGADMIN_DEFAULT_PASSWORD=${f.secret}`,
      '-e', 'PGADMIN_LISTEN_ADDRESS=0.0.0.0',
      '-e', 'PGADMIN_CONFIG_SERVER_MODE=False', '-e', 'PGADMIN_CONFIG_MASTER_PASSWORD_REQUIRED=False',
      '-e', 'PGADMIN_REPLACE_SERVERS_ON_STARTUP=True', '-e', 'PGPASS_FILE=/config/pgpass',
      '-v', `${f.servers}:/pgadmin4/servers.json:ro`, '-v', `${f.pgpass}:/config/pgpass:ro`, '-v', `${f.data}:/var/lib/pgadmin`);
  } else if (type === 'mysql' || type === 'mariadb') {
    args.push('-e', `PMA_HOST=${config.host}`, '-e', `PMA_PORT=${config.port}`, '-e', `PMA_USER=${config.user}`, '-e', `PMA_PASSWORD=${config.pass}`, '-e', `PMA_VERBOSE=${id} ${type === 'mariadb' ? 'MariaDB' : 'MySQL'}`);
  } else if (type === 'mongo') {
    const auth = `${encodeURIComponent(config.user)}:${encodeURIComponent(config.pass)}`;
    args.push('-e', `ME_CONFIG_MONGODB_URL=mongodb://${auth}@${config.host}:${config.port}/${encodeURIComponent(config.db || '')}?authSource=admin`, '-e', 'ME_CONFIG_BASICAUTH_ENABLED=false');
  } else {
    args.push('-e', `REDIS_HOST=${config.host}`, '-e', `REDIS_PORT=${config.port}`, '-e', `REDIS_PASSWORD=${config.pass}`, '-e', `REDIS_DB=${config.db}`, '-e', `REDIS_LABEL=${id} Redis`);
  }
  args.push(tool.image);
  try { await dockerAsync(args, { encoding: 'utf8', timeout: 300000, maxBuffer: 1024 * 1024 }); }
  catch (e) {
    let msg = String(e.stderr || e.message).trim().split(/\r?\n/).slice(-3).join(' ');
    for (const secret of secrets.filter(Boolean)) msg = msg.split(secret).join('***');
    throw new Error(msg || `${tool.label} failed to start`);
  }
  await waitForReady(name, type, tool, secrets);
  return { type, tool: tool.label, port: hostPort, state: 'running' };
}

function stop(id, type) {
  if (!TOOLS[type]) throw new Error('unsupported database tool');
  try { docker(['rm', '-f', safeName(id, type)], { stdio: 'ignore', timeout: 30000 }); } catch {}
}

function stopAll(id) {
  for (const type of Object.keys(TOOLS)) stop(id, type);
}

// Admin UI images live on the server so the first launch does not wait on a
// large download. Pulls are best-effort and sequential; launch() works
// without them (docker fetches a missing image on demand).
const IMAGES = [...new Set(Object.values(TOOLS).map(t => t.image))];

function imagePresent(image) {
  try { docker(['image', 'inspect', image], { stdio: 'ignore' }); return true; }
  catch { return false; }
}

async function pullImages(images = IMAGES) {
  const results = [];
  for (const image of [...new Set(images)]) {
    try {
      await dockerAsync(['pull', image], { encoding: 'utf8', timeout: 600000, maxBuffer: 1024 * 1024 });
      results.push({ image, ok: true });
    } catch (e) {
      results.push({ image, ok: false, error: String((e && e.stderr) || (e && e.message) || e).trim().split(/\r?\n/).slice(-2).join(' ').slice(-300) });
    }
  }
  return results;
}

module.exports = { TOOLS, IMAGES, describe, launch, stop, stopAll, databaseConfig, safeName, imagePresent, pullImages };
