const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { exec, execSync, spawn } = require('child_process');
const http = require('http');
const { WebSocketServer } = require('ws');
const { createApp, appDir } = require('./lib/generator');

const PORT = process.env.PORT || 3001;
const APPS_DIR = path.resolve(__dirname, process.env.APPS_DIR || '../apps');
function pickDir(cands) { for (const c of cands) { try { if (fs.existsSync(c)) return c; } catch {} } return cands[0]; }
const TEMPLATES_DIR = pickDir([path.resolve(__dirname, '../templates'), path.join(__dirname, 'templates'), path.join(process.cwd(), 'templates')]);
const FRONTEND_DIR = pickDir([path.resolve(__dirname, '../frontend'), path.join(__dirname, 'frontend'), path.join(process.cwd(), 'frontend')]);
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data.json');
fs.mkdirSync(APPS_DIR, { recursive: true });
fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });

const app = express();
app.use(cors());
app.use(express.json());
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
// Portable compose: prefer `docker compose` (v2), fallback to `docker-compose` (v1).
// Override with COMPOSE_BIN env, e.g. COMPOSE_BIN="docker-compose".
let COMPOSE_BIN = process.env.COMPOSE_BIN || 'docker compose';
try { execSync('docker compose version', { stdio: 'ignore' }); }
catch { try { execSync('docker-compose --version', { stdio: 'ignore' }); COMPOSE_BIN = 'docker-compose'; } catch {} }
function sh(cmd, cwd) {
  return new Promise((res, rej) => {
    exec(cmd, { cwd, maxBuffer: 10 * 1024 * 1024 }, (e, stdout, stderr) => {
      if (e) rej(new Error(stderr || e.message)); else res(stdout);
    });
  });
}

app.get('/api/types', (req, res) => {
  res.json([
    { id: 'static', label: 'Static HTML' },
    { id: 'react', label: 'React (build + serve)' },
    { id: 'node', label: 'Node.js' },
    { id: 'php', label: 'PHP + Apache' }
  ]);
});

app.get('/api/apps', (req, res) => res.json(load().apps));

app.post('/api/apps', async (req, res) => {
  try {
    const { name, type, repoUrl, db, port, domain } = req.body;
    if (!name || !type) return res.status(400).json({ error: 'name and type required' });
    const id = name.toLowerCase().replace(/[^a-z0-9-]/g, '-');
    const token = crypto.randomBytes(16).toString('hex');
    // localhost: auto-assign host port 8000+ so app is reachable without a domain
    const existing = load().apps;
    const used = new Set(existing.map(a => a.hostPort).filter(Boolean));
    let hostPort = parseInt(req.body.hostPort, 10) || 8000;
    while (used.has(hostPort) && hostPort < 9000) hostPort++;
    createApp({ appsDir: APPS_DIR, templatesDir: TEMPLATES_DIR, name: id, type, repoUrl, db: db || 'none', port, domain, hostPort });
    const db_ = load();
    const meta = { id, type, repoUrl: repoUrl || '', db: db || 'none', domain: domain || '', token, hostPort, createdAt: new Date().toISOString() };
    db_.apps = db_.apps.filter(a => a.id !== id).concat([meta]);
    save(db_);
    // build async so UI returns fast
    sh(`${COMPOSE_BIN} up --build -d`, appDir(APPS_DIR, id)).catch(e => console.error(e.message));
    res.json({ ...meta, localUrl: `http://localhost:${hostPort}`, webhook: `/webhook/${id}?token=${token}` });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

async function deploy(id) {
  const dir = appDir(APPS_DIR, id);
  const meta = load().apps.find(a => a.id === id);
  if (meta && meta.repoUrl && fs.existsSync(path.join(dir, 'code', '.git'))) {
    await sh('git pull --ff-only', path.join(dir, 'code'));
  }
  await sh(`${COMPOSE_BIN} up --build -d`, dir);
  return true;
}

app.post('/api/apps/:id/deploy', async (req, res) => {
  try { await deploy(req.params.id); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// Git auto-deploy: GitHub webhook -> this URL. Connect once, push = redeploy.
app.post('/webhook/:id', async (req, res) => {
  const meta = load().apps.find(a => a.id === req.params.id);
  if (!meta || req.query.token !== meta.token) return res.status(401).send('bad token');
  try { await deploy(req.params.id); res.send('deployed'); }
  catch (e) { res.status(500).send(e.message); }
});

app.get('/api/apps/:id/logs', async (req, res) => {
  try {
    const out = await sh(`${COMPOSE_BIN} logs --tail=${req.query.tail || 100}`, appDir(APPS_DIR, req.params.id));
    res.type('text/plain').send(out);
  } catch (e) { res.status(500).send(e.message); }
});

app.delete('/api/apps/:id', async (req, res) => {
  try {
    const dir = appDir(APPS_DIR, req.params.id);
    await sh(`${COMPOSE_BIN} down -v`, dir).catch(() => {});
    fs.rmSync(dir, { recursive: true, force: true });
    const db_ = load();
    db_.apps = db_.apps.filter(a => a.id !== req.params.id);
    save(db_);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

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
      let hostPort = parseInt(env.HOST_PORT, 10);
      if (!hostPort || used.has(hostPort)) {
        hostPort = nextPort;
        while (used.has(hostPort) && hostPort < 9000) hostPort++;
        nextPort = hostPort + 1;
      }
      used.add(hostPort);
      db_.apps.push({
        id: name, type: env.APP_TYPE || 'static', repoUrl: '',
        db: env.DB_HOST ? 'external' : 'none', domain: env.DOMAIN || '',
        token: crypto.randomBytes(16).toString('hex'),
        hostPort, createdAt: new Date().toISOString(), recovered: true
      });
      found.push(name + ' (recovered, new webhook token)');
    }
    save(db_);
    res.json({ ok: true, found, total: db_.apps.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// File manager for apps without git (static default page etc.)
function codeDir(id) { return path.join(appDir(APPS_DIR, id), 'code'); }
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
    if (!st.isFile() || st.size > 200 * 1024) return res.status(400).json({ error: 'not a small text file' });
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
    await deploy(req.params.id);
    res.json({ ok: true, redeployed: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/apps/:id/file', async (req, res) => {
  try {
    const base = codeDir(req.params.id);
    const f = safeRel(base, req.query.path || '');
    if (f === base) return res.status(400).json({ error: 'refusing to delete app root' });
    fs.rmSync(f, { recursive: true, force: true });
    await deploy(req.params.id);
    res.json({ ok: true, redeployed: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
const upload = require('multer')({ dest: '/tmp/minipass-uploads/', limits: { fileSize: 50 * 1024 * 1024 } });
fs.mkdirSync('/tmp/minipass-uploads', { recursive: true });
app.post('/api/apps/:id/upload', upload.single('zip'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'no zip attached (field name: zip)' });
    const code = codeDir(req.params.id);
    const tmpBase = fs.mkdtempSync(path.join('/tmp', 'minipass-extract-'));
    await sh(`unzip -o "${req.file.path}" -d "${tmpBase}"`, '/tmp');
    fs.unlinkSync(req.file.path);
    // smart flatten: descend through single wrapper folders until index.html level (max 3)
    const JUNK = new Set(['__MACOSX', '.DS_Store', 'Thumbs.db']);
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
    await deploy(req.params.id);
    res.json({ ok: true, redeployed: true, files: n, index: hasIndex ? 'index.html' : null, warning });
  } catch (e) { res.status(500).json({ error: e.message }); }
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
  try {
    const pulled = await sh('git pull --ff-only', REPO_DIR);
    const sha = execSync('git rev-parse --short HEAD', { cwd: REPO_DIR }).toString().trim().replace(/[^a-z0-9]/gi, '');
    // rebuild detached with baked sha: panel container restarts, so don't wait for it
    const child = spawn('sh', ['-c', `GIT_SHA=${sha} ${COMPOSE_BIN} up -d --build`], { cwd: REPO_DIR, detached: true, stdio: 'ignore' });
    child.unref();
    res.json({ ok: true, pulled: pulled.trim(), target: sha, restarting: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

const server = http.createServer(app);
// Web terminal: xterm.js -> ws://host/terminal?app=<id> -> docker exec -i
const wss = new WebSocketServer({ server, path: '/terminal' });
wss.on('connection', (ws, req) => {
  const id = new URL(req.url, 'http://x').searchParams.get('app');
  if (!id) return ws.close();
  const dir = appDir(APPS_DIR, id);
  let cid = '';
  try { cid = execSync(`${COMPOSE_BIN} ps -q app`, { cwd: dir }).toString().trim().split('\n')[0]; }
  catch {}
  if (!cid) { ws.send('container not running - deploy first\r\n'); return ws.close(); }
  const p = spawn('docker', ['exec', '-i', cid, '/bin/sh'], { cwd: dir });
  p.stdout.on('data', d => ws.send(d.toString()));
  p.stderr.on('data', d => ws.send(d.toString()));
  ws.on('message', m => p.stdin.write(m.toString()));
  ws.on('close', () => p.kill());
});

server.listen(PORT, () => console.log(`minipaas on :${PORT}, apps in ${APPS_DIR}`));
