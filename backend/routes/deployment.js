// deployment: extracted from the original backend without changing route semantics.
module.exports = function register(ctx) {
  const { APPS_DIR, AUTO_DEPLOY, app, appDir, deployLocks, deployOps, fs, path, pushEvents, store } = ctx;
  const appContainers = (...args) => ctx.appContainers(...args);
  const deploy = (...args) => ctx.deploy(...args);
  const load = (...args) => ctx.load(...args);
  const pubApp = (...args) => ctx.pubApp(...args);
  const publicServices = (...args) => ctx.publicServices(...args);
  const save = (...args) => ctx.save(...args);
app.get('/api/apps/:id/build-log', (req, res) => {
  const tail = Math.max(10, Math.min(500, parseInt(req.query.tail, 10) || 80));
  try {
    const log = fs.readFileSync(path.join(appDir(APPS_DIR, req.params.id), 'deploy.log'), 'utf8');
    const lines = log.split('\n');
    const slice = lines.slice(-tail).join('\n') || '(empty build log)';
    res.type('text/plain').send(lines.length > tail ? `… showing last ${tail} of ${lines.length} lines (add ?tail=500 for all)\n\n${slice}` : slice);
  } catch { res.type('text/plain').send('(no builds recorded yet)'); }
});

app.get('/api/apps/:id/events', (req, res) => {
  const meta = load().apps.find(a => a.id === req.params.id);
  if (!meta) return res.status(404).json({ error: 'unknown app' });
  res.json({ events: store.siteEvents(meta.id, req.query.limit) });
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

app.post('/api/apps/:id/deploy', async (req, res) => {
  try {
    if ((req.body && req.body.source) === 'local-push' && !AUTO_DEPLOY) return res.status(409).json({ error: 'automatic deploy disabled for now' });
    const only = Array.isArray(req.body && req.body.services)
      ? [...new Set(req.body.services.filter(s => /^[A-Za-z0-9_-]{1,32}$/.test(s || '')))]
      : [];
    const source = ['manual', 'local', 'local-push'].includes(req.body && req.body.source) ? req.body.source : 'manual';
    const skipSync = (req.body && req.body.source) === 'local';
    const pushedSha = /^[0-9a-f]{40}$/.test((req.body && req.body.sha) || '') ? req.body.sha : null;
    const pushedBranch = /^[A-Za-z0-9._/-]{1,64}$/.test((req.body && req.body.branch) || '') ? req.body.branch : null;
    await deploy(req.params.id, { only, source, skipSync, pushedSha, pushedBranch, originHost: req.hostname });
    res.json({ ok: true, redeployed: true, services: only.length ? only : undefined });
  }
  catch (e) { res.status(e.status || 500).json({ error: e.message }); }
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
};
