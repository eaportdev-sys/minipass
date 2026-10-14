// webhooks: extracted from the original backend without changing route semantics.
module.exports = function register(ctx) {
  const { AUTO_DEPLOY, app, crypto, express } = ctx;
  const deploy = (...args) => ctx.deploy(...args);
  const load = (...args) => ctx.load(...args);
  const save = (...args) => ctx.save(...args);
app.post('/webhook/:id', express.raw({ type: '*/*' }), async (req, res) => {
  const meta = load().apps.find(a => a.id === req.params.id);
  if (!meta || req.query.token !== meta.token) return res.status(401).send('bad token');
  if (!AUTO_DEPLOY) return res.status(409).send('automatic deploy disabled for now');
  if (!meta.github || meta.github.enabled !== true) return res.status(409).send('github automation disabled');
  const sig = req.headers['x-hub-signature-256'];
  if (sig && meta.github) {
    const expect = 'sha256=' + crypto.createHmac('sha256', meta.token).update(req.body).digest('hex');
    const ok = sig.length === expect.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect));
    if (!ok) return res.status(401).send('bad signature');
  }
  try { await deploy(req.params.id, { source: 'webhook' }); } catch (e) { return res.status(500).send(e.message); }
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
};
