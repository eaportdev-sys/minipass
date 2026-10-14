// github-polling: extracted from the original backend without changing route semantics.
module.exports = function createHelpers(ctx) {
  const { AUTO_DEPLOY, crypto, gh, pollState } = ctx;
  const deploy = (...args) => ctx.deploy(...args);
  const load = (...args) => ctx.load(...args);
  const save = (...args) => ctx.save(...args);
async function pollGithub() {
  if (!AUTO_DEPLOY) return;
  let db_;
  try { db_ = load(); } catch { return; }
  const now = Date.now();
  for (const meta of db_.apps) {
    const g = meta.github;
    if (!g || !g.repo || g.enabled !== true || !(g.pollMinutes > 0)) continue;
    if (now - (pollState.get(meta.id) || 0) < g.pollMinutes * 60 * 1000) continue;
    pollState.set(meta.id, now);
    try {
      const parts = String(g.repo).split('/');
      const commitsPath = `/repos/${parts[0]}/${parts[1]}/commits/${encodeURIComponent(g.branch || 'main')}`;
      let c;
      try {
        c = await gh.apiFor(meta, commitsPath);
      } catch (e) {
        // token-free public link: poll without credentials (shared 60/hr quota)
        if (gh.tokenFor(meta)) throw e;
        c = await gh.apiPublic(commitsPath);
      }
      const sha = c && c.sha;
      if (!sha || sha === g.sha) continue;
      await deploy(meta.id, { source: 'poll' });
      const fresh = load();
      const m2 = fresh.apps.find(a => a.id === meta.id);
      if (m2 && m2.github) { m2.github.sha = sha; save(fresh); }
      console.log(`poll-deploy ${meta.id} -> ${String(sha).slice(0, 7)}`);
    } catch (e) { console.error(`poll ${meta.id}: ${e.message}`); }
  }
}

async function removeGithubHook(meta) {
  if (!meta || !meta.github || !meta.github.repo || !(meta.github.token || meta.github.login)) return false;
  try {
    const [o, n] = String(meta.github.repo).split('/');
    const hooks = await gh.apiFor(meta, `/repos/${o}/${n}/hooks`);
    const ours = (Array.isArray(hooks) ? hooks : []).find(h => h && h.config && String(h.config.url || '').includes(`/webhook/${meta.id}`));
    if (!ours) return false;
    await gh.apiFor(meta, `/repos/${o}/${n}/hooks/${ours.id}`, { method: 'DELETE' });
    return true;
  } catch { return false; }
}

async function createGithubHook(meta) {
  const base = (process.env.PANEL_URL || '').replace(/\/$/, '');
  if (!base || !meta || !meta.github || !meta.github.repo || !(meta.github.token || meta.github.login)) return false;
  try {
    const [o, n] = String(meta.github.repo).split('/');
    await gh.apiFor(meta, `/repos/${o}/${n}/hooks`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'web', active: true, events: ['push'],
        config: { url: `${base}/webhook/${meta.id}?token=${meta.token}`, content_type: 'json', secret: meta.token, insecure_ssl: '0' }
      })
    });
    return true;
  } catch { return false; }
}

async function githubHead(meta) {
  const [o, n] = String(meta.github.repo || '').split('/');
  const endpoint = `/repos/${o}/${n}/commits/${encodeURIComponent(meta.github.branch || 'main')}`;
  try { return (await gh.apiFor(meta, endpoint) || {}).sha || null; }
  catch {
    try { return (await gh.apiPublic(endpoint) || {}).sha || null; }
    catch { return null; }
  }
}

async function setGithubAutomation(req, res, forcedEnabled) {
  // Disabling stops both webhook and poll triggers while preserving the GitHub
  // source link used by manual repo redeploys. Enabling takes a head snapshot,
  // so the first scheduled check cannot redeploy an unchanged commit.
  try {
    const db_ = load();
    const meta = db_.apps.find(a => a.id === req.params.id);
    if (!meta) return res.status(404).json({ error: 'unknown app' });
    if (!meta.github || !meta.github.repo) return res.status(400).json({ error: 'no github repository linked to this site' });
    const enabled = forcedEnabled === undefined ? !!(req.body && req.body.enabled) : forcedEnabled;
    if (enabled) {
      if (!AUTO_DEPLOY) return res.status(409).json({ error: 'automatic deploy disabled for now' });
      const head = await githubHead(meta);
      if (head) meta.github.sha = head;
      meta.github.enabled = true;
      meta.github.pollMinutes = Math.max(0, Math.min(60, parseInt(meta.github.pollMinutes, 10) || 0));
      save(db_);
      await removeGithubHook(meta);
      const webhookCreated = await createGithubHook(meta);
      return res.json({ ok: true, enabled: true, pollMinutes: meta.github.pollMinutes, sha: meta.github.sha || null, webhookCreated });
    }
    const webhookDeleted = await removeGithubHook(meta);
    meta.github.enabled = false;
    meta.github.pollMinutes = 0;
    meta.token = crypto.randomBytes(16).toString('hex');
    save(db_);
    res.json({ ok: true, enabled: false, webhookDeleted });
  } catch (e) { res.status(500).json({ error: e.message }); }
}
  return { pollGithub, removeGithubHook, createGithubHook, githubHead, setGithubAutomation };
};
