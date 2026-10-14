// storage: extracted from the original backend without changing route semantics.
module.exports = function register(ctx) {
  const { APPS_DIR, app, appDir, hostStorage, quotas, storage, storageRequests } = ctx;
  const load = (...args) => ctx.load(...args);
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
};
