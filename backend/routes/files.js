// files: extracted from the original backend without changing route semantics.
module.exports = function register(ctx) {
  const { JUNK, app, fs, path, upload, uploadMany } = ctx;
  const codeDir = (...args) => ctx.codeDir(...args);
  const deploy = (...args) => ctx.deploy(...args);
  const isInfraFile = (...args) => ctx.isInfraFile(...args);
  const markDirty = (...args) => ctx.markDirty(...args);
  const safeRel = (...args) => ctx.safeRel(...args);
  const sh = (...args) => ctx.sh(...args);
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
    if (!st.isFile()) return res.status(400).json({ error: 'not a file' });
    if (st.size > 1024 * 1024) return res.status(400).json({ error: `file too large to edit in the panel (${Math.round(st.size / 1024)}KB > 1024KB) - replace it via zip upload` });
    const buf = fs.readFileSync(f);
    if (buf.includes(0)) return res.status(400).json({ error: 'binary file - use zip upload to replace' });
    res.json({ path: req.query.path, content: buf.toString('utf8') });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.put('/api/apps/:id/file', async (req, res) => {
  try {
    const root = codeDir(req.params.id);
    const relative = String(req.body.path || '').replace(/\\/g, '/');
    const f = safeRel(root, relative);
    if (isInfraFile(path.basename(f), root, relative)) return res.status(409).json({ error: 'build recipes and nginx.conf are protected; use the explicit service build-file workflow' });
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, req.body.content || '');
    await markDirty(req.params.id, 'file ' + (req.body.path || ''));
  } catch (e) { return res.status(500).json({ error: e.message }); }
  if (!(req.body && req.body.apply === true)) return res.json({ ok: true, saved: true, pending: true });
  try { await deploy(req.params.id); res.json({ ok: true, redeployed: true }); }
  catch (e) { res.json({ ok: true, saved: true, redeployError: e.message }); }
});

app.delete('/api/apps/:id/file', async (req, res) => {
  try {
    const base = codeDir(req.params.id);
    const f = safeRel(base, req.query.path || '');
    if (f === base) return res.status(400).json({ error: 'refusing to delete app root' });
    fs.rmSync(f, { recursive: true, force: true });
    await markDirty(req.params.id, 'deleted ' + (req.query.path || ''));
    if (req.query.apply === 'true' || (req.body && req.body.apply === true)) await deploy(req.params.id);
    res.json({ ok: true, saved: true, pending: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

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
      if (!rel || rel.includes('..') || !base || JUNK.has(base) || base.startsWith('._') || isInfraFile(base, code, rel)) {
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
    await markDirty(req.params.id, 'upload');
    if (req.body.apply !== 'true') return res.json({ ok: true, files: n, skipped, pending: true });
    try { await deploy(req.params.id); res.json({ ok: true, redeployed: true, files: n, skipped }); }
    catch (e) { res.json({ ok: true, files: n, skipped, redeployError: e.message }); }
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/apps/:id/upload', upload.single('zip'), async (req, res) => {
  let merged = false, warning;
  try {
    if (!req.file) return res.status(400).json({ error: 'no zip attached (field name: zip)' });
    const code = codeDir(req.params.id);
    const tmpBase = fs.mkdtempSync(path.join('/tmp', 'minipass-extract-'));
    await sh(`unzip -o "${req.file.path}" -d "${tmpBase}"`, '/tmp');
    fs.unlinkSync(req.file.path);
    // smart flatten: descend through single wrapper folders until runnable level (max 3)
    let src = tmpBase;
    for (let d = 0; d < 3; d++) {
      const kids = fs.readdirSync(src).filter(e => !JUNK.has(e) && !e.startsWith('._'));
      const hasRunnable = kids.some(e => /^(index\.html?|index\.php|composer\.json|package\.json)$/i.test(e));
      if (!hasRunnable && kids.length === 1 && fs.statSync(path.join(src, kids[0])).isDirectory()) {
        src = path.join(src, kids[0]);
        continue;
      }
      break;
    }
    // merge into code, but keep managed infra files (Dockerfile, nginx.conf)
    let n = 0;
    for (const e of fs.readdirSync(src)) {
      if (isInfraFile(e) || JUNK.has(e) || e.startsWith('._')) continue;
      fs.cpSync(path.join(src, e), path.join(code, e), { recursive: true, filter: (from, to) => {
        const name = path.basename(from);
        if (JUNK.has(name) || name.startsWith('._') || fs.lstatSync(from).isSymbolicLink()) return false;
        if (fs.lstatSync(from).isDirectory()) return true;
        return !isInfraFile(name, code, path.relative(code, to).replace(/\\/g, '/'));
      } });
      n++;
    }
    fs.rmSync(tmpBase, { recursive: true, force: true });
    if (!n) return res.status(400).json({ error: 'zip was empty (or only contained infra files)' });
    await markDirty(req.params.id, 'zip upload');
    // validate: static hosting needs index.html at root - indicate, don't guess further
    const rootFiles = fs.readdirSync(code);
    const hasIndex = rootFiles.some(e => /^index\.html?$/i.test(e));
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
    if (req.body.apply !== 'true') return res.json({ ok: true, files: 'merged', saved: true, pending: true, index: hasIndex ? 'index.html' : null, warning });
    await deploy(req.params.id);
    res.json({ ok: true, redeployed: true, files: n, index: hasIndex ? 'index.html' : null, warning });
  } catch (e) {
    // files already merged - report deploy failure separately so upload isn't mistaken as lost
    if (merged) return res.json({ ok: true, files: 'merged', saved: true, warning, redeployError: e.message });
    return res.status(500).json({ error: e.message });
  }
});
};
