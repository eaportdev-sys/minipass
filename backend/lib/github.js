// GitHub handshake: one OAuth connect, then every repo works.
// Token lives next to DATA_FILE (persistent volume, never git). Clone/pull inject it
// in-memory only; stored repo URLs stay clean.
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

function getAuth() {
  try {
    const a = JSON.parse(fs.readFileSync(tokenFile(), 'utf8'));
    if (a && a.access_token) return a;
  } catch {}
  return null;
}

function saveAuth(a) {
  fs.mkdirSync(path.dirname(tokenFile()), { recursive: true });
  fs.writeFileSync(tokenFile(), JSON.stringify(a, null, 2));
  try { fs.chmodSync(tokenFile(), 0o600); } catch {}
}

function clearAuth() {
  try { fs.unlinkSync(tokenFile()); } catch {}
}

// Inject token into an https github remote. SSH remotes and non-github hosts untouched.
function authUrl(url) {
  const a = getAuth();
  if (!a || !url) return url;
  const m = String(url).match(/^https:\/\/([^@]+@)?github\.com\/(.+)$/i);
  if (!m || m[1]) return url;
  return `https://x-access-token:${a.access_token}@github.com/${m[2]}`;
}

async function api(p, opts = {}) {
  const a = getAuth();
  if (!a) throw new Error('github not connected');
  const r = await fetch(`https://api.github.com${p}`, {
    ...opts,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${a.access_token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      ...(opts.headers || {})
    }
  });
  if (!r.ok) throw new Error(`github api ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

module.exports = { getAuth, saveAuth, clearAuth, authUrl, api, tokenFile };
