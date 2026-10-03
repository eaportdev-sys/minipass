// Panel-owned SSH key for all git operations (self-upgrade + private app repos).
// Lives next to DATA_FILE so it survives rebuilds via the persistent volume.
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

function dataDir() {
  try {
    return path.dirname(process.env.DATA_FILE || path.join(__dirname, '..', 'data.json'));
  } catch {
    return '/tmp';
  }
}

function keyPath() {
  return process.env.PANEL_KEY || path.join(dataDir(), 'panel-key');
}

function ensureKey() {
  const kp = keyPath();
  try {
    if (fs.existsSync(kp)) return kp;
    fs.mkdirSync(path.dirname(kp), { recursive: true });
    execSync(`ssh-keygen -t ed25519 -f "${kp}" -N "" -C "minipass"`, { stdio: 'ignore' });
    return fs.existsSync(kp) ? kp : null;
  } catch {
    return fs.existsSync(kp) ? kp : null;
  }
}

function gitEnv() {
  const kp = ensureKey();
  const keys = [kp, '/root/.ssh/minipass-deploy', '/root/.ssh/id_ed25519', '/root/.ssh/id_rsa'].filter(Boolean);
  const key = keys.find(k => { try { return fs.existsSync(k); } catch { return false; } });
  if (!key) return process.env;
  return { ...process.env, GIT_SSH_COMMAND: `ssh -i ${key} -o StrictHostKeyChecking=accept-new` };
}

function pubKey() {
  const kp = ensureKey();
  if (!kp) return null;
  try { return fs.readFileSync(kp + '.pub', 'utf8').trim(); } catch { return null; }
}

// Per-app repo key: GitHub forbids registering one key on many repos,
// so each app with an SSH remote gets its own pair inside its (gitignored) dir.
function appKeypair(dir) {
  try {
    const kp = path.join(dir, 'deploy-key');
    if (!fs.existsSync(kp)) {
      execSync(`ssh-keygen -t ed25519 -f "${kp}" -N "" -C "minipass-${path.basename(dir)}"`, { stdio: 'ignore' });
      try { fs.chmodSync(kp, 0o600); } catch {}
    }
    return fs.existsSync(kp) ? kp : null;
  } catch {
    return null;
  }
}

function appGitEnv(dir) {
  const kp = dir && appKeypair(dir);
  if (kp) return { ...process.env, GIT_SSH_COMMAND: `ssh -i ${kp} -o StrictHostKeyChecking=accept-new` };
  return gitEnv();
}

function appPubKey(dir) {
  const kp = dir && appKeypair(dir);
  if (!kp) return null;
  try { return fs.readFileSync(kp + '.pub', 'utf8').trim(); } catch { return null; }
}

module.exports = { gitEnv, pubKey, keyPath, appKeypair, appGitEnv, appPubKey };
