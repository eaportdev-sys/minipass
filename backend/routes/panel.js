// panel: extracted from the original backend without changing route semantics.
module.exports = function register(ctx) {
  const { APPS_DIR, COMPOSE_BIN, REPO_DIR, app, crypto, deployLocks, deployQueues, execSync, fs, gitEnv, panelLog, path, pubKey, siteIdentity, spawn } = ctx;
  const load = (...args) => ctx.load(...args);
  const parseEnvFile = (...args) => ctx.parseEnvFile(...args);
  const save = (...args) => ctx.save(...args);
  const sh = (...args) => ctx.sh(...args);
app.get('/api/panel/pubkey', (req, res) => {
  const k = pubKey();
  if (!k) return res.status(500).json({ error: 'no panel key (ssh-keygen unavailable?)' });
  res.json({ pubkey: k });
});

app.get('/api/panel/errors', (req, res) => {
  try { res.json(panelLog.readErrors(load().apps, req.query.limit)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

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
  // A restart now would orphan any running site deploy (in-memory queues die
  // with this container, leaving a stale status). Refuse while deploys are
  // queued or running; the host-side job defers the same way via markers.
  if (deployLocks.size > 0 || deployQueues.size > 0) return res.status(409).json({ error: 'site deploy in progress - upgrade when it finishes' });
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
};
