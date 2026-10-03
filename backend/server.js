const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { exec, execSync, spawn } = require('child_process');
const http = require('http');
const { WebSocketServer } = require('ws');
const { createApp, appDir, normDbs, dbService } = require('./lib/generator');
const { gitEnv, pubKey, appPubKey, appGitEnv } = require('./lib/ssh');

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
// GitHub push webhook FIRST with a raw body: HMAC verification needs exact bytes,
// and the global json parser would already have consumed them.
const gh = require('./lib/github');
app.post('/webhook/:id', express.raw({ type: '*/*' }), async (req, res) => {
  const meta = load().apps.find(a => a.id === req.params.id);
  if (!meta || req.query.token !== meta.token) return res.status(401).send('bad token');
  const sig = req.headers['x-hub-signature-256'];
  if (sig && meta.github) {
    const expect = 'sha256=' + crypto.createHmac('sha256', meta.token).update(req.body).digest('hex');
    const ok = sig.length === expect.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect));
    if (!ok) return res.status(401).send('bad signature');
  }
  try { await deploy(req.params.id); } catch (e) { return res.status(500).send(e.message); }
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
  const pub = g ? { repo: g.repo, branch: g.branch, login: g.login, sha: g.sha, pollMinutes: g.pollMinutes, hasToken: !!g.token } : g;
  return { ...a, github: pub };
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
    if (!g || !g.repo || !(g.pollMinutes > 0)) continue;
    if (now - (pollState.get(meta.id) || 0) < g.pollMinutes * 60 * 1000) continue;
    pollState.set(meta.id, now);
    try {
      const parts = String(g.repo).split('/');
      const c = await gh.apiFor(meta, `/repos/${parts[0]}/${parts[1]}/commits/${encodeURIComponent(g.branch || 'main')}`);
      const sha = c && c.sha;
      if (!sha || sha === g.sha) continue;
      await deploy(meta.id);
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

app.get('/api/apps', (req, res) => res.json(load().apps.map(pubApp)));

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
    // site-owned git connection: fresh token per build, validated BEFORE anything
    // is created, stored on the site only - never the shared pool.
    let finalRepoUrl = repoUrl || '';
    let siteToken = String(req.body.gitToken || '').trim() || null;
    let ghLink = null;
    const ghRepo = req.body.ghRepo;
    if (ghRepo && ghRepo.repo) {
      if (!siteToken) return res.status(400).json({ error: 'repo picked but no site token pasted' });
      const me = await gh.apiWith(siteToken, '/user')
        .catch(() => { throw new Error('site token rejected by github - regenerate and repaste'); });
      const parts = String(ghRepo.repo).split('/');
      const info = await gh.apiWith(siteToken, `/repos/${parts[0]}/${parts[1]}`)
        .catch(() => { throw new Error('token cannot read ' + ghRepo.repo + ' - check repo access on the token'); });
      let head = null;
      try {
        const c = await gh.apiWith(siteToken, `/repos/${parts[0]}/${parts[1]}/commits/${encodeURIComponent(info.default_branch)}`);
        head = c && c.sha;
      } catch {}
      finalRepoUrl = info.clone_url;
      ghLink = { repo: info.full_name, branch: info.default_branch, login: me.login, sha: head, pollMinutes: 5, token: siteToken };
    } else if (siteToken && finalRepoUrl) {
      const m = finalRepoUrl.match(/github\.com[:/]([^/]+)\/([^/]+?)(\.git)?\/?$/i);
      if (m) ghLink = { repo: `${m[1]}/${m[2]}`, branch: null, login: null, sha: null, pollMinutes: 5, token: siteToken };
      else siteToken = null;
    }
    const dbs = normDbs(req.body.dbs !== undefined ? req.body.dbs : db);
    createApp({ appsDir: APPS_DIR, templatesDir: TEMPLATES_DIR, name: id, type, repoUrl: finalRepoUrl, db: dbs, port, domain, hostPort, gitToken: siteToken });
    const db_ = load();
    const meta = { id, type, repoUrl: finalRepoUrl, github: ghLink, db: dbs, domain: domain || '', token, hostPort, createdAt: new Date().toISOString() };
    db_.apps = db_.apps.filter(a => a.id !== id).concat([meta]);
    save(db_);
    // auto webhook for site-token links (best effort - needs PANEL_URL reachable)
    let webhookNote = 'manual - paste the webhook URL into repo Settings → Webhooks';
    const base = (process.env.PANEL_URL || '').replace(/\/$/, '');
    if (ghLink && ghLink.repo && siteToken && base) {
      try {
        const [o, n] = ghLink.repo.split('/');
        await gh.apiWith(siteToken, `/repos/${o}/${n}/hooks`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: 'web', active: true, events: ['push'],
            config: { url: `${base}/webhook/${id}?token=${token}`, content_type: 'json', secret: token, insecure_ssl: '0' }
          })
        });
        webhookNote = 'auto-created - push to deploy';
      } catch {}
    }
    // build async so UI returns fast
    sh(`${COMPOSE_BIN} up --build -d`, appDir(APPS_DIR, id)).catch(e => console.error(e.message));
    res.json({ ...pubApp(meta), localUrl: `http://localhost:${hostPort}`, webhook: `/webhook/${id}?token=${token}`, webhookNote });
  } catch (e) { res.status(500).json({ error: redactUrl(e.message) }); }
});

const redactUrl = s => String(s).replace(/x-access-token:[^@]+@/g, 'x-access-token:***@');
async function deploy(id) {
  const dir = appDir(APPS_DIR, id);
  const meta = load().apps.find(a => a.id === id);
  const codeDir = path.join(dir, 'code');
  if (meta && meta.repoUrl) {
    const isSsh = /^(git@|ssh:\/\/)/i.test(meta.repoUrl);
    const url = isSsh ? meta.repoUrl : gh.authUrlFor(meta, meta.repoUrl);
    const env = isSsh ? appGitEnv(dir) : process.env;
    try {
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
        await sh(`git pull --ff-only "${url}" "${branch}"`, codeDir, env);
      }
    } catch (e) {
      throw new Error(redactUrl(e.stderr ? String(e.stderr) : e.message));
    }
  }
  await sh(`${COMPOSE_BIN} up --build -d`, dir);
  return true;
}

app.post('/api/apps/:id/deploy', async (req, res) => {
  try { await deploy(req.params.id); res.json({ ok: true }); }
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
app.get('/api/github/detect', async (req, res) => {
  // ?repo=owner/name&login= - inspect tree + package.json, auto-select the template
  try {
    const m = String(req.query.repo || '').match(/^([^/]+)\/([^/]+?)(\.git)?$/);
    if (!m) return res.status(400).json({ error: 'repo must be owner/name' });
    const logins = req.query.login ? [req.query.login] : gh.getLogins();
    if (!logins.length) return res.status(500).json({ error: 'github not connected' });
    let tree = null, used = null, lastErr = 'no access';
    for (const login of logins) {
      try {
        const t = await gh.apiAs(login, `/repos/${m[1]}/${m[2]}/git/trees/HEAD?recursive=1`);
        tree = (t.tree || []).filter(e => e.type === 'blob').map(e => e.path);
        used = login;
        break;
      } catch (e) { lastErr = e.message; }
    }
    if (!tree) return res.status(500).json({ error: 'cannot read repo: ' + lastErr });
    let pkg = null;
    const pkgPath = tree.filter(p => /(^|\/)package\.json$/.test(p)).sort((a, b) => a.length - b.length)[0];
    if (pkgPath) {
      try {
        const blob = await gh.apiAs(used, `/repos/${m[1]}/${m[2]}/contents/${pkgPath}`);
        if (blob && blob.content) pkg = JSON.parse(Buffer.from(blob.content, 'base64').toString('utf8'));
      } catch {}
    }
    const { decideType } = require('./lib/detect');
    res.json({ ...decideType(tree, pkg), login: used });
  } catch (e) { res.status(500).json({ error: e.message }); }
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
  // { appId, repo: "owner/name", login? } -> set repoUrl + auto-create push webhook
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
    meta.github = { repo: info.full_name, branch: info.default_branch, login: acct && acct.login, sha: head, pollMinutes: 5 };
    save(db_);
    const base = (process.env.PANEL_URL || '').replace(/\/$/, '');
    if (base) {
      try {
        await gh.apiAs(login || (meta.github && meta.github.login) || undefined, `/repos/${parts[0]}/${parts[1]}/hooks`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: 'web', active: true, events: ['push'],
            config: { url: `${base}/webhook/${meta.id}?token=${meta.token}`, content_type: 'json', secret: meta.token, insecure_ssl: '0' }
          })
        });
        return res.json({ ok: true, repoUrl: meta.repoUrl, webhook: 'auto-created - push to deploy' });
      } catch (e) { /* panel unreachable from github or no hook rights: manual flow still works */ }
    }
    res.json({ ok: true, repoUrl: meta.repoUrl, webhook: 'manual - paste the webhook URL into repo Settings → Webhooks' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// Push-to-deploy: bare repo per app on the host. `git push` to it checks out
// into code/ and triggers a rebuild - no GitHub needed on localhost/LAN.
app.post('/api/apps/:id/git-init', (req, res) => {
  try {
    const id = req.params.id;
    const dir = appDir(APPS_DIR, id);
    if (!fs.existsSync(path.join(dir, 'docker-compose.yml'))) return res.status(404).json({ error: 'unknown app' });
    const repo = path.join(dir, 'repo.git');
    const port = process.env.PORT || PORT;
    if (!fs.existsSync(repo)) execSync(`git init --bare "${repo}"`, { stdio: 'ignore' });
    const hook = `#!/bin/sh\n# minipass push-to-deploy: checkout pushed branch into code/, rebuild\nif GIT_WORK_TREE="${path.join(dir, 'code')}" git --git-dir="${repo}" checkout -f main 2>/dev/null; then\n  :\nelse\n  GIT_WORK_TREE="${path.join(dir, 'code')}" git --git-dir="${repo}" checkout -f master\nfi\ncurl -s -X POST http://localhost:${port}/api/apps/${id}/deploy >/dev/null\n`;
    fs.writeFileSync(path.join(repo, 'hooks', 'post-receive'), hook);
    fs.chmodSync(path.join(repo, 'hooks', 'post-receive'), 0o755);
    const db_ = load();
    const meta = db_.apps.find(a => a.id === id);
    if (meta) { meta.localGit = true; save(db_); }
    res.json({ ok: true, remote: `ssh://root@<server>:${path.join(dir, 'repo.git')}` });
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
    else out = out.replace(/^(volumes:\n(?:  [^\n]+\n?)*)/m, `$1  ${b.vol}:\n`);
    fs.writeFileSync(ymlPath, out);
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
    meta.db = [...current, type];
    save(db_);
    try { await deploy(meta.id); } catch (e) { return res.json({ ok: true, added: type, redeployError: e.message }); }
    res.json({ ok: true, added: type, redeployed: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
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
    const out = await sh(`${COMPOSE_BIN} logs --tail=${req.query.tail || 100}`, appDir(APPS_DIR, req.params.id));
    res.type('text/plain').send(out);
  } catch (e) { res.status(500).send(e.message); }
});

app.post('/api/apps/:id/stop', async (req, res) => {
  try { await sh(`${COMPOSE_BIN} stop`, appDir(APPS_DIR, req.params.id)); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/apps/:id/start', async (req, res) => {
  try { await sh(`${COMPOSE_BIN} up -d`, appDir(APPS_DIR, req.params.id)); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
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
      const detected = ['postgres', 'mysql', 'mongo', 'redis'].filter(t => env[t.toUpperCase() + '_HOST']);
      const dbLabel = detected.length ? detected : (env.DB_HOST ? ['external'] : []);
      let hostPort = parseInt(env.HOST_PORT, 10);
      if (!hostPort || used.has(hostPort)) {
        hostPort = nextPort;
        while (used.has(hostPort) && hostPort < 9000) hostPort++;
        nextPort = hostPort + 1;
      }
      used.add(hostPort);
      db_.apps.push({
        id: name, type: env.APP_TYPE || 'static', repoUrl: '',
        db: dbLabel, domain: env.DOMAIN || '',
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
  } catch (e) { return res.status(500).json({ error: e.message }); }
  try { await deploy(req.params.id); res.json({ ok: true, redeployed: true }); }
  catch (e) { res.json({ ok: true, saved: true, redeployError: e.message }); }
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
