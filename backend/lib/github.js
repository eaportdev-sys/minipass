// GitHub handshake: connect N accounts, link each site to any of them.
// Tokens live next to DATA_FILE (persistent volume, never git). Clone/pull inject the
// right account's token in-memory only; stored repo URLs stay clean.
const fs = require('fs');
const path = require('path');

function dataDir() {
  try {
    return path.dirname(process.env.DATA_FILE || path.join(__dirname, '..', 'data.json'));
  } catch {
    return '/tmp';
  }
}

function tokenFile() {
  return process.env.GITHUB_TOKEN_FILE || path.join(dataDir(), 'github.json');
}

function readStore() {
  try {
    const s = JSON.parse(fs.readFileSync(tokenFile(), 'utf8'));
    // migrate legacy single-account shape { access_token, login, ... }
    if (s && s.access_token && !s.accounts) {
      const login = s.login || 'default';
      return { accounts: { [login]: { access_token: s.access_token, scope: s.scope } }, default: login };
    }
    if (s && s.accounts) return s;
  } catch {}
  return { accounts: {}, default: null };
}

function writeStore(s) {
  fs.mkdirSync(path.dirname(tokenFile()), { recursive: true });
  fs.writeFileSync(tokenFile(), JSON.stringify(s, null, 2));
  try { fs.chmodSync(tokenFile(), 0o600); } catch {}
}

// Picks requested account, else default, else first. Null when nothing connected.
function getAuth(login) {
  const s = readStore();
  const logins = Object.keys(s.accounts);
  if (!logins.length) return null;
  const pick = (login && s.accounts[login]) ? login : (s.accounts[s.default] ? s.default : logins[0]);
  return { ...s.accounts[pick], login: pick };
}

function getLogins() {
  return Object.keys(readStore().accounts);
}

function saveAuth(entry) {
  const s = readStore();
  s.accounts[entry.login] = { access_token: entry.access_token, scope: entry.scope, createdAt: new Date().toISOString() };
  if (!s.default || !s.accounts[s.default]) s.default = entry.login;
  writeStore(s);
}

function clearAuth(login) {
  if (!login) { try { fs.unlinkSync(tokenFile()); } catch {} return; }
  const s = readStore();
  delete s.accounts[login];
  if (s.default === login) s.default = Object.keys(s.accounts)[0] || null;
  try { writeStore(s); } catch {}
}

// Inject an account's token into an https github remote. SSH remotes and
// non-github hosts untouched. Login omitted = default account.
function authUrl(url, login) {
  const a = getAuth(login);
  if (!a || !url) return url;
  return authUrlWith(url, a.access_token);
}

// Inject an explicit token (site-owned connection at create time).
function authUrlWith(url, token) {
  if (!token || !url) return url;
  const m = String(url).match(/^https:\/\/github\.com\/(.+)$/i);
  if (!m) return url;
  return `https://x-access-token:${token}@github.com/${m[1]}`;
}

async function apiAs(login, p, opts = {}) {
  const a = getAuth(login);
  if (!a) throw new Error('github not connected' + (login ? ` (${login})` : ''));
  try {
    return await apiWith(a.access_token, p, opts);
  } catch (e) {
    // revoked on github: drop it so a dead credential stops poisoning every call
    if (/api 401/.test(e.message)) {
      clearAuth(a.login);
      throw new Error(`github revoked the token for ${a.login} - account removed, reconnect to restore`);
    }
    throw e;
  }
}

async function apiWith(token, p, opts = {}) {
  const r = await fetch(`https://api.github.com${p}`, {
    ...opts,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      ...(opts.headers || {})
    }
  });
  if (!r.ok) throw new Error(`github api ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

// Per-site resolution: site token first, then linked panel account, then default.
function tokenFor(meta) {
  if (meta && meta.github && meta.github.token) return meta.github.token;
  const a = getAuth(meta && meta.github && meta.github.login);
  return a ? a.access_token : null;
}

async function apiFor(meta, p, opts = {}) {
  const t = meta && meta.github && meta.github.token;
  if (t) {
    try {
      return await apiWith(t, p, opts);
    } catch (e) {
      if (/api 401/.test(e.message)) throw new Error('site token invalid (revoked?) - paste a fresh token on the site page');
      throw e;
    }
  }
  return apiAs(meta && meta.github && meta.github.login, p, opts);
}

function authUrlFor(meta, url) {
  const t = meta && meta.github && meta.github.token;
  if (t && url) {
    const m = String(url).match(/^https:\/\/github\.com\/(.+)$/i);
    if (m) return `https://x-access-token:${t}@github.com/${m[1]}`;
  }
  return authUrl(url, meta && meta.github && meta.github.login);
}

async function api(p, opts = {}) {
  return apiAs(null, p, opts);
}

module.exports = { getAuth, getLogins, saveAuth, clearAuth, authUrl, authUrlWith, authUrlFor, api, apiAs, apiWith, apiFor, tokenFor, tokenFile };
