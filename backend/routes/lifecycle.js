// lifecycle: extracted from the original backend without changing route semantics.
module.exports = function register(ctx) {
  const { APPS_DIR, COMPOSE_BIN, DOCKER_BIN, TEMPLATES_DIR, TRASH_DIR, TRASH_HOLD_MS, app, appDir, dbTools, deployOps, fs, path, redactUrl, repositoryCompose, svc, trashKey, trashLib, trashOptions } = ctx;
  const cancelDeploy = (...args) => ctx.cancelDeploy(...args);
  const composeArgv = (...args) => ctx.composeArgv(...args);
  const destroyTrashRecord = (...args) => ctx.destroyTrashRecord(...args);
  const envSetManaged = (...args) => ctx.envSetManaged(...args);
  const hostPortsInUse = (...args) => ctx.hostPortsInUse(...args);
  const lifecycleError = (...args) => ctx.lifecycleError(...args);
  const load = (...args) => ctx.load(...args);
  const markDirty = (...args) => ctx.markDirty(...args);
  const pubApp = (...args) => ctx.pubApp(...args);
  const runOut = (...args) => ctx.runOut(...args);
  const save = (...args) => ctx.save(...args);
  const sh = (...args) => ctx.sh(...args);
  const siteLifecycle = (...args) => ctx.siteLifecycle(...args);
  const trashOperation = (...args) => ctx.trashOperation(...args);
app.post('/api/apps/:id/stop', async (req, res) => {
  try {
    const cancelledDeploy = cancelDeploy(req.params.id);
    await siteLifecycle(req.params.id, async () => {
      dbTools.stopAll(req.params.id);
      const meta = load().apps.find(a => a.id === req.params.id);
      if (meta && (meta.executor === 'repository-compose' || deployOps.get(meta.id) && deployOps.get(meta.id).executor === 'repository-compose')) {
        const all = await repositoryCompose.inspectProject({ id: meta.id, docker: DOCKER_BIN, run: runOut });
        if (all.length) await runOut(DOCKER_BIN, ['stop', ...all.map(c => c.Id)]);
      } else await sh(`${COMPOSE_BIN} stop`, appDir(APPS_DIR, req.params.id));
    }, { allowDeploy: cancelledDeploy });
    res.json({ ok: true, cancelledDeploy });
  }
  catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

app.post('/api/apps/:id/start', async (req, res) => {
  try { await siteLifecycle(req.params.id, async () => {
    const meta = load().apps.find(a => a.id === req.params.id);
    const dir = appDir(APPS_DIR, req.params.id);
    if (!meta) throw lifecycleError('unknown app', 404);
    if (meta.executor === 'repository-compose') {
      const config = require('yaml').parse(fs.readFileSync(path.join(dir,'docker-compose.yml'),'utf8'));
      const roles = repositoryCompose.roles(config);
      const names = Object.keys(config.services).filter(n=>roles[n]!=='task');
      const ca = composeArgv();
      await runOut(ca[0],[...ca.slice(1),'-p',meta.id,'up','-d','--no-deps','--no-build','--pull','never',...names],{cwd:dir});
    } else await sh(`${COMPOSE_BIN}${meta && meta.storageQuota ? ` -p ${meta.id}` : ''} up -d`, dir);
  }); res.json({ ok: true }); }
  catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

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
      try { save(fresh); }
      catch (e) { fs.renameSync(path.join(TRASH_DIR, name), dir); throw e; }
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
    Object.assign(db_, load()); // preserve unrelated site updates
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
      if ((s.name === 'app' || s.primary) && meta.hostPort) { s.hostPort = meta.hostPort; continue; }
      const p = claim(s.hostPort);
      if (p !== parseInt(s.hostPort, 10)) moved.push({ service: s.name, from: s.hostPort, to: p });
      s.hostPort = p;
    }
    db_.apps.push(meta);
    db_.trash.splice(idx, 1);
    try { save(db_); }
    catch (e) { fs.renameSync(dir, from); throw e; }
    if (moved.length) {
      try {
        envSetManaged(dir, { HOST_PORT: String(meta.hostPort) });
        svc.renderProject({ dir, templatesDir: TEMPLATES_DIR, meta });
      } catch (e) { console.error(record.id, 'restore port rewrite:', e.message); }
    }
    let restarted = false, restartError = null;
    try {
      if (meta.executor === 'repository-compose') {
        const ca = composeArgv(); const config = require('yaml').parse(fs.readFileSync(path.join(dir,'docker-compose.yml'),'utf8'));
        const roles = repositoryCompose.roles(config);
        await runOut(ca[0],[...ca.slice(1),'-p',meta.id,'up','-d','--no-deps','--no-build','--pull','never',...Object.keys(config.services).filter(n=>roles[n]!=='task')],{cwd:dir});
      } else await sh(`${COMPOSE_BIN} -p ${meta.id} up -d`, dir);
      restarted = true;
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
  // The global build-cache prune runs once at the end (not per site):
  // it is the slowest Docker step, so per-site pruning made bulk empty
  // take N times longer than a single destroy.
  try {
    await trashOperation(async () => {
      const records = load().trash || [];
      const selected = new Set(records.map(trashKey));
      const destroyed = [], failed = [];
      for (const record of records) {
        try { await destroyTrashRecord(record, selected, { skipPrune: true }); destroyed.push(record.id); }
        catch (e) { failed.push({ id: record.id, error: e.message }); }
      }
      let cacheWarning = null;
      if (destroyed.length) {
        try { await trashLib.pruneBuildCache(trashOptions()); }
        catch (e) { cacheWarning = String(e.message || e).slice(0, 300); }
      }
      res.json({ ok: !failed.length, destroyed, failed, ...(cacheWarning ? { cacheWarning } : {}), ...(failed.length ? { error: `${failed.length} site(s) could not be fully cleaned; kept in Trash. Open Trash for the error and retry.` } : {}) });
    });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});
};
