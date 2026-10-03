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
const DATA_FILE = path.join(__dirname, 'data.json');
fs.mkdirSync(APPS_DIR, { recursive: true });

const app = express();
app.use(cors());
app.use(express.json());
// serve wizard UI (works locally and in docker)
app.use(express.static(FRONTEND_DIR));
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
    createApp({ appsDir: APPS_DIR, templatesDir: TEMPLATES_DIR, name: id, type, repoUrl, db: db || 'none', port, domain });
    const db_ = load();
    const meta = { id, type, repoUrl: repoUrl || '', db: db || 'none', domain: domain || '', token, createdAt: new Date().toISOString() };
    db_.apps = db_.apps.filter(a => a.id !== id).concat([meta]);
    save(db_);
    // build async so UI returns fast
    sh(`${COMPOSE_BIN} up --build -d`, appDir(APPS_DIR, id)).catch(e => console.error(e.message));
    res.json({ ...meta, webhook: `/webhook/${id}?token=${token}` });
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
