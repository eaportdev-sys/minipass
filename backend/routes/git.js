// git: extracted from the original backend without changing route semantics.
module.exports = function register(ctx) {
  const { APPS_DIR, AUTO_DEPLOY, PORT, TEMPLATES_DIR, app, appDir, appGitEnv, deployLocks, deployQueues, execFileSync, execSync, fs, gh, path, pushEvents, redactUrl } = ctx;
  const codeDir = (...args) => ctx.codeDir(...args);
  const detectRepo = (...args) => ctx.detectRepo(...args);
  const firstSyncClone = (...args) => ctx.firstSyncClone(...args);
  const load = (...args) => ctx.load(...args);
  const markDirty = (...args) => ctx.markDirty(...args);
  const save = (...args) => ctx.save(...args);
  const setGithubAutomation = (...args) => ctx.setGithubAutomation(...args);
  const sh = (...args) => ctx.sh(...args);
app.post('/api/apps/:id/poll', (req, res) => {
  try {
    const db_ = load();
    const meta = db_.apps.find(a => a.id === req.params.id);
    if (!meta) return res.status(404).json({ error: 'unknown app' });
    if (!AUTO_DEPLOY && parseInt(req.body.minutes, 10) > 0) return res.status(409).json({ error: 'automatic deploy disabled for now' });
    if (!meta.github) return res.status(400).json({ error: 'link a github repo first' });
    if (meta.github.enabled !== true) return res.status(409).json({ error: 'enable github automation first' });
    meta.github.pollMinutes = Math.max(0, Math.min(60, parseInt(req.body.minutes, 10) || 0));
    save(db_);
    res.json({ ok: true, pollMinutes: meta.github.pollMinutes });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

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
  // Credentials resolve per-site (stored site token first), so a token-only
  // site can link or relink without a panel account - e.g. after a token
  // change. The stored token and automation settings are preserved.
  try {
    const { appId, repo, login } = req.body;
    const parts = String(repo || '').split('/');
    if (parts.length !== 2 || !parts[0] || !parts[1]) return res.status(400).json({ error: 'repo must be owner/name' });
    const db_ = load();
    const meta = db_.apps.find(a => a.id === appId);
    if (!meta) return res.status(404).json({ error: 'unknown app' });
    const trimmedLogin = String(login || '').trim();
    if (trimmedLogin && !gh.getAuth(trimmedLogin)) return res.status(400).json({ error: 'account not connected: ' + trimmedLogin });
    const prev = (meta.github && typeof meta.github === 'object') ? meta.github : {};
    const probe = { github: { token: prev.token || null, login: trimmedLogin || prev.login || null } };
    const info = await gh.apiFor(probe, `/repos/${parts[0]}/${parts[1]}`);
    let head = null;
    try {
      const c = await gh.apiFor(probe, `/repos/${parts[0]}/${parts[1]}/commits/${encodeURIComponent(info.default_branch)}`);
      head = c && c.sha;
    } catch {}
    meta.repoUrl = info.clone_url;
    meta.github = { ...prev, repo: info.full_name, branch: info.default_branch, login: trimmedLogin || prev.login || null, sha: head,
      pollMinutes: typeof prev.pollMinutes === 'number' ? prev.pollMinutes : 0, enabled: !!prev.enabled };
    save(db_);
    // Connect downloads the code like create does: fresh clone when no checkout
    // exists yet. Existing checkouts are left alone - redeploy pulls updates.
    // No containers are touched here; builds stay manual.
    let pulled = false, codePresent = false, pullNote = null;
    const siteDir = appDir(APPS_DIR, meta.id);
    const codeDir = path.join(siteDir, 'code');
    if (!meta.repoUrl) { pullNote = 'no repository url stored'; }
    else if (fs.existsSync(path.join(codeDir, '.git'))) {
      codePresent = true;
      if (prev.repo && prev.repo !== info.full_name) pullNote = 'code on disk is from ' + prev.repo + ' - redeploy pulls ' + info.full_name;
    } else {
      const isSsh = /^(git@|ssh:\/\/)/i.test(meta.repoUrl);
      const credToken = (probe.github && probe.github.token) || null;
      const url = isSsh ? meta.repoUrl : (credToken ? gh.authUrlFor({ github: { token: credToken } }, meta.repoUrl) : meta.repoUrl);
      try {
        firstSyncClone({ codeDir, templatesDir: TEMPLATES_DIR, type: meta.type, url, env: isSsh ? appGitEnv(siteDir) : process.env });
        pulled = true;
      } catch (e) { pullNote = 'download failed: ' + redactUrl(e.stderr ? String(e.stderr) : e.message).slice(-300); }
    }
    if (pulled) await markDirty(meta.id, 'repository downloaded');
    res.json({ ok: true, repoUrl: meta.repoUrl, pulled, codePresent, pullNote, automation: false, webhook: 'disabled until enabled on the site deploy page' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/apps/:id/git-init', (req, res) => {
  try {
    if (!AUTO_DEPLOY) return res.status(409).json({ error: 'automatic deploy disabled for now' });
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

app.post('/api/apps/:id/git-account', async (req, res) => {
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
    const repo = meta.github.repo || null;
    let verified = false, verifyError = null;
    if (repo && login) {
      try { await gh.apiAs(login, `/repos/${repo}`); verified = true; }
      catch (e) { verifyError = e.message; }
    }
    res.json({ ok: true, repo, verified, ...(verifyError ? { verifyError } : {}) });
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
    // Run the connection, not just store it: prove the new token can read
    // the linked repo now, instead of failing silently at the next redeploy.
    const repo = meta.github.repo || null;
    let verified = false, verifyError = null;
    if (repo) {
      try { await gh.apiWith(token, `/repos/${repo}`); verified = true; }
      catch (e) { verifyError = e.message; }
    }
    res.json({ ok: true, repo, verified, ...(verifyError ? { verifyError } : {}) });
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

app.post('/api/apps/:id/git-repos', async (req, res) => {
  // Repos the site's own credentials can see (site token first, then linked
  // account) - pick one instead of typing owner/name.
  try {
    const meta = load().apps.find(a => a.id === req.params.id);
    if (!meta) return res.status(404).json({ error: 'unknown app' });
    if (!gh.tokenFor(meta)) return res.status(400).json({ error: 'save a site token or connect an account first' });
    const repos = await gh.apiFor(meta, '/user/repos?per_page=100&sort=updated');
    res.json({ repos: repos.map(r => ({ full_name: r.full_name, private: !!r.private, default_branch: r.default_branch })) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/apps/:id/github/automation', (req, res) => setGithubAutomation(req, res));

app.post('/api/apps/:id/github/unlink', (req, res) => setGithubAutomation(req, res, false));

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
};
