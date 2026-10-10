const express = require('express');
const cors = require('cors');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { exec, execSync, execFileSync, spawn } = require('child_process');
const http = require('http');
const { WebSocketServer } = require('ws');
const { createApp, appDir, normDbs, dbService, nginxConf, ensureDockerfile, needsDockerfileOptIn } = require('./lib/generator');
const { gitEnv, pubKey, appPubKey, appGitEnv } = require('./lib/ssh');
const svc = require('./lib/services');
const dbTools = require('./lib/db-tools');
const migrations = require('./lib/migrations');
const routes = require('./lib/routes');
const envDefaults = require('./lib/env-defaults');
const tokens = require('./lib/tokens');
const portsLib = require('./lib/ports');
const storage = require('./lib/storage');
const hostStorage = require('./lib/host-storage');
const trashLib = require('./lib/trash');
const quotas = require('./lib/quotas');
const panelLog = require('./lib/panel-log');
const prebuild = require('./lib/prebuild');
const { runLogged, failureSummary } = require('./lib/build-log');
const remediate = require('./lib/remediate');
const importProtection = require('./lib/import-protection');
const dockerfileProtection = require('./lib/dockerfile-protection');
const siteIdentity = require('./lib/site-identity');
const { refreshStandardDockerfile, standardDockerfileType } = require('./lib/dockerfiles');
const { buildProfile, readBuildProfile, localBuildProfile, isJekyll } = require('./lib/build-profile');

const PORT = process.env.PORT || 3001;
const APPS_DIR = path.resolve(__dirname, process.env.APPS_DIR || '../apps');
const TRASH_HOLD_MS = 48 * 3600 * 1000;
const TRASH_DIR = path.join(APPS_DIR, '.trash');
function pickDir(cands) { for (const c of cands) { try { if (fs.existsSync(c)) return c; } catch {} } return cands[0]; }
const TEMPLATES_DIR = pickDir([path.resolve(__dirname, '../templates'), path.join(__dirname, 'templates'), path.join(process.cwd(), 'templates')]);
const FRONTEND_DIR = pickDir([path.resolve(__dirname, '../frontend'), path.join(__dirname, 'frontend'), path.join(process.cwd(), 'frontend')]);
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data.json');
fs.mkdirSync(APPS_DIR, { recursive: true });
try { fs.mkdirSync(TRASH_DIR, { recursive: true }); } catch {}
fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });

const app = express();
const lifecycleLocks = new Set();
const creatingSites = new Set();
let trashBusy = false;
app.use(cors());
// GitHub push webhook FIRST with a raw body: HMAC verification needs exact bytes,
// and the global json parser would already have consumed them.
const gh = require('./lib/github');
app.post('/webhook/:id', express.raw({ type: '*/*' }), async (req, res) => {
  const meta = load().apps.find(a => a.id === req.params.id);
  if (!meta || req.query.token !== meta.token) return res.status(401).send('bad token');
  if (!meta.github || meta.github.enabled !== true) return res.status(409).send('github automation disabled');
  const sig = req.headers['x-hub-signature-256'];
  if (sig && meta.github) {
    const expect = 'sha256=' + crypto.createHmac('sha256', meta.token).update(req.body).digest('hex');
    const ok = sig.length === expect.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect));
    if (!ok) return res.status(401).send('bad signature');
  }
  try { await deploy(req.params.id, { source: 'webhook' }); } catch (e) { return res.status(500).send(e.message); }
  // keep the poller from redeploying what the webhook just deployed
  try {
    const p = JSON.parse(req.body.toString());
    if (p && /^[0-9a-f]{40}$/.test(p.after || '')) {
      const db2 = load();
      const m2 = db2.apps.find(a => a.id === req.params.id);
      if (m2) { m2.github = { ...(m2.github || {}), sha: p.after }; save(db2); }
    }
  } catch {}
  res.send('deployed');
});
app.use(express.json());
// ---- Panel admin gate. Without this, anyone reaching :3001 owns the box
// (docker.sock + web terminal). Static UI stays public (no secrets in it);
// every /api/* route below (except the login/setup/terms-text/status ones)
// and the /terminal socket require a session cookie. GitHub push webhooks
// stay open above - they carry their own per-app token.
const AUTH_FILE = path.join(path.dirname(DATA_FILE), 'panel-auth.json');
const SESSION_DAYS = 30;
const TERMS_TEXT = [
  'MINIPASS OPERATOR TERMS (v0.1, localhost testing build)',
  '',
  '1. You operate this panel. Every site it builds, runs, or exposes is yours.',
  '2. Deployed apps run arbitrary code from connected repos. You are responsible',
  '   for the content, behavior, and legal compliance of everything you deploy.',
  '3. Database engines run under their own upstream licenses (e.g. MySQL/MariaDB GPL-2.0,',
  '   MongoDB SSPL). Commercial use is your call to clear, not ours.',
  '4. Backups are your responsibility until automated backups exist. Download them',
  '   from the site Files tab and store them somewhere that is not this box.',
  '5. This is a testing build with no warranty of any kind (see LICENSE).',
  '6. Do not expose the panel to the public internet until an auth + TLS review',
  '   says otherwise. Localhost / trusted-LAN use only for now.'
].join('\n');
function loadAuth() {
  try {
    const a = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8'));
    if (a && typeof a === 'object') return { hash: a.hash || null, salt: a.salt || null,
      sessions: Array.isArray(a.sessions) ? a.sessions : [], termsAcceptedAt: a.termsAcceptedAt || null };
  } catch {}
  return { hash: null, salt: null, sessions: [], termsAcceptedAt: null };
}
function saveAuth(a) {
  try { fs.mkdirSync(path.dirname(AUTH_FILE), { recursive: true }); } catch {}
  fs.writeFileSync(AUTH_FILE, JSON.stringify(a, null, 2), { mode: 0o600 });
}
function scryptHex(pw, salt) { return crypto.scryptSync(String(pw), String(salt), 64).toString('hex'); }
function timingEqualHex(a, b) {
  try {
    const x = Buffer.from(String(a), 'hex'), y = Buffer.from(String(b), 'hex');
    return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
  } catch { return false; }
}
function pruneSessions(a) {
  const cut = Date.now() - SESSION_DAYS * 864e5;
  a.sessions = (a.sessions || []).filter(s => s && s.createdAt > cut);
  return a;
}
function panelToken(req) {
  const h = req.headers || {};
  const auth = String(h.authorization || '');
  if (/^bearer\s+/i.test(auth)) return auth.replace(/^bearer\s+/i, '').trim();
  if (h['x-panel-token']) return String(h['x-panel-token']).trim();
  const m = String(h.cookie || '').match(/(?:^|;\s*)mp_session=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : '';
}
function panelAuthed(req) {
  const t = panelToken(req);
  if (!t) return false;
  return loadAuth().sessions.some(s => s && s.token === t && Date.now() - s.createdAt < SESSION_DAYS * 864e5);
}
function newSession(a) {
  pruneSessions(a);
  const token = crypto.randomBytes(32).toString('hex');
  a.sessions.push({ token, createdAt: Date.now() });
  a.sessions = a.sessions.slice(-20);
  saveAuth(a);
  return token;
}
function setSessionCookie(res, token) {
  res.set('Set-Cookie', `mp_session=${encodeURIComponent(token)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}`);
}
const PUBLIC_API = new Set(['/api/panel/auth-status', '/api/panel/setup', '/api/panel/login', '/api/panel/terms-text']);
app.use((req, res, next) => {
  if (!req.path.startsWith('/api/')) return next();
  if (PUBLIC_API.has(req.path)) return next();
  if (panelAuthed(req)) return next();
  return res.status(401).json({ error: 'panel login required' });
});
app.use('/api/apps/:id', async (req, res, next) => {
  if (!['GET', 'HEAD'].includes(req.method) && lifecycleLocks.has(req.params.id)) return res.status(409).json({ error: 'site lifecycle operation in progress - retry when it finishes' });
  if (!['GET', 'HEAD', 'DELETE'].includes(req.method)) {
    try { await quotas.ensure(load().apps.find(a => a.id === req.params.id) || {}); }
    catch (e) { return res.status(e.status || 503).json({ error: e.message }); }
  }
  next();
});
app.get('/api/panel/auth-status', (req, res) => {
  const a = loadAuth();
  res.json({ setupRequired: !a.hash, authenticated: panelAuthed(req), termsAccepted: !!a.termsAcceptedAt });
});
app.get('/api/panel/terms-text', (req, res) => res.type('text/plain').send(TERMS_TEXT));
app.post('/api/panel/setup', (req, res) => {
  const a = loadAuth();
  if (a.hash) return res.status(409).json({ error: 'admin password already set - use login' });
  const pw = String((req.body && req.body.password) || '');
  if (pw.length < 12) return res.status(400).json({ error: 'use at least 12 characters' });
  if (!(req.body && req.body.acceptTerms)) return res.status(400).json({ error: 'operator terms must be accepted' });
  a.salt = crypto.randomBytes(16).toString('hex');
  a.hash = scryptHex(pw, a.salt);
  a.termsAcceptedAt = new Date().toISOString();
  setSessionCookie(res, newSession(a));
  res.json({ ok: true });
});
app.post('/api/panel/login', (req, res) => {
  const a = loadAuth();
  if (!a.hash) return res.status(409).json({ error: 'no admin password yet - finish setup first' });
  const pw = String((req.body && req.body.password) || '');
  if (!pw || !timingEqualHex(scryptHex(pw, a.salt), a.hash)) return res.status(401).json({ error: 'wrong password' });
  const token = newSession(a);
  setSessionCookie(res, token);
  res.json({ ok: true, termsAccepted: !!a.termsAcceptedAt });
});
app.post('/api/panel/logout', (req, res) => {
  const t = panelToken(req);
  const a = loadAuth();
  a.sessions = (a.sessions || []).filter(s => !s || s.token !== t);
  saveAuth(a);
  res.set('Set-Cookie', 'mp_session=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0');
  res.json({ ok: true });
});
app.post('/api/panel/password', (req, res) => {
  const a = loadAuth();
  if (!a.hash) return res.status(409).json({ error: 'no admin password yet - finish setup first' });
  if (!timingEqualHex(scryptHex(String((req.body && req.body.current) || ''), a.salt), a.hash))
    return res.status(401).json({ error: 'current password is wrong' });
  const next = String((req.body && req.body.next) || '');
  if (next.length < 12) return res.status(400).json({ error: 'use at least 12 characters' });
  a.salt = crypto.randomBytes(16).toString('hex');
  a.hash = scryptHex(next, a.salt);
  saveAuth(a);
  res.json({ ok: true });
});
app.post('/api/panel/terms', (req, res) => {
  if (!(req.body && req.body.accepted)) return res.status(400).json({ error: 'terms not accepted' });
  const a = loadAuth();
  a.termsAcceptedAt = new Date().toISOString();
  saveAuth(a);
  res.json({ ok: true });
});
// ---- Database admin images: pre-downloaded on the server so the first UI
// launch does not wait on a large pull. The manual pull doubles as the
// upgrade path (re-fetches every pinned admin image).
app.get('/api/panel/db-tools/images', (req, res) => {
  try {
    res.json({ images: Object.entries(dbTools.TOOLS).map(([type, tool]) => ({ type, tool: tool.label, image: tool.image, present: dbTools.imagePresent(tool.image) })) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
let dbToolsPulling = false;
app.post('/api/panel/db-tools/pull', async (req, res) => {
  if (dbToolsPulling) return res.status(409).json({ error: 'image download already in progress' });
  dbToolsPulling = true;
  try {
    const results = await dbTools.pullImages();
    res.json({ ok: results.every(r => r.ok), results });
  } catch (e) { res.status(500).json({ error: e.message }); }
  finally { dbToolsPulling = false; }
});
// ---- Backups: site tarball + per-database dumps. Downloads only - restore is
// manual (extract the tarball, rescan). Passwords travel as argv, never shell.
app.get('/api/apps/:id/backup', async (req, res) => {
  const meta = load().apps.find(a => a.id === req.params.id);
  if (!meta) return res.status(404).json({ error: 'unknown app' });
  const stamp = backupStamp();
  const tmp = path.join(os.tmpdir(), `${meta.id}-backup-${stamp}.tar.gz`);
  try {
    await runOut('tar', ['-czf', tmp, '--exclude=node_modules', '-C', appDir(APPS_DIR, meta.id), '.']);
  } catch (e) { return res.status(500).json({ error: 'site backup failed: ' + e.message }); }
  res.download(tmp, `${meta.id}-backup-${stamp}.tar.gz`, () => { try { fs.unlinkSync(tmp); } catch {} });
});
app.get('/api/apps/:id/databases/:type/dump', async (req, res) => {
  const meta = load().apps.find(a => a.id === req.params.id);
  if (!meta) return res.status(404).json({ error: 'unknown app' });
  const type = req.params.type;
  let cfg;
  try { cfg = dbTools.databaseConfig(meta, appDir(APPS_DIR, meta.id), type); }
  catch (e) { return res.status(400).json({ error: e.message }); }
  if (!cfg.host || !cfg.pass || (type !== 'redis' && (!cfg.user || !cfg.db)))
    return res.status(400).json({ error: 'incomplete managed credentials for ' + type });
  const redact = s => String(s).split(cfg.pass).join('***');
  const dir = appDir(APPS_DIR, meta.id);
  const svc = cfg.service;
  const stamp = backupStamp();
  const ext = type === 'redis' ? 'rdb' : type === 'mongo' ? 'archive' : 'sql';
  const tmp = path.join(os.tmpdir(), `${meta.id}-${type}-${stamp}.${ext}`);
  try {
    const ca = composeArgv();
    const cexec = (args) => runOut(ca[0], [...ca.slice(1), 'exec', '-T', ...args], { cwd: dir });
    const cexecTo = (args) => runToFile(ca[0], [...ca.slice(1), 'exec', '-T', ...args], tmp, { cwd: dir });
    if (type === 'postgres') {
      await cexecTo(['-e', `PGPASSWORD=${cfg.pass}`, svc, 'pg_dump', '-U', cfg.user, '-h', 'localhost', cfg.db]);
    } else if (type === 'mysql' || type === 'mariadb') {
      await cexecTo([svc, type === 'mariadb' ? 'mariadb-dump' : 'mysqldump', '-u', cfg.user, `-p${cfg.pass}`, cfg.db]);
    } else if (type === 'mongo') {
      const uri = `mongodb://${encodeURIComponent(cfg.user)}:${encodeURIComponent(cfg.pass)}@localhost:${cfg.port || 27017}/${encodeURIComponent(cfg.db || '')}?authSource=admin`;
      await cexecTo([svc, 'mongodump', `--uri=${uri}`, '--archive']);
    } else if (type === 'redis') {
      const cid = execSync(`${COMPOSE_BIN} ps -q ${svc}`, { cwd: dir }).toString().trim().split('\n')[0] || '';
      if (!/^[a-f0-9]{12,64}$/i.test(cid)) throw new Error('database container not running');
      const lastsave = async () => {
        const o = await cexec([svc, 'redis-cli', '-a', cfg.pass, 'LASTSAVE']);
        return parseInt(String(o).trim(), 10) || 0;
      };
      const before = await lastsave().catch(() => 0);
      await cexec([svc, 'redis-cli', '-a', cfg.pass, 'BGSAVE']);
      let fresh = false;
      for (let i = 0; i < 15; i++) {
        await new Promise(r => setTimeout(r, 1000));
        try { if (await lastsave() > before) { fresh = true; break; } } catch {}
      }
      if (!fresh) throw new Error('redis snapshot did not finish in time');
      await runOut(DOCKER_BIN, ['cp', `${cid}:/data/dump.rdb`, tmp]);
    } else return res.status(400).json({ error: 'unsupported database' });
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch {}
    return res.status(500).json({ error: ('database dump failed: ' + redact(e.message)).slice(0, 300) });
  }
  res.download(tmp, path.basename(tmp), () => { try { fs.unlinkSync(tmp); } catch {} });
});
// serve wizard UI (works locally and in docker). No-store so upgrades show instantly.
app.use((req, res, next) => {
  if (!req.path.startsWith('/api') && !req.path.startsWith('/webhook') && !req.path.startsWith('/terminal')) res.set('Cache-Control', 'no-store');
  next();
});
app.use(express.static(FRONTEND_DIR, { maxAge: 0, etag: false }));
app.get('/health', (req, res) => res.send('ok'));

function load() {
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
  catch { return { apps: [] }; }
}
function save(d) { fs.writeFileSync(DATA_FILE, JSON.stringify(d, null, 2)); }
// Strip secrets for every API response - tokens stay server-side only.
function pubApp(a) {
  const g = a.github || null;
  const pub = g ? { repo: g.repo, branch: g.branch, login: g.login, sha: g.sha, pollMinutes: g.pollMinutes, enabled: g.enabled === true, hasToken: !!g.token } : g;
  // SPA/static servers commonly return index.html for every path. Old landing
  // detection therefore mistook /health/live for their homepage. Preserve an
  // operator-set path, otherwise frontend roots always open at /.
  const homePath = ['static', 'react'].includes(a.type) && !a.homePathManual ? '' : (a.homePath || '');
  return { ...a, name: a.name || a.id, homePath, github: pub };
}
function publicServices(meta, dir) {
  return svc.fullServices(meta, dir).map(s => {
    const frontendRoot = ['static', 'react'].includes(s.type) && !(s.name === 'app' && meta.homePathManual);
    const homePath = s.name === 'app'
      ? (frontendRoot ? '' : (meta.homePath || ''))
      : (frontendRoot ? '' : (s.homePath || ''));
    return { ...s, homePath };
  });
}
// Portable compose: prefer `docker compose` (v2), fallback to `docker-compose` (v1).
// Override with COMPOSE_BIN env, e.g. COMPOSE_BIN="docker-compose".
let COMPOSE_BIN = process.env.COMPOSE_BIN || 'docker compose';
try { execSync('docker compose version', { stdio: 'ignore' }); }
catch { try { execSync('docker-compose --version', { stdio: 'ignore' }); COMPOSE_BIN = 'docker-compose'; } catch {} }
function sh(cmd, cwd, env) {
  return new Promise((res, rej) => {
    exec(cmd, { cwd, env: env || process.env, maxBuffer: 10 * 1024 * 1024 }, (e, stdout, stderr) => {
      if (e) rej(new Error(stderr || e.message)); else res(stdout);
    });
  });
}
// argv-based runner (no shell) so generated passwords never touch a shell line.
// captureStderr merges stderr into the resolved output (migrations print there).
// stderr is always kept for failure messages, so `cd` into a wrong folder
// reports the shell's reason instead of a bare exit code.
function runOut(bin, args, opts = {}) {
  return new Promise((res, rej) => {
    const { onSpawn, captureStderr, ...spawnOpts } = opts;
    const p = spawn(bin, args, spawnOpts);
    if (onSpawn) onSpawn(p);
    const chunks = [];
    const errChunks = [];
    let settled = false;
    // Process errors usually put the actionable cause first and a long stack
    // afterward. Preserve both ends so migration failures do not degrade into
    // only `at Client.acquireRawConnection` frames.
    const errDetail = () => {
      const raw = Buffer.concat(errChunks).toString().trim();
      if (raw.length <= 1800) return raw;
      return raw.slice(0, 900) + '\n…\n' + raw.slice(-700);
    };
    p.stdout.on('data', d => chunks.push(d));
    p.stderr.on('data', d => {
      if (captureStderr) chunks.push(d);
      errChunks.push(d);
      if (errChunks.length > 32) errChunks.shift();
    });
    p.on('error', e => { if (!settled) { settled = true; rej(e); } });
    p.on('close', code => {
      if (settled) return;
      settled = true;
      if (code === 0) res(Buffer.concat(chunks));
      else {
        const detail = errDetail();
        rej(new Error(`${bin} exited with code ${code}${detail ? `: ${detail}` : ''}`));
      }
    });
  });
}
// Stream stdout straight to a file (dumps can be larger than memory).
function runToFile(bin, args, file, opts = {}) {
  return new Promise((res, rej) => {
    const out = fs.createWriteStream(file);
    out.on('error', rej);
    const p = spawn(bin, args, opts);
    const errChunks = [];
    const errTail = () => Buffer.concat(errChunks).toString().slice(-500);
    p.stdout.on('data', d => {
      if (!out.write(d)) { p.stdout.pause(); out.once('drain', () => { try { p.stdout.resume(); } catch {} }); }
    });
    p.stderr.on('data', d => { errChunks.push(d); if (errChunks.length > 32) errChunks.shift(); });
    p.on('error', e => { out.destroy(); rej(e); });
    p.on('close', code => {
      out.end(() => {
        if (code === 0) res();
        else rej(new Error(`${bin} exited with code ${code}${errTail() ? `: ${errTail()}` : ''}`));
      });
    });
  });
}
// ['docker','compose',...] or ['docker-compose',...] without ever shell-splitting secrets.
function composeArgv() { return String(COMPOSE_BIN).trim().split(/\s+/); }
const DOCKER_BIN = process.env.DOCKER_BIN || 'docker';
function backupStamp() { return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19); }
app.get('/api/panel/pubkey', (req, res) => {
  const k = pubKey();
  if (!k) return res.status(500).json({ error: 'no panel key (ssh-keygen unavailable?)' });
  res.json({ pubkey: k });
});
app.get('/api/apps/:id/repokey', (req, res) => {
  const k = appPubKey(appDir(APPS_DIR, req.params.id));
  if (!k) return res.status(500).json({ error: 'no repo key (ssh-keygen unavailable?)' });
  res.json({ pubkey: k });
});

// Offline auto-deploy (the localhost answer): GitHub can't push webhooks to an
// unreachable panel, so the panel polls instead - outbound HTTPS only, no tunnel
// or inbound ports. Per-app interval; converges via stored head sha.
const pollState = new Map();
setInterval(pollGithub, 60 * 1000);
async function pollGithub() {
  let db_;
  try { db_ = load(); } catch { return; }
  const now = Date.now();
  for (const meta of db_.apps) {
    const g = meta.github;
    if (!g || !g.repo || g.enabled !== true || !(g.pollMinutes > 0)) continue;
    if (now - (pollState.get(meta.id) || 0) < g.pollMinutes * 60 * 1000) continue;
    pollState.set(meta.id, now);
    try {
      const parts = String(g.repo).split('/');
      const commitsPath = `/repos/${parts[0]}/${parts[1]}/commits/${encodeURIComponent(g.branch || 'main')}`;
      let c;
      try {
        c = await gh.apiFor(meta, commitsPath);
      } catch (e) {
        // token-free public link: poll without credentials (shared 60/hr quota)
        if (gh.tokenFor(meta)) throw e;
        c = await gh.apiPublic(commitsPath);
      }
      const sha = c && c.sha;
      if (!sha || sha === g.sha) continue;
      await deploy(meta.id, { source: 'poll' });
      const fresh = load();
      const m2 = fresh.apps.find(a => a.id === meta.id);
      if (m2 && m2.github) { m2.github.sha = sha; save(fresh); }
      console.log(`poll-deploy ${meta.id} -> ${String(sha).slice(0, 7)}`);
    } catch (e) { console.error(`poll ${meta.id}: ${e.message}`); }
  }
}
app.post('/api/apps/:id/poll', (req, res) => {
  try {
    const db_ = load();
    const meta = db_.apps.find(a => a.id === req.params.id);
    if (!meta) return res.status(404).json({ error: 'unknown app' });
    if (!meta.github) return res.status(400).json({ error: 'link a github repo first' });
    if (meta.github.enabled !== true) return res.status(409).json({ error: 'enable github automation first' });
    meta.github.pollMinutes = Math.max(0, Math.min(60, parseInt(req.body.minutes, 10) || 0));
    save(db_);
    res.json({ ok: true, pollMinutes: meta.github.pollMinutes });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/types', (req, res) => {
  res.json([
    { id: 'static', label: 'Static HTML' },
    { id: 'react', label: 'React (build + serve)' },
    { id: 'node', label: 'Node.js' },
    { id: 'php', label: 'PHP + Apache' }
  ]);
});

function cleanDomain(value) {
  const domain = String(value || '').trim().toLowerCase().replace(/\.$/, '');
  if (!domain) return '';
  if (domain.length > 253 || !domain.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) {
    throw new Error('domain must be a hostname only, for example app.example.com (no protocol, path, port, or spaces)');
  }
  return domain;
}

app.get('/api/apps', (req, res) => res.json(load().apps.map(meta => ({
  ...pubApp(meta),
  services: publicServices(meta, appDir(APPS_DIR, meta.id))
}))));
app.get('/api/panel/storage', async (req, res) => {
  try { res.json(await quotas.status()); }
  catch (e) { res.status(e.status || 503).json({ ready: false, error: e.message }); }
});
app.get('/api/panel/storage/discovery', async (req, res) => {
  try { res.json(await hostStorage.discovery()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/panel/storage/remotes', (req, res) => {
  try { res.json(hostStorage.loadRemotes().map(hostStorage.publicRemote)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/panel/storage/remotes', (req, res) => {
  try { res.json(hostStorage.addRemote(req.body || {})); }
  catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});
app.delete('/api/panel/storage/remotes/:id', (req, res) => {
  try { res.json(hostStorage.removeRemote(req.params.id)); }
  catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});
app.get('/api/panel/storage/remotes/:id/setup', (req, res) => {
  try {
    const found = hostStorage.loadRemotes().find(r => r.id === req.params.id);
    if (!found) return res.status(404).json({ error: 'unknown remote' });
    res.json(hostStorage.remoteSetup(found));
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/panel/storage/provision', (req, res) => {
  try { res.json({ approval: hostStorage.provisionStatus() }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/panel/storage/provision', (req, res) => {
  try { res.json(hostStorage.requestProvision(req.body || {})); }
  catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});
// Persistent panel error log: toasts vanish, this does not. Newest first.
app.get('/api/panel/errors', (req, res) => {
  try { res.json(panelLog.readErrors(load().apps, req.query.limit)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/apps', async (req, res) => {
  let creatingId = null;
  try {
    const { name, type, repoUrl, db, port, domain } = req.body;
    if (!name || !type) return res.status(400).json({ error: 'name and type required' });
    if (!['static', 'react', 'node', 'php'].includes(type)) return res.status(400).json({ error: 'unsupported application type' });
    const rawName = siteIdentity.displayName(name);
    const id = req.body.pendingId || siteIdentity.allocate(APPS_DIR, load(), new Set([...creatingSites, ...lifecycleLocks]));
    if (lifecycleLocks.has(id) || creatingSites.has(id) || [...load().apps, ...(load().trash || [])].some(a => a.id === id)) return res.status(409).json({ error: 'site identity is already registered or busy' });
    const draft = req.body.pendingId ? siteIdentity.pending(APPS_DIR, id) : null;
    const storageBytes = quotas.limitBytes(req.body.storageGB);
    creatingId = id;
    creatingSites.add(id);
    let appDomain;
    try { appDomain = cleanDomain(domain); }
    catch (e) { return res.status(400).json({ error: e.message }); }
    const token = crypto.randomBytes(16).toString('hex');
    // localhost: auto-assign host port 8000+ so app is reachable without a domain
    const existing = load().apps;
    const used = new Set(existing.map(a => a.hostPort).filter(Boolean));
    let hostPort = parseInt(req.body.hostPort, 10) || 8000;
    while (used.has(hostPort) && hostPort < 9000) hostPort++;
    // site-owned git connection: fresh token per build, validated BEFORE anything
    // is created, stored on the site only - never the shared pool.
    let finalRepoUrl = repoUrl || '';
    let siteToken = String(req.body.gitToken || '').trim() || null;
    let explicitBranch = String(req.body.branch || '').trim() || null;
    if (explicitBranch && !/^[A-Za-z0-9._\/-]+$/.test(explicitBranch)) {
      return res.status(400).json({ error: `bad branch name '${explicitBranch}'` });
    }
    let ghLink = null;
    const ghRepo = req.body.ghRepo;
    if (ghRepo && ghRepo.repo) {
      const parts = String(ghRepo.repo).split('/');
      if (parts.length !== 2 || !parts[0] || !parts[1]) return res.status(400).json({ error: 'repo must be owner/name' });
      if (!siteToken) {
        // public repo: verify unauthenticated, clone token-free. No auto-webhook
        // without a token - polling/manual redeploy stays available.
        const info = await gh.apiPublic(`/repos/${parts[0]}/${parts[1]}`)
          .catch(() => { throw new Error('repo is not public - paste a site token for private repos'); });
        finalRepoUrl = info.clone_url;
        ghLink = { repo: info.full_name, branch: explicitBranch || info.default_branch, login: null, sha: null, pollMinutes: 0, enabled: false, token: null };
      } else {
        const me = await gh.apiWith(siteToken, '/user')
          .catch(() => { throw new Error('site token rejected by github - regenerate and repaste'); });
        const info = await gh.apiWith(siteToken, `/repos/${parts[0]}/${parts[1]}`)
          .catch(() => { throw new Error('token cannot read ' + ghRepo.repo + ' - check repo access on the token'); });
        let head = null;
        try {
          const br = explicitBranch || info.default_branch;
          const c = await gh.apiWith(siteToken, `/repos/${parts[0]}/${parts[1]}/commits/${encodeURIComponent(br)}`);
          head = c && c.sha;
        } catch {}
        finalRepoUrl = info.clone_url;
        ghLink = { repo: info.full_name, branch: explicitBranch || info.default_branch, login: me.login, sha: head, pollMinutes: 0, enabled: false, token: siteToken };
      }
    } else if (finalRepoUrl) {
      const m = finalRepoUrl.match(/github\.com[:/]([^/]+)\/([^/]+?)(\.git)?\/?$/i);
      if (m && siteToken) ghLink = { repo: `${m[1]}/${m[2]}`, branch: explicitBranch, login: null, sha: null, pollMinutes: 0, enabled: false, token: siteToken };
      else if (m && !siteToken) {
        // pasted public URL: link it token-free after a public readability check,
        // so pull/poll work unauthenticated and the webhook stays manual.
        const pub = await gh.apiPublic(`/repos/${m[1]}/${m[2]}`).catch(() => null);
        if (pub) ghLink = { repo: pub.full_name, branch: explicitBranch || pub.default_branch, login: null, sha: null, pollMinutes: 0, enabled: false, token: null };
      }
      else siteToken = null;
    }
    const dbs = normDbs(req.body.dbs !== undefined ? req.body.dbs : db);
    const subdir = String(req.body.subdir || '').replace(/^\/+|\/+$/g, '').replace(/\.\./g, '') || '';
    if (draft && (draft.repoUrl !== finalRepoUrl || draft.branch !== explicitBranch || draft.subdir !== subdir)) throw lifecycleError('pending checkout uses a different source - cancel and reopen before changing repositories, branches or folders');
    // Requested allowance is always validated and recorded. When the host
    // quota bridge is unavailable, creation proceeds unenforced rather than
    // bricking site creation - the UI labels it honestly as not enforced.
    // Only validation (400) and capacity (409) failures stay hard.
    let storageQuota = null, storageWarning = null;
    try {
      const reserved = await quotas.reserve(id, storageBytes);
      if (!reserved.enforced) throw Object.assign(new Error('host did not confirm an enforced storage allowance'), { status: 503 });
      storageQuota = { projectId: reserved.projectId, limitBytes: storageBytes, enforced: true };
    } catch (e) {
      if (e && (e.status === 400 || e.status === 409)) throw e;
      storageWarning = e.message;
      storageQuota = { projectId: null, limitBytes: storageBytes, enforced: false };
    }
    const pendingDir = appDir(APPS_DIR, id);
    fs.mkdirSync(pendingDir, { recursive: true });
    fs.writeFileSync(path.join(pendingDir, '.pending-create.json'), JSON.stringify({ id, repoUrl: finalRepoUrl, branch: explicitBranch, subdir }), { mode: 0o600 });
    const created = createApp({ appsDir: APPS_DIR, templatesDir: TEMPLATES_DIR, name: id, type, repoUrl: finalRepoUrl, db: dbs, port, domain: appDomain, hostPort, gitToken: siteToken, subdir, gitBranch: explicitBranch, standardDockerfile: req.body.standardDockerfile === true, modernizeBuild: req.body.modernizeBuild === true });
    siteIdentity.writeName(created.dir, id, rawName);
    fs.writeFileSync(path.join(created.dir, '.storage-quota.json'), JSON.stringify({ projectId: storageQuota.projectId, limitBytes: storageBytes }), { mode: 0o600 });
    quotas.bindDatabases(created.dir);
    envSetManaged(created.dir, { COMPOSE_PROJECT_NAME: id });
    const db_ = load();
    const meta = { id, name: rawName, type: created.type || type, repoUrl: finalRepoUrl, github: ghLink, db: dbs, domain: appDomain, token, hostPort, subdir: created.subdir || '', storageQuota, buildOptions: { modernize: req.body.modernizeBuild === true }, createdAt: new Date().toISOString() };
    // Capture repository env sources before the first deploy. Never fail an
    // otherwise valid create solely because the private snapshot could not be written.
    try { applyEnvDefaults(meta, created.dir, req.hostname, req.protocol); }
    catch (e) { console.error(id, 'env defaults snapshot:', e.message); }
    db_.apps = db_.apps.filter(a => a.id !== id).concat([meta]);
    save(db_);
    try { fs.unlinkSync(path.join(created.dir, '.pending-create.json')); } catch {}
    // Source linking and automatic deployment are separate choices. The first
    // build is manual and automation stays off until explicitly enabled.
    const webhookNote = ghLink ? 'github linked - automation disabled' : 'no github automation';
    // build async so UI returns fast (goes through deploy() so it lands in deploy.log)
    deploy(id).catch(e => console.error(id, e.message));
    if (storageWarning) panelLog.logEvent({ level: 'warn', area: 'create', site: id, message: 'storage allowance recorded but not enforced: ' + storageWarning });
    res.json({ ...pubApp(meta), localUrl: `http://localhost:${hostPort}`, webhook: `/webhook/${id}?token=${token}`, webhookNote, storageEnforced: storageQuota.enforced === true, ...(storageWarning ? { storageWarning } : {}) });
  } catch (e) {
    const error = redactUrl(e.message);
    try { panelLog.logEvent({ level: 'error', area: 'create', site: creatingId, message: error }); } catch {}
    const needsDockerfile = /no Dockerfile in build context and type/i.test(error);
    const needsModernization = /Jekyll static build needs modernization/i.test(error);
    const pendingId = creatingId && fs.existsSync(path.join(appDir(APPS_DIR, creatingId), '.pending-create.json')) ? creatingId : null;
    res.status(needsDockerfile || needsModernization ? 409 : (e.status || 500)).json({ error, needsDockerfile, needsModernization, ...(pendingId ? { pendingId } : {}) });
  } finally {
    if (creatingId) creatingSites.delete(creatingId);
  }
});
// Canceling create removes only an unfinished checkout. Registered sites and
// anything with a generated Compose file are never touched by this endpoint.
app.delete('/api/apps/pending/:id', async (req, res) => {
  try {
    const id = String(req.params.id || '').toLowerCase().replace(/[^a-z0-9-]/g, '-');
    if (!trashLib.validId(id)) return res.status(400).json({ error: 'bad site id' });
    if (creatingSites.has(id)) return res.status(409).json({ error: 'site creation is still in progress' });
    if (load().apps.some(a => a.id === id)) return res.status(409).json({ error: 'site is already registered' });
    const dir = appDir(APPS_DIR, id);
    if (fs.existsSync(path.join(dir, 'docker-compose.yml'))) return res.status(409).json({ error: 'refusing to remove a composed site' });
    const hadFiles = fs.existsSync(dir);
    let charged = fs.existsSync(path.join(dir, '.storage-quota.json'));
    try { await quotas.usage(id); charged = true; }
    catch (e) { if (charged || (e.status !== 404 && e.status !== 503)) throw e; }
    fs.rmSync(dir, { recursive: true, force: true });
    // The quota bridge is optional for legacy pending checkouts, but a saved
    // reservation must never silently leak after a successful cancellation.
    if (charged) await quotas.release(id);
    res.json({ ok: true, removed: hadFiles });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

const redactUrl = s => String(s).replace(/x-access-token:[^@]+@/g, 'x-access-token:***@');
const LEGACY_PANEL_PHP_DOCKERFILE = [
  'FROM php:8.2-apache',
  'WORKDIR /var/www/html',
  'COPY . /var/www/html/',
  'EXPOSE 80'
].join('\n');
const deployLocks = new Set();
// Every trigger for one site goes through the same promise chain. A push that
// arrives during a build waits its turn instead of failing with "already in progress".
const deployQueues = new Map();
// Stop invalidates every deploy already queued at that moment. A later,
// explicit deploy captures the new epoch and may run normally.
const deployEpochs = new Map();
// Child processes owned by the active deploy. Kept separate from deployOps so
// /status can serialize the public operation record without ChildProcess cycles.
const deployChildren = new Map();
// Live ops: id -> { source, startedAt } so the UI can show per-card progress
// for server-side triggers (webhook/poll/local-push) with no browser involved.
const deployOps = new Map();
// Push receipts: id -> { phase, at }. The hook pings `received` before the
// queued deploy starts so the UI immediately shows incoming work.
const pushEvents = new Map();
function deploySh(id, cmd, cwd, env) {
  checkCancelled(id);
  return new Promise((res, rej) => {
    const child = exec(cmd, { cwd, env: env || process.env, maxBuffer: 10 * 1024 * 1024,
      detached: process.platform !== 'win32' }, (e, stdout, stderr) => {
      if (e) rej(new Error(stderr || e.message)); else res(stdout);
    });
    trackDeployChild(id, child);
  });
}
// Container image IDs before a deploy, so a failed swap can retag + restart them.
async function snapshotImages(id, dir) {
  const snaps = [];
  try {
    const out = await deploySh(id, `${COMPOSE_BIN} ps -q`, dir);
    for (const cid of out.trim().split('\n').filter(Boolean)) {
      try {
        const name = execSync(`docker inspect ${cid.trim()} --format '{{.Config.Image}}'`).toString().trim();
        const imgId = execSync(`docker inspect ${cid.trim()} --format '{{.Image}}'`).toString().trim();
        if (name && imgId) snaps.push({ name, imgId });
      } catch {}
    }
  } catch {}
  return snaps;
}
async function rollbackImages(dir, snaps) {
  if (!snaps.length) return;
  for (const s of snaps) {
    try { execSync(`docker tag ${s.imgId} ${s.name}`); } catch {}
  }
  await sh(`${COMPOSE_BIN} up -d --remove-orphans`, dir);
}
// Health gate: every enabled app service running (not restarting/exited) twice in a
// row, 5s apart, within ~60s. DB services excluded - slow first initdb is normal.
// `only` scopes the gate to just-rebuilt services (others keep whatever state they had).
async function waitStable(id, dir, meta, only = null) {
  const all = svc.fullServices(meta || {}, dir).filter(s => s.enabled !== false);
  const names = new Set((only && only.length ? all.filter(s => only.includes(s.name)) : all).map(s => s.name));
  let steady = 0;
  for (let i = 0; i < 12; i++) {
    if (i) await new Promise(r => setTimeout(r, 5000));
    checkCancelled(id); // stop mid-verify aborts before any rollback restart
    let cs = [];
    try { cs = await appContainers(id); } catch { continue; }
    const rel = cs.filter(c => names.has(c.service));
    if (rel.length && rel.some(c => /exited|dead|failed|removing/i.test(c.state || ''))) {
      return { ok: false, detail: rel.map(c => `${c.service}=${c.state}`).join(', ') };
    }
    if (rel.length && rel.every(c => /^running/i.test(c.state || ''))) {
      if (++steady >= 2) return { ok: true };
    } else steady = 0;
  }
  return { ok: false, detail: 'containers never stabilized within 60s' };
}
async function currentSha(dir) {
  try {
    const code = path.join(dir, 'code');
    // require code's OWN .git - otherwise rev-parse walks up into the panel repo
    if (!fs.existsSync(path.join(code, '.git'))) return null;
    return execSync('git rev-parse --short HEAD', { cwd: code }).toString().trim();
  } catch { return null; }
}

// Local pushes are checked out from repo.git into an isolated, disposable
// worktree. Docker Compose keeps the site's normal project, env, database
// services and volumes; only app-service build contexts are overridden.
function createLocalPushStage(dir, meta, pushedSha, pushedBranch) {
  if (!/^[0-9a-f]{40}$/.test(pushedSha || '') || !/^[A-Za-z0-9._/-]{1,64}$/.test(pushedBranch || '')) {
    throw new Error('local push is missing a valid commit sha or branch');
  }
  const bareRepo = path.join(dir, 'repo.git');
  if (!fs.existsSync(path.join(bareRepo, 'HEAD'))) throw new Error('local push repository is not initialized');
  try {
    execFileSync('git', ['check-ref-format', '--branch', pushedBranch], { stdio: 'ignore' });
    execFileSync('git', ['--git-dir', bareRepo, 'show-ref', '--verify', `refs/heads/${pushedBranch}`], { stdio: 'ignore' });
    execFileSync('git', ['--git-dir', bareRepo, 'cat-file', '-e', `${pushedSha}^{commit}`], { stdio: 'ignore' });
  } catch {
    throw new Error(`commit ${pushedSha.slice(0, 7)} or pushed branch '${pushedBranch}' is not available in the local repository`);
  }

  const stageRoot = path.join(dir, '.local-deploy');
  const stageCode = path.join(stageRoot, 'code');
  const cleanup = () => {
    try { execFileSync('git', ['--git-dir', bareRepo, 'worktree', 'remove', '--force', stageCode], { stdio: 'ignore' }); } catch {}
    try { fs.rmSync(stageRoot, { recursive: true, force: true }); } catch {}
    try { execFileSync('git', ['--git-dir', bareRepo, 'worktree', 'prune'], { stdio: 'ignore' }); } catch {}
  };
  cleanup();
  try {
    fs.mkdirSync(stageRoot, { recursive: true });
    execFileSync('git', ['--git-dir', bareRepo, 'worktree', 'add', '--force', '--detach', stageCode, pushedSha], { stdio: 'pipe' });

    const enabled = svc.fullServices(meta || {}, dir).filter(s => s.enabled !== false);
    const lines = ['services:'];
    for (const s of enabled) {
      const ctxDir = path.join(stageCode, s.subdir || '');
      if (!fs.existsSync(ctxDir)) throw new Error(`service '${s.name}' build folder '${s.subdir || '.'}' is absent from pushed commit`);
      ensureDockerfile(ctxDir, s.type, TEMPLATES_DIR, { modernize: !!((s.buildOptions || (s.name === 'app' && meta.buildOptions) || {}).modernize) });
      // Upgrade only exact historical Node/React templates, including monorepo
      // services and detached local-push checkouts. Never rewrite custom files.
      refreshStandardDockerfile(ctxDir, s.type, TEMPLATES_DIR);
      if (s.type === 'static' || s.type === 'react') {
        const nc = path.join(ctxDir, 'nginx.conf');
        if (!fs.existsSync(nc)) fs.writeFileSync(nc, nginxConf(null));
      }
      lines.push(`  ${s.name}:`, '    build:', `      context: ${JSON.stringify(ctxDir.replace(/\\/g, '/'))}`, '      dockerfile: Dockerfile');
    }
    const override = path.join(stageRoot, 'compose.override.yml');
    fs.writeFileSync(override, lines.join('\n') + '\n');
    return {
      codeDir: stageCode,
      compose: `${COMPOSE_BIN} -f "${path.join(dir, 'docker-compose.yml')}" -f "${override}"`,
      sha: pushedSha.slice(0, 7),
      cleanup
    };
  } catch (e) {
    cleanup();
    throw e;
  }
}
async function recordDeploy(id, rec) {
  const op = deployOps.get(id);
  if (op) {
    rec.source = rec.source || op.source;
    if (!rec.durationMs) rec.durationMs = Date.now() - op.startedAt;
  }
  if (rec.status === 'error') {
    rec.error = panelLog.redact(rec.error || 'Deployment failed').slice(0, 2000);
    panelLog.logEvent(panelLog.deploymentEvent(id, rec));
    if (op) op.failureRecorded = true;
  }
  try {
    const db2 = load();
    const m = db2.apps.find(a => a.id === id);
    if (m) {
      m.lastDeploy = rec;
      if (rec.status === 'ok') {
        delete m.dirty;
        if (Array.isArray(m.pendingImportBuilds) && Array.isArray(rec.services)) {
          m.pendingImportBuilds = m.pendingImportBuilds.filter(name => !rec.services.includes(name));
          if (!m.pendingImportBuilds.length) delete m.pendingImportBuilds;
        }
        m.lastGoodDeploy = { at: rec.at, sha: rec.sha, status: rec.status, source: rec.source || null, durationMs: rec.durationMs != null ? rec.durationMs : null };
      }
      m.deployHistory = [{ at: rec.at, sha: rec.sha, status: rec.status, source: rec.source || null, durationMs: rec.durationMs != null ? rec.durationMs : null, error: rec.error || null }, ...(m.deployHistory || [])].slice(0, 10);
      save(db2);
    }
  } catch {}
}
// Anything that changes what a build would produce marks the app dirty.
// Deploy buttons enable off this; a successful deploy clears it.
async function markDirty(id, reason) {
  try {
    const db2 = load();
    const m = db2.apps.find(a => a.id === id);
    if (m && !m.dirty) { m.dirty = { reason, at: new Date().toISOString() }; save(db2); }
  } catch {}
}
// Detect a landing path per service. Frontend images always open at /: SPA
// fallbacks return 200 for arbitrary health paths and cannot prove such a route
// exists. Backend services are probed by their own Compose DNS name and port.
async function autodetectHome(id) {
  try {
    const dir = appDir(APPS_DIR, id);
    const fresh = load().apps.find(a => a.id === id);
    if (!fresh) return;
    const services = svc.fullServices(fresh, dir).filter(s => s.enabled !== false);
    const net = `${id}_default`;
    const cands = routes.PROBE_PATHS;
    const results = [];
    for (const service of services) {
      if (['static', 'react'].includes(service.type)) {
        results.push({ name: service.name, path: '', openPaths: [{ path: '/', code: 200, live: true, source: 'frontend' }] });
        continue;
      }
      const ctxDir = path.join(dir, 'code', service.subdir || '');
      const sourceRoutes = routes.detectOpenPaths(ctxDir);
      const directRoutes = sourceRoutes.filter(r => r.direct).map(r => r.path);
      const mountedRoutes = sourceRoutes.filter(r => !r.direct).map(r => r.path);
      const sourceCandidates = [...new Set([...directRoutes, ...mountedRoutes])]
        .sort((a, b) => routes.routeScore(a) - routes.routeScore(b)).slice(0, 24);
      const discovered = new Map(sourceCandidates.map(p => [p, {
        path: p, code: null, live: null, source: directRoutes.includes(p) ? 'direct' : 'router'
      }]));
      const probeOne = async (p, record = true) => {
        try {
          const url = `http://${service.name}:${parseInt(service.port, 10) || 3000}${p}`;
          const code = String(await runOut(DOCKER_BIN, ['run', '--rm', '--network', net, 'curlimages/curl:latest', '-s', '-o', '/dev/null', '-w', '%{http_code}', '--max-time', '5', url], { timeout: 25000 })).trim();
          const item = discovered.get(p) || { path: p, source: 'probe' };
          item.code = parseInt(code, 10) || null;
          item.live = routes.liveStatus(code);
          if (record) discovered.set(p, item);
          return item;
        } catch { return null; }
      };
      // Probe every literal source route so multi-route APIs can present all
      // valid entry points. A successful deliberately-missing path means this
      // app has a catch-all/soft-404 (common in PHP front controllers and SPAs),
      // so guessed health paths cannot prove anything and root is the safe default.
      const sentinel = await probeOne(routes.PROBE_SENTINEL, false);
      const soft404 = !!(sentinel && sentinel.live);
      let live = [];
      if (soft404) {
        const root = await probeOne('/');
        if (root && root.live) live = [root];
      } else {
        for (const p of sourceCandidates) await probeOne(p);
        if (sourceCandidates.length && ![...discovered.values()].some(x => x.live)) {
          await new Promise(r => setTimeout(r, 2000));
          for (const p of sourceCandidates) await probeOne(p);
        }
        live = [...discovered.values()].filter(x => x.live)
          .sort((a, b) => routes.routeScore(a.path) - routes.routeScore(b.path));
        if (!live.length) {
          const fallbacks = cands.filter(p => !discovered.has(p));
          for (let round = 0; round < 2 && !live.length; round++) {
            if (round) await new Promise(r => setTimeout(r, 2000));
            for (const p of fallbacks) {
              const item = await probeOne(p);
              if (item && item.live) { live = [item]; break; }
            }
          }
        }
      }
      const currentPath = service.name === 'app' ? (fresh.homePath || '/') : (service.homePath || '/');
      let found = routes.chooseOpenPath(live, currentPath);
      // A direct app.get/server.get/Route::get declaration is more useful than
      // publishing a known-bad root when Docker cannot run the curl probe.
      const anyResponse = [...discovered.values()].some(x => x.code != null);
      if (found == null && directRoutes.length && !anyResponse) found = directRoutes[0];
      if (found != null) {
        const openPaths = [...discovered.values()]
          .filter(x => sourceCandidates.includes(x.path) || x.live)
          .sort((a, b) => Number(b.live === true) - Number(a.live === true) || routes.routeScore(a.path) - routes.routeScore(b.path));
        results.push({ name: service.name, path: found === '/' ? '' : found, openPaths });
      }
    }
    if (!results.length) return;
    const db3 = load();
    const m3 = db3.apps.find(a => a.id === id);
    if (!m3) return;
    let changed = false;
    for (const result of results) {
      if (result.name === 'app') {
        if (!m3.homePathManual && (m3.homePath || '') !== result.path) { m3.homePath = result.path; changed = true; }
        if (JSON.stringify(m3.openPaths || []) !== JSON.stringify(result.openPaths || [])) { m3.openPaths = result.openPaths || []; changed = true; }
      } else if (Array.isArray(m3.services)) {
        const stored = m3.services.find(s => s.name === result.name);
        if (stored && (stored.homePath || '') !== result.path) { stored.homePath = result.path; changed = true; }
        if (stored && JSON.stringify(stored.openPaths || []) !== JSON.stringify(result.openPaths || [])) { stored.openPaths = result.openPaths || []; changed = true; }
      }
    }
    if (changed) save(db3);
  } catch (e) { console.error(id, 'autodetect:', e.message); }
}
function deploy(id, opts = {}) {
  if (lifecycleLocks.has(id)) return Promise.reject(new Error('site lifecycle operation in progress'));
  const epoch = deployEpochs.get(id) || 0;
  const previous = deployQueues.get(id) || Promise.resolve();
  const run = previous.catch(() => {}).then(() => {
    if ((deployEpochs.get(id) || 0) !== epoch) throw deployCancelledError();
    return deployNow(id, opts);
  });
  deployQueues.set(id, run);
  const clear = () => { if (deployQueues.get(id) === run) deployQueues.delete(id); };
  run.then(clear, clear);
  return run;
}

// Deploy-time port rebind: a stored host port may be squatted by an orphan
// container, a manual `docker run`, or another site's un-refreshed claim.
// Our own running containers legitimately hold our ports and never count.
// On any move, meta + .env + compose are rewritten before the build, so every
// later stage (build, migrate, up, health gate) sees the new ports.
async function rebindHostPorts(id, dir, meta, composeCmd) {
  const enabled = svc.fullServices(meta || {}, dir).filter(s => s.enabled !== false && s.hostPort);
  if (!enabled.length) return [];
  let own = [];
  try { own = String(await deploySh(id, `${composeCmd} ps -q`, dir)).split(/\s+/).map(s => s.trim()).filter(Boolean); }
  catch { own = []; }
  let bound;
  try {
    bound = portsLib.parsePublishedPorts(await sh('docker ps --format "{{.ID}} {{.Ports}}"', dir));
  } catch {
    return []; // docker unreachable - keep stored ports, `up` reports the truth
  }
  const selfPorts = new Set(enabled.map(s => parseInt(s.hostPort, 10)));
  const registryOthers = new Set([...hostPortsInUse()].filter(p => !selfPorts.has(p)));
  const moves = portsLib.planRebind(enabled.map(s => ({ name: s.name, hostPort: s.hostPort })), { bound, own, registryOthers });
  if (!moves.length) return [];
  const byName = new Map(moves.map(m => [m.name, m.to]));
  for (const s of enabled) if (byName.has(s.name)) s.hostPort = byName.get(s.name);
  if (!meta.services || !meta.services.length) meta.services = enabled;
  const primary = enabled.find(s => s.name === 'app') || enabled[0];
  meta.hostPort = primary.hostPort;
  envSetManaged(dir, { HOST_PORT: String(primary.hostPort) });
  svc.renderProject({ dir, templatesDir: TEMPLATES_DIR, meta });
  const db = load();
  const m = db.apps.find(a => a.id === id);
  if (m) { m.services = meta.services; m.hostPort = meta.hostPort; save(db); }
  return moves.map(m => ({ service: m.name, from: m.from, to: m.to }));
}

async function deployNow(id, opts = {}) {
  // The queue above serializes builds. Keep the lock as live UI state and as a
  // defensive invariant against any future call that bypasses the queue.
  if (deployLocks.has(id)) throw new Error('internal deploy queue violation');
  deployLocks.add(id);
  const opSource = ['webhook', 'poll', 'local-push', 'manual', 'local'].includes(opts.source) ? opts.source : 'manual';
  deployOps.set(id, { source: opSource, startedAt: Date.now() });
  pushEvents.delete(id);
  let localStage = null;
  try {
  const dir = appDir(APPS_DIR, id);
  const meta = load().apps.find(a => a.id === id);
  const codeDir = path.join(dir, 'code');
  if (!meta) throw new Error('unknown app');
  const buildLog = path.join(dir, 'deploy.log');
  // One log per attempt. Clear before any preflight/pre-build output, not just
  // before Docker build (which used to erase successful pre-build evidence).
  fs.writeFileSync(buildLog, `--- deploy ${opSource} started ${new Date().toISOString()} ---\n`);
  await quotas.ensure(meta);
  if (meta.storageQuota) await quotas.verifyDatabases(meta.id, dir);
  let buildCodeDir = codeDir;
  let composeCmd = meta.storageQuota ? `${COMPOSE_BIN} -p ${id}` : COMPOSE_BIN;
  let sourceSha = null;

  // Host ports are claimed at create time, but orphans from deleted sites,
  // manual containers, or hand edits can squat a stored port. Rebind to the
  // next free port now instead of dying in `up` with "port is already allocated".
  // Covers every trigger path below (manual, webhook, poll, local-push).
  try {
    const moved = await rebindHostPorts(id, dir, meta, composeCmd);
    if (moved.length) {
      try { fs.appendFileSync(path.join(dir, 'deploy.log'), moved.map(u => `host port ${u.from} taken - ${u.service} moved to ${u.to}\n`).join('')); } catch {}
    }
  } catch (e) {
    if (deployOps.get(id) && deployOps.get(id).cancelled) throw deployCancelledError();
    const shaRb = await currentSha(dir);
    await recordDeploy(id, { sha: shaRb, at: new Date().toISOString(), status: 'error', error: ('host port rebind failed - running containers untouched: ' + e.message).slice(-500) });
    throw e;
  }

  if (opSource === 'local-push') {
    try {
      localStage = createLocalPushStage(dir, meta, opts.pushedSha, opts.pushedBranch);
      buildCodeDir = localStage.codeDir;
      composeCmd = localStage.compose + (meta.storageQuota ? ` -p ${id}` : '');
      sourceSha = localStage.sha;
    } catch (e) {
      await recordDeploy(id, {
        sha: /^[0-9a-f]{40}$/.test(opts.pushedSha || '') ? opts.pushedSha.slice(0, 7) : null,
        at: new Date().toISOString(), status: 'error',
        error: ('local checkout failed - running containers untouched: ' + e.message).slice(-500)
      });
      throw e;
    }
  } else if (meta.repoUrl) {
    if (!opts.skipSync) {
    const isSsh = /^(git@|ssh:\/\/)/i.test(meta.repoUrl);
    const url = isSsh ? meta.repoUrl : gh.authUrlFor(meta, meta.repoUrl);
    const env = isSsh ? appGitEnv(dir) : process.env;
    try {
      const protectedServices = svc.fullServices(meta, dir);
      for (const service of protectedServices.filter(s => s.enabled !== false)) importProtection.migrate(dir, service, codeDir);
      if (fs.existsSync(path.join(codeDir, '.git'))) {
        importProtection.run(dir, protectedServices, codeDir, 'suspend', line => fs.appendFileSync(buildLog, line + '\n'));
        dockerfileProtection.run(dir, protectedServices, codeDir, 'suspend', line => fs.appendFileSync(buildLog, line + '\n'));
      }
      if (!fs.existsSync(path.join(codeDir, '.git'))) {
        // first sync: repo linked after a template create - replace starter with repo,
        // keeping managed build files the container needs
        execSync(`git clone --depth 1 "${url}" "${codeDir}.new"`, { stdio: 'pipe', env });
        for (const f of ['Dockerfile', 'nginx.conf']) {
          const dst = path.join(codeDir + '.new', f);
          const src = path.join(TEMPLATES_DIR, meta.type || 'static', f);
          if (!fs.existsSync(dst) && fs.existsSync(src)) fs.copyFileSync(src, dst);
        }
        fs.rmSync(codeDir, { recursive: true, force: true });
        fs.renameSync(codeDir + '.new', codeDir);
      } else {
        let branch = (meta.github && meta.github.branch) || 'main';
        try { branch = execSync('git branch --show-current', { cwd: codeDir }).toString().trim() || branch; } catch {}
        await deploySh(id, `git pull --ff-only "${url}" "${branch}"`, codeDir, env);
      }
    } catch (e) {
      let msg = redactUrl(e.stderr ? String(e.stderr) : e.message);
      // A failed pull must not leave exact approved corrections removed.
      try {
        importProtection.run(dir, svc.fullServices(meta, dir), codeDir, 'replay', line => fs.appendFileSync(buildLog, line + '\n'));
        dockerfileProtection.run(dir, svc.fullServices(meta, dir), codeDir, 'replay', line => fs.appendFileSync(buildLog, line + '\n'));
      }
      catch (restoreError) { msg += '\nImport protection needs review: ' + restoreError.message; }
      if (deployOps.get(id) && deployOps.get(id).cancelled) throw deployCancelledError();
      const sha0 = await currentSha(dir);
      await recordDeploy(id, { sha: sha0, at: new Date().toISOString(), status: 'error', error: ('git sync failed - running containers untouched: ' + msg).slice(-500) });
      throw new Error(msg);
    }
    } // end pull (local rebuilds skip the sync: box files are the source of truth)
  }
  // All deployment sources, including detached local-push checkouts and local
  // rebuilds, pass the same approval gate before any build or container swap.
  const replayedImportServices = new Set();
  try {
    const protectedServices = svc.fullServices(meta, dir);
    for (const service of protectedServices.filter(s => s.enabled !== false)) importProtection.migrate(dir, service, codeDir);
    for (const name of importProtection.run(dir, protectedServices, buildCodeDir, 'replay', line => fs.appendFileSync(buildLog, line + '\n'))) replayedImportServices.add(name);
    for (const name of dockerfileProtection.run(dir, protectedServices, buildCodeDir, 'replay', line => fs.appendFileSync(buildLog, line + '\n'))) replayedImportServices.add(name);
  } catch (e) {
    const failure = 'import protection blocked deployment - running containers untouched: ' + e.message;
    fs.appendFileSync(buildLog, failure + '\n');
    await recordDeploy(id, { sha: sourceSha || await currentSha(dir), at: new Date().toISOString(), status: 'error', error: failure });
    throw new Error(failure);
  }
  // self-heal seeded build files: a panel-seeded Dockerfile/nginx.conf that later
  // vanished (swept, deleted, never committed) kills the build cryptically.
  // Re-seed when the repo shape is unambiguous, fail loud otherwise.
  try {
    for (const s of svc.fullServices(meta || {}, dir).filter(s => s.enabled !== false)) {
      const ctxDir = path.join(buildCodeDir, s.subdir || '');
      let hasDockerfile = false;
      try { hasDockerfile = fs.readdirSync(ctxDir).some(f => /^dockerfile$/i.test(f)); } catch {}
      if (!hasDockerfile) {
        const detected = svc.detectServiceType(ctxDir);
        if (detected.type && detected.type !== s.type) {
          throw new Error(`service '${s.name}' is configured as '${s.type}' but '${s.subdir || '.'}' is detected as '${detected.type}' - change the service type`);
        }
      }
      const profile = readBuildProfile(ctxDir);
      if (profile.kind === 'jekyll' && s.type !== 'static' && standardDockerfileType(ctxDir, TEMPLATES_DIR)) {
        throw new Error(`service '${s.name}' is a Jekyll static site, not ${s.type} - open Setup and choose Use Jekyll static build`);
      }
      ensureDockerfile(ctxDir, s.type, TEMPLATES_DIR, { modernize: !!((s.buildOptions || (s.name === 'app' && meta.buildOptions) || {}).modernize) });
      // Native build prerequisites also apply to ordinary repo/local rebuilds.
      refreshStandardDockerfile(ctxDir, s.type, TEMPLATES_DIR);
      // Refresh panel-owned PHP images so existing sites gain standard Apache
      // rewrite support. The pre-marker legacy file is recognized only by an
      // exact byte-normalized match; repository/custom Dockerfiles stay sacred.
      if (s.type === 'php') {
        const df = path.join(ctxDir, 'Dockerfile');
        const tpl = path.join(TEMPLATES_DIR, 'php', 'Dockerfile');
        try {
          const current = fs.readFileSync(df, 'utf8').replace(/\r\n/g, '\n').trim();
          if ((current.startsWith('# minipass template') || current === LEGACY_PANEL_PHP_DOCKERFILE) && fs.existsSync(tpl)) {
            fs.copyFileSync(tpl, df);
          }
        } catch {}
      }
      if (s.type === 'static' || s.type === 'react') {
        try {
          if (!fs.existsSync(path.join(ctxDir, 'nginx.conf'))) fs.writeFileSync(path.join(ctxDir, 'nginx.conf'), nginxConf(null));
        } catch {}
      }
    }
  } catch (e) {
    const shaSe = sourceSha || await currentSha(dir);
    await recordDeploy(id, { sha: shaSe, at: new Date().toISOString(), status: 'error', error: ('missing build file - running containers untouched: ' + e.message).slice(-500) });
    throw e;
  }
  // automatic pre-build: a repo-owned Dockerfile that expects compiled output
  // (dist/) without compiling it gets the repo's own build script run first in
  // a disposable builder container. The Dockerfile itself is never modified;
  // services that build themselves, lack a build script, or already have the
  // output behave exactly as before.
  let prebuildService = null;
  try {
    for (const s of svc.fullServices(meta || {}, dir).filter(s => s.enabled !== false)) {
      if (/^db(-|$)/.test(s.name || '')) continue;
      const ctxDir = path.join(buildCodeDir, s.subdir || '');
      const force = replayedImportServices.has(s.name) || (Array.isArray(meta.pendingImportBuilds) && meta.pendingImportBuilds.includes(s.name)) || importProtection.list(dir, s.name).length > 0;
      const item = prebuild.plan(ctxDir, { force });
      if (!item) continue;
      prebuildService = s.name;
      if (item.blocked) throw new Error(`service '${s.name}' pre-build blocked - running containers untouched: ${item.blocked}`);
      fs.appendFileSync(buildLog, `--- pre-building service '${s.name}' folder '${s.subdir || '.'}' (${item.manager} run build) ${force ? 'after approved import correction' : `for missing '${item.outputDir}/'`} ---\n`);
      const tracked = child => trackDeployChild(id, child);
      await prebuild.ensureBuilderImage(args => args[1] === 'pull'
        ? runLogged(DOCKER_BIN, args, { cwd: dir, logFile: buildLog, detached: process.platform !== 'win32', onSpawn: tracked })
        : runOut(DOCKER_BIN, args, { cwd: dir, detached: process.platform !== 'win32', onSpawn: tracked }));
      checkCancelled(id);
      await runLogged(DOCKER_BIN, prebuild.argv(ctxDir, item), { cwd: dir, logFile: buildLog,
        detached: process.platform !== 'win32', onSpawn: tracked });
    }
  } catch (e) {
    if (deployOps.get(id) && deployOps.get(id).cancelled) throw deployCancelledError();
    const shaPb = sourceSha || await currentSha(dir);
    const failure = panelLog.redact(`pre-build failed${prebuildService ? ` for service '${prebuildService}'` : ''} - running containers untouched: ` + e.message).slice(0, 2000);
    await recordDeploy(id, { sha: shaPb, at: new Date().toISOString(), status: 'error', service: prebuildService, error: failure });
    throw new Error(failure);
  }
  // every build streams to deploy.log (host-persisted, per app) so the UI can show
  // the builder output; failures return the tail instead of a bare exit code.
  // --remove-orphans: disabled/removed services actually disappear.
  // opts.only: rebuild just these services, the rest stay untouched and running.
  const only = Array.isArray(opts.only)
    ? [...new Set(opts.only.filter(s => /^[A-Za-z0-9_-]{1,32}$/.test(s || '')))]
    : [];
  const scope = only.join(' ');
  // heal: static/react must ship our nginx.conf (SPA fallback, proxy when linked).
  // Only files WE seeded (marker headers) are ever refreshed - repo-owned files are sacred.
  // Proxy target comes from env (the link lives there), meta only migrates old links forward.
  // heal: every enabled static/react SERVICE gets a working nginx.conf.
  // Only files WE seeded (marker headers) are ever refreshed - repo-owned files are sacred.
  // The api link lands on its recorded service (or the first frontend); others stay plain.
  try {
    const services = svc.fullServices(meta || {}, dir);
    const fronts = services.filter(s => (s.type === 'static' || s.type === 'react') && s.enabled !== false);
    const envNow = parseEnvFile(path.join(dir, '.env'));
    let proxy = null;
    const ab = meta && meta.apiBackend;
    if (ab && ab.app) {
      const sib = services.find(s => s.name === ab.app.replace(/^svc:/, '') && s.enabled !== false);
      if (sib) {
        proxy = { host: sib.name, port: parseInt(sib.port, 10) || 3000 };
      } else {
        const t = load().apps.find(a => a.id === ab.app);
        if (t && t.hostPort) proxy = { host: 'host.docker.internal', port: t.hostPort };
      }
      if (proxy && (envNow.API_PORT !== String(proxy.port) || envNow.API_HOST !== proxy.host)) {
        envSetManaged(dir, { API_HOST: proxy.host, API_PORT: String(proxy.port) });
      }
    }
    if (!proxy && envNow.API_HOST && envNow.API_PORT) proxy = { host: envNow.API_HOST, port: envNow.API_PORT };
    const linkedSvc = (ab && ab.service) || (fronts[0] && fronts[0].name);
    for (const f of fronts) {
      const ctx = path.join(buildCodeDir, f.subdir || '');
      const df = path.join(ctx, 'Dockerfile');
      if (f.type === 'static' && readBuildProfile(ctx).kind !== 'jekyll' && fs.existsSync(df)) {
        const first = (fs.readFileSync(df, 'utf8').split('\n')[0] || '');
        if (first.includes('minipass template') || first.includes('build stage + serve')) {
          const tplDf = path.join(TEMPLATES_DIR, f.type, 'Dockerfile');
          if (fs.existsSync(tplDf)) fs.copyFileSync(tplDf, df);
        }
      }
      const wantProxy = linkedSvc === f.name ? proxy : null;
      const nc = path.join(ctx, 'nginx.conf');
      let cur = null;
      try { cur = fs.readFileSync(nc, 'utf8'); } catch {}
      if (cur === null) {
        fs.writeFileSync(nc, nginxConf(wantProxy));
      } else if (cur.includes('# minipass-managed') && cur !== nginxConf(wantProxy)) {
        fs.writeFileSync(nc, nginxConf(wantProxy));
      }
    }
  } catch {}
  // auto-link: exactly one backend sibling + frontend(s) present and no explicit
  // choice on record = wire it. Manual unlink sets apiLinkOff so this never fights back.
  try {
    const autoSvcs = svc.fullServices(meta, dir);
    const autoFronts = autoSvcs.filter(s => (s.type === 'static' || s.type === 'react') && s.enabled !== false);
    const autoBacks = autoSvcs.filter(s => s.type !== 'static' && s.type !== 'react' && s.enabled !== false);
    if (!meta.apiBackend && !meta.apiLinkOff && autoFronts.length >= 1 && autoBacks.length === 1) {
      const b = autoBacks[0];
      meta.apiBackend = { app: b.name, port: parseInt(b.port, 10) || 3000, auto: true };
      const dbAuto = load();
      const mAuto = dbAuto.apps.find(a => a.id === id);
      if (mAuto) { mAuto.apiBackend = meta.apiBackend; save(dbAuto); }
    }
  } catch {}
  const sha = sourceSha || await currentSha(dir);
  const stamp = () => new Date().toISOString();
  // atomic deploy: snapshot running images, build WITHOUT touching containers,
  // swap only on success, health-gate the new containers, roll back on failure.
  const snaps = await snapshotImages(id, dir);
  checkCancelled(id);
  const scopeSuffix = scope ? ` ${scope}` : '';
  fs.appendFileSync(buildLog, '--- Docker image build ---\n');
  const buildOffset = fs.statSync(buildLog).size;
  try {
    await deploySh(id, `${composeCmd} build${scopeSuffix} >> "${buildLog}" 2>&1`, dir);
  } catch (e) {
    if (deployOps.get(id) && deployOps.get(id).cancelled) {
      const cancelled = 'deploy cancelled - active build terminated and containers stay stopped';
      try { fs.appendFileSync(buildLog, `\n--- ${cancelled} ---\n`); } catch {}
      await recordDeploy(id, { sha, at: stamp(), status: 'error', error: cancelled });
      throw deployCancelledError();
    }
    let tail = '';
    try {
      const lines = fs.readFileSync(buildLog).subarray(buildOffset).toString('utf8').split('\n');
      // The last lines are usually just the summary; the cause (npm error
      // codes, tsc errors, ELIFECYCLE) sits above. Prefer cause lines so the
      // Deploy tab names the failure without SSH.
      tail = failureSummary(lines.slice(-500).join('\n'));
    } catch {}
    await recordDeploy(id, { sha, at: stamp(), status: 'error', error: panelLog.redact('build failed - running containers untouched: ' + (tail || e.message)).trim().slice(0, 2000) });
    throw new Error('build failed - running containers untouched: ' + (tail || e.message).trim().split('\n').slice(-3).join(' '));
  }
  if (opts.skipSync) {
    try { fs.appendFileSync(buildLog, '--- built from local box files (git sync skipped) ---\n'); } catch {}
  }
  // pre-swap migrations: one-off container from the fresh image, DBs already up.
  // Fail = abort before anything is swapped; running containers untouched.
  // Runs in the configured migrate service (knex usually lives in the backend
  // service, not 'app'), with an optional cd into its subfolder.
  const migrateCmd = String((meta && meta.migrateCmd) || '').trim();
  if (migrateCmd) {
    const migrateSvc = migrateTarget(meta, dir, meta.migrateSvc);
    const argv = migrateRunArgv(migrateSvc, meta.migrateDir || '', migrateCmd);
    try {
      checkCancelled(id);
      const out = await runOut(argv[0], argv.slice(1), { cwd: dir, captureStderr: true,
        detached: process.platform !== 'win32', onSpawn: child => trackDeployChild(id, child) });
      try { fs.appendFileSync(buildLog, `\n--- migrate (${migrateSvc}) ---\n` + String(out).slice(-2000)); } catch {}
    } catch (e) {
      if (deployOps.get(id) && deployOps.get(id).cancelled) throw deployCancelledError();
      const reason = migrationFailure(e);
      const failure = migrationResponse('migration failed - running containers untouched: ', e);
      try { fs.appendFileSync(buildLog, `\n--- migrate failed (${migrateSvc}) ---\n${reason}\n`); } catch {}
      await recordDeploy(id, { sha, at: stamp(), status: 'error', error: failure });
      throw new Error(failure);
    }
  }
  try {
    checkCancelled(id); // a stop during the build wins: never start containers afterwards
    await deploySh(id, `${composeCmd} up -d --remove-orphans${scopeSuffix} >> "${buildLog}" 2>&1`, dir);
  } catch (e) {
    if (deployOps.get(id) && deployOps.get(id).cancelled) {
      await recordDeploy(id, { sha, at: stamp(), status: 'error', error: 'deploy cancelled - the site was stopped mid-deploy; containers stay stopped' });
      throw new Error('deploy cancelled - the site was stopped mid-deploy; containers stay stopped');
    }
    await recordDeploy(id, { sha, at: stamp(), status: 'error', error: String(e.message).slice(-500) });
    throw e;
  }
  const gate = await waitStable(id, dir, meta, only.length ? only : null);
  if (!gate.ok) {
    await rollbackImages(dir, snaps).catch(() => {});
    await recordDeploy(id, { sha, at: stamp(), status: 'error', error: ('new containers unhealthy - rolled back: ' + gate.detail).slice(-500) });
    throw new Error('new containers unhealthy - rolled back: ' + gate.detail);
  }
  await recordDeploy(id, { sha, at: stamp(), status: 'ok', services: only.length ? only : svc.fullServices(meta, dir).filter(s => s.enabled !== false).map(s => s.name) });
  // Landing-path discovery is optional follow-up work. Do not hold the deploy
  // lock (and keep the UI pulsing) after the release is already healthy/live.
  autodetectHome(id).catch(e => console.error(id, 'home detection:', e.message));
  return true;
  } catch (e) {
    // Also retain failures before the build stage (quota checks, staging, etc.).
    // Stage-specific failures already recorded above must not be duplicated.
    const op = deployOps.get(id);
    if (op && !op.failureRecorded) {
      await recordDeploy(id, { at: new Date().toISOString(), status: 'error',
        error: panelLog.redact(e.message).slice(0, 2000) });
    }
    throw e;
  } finally {
    const cancelled = !!(deployOps.get(id) && deployOps.get(id).cancelled);
    if (localStage) localStage.cleanup();
    deployChildren.delete(id);
    deployLocks.delete(id);
    deployOps.delete(id);
    // Cancellation must clear live UI state immediately; no image was swapped,
    // so the optional post-deploy inventory is unnecessary and must not delay Stop.
    if (!cancelled) {
      try {
        const retained = load().apps.find(a => a.id === id);
        if (retained) await trashLib.rememberImages({ id, dir: appDir(APPS_DIR, id), record: retained, docker: DOCKER_BIN, compose: composeArgv() });
      } catch (e) { console.error(id, 'image inventory unavailable:', e.message); }
    }
  }
}

app.get('/api/apps/:id/build-log', (req, res) => {
  const tail = Math.max(10, Math.min(500, parseInt(req.query.tail, 10) || 80));
  try {
    const log = fs.readFileSync(path.join(appDir(APPS_DIR, req.params.id), 'deploy.log'), 'utf8');
    const lines = log.split('\n');
    const slice = lines.slice(-tail).join('\n') || '(empty build log)';
    res.type('text/plain').send(lines.length > tail ? `… showing last ${tail} of ${lines.length} lines (add ?tail=500 for all)\n\n${slice}` : slice);
  } catch { res.type('text/plain').send('(no builds recorded yet)'); }
});
app.get('/api/apps/:id/status', async (req, res) => {
  let meta = load().apps.find(a => a.id === req.params.id);
  if (!meta) return res.status(404).json({ error: 'unknown app' });
  const containers = await appContainers(meta.id);
  // appContainers shells out to Docker and can overlap the end of a deploy.
  // Reload metadata afterwards so a slow request never returns pre-deploy
  // history after a newer request has already rendered the successful record.
  meta = load().apps.find(a => a.id === req.params.id);
  if (!meta) return res.status(404).json({ error: 'unknown app' });
  const history = meta.deployHistory || [];
  const liveDeploy = meta.lastGoodDeploy || history.find(h => h.status === 'ok') || (meta.lastDeploy && meta.lastDeploy.status === 'ok' ? meta.lastDeploy : null);
  res.json({ app: pubApp(meta), services: publicServices(meta, appDir(APPS_DIR, meta.id)), lastDeploy: meta.lastDeploy || null, liveDeploy, history: history.slice(0, 5), containers, deploying: deployLocks.has(meta.id), deployOp: deployOps.get(meta.id) || null, pushEvent: pushEvents.get(meta.id) || null });
});
// Size inspection is on-demand, never part of the list/status polling loop.
const storageRequests = new Map();
app.get('/api/apps/:id/storage', async (req, res) => {
  const meta = load().apps.find(a => a.id === req.params.id);
  if (!meta) return res.status(404).json({ error: 'unknown app' });
  let pending = storageRequests.get(meta.id);
  if (!pending) {
    pending = (async () => {
      const report = await storage.measureStorage({ id: meta.id, dir: appDir(APPS_DIR, meta.id) });
      if (meta.storageQuota) {
        if (!meta.storageQuota.projectId) {
          report.quota = { ...meta.storageQuota, enforced: false, error: 'Recorded allowance is not enforced on this host yet - complete quota setup to enforce it.' };
        } else {
          try { report.quota = await quotas.usage(meta.id); }
          catch (e) { report.quota = { ...meta.storageQuota, enforced: false, error: e.message }; }
        }
      }
      return report;
    })();
    storageRequests.set(meta.id, pending);
  }
  try { res.json(await pending); }
  catch { res.status(500).json({ error: 'storage measurement unavailable' }); }
  finally { if (storageRequests.get(meta.id) === pending) storageRequests.delete(meta.id); }
});
async function appContainers(id) {
  let containers = [];
  try {
    const out = await sh(`${COMPOSE_BIN} ps --format json`, appDir(APPS_DIR, id));
    let arr = [];
    try {
      const parsed = JSON.parse(out.trim() || '[]');
      arr = Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      arr = out.trim().split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    }
    containers = arr.map(c => ({
      id: c.ID || c.Id || c.id,
      service: c.Service || c.service || c.Name || c.name,
      image: c.Image || c.image,
      state: c.State || c.state,
      status: c.Status || c.status
    }));
  } catch {}
  return containers;
}
// Doctor: same checklist for any developer's app - containers, OOM, landing path,
// and known failure signatures in recent logs. Read-only, no changes.
const LOG_RULES = [
  { re: /relation "([^"]+)" does not exist/, level: 'fail', msg: m => `table "${m[1]}" missing in postgres — run this app's migrations` },
  { re: /FATAL:\s+database "([^"]+)" does not exist/, level: 'fail', msg: m => `database "${m[1]}" missing on the db service — wrong DB name in env?` },
  { re: /FATAL:\s+role "([^"]+)" does not exist/, level: 'fail', msg: m => `db role "${m[1]}" missing — user/password out of sync with the volume?` },
  { re: /password authentication failed/i, level: 'fail', msg: () => 'db password rejected — .env out of sync with the kept volume (recreate resets both)' },
  { re: /getaddrinfo ENOTFOUND ([^\s]+)/i, level: 'fail', msg: m => `DNS fail for "${m[1]}" — wrong service hostname in env? (use db-<type>)` },
  { re: /connect ECONNREFUSED ([^\s:]+):(\d+)/i, level: 'fail', msg: m => `nothing at ${m[1]}:${m[2]} — wrong host/port in env, or that service is down` },
  { re: /EADDRINUSE[^:]*:?(\d+)?/i, level: 'fail', msg: m => `port ${m[1] || '?'} busy inside the container — app hardcodes a port?` },
  { re: /Cannot find module ([^\s'"]+)/, level: 'fail', msg: m => `missing node module ${m[1]} — incomplete install, rebuild the app` },
  { re: /JavaScript heap out of memory|OOMKilled/i, level: 'fail', msg: () => 'out of memory — raise box swap or container limits' },
  { re: /^(?!.*(password|token|secret|key)).*error:/gim, level: 'warn', msg: () => 'error lines present in recent logs', count: true }
];
app.get('/api/apps/:id/doctor', async (req, res) => {
  const meta = load().apps.find(a => a.id === req.params.id);
  if (!meta) return res.status(404).json({ error: 'unknown app' });
  const dir = appDir(APPS_DIR, meta.id);
  const checks = [];
  const containers = await appContainers(meta.id);
  const appC = containers.find(c => /^(app|web|server)$/i.test(c.service)) || containers[0];
  checks.push({
    name: 'containers',
    status: containers.length && containers.every(c => /^running/i.test(c.state || '')) ? 'ok' : 'fail',
    detail: containers.length ? containers.map(c => `${c.service}: ${c.state || '?'}${c.status ? ` (${c.status})` : ''}`).join(', ') : 'no containers'
  });
  if (appC && appC.id) {
    try {
      const insp = await sh(`docker inspect ${appC.id} --format '{{.State.OOMKilled}} {{.State.ExitCode}} {{.RestartCount}}'`, dir);
      const [oom, code, restarts] = insp.trim().split(/\s+/);
      checks.push({
        name: 'oom/crashloop',
        status: oom === 'true' || (parseInt(code, 10) !== 0 && parseInt(restarts, 10) > 3) ? 'fail' : 'ok',
        detail: `OOMKilled=${oom} exit=${code} restarts=${restarts}`
      });
    } catch (e) { checks.push({ name: 'oom/crashloop', status: 'warn', detail: 'inspect failed' }); }
  }
  // landing probe (same candidates as autodetect)
  try {
    const env = parseEnvFile(path.join(dir, '.env'));
    const cport = parseInt(env.PORT, 10) || 3000;
    const net = `${meta.id}_default`;
    const probed = [];
    const probePath = p => execSync(`docker run --rm --network ${net} curlimages/curl:latest -s -o /dev/null -w "%{http_code}" --max-time 5 http://app:${cport}${p}`, { timeout: 15000 }).toString().trim();
    let soft404 = false;
    try {
      const code = probePath(routes.PROBE_SENTINEL);
      soft404 = routes.liveStatus(code);
      probed.push(`${routes.PROBE_SENTINEL}→${code}`);
    } catch { probed.push(`${routes.PROBE_SENTINEL}→unreachable`); }
    const candidates = soft404 ? ['/'] : routes.PROBE_PATHS;
    for (const p of candidates) {
      try {
        const code = probePath(p);
        probed.push(`${p}→${code}`);
        if (routes.liveStatus(code)) {
          const detail = soft404
            ? `catch-all/soft-404 detected; safe default: / (${code})`
            : `first live route: ${p} (${code})${meta.homePath && meta.homePath !== p ? ` - open path set to ${meta.homePath}` : ''}`;
          checks.push({ name: 'landing', status: 'ok', detail });
          break;
        }
      } catch { probed.push(`${p}→unreachable`); }
    }
    if (!checks.some(c => c.name === 'landing')) {
      checks.push({ name: 'landing', status: 'fail', detail: 'no route answers; probed: ' + probed.join(' ') });
    }
  } catch (e) { checks.push({ name: 'landing', status: 'warn', detail: 'probe failed: ' + e.message }); }
  // log signature scan (app service only, secretes filtered by rules avoiding creds)
  try {
    const logs = await sh(`${COMPOSE_BIN} logs --tail=200 app`, dir).catch(() => '');
    const hits = [];
    for (const rule of LOG_RULES) {
      if (rule.count) {
        const n = (logs.match(rule.re) || []).length;
        if (n > 3) hits.push({ level: rule.level, msg: `${n} error lines in recent logs - open Logs tab` });
        continue;
      }
      const m = logs.match(rule.re);
      if (m) hits.push({ level: rule.level, msg: rule.msg(m) });
    }
    checks.push(hits.length
      ? { name: 'logs', status: hits.some(h => h.level === 'fail') ? 'fail' : 'warn', detail: hits.map(h => h.msg).join(' | ') }
      : { name: 'logs', status: 'ok', detail: 'no known failure signatures in last 200 lines' });
  } catch (e) { checks.push({ name: 'logs', status: 'warn', detail: 'could not read logs' }); }
  // env-needs: vars the repo code reads but .env doesn't set (read-only scan).
  // Empty counts as unset: a referenced key with no value can't function.
  try {
    const need = scanEnvNeeds(dir);
    const valOf = new Map(readEnvVars(path.join(dir, '.env')).map(v => [v.key, v.value]));
    const missing = need.filter(k => !valOf.has(k));
    const empty = need.filter(k => valOf.has(k) && !String(valOf.get(k)).trim());
    const unset = [...missing, ...empty];
    if (!need.length) checks.push({ name: 'env-needs', status: 'ok', detail: 'no env references found in code' });
    else if (!unset.length) checks.push({ name: 'env-needs', status: 'ok', detail: `all ${need.length} code-referenced var${need.length === 1 ? '' : 's'} set` });
    else checks.push({ name: 'env-needs', status: 'fail', detail: `code reads ${unset.length} unset var${unset.length === 1 ? '' : 's'}: ${unset.slice(0, 12).join(', ')}${unset.length > 12 ? '…' : ''}${empty.length ? ` (${empty.length} present but empty)` : ''} — add via environment card` });
  } catch (e) { checks.push({ name: 'env-needs', status: 'warn', detail: 'scan failed' }); }
  const fails = checks.filter(c => c.status === 'fail').length;
  const warns = checks.filter(c => c.status === 'warn').length;
  res.json({ app: meta.id, checks, summary: fails ? `${fails} fail${warns ? `, ${warns} warn` : ''}` : (warns ? `${warns} warn` : 'all clear') });
});

app.post('/api/apps/:id/deploy', async (req, res) => {
  try {
    const only = Array.isArray(req.body && req.body.services)
      ? [...new Set(req.body.services.filter(s => /^[A-Za-z0-9_-]{1,32}$/.test(s || '')))]
      : [];
    const source = ['manual', 'local', 'local-push'].includes(req.body && req.body.source) ? req.body.source : 'manual';
    const skipSync = (req.body && req.body.source) === 'local';
    const pushedSha = /^[0-9a-f]{40}$/.test((req.body && req.body.sha) || '') ? req.body.sha : null;
    const pushedBranch = /^[A-Za-z0-9._/-]{1,64}$/.test((req.body && req.body.branch) || '') ? req.body.branch : null;
    await deploy(req.params.id, { only, source, skipSync, pushedSha, pushedBranch });
    res.json({ ok: true, redeployed: true, services: only.length ? only : undefined });
  }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// GitHub handshake: one OAuth connect, then every repo works with auto-webhooks.
app.get('/api/github/status', (req, res) => {
  const logins = gh.getLogins();
  const d = gh.getAuth();
  res.json(logins.length
    ? { connected: true, logins, default: d && d.login, oauth: !!(process.env.GITHUB_CLIENT_ID && process.env.PANEL_URL) }
    : { connected: false, logins: [], oauth: !!(process.env.GITHUB_CLIENT_ID && process.env.PANEL_URL) });
});
app.get('/api/github/login', (req, res) => {
  const { GITHUB_CLIENT_ID, PANEL_URL } = process.env;
  if (!GITHUB_CLIENT_ID || !PANEL_URL) {
    return res.status(500).send('GitHub not configured: set GITHUB_CLIENT_ID (+SECRET) and PANEL_URL in backend .env - see .env.example');
  }
  const cb = `${PANEL_URL.replace(/\/$/, '')}/api/github/callback`;
  const url = `https://github.com/login/oauth/authorize?client_id=${encodeURIComponent(GITHUB_CLIENT_ID)}` +
    `&redirect_uri=${encodeURIComponent(cb)}&scope=${encodeURIComponent('repo admin:repo_hook')}`;
  res.redirect(url);
});
app.get('/api/github/callback', async (req, res) => {
  const { GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET, PANEL_URL } = process.env;
  const base = (PANEL_URL || '').replace(/\/$/, '');
  try {
    const r = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: GITHUB_CLIENT_ID, client_secret: GITHUB_CLIENT_SECRET, code: req.query.code })
    });
    const tok = await r.json();
    if (tok.error || !tok.access_token) throw new Error((tok.error_description || tok.error || 'oauth exchange failed'));
    const me = await fetch('https://api.github.com/user', {
      headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${tok.access_token}` }
    }).then(x => x.json());
    gh.saveAuth({ access_token: tok.access_token, login: me.login, scope: tok.scope, createdAt: new Date().toISOString() });
    res.redirect(base + '/?github=connected');
  } catch (e) { res.status(500).send('github connect failed: ' + e.message); }
});
app.post('/api/github/disconnect', (req, res) => { gh.clearAuth(req.body && req.body.login); res.json({ ok: true }); });
// Preview a pasted token WITHOUT saving it: validates + lists repos for the
// create flow, where every build brings a fresh, site-owned connection.
app.post('/api/github/preview', async (req, res) => {
  try {
    const token = String((req.body && req.body.token) || '').trim();
    if (!token) return res.status(400).json({ error: 'empty token' });
    const me = await gh.apiWith(token, '/user');
    const repos = await gh.apiWith(token, '/user/repos?per_page=100&sort=updated');
    res.json({ login: me.login, repos: repos.map(r => ({ full_name: r.full_name, private: r.private, default_branch: r.default_branch, https: r.clone_url })) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/github/token', async (req, res) => {
  // LAN path: no OAuth App / callback / public URL needed. Fine-grained PAT with
  // Contents read-only + Webhooks read+write (+Metadata read-only) per account.
  try {
    const token = String((req.body && req.body.token) || '').trim();
    if (!token) return res.status(400).json({ error: 'empty token' });
    const me = await fetch('https://api.github.com/user', {
      headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}` }
    }).then(async r => {
      if (!r.ok) throw new Error(`github rejected token (${r.status}) - check scopes and expiry`);
      return r.json();
    });
    gh.saveAuth({ access_token: token, login: me.login });
    res.json({ ok: true, login: me.login });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// Stack detection. Token-first, pool-NEVER: the create flow always carries its
// own fresh token, so a revoked pool credential can never poison detection.
// Public repos need no token at all: unauthenticated reads involve no account.
async function detectRepo(repo, { login, token, branch } = {}) {
  const m = String(repo || '').match(/^([^/]+)\/([^/]+?)(\.git)?$/);
  if (!m) throw new Error('repo must be owner/name');
  const get = token
    ? (p) => gh.apiWith(token, p)
    : login
      ? (p) => gh.apiAs(login, p)
      : (p) => gh.apiPublic(p);
  const { repoSource } = require('./lib/repo-source');
  const source = await repoSource(get, `${m[1]}/${m[2]}`, branch);
  const ref = encodeURIComponent(source.branch);
  const t = await get(`/repos/${m[1]}/${m[2]}/git/trees/${ref}?recursive=1`)
    .catch(e => { throw new Error('cannot read repo (private? paste a token): ' + e.message); });
  const tree = (t.tree || []).filter(e => e.type === 'blob').map(e => e.path);
  let pkg = null;
  const pkgPath = tree.filter(p => /(^|\/)package\.json$/.test(p)).sort((a, b) => a.length - b.length)[0];
  if (pkgPath) {
    try {
      const blob = await get(`/repos/${m[1]}/${m[2]}/contents/${pkgPath}?ref=${ref}`);
      if (blob && blob.content) pkg = JSON.parse(Buffer.from(blob.content, 'base64').toString('utf8'));
    } catch {}
  }
  const { decideType, expandWorkspaces, matchWorkspaces, findBackends, findFrontends, sqlDatabaseHints, prismaDatabaseHints, databaseConfigHints } = require('./lib/detect');
  const out = decideType(tree, pkg);
  Object.assign(out, source);
  out.repositorySize = quotas.repositorySize(t);
  // monorepo sub-apps, tool-agnostic: vite heuristic + workspace manifests
  // (npm workspaces, pnpm-workspace.yaml, lerna.json, turbo/nx conventions)
  out.frontends = [];
  const readText = async (p) => {
    try {
      const b = await get(`/repos/${m[1]}/${m[2]}/contents/${p}?ref=${ref}`);
      return b && b.content ? Buffer.from(b.content, 'base64').toString('utf8') : null;
    } catch { return null; }
  };
  const buildFiles = {};
  await Promise.all(['Gemfile', 'Gemfile.lock', '_config.yml', '.nvmrc', '.node-version', '.ruby-version'].filter(p => tree.includes(p)).map(async p => { buildFiles[p] = await readText(p); }));
  out.buildProfile = buildProfile(tree, pkgPath === 'package.json' ? pkg : null, buildFiles);
  if (out.buildProfile.kind === 'jekyll') {
    out.type = 'static'; out.detected = 'jekyll'; out.dbs = [];
    out.reason = 'Jekyll static site - build with Ruby/Node, serve with nginx';
  }
  for (const p of tree) {
    const fm = p.match(/^(.+)\/package\.json$/);
    if (fm && fm[1].split('/').length <= 2 &&
        (tree.includes(`${fm[1]}/vite.config.js`) || tree.includes(`${fm[1]}/vite.config.ts`) || tree.includes(`${fm[1]}/vite.config.mjs`))) {
      if (!out.frontends.includes(fm[1])) out.frontends.push(fm[1]);
    }
  }
  const patterns = expandWorkspaces(tree, pkgPath === 'package.json' ? pkg : null);
  if (tree.includes('pnpm-workspace.yaml')) {
    const y = await readText('pnpm-workspace.yaml');
    if (y) for (const line of y.split('\n')) {
      const mm = line.match(/^\s*-\s*['"]?([^'"]+?)['"]?\s*$/);
      if (mm && !mm[1].startsWith('!')) patterns.push(mm[1]);
    }
  }
  if (tree.includes('lerna.json')) {
    try {
      const l = JSON.parse(await readText('lerna.json'));
      if (l && Array.isArray(l.packages)) patterns.push(...l.packages);
    } catch {}
  }
  if (!patterns.length && tree.some(p => /^(turbo\.json|nx\.json)$/.test(p))) {
    patterns.push('apps/*', 'packages/*');
  }
  for (const d of matchWorkspaces(tree, patterns)) {
    if (!out.frontends.includes(d)) out.frontends.push(d);
  }
  // backend homes: subdirs with runnable package.json that aren't frontends.
  // Frontend markers beyond vite (CRA layout, Angular/Next/Nuxt/Vue configs,
  // UI deps + build script) classify first so they never pose as backends.
  out.backends = [];
  const pkgs = {};
  try {
    // tree markers need no package reads - classify before the capped fetch so
    // CRA/Angular-style dirs are already excluded from pkgDirs below.
    for (const f of findFrontends(tree)) if (!out.frontends.includes(f)) out.frontends.push(f);
    const pkgDirs = [...new Set(tree.filter(p => /(^|\/)package\.json$/.test(p))
      .map(p => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : ''))
      .filter(d => d && d.split('/').length <= 2 && !out.frontends.includes(d)))].slice(0, 8);
    for (const d of pkgDirs) {
      try {
        const blob = await get(`/repos/${m[1]}/${m[2]}/contents/${d}/package.json?ref=${ref}`);
        if (blob && blob.content) pkgs[d] = JSON.parse(Buffer.from(blob.content, 'base64').toString('utf8'));
      } catch { pkgs[d] = null; }
    }
    // package-based pass (UI deps + build script) with the fetched manifests,
    // then backends skip everything classified as a frontend.
    for (const f of findFrontends(tree, pkgs)) if (!out.frontends.includes(f)) out.frontends.push(f);
    out.backends = findBackends(tree, pkgs, out.frontends);
    for (const pkg_ of Object.values(pkgs).filter(Boolean)) {
      for (const db of decideType(['package.json'], pkg_).dbs || []) if (!out.dbs.includes(db)) out.dbs.push(db);
    }
  } catch {}
  out.staticFrontends = out.frontends.filter(d => isJekyll(tree.filter(p => p.startsWith(d + '/')).map(p => p.slice(d.length + 1)), pkgs[d]));
  out.frontends = out.frontends.filter(d => !out.staticFrontends.includes(d));
  // Prisma dependencies do not reveal the database engine. Read only the
  // bounded schema files and use their explicit datasource provider instead.
  const prismaCandidates = tree.filter(p => /(^|\/)schema\.prisma$/i.test(p)).slice(0, 4);
  for (const p of prismaCandidates) {
    const text = await readText(p);
    for (const db of prismaDatabaseHints(text)) {
      if (!out.dbs.includes(db)) out.dbs.push(db);
      if (!out.dbReason) out.dbReason = `Prisma datasource in ${p}`;
    }
  }
  // Standard ORM/framework config files can state the engine even when their
  // package dependency is database-neutral. Dynamic env expressions are not
  // inferred; only explicit literal values preselect a service.
  const configCandidates = tree.filter(p => /(^|\/)(?:knexfile\.(?:js|cjs|mjs|ts)|(?:ormconfig|data-source|typeorm\.config)\.(?:json|js|cjs|mjs|ts)|drizzle\.config\.(?:js|cjs|mjs|ts)|(?:config\/config|sequelize\.config)\.(?:json|js|cjs|mjs|ts)|\.env\.(?:example|sample)|config\/database\.php)$/i.test(p)).slice(0, 12);
  for (const p of configCandidates) {
    const text = await readText(p);
    for (const db of databaseConfigHints(p, text)) {
      // SQLite is file-based: no managed service exists to preselect, so say
      // so explicitly instead of leaving the database pills silent.
      if (db === 'sqlite') {
        if (!out.dbNote) out.dbNote = `SQLite detected in ${p}. Persist the database file, or select a managed SQL database and update DB_CONNECTION.`;
        continue;
      }
      if (db === 'mariadb') out.dbs = (out.dbs || []).filter(item => item !== 'mysql');
      if (!out.dbs.includes(db)) out.dbs.push(db);
      if (!out.dbReason) out.dbReason = `Explicit database setting in ${p}`;
    }
  }
  // Strong SQL dialect signatures provide a bounded fallback. Prefer MariaDB
  // over a generic mysql/mysql2 dependency when a schema says MariaDB.
  const sqlCandidates = tree.filter(p => /(^|\/)(?:(?:baseline|schema|dump)[^/]*\.sql|(?:migrations?|sql)\/[^/]+\.sql)$/i.test(p)).slice(0, 6);
  for (const p of sqlCandidates) {
    const text = await readText(p);
    const hinted = sqlDatabaseHints(text);
    if (!hinted.length) continue;
    for (const db of hinted) {
      if (db === 'mariadb') out.dbs = (out.dbs || []).filter(item => item !== 'mysql');
      if (!out.dbs.includes(db)) out.dbs.push(db);
    }
    if (!out.dbReason) out.dbReason = `Database dialect marker in ${p}`;
  }
  return out;
}
app.get('/api/github/detect', async (req, res) => {
  try { res.json({ ...(await detectRepo(req.query.repo, { login: req.query.login, branch: req.query.branch })), via: 'account' }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/github/detect', async (req, res) => {
  try { res.json({ ...(await detectRepo(req.body.repo, { login: req.body.login, token: req.body.token, branch: req.body.branch })), via: 'token' }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/github/repos', async (req, res) => {
  // aggregate every connected account so 10 sites can live on 10 different githubs
  try {
    const logins = gh.getLogins();
    if (!logins.length) return res.status(500).json({ error: 'github not connected' });
    const repos = [];
    const errors = [];
    for (const login of logins) {
      try {
        const list = await gh.apiAs(login, '/user/repos?per_page=100&sort=updated');
        for (const r of list) repos.push({ account: login, full_name: r.full_name, private: r.private, default_branch: r.default_branch, https: r.clone_url });
      } catch (e) { errors.push({ account: login, error: e.message }); }
    }
    res.json({ repos, errors });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/github/link', async (req, res) => {
  // { appId, repo: "owner/name", login? } -> connect the source. Automatic
  // deployment remains off until the site owner explicitly enables it.
  try {
    const { appId, repo, login } = req.body;
    const parts = String(repo || '').split('/');
    if (parts.length !== 2) return res.status(400).json({ error: 'repo must be owner/name' });
    const db_ = load();
    const meta = db_.apps.find(a => a.id === appId);
    if (!meta) return res.status(404).json({ error: 'unknown app' });
    const info = await gh.apiAs(login || undefined, `/repos/${parts[0]}/${parts[1]}`);
    const acct = gh.getAuth(login);
    let head = null;
    try {
      const c = await gh.apiAs(login || undefined, `/repos/${parts[0]}/${parts[1]}/commits/${encodeURIComponent(info.default_branch)}`);
      head = c && c.sha;
    } catch {}
    meta.repoUrl = info.clone_url;
    meta.github = { repo: info.full_name, branch: info.default_branch, login: acct && acct.login, sha: head, pollMinutes: 0, enabled: false };
    save(db_);
    res.json({ ok: true, repoUrl: meta.repoUrl, automation: false, webhook: 'disabled until enabled on the site deploy page' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// Push-to-deploy: bare repo per app on the host. The hook only notifies the
// panel; deploy checks out an isolated worktree and never mutates code/.
app.post('/api/apps/:id/git-init', (req, res) => {
  try {
    const id = req.params.id;
    const dir = appDir(APPS_DIR, id);
    if (!fs.existsSync(path.join(dir, 'docker-compose.yml'))) return res.status(404).json({ error: 'unknown app' });
    const repo = path.join(dir, 'repo.git');
    if (!fs.existsSync(path.join(repo, 'HEAD'))) execFileSync('git', ['init', '--bare', repo], { stdio: 'ignore' });
    const port = process.env.PORT || PORT;
    // Hook only pings + triggers (never touches files): the pushed sha/branch
    // ride the deploy POST, and deploy builds an isolated checkout from repo.git.
    const hook = `#!/bin/sh\n# minipass push-to-deploy: notify + trigger rebuild (deploy owns the tree)\nLOG="${path.join(repo, 'push.log')}"\n{\necho "=== $(date -u +%FT%TZ) push received ==="\nBRANCH=""\nNEWREV=""\nwhile read oldrev newrev ref; do\n  case "$ref" in refs/heads/*) BRANCH="\${ref#refs/heads/}"; NEWREV="$newrev";; esac\ndone\nBRANCH="\${BRANCH:-main}"\necho "pushed $BRANCH $NEWREV"\ncurl -s -m 5 -X POST -H 'Content-Type: application/json' -d '{"phase":"received"}' http://localhost:${port}/api/apps/${id}/git-push-event >> "$LOG" 2>&1\nnohup curl -s -X POST -H 'Content-Type: application/json' -d "{\\"source\\":\\"local-push\\",\\"sha\\":\\"$NEWREV\\",\\"branch\\":\\"$BRANCH\\"}" http://localhost:${port}/api/apps/${id}/deploy >> "$LOG" 2>&1 &\n} >> "$LOG" 2>&1\n`;
    fs.writeFileSync(path.join(repo, 'hooks', 'post-receive'), hook);
    fs.chmodSync(path.join(repo, 'hooks', 'post-receive'), 0o755);
    const db_ = load();
    const meta = db_.apps.find(a => a.id === id);
    if (meta) { meta.localGit = true; save(db_); }
    res.json({ ok: true, remote: `ssh://root@<server>:${path.join(dir, 'repo.git')}` });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// Disable local push-to-deploy: drop the hook, keep the repo (pushes land but
// don't rebuild). Re-enable rewrites the hook.
// Push receipt from the local-git hook (fires before the queued deploy starts).
// Fixed phase string only - nothing reaches a shell.
app.post('/api/apps/:id/git-push-event', (req, res) => {
  const meta = load().apps.find(a => a.id === req.params.id);
  if (!meta) return res.status(404).json({ error: 'unknown app' });
  if (!req.body || req.body.phase !== 'received') return res.status(400).json({ error: 'bad phase' });
  pushEvents.set(req.params.id, { phase: 'received', at: Date.now() });
  res.json({ ok: true });
});
app.delete('/api/apps/:id/git-init', (req, res) => {
  try {
    const dir = appDir(APPS_DIR, req.params.id);
    try { fs.rmSync(path.join(dir, 'repo.git', 'hooks', 'post-receive'), { force: true }); } catch {}
    const db_ = load();
    const meta = db_.apps.find(a => a.id === req.params.id);
    if (!meta) return res.status(404).json({ error: 'unknown app' });
    meta.localGit = false;
    save(db_);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// Services: one folder runs N of them (api + web + ...). Add/remove/toggle,
// compose regenerates (enabled only, `up --remove-orphans` cleans the rest).
function hostPortsInUse() {
  const used = new Set();
  try {
    for (const a of load().apps) {
      if (a.hostPort) used.add(a.hostPort);
      for (const s of (a.services || [])) if (s.hostPort) used.add(s.hostPort);
      for (const t of Object.values(a.dbTools || {})) if (t && t.port) used.add(t.port);
    }
  } catch {}
  return used;
}
function serviceCandidate(meta, dir, input, requireSubdir = false) {
  const name = String((input && input.name) || '').trim().toLowerCase();
  const requestedType = String((input && input.type) || 'auto').trim();
  const rawSubdir = String((input && input.subdir) || '').trim().replace(/\\/g, '/');
  const subdir = rawSubdir.replace(/^\/+|\/+$/g, '');
  if (!svc.validSvcName(name) || name === 'app') return { error: 'use a unique name with lowercase letters, numbers, or dashes' };
  if (!['auto', 'static', 'react', 'node', 'php'].includes(requestedType)) return { error: 'choose a valid service type' };
  if (requireSubdir && !subdir) return { error: 'enter the existing repository subfolder' };
  if (subdir && (subdir.split('/').includes('..') || !/^[A-Za-z0-9._/-]+$/.test(subdir))) return { error: 'subfolder contains unsupported characters' };
  const ctxDir = path.resolve(dir, 'code', subdir);
  const codeRoot = path.resolve(dir, 'code');
  if (ctxDir !== codeRoot && !ctxDir.startsWith(codeRoot + path.sep)) return { error: 'subfolder must stay inside the repository' };
  try { if (!fs.statSync(ctxDir).isDirectory()) return { error: `subfolder '${subdir}' is not a directory` }; }
  catch { return { error: `subfolder '${subdir}' does not exist in the repository` }; }
  const services = svc.fullServices(meta, dir);
  if (services.some(s => s.name === name)) return { error: `service name '${name}' is already used` };
  const folderOwner = services.find(s => (s.subdir || '') === subdir);
  if (folderOwner) return { error: `folder '${subdir || '.'}' already runs as ${folderOwner.name}` };
  const detected = svc.detectServiceType(ctxDir);
  const type = detected.type || (requestedType === 'auto' ? null : requestedType);
  if (!type) return { error: `could not detect a runnable service: ${detected.reason}` };
  return { name, requestedType, subdir, ctxDir, services, detected, type };
}
app.get('/api/apps/:id/services', (req, res) => {
  const meta = load().apps.find(a => a.id === req.params.id);
  if (!meta) return res.status(404).json({ error: 'unknown app' });
  const dir = appDir(APPS_DIR, meta.id);
  const buildProfiles = {};
  for (const s of svc.fullServices(meta, dir)) {
    try { buildProfiles[s.name] = { ...localBuildProfile(path.join(dir, 'code', s.subdir || ''), TEMPLATES_DIR), modernize: !!((s.buildOptions || (s.name === 'app' && meta.buildOptions) || {}).modernize) }; }
    catch (e) { buildProfiles[s.name] = { kind: null, warnings: [e.message] }; }
  }
  res.json({ services: publicServices(meta, dir), buildProfiles, dirty: meta.dirty || null, homePath: pubApp(meta).homePath, homePathManual: !!meta.homePathManual });
});
app.post('/api/apps/:id/services/:name/build-profile', async (req, res) => {
  try {
    if (deployQueues.has(req.params.id) || deployLocks.has(req.params.id)) return res.status(409).json({ error: 'wait for the current deployment to finish' });
    const db_ = load();
    const meta = db_.apps.find(a => a.id === req.params.id);
    if (!meta) return res.status(404).json({ error: 'unknown app' });
    const dir = appDir(APPS_DIR, meta.id);
    const services = svc.fullServices(meta, dir);
    const service = services.find(s => s.name === req.params.name);
    if (!service) return res.status(404).json({ error: 'unknown service' });
    const ctx = path.join(dir, 'code', service.subdir || '');
    const profile = localBuildProfile(ctx, TEMPLATES_DIR);
    if (profile.kind !== 'jekyll') return res.status(400).json({ error: 'no Jekyll build detected in this service folder' });
    if (profile.customDockerfile) return res.status(409).json({ error: 'custom Dockerfile preserved - configure the Jekyll build in that file instead' });
    if (profile.blockedReason) return res.status(400).json({ error: profile.blockedReason });
    const modernize = req.body.modernize === true;
    if (profile.needsModernization && !modernize) return res.status(409).json({ error: 'enable build-only modernization for these legacy dependencies' });
    ensureDockerfile(ctx, 'static', TEMPLATES_DIR, { modernize });
    service.type = 'static'; service.port = 80; service.homePath = ''; service.openPaths = []; service.homePathManual = false;
    service.buildOptions = { modernize };
    meta.services = services;
    if (service.name === 'app') {
      meta.type = 'static'; meta.buildOptions = { modernize }; meta.homePath = ''; meta.homePathManual = false; meta.openPaths = [];
      envSetManaged(dir, { APP_TYPE: 'static', PORT: '80' });
    }
    svc.renderProject({ dir, templatesDir: TEMPLATES_DIR, meta });
    save(db_);
    await markDirty(meta.id, 'Jekyll static build configured');
    res.json({ ok: true, saved: true, pending: true, type: 'static', modernize });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/apps/:id/services/check', (req, res) => {
  const meta = load().apps.find(a => a.id === req.params.id);
  if (!meta) return res.status(404).json({ error: 'unknown app' });
  const check = serviceCandidate(meta, appDir(APPS_DIR, meta.id), req.query, true);
  if (check.error) return res.status(400).json({ ok: false, error: check.error });
  const profile = localBuildProfile(check.ctxDir, TEMPLATES_DIR);
  if (profile.blockedReason && !profile.customDockerfile) return res.status(400).json({ ok: false, error: profile.blockedReason });
  res.json({
    ok: true,
    name: check.name,
    subdir: check.subdir,
    type: check.type,
    detected: check.detected.detected,
    reason: check.detected.reason,
    needsDockerfile: needsDockerfileOptIn(check.ctxDir, check.type),
    buildProfile: profile
  });
});
// One-click standard Dockerfile: the validator refuses to guess for node
// (no safe default), so the operator explicitly opts into the type template
// here instead. Box-local untracked file - commit it to the repo so fresh
// clones keep it. The file editor never overwrites Dockerfiles; this route
// is the sanctioned exception.
const STANDARD_DOCKER_TYPES = ['node', 'react', 'php', 'static'];
app.post('/api/apps/:id/services/dockerfile', async (req, res) => {
  try {
    const db_ = load();
    const meta = db_.apps.find(a => a.id === req.params.id);
    if (!meta) return res.status(404).json({ error: 'unknown app' });
    const type = String((req.body && req.body.type) || '').trim();
    if (!STANDARD_DOCKER_TYPES.includes(type)) return res.status(400).json({ error: 'choose node, react, php, or static' });
    const rawSub = String((req.body && req.body.subdir) || '').trim().replace(/\\/g, '/');
    const subdir = rawSub.replace(/^\/+|\/+$/g, '');
    if (subdir && (subdir.split('/').includes('..') || !/^[A-Za-z0-9._/-]+$/.test(subdir))) return res.status(400).json({ error: 'bad subfolder' });
    const dir = appDir(APPS_DIR, meta.id);
    const ctxDir = path.resolve(dir, 'code', subdir);
    const codeRoot = path.resolve(dir, 'code');
    if (ctxDir !== codeRoot && !ctxDir.startsWith(codeRoot + path.sep)) return res.status(400).json({ error: 'subfolder must stay inside the repository' });
    try { if (!fs.statSync(ctxDir).isDirectory()) return res.status(400).json({ error: 'subfolder is not a directory in the repository' }); }
    catch { return res.status(400).json({ error: 'subfolder does not exist in the repository' }); }
    try {
      if (fs.readdirSync(ctxDir).some(f => /^dockerfile$/i.test(f)))
        return res.status(409).json({ error: 'a Dockerfile is already there - edit it instead' });
    } catch (e) { return res.status(500).json({ error: e.message }); }
    const tpl = path.join(TEMPLATES_DIR, type, 'Dockerfile');
    try {
      if (type === 'static' && readBuildProfile(ctxDir).kind === 'jekyll') ensureDockerfile(ctxDir, type, TEMPLATES_DIR, { modernize: req.body.modernizeBuild === true });
      else fs.copyFileSync(tpl, path.join(ctxDir, 'Dockerfile'));
    }
    catch (e) { return res.status(500).json({ error: 'standard template missing: ' + e.message }); }
    const seeded = ['Dockerfile'];
    if ((type === 'react' || type === 'static') && !fs.existsSync(path.join(ctxDir, 'nginx.conf'))) {
      try {
        fs.copyFileSync(path.join(TEMPLATES_DIR, type, 'nginx.conf'), path.join(ctxDir, 'nginx.conf'));
        seeded.push('nginx.conf');
      } catch {}
    }
    await markDirty(meta.id, 'standard Dockerfile added to ' + (subdir || 'root'));
    res.json({ ok: true, seeded, note: 'box-local file - commit it to the repo so fresh clones and rebuilds keep it' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// Suggested fixes for the latest failed deploy. Detection is automatic; every
// fix needs an explicit POST (previewed in the UI) and touches box files only.
function remediationContext(dir, subdir) {
  const root = fs.realpathSync(path.join(dir, 'code'));
  const context = fs.realpathSync(path.resolve(dir, 'code', subdir || ''));
  if (context !== root && !context.startsWith(root + path.sep)) throw lifecycleError('build folder must stay inside the repository', 400);
  return context;
}
function remediationSuggestions(meta, dir) {
  const services = svc.fullServices(meta || {}, dir);
  const protectedCards = [...importProtection.cards(dir, services), ...dockerfileProtection.cards(dir, services)];
  const out = [];
  const last = meta.lastDeploy && meta.lastDeploy.status !== 'ok' ? String(meta.lastDeploy.error || '') : '';
  if (!last) return protectedCards;
  // The deploy record truncates; the persisted log tail keeps the evidence
  // (tsc error lines, missing-module paths) suggestions match against.
  let evidence = last;
  try {
    const log = fs.readFileSync(path.join(dir, 'deploy.log'), 'utf8');
    evidence = log.split('\n').slice(-300).join('\n') + '\n' + last;
  } catch {}
  for (const s of svc.fullServices(meta || {}, dir).filter(s => s.enabled !== false)) {
    if (/^db(-|$)/.test(s.name || '')) continue;
    if (meta.lastDeploy.service && meta.lastDeploy.service !== s.name) continue;
    const ctxDir = remediationContext(dir, s.subdir);
    let template = null;
    try { template = fs.readFileSync(path.join(TEMPLATES_DIR, s.type, 'Dockerfile'), 'utf8'); } catch {}
    for (const suggestion of remediate.suggest(ctxDir, evidence, template, last)) {
      out.push({ service: s.name, subdir: s.subdir || '', ...suggestion });
    }
  }
  return [...out, ...protectedCards];
}
app.get('/api/apps/:id/remediations', (req, res) => {
  try {
    const meta = load().apps.find(a => a.id === req.params.id);
    if (!meta) return res.status(404).json({ error: 'unknown app' });
    res.json(remediationSuggestions(meta, appDir(APPS_DIR, meta.id)));
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/apps/:id/remediate', async (req, res) => {
  try {
    const key = String((req.body && req.body.key) || '');
    if (!remediate.VALID_KEY.test(key)) return res.status(400).json({ error: 'unknown remediation' });
    await siteLifecycle(req.params.id, async () => {
      const meta = load().apps.find(a => a.id === req.params.id);
      if (!meta) throw lifecycleError('unknown app', 404);
      const dir = appDir(APPS_DIR, meta.id);
      // Recompute server-side; the client preview is never trusted.
      const requestedService = String((req.body && req.body.service) || '');
      const matches = remediationSuggestions(meta, dir).filter(s => s.key === key && (!requestedService || s.service === requestedService));
      if (matches.length !== 1) throw lifecycleError('remediation no longer applies or is ambiguous - refresh suggestions', 409);
      const match = matches[0];
      if (match.revision && match.revision !== (req.body && req.body.revision)) throw lifecycleError('Files changed - refresh the recovery preview before applying', 409);
      const ctxDir = remediationContext(dir, match.subdir);
      if (!/^[A-Za-z0-9_-]{1,32}$/.test(match.service || '')) throw lifecycleError('invalid recovery service name', 400);
      const result = match.kind === 'dockerfile-fix'
        ? remediate.apply(ctxDir, match, { backupRoot: path.join(dir, '.remediation-backups', match.service),
          beforeApply: approval => dockerfileProtection.save(dir, match.service, match.subdir, approval) })
        : remediate.apply(ctxDir, match, { backupRoot: path.join(dir, '.remediation-backups', match.service),
          beforeApply: approval => importProtection.save(dir, match.service, match.subdir, approval) });
      if (match.kind === 'import-repair' || match.kind === 'dockerfile-fix') result.protected = true;
      if (result.backup) result.backup = path.relative(dir, result.backup).split(path.sep).join('/');
      if (match.kind === 'import-repair') {
        const fresh = load();
        const stored = fresh.apps.find(a => a.id === meta.id);
        if (!stored) throw lifecycleError('site metadata disappeared after saving the import correction', 409);
        stored.pendingImportBuilds = [...new Set([...(stored.pendingImportBuilds || []), match.service])];
        save(fresh);
      }
      try { panelLog.logEvent({ level: 'warn', area: 'remediate', site: meta.id, message: `applied ${key}: ${result.applied.join(', ')}` }); } catch {}
      await markDirty(meta.id, 'remediation applied: ' + key);
      res.json({ ok: true, saved: true, ...result, note: result.protected ? (match.kind === 'dockerfile-fix' ? 'approved Dockerfile adaptation retained outside Git and revalidated on redeploy; remote repository unchanged' : 'approved import correction retained outside Git and revalidated on redeploy; remote repository unchanged') : 'box-local change - use local rebuild to preserve box edits; commit to the repo to keep it' });
    });
  } catch (e) {
    panelLog.logEvent({ level: 'error', area: 'remediate', site: req.params.id, message: e.message });
    res.status(e.status || 500).json({ error: e.message });
  }
});
app.delete('/api/apps/:id/import-protection', async (req, res) => {
  try {
    await siteLifecycle(req.params.id, async () => {
      const meta = load().apps.find(a => a.id === req.params.id);
      if (!meta) throw lifecycleError('unknown app', 404);
      importProtection.remove(appDir(APPS_DIR, meta.id), req.body.service, req.body.key, req.body.revision);
      panelLog.logEvent({ level: 'warn', area: 'remediate', site: meta.id, message: `removed import protection for '${req.body.service}': ${req.body.key}; current source unchanged` });
      res.json({ ok: true });
    });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});
app.delete('/api/apps/:id/dockerfile-fix', async (req, res) => {
  try {
    await siteLifecycle(req.params.id, async () => {
      const meta = load().apps.find(a => a.id === req.params.id);
      if (!meta) throw lifecycleError('unknown app', 404);
      dockerfileProtection.remove(appDir(APPS_DIR, meta.id), req.body.service, req.body.key, req.body.revision);
      panelLog.logEvent({ level: 'warn', area: 'remediate', site: meta.id, message: `removed Dockerfile adaptation protection for '${req.body.service}': ${req.body.key}; current build recipe unchanged` });
      res.json({ ok: true });
    });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});
app.post('/api/apps/:id/services', async (req, res) => {
  try {
    const db_ = load();
    const meta = db_.apps.find(a => a.id === req.params.id);
    if (!meta) return res.status(404).json({ error: 'unknown app' });
    const dir = appDir(APPS_DIR, meta.id);
    const candidate = serviceCandidate(meta, dir, req.body);
    if (candidate.error) return res.status(400).json({ error: candidate.error });
    const { name, requestedType, subdir, detected, type, services } = candidate;
    const { inferPort, TYPE_PORT } = require('./lib/generator');
    const profile = localBuildProfile(path.join(dir, 'code', subdir), TEMPLATES_DIR);
    if (profile.blockedReason && !profile.customDockerfile) return res.status(400).json({ error: profile.blockedReason });
    if (profile.needsModernization && req.body.modernizeBuild !== true) return res.status(409).json({ error: 'enable build-only modernization for this service' });
    const port = type === 'static' && profile.kind === 'jekyll' && !profile.customDockerfile
      ? 80 : inferPort(path.join(dir, 'code', subdir), TYPE_PORT[type] || 3000);
    const used = hostPortsInUse();
    let hostPort = 8000;
    while (used.has(hostPort) && hostPort < 9000) hostPort++;
    used.add(hostPort);
    meta.services = [...services, { name, subdir, type, port, hostPort, enabled: true, buildOptions: { modernize: req.body.modernizeBuild === true } }];
    const out = svc.renderProject({ dir, templatesDir: TEMPLATES_DIR, meta });
    meta.services = out.normalized;
    // A new service contributes its .env/.env.example exactly once. This also
    // resolves frontend/API localhost placeholders now that its role is known.
    try { applyEnvDefaults(meta, dir, req.hostname, req.protocol); }
    catch (e) { console.error(meta.id, 'env defaults snapshot:', e.message); }
    save(db_);
    await markDirty(meta.id, 'service ' + name + ' added');
    const correctedFrom = requestedType !== 'auto' && requestedType !== type ? requestedType : null;
    if (!(req.body && req.body.apply === true)) return res.json({ ok: true, added: name, type, correctedFrom, detected: detected.detected, pending: true });
    try { await deploy(meta.id); } catch (e) { return res.json({ ok: true, added: name, redeployError: e.message }); }
    res.json({ ok: true, added: name, type, correctedFrom, detected: detected.detected, redeployed: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/apps/:id/services/:name', async (req, res) => {
  try {
    const db_ = load();
    const meta = db_.apps.find(a => a.id === req.params.id);
    if (!meta) return res.status(404).json({ error: 'unknown app' });
    const dir = appDir(APPS_DIR, meta.id);
    if (req.params.name === 'app') return res.status(400).json({ error: 'primary service cannot be removed - delete the app instead' });
    let services = svc.fullServices(meta, dir);
    if (services.length <= 1) return res.status(400).json({ error: 'cannot remove the last service' });
    if (!services.some(s => s.name === req.params.name)) return res.status(404).json({ error: 'unknown service' });
    meta.services = services.filter(s => s.name !== req.params.name);
    svc.renderProject({ dir, templatesDir: TEMPLATES_DIR, meta });
    envDeleteKeys(dir, [svc.portEnvName(req.params.name)]);
    save(db_);
    await markDirty(meta.id, 'service ' + req.params.name + ' removed');
    if (!(req.body && req.body.apply === true)) return res.json({ ok: true, removed: true, pending: true });
    try { await deploy(meta.id); } catch (e) { return res.json({ ok: true, removed: true, redeployError: e.message }); }
    res.json({ ok: true, removed: true, redeployed: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/apps/:id/services/:name/enable', async (req, res) => {
  try {
    const db_ = load();
    const meta = db_.apps.find(a => a.id === req.params.id);
    if (!meta) return res.status(404).json({ error: 'unknown app' });
    const dir = appDir(APPS_DIR, meta.id);
    const services = svc.fullServices(meta, dir);
    const target = services.find(s => s.name === req.params.name);
    if (!target) return res.status(404).json({ error: 'unknown service' });
    target.enabled = !(req.body && req.body.enabled === false);
    meta.services = services;
    try {
      svc.renderProject({ dir, templatesDir: TEMPLATES_DIR, meta });
    } catch (e) { return res.status(400).json({ error: e.message }); }
    save(db_);
    await markDirty(meta.id, 'service ' + target.name + (target.enabled ? ' enabled' : ' disabled'));
    if (!(req.body && req.body.apply === true)) return res.json({ ok: true, enabled: target.enabled, pending: true });
    try { await deploy(meta.id); } catch (e) { return res.json({ ok: true, redeployError: e.message }); }
    res.json({ ok: true, enabled: target.enabled, redeployed: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/apps/:id/suggest', async (req, res) => {
  try {
    const meta = load().apps.find(a => a.id === req.params.id);
    if (!meta || !meta.repoUrl) return res.status(400).json({ error: 'no repo linked' });
    const m = String(meta.repoUrl).match(/github\.com[:/]([^/]+)\/([^/]+?)(\.git)?\/?$/i);
    if (!m) return res.json({ suggestions: [] });
    const r = await detectRepo(`${m[1]}/${m[2]}`, { login: meta.github && meta.github.login, token: meta.github && meta.github.token, branch: meta.github && meta.github.branch });
    const have = new Set(svc.fullServices(meta, appDir(APPS_DIR, meta.id)).map(s => s.subdir || ''));
    res.json({
      suggestions: (r.frontends || []).filter(f => !have.has(f)),
      staticSuggestions: (r.staticFrontends || []).filter(f => !have.has(f)),
      backends: (r.backends || []).filter(b => !have.has(b))
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/apps/:id/git-account', (req, res) => {
  try {
    const db_ = load();
    const meta = db_.apps.find(a => a.id === req.params.id);
    if (!meta) return res.status(404).json({ error: 'unknown app' });
    const login = String((req.body && req.body.login) || '').trim();
    if (!meta.github) meta.github = {};
    if (!login) delete meta.github.login;
    else {
      if (!gh.getAuth(login)) return res.status(400).json({ error: 'account not connected: ' + login });
      meta.github.login = login;
    }
    save(db_);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/apps/:id/git-token', async (req, res) => {
  try {
    const token = String((req.body && req.body.token) || '').trim();
    if (!token) return res.status(400).json({ error: 'empty token' });
    await gh.apiWith(token, '/user');
    const db_ = load();
    const meta = db_.apps.find(a => a.id === req.params.id);
    if (!meta) return res.status(404).json({ error: 'unknown app' });
    if (!meta.github) meta.github = {};
    meta.github.token = token;
    save(db_);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/apps/:id/git-token', (req, res) => {
  try {
    const db_ = load();
    const meta = db_.apps.find(a => a.id === req.params.id);
    if (!meta) return res.status(404).json({ error: 'unknown app' });
    if (meta.github) delete meta.github.token;
    save(db_);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// Add a database to an existing app: appends service + volume, merges new env
// vars without touching existing ones (passwords stay valid against kept volumes).
app.post('/api/apps/:id/db', async (req, res) => {
  try {
    const type = normDbs(req.body.type)[0];
    if (!type) return res.status(400).json({ error: 'unknown database type' });
    const db_ = load();
    const meta = db_.apps.find(a => a.id === req.params.id);
    if (!meta) return res.status(404).json({ error: 'unknown app' });
    const dir = appDir(APPS_DIR, meta.id);
    const ymlPath = path.join(dir, 'docker-compose.yml');
    const envPath = path.join(dir, '.env');
    if (!fs.existsSync(ymlPath)) return res.status(400).json({ error: 'app has no compose file' });
    const current = normDbs(meta.db);
    const yml = fs.readFileSync(ymlPath, 'utf8');
    if (current.includes(type) || yml.includes(`db-${type}:`)) {
      return res.status(400).json({ error: type + ' already attached' });
    }
    const safe = meta.id.replace(/[^a-z0-9]/gi, '').toLowerCase() || 'app';
    const b = dbService(type, safe, `db-${type}`, `dbdata-${type}`);
    // splice service in before the volumes: block (or append both at end)
    let out = yml.replace(/\nvolumes:\n/, `\n${b.compose}\nvolumes:\n`);
    if (out === yml) out = yml.replace(/\s*$/, `\n${b.compose}\nvolumes:\n  ${b.vol}:\n`);
    else {
      // Bound quota volumes have nested driver_opts. Append at the END of the
      // top-level volumes section, never between a volume name and its options.
      const start = out.search(/^volumes:[ \t]*\r?$/m);
      const next = out.slice(start).search(/\n(?=[A-Za-z_][A-Za-z0-9_-]*:)/);
      const end = next < 0 ? out.length : start + next + 1;
      out = out.slice(0, end).replace(/\s*$/, '\n') + `  ${b.vol}:\n` + out.slice(end);
    }
    fs.writeFileSync(ymlPath, out);
    if (meta.storageQuota) quotas.bindDatabases(dir);
    // merge env: existing keys win (old passwords keep matching old volumes)
    const have = new Set();
    let envText = '';
    try {
      envText = fs.readFileSync(envPath, 'utf8');
      for (const line of envText.split('\n')) {
        const m = line.match(/^([A-Z_]+)=/);
        if (m) have.add(m[1]);
      }
    } catch {}
    const fresh = b.lines.filter(l => !have.has(l.split('=')[0]));
    fs.writeFileSync(envPath, envText.replace(/\s*$/, '') + '\n' + fresh.join('\n') + '\n');
    try {
      fs.appendFileSync(path.join(dir, '.env.managed'), fresh.map(l => l.split('=')[0]).join('\n') + '\n');
    } catch {}
    meta.db = [...current, type];
    save(db_);
    await markDirty(meta.id, 'db ' + type + ' added');
    if (!(req.body && req.body.apply === true)) return res.json({ ok: true, added: type, pending: true });
    try { await deploy(meta.id); } catch (e) { return res.json({ ok: true, added: type, redeployError: e.message }); }
    res.json({ ok: true, added: type, redeployed: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
const DB_TOOL_TTL_MS = 30 * 60 * 1000;
function clearDbToolLease(meta, type) {
  const saved = meta.dbTools && meta.dbTools[type];
  if (!saved) return false;
  delete saved.startedAt;
  delete saved.expiresAt;
  return true;
}
function stopExpiredDbTools() {
  try {
    const db_ = load();
    const now = Date.now();
    let changed = false;
    for (const meta of db_.apps) {
      for (const [type, saved] of Object.entries(meta.dbTools || {})) {
        const expires = saved && Date.parse(saved.expiresAt || '');
        if (expires && expires <= now) {
          dbTools.stop(meta.id, type);
          clearDbToolLease(meta, type);
          changed = true;
        }
      }
    }
    if (changed) save(db_);
  } catch (e) { console.error('database UI expiry:', e.message); }
}
setInterval(stopExpiredDbTools, 30000).unref();

app.get('/api/apps/:id/databases', async (req, res) => {
  try {
    let db_ = load();
    let meta = db_.apps.find(a => a.id === req.params.id);
    if (!meta) return res.status(404).json({ error: 'unknown app' });
    const containers = await appContainers(meta.id);
    db_ = load();
    meta = db_.apps.find(a => a.id === req.params.id);
    if (!meta) return res.status(404).json({ error: 'unknown app' });
    const dir = appDir(APPS_DIR, meta.id);
    const databases = dbTools.describe(meta, dir, containers);
    let changed = false;
    const now = Date.now();
    for (const database of databases) {
      if (database.toolState !== 'running') continue;
      const saved = meta.dbTools && meta.dbTools[database.type];
      if (!saved) continue;
      const expires = Date.parse(saved.expiresAt || '');
      if (expires && expires <= now) {
        dbTools.stop(meta.id, database.type);
        clearDbToolLease(meta, database.type);
        database.toolState = 'stopped';
        delete database.toolExpiresAt;
        changed = true;
      } else if (!expires) {
        saved.startedAt = new Date(now).toISOString();
        saved.expiresAt = new Date(now + DB_TOOL_TTL_MS).toISOString();
        database.toolExpiresAt = saved.expiresAt;
        changed = true;
      }
    }
    if (changed) save(db_);
    res.json({ databases, toolTtlMinutes: DB_TOOL_TTL_MS / 60000 });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
const dbToolLocks = new Set();
const dbToolPorts = new Set();
app.post('/api/apps/:id/databases/:type/tool', async (req, res) => {
  const lock = `${req.params.id}:${req.params.type}`;
  if (dbToolLocks.has(lock)) return res.status(409).json({ error: 'database tool is already starting' });
  dbToolLocks.add(lock);
  let reservedPort = null;
  try {
    const db_ = load();
    const meta = db_.apps.find(a => a.id === req.params.id);
    if (!meta) return res.status(404).json({ error: 'unknown app' });
    const type = req.params.type;
    if (!dbTools.TOOLS[type] || !normDbs(meta.db).includes(type)) return res.status(400).json({ error: 'database is not attached to this site' });
    const dir = appDir(APPS_DIR, meta.id);
    const live = dbTools.describe(meta, dir, await appContainers(meta.id)).find(d => d.type === type);
    if (!live || !/^running/i.test(live.state || '')) return res.status(409).json({ error: `${live ? live.label : type} is not running - deploy the site first` });
    const saved = meta.dbTools && meta.dbTools[type];
    let port = saved && parseInt(saved.port, 10);
    if (port < 8900 || port > 8999) port = null;
    if (!port) {
      const used = hostPortsInUse();
      port = 8900;
      while ((used.has(port) || dbToolPorts.has(port)) && port <= 8999) port++;
      if (port > 8999) return res.status(409).json({ error: 'no database UI port available in 8900-8999' });
    }
    if (dbToolPorts.has(port)) return res.status(409).json({ error: `database UI port ${port} is already starting` });
    dbToolPorts.add(port);
    reservedPort = port;
    const out = await dbTools.launch(meta.id, meta, dir, type, port);
    // Reload after the image starts: launches for different database types can
    // finish together, and each must merge rather than overwrite the others.
    const freshDb = load();
    const freshMeta = freshDb.apps.find(a => a.id === meta.id);
    if (!freshMeta) {
      dbTools.stop(meta.id, type);
      throw new Error('site was deleted while the database UI was starting');
    }
    const startedAt = new Date();
    freshMeta.dbTools = { ...(freshMeta.dbTools || {}), [type]: {
      port, tool: out.tool, startedAt: startedAt.toISOString(), expiresAt: new Date(startedAt.getTime() + DB_TOOL_TTL_MS).toISOString()
    } };
    save(freshDb);
    res.json({ ok: true, ...out, expiresAt: freshMeta.dbTools[type].expiresAt });
  } catch (e) { res.status(e.code === 'DB_TOOL_IMAGE_MISSING' ? 409 : 500).json({ error: e.message }); }
  finally {
    dbToolLocks.delete(lock);
    if (reservedPort) dbToolPorts.delete(reservedPort);
  }
});
app.delete('/api/apps/:id/databases/:type/tool', (req, res) => {
  try {
    const db_ = load();
    const meta = db_.apps.find(a => a.id === req.params.id);
    if (!meta) return res.status(404).json({ error: 'unknown app' });
    dbTools.stop(meta.id, req.params.type);
    clearDbToolLease(meta, req.params.type);
    save(db_);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// Frontend -> backend wiring: a static/react site proxies same-origin /api/ to another
// app preserving the /api prefix. Reaches the target through the host gateway, so no
// shared networks and no changes to the target app are needed.
app.post('/api/apps/:id/allow-backend', (req, res) => {
  try {
    const db_ = load();
    const meta = db_.apps.find(a => a.id === req.params.id);
    if (!meta) return res.status(404).json({ error: 'unknown app' });
    meta.allowBackend = !(req.body && req.body.allow === false);
    save(db_);
    res.json({ ok: true, allowBackend: !!meta.allowBackend });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/apps/:id/api-backend', async (req, res) => {
  try {
    const db_ = load();
    const meta = db_.apps.find(a => a.id === req.params.id);
    if (!meta) return res.status(404).json({ error: 'unknown app' });
    const dir = appDir(APPS_DIR, meta.id);
    if (!['static', 'react'].includes(meta.type) && !(svc.fullServices(meta, dir).some(s => (s.type === 'static' || s.type === 'react') && s.enabled !== false))) {
      return res.status(400).json({ error: 'api link needs a static/react frontend service on this site' });
    }
    const frontName = (req.body && req.body.service) || null;
    const all = svc.fullServices(meta, dir);
    const front = frontName
      ? all.find(s => s.name === frontName && (s.type === 'static' || s.type === 'react') && s.enabled !== false)
      : all.find(s => (s.type === 'static' || s.type === 'react') && s.enabled !== false);
    if (!front) return res.status(400).json({ error: 'no enabled static/react service to link from' });
    const ctxDir = path.join(dir, 'code', front.subdir || '');
    const ymlPath = path.join(dir, 'docker-compose.yml');
    if (!fs.existsSync(ymlPath)) return res.status(400).json({ error: 'app has no compose file' });
    const target = (req.body && req.body.target) || null;
    let yml = fs.readFileSync(ymlPath, 'utf8');
    if (!target) {
      envDeleteKeys(dir, ['API_HOST', 'API_PORT']);
      fs.writeFileSync(path.join(ctxDir, 'nginx.conf'), nginxConf(null));
      // global: old buggy links may have stamped several services
      yml = yml.replace(/\n    extra_hosts:\n      - "host\.docker\.internal:host-gateway"\n/g, '\n');
      fs.writeFileSync(ymlPath, yml);
      meta.apiBackend = null;
      meta.apiLinkOff = true;
      save(db_);
      await markDirty(meta.id, 'api link removed');
      if (!(req.body && req.body.apply === true)) return res.json({ ok: true, unlinked: true, pending: true });
      try { await deploy(meta.id); } catch (e) { return res.json({ ok: true, unlinked: true, redeployError: e.message }); }
      return res.json({ ok: true, unlinked: true, redeployed: true });
    }
    // sibling service (same site, same private network) vs other site (via host gateway)
    let proxy, label;
    if (String(target).startsWith('svc:')) {
      const sname = target.slice(4);
      const list = svc.fullServices(meta, dir);
      const s = list.find(x => x.name === sname && x.enabled !== false);
      if (!s) return res.status(404).json({ error: 'unknown sibling service' });
      if (s.name === front.name) return res.status(400).json({ error: 'cannot link a service to itself' });
      proxy = { host: s.name, port: parseInt(s.port, 10) || 3000 };
      label = s.name;
    } else {
      const t = db_.apps.find(a => a.id === target);
      if (!t) return res.status(404).json({ error: 'unknown target app' });
      if (t.id === meta.id) return res.status(400).json({ error: 'cannot link an app to itself' });
      if (!t.allowBackend) return res.status(400).json({ error: `${t.id} has not opted in as an API backend` });
      if (!t.hostPort) return res.status(400).json({ error: 'target has no published port' });
      proxy = { host: 'host.docker.internal', port: t.hostPort };
      label = t.id;
      // splice extra_hosts into the FRONTEND's own block (first env_file in the
      // file may belong to another service); skip when already present there
      const ymlLines = yml.split('\n');
      let inFront = false;
      for (let i = 0; i < ymlLines.length; i++) {
        if (/^  [A-Za-z0-9_-]+:\s*$/.test(ymlLines[i])) inFront = ymlLines[i].trim().replace(/:$/, '') === front.name;
        else if (/^[^ ]/.test(ymlLines[i])) inFront = false;
        if (!inFront) continue;
        if (/^\s*extra_hosts:/.test(ymlLines[i])) break;
        if (/^    env_file: \.env$/.test(ymlLines[i])) {
          ymlLines.splice(i + 1, 0, '    extra_hosts:', '      - "host.docker.internal:host-gateway"');
          break;
        }
      }
      yml = ymlLines.join('\n');
      fs.writeFileSync(ymlPath, yml);
    }
    // the link IS these two env vars - the conf below renders from them
    envSetManaged(dir, { API_HOST: proxy.host, API_PORT: String(proxy.port) });
    fs.writeFileSync(path.join(ctxDir, 'nginx.conf'), nginxConf(proxy));
    meta.apiBackend = { app: label, port: proxy.port, service: front.name };
    delete meta.apiLinkOff;
    save(db_);
    await markDirty(meta.id, 'api link changed');
    if (!(req.body && req.body.apply === true)) return res.json({ ok: true, linked: label, pending: true });
    try { await deploy(meta.id); } catch (e) { return res.json({ ok: true, linked: label, redeployError: e.message }); }
    res.json({ ok: true, linked: label, redeployed: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
async function removeGithubHook(meta) {
  if (!meta || !meta.github || !meta.github.repo || !(meta.github.token || meta.github.login)) return false;
  try {
    const [o, n] = String(meta.github.repo).split('/');
    const hooks = await gh.apiFor(meta, `/repos/${o}/${n}/hooks`);
    const ours = (Array.isArray(hooks) ? hooks : []).find(h => h && h.config && String(h.config.url || '').includes(`/webhook/${meta.id}`));
    if (!ours) return false;
    await gh.apiFor(meta, `/repos/${o}/${n}/hooks/${ours.id}`, { method: 'DELETE' });
    return true;
  } catch { return false; }
}
async function createGithubHook(meta) {
  const base = (process.env.PANEL_URL || '').replace(/\/$/, '');
  if (!base || !meta || !meta.github || !meta.github.repo || !(meta.github.token || meta.github.login)) return false;
  try {
    const [o, n] = String(meta.github.repo).split('/');
    await gh.apiFor(meta, `/repos/${o}/${n}/hooks`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'web', active: true, events: ['push'],
        config: { url: `${base}/webhook/${meta.id}?token=${meta.token}`, content_type: 'json', secret: meta.token, insecure_ssl: '0' }
      })
    });
    return true;
  } catch { return false; }
}
async function githubHead(meta) {
  const [o, n] = String(meta.github.repo || '').split('/');
  const endpoint = `/repos/${o}/${n}/commits/${encodeURIComponent(meta.github.branch || 'main')}`;
  try { return (await gh.apiFor(meta, endpoint) || {}).sha || null; }
  catch {
    try { return (await gh.apiPublic(endpoint) || {}).sha || null; }
    catch { return null; }
  }
}
async function setGithubAutomation(req, res, forcedEnabled) {
  // Disabling stops both webhook and poll triggers while preserving the GitHub
  // source link used by manual repo redeploys. Enabling takes a head snapshot,
  // so the first scheduled check cannot redeploy an unchanged commit.
  try {
    const db_ = load();
    const meta = db_.apps.find(a => a.id === req.params.id);
    if (!meta) return res.status(404).json({ error: 'unknown app' });
    if (!meta.github || !meta.github.repo) return res.status(400).json({ error: 'no github repository linked to this site' });
    const enabled = forcedEnabled === undefined ? !!(req.body && req.body.enabled) : forcedEnabled;
    if (enabled) {
      const head = await githubHead(meta);
      if (head) meta.github.sha = head;
      meta.github.enabled = true;
      meta.github.pollMinutes = Math.max(0, Math.min(60, parseInt(meta.github.pollMinutes, 10) || 0));
      save(db_);
      await removeGithubHook(meta);
      const webhookCreated = await createGithubHook(meta);
      return res.json({ ok: true, enabled: true, pollMinutes: meta.github.pollMinutes, sha: meta.github.sha || null, webhookCreated });
    }
    const webhookDeleted = await removeGithubHook(meta);
    meta.github.enabled = false;
    meta.github.pollMinutes = 0;
    meta.token = crypto.randomBytes(16).toString('hex');
    save(db_);
    res.json({ ok: true, enabled: false, webhookDeleted });
  } catch (e) { res.status(500).json({ error: e.message }); }
}
app.post('/api/apps/:id/github/automation', (req, res) => setGithubAutomation(req, res));
// Compatibility for older frontends: "unlink" now means disable automation;
// the repository connection is deliberately retained.
app.post('/api/apps/:id/github/unlink', (req, res) => setGithubAutomation(req, res, false));
app.post('/api/apps/:id/regenerate', (req, res) => {
  try {
    const db_ = load();
    const meta = db_.apps.find(a => a.id === req.params.id);
    if (!meta) return res.status(404).json({ error: 'unknown app' });
    meta.token = crypto.randomBytes(16).toString('hex');
    save(db_);
    res.json({ ok: true, token: meta.token, webhook: `/webhook/${meta.id}?token=${meta.token}` });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/apps/:id/logs', async (req, res) => {
  try {
    // service names go to the shell - strict charset or no logs
    const svcName = /^[A-Za-z0-9_-]{1,32}$/.test(req.query.service || '') ? req.query.service : 'app';
    const tail = Math.max(10, Math.min(500, parseInt(req.query.tail, 10) || 100));
    const out = await sh(`${COMPOSE_BIN} logs --tail=${tail} ${svcName}`, appDir(APPS_DIR, req.params.id));
    res.type('text/plain').send(out);
  } catch (e) { res.status(500).send(e.message); }
});

app.post('/api/apps/:id/home', (req, res) => {
  try {
    const db_ = load();
    const meta = db_.apps.find(a => a.id === req.params.id);
    if (!meta) return res.status(404).json({ error: 'unknown app' });
    let p = String((req.body && req.body.path) || '').trim();
    if (p && !p.startsWith('/')) p = '/' + p;
    meta.homePath = p || '';
    meta.homePathManual = true;
    save(db_);
    res.json({ ok: true, homePath: meta.homePath });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// Pre-swap migrate command (runs in a one-off container after build, before swap).
// service/dir/check ride along so knex-style flows work: pick the backend
// service, an optional subdir (cd without shell metachars), and a verify cmd.
// = is allowed (single words only, no quoting/$/backtick/;/&/|) so flag-style
// args like `--db=newdbname` and VAR=x prefix overrides work. VAR=x at the
// start of the command sets a per-run env override for that run only.
const MIGRATE_CMD_RE = migrations.COMMAND_RE;
const MIGRATE_DIR_RE = migrations.DIR_RE;
function migrateTarget(meta, dir, svcName) {
  const list = svc.fullServices(meta, dir).filter(s => s.enabled !== false);
  if (svcName && list.some(s => s.name === svcName)) return svcName;
  if (list.some(s => s.name === 'app')) return 'app';
  return (list[0] && list[0].name) || 'app';
}
function migrateDirOk(d) {
  return !d || (MIGRATE_DIR_RE.test(d) && !d.split('/').includes('..'));
}
// The folder is relative to the service's repo root (code/<service-subdir>).
// A file path here is the classic mistake - cd fails with a cryptic exit
// code, so reject it up front with the fix spelled out.
function migrateDirProblem(meta, dirAbs, svcName, dir) {
  if (!dir) return null;
  const list = svc.fullServices(meta, dirAbs).filter(s => s.enabled !== false);
  const svcObj = list.find(s => s.name === svcName) || null;
  const base = path.join(dirAbs, 'code', (svcObj && svcObj.subdir) || '');
  let st = null;
  try { st = fs.statSync(path.join(base, dir)); } catch { return `migrate folder '${dir}' not found in the repo`; }
  if (!st.isDirectory()) return `'${dir}' is a file - use its folder instead`;
  return null;
}
// dir/cmd are charset-validated (no quotes/$/backtick/semicolon/&/|), so the
// sh -c wrapper cannot break out - it only adds a safe `cd`.
function migrateRunArgv(svcName, dir, cmd) {
  const localCmd = migrations.localOnlyCommand(cmd);
  const inner = dir ? `cd ${dir} && ${localCmd}` : localCmd;
  return [...composeArgv(), 'run', '--rm', svcName, 'sh', '-c', inner];
}
function migrationFailure(error) {
  const raw = String((error && error.message) || error || 'migration failed');
  const missingModule = raw.match(/Cannot find module '((?:@[^'/]+\/)?[^'./][^']*)'/);
  if (missingModule) {
    return (`migration dependency '${missingModule[1]}' is not installed in this app image. Add it to package.json dependencies, redeploy (or local rebuild after a Files-tab edit), then retry. Minipass never installs packages during a migration. Original error: ` + raw).slice(0, 1200);
  }
  if (/node_modules\/\.bin\/[A-Za-z0-9_.-]+[^\n]*(?:not found|No such file)|will be installed|npm (?:error|err!).*(?:canceled|cancelled)|could not determine executable/i.test(raw)) {
    return 'migration tool is not installed in this app image. Add the CLI to package.json dependencies/devDependencies, redeploy, then retry. Minipass will not download an unpinned latest version during a migration.';
  }
  const redacted = raw.replace(/((?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?):\/\/[^:\s/@]+):[^@\s/]+@/gi, '$1:***@');
  const useful = redacted.split(/\r?\n/).filter(line => !/^\s*at\b/.test(line) && !/^Node\.js v/i.test(line));
  const concise = useful.join('\n').trim() || redacted;
  if (/ECONNREFUSED[^\n]*(?:127\.0\.0\.1|::1|localhost)/i.test(redacted)) {
    return ('database connection refused at localhost. Inside an app container, localhost is the app itself, not the managed database. Configure the project to use process.env.DB_HOST and process.env.DB_PORT, then local rebuild and retry. Original error: ' + concise).slice(0, 1200);
  }
  if (/ER_NOT_SUPPORTED_AUTH_MODE|does not support authentication protocol|caching_sha2_password/i.test(redacted)) {
    return ('MySQL 8 authentication (caching_sha2_password) is not supported by the repository\u2019s old `mysql` package. Fix in source: replace dependency `mysql` with `mysql2`, set the Knex client to `mysql2`, redeploy, then retry. Testing alternative: recreate the site with MariaDB. Original error: ' + concise).slice(0, 1200);
  }
  return concise.slice(0, 1200);
}
function migrationResponse(prefix, error) {
  const message = prefix + migrationFailure(error);
  return message.length > 500 ? message.slice(0, 497) + '...' : message;
}
app.post('/api/apps/:id/migrate', (req, res) => {
  try {
    const db_ = load();
    const meta = db_.apps.find(a => a.id === req.params.id);
    if (!meta) return res.status(404).json({ error: 'unknown app' });
    const c = String((req.body && (req.body.command ?? req.body.cmd)) || '').trim();
    if (c && !MIGRATE_CMD_RE.test(c)) return res.status(400).json({ error: 'bad command (letters/numbers/space _ . : / - = only)' });
    const dir = String((req.body && req.body.dir) || '').trim().replace(/^\/+|\/+$/g, '');
    if (!migrateDirOk(dir)) return res.status(400).json({ error: 'bad migrate folder' });
    const check = String((req.body && req.body.check) || '').trim();
    if (check && !MIGRATE_CMD_RE.test(check)) return res.status(400).json({ error: 'bad verify command' });
    const dirAbs = appDir(APPS_DIR, meta.id);
    meta.migrateCmd = c;
    meta.migrateDir = dir;
    meta.migrateCheck = check;
    if (req.body && req.body.service !== undefined)
      meta.migrateSvc = migrateTarget(meta, dirAbs, String(req.body.service || '').trim());
    else if (!meta.migrateSvc) meta.migrateSvc = migrateTarget(meta, dirAbs, '');
    const problem = migrateDirProblem(meta, dirAbs, meta.migrateSvc, dir);
    if (problem) return res.status(400).json({ error: problem });
    save(db_);
    res.json({ ok: true, migrateCmd: meta.migrateCmd, migrateSvc: meta.migrateSvc, migrateDir: meta.migrateDir, migrateCheck: meta.migrateCheck });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// Run a migrate command NOW in a one-off container (no swap, no deploy
// record beyond the returned output). Same sandbox as the pre-deploy hook.
// Accepts one-shot {command, service, dir} overrides (validated, not saved)
// so ad-hoc flows like `npm run db:init -- --db=newdbname` run without
// touching the saved pre-deploy settings.
app.post('/api/apps/:id/migrate-run', async (req, res) => {
  try {
    const meta = load().apps.find(a => a.id === req.params.id);
    if (!meta) return res.status(404).json({ error: 'unknown app' });
    const cmd = String((req.body && req.body.command) || (meta && meta.migrateCmd) || '').trim();
    if (!cmd) return res.status(400).json({ error: 'no migrate command saved' });
    if (!MIGRATE_CMD_RE.test(cmd)) return res.status(400).json({ error: 'bad command (letters/numbers/space _ . : / - = only)' });
    const dirIn = String((req.body && req.body.dir) || '').trim().replace(/^\/+|\/+$/g, '');
    if (!migrateDirOk(dirIn)) return res.status(400).json({ error: 'bad migrate folder' });
    const dirAbs = appDir(APPS_DIR, meta.id);
    const svcName = migrateTarget(meta, dirAbs, String((req.body && req.body.service) || meta.migrateSvc || ''));
    // An explicitly sent dir (even empty = service root) wins - the boxes are
    // the truth for one-shot runs. Only fall back to saved when absent.
    const dir = (req.body && req.body.dir !== undefined) ? dirIn : (meta.migrateDir || '');
    const problem = migrateDirProblem(meta, dirAbs, svcName, dir);
    if (problem) return res.status(400).json({ error: problem });
    const argv = migrateRunArgv(svcName, dir, cmd);
    const cap = { cwd: dirAbs, captureStderr: true };
    const out = await runOut(argv[0], argv.slice(1), cap);
    res.json({ ok: true, service: svcName, output: String(out).slice(-4000) || '(no output)' });
  } catch (e) { res.status(500).json({ error: migrationResponse('migrate run failed: ', e) }); }
});
// Verify-only: runs a verify command (e.g. knex migrate:list) and
// returns its output. Accepts a one-shot {check, service, dir} override.
// Never changes anything, never deploys.
app.post('/api/apps/:id/migrate-check', async (req, res) => {
  try {
    const meta = load().apps.find(a => a.id === req.params.id);
    if (!meta) return res.status(404).json({ error: 'unknown app' });
    const cmd = String((req.body && req.body.check) || (meta && meta.migrateCheck) || '').trim();
    if (!cmd) return res.status(400).json({ error: 'no verify command saved' });
    if (!MIGRATE_CMD_RE.test(cmd)) return res.status(400).json({ error: 'bad verify command' });
    const dirIn = String((req.body && req.body.dir) || '').trim().replace(/^\/+|\/+$/g, '');
    if (!migrateDirOk(dirIn)) return res.status(400).json({ error: 'bad migrate folder' });
    const dirAbs = appDir(APPS_DIR, meta.id);
    const svcName = migrateTarget(meta, dirAbs, String((req.body && req.body.service) || meta.migrateSvc || ''));
    const dir = (req.body && req.body.dir !== undefined) ? dirIn : (meta.migrateDir || '');
    const problem = migrateDirProblem(meta, dirAbs, svcName, dir);
    if (problem) return res.status(400).json({ error: problem });
    const argv = migrateRunArgv(svcName, dir, cmd);
    const out = await runOut(argv[0], argv.slice(1), { cwd: dirAbs, captureStderr: true });
    res.json({ ok: true, service: svcName, output: String(out).slice(-4000) || '(no output)' });
  } catch (e) { res.status(500).json({ error: migrationResponse('verify failed: ', e) }); }
});
// Detect migration frameworks and map each project folder to the most-specific
// enabled service build context. Returned dirs are container-relative, never
// repository-relative (server service + code/server project => empty dir).
app.get('/api/apps/:id/migrate-suggest', (req, res) => {
  try {
    const meta = load().apps.find(a => a.id === req.params.id);
    if (!meta) return res.status(404).json({ error: 'unknown app' });
    const dir = appDir(APPS_DIR, meta.id);
    const services = svc.fullServices(meta, dir);
    const detected = migrations.detectMigrations(path.join(dir, 'code'), services);
    // cmd/svc aliases keep older frontends useful during a rolling panel update.
    const suggestions = detected.slice(0, 30).map(x => ({ ...x, cmd: x.command, svc: x.service }));
    res.json({ suggestions });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// Sync box tree to GitHub. All tracked + untracked box edits are first saved in
// a named stash, then the checkout is reset to the authoritative branch. Existing
// stashes and app data/volumes are untouched.
app.post('/api/apps/:id/sync-github', async (req, res) => {
  try {
    const db_ = load();
    const meta = db_.apps.find(a => a.id === req.params.id);
    if (!meta) return res.status(404).json({ error: 'unknown app' });
    if (deployQueues.has(meta.id) || deployLocks.has(meta.id)) return res.status(409).json({ error: 'deploy in progress - sync after it finishes' });
    if (!meta.repoUrl) return res.status(400).json({ error: 'no repo linked' });
    const dir = appDir(APPS_DIR, meta.id);
    const codeDir = path.join(dir, 'code');
    if (!fs.existsSync(path.join(codeDir, '.git'))) return res.status(400).json({ error: 'no git checkout in code/' });
    const isSsh = /^(git@|ssh:\/\/)/i.test(meta.repoUrl);
    const url = isSsh ? meta.repoUrl : gh.authUrlFor(meta, meta.repoUrl);
    const env = isSsh ? appGitEnv(dir) : process.env;
    const branch = (meta.github && meta.github.branch) || 'main';
    let backup = null;
    try {
      const dirty = execFileSync('git', ['status', '--porcelain'], { cwd: codeDir, encoding: 'utf8' }).trim();
      if (dirty) {
        const label = `minipass pre-github-sync ${new Date().toISOString()}`;
        execFileSync('git', ['stash', 'push', '-u', '-m', label], { cwd: codeDir, env, stdio: 'pipe' });
        backup = execFileSync('git', ['rev-parse', '--short', 'stash@{0}'], { cwd: codeDir, env, encoding: 'utf8' }).trim();
      }
      await sh(`git fetch "${url}" "${branch}"`, codeDir, env);
      await sh(`git reset --hard FETCH_HEAD`, codeDir, env);
      const sha = execSync('git rev-parse --short HEAD', { cwd: codeDir }).toString().trim();
      await markDirty(meta.id, 'synced to github');
      res.json({ ok: true, branch, sha, backup });
    } catch (e) {
      return res.json({ ok: false, error: redactUrl(e.stderr ? String(e.stderr) : e.message) });
    }
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/apps/:id/stop', async (req, res) => {
  try {
    const cancelledDeploy = cancelDeploy(req.params.id);
    await siteLifecycle(req.params.id, async () => { dbTools.stopAll(req.params.id); await sh(`${COMPOSE_BIN} stop`, appDir(APPS_DIR, req.params.id)); }, { allowDeploy: cancelledDeploy });
    res.json({ ok: true, cancelledDeploy });
  }
  catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});
app.post('/api/apps/:id/start', async (req, res) => {
  try { await siteLifecycle(req.params.id, async () => {
    const meta = load().apps.find(a => a.id === req.params.id);
    const dir = appDir(APPS_DIR, req.params.id);
    if (meta && meta.storageQuota) await quotas.verifyDatabases(meta.id, dir);
    await sh(`${COMPOSE_BIN}${meta && meta.storageQuota ? ` -p ${meta.id}` : ''} up -d`, dir);
  }); res.json({ ok: true }); }
  catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});
// Static env-need scan: which vars the repo code actually reads, so missing
// declarations in .env/.env.example surface before runtime. Read-only, key
// names only - never values. Caps files/size/depth to stay fast.
const ENV_SCAN_SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'vendor', '__pycache__', '.venv', 'venv']);
const ENV_SCAN_NOISE = new Set(['PATH', 'HOME', 'USER', 'SHELL', 'PWD', 'OLDPWD', 'LANG', 'LC_ALL', 'TZ', 'TMPDIR', 'TEMP', 'TMP', 'NODE_PATH']);
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
// Sensible self-generated defaults: values the panel can compute without asking.
function suggestedDefaults(meta) {
  return { ...envDefaults.BUILT_INS };
}
// Environment editor: custom keys editable, managed keys (ports, generated creds)
// locked. POST saves pending changes; deploy explicitly to apply them.
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
function managedKeys(dir) {
  try {
    const keys = fs.readFileSync(path.join(dir, '.env.managed'), 'utf8').split('\n').map(s => s.trim()).filter(Boolean);
    if (keys.length) return new Set(keys);
  } catch {}
  // legacy apps predate .env.managed: fall back to the closed set of generated names
  return new Set(['APP_NAME', 'APP_TYPE', 'PORT', 'HOST_PORT', 'DOMAIN',
    'DB_HOST', 'DB_PORT', 'DB_NAME', 'DB_USER', 'DB_PASSWORD', 'DATABASE_URL',
    'POSTGRES_HOST', 'POSTGRES_PORT', 'POSTGRES_DB', 'POSTGRES_USER', 'POSTGRES_PASSWORD',
    'MYSQL_HOST', 'MYSQL_PORT', 'MYSQL_DB', 'MYSQL_USER', 'MYSQL_PASSWORD',
    'MONGO_HOST', 'MONGO_PORT', 'MONGO_DB', 'MONGO_USER', 'MONGO_PASSWORD', 'MONGO_URL',
    'REDIS_HOST', 'REDIS_PORT', 'REDIS_PASSWORD', 'REDIS_URL',
    'API_HOST', 'API_PORT']);
}
// Cross-site links live in env (visible, editable source of truth) - never in
// shared networks or volumes. One folder/container per site, always.
function envSetManaged(dir, obj) {
  const envPath = path.join(dir, '.env');
  let arr = [];
  try { arr = fs.readFileSync(envPath, 'utf8').split('\n'); } catch {}
  for (const [k, v] of Object.entries(obj)) {
    const i = arr.findIndex(l => new RegExp(`^\\s*${k}\\s*=`).test(l));
    if (i >= 0) arr[i] = `${k}=${v}`;
    else arr.push(`${k}=${v}`);
  }
  fs.writeFileSync(envPath, arr.join('\n').replace(/\s*$/, '') + '\n');
  const mp = path.join(dir, '.env.managed');
  let have = new Set();
  try { have = new Set(fs.readFileSync(mp, 'utf8').split('\n').map(s => s.trim()).filter(Boolean)); } catch {}
  for (const k of Object.keys(obj)) have.add(k);
  try { fs.writeFileSync(mp, [...have].join('\n') + '\n'); } catch {}
}
function envDeleteKeys(dir, keys) {
  const envPath = path.join(dir, '.env');
  let arr = [];
  try { arr = fs.readFileSync(envPath, 'utf8').split('\n'); } catch {}
  const gone = new Set(keys);
  arr = arr.filter(l => {
    const m = l.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    return !(m && gone.has(m[1]));
  });
  fs.writeFileSync(envPath, arr.join('\n').replace(/\s*$/, '') + '\n');
  const mp = path.join(dir, '.env.managed');
  try {
    const kept = fs.readFileSync(mp, 'utf8').split('\n').map(s => s.trim()).filter(s => s && !gone.has(s));
    fs.writeFileSync(mp, kept.join('\n') + '\n');
  } catch {}
}
app.get('/api/apps/:id/env', (req, res) => {
  const meta = load().apps.find(a => a.id === req.params.id);
  if (!meta) return res.status(404).json({ error: 'unknown app' });
  const managed = managedKeys(appDir(APPS_DIR, meta.id));
  res.json({ vars: readEnvVars(path.join(appDir(APPS_DIR, meta.id), '.env')).map(v => ({ ...v, managed: managed.has(v.key) })) });
});
app.put('/api/apps/:id/env', async (req, res) => {
  const validKey = k => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k);
  try {
    const db_ = load();
    const meta = db_.apps.find(a => a.id === req.params.id);
    if (!meta) return res.status(404).json({ error: 'unknown app' });
    const dir = appDir(APPS_DIR, meta.id);
    const managed = managedKeys(dir);
    // managed keys are infrastructure (ports, hosts, generated creds) - read-only,
    // except DOMAIN which is display/future-tunnel metadata. Deleting them is refused too.
    const EDITABLE = new Set(['DOMAIN']);
    const PROTECTED = new Set(['NODE_ENV']);
    const set = { ...((req.body && req.body.set) || {}) };
    const del = Array.isArray(req.body && req.body.delete) ? req.body.delete : [];
    const rename = (req.body && req.body.rename) || {};
    if (Object.prototype.hasOwnProperty.call(set, 'DOMAIN')) {
      try { set.DOMAIN = cleanDomain(set.DOMAIN); }
      catch (e) { return res.status(400).json({ error: e.message }); }
    }
    for (const k of Object.keys(set)) {
      if (!validKey(k)) return res.status(400).json({ error: 'bad key name: ' + k });
    }
    for (const k of del) {
      if (!validKey(k)) return res.status(400).json({ error: 'bad key name: ' + k });
      if (PROTECTED.has(k)) return res.status(400).json({ error: `${k} is required and cannot be deleted` });
    }
    for (const [from, to] of Object.entries(rename)) {
      if (!validKey(from) || !validKey(to)) return res.status(400).json({ error: `bad key rename: ${from} → ${to}` });
      if (PROTECTED.has(from)) return res.status(400).json({ error: `${from} is required and cannot be renamed` });
      if (managed.has(from) || managed.has(to)) return res.status(400).json({ error: 'managed environment keys cannot be renamed' });
      if (!del.includes(from) || !Object.prototype.hasOwnProperty.call(set, to)) return res.status(400).json({ error: 'incomplete environment key rename' });
    }
    let raw = '';
    try { raw = fs.readFileSync(path.join(dir, '.env'), 'utf8'); } catch {}
    let arr = raw.split('\n');
    const existing = new Set(arr.map(l => { const m = l.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/); return m && m[1]; }).filter(Boolean));
    const renamedFrom = new Set(Object.keys(rename));
    for (const [from, to] of Object.entries(rename)) {
      if (!existing.has(from)) return res.status(400).json({ error: `environment key no longer exists: ${from}` });
      if (existing.has(to) && !renamedFrom.has(to)) return res.status(400).json({ error: `environment key already exists: ${to}` });
    }
    const skipped = del.filter(k => managed.has(k));
    const delSet = new Set(del.filter(k => !managed.has(k)));
    const lockedSet = Object.keys(set).filter(k => managed.has(k) && !EDITABLE.has(k));
    for (const k of lockedSet) delete set[k];
    if (delSet.size) {
      arr = arr.filter(l => {
        const m = l.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/);
        return !(m && delSet.has(m[1]));
      });
    }
    for (const [k, vv] of Object.entries(set)) {
      const clean = String(vv == null ? '' : vv).replace(/[\r\n]/g, '');
      const i = arr.findIndex(l => new RegExp(`^\\s*${k}\\s*=`).test(l));
      if (i >= 0) arr[i] = `${k}=${clean}`;
      else arr.push(`${k}=${clean}`);
    }
    fs.writeFileSync(path.join(dir, '.env'), arr.join('\n').replace(/\s*$/, '') + '\n');
    if (Object.prototype.hasOwnProperty.call(set, 'DOMAIN') && meta.domain !== set.DOMAIN) {
      meta.domain = set.DOMAIN;
      save(db_);
    }
    await markDirty(meta.id, 'env changed');
    const skippedAll = [...new Set([...skipped, ...lockedSet])];
    // edits save only - redeploy is an explicit user action (deploy button)
    if (!(req.body && req.body.apply === true)) return res.json({ ok: true, saved: true, skipped: skippedAll, pending: true });
    try { await deploy(meta.id); } catch (e) { return res.json({ ok: true, saved: true, skipped: skippedAll, redeployError: e.message }); }
    res.json({ ok: true, saved: true, skipped: skippedAll, redeployed: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
function applyEnvDefaults(meta, dir, hostname, protocol, requestedKeys) {
  const services = svc.fullServices(meta, dir);
  const origins = envDefaults.publishedOrigins(services, hostname, protocol);
  const snapshot = envDefaults.snapshotDefaults(dir, path.join(dir, 'code'), services);
  const envPath = path.join(dir, '.env');
  const valOf = new Map(readEnvVars(envPath).map(v => [v.key, v.value]));
  const runtimeValues = Object.fromEntries(valOf);
  const resolved = envDefaults.resolvedDefaults(path.join(dir, 'code'), services, origins, snapshot.values, snapshot.originals, runtimeValues);
  const managed = managedKeys(dir);
  const allowed = { ...resolved.values, ...suggestedDefaults(meta) };
  for (const key of managed) delete allowed[key];
  const asked = Array.isArray(requestedKeys) && requestedKeys.length
    ? requestedKeys.filter(k => Object.prototype.hasOwnProperty.call(allowed, k))
    : Object.keys(allowed);
  // Fill missing/empty values. Also repair captured local-development placeholders
  // once the corresponding published frontend/backend service is known.
  const fill = asked.filter(k => !valOf.has(k) || (!String(valOf.get(k)).trim() && String(allowed[k]).trim()));
  const corrected = {};
  for (const k of asked.filter(k => valOf.has(k) && String(valOf.get(k)).trim())) {
    const value = envDefaults.correctedValue(k, valOf.get(k), resolved, origins);
    if (value != null) corrected[k] = value;
  }
  const update = Object.keys(corrected);
  const change = [...new Set([...fill, ...update])];
  if (change.length) {
    let arr = [];
    try { arr = fs.readFileSync(envPath, 'utf8').split('\n'); } catch {}
    for (const k of change) {
      const i = arr.findIndex(l => new RegExp(`^\\s*${k}\\s*=`).test(l));
      const value = Object.prototype.hasOwnProperty.call(corrected, k) ? corrected[k] : allowed[k];
      if (i >= 0) arr[i] = `${k}=${value}`;
      else arr.push(`${k}=${value}`);
    }
    fs.writeFileSync(envPath, arr.join('\n').replace(/\s*$/, '') + '\n');
  }
  return { added: fill, updated: update, origins, defaultSources: snapshot.sources, pending: true };
}
app.post('/api/tools/token', (req, res) => {
  try {
    const value = tokens.mintToken(
      String((req.body && req.body.format) || 'base64url').trim(),
      parseInt((req.body && req.body.bytes) || 32, 10)
    );
    res.json({ ok: true, format: String((req.body && req.body.format) || 'base64url').trim(), value });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/apps/:id/env/defaults', async (req, res) => {
  try {
    const meta = load().apps.find(a => a.id === req.params.id);
    if (!meta) return res.status(404).json({ error: 'unknown app' });
    const result = applyEnvDefaults(meta, appDir(APPS_DIR, meta.id), req.hostname, req.protocol, req.body && req.body.keys);
    if (result.added.length || result.updated.length) await markDirty(meta.id, 'env defaults restored');
    res.json({ ok: true, ...result });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
function lifecycleError(message, status = 409) { return Object.assign(new Error(message), { status }); }
function deployCancelledError() {
  return new Error('deploy cancelled - the site was stopped mid-deploy; containers stay stopped');
}
function trackDeployChild(id, child) {
  if (!child) return child;
  let children = deployChildren.get(id);
  if (!children) { children = new Set(); deployChildren.set(id, children); }
  children.add(child);
  child.once('close', () => {
    const current = deployChildren.get(id);
    if (!current) return;
    current.delete(child);
    if (!current.size) deployChildren.delete(id);
  });
  // Stop may have raced the spawn by a few microtasks.
  const op = deployOps.get(id);
  if (op && op.cancelled) killProcessTree(child);
  return child;
}
function killProcessTree(child) {
  if (!child || !child.pid) return;
  // Deploy commands run as their own process group on Linux. Killing the group
  // terminates the shell, docker compose, and its active build client together.
  if (process.platform !== 'win32') {
    try { process.kill(-child.pid, 'SIGTERM'); } catch { try { child.kill('SIGTERM'); } catch {} }
    const timer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 2000);
    if (timer.unref) timer.unref();
  } else {
    try { execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); }
    catch { try { child.kill('SIGTERM'); } catch {} }
  }
}
function killDeployChildren(id) {
  for (const child of [...(deployChildren.get(id) || [])]) killProcessTree(child);
}
// Stopping a site must work even mid-deploy: invalidate queued work, terminate
// active deploy processes, then stop containers. Only stop takes this path;
// destructive operations remain blocked while deployment work drains.
function cancelDeploy(id) {
  const op = deployOps.get(id);
  const busy = !!op || deployQueues.has(id) || deployLocks.has(id);
  if (!busy) return false;
  deployEpochs.set(id, (deployEpochs.get(id) || 0) + 1);
  if (op) op.cancelled = true;
  killDeployChildren(id);
  return true;
}
function checkCancelled(id) {
  const op = deployOps.get(id);
  if (op && op.cancelled) throw deployCancelledError();
}
async function siteLifecycle(id, action, opts = {}) {
  const deployBusy = deployQueues.has(id) || deployLocks.has(id);
  if (creatingSites.has(id) || lifecycleLocks.has(id) || (deployBusy && !opts.allowDeploy)) throw lifecycleError('wait for the current site operation to finish');
  lifecycleLocks.add(id);
  try { return await action(); } finally { lifecycleLocks.delete(id); }
}
async function trashOperation(action) {
  if (trashBusy) throw lifecycleError('another Trash operation is running - retry when it finishes');
  trashBusy = true;
  try { return await action(); } finally { trashBusy = false; }
}
const trashKey = record => record.trashDir || record.id;
const trashOptions = () => ({ docker: DOCKER_BIN, compose: composeArgv() });
app.delete('/api/apps/:id', async (req, res) => {
  // soft delete: containers stop, but volumes and files move to the 48-hour
  // trash hold so an accidental delete is restorable. Permanent destruction
  // is DELETE /api/trash/:id (typed confirm) or the expiry worker.
  try {
    await trashOperation(() => siteLifecycle(req.params.id, async () => {
      const meta = load().apps.find(a => a.id === req.params.id);
      if (!meta) throw lifecycleError('unknown app', 404);
      const dir = appDir(APPS_DIR, meta.id);
      const images = await trashLib.rememberImages({ id: meta.id, dir, record: meta, ...trashOptions() });
      await trashLib.stopSiteTools({ id: meta.id, ...trashOptions() });
      await sh(`${COMPOSE_BIN} -p ${meta.id} down`, dir);
      let name = meta.id, n = 0;
      while (fs.existsSync(path.join(TRASH_DIR, name))) { n++; name = `${meta.id}-${Date.now()}-${n}`; }
      fs.renameSync(dir, path.join(TRASH_DIR, name));
      // Reload after Docker awaits so unrelated deploy/create changes survive.
      const fresh = load();
      const latest = fresh.apps.find(a => a.id === meta.id) || meta;
      fresh.apps = fresh.apps.filter(a => a.id !== meta.id);
      fresh.trash = [...(fresh.trash || []), { ...latest, deletedAt: Date.now(), trashDir: name, trashImages: images }];
      save(fresh);
      res.json({ ok: true, trashed: true, restoreBy: new Date(Date.now() + TRASH_HOLD_MS).toISOString() });
    }));
  } catch (e) { res.status(e.status || 500).json({ error: redactUrl(e.message) }); }
});
app.get('/api/trash', (req, res) => {
  try {
    const db_ = load();
    const now = Date.now();
    res.json((db_.trash || []).map(t => ({
      ...pubApp(t),
      deletedAt: t.deletedAt || null,
      restoreBy: t.deletedAt ? new Date(t.deletedAt + TRASH_HOLD_MS).toISOString() : null,
      msLeft: t.deletedAt ? Math.max(0, t.deletedAt + TRASH_HOLD_MS - now) : null
    })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/trash/:id/restore', async (req, res) => {
  try {
    await trashOperation(() => siteLifecycle(req.params.id, async () => {
    const db_ = load();
    if (!Array.isArray(db_.trash)) db_.trash = [];
    const idx = db_.trash.map(t => t.id).lastIndexOf(req.params.id);
    if (idx < 0) return res.status(404).json({ error: 'nothing in trash for ' + req.params.id });
    if (db_.apps.some(a => a.id === req.params.id)) return res.status(409).json({ error: 'a live site already uses this internal id; resolve the metadata conflict before restoring' });
    const record = db_.trash[idx];
    if (db_.trash.filter(t => t.id === record.id).length > 1) return res.status(409).json({ error: 'multiple Trash generations share this name - use Empty trash to clean them together' });
    if (record.cleanupStartedAt || Date.now() - record.deletedAt >= TRASH_HOLD_MS) return res.status(410).json({ error: 'retention expired or permanent cleanup started - retry destruction instead' });
    await quotas.ensure(record);
    Object.assign(db_, load()); // preserve unrelated site updates during host check
    const from = trashLib.trashPath(TRASH_DIR, record);
    if (!fs.existsSync(path.join(from, 'docker-compose.yml'))) return res.status(410).json({ error: 'trash contents are missing - cannot restore' });
    const dir = appDir(APPS_DIR, record.id);
    try { fs.renameSync(from, dir); }
    catch (e) { return res.status(500).json({ error: 'could not restore site files: ' + e.message }); }
    const { deletedAt, trashDir, trashImages, cleanupError, cleanupStartedAt, cleanupAttemptAt, ...meta } = record;
    // ports may have been claimed by sites created after the delete - bump
    // them like create does, then rewrite .env + compose before starting.
    const used = hostPortsInUse();
    const moved = [];
    const claim = current => {
      let p = parseInt(current, 10) || 8000;
      while (used.has(p) && p < 9000) p++;
      used.add(p);
      return p;
    };
    if (meta.hostPort) {
      const p = claim(meta.hostPort);
      if (p !== parseInt(meta.hostPort, 10)) moved.push({ from: meta.hostPort, to: p });
      meta.hostPort = p;
    }
    for (const s of (meta.services || [])) {
      if (!s.hostPort) continue;
      if (s.name === 'app' && meta.hostPort) { s.hostPort = meta.hostPort; continue; }
      const p = claim(s.hostPort);
      if (p !== parseInt(s.hostPort, 10)) moved.push({ service: s.name, from: s.hostPort, to: p });
      s.hostPort = p;
    }
    db_.apps.push(meta);
    db_.trash.splice(idx, 1);
    save(db_);
    if (moved.length) {
      try {
        envSetManaged(dir, { HOST_PORT: String(meta.hostPort) });
        svc.renderProject({ dir, templatesDir: TEMPLATES_DIR, meta });
      } catch (e) { console.error(record.id, 'restore port rewrite:', e.message); }
    }
    let restarted = false, restartError = null;
    try {
      if (meta.storageQuota) await quotas.verifyDatabases(meta.id, dir);
      await sh(`${COMPOSE_BIN} -p ${meta.id} up -d`, dir); restarted = true;
    }
    catch (e) { restartError = e.message; }
    try { await markDirty(meta.id, 'restored from trash'); } catch {}
    res.json({ ok: true, restored: true, movedPorts: moved, restarted, restartError });
    }));
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});
app.delete('/api/trash/:id', async (req, res) => {
  // One shared cleanup pipeline for individual, bulk and expiry destruction.
  try {
    await trashOperation(async () => {
      const records = load().trash || [];
      const record = records.filter(t => t.id === req.params.id).pop();
      if (!record) throw lifecycleError('nothing in trash for ' + req.params.id, 404);
      const cleanup = await destroyTrashRecord(record, new Set([trashKey(record)]));
      res.json({ ok: true, destroyed: true, cleanup });
    });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});
app.delete('/api/trash', async (req, res) => {
  // empty trash: permanently destroy everything held, oldest first.
  try {
    await trashOperation(async () => {
      const records = load().trash || [];
      const selected = new Set(records.map(trashKey));
      const destroyed = [], failed = [];
      for (const record of records) {
        try { await destroyTrashRecord(record, selected); destroyed.push(record.id); }
        catch (e) { failed.push({ id: record.id, error: e.message }); }
      }
      res.json({ ok: !failed.length, destroyed, failed, ...(failed.length ? { error: `${failed.length} site(s) could not be fully cleaned; kept in Trash. Open Trash for the error and retry.` } : {}) });
    });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});
async function destroyTrashRecord(record, selected) {
  return siteLifecycle(record.id, async () => {
    try {
      const db_ = load();
      if (db_.apps.some(a => a.id === record.id)) throw lifecycleError('a live site reuses this Compose project - cleanup blocked to protect it');
      const siblings = (db_.trash || []).filter(t => t.id === record.id);
      if (siblings.some(t => !selected.has(trashKey(t)))) throw lifecycleError('multiple Trash generations share this name - use Empty trash to destroy them together');
      const dir = trashLib.trashPath(TRASH_DIR, record);
      const images = await trashLib.collectImages({ id: record.id, dir, record, ...trashOptions() });
      const before = load();
      for (const item of before.trash || []) {
        if (item.id === record.id && selected.has(trashKey(item))) item.cleanupStartedAt = item.cleanupStartedAt || Date.now();
        if (trashKey(item) === trashKey(record)) { item.trashImages = images; item.cleanupAttemptAt = Date.now(); delete item.cleanupError; }
      }
      save(before);
      const cleanup = await trashLib.destroySite({ record, trashRoot: TRASH_DIR, images,
        protectedImages: [...Object.values(require('./lib/generator').DB_IMAGES), ...dbTools.IMAGES, 'minipass-panel:latest'], ...trashOptions() });
      if (record.storageQuota && record.storageQuota.projectId) await quotas.release(record.id);
      const fresh = load();
      fresh.trash = (fresh.trash || []).filter(t => trashKey(t) !== trashKey(record));
      save(fresh);
      return cleanup;
    } catch (e) {
      const fresh = load();
      const retained = (fresh.trash || []).find(t => trashKey(t) === trashKey(record));
      if (retained) { retained.cleanupError = redactUrl(e.message).slice(-600); retained.cleanupAttemptAt = Date.now(); save(fresh); }
      try { panelLog.logEvent({ level: 'error', area: 'trash-destroy', site: record.id, message: e.message }); } catch {}
      throw e;
    }
  });
}
async function purgeTrash() {
  if (trashBusy) return;
  try {
    await trashOperation(async () => {
      const records = (load().trash || []).filter(t => t && t.deletedAt && Date.now() - t.deletedAt >= TRASH_HOLD_MS);
      const selected = new Set(records.map(trashKey));
      for (const record of records) {
        try { await destroyTrashRecord(record, selected); console.log('trash expired:', record.id); }
        catch (e) { console.error('trash cleanup retained:', record.id, e.message); }
      }
    });
  } catch (e) { console.error('trash purge:', e.message); }
}
setInterval(purgeTrash, 60 * 1000).unref();
purgeTrash();

function parseEnvFile(p) {
  const out = {};
  try {
    for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
      const m = line.match(/^([A-Z_]+)=(.*)$/);
      if (m) out[m[1]] = m[2].trim();
    }
  } catch {}
  return out;
}

// Recover apps found on disk (e.g. panel data lost before persistent volume).
app.post('/api/panel/scan', (req, res) => {
  try {
    const db_ = load();
    const used = new Set(db_.apps.map(a => a.hostPort).filter(Boolean));
    let nextPort = 8000;
    const found = [];
    for (const name of fs.readdirSync(APPS_DIR)) {
      const dir = path.join(APPS_DIR, name);
      try { if (!fs.statSync(dir).isDirectory()) continue; } catch { continue; }
      if (!fs.existsSync(path.join(dir, 'docker-compose.yml'))) continue;
      if (db_.apps.some(a => a.id === name)) { found.push(name + ' (kept)'); continue; }
      const env = parseEnvFile(path.join(dir, '.env'));
      const detected = ['postgres', 'mysql', 'mariadb', 'mongo', 'redis'].filter(t => env[t.toUpperCase() + '_HOST']);
      let dbLabel = detected;
      if (!dbLabel.length && env.DB_HOST) {
        if (env.MARIADB_ROOT_PASSWORD) dbLabel = ['mariadb'];
        else if (env.MYSQL_ROOT_PASSWORD) dbLabel = ['mysql'];
        else if (env.POSTGRES_PASSWORD) dbLabel = ['postgres'];
        else dbLabel = ['external'];
      } else if (!dbLabel.length && env.MONGO_URL) dbLabel = ['mongo'];
      else if (!dbLabel.length && env.REDIS_URL) dbLabel = ['redis'];
      let hostPort = parseInt(env.HOST_PORT, 10);
      if (!hostPort || used.has(hostPort)) {
        hostPort = nextPort;
        while (used.has(hostPort) && hostPort < 9000) hostPort++;
        nextPort = hostPort + 1;
      }
      used.add(hostPort);
      let storageQuota;
      const quotaFile = path.join(dir, '.storage-quota.json');
      if (fs.existsSync(quotaFile)) {
        storageQuota = JSON.parse(fs.readFileSync(quotaFile, 'utf8'));
        if (!Number.isSafeInteger(storageQuota.limitBytes)) throw new Error('invalid recovered storage allowance for ' + name);
        if (storageQuota.projectId !== null && storageQuota.projectId !== undefined && !Number.isInteger(storageQuota.projectId)) throw new Error('invalid recovered storage allowance for ' + name);
        storageQuota = { projectId: storageQuota.projectId || null, limitBytes: storageQuota.limitBytes, enforced: !!storageQuota.projectId };
      }
      db_.apps.push({
        id: name, name: siteIdentity.readName(dir, name), type: env.APP_TYPE || 'static', repoUrl: '',
        db: dbLabel, domain: env.DOMAIN || '',
        token: crypto.randomBytes(16).toString('hex'),
        hostPort, ...(storageQuota ? { storageQuota } : {}), createdAt: new Date().toISOString(), recovered: true
      });
      found.push(name + ' (recovered, new webhook token)');
    }
    save(db_);
    res.json({ ok: true, found, total: db_.apps.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// File manager for apps without git (static default page etc.)
function codeDir(id) { return path.join(appDir(APPS_DIR, id), 'code'); }
const JUNK = new Set(['__MACOSX', '.DS_Store', 'Thumbs.db']);
function safeRel(base, rel) {
  const resolved = path.resolve(base, '.' + path.sep + (rel || ''));
  if (resolved !== base && !resolved.startsWith(base + path.sep)) throw new Error('bad path');
  return resolved;
}
app.get('/api/apps/:id/files', (req, res) => {
  try {
    const base = codeDir(req.params.id);
    const dir = safeRel(base, req.query.path || '');
    const out = fs.readdirSync(dir, { withFileTypes: true })
      .map(e => ({ name: e.name, dir: e.isDirectory() }))
      .sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name));
    res.json(out);
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.get('/api/apps/:id/file', (req, res) => {
  try {
    const f = safeRel(codeDir(req.params.id), req.query.path || '');
    const st = fs.statSync(f);
    if (!st.isFile()) return res.status(400).json({ error: 'not a file' });
    if (st.size > 1024 * 1024) return res.status(400).json({ error: `file too large to edit in the panel (${Math.round(st.size / 1024)}KB > 1024KB) - replace it via zip upload` });
    const buf = fs.readFileSync(f);
    if (buf.includes(0)) return res.status(400).json({ error: 'binary file - use zip upload to replace' });
    res.json({ path: req.query.path, content: buf.toString('utf8') });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.put('/api/apps/:id/file', async (req, res) => {
  try {
    const f = safeRel(codeDir(req.params.id), req.body.path || '');
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, req.body.content || '');
    await markDirty(req.params.id, 'file ' + (req.body.path || ''));
  } catch (e) { return res.status(500).json({ error: e.message }); }
  if (!(req.body && req.body.apply === true)) return res.json({ ok: true, saved: true, pending: true });
  try { await deploy(req.params.id); res.json({ ok: true, redeployed: true }); }
  catch (e) { res.json({ ok: true, saved: true, redeployError: e.message }); }
});
app.delete('/api/apps/:id/file', async (req, res) => {
  try {
    const base = codeDir(req.params.id);
    const f = safeRel(base, req.query.path || '');
    if (f === base) return res.status(400).json({ error: 'refusing to delete app root' });
    fs.rmSync(f, { recursive: true, force: true });
    await markDirty(req.params.id, 'deleted ' + (req.query.path || ''));
    if (req.query.apply === 'true' || (req.body && req.body.apply === true)) await deploy(req.params.id);
    res.json({ ok: true, saved: true, pending: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
const uploadMany = require('multer')({ dest: '/tmp/minipass-uploads/', limits: { fileSize: 50 * 1024 * 1024, files: 100 } });
app.post('/api/apps/:id/upload-files', uploadMany.array('files', 100), async (req, res) => {
  try {
    if (!req.files || !req.files.length) return res.status(400).json({ error: 'no files attached' });
    let paths = req.body.paths;
    if (!Array.isArray(paths)) paths = [paths];
    const code = codeDir(req.params.id);
    let n = 0;
    const skipped = [];
    req.files.forEach((f, i) => {
      const rel = String(paths[i] || f.originalname || '').replace(/\\/g, '/');
      const base = rel.split('/').pop();
      if (!rel || rel.includes('..') || !base || JUNK.has(base) || base.startsWith('._') || base === 'Dockerfile' || base === 'nginx.conf') {
        skipped.push(rel || f.originalname || '?');
        try { fs.unlinkSync(f.path); } catch {}
        return;
      }
      try {
        const dest = safeRel(code, rel);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.renameSync(f.path, dest);
        n++;
      } catch {
        skipped.push(rel);
        try { fs.unlinkSync(f.path); } catch {}
      }
    });
    if (!n) return res.status(400).json({ error: 'nothing usable uploaded', skipped });
    await markDirty(req.params.id, 'upload');
    if (req.body.apply !== 'true') return res.json({ ok: true, files: n, skipped, pending: true });
    try { await deploy(req.params.id); res.json({ ok: true, redeployed: true, files: n, skipped }); }
    catch (e) { res.json({ ok: true, files: n, skipped, redeployError: e.message }); }
  } catch (e) { res.status(500).json({ error: e.message }); }
});
fs.mkdirSync('/tmp/minipass-uploads', { recursive: true });
const upload = require('multer')({ dest: '/tmp/minipass-uploads/', limits: { fileSize: 50 * 1024 * 1024 } });
app.post('/api/apps/:id/upload', upload.single('zip'), async (req, res) => {
  let merged = false;
  try {
    if (!req.file) return res.status(400).json({ error: 'no zip attached (field name: zip)' });
    const code = codeDir(req.params.id);
    const tmpBase = fs.mkdtempSync(path.join('/tmp', 'minipass-extract-'));
    await sh(`unzip -o "${req.file.path}" -d "${tmpBase}"`, '/tmp');
    fs.unlinkSync(req.file.path);
    // smart flatten: descend through single wrapper folders until index.html level (max 3)
    let src = tmpBase;
    for (let d = 0; d < 3; d++) {
      const kids = fs.readdirSync(src).filter(e => !JUNK.has(e) && !e.startsWith('._'));
      const hasIndex = kids.some(e => /^index\.html?$/i.test(e));
      if (!hasIndex && kids.length === 1 && fs.statSync(path.join(src, kids[0])).isDirectory()) {
        src = path.join(src, kids[0]);
        continue;
      }
      break;
    }
    // merge into code, but keep managed infra files (Dockerfile, nginx.conf)
    let n = 0;
    for (const e of fs.readdirSync(src)) {
      if (e === 'Dockerfile' || e === 'nginx.conf' || JUNK.has(e) || e.startsWith('._')) continue;
      fs.cpSync(path.join(src, e), path.join(code, e), { recursive: true });
      n++;
    }
    fs.rmSync(tmpBase, { recursive: true, force: true });
    if (!n) return res.status(400).json({ error: 'zip was empty (or only contained infra files)' });
    await markDirty(req.params.id, 'zip upload');
    // validate: static hosting needs index.html at root - indicate, don't guess further
    const rootFiles = fs.readdirSync(code);
    const hasIndex = rootFiles.some(e => /^index\.html?$/i.test(e));
    let warning;
    if (!hasIndex) {
      let foundAt = null;
      const walk = (dir, rel, depth) => {
        if (foundAt || depth > 2) return;
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          if (JUNK.has(e.name)) continue;
          if (!e.isDirectory() && /^index\.html?$/i.test(e.name)) { foundAt = (rel ? rel + '/' : '') + e.name; return; }
        }
        if (depth < 2) for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          if (e.isDirectory() && !JUNK.has(e.name)) walk(path.join(dir, e.name), (rel ? rel + '/' : '') + e.name, depth + 1);
        }
      };
      try { walk(code, '', 0); } catch {}
      warning = foundAt
        ? `no index.html at site root - found at ${foundAt}. Move that folder's contents to the top (or re-zip so index.html is at root).`
        : `no index.html found anywhere in the zip. Static sites need an index.html - showing: ${rootFiles.slice(0, 8).join(', ')}`;
    }
    merged = true;
    if (req.body.apply !== 'true') return res.json({ ok: true, files: 'merged', saved: true, pending: true, index: hasIndex ? 'index.html' : null, warning });
    await deploy(req.params.id);
    res.json({ ok: true, redeployed: true, files: n, index: hasIndex ? 'index.html' : null, warning });
  } catch (e) {
    // files already merged - report deploy failure separately so upload isn't mistaken as lost
    if (merged) return res.json({ ok: true, files: 'merged', saved: true, warning, redeployError: e.message });
    return res.status(500).json({ error: e.message });
  }
});

// Panel self-upgrade from UI: git pull + rebuild (needs ./:/repo mount + docker sock).
const REPO_DIR = (() => {
  for (const c of ['/repo', path.resolve(__dirname, '..')]) {
    try { if (fs.existsSync(path.join(c, '.git'))) return c; } catch {}
  }
  return null;
})();
app.get('/api/panel/version', (req, res) => {
  const running = process.env.GIT_SHA || 'dev';
  if (!REPO_DIR) return res.json({ running, repo: 'unknown', upgradeable: false });
  try {
    const repo = execSync('git rev-parse --short HEAD', { cwd: REPO_DIR }).toString().trim();
    res.json({ running, repo, upgradeable: true, restarting: running !== 'dev' && running !== repo });
  } catch (e) { res.json({ running, repo: 'unknown', upgradeable: false }); }
});
app.post('/api/panel/upgrade', async (req, res) => {
  if (!REPO_DIR) return res.status(501).json({ error: 'repo not mounted (add ./:/repo volume)' });
  // Upgrade lock: double-clicks / retries must not stack concurrent recreates.
  const lockFile = path.join(REPO_DIR, '.upgrade-lock');
  try {
    const age = Date.now() - fs.statSync(lockFile).mtimeMs;
    if (age < 8 * 60 * 1000) return res.status(409).json({ error: 'upgrade already in progress - watch the countdown' });
  } catch {}
  try { fs.writeFileSync(lockFile, String(Date.now())); } catch {}
  // Sync to origin/main explicitly: local HEAD may lag if the host pulled
  // concurrently (or lead nowhere) - building stale code causes pointless recycles.
  try {
    await sh('git fetch origin', REPO_DIR, gitEnv());
    execSync('git reset --hard origin/main', { cwd: REPO_DIR, env: gitEnv() });
  } catch (e) {
    return res.status(500).json({ error: 'fetch failed (panel key on GitHub? git remote SSH?): ' + e.message });
  }
  const pulled = 'synced to origin/main';
    const sha = execSync('git rev-parse --short HEAD', { cwd: REPO_DIR }).toString().trim().replace(/[^a-z0-9]/gi, '');
    // No-suicide rule: NOTHING here may stop this container. The old design ran
    // `up -d` detached from inside the panel itself - compose then killed its own
    // runner mid-recreate, leaving the new container stuck in `Created`.
    // Instead: build in background (safe, old container keeps serving), then drop
    // a flag file. A host cronjob (installed by install-linux.sh) sees the flag and
    // runs `up -d` from OUTSIDE, where nothing can kill it.
    fs.writeFileSync(path.join(REPO_DIR, 'upgrade.log'), `pulled ${sha}, building in background…\n`);
    try { fs.writeFileSync(lockFile, String(Date.now())); } catch {}
    const builder = spawn('sh', ['-c',
      `GIT_SHA=${sha} ${COMPOSE_BIN} -p minipass build >> "${REPO_DIR}/upgrade.log" 2>&1 && ` +
      `echo "${sha}" > "${REPO_DIR}/.pending-restart" && ` +
      `echo "build ok - restart flagged for ${sha}" >> "${REPO_DIR}/upgrade.log" || ` +
      `echo "BUILD FAILED (old panel untouched)" >> "${REPO_DIR}/upgrade.log"`
    ], { cwd: REPO_DIR, detached: true, stdio: 'ignore' });
    builder.unref();
    res.json({ ok: true, pulled: pulled.trim(), target: sha, building: true });
});
app.get('/api/panel/upgrade-log', (req, res) => {
  try {
    if (!REPO_DIR) return res.status(501).send('repo not mounted');
    const log = fs.readFileSync(path.join(REPO_DIR, 'upgrade.log'), 'utf8');
    res.type('text/plain').send(log.split('\n').slice(-40).join('\n'));
  } catch { res.type('text/plain').send('(no upgrade log yet - hit Upgrade first)'); }
});

const server = http.createServer(app);
// Fast graceful shutdown: without this, compose waits the full 10s grace
// then SIGKILLs (exit 137) on every recreate, stretching upgrade downtime.
let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
// Web terminal: xterm.js -> websocket -> script PTY -> docker exec shell.
// `script` supplies the TTY that docker exec -it needs while Node relays pipes.
const wss = new WebSocketServer({ server, path: '/terminal' });
wss.on('connection', (ws, req) => {
  if (!panelAuthed(req)) { try { ws.send('panel login required - sign in and reconnect\r\n'); } catch {} return ws.close(1008, 'login required'); }
  const q = new URL(req.url, 'http://x').searchParams;
  const id = q.get('app');
  const meta = id && load().apps.find(a => a.id === id);
  if (!meta) { ws.send('unknown website\r\n'); return ws.close(1008, 'unknown website'); }
  const service = /^[A-Za-z0-9_-]{1,32}$/.test(q.get('service') || '') ? q.get('service') : 'app';
  const dir = appDir(APPS_DIR, id);
  let cid = '';
  try { cid = execSync(`${COMPOSE_BIN} ps -q ${service}`, { cwd: dir }).toString().trim().split('\n')[0]; }
  catch {}
  if (!cid) { ws.send('container not running - deploy or start this service first\r\n'); return ws.close(); }
  if (!/^[a-f0-9]{12,64}$/i.test(cid)) { ws.send('invalid container id\r\n'); return ws.close(1011, 'invalid container id'); }
  const command = `docker exec -it -e TERM=xterm-256color ${cid} /bin/sh`;
  const p = spawn('script', ['-q', '-f', '-e', '-c', command, '/dev/null'], { cwd: dir });
  const send = d => { if (ws.readyState === 1) ws.send(d.toString()); };
  p.stdout.on('data', send);
  p.stderr.on('data', send);
  p.stdin.on('error', () => {});
  p.on('error', e => {
    send(`terminal failed to start: ${e.message}\r\n`);
    if (ws.readyState === 1) ws.close(1011, 'terminal failed to start');
  });
  p.on('close', code => {
    send(`\r\nterminal exited${code ? ` (${code})` : ''}\r\n`);
    if (ws.readyState === 1) ws.close(1000, 'shell exited');
  });
  ws.on('message', m => { if (!p.stdin.destroyed && p.stdin.writable) p.stdin.write(m); });
  ws.on('close', () => { if (!p.killed) p.kill(); });
});

server.listen(PORT, () => console.log(`minipaas on :${PORT}, apps in ${APPS_DIR}`));
