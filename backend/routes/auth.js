const crypto = require('crypto');
const PUBLIC = new Set(['/api/panel/auth-status','/api/panel/setup','/api/panel/login','/api/panel/terms-text']);
function panelToken(req) {
  const h = req.headers || {};
  if (/^bearer\s+/i.test(String(h.authorization || ''))) return String(h.authorization).replace(/^bearer\s+/i, '').trim();
  if (h['x-panel-token']) return String(h['x-panel-token']).trim();
  const match = String(h.cookie || '').match(/(?:^|;\s*)mp_session=([^;]+)/);
  try { return match ? decodeURIComponent(match[1]) : ''; } catch { return ''; }
}
function registerAuth({ app, store, accounts, terms }) {
  const panelAuthed = req => !!accounts.session(panelToken(req));
  const cookie = (res, token) => res.set('Set-Cookie', `mp_session=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=2592000`);
  const reply = (res, action) => { try { action(); } catch (e) { res.status(e.status || 500).json({ error: e.message }); } };
  app.use((req, res, next) => {
    if (!req.path.startsWith('/api/')) return next();
    const user = accounts.session(panelToken(req));
    if (!user && !PUBLIC.has(req.path)) return res.status(401).json({ error: 'panel login required' });
    req.panelUser = user;
    const actor = { id: user && user.id, username: user ? user.username : 'anonymous:unauthenticated', ip: req.socket.remoteAddress || null, requestId: crypto.randomUUID() };
    store.withActor(actor, () => {
      if (!['GET','HEAD'].includes(req.method)) {
        const siteId = /^\/api\/apps\/pending\/([^/]+)/.exec(req.path)?.[1] || /^\/api\/(?:apps|trash)\/([^/]+)/.exec(req.path)?.[1];
        const site = siteId ? store.load().apps.concat(store.load().trash).find(a => a.id === siteId) || { id: siteId } : null;
        store.audit('request.started', site, 'pending', { method: req.method, path: req.path }, actor);
        res.once('finish', () => {
          try {
            store.audit('request.finished', site, res.statusCode < 400 ? 'success' : 'failure', { method: req.method, path: req.path, status: res.statusCode }, actor);
            if (res.statusCode >= 400 && site) {
              const action = req.method === 'DELETE' && /^\/api\/apps\/[^/]+$/.test(req.path) ? 'site.deleted'
                : req.method === 'POST' && /^\/api\/trash\/[^/]+\/restore$/.test(req.path) ? 'site.restored' : null;
              if (action) store.audit(action, site, 'failure', { status: res.statusCode }, actor);
            }
          }
          catch (e) { console.error('Audit completion could not be recorded:', e.message); }
        });
      }
      next();
    });
  });
  app.get('/api/panel/auth-status', (req, res) => res.json({ setupRequired: !accounts.configured(), authenticated: !!req.panelUser, user: req.panelUser, termsAccepted: !!req.panelUser?.termsAccepted, namedAccounts: true }));
  app.get('/api/panel/terms-text', (req, res) => res.type('text/plain').send(terms));
  app.post('/api/panel/setup', (req, res) => reply(res, () => {
    if (accounts.configured()) return res.status(409).json({ error: 'Panel already configured — sign in' });
    if (!req.body?.acceptTerms) return res.status(400).json({ error: 'Operator terms must be accepted' });
    const username = String(req.body.username || 'admin').trim();
    accounts.create({ username, password: req.body.password, role: 'admin', acceptTerms: true });
    const session = accounts.login(username, req.body.password); cookie(res, session.token); res.json({ ok: true, user: session.user });
  }));
  app.post('/api/panel/login', (req, res) => reply(res, () => {
    if (!accounts.configured()) return res.status(409).json({ error: 'Complete panel setup first' });
    const session = accounts.login(String(req.body?.username || 'admin').trim(), req.body?.password);
    cookie(res, session.token); res.json({ ok: true, user: session.user, termsAccepted: session.user.termsAccepted });
  }));
  app.post('/api/panel/logout', (req, res) => reply(res, () => {
    accounts.logout(panelToken(req)); res.set('Set-Cookie', 'mp_session=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0'); res.json({ ok: true });
  }));
  app.post('/api/panel/password', (req, res) => reply(res, () => {
    accounts.password(req.panelUser.id, req.body.current, req.body.next, panelToken(req)); res.json({ ok: true });
  }));
  app.post('/api/panel/terms', (req, res) => reply(res, () => {
    if (!req.body?.accepted) return res.status(400).json({ error: 'Terms not accepted' });
    accounts.terms(req.panelUser.id); res.json({ ok: true });
  }));
  app.get('/api/panel/operators', (req, res) => {
    if (req.panelUser.role !== 'admin') return res.status(403).json({ error: 'Administrator account required' });
    res.json(accounts.list());
  });
  app.post('/api/panel/operators', (req, res) => reply(res, () => {
    if (req.panelUser.role !== 'admin') return res.status(403).json({ error: 'Administrator account required' });
    res.json({ ok: true, user: accounts.create(req.body) });
  }));
  app.patch('/api/panel/operators/:id', (req, res) => reply(res, () => {
    if (req.panelUser.role !== 'admin') return res.status(403).json({ error: 'Administrator account required' });
    if (typeof req.body.disabled !== 'boolean') return res.status(400).json({ error: 'Supply disabled: true or false' });
    res.json({ ok: true, user: accounts.disable(req.params.id, req.body.disabled) });
  }));
  return { panelAuthed, panelToken };
}
module.exports = { registerAuth, panelToken };
