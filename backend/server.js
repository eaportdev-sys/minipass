const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { exec, execSync, spawn } = require('child_process');
const http = require('http');
const { WebSocketServer } = require('ws');
const { createApp, appDir, normDbs, dbService, nginxConf } = require('./lib/generator');
const { gitEnv, pubKey, appPubKey, appGitEnv } = require('./lib/ssh');
const svc = require('./lib/services');

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
    let explicitBranch = String(req.body.branch || '').trim() || null;
    if (explicitBranch && !/^[A-Za-z0-9._\/-]+$/.test(explicitBranch)) {
      return res.status(400).json({ error: `bad branch name '${explicitBranch}'` });
    }
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
        const br = explicitBranch || info.default_branch;
        const c = await gh.apiWith(siteToken, `/repos/${parts[0]}/${parts[1]}/commits/${encodeURIComponent(br)}`);
        head = c && c.sha;
      } catch {}
      finalRepoUrl = info.clone_url;
      ghLink = { repo: info.full_name, branch: explicitBranch || info.default_branch, login: me.login, sha: head, pollMinutes: 5, token: siteToken };
    } else if (siteToken && finalRepoUrl) {
      const m = finalRepoUrl.match(/github\.com[:/]([^/]+)\/([^/]+?)(\.git)?\/?$/i);
      if (m) ghLink = { repo: `${m[1]}/${m[2]}`, branch: explicitBranch, login: null, sha: null, pollMinutes: 5, token: siteToken };
      else siteToken = null;
    }
    const dbs = normDbs(req.body.dbs !== undefined ? req.body.dbs : db);
    const subdir = String(req.body.subdir || '').replace(/^\/+|\/+$/g, '').replace(/\.\./g, '') || '';
    const created = createApp({ appsDir: APPS_DIR, templatesDir: TEMPLATES_DIR, name: id, type, repoUrl: finalRepoUrl, db: dbs, port, domain, hostPort, gitToken: siteToken, subdir, gitBranch: explicitBranch });
    const db_ = load();
    const meta = { id, type, repoUrl: finalRepoUrl, github: ghLink, db: dbs, domain: domain || '', token, hostPort, subdir: created.subdir || '', createdAt: new Date().toISOString() };
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
    // build async so UI returns fast (goes through deploy() so it lands in deploy.log)
    deploy(id).catch(e => console.error(id, e.message));
    res.json({ ...pubApp(meta), localUrl: `http://localhost:${hostPort}`, webhook: `/webhook/${id}?token=${token}`, webhookNote });
  } catch (e) { res.status(500).json({ error: redactUrl(e.message) }); }
});

const redactUrl = s => String(s).replace(/x-access-token:[^@]+@/g, 'x-access-token:***@');
const deployLocks = new Set();
async function currentSha(dir) {
  try {
    const code = path.join(dir, 'code');
    // require code's OWN .git - otherwise rev-parse walks up into the panel repo
    if (!fs.existsSync(path.join(code, '.git'))) return null;
    return execSync('git rev-parse --short HEAD', { cwd: code }).toString().trim();
  } catch { return null; }
}
async function recordDeploy(id, rec) {
  try {
    const db2 = load();
    const m = db2.apps.find(a => a.id === id);
    if (m) { m.lastDeploy = rec; save(db2); }
  } catch {}
}
// Auto-detect the landing path when the user hasn't set one: first non-404 among
// common health/index routes (401/403 count - the route exists, only auth blocks it).
// Probes from inside the app's own compose network, so no published ports are needed.
async function autodetectHome(id) {
  try {
    const dir = appDir(APPS_DIR, id);
    const fresh = load().apps.find(a => a.id === id);
    if (!fresh || fresh.homePath) return;
    const env = parseEnvFile(path.join(dir, '.env'));
    const cport = parseInt(env.PORT, 10) || 3000;
    const net = `${id}_default`;
    const cands = ['/health/live', '/health/ready', '/health', '/api/health', '/api', '/v1', '/'];
    for (let round = 0; round < 6; round++) {
      if (round) await new Promise(r => setTimeout(r, 5000));
      for (const p of cands) {
        try {
          const code = execSync(
            `docker run --rm --network ${net} curlimages/curl:latest -s -o /dev/null -w "%{http_code}" --max-time 5 http://app:${cport}${p}`,
            { timeout: 25000 }).toString().trim();
          if (/^[234]/.test(code) || code === '401' || code === '403') {
            if (p === '/') return; // default already - nothing to store
            const db3 = load();
            const m3 = db3.apps.find(a => a.id === id);
            if (m3 && !m3.homePath) { m3.homePath = p; save(db3); }
            return;
          }
        } catch {}
      }
    }
  } catch (e) { console.error(id, 'autodetect:', e.message); }
}
async function deploy(id) {
  // one build per app at a time: overlapping `up --build` runs fight over
  // container names and lose ("is already in use")
  if (deployLocks.has(id)) throw new Error('deploy already in progress - wait for it to finish');
  deployLocks.add(id);
  try {
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
  // every build streams to deploy.log (host-persisted, per app) so the UI can show
  // the builder output; failures return the tail instead of a bare exit code.
  // --remove-orphans: disabled/removed services actually disappear.
  const buildLog = path.join(dir, 'deploy.log');
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
      const ctx = path.join(codeDir, f.subdir || '');
      const df = path.join(ctx, 'Dockerfile');
      if (fs.existsSync(df)) {
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
      } else if (cur.includes('# minipass-managed') && (cur.includes('location /api/') !== !!wantProxy)) {
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
  const sha = await currentSha(dir);
  const stamp = () => new Date().toISOString();
  try {
    await sh(`${COMPOSE_BIN} up --build -d --remove-orphans > "${buildLog}" 2>&1`, dir);
  } catch (e) {
    let tail = '';
    try { tail = fs.readFileSync(buildLog, 'utf8').split('\n').slice(-25).join('\n'); } catch {}
    await recordDeploy(id, { sha, at: stamp(), status: 'error', error: (tail || e.message).trim().slice(-500) });
    throw new Error((tail || e.message).trim());
  }
  await recordDeploy(id, { sha, at: stamp(), status: 'ok' });
  autodetectHome(id).catch(e => console.error(id, e.message));
  return true;
  } finally {
    deployLocks.delete(id);
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
  const meta = load().apps.find(a => a.id === req.params.id);
  if (!meta) return res.status(404).json({ error: 'unknown app' });
  res.json({ app: pubApp(meta), lastDeploy: meta.lastDeploy || null, containers: await appContainers(meta.id) });
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
    for (const p of ['/health/live', '/health/ready', '/health', '/api/health', '/api', '/v1', '/']) {
      try {
        const code = execSync(`docker run --rm --network ${net} curlimages/curl:latest -s -o /dev/null -w "%{http_code}" --max-time 5 http://app:${cport}${p}`, { timeout: 15000 }).toString().trim();
        probed.push(`${p}→${code}`);
        if (/^[234]/.test(code) || code === '401' || code === '403') {
          checks.push({ name: 'landing', status: 'ok', detail: `first live route: ${p} (${code})${meta.homePath && meta.homePath !== p ? ` - open path set to ${meta.homePath}` : ''}` });
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
  const fails = checks.filter(c => c.status === 'fail').length;
  const warns = checks.filter(c => c.status === 'warn').length;
  res.json({ app: meta.id, checks, summary: fails ? `${fails} fail${warns ? `, ${warns} warn` : ''}` : (warns ? `${warns} warn` : 'all clear') });
});

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
// Stack detection. Token-first and pool-NEVER: the create flow always carries its
// own fresh token, so a revoked pool credential can never poison detection.
async function detectRepo(repo, { login, token } = {}) {
  const m = String(repo || '').match(/^([^/]+)\/([^/]+?)(\.git)?$/);
  if (!m) throw new Error('repo must be owner/name');
  if (!token && !login) throw new Error('paste a token first - detection never uses stored accounts');
  const get = token
    ? (p) => gh.apiWith(token, p)
    : (p) => gh.apiAs(login, p);
  const t = await get(`/repos/${m[1]}/${m[2]}/git/trees/HEAD?recursive=1`)
    .catch(e => { throw new Error('cannot read repo (token access?): ' + e.message); });
  const tree = (t.tree || []).filter(e => e.type === 'blob').map(e => e.path);
  let pkg = null;
  const pkgPath = tree.filter(p => /(^|\/)package\.json$/.test(p)).sort((a, b) => a.length - b.length)[0];
  if (pkgPath) {
    try {
      const blob = await get(`/repos/${m[1]}/${m[2]}/contents/${pkgPath}`);
      if (blob && blob.content) pkg = JSON.parse(Buffer.from(blob.content, 'base64').toString('utf8'));
    } catch {}
  }
  const { decideType, expandWorkspaces, matchWorkspaces, findBackends } = require('./lib/detect');
  const out = decideType(tree, pkg);
  // monorepo sub-apps, tool-agnostic: vite heuristic + workspace manifests
  // (npm workspaces, pnpm-workspace.yaml, lerna.json, turbo/nx conventions)
  out.frontends = [];
  const readText = async (p) => {
    try {
      const b = await get(`/repos/${m[1]}/${m[2]}/contents/${p}`);
      return b && b.content ? Buffer.from(b.content, 'base64').toString('utf8') : null;
    } catch { return null; }
  };
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
  // backend homes: subdirs with runnable package.json that aren't frontends
  out.backends = [];
  try {
    const pkgDirs = [...new Set(tree.filter(p => /(^|\/)package\.json$/.test(p))
      .map(p => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : ''))
      .filter(d => d && d.split('/').length <= 2 && !out.frontends.includes(d)))].slice(0, 8);
    const pkgs = {};
    for (const d of pkgDirs) {
      try {
        const blob = await get(`/repos/${m[1]}/${m[2]}/contents/${d}/package.json`);
        if (blob && blob.content) pkgs[d] = JSON.parse(Buffer.from(blob.content, 'base64').toString('utf8'));
      } catch { pkgs[d] = null; }
    }
    out.backends = findBackends(tree, pkgs);
  } catch {}
  return out;
}
app.get('/api/github/detect', async (req, res) => {
  try { res.json({ ...(await detectRepo(req.query.repo, { login: req.query.login })), via: 'account' }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/github/detect', async (req, res) => {
  try { res.json({ ...(await detectRepo(req.body.repo, { login: req.body.login, token: req.body.token })), via: 'token' }); }
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
// Services: one folder runs N of them (api + web + ...). Add/remove/toggle,
// compose regenerates (enabled only, `up --remove-orphans` cleans the rest).
function hostPortsInUse() {
  const used = new Set();
  try {
    for (const a of load().apps) {
      if (a.hostPort) used.add(a.hostPort);
      for (const s of (a.services || [])) if (s.hostPort) used.add(s.hostPort);
    }
  } catch {}
  return used;
}
app.get('/api/apps/:id/services', (req, res) => {
  const meta = load().apps.find(a => a.id === req.params.id);
  if (!meta) return res.status(404).json({ error: 'unknown app' });
  res.json({ services: svc.fullServices(meta, appDir(APPS_DIR, meta.id)) });
});
app.post('/api/apps/:id/services', async (req, res) => {
  try {
    const db_ = load();
    const meta = db_.apps.find(a => a.id === req.params.id);
    if (!meta) return res.status(404).json({ error: 'unknown app' });
    const dir = appDir(APPS_DIR, meta.id);
    const name = String((req.body && req.body.name) || '').trim().toLowerCase();
    const type = String((req.body && req.body.type) || '').trim();
    const subdir = String((req.body && req.body.subdir) || '').replace(/^\/+|\/+$/g, '').replace(/\.\./g, '');
    if (!svc.validSvcName(name) || name === 'app') return res.status(400).json({ error: 'bad service name (lowercase letters/numbers/dashes, not "app")' });
    if (!['static', 'react', 'node', 'php'].includes(type)) return res.status(400).json({ error: 'bad type' });
    if (!fs.existsSync(path.join(dir, 'code', subdir))) return res.status(400).json({ error: `subfolder '${subdir}' not in repo - push it first? (empty means repo root, already taken here)` });
    const services = svc.fullServices(meta, dir);
    if (services.some(s => s.name === name)) return res.status(400).json({ error: 'service name taken' });
    if (services.some(s => (s.subdir || '') === subdir)) return res.status(400).json({ error: 'that folder already runs as ' + services.find(s => (s.subdir || '') === subdir).name });
    const { inferPort, TYPE_PORT } = require('./lib/generator');
    const port = inferPort(path.join(dir, 'code', subdir), TYPE_PORT[type] || 3000);
    const used = hostPortsInUse();
    let hostPort = 8000;
    while (used.has(hostPort) && hostPort < 9000) hostPort++;
    used.add(hostPort);
    meta.services = [...services, { name, subdir, type, port, hostPort, enabled: true }];
    const out = svc.renderProject({ dir, templatesDir: TEMPLATES_DIR, meta });
    meta.services = out.normalized;
    save(db_);
    try { await deploy(meta.id); } catch (e) { return res.json({ ok: true, added: name, redeployError: e.message }); }
    res.json({ ok: true, added: name, redeployed: true });
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
    const r = await detectRepo(`${m[1]}/${m[2]}`, { login: meta.github && meta.github.login, token: meta.github && meta.github.token });
    const have = new Set(svc.fullServices(meta, appDir(APPS_DIR, meta.id)).map(s => s.subdir || ''));
    res.json({
      suggestions: (r.frontends || []).filter(f => !have.has(f)),
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
    try {
      fs.appendFileSync(path.join(dir, '.env.managed'), fresh.map(l => l.split('=')[0]).join('\n') + '\n');
    } catch {}
    meta.db = [...current, type];
    save(db_);
    try { await deploy(meta.id); } catch (e) { return res.json({ ok: true, added: type, redeployError: e.message }); }
    res.json({ ok: true, added: type, redeployed: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// Frontend -> backend wiring: a static/react site proxies same-origin /api/ to another
// app (mirrors the vite dev proxy). Reaches the target through the host gateway, so no
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
      yml = yml.replace(/\n    extra_hosts:\n      - "host\.docker\.internal:host-gateway"\n/, '\n');
      fs.writeFileSync(ymlPath, yml);
      meta.apiBackend = null;
      meta.apiLinkOff = true;
      save(db_);
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
      if (!/extra_hosts:/.test(yml)) {
        yml = yml.replace(/(    env_file: \.env\n)/, '$1    extra_hosts:\n      - "host.docker.internal:host-gateway"\n');
        fs.writeFileSync(ymlPath, yml);
      }
    }
    // the link IS these two env vars - the conf below renders from them
    envSetManaged(dir, { API_HOST: proxy.host, API_PORT: String(proxy.port) });
    fs.writeFileSync(path.join(ctxDir, 'nginx.conf'), nginxConf(proxy));
    meta.apiBackend = { app: label, port: proxy.port, service: front.name };
    delete meta.apiLinkOff;
    save(db_);
    try { await deploy(meta.id); } catch (e) { return res.json({ ok: true, linked: label, redeployError: e.message }); }
    res.json({ ok: true, linked: label, redeployed: true });
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
    save(db_);
    res.json({ ok: true, homePath: meta.homePath });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/apps/:id/stop', async (req, res) => {
  try { await sh(`${COMPOSE_BIN} stop`, appDir(APPS_DIR, req.params.id)); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/apps/:id/start', async (req, res) => {
  try { await sh(`${COMPOSE_BIN} up -d`, appDir(APPS_DIR, req.params.id)); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
// Environment editor: custom keys editable, managed keys (ports, generated creds)
// locked. POST redeploys so containers pick the new env up.
function readEnvVars(envPath) {
  const vars = [];
  try {
    for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
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
    const meta = load().apps.find(a => a.id === req.params.id);
    if (!meta) return res.status(404).json({ error: 'unknown app' });
    const dir = appDir(APPS_DIR, meta.id);
    const managed = managedKeys(dir);
    // managed keys are infrastructure (ports, hosts, generated creds) - read-only,
    // except DOMAIN which is display/future-tunnel metadata. Deleting them is refused too.
    const EDITABLE = new Set(['DOMAIN']);
    const set = (req.body && req.body.set) || {};
    const del = (req.body && req.body.delete) || [];
    for (const k of Object.keys(set)) {
      if (!validKey(k)) return res.status(400).json({ error: 'bad key name: ' + k });
    }
    for (const k of Object.keys(set)) {
      if (!validKey(k)) return res.status(400).json({ error: 'bad key name: ' + k });
    }
    let raw = '';
    try { raw = fs.readFileSync(path.join(dir, '.env'), 'utf8'); } catch {}
    let arr = raw.split('\n');
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
    const skippedAll = [...new Set([...skipped, ...lockedSet])];
    try { await deploy(meta.id); } catch (e) { return res.json({ ok: true, saved: true, skipped: skippedAll, redeployError: e.message }); }
    res.json({ ok: true, saved: true, skipped: skippedAll, redeployed: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
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
// Web terminal: xterm.js -> ws://host/terminal?app=<id>&service=<name> -> docker exec -i
const wss = new WebSocketServer({ server, path: '/terminal' });
wss.on('connection', (ws, req) => {
  const q = new URL(req.url, 'http://x').searchParams;
  const id = q.get('app');
  if (!id) return ws.close();
  const service = /^[A-Za-z0-9_-]{1,32}$/.test(q.get('service') || '') ? q.get('service') : 'app';
  const dir = appDir(APPS_DIR, id);
  let cid = '';
  try { cid = execSync(`${COMPOSE_BIN} ps -q ${service}`, { cwd: dir }).toString().trim().split('\n')[0]; }
  catch {}
  if (!cid) { ws.send('container not running - deploy first\r\n'); return ws.close(); }
  const p = spawn('docker', ['exec', '-i', cid, '/bin/sh'], { cwd: dir });
  p.stdout.on('data', d => ws.send(d.toString()));
  p.stderr.on('data', d => ws.send(d.toString()));
  ws.on('message', m => p.stdin.write(m.toString()));
  ws.on('close', () => p.kill());
});

server.listen(PORT, () => console.log(`minipaas on :${PORT}, apps in ${APPS_DIR}`));
