// Panel records only. Customer application/database files remain separate.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { AsyncLocalStorage } = require('async_hooks');
const { DatabaseSync } = require('node:sqlite');
const { redact } = require('./panel-log');
const TRASH_KEY = Symbol('sqliteTrashKey');
const json = value => JSON.stringify(value);
const copy = value => value === undefined ? undefined : JSON.parse(json(value));
const timestamp = value => value == null || !Number.isFinite(new Date(value).getTime()) ? null : new Date(value).toISOString();
function mergeChanges(current, before, after) {
  if (json(before) === json(after)) return current;
  if (!before || !after || Array.isArray(before) || Array.isArray(after) || typeof before !== 'object' || typeof after !== 'object') return copy(after);
  const result = { ...(current || {}) };
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (json(before[key]) === json(after[key])) continue;
    if (!(key in after)) delete result[key];
    else result[key] = mergeChanges(result[key], before[key], after[key]);
  }
  return result;
}
class PanelStore {
  constructor({ file, legacyFile, authFile }) {
    this.file = path.resolve(file);
    this.context = new AsyncLocalStorage();
    this.snapshots = new WeakMap();
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    this.db = new DatabaseSync(this.file);
    fs.chmodSync(this.file, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sites(id TEXT PRIMARY KEY,name TEXT,type TEXT,state TEXT NOT NULL,created_at TEXT,updated_at TEXT NOT NULL,deleted_at TEXT,deleted_by_id TEXT,deleted_by TEXT,destroyed_at TEXT,data_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS trash_records(record_key TEXT PRIMARY KEY,site_id TEXT NOT NULL,data_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS operators(id TEXT PRIMARY KEY,username TEXT NOT NULL UNIQUE COLLATE NOCASE,role TEXT NOT NULL CHECK(role IN ('admin','operator')),password_hash TEXT NOT NULL,salt TEXT NOT NULL,disabled INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL,terms_accepted_at TEXT);
      CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES operators(id),created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS audit_events(id INTEGER PRIMARY KEY AUTOINCREMENT,occurred_at TEXT NOT NULL,actor_id TEXT,actor_username TEXT NOT NULL,action TEXT NOT NULL,site_id TEXT,site_name TEXT,outcome TEXT NOT NULL,request_id TEXT,ip_address TEXT,details TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS site_events(id INTEGER PRIMARY KEY AUTOINCREMENT,occurred_at TEXT NOT NULL,site_id TEXT,level TEXT NOT NULL,area TEXT NOT NULL,message TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS site_event_time ON site_events(site_id,id);
      CREATE INDEX IF NOT EXISTS audit_time ON audit_events(occurred_at);
      CREATE INDEX IF NOT EXISTS audit_site ON audit_events(site_id,occurred_at);
      CREATE INDEX IF NOT EXISTS audit_actor ON audit_events(actor_id,occurred_at);
      CREATE TRIGGER IF NOT EXISTS audit_no_update BEFORE UPDATE ON audit_events BEGIN SELECT RAISE(ABORT,'Audit records are append-only'); END;
      CREATE TRIGGER IF NOT EXISTS audit_no_delete BEFORE DELETE ON audit_events BEGIN SELECT RAISE(ABORT,'Audit records are append-only'); END;
      CREATE VIEW IF NOT EXISTS panel_sites AS SELECT id,name,type,state,created_at,updated_at,deleted_at,deleted_by_id,deleted_by,destroyed_at FROM sites;`);
    try { this.migrate(legacyFile, authFile); }
    catch (e) { this.db.close(); throw e; }
  }
  transaction(action) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = action(); this.db.exec('COMMIT'); return result; }
    catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  actor() { return this.context.getStore() || { username: 'system:background', requestId: null, ip: null }; }
  withActor(actor, action) { return this.context.run(actor, action); }
  siteEvent({ at = new Date().toISOString(), site = null, level = 'error', area = 'panel', message = '' }) {
    this.db.prepare('INSERT INTO site_events(occurred_at,site_id,level,area,message) VALUES(?,?,?,?,?)')
      .run(at, site || null, level, area, redact(message).slice(0, 8000));
  }
  siteEvents(id, limit = 100) {
    return this.db.prepare('SELECT occurred_at AS at,site_id AS site,level,area,message FROM site_events WHERE site_id=? ORDER BY id DESC LIMIT ?')
      .all(id, Math.min(200, Math.max(1, parseInt(limit, 10) || 100)));
  }
  audit(action, site = null, outcome = 'success', details = {}, actor = this.actor()) {
    this.db.prepare('INSERT INTO audit_events(occurred_at,actor_id,actor_username,action,site_id,site_name,outcome,request_id,ip_address,details) VALUES(?,?,?,?,?,?,?,?,?,?)')
      .run(new Date().toISOString(), actor.id || null, actor.username || 'system:background', action, site && site.id || null, site && (site.name || site.id) || null, outcome, actor.requestId || null, actor.ip || null, redact(json(details)).slice(0, 4000));
  }
  writeSite(record, state = 'active', deleted = null) {
    const now = new Date().toISOString(), actor = this.actor();
    this.db.prepare(`INSERT INTO sites(id,name,type,state,created_at,updated_at,deleted_at,deleted_by_id,deleted_by,data_json) VALUES(?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name,type=excluded.type,state=excluded.state,updated_at=excluded.updated_at,
      deleted_at=CASE WHEN excluded.state='trashed' THEN excluded.deleted_at ELSE sites.deleted_at END,
      deleted_by_id=CASE WHEN excluded.state='trashed' THEN excluded.deleted_by_id ELSE sites.deleted_by_id END,
      deleted_by=CASE WHEN excluded.state='trashed' THEN excluded.deleted_by ELSE sites.deleted_by END,data_json=excluded.data_json`)
      .run(record.id, record.name || record.id, record.type || null, state, record.createdAt || null, now, deleted ? timestamp(deleted.deletedAt) : null,
        deleted && (deleted.deletedBy && deleted.deletedBy.id || actor.id) || null, deleted && (deleted.deletedBy && deleted.deletedBy.username || actor.username) || null, json(record));
  }
  migrate(legacyFile, authFile) {
    if (this.db.prepare("SELECT value FROM settings WHERE key='sqlite_migrated'").get()) return;
    const read = file => {
      if (!file || !fs.existsSync(file)) return null;
      const raw = fs.readFileSync(file, 'utf8');
      let data; try { data = JSON.parse(raw); } catch { throw new Error('Legacy panel JSON is invalid; migration stopped without discarding it: ' + file); }
      const backup = file + '.sqlite-migration-backup';
      if (!fs.existsSync(backup)) { fs.copyFileSync(file, backup, fs.constants.COPYFILE_EXCL); fs.chmodSync(backup, 0o600); }
      return data;
    };
    const legacy = read(legacyFile), auth = read(authFile);
    if (legacy && (!Array.isArray(legacy.apps) || legacy.trash !== undefined && !Array.isArray(legacy.trash))) throw new Error('Legacy panel records have an invalid shape; migration stopped');
    if (auth && (auth.hash || auth.salt) && (typeof auth.hash !== 'string' || !/^[a-f0-9]{128}$/i.test(auth.hash) || typeof auth.salt !== 'string' || !auth.salt)) throw new Error('Legacy panel credentials have an invalid shape; migration stopped without opening unauthenticated setup');
    this.withActor({ username: 'system:migration' }, () => this.transaction(() => {
      for (const site of legacy && legacy.apps || []) {
        if (!site.id || this.db.prepare('SELECT id FROM sites WHERE id=?').get(site.id)) throw new Error('Duplicate/missing live site identity in legacy records; migration stopped');
        this.writeSite(site); this.audit('site.imported', site);
      }
      for (const record of legacy && legacy.trash || []) {
        let key = record.trashDir || record.id + '@' + (record.deletedAt || 'unknown'), suffix = 1;
        while (this.db.prepare('SELECT record_key FROM trash_records WHERE record_key=?').get(key)) key += '#' + suffix++;
        this.db.prepare('INSERT INTO trash_records VALUES(?,?,?)').run(key, record.id, json(record));
        if (!this.db.prepare("SELECT id FROM sites WHERE id=? AND state='active'").get(record.id)) this.writeSite(record, 'trashed', { ...record, deletedBy: { username: 'unknown:legacy' } });
        this.audit('site.deletion.imported', record, 'unknown', { deletedAt: record.deletedAt || null, attribution: 'No authenticated operator was recorded by the old panel' });
      }
      for (const [key, value] of Object.entries(legacy || {})) if (!['apps', 'trash'].includes(key)) this.db.prepare('INSERT INTO settings VALUES(?,?)').run('legacy:' + key, json(value));
      if (auth && auth.hash && auth.salt) {
        this.db.prepare('INSERT INTO operators(id,username,role,password_hash,salt,created_at,terms_accepted_at) VALUES(?,?,?,?,?,?,?)')
          .run(crypto.randomUUID(), 'admin', 'admin', auth.hash, auth.salt, new Date().toISOString(), auth.termsAcceptedAt || null);
        this.audit('account.migrated', null, 'success', { username: 'admin', anonymousSessionsInvalidated: true });
      }
      this.db.prepare('INSERT INTO settings VALUES(?,?)').run('sqlite_migrated', new Date().toISOString());
    }));
  }
  load() {
    const result = {};
    for (const row of this.db.prepare("SELECT key,value FROM settings WHERE key LIKE 'legacy:%'").all()) result[row.key.slice(7)] = JSON.parse(row.value);
    result.apps = this.db.prepare("SELECT data_json FROM sites WHERE state='active' ORDER BY rowid").all().map(row => JSON.parse(row.data_json));
    result.trash = this.db.prepare('SELECT record_key,data_json FROM trash_records ORDER BY rowid').all().map(row => {
      const record = JSON.parse(row.data_json); Object.defineProperty(record, TRASH_KEY, { value: row.record_key }); return record;
    });
    this.snapshots.set(result, { data: copy(result), trashKeys: result.trash.map(t => t[TRASH_KEY]) });
    return result;
  }
  save(next) {
    const snapshot = this.snapshots.get(next);
    if (!snapshot) throw new Error('Panel metadata must be saved from a loaded SQLite snapshot');
    const before = snapshot.data;
    const oldApps = new Map(before.apps.map(a => [a.id, a])), apps = new Map(next.apps.map(a => [a.id, a]));
    if (apps.size !== next.apps.length) throw new Error('Duplicate live site identity');
    const oldTrash = new Map(before.trash.map((t, i) => [snapshot.trashKeys[i], t]));
    const trash = new Map((next.trash || []).map(t => [t[TRASH_KEY] || t.trashDir || t.id + '@' + (t.deletedAt || 'unknown'), t]));
    this.transaction(() => {
      for (const [id, record] of apps) {
        const old = oldApps.get(id);
        if (old && json(old) === json(record)) continue; // never rewrite unrelated rows from a stale snapshot
        const current = this.db.prepare('SELECT state,data_json FROM sites WHERE id=?').get(id);
        if (!old && current && current.state === 'active') {
          if (current.data_json === json(record)) continue;
          throw new Error('Site identity was already created; reload current records');
        }
        if (old && (!current || current.state !== 'active')) throw new Error('Site changed lifecycle while it was being edited; retry with current records');
        const merged = old ? mergeChanges(JSON.parse(current.data_json), old, record) : record;
        this.writeSite(merged);
        if (!old && ![...oldTrash.values()].some(t => t.id === id)) this.audit('site.created', record);
      }
      for (const [id, old] of oldApps) if (!apps.has(id)) {
        const current = this.db.prepare('SELECT state FROM sites WHERE id=?').get(id);
        if (!current || current.state !== 'active') continue; // another request already recorded this transition
        const deleted = [...trash.values()].find(t => t.id === id);
        if (deleted) {
          deleted.deletedBy = { id: this.actor().id || null, username: this.actor().username || 'system:background' };
          this.writeSite(deleted, 'trashed', deleted); this.audit('site.deleted', deleted, 'success', { deletedAt: deleted.deletedAt });
        } else {
          this.db.prepare("UPDATE sites SET state='removed',updated_at=? WHERE id=? AND state='active'").run(new Date().toISOString(), id);
          this.audit('site.removed', old);
        }
      }
      for (const [key, record] of trash) {
        const old = oldTrash.get(key);
        if (old && json(old) === json(record)) continue;
        const row = this.db.prepare('SELECT data_json FROM trash_records WHERE record_key=?').get(key);
        if (old && !row) throw new Error('Trash record changed lifecycle; retry with current records');
        const merged = old ? mergeChanges(JSON.parse(row.data_json), old, record) : record;
        this.db.prepare('INSERT INTO trash_records VALUES(?,?,?) ON CONFLICT(record_key) DO UPDATE SET data_json=excluded.data_json').run(key, record.id, json(merged));
      }
      for (const [key, record] of oldTrash) if (!trash.has(key)) {
        const removed = this.db.prepare('DELETE FROM trash_records WHERE record_key=?').run(key);
        if (!removed.changes) continue; // never invent a second restore/destroy attribution from stale snapshots
        if (apps.has(record.id)) this.audit('site.restored', apps.get(record.id));
        else {
          this.db.prepare("UPDATE sites SET state='destroyed',destroyed_at=?,updated_at=?,data_json='{}' WHERE id=? AND state<>'active'").run(new Date().toISOString(), new Date().toISOString(), record.id);
          this.audit('site.destroyed', record);
        }
      }
      for (const key of new Set([...Object.keys(before), ...Object.keys(next)])) {
        if (['apps', 'trash'].includes(key) || json(before[key]) === json(next[key])) continue;
        if (!(key in next)) this.db.prepare('DELETE FROM settings WHERE key=?').run('legacy:' + key);
        else this.db.prepare('INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run('legacy:' + key, json(next[key]));
      }
    });
    this.snapshots.set(next, { data: copy(next), trashKeys: [...trash.keys()] });
  }
  close() { this.db.close(); }
}
module.exports = { PanelStore, mergeChanges };
