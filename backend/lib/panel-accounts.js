const crypto = require('crypto');
const hash = (password, salt) => crypto.scryptSync(String(password), salt, 64).toString('hex');
const tokenHash = token => crypto.createHash('sha256').update(String(token || '')).digest('hex');
const publicUser = row => row ? { id: row.id, username: row.username, role: row.role, disabled: !!row.disabled, createdAt: row.created_at, termsAccepted: !!row.terms_accepted_at } : null;
const validUsername = value => typeof value === 'string' && /^[A-Za-z][A-Za-z0-9._-]{2,31}$/.test(value);
function equal(a, b) {
  const x = Buffer.from(a, 'hex'), y = Buffer.from(b, 'hex');
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
class PanelAccounts {
  constructor(store) { this.store = store; this.db = store.db; }
  configured() { return !!this.db.prepare('SELECT id FROM operators LIMIT 1').get(); }
  list() { return this.db.prepare('SELECT * FROM operators ORDER BY username').all().map(publicUser); }
  create({ username, password, role = 'operator', acceptTerms = false }) {
    if (!validUsername(username)) throw Object.assign(new Error('Username must be 3–32 letters, digits, dots, underscores or hyphens, starting with a letter'), { status: 400 });
    if (!['admin', 'operator'].includes(role)) throw Object.assign(new Error('Invalid account role'), { status: 400 });
    if (typeof password !== 'string' || password.length < 12 || password.length > 1024) throw Object.assign(new Error('Use a password from 12 to 1024 characters'), { status: 400 });
    if (this.db.prepare('SELECT id FROM operators WHERE username=?').get(username)) throw Object.assign(new Error('Username already exists; disabled accounts retain their audit identity'), { status: 409 });
    const id = crypto.randomUUID(), salt = crypto.randomBytes(16).toString('hex');
    return this.store.transaction(() => {
      this.db.prepare('INSERT INTO operators(id,username,role,password_hash,salt,created_at,terms_accepted_at) VALUES(?,?,?,?,?,?,?)')
        .run(id, username, role, hash(password, salt), salt, new Date().toISOString(), acceptTerms ? new Date().toISOString() : null);
      this.store.audit('account.created', null, 'success', { accountId: id, username, role });
      return publicUser(this.db.prepare('SELECT * FROM operators WHERE id=?').get(id));
    });
  }
  login(username, password) {
    const row = this.db.prepare('SELECT * FROM operators WHERE username=?').get(String(username || ''));
    const passwordHash = hash(String(password || ''), row ? row.salt : 'unconfigured-account');
    if (!row || row.disabled || !equal(passwordHash, row.password_hash)) {
      this.store.audit('account.login', null, 'failure', { username: String(username || '').slice(0, 32) });
      throw Object.assign(new Error('Invalid username or password'), { status: 401 });
    }
    const token = crypto.randomBytes(32).toString('hex'), created = Date.now();
    this.store.transaction(() => {
      this.db.prepare('DELETE FROM sessions WHERE expires_at<=?').run(created);
      this.db.prepare('INSERT INTO sessions VALUES(?,?,?,?)').run(tokenHash(token), row.id, created, created + 30 * 864e5);
      this.store.audit('account.login', null, 'success', {}, { ...this.store.actor(), id: row.id, username: row.username });
    });
    return { token, user: publicUser(row) };
  }
  session(token) {
    if (!token) return null;
    return publicUser(this.db.prepare('SELECT o.* FROM sessions s JOIN operators o ON o.id=s.user_id WHERE s.token_hash=? AND s.expires_at>? AND o.disabled=0').get(tokenHash(token), Date.now()));
  }
  logout(token) { this.db.prepare('DELETE FROM sessions WHERE token_hash=?').run(tokenHash(token)); this.store.audit('account.logout'); }
  terms(userId) { this.db.prepare('UPDATE operators SET terms_accepted_at=? WHERE id=?').run(new Date().toISOString(), userId); }
  password(userId, current, next, token) {
    const row = this.db.prepare('SELECT * FROM operators WHERE id=? AND disabled=0').get(userId);
    if (!row || !equal(hash(String(current || ''), row.salt), row.password_hash)) throw Object.assign(new Error('Current password is wrong'), { status: 400 });
    if (typeof next !== 'string' || next.length < 12 || next.length > 1024) throw Object.assign(new Error('Use a password from 12 to 1024 characters'), { status: 400 });
    const salt = crypto.randomBytes(16).toString('hex');
    this.store.transaction(() => {
      this.db.prepare('UPDATE operators SET salt=?,password_hash=? WHERE id=?').run(salt, hash(next, salt), userId);
      this.db.prepare('DELETE FROM sessions WHERE user_id=? AND token_hash<>?').run(userId, tokenHash(token));
      this.store.audit('account.password.changed', null, 'success', { accountId: userId });
    });
  }
  disable(userId, disabled) {
    const row = this.db.prepare('SELECT * FROM operators WHERE id=?').get(userId);
    if (!row) throw Object.assign(new Error('Unknown operator'), { status: 404 });
    return this.store.transaction(() => {
      if (disabled && row.role === 'admin' && !row.disabled && this.db.prepare("SELECT count(*) AS n FROM operators WHERE role='admin' AND disabled=0").get().n <= 1) throw Object.assign(new Error('Keep at least one enabled administrator'), { status: 409 });
      this.db.prepare('UPDATE operators SET disabled=? WHERE id=?').run(disabled ? 1 : 0, userId);
      if (disabled) this.db.prepare('DELETE FROM sessions WHERE user_id=?').run(userId);
      this.store.audit(disabled ? 'account.disabled' : 'account.enabled', null, 'success', { accountId: row.id, username: row.username });
      return publicUser({ ...row, disabled });
    });
  }
}
module.exports = { PanelAccounts, tokenHash };
