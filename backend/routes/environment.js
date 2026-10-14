// environment: extracted from the original backend without changing route semantics.
module.exports = function register(ctx) {
  const { APPS_DIR, app, appDir, fs, path, readEnvVars, tokens } = ctx;
  const applyEnvDefaults = (...args) => ctx.applyEnvDefaults(...args);
  const cleanDomain = (...args) => ctx.cleanDomain(...args);
  const deploy = (...args) => ctx.deploy(...args);
  const load = (...args) => ctx.load(...args);
  const managedKeys = (...args) => ctx.managedKeys(...args);
  const markDirty = (...args) => ctx.markDirty(...args);
  const save = (...args) => ctx.save(...args);
app.get('/api/apps/:id/env', (req, res) => {
  const meta = load().apps.find(a => a.id === req.params.id);
  if (!meta) return res.status(404).json({ error: 'unknown app' });
  const managed = managedKeys(appDir(APPS_DIR, meta.id));
  res.json({ vars: readEnvVars(path.join(appDir(APPS_DIR, meta.id), '.env')).map(v => ({ ...v, managed: managed.has(v.key) })) });
});

app.put('/api/apps/:id/env', async (req, res) => {
  const validKey = k => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k);
  try {
    const db_ = load();
    const meta = db_.apps.find(a => a.id === req.params.id);
    if (!meta) return res.status(404).json({ error: 'unknown app' });
    const dir = appDir(APPS_DIR, meta.id);
    const managed = managedKeys(dir);
    // managed keys are infrastructure (ports, hosts, generated creds) - read-only,
    // except DOMAIN which is display/future-tunnel metadata. Deleting them is refused too.
    const EDITABLE = new Set(['DOMAIN']);
    const PROTECTED = new Set(['NODE_ENV']);
    const set = { ...((req.body && req.body.set) || {}) };
    const del = Array.isArray(req.body && req.body.delete) ? req.body.delete : [];
    const rename = (req.body && req.body.rename) || {};
    if (Object.prototype.hasOwnProperty.call(set, 'DOMAIN')) {
      try { set.DOMAIN = cleanDomain(set.DOMAIN); }
      catch (e) { return res.status(400).json({ error: e.message }); }
    }
    for (const k of Object.keys(set)) {
      if (!validKey(k)) return res.status(400).json({ error: 'bad key name: ' + k });
    }
    for (const k of del) {
      if (!validKey(k)) return res.status(400).json({ error: 'bad key name: ' + k });
      if (PROTECTED.has(k)) return res.status(400).json({ error: `${k} is required and cannot be deleted` });
    }
    for (const [from, to] of Object.entries(rename)) {
      if (!validKey(from) || !validKey(to)) return res.status(400).json({ error: `bad key rename: ${from} → ${to}` });
      if (PROTECTED.has(from)) return res.status(400).json({ error: `${from} is required and cannot be renamed` });
      if (managed.has(from) || managed.has(to)) return res.status(400).json({ error: 'managed environment keys cannot be renamed' });
      if (!del.includes(from) || !Object.prototype.hasOwnProperty.call(set, to)) return res.status(400).json({ error: 'incomplete environment key rename' });
    }
    let raw = '';
    try { raw = fs.readFileSync(path.join(dir, '.env'), 'utf8'); } catch {}
    let arr = raw.split('\n');
    const existing = new Set(arr.map(l => { const m = l.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/); return m && m[1]; }).filter(Boolean));
    const renamedFrom = new Set(Object.keys(rename));
    for (const [from, to] of Object.entries(rename)) {
      if (!existing.has(from)) return res.status(400).json({ error: `environment key no longer exists: ${from}` });
      if (existing.has(to) && !renamedFrom.has(to)) return res.status(400).json({ error: `environment key already exists: ${to}` });
    }
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
    if (Object.prototype.hasOwnProperty.call(set, 'DOMAIN') && meta.domain !== set.DOMAIN) {
      meta.domain = set.DOMAIN;
      save(db_);
    }
    await markDirty(meta.id, 'env changed');
    const skippedAll = [...new Set([...skipped, ...lockedSet])];
    // edits save only - redeploy is an explicit user action (deploy button)
    if (!(req.body && req.body.apply === true)) return res.json({ ok: true, saved: true, skipped: skippedAll, pending: true });
    try { await deploy(meta.id); } catch (e) { return res.json({ ok: true, saved: true, skipped: skippedAll, redeployError: e.message }); }
    res.json({ ok: true, saved: true, skipped: skippedAll, redeployed: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/tools/token', (req, res) => {
  try {
    const value = tokens.mintToken(
      String((req.body && req.body.format) || 'base64url').trim(),
      parseInt((req.body && req.body.bytes) || 32, 10)
    );
    res.json({ ok: true, format: String((req.body && req.body.format) || 'base64url').trim(), value });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.post('/api/apps/:id/env/defaults', async (req, res) => {
  try {
    const meta = load().apps.find(a => a.id === req.params.id);
    if (!meta) return res.status(404).json({ error: 'unknown app' });
    const result = applyEnvDefaults(meta, appDir(APPS_DIR, meta.id), req.hostname, req.protocol, req.body && req.body.keys);
    if (result.added.length || result.updated.length) await markDirty(meta.id, 'env defaults restored');
    res.json({ ok: true, ...result });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
};
