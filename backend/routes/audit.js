const { query } = require('../lib/audit-query');
function registerAudit({ app, store }) {
  app.get('/api/panel/audit', (req, res) => {
    try {
      const clauses = [], args = [];
      for (const [field, column] of [['actor','actor_username'],['action','action'],['site','site_id'],['outcome','outcome']]) if (req.query[field]) { clauses.push(column + '=?'); args.push(String(req.query[field]).slice(0, 200)); }
      for (const [field, operator] of [['from','>='],['to','<=']]) if (req.query[field]) {
        const time = new Date(String(req.query[field])); if (!Number.isFinite(time.getTime())) return res.status(400).json({ error: 'Invalid audit date' });
        clauses.push('occurred_at' + operator + '?'); args.push(time.toISOString());
      }
      const where = clauses.length ? ' WHERE ' + clauses.join(' AND ') : '';
      const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
      const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
      const total = store.db.prepare('SELECT count(*) AS n FROM audit_events' + where).get(...args).n;
      const rows = store.db.prepare('SELECT * FROM audit_events' + where + ' ORDER BY id DESC LIMIT ? OFFSET ?').all(...args, limit, offset);
      res.json({ rows, total, limit, offset });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  app.post('/api/panel/audit/query', async (req, res) => {
    const actor = store.actor();
    try {
      const started = Date.now(), result = await query(store.file, req.body?.sql);
      store.audit('audit.queried', null, 'success', { rows: result.rows.length, durationMs: Date.now() - started }, actor);
      res.json({ ...result, durationMs: Date.now() - started });
    } catch (e) { store.audit('audit.queried', null, 'failure', {}, actor); res.status(e.status || 500).json({ error: e.message }); }
  });
}
module.exports = { registerAudit };
