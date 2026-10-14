// remediation: extracted from the original backend without changing route semantics.
module.exports = function register(ctx) {
  const { APPS_DIR, app, appDir, dockerfileProtection, importProtection, panelLog } = ctx;
  const lifecycleError = (...args) => ctx.lifecycleError(...args);
  const load = (...args) => ctx.load(...args);
  const remediationSuggestions = (...args) => ctx.remediationSuggestions(...args);
  const siteLifecycle = (...args) => ctx.siteLifecycle(...args);
app.get('/api/apps/:id/remediations', (req, res) => {
  try {
    const meta = load().apps.find(a => a.id === req.params.id);
    if (!meta) return res.status(404).json({ error: 'unknown app' });
    res.json(remediationSuggestions(meta, appDir(APPS_DIR, meta.id)));
  } catch (e) { res.status(500).json({ error: e.message }); }
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
};
