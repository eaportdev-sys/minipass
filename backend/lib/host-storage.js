// Host storage expansion: read-only discovery via the root-only quota bridge,
// plus a registry for additional/remote storage and explicit host-side approvals.
// The panel container cannot format host block devices, so provisioning is a
// two-step approval: the panel records the exact target, the host installer
// performs it (sudo bash install-linux.sh --provision-storage=<target>).
// Remote/cloud drives (Google Drive, OneDrive, SSH/NFS/SMB) are backup-class
// only: ext4 project quotas require local block storage, so they are never
// advertised as quota-capable.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const quotas = require('./quotas');

const REMOTE_TYPES = ['nfs', 'smb', 'sshfs', 'rclone-gdrive', 'rclone-onedrive', 'other'];
const QUOTA_CAPABLE = new Set(); // no remote type is quota-capable by design
const invalid = message => Object.assign(new Error(message), { status: 400 });
const conflict = message => Object.assign(new Error(message), { status: 409 });

function dataDir() {
  return path.dirname(process.env.DATA_FILE || path.join(__dirname, '../data.json'));
}
function remotesFile() { return path.join(dataDir(), 'storage-remotes.json'); }
function provisionFile() { return path.join(dataDir(), 'storage-provision.json'); }

function loadRemotes() {
  try {
    const raw = fs.readFileSync(remotesFile(), 'utf8');
    const data = JSON.parse(raw);
    if (!Array.isArray(data)) throw invalid('remote registry is invalid');
    return data;
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e.status ? e : invalid('remote registry is unreadable');
  }
}
function saveRemotes(list) {
  fs.mkdirSync(dataDir(), { recursive: true });
  const temp = remotesFile() + '.' + crypto.randomBytes(8).toString('hex') + '.tmp';
  try {
    fs.writeFileSync(temp, JSON.stringify(list, null, 2), { flag: 'wx', mode: 0o600 });
    fs.renameSync(temp, remotesFile());
  } finally { try { fs.unlinkSync(temp); } catch {} }
}
function publicRemote(r) {
  return { id: r.id, type: r.type, address: r.address, mount: r.mount || '', username: r.username || '', notes: r.notes || '', hasPassword: !!r.password, quotaCapable: false, backupOnly: true, addedAt: r.addedAt };
}
function validAddress(value) {
  const v = String(value || '').trim();
  if (!v || v.length > 256 || /[\s;`$&|]/.test(v)) throw invalid('remote address must be 1-256 characters without spaces or shell characters');
  return v;
}
async function discovery() {
  let quota = null, bridge = null;
  try { quota = await quotas.status(); } catch (e) { quota = { ready: false, error: e.message }; }
  try { bridge = await quotas.request('GET', '/discovery'); } catch (e) { bridge = { error: e.message }; }
  let setup = null;
  try { setup = JSON.parse(fs.readFileSync(path.join(dataDir(), 'storage-quota-setup.json'), 'utf8')); } catch {}
  return { quota, bridge, setup };
}
function addRemote({ type, address, mount, username, password, notes }) {
  if (!REMOTE_TYPES.includes(type)) throw invalid('remote type must be one of ' + REMOTE_TYPES.join(', '));
  const record = {
    id: 'remote-' + crypto.randomBytes(8).toString('hex'),
    type, address: validAddress(address),
    mount: String(mount || '').trim().slice(0, 256),
    username: String(username || '').trim().slice(0, 128),
    password: String(password || '').slice(0, 512) || undefined,
    notes: String(notes || '').slice(0, 500),
    addedAt: new Date().toISOString()
  };
  if (record.mount && (!/^\/[A-Za-z0-9_./-]{0,255}$/.test(record.mount) || record.mount.includes('..'))) throw invalid('mount must be an absolute path without .. or shell characters');
  if (record.username && !/^[A-Za-z0-9_.@-]{1,128}$/.test(record.username)) throw invalid('login contains unsupported characters');
  const list = loadRemotes();
  if (list.length >= 20) throw conflict('remote registry is full; remove one first');
  list.push(record);
  saveRemotes(list);
  return publicRemote(record);
}
function removeRemote(id) {
  const list = loadRemotes();
  const next = list.filter(r => r.id !== id);
  if (next.length === list.length) throw invalid('unknown remote');
  saveRemotes(next);
  return { ok: true };
}
function validTarget(value) {  const v = String(value || '').trim();
  if (!/^(vg:[A-Za-z0-9_.-]{1,64}|device:\/dev\/[A-Za-z0-9_./-]{1,64}|region:[A-Za-z0-9_./-]{1,64}:\d+:\d+)$/.test(v)) throw invalid('provision target must look like vg:<name>, device:/dev/<path> or region:<disk>:<start>:<end>');
  return v;
}
function requestProvision({ target, confirm }) {
  const t = validTarget(target);
  if (String(confirm || '') !== t) throw conflict('provision approval must repeat the exact target string');
  const approval = { target: t, requestedAt: new Date().toISOString(), status: 'pending-host' };
  fs.mkdirSync(dataDir(), { recursive: true });
  fs.writeFileSync(provisionFile(), JSON.stringify(approval, null, 2), { mode: 0o600 });
  return { ...approval, hostCommand: `sudo bash install-linux.sh --provision-storage=${t}` };
}
function provisionStatus() {
  try { return JSON.parse(fs.readFileSync(provisionFile(), 'utf8')); } catch { return null; }
}

// Stay-connected host setup for one registered remote. Returns copy-paste root
// commands only - the panel never mounts anything itself. Secrets are never
// embedded: the admin places passwords in a 0600 host file or uses keys.
function remoteSetup(remote) {
  const mount = (remote.mount && remote.mount.startsWith('/')) ? remote.mount : '/mnt/minipass-' + remote.id;
  const lines = [`sudo mkdir -p ${mount}`];
  let persist = '', verify = `mountpoint -q ${mount} && df -h ${mount}`;
  if (remote.type === 'nfs') {
    lines.push(`sudo mount -t nfs -o _netdev ${remote.address} ${mount}`,
      `echo '${remote.address} ${mount} nfs defaults,_netdev 0 0' | sudo tee -a /etc/fstab`);
    persist = 'fstab with _netdev: remounts automatically at boot after network.';
  } else if (remote.type === 'smb') {
    const cred = `/root/.minipass-cifs-${remote.id}`;
    const user = remote.username ? `username=${remote.username}\n` : '';
    lines.push(`printf '${user}password=<fill-on-host>\n' | sudo tee ${cred} >/dev/null && sudo chmod 600 ${cred}`,
      `sudo mount -t cifs -o credentials=${cred},_netdev ${remote.address} ${mount}`,
      `echo '${remote.address} ${mount} cifs credentials=${cred},_netdev 0 0' | sudo tee -a /etc/fstab`);
    persist = 'credentials file stays 0600 on the host; fstab reconnects at boot.';
  } else if (remote.type === 'sshfs') {
    const login = remote.username ? `${remote.username}@` : '';
    const host = remote.address.replace(/^ssh:\/\//, '');
    const source = host.includes(':') ? host : host + ':';
    lines.push(`sudo sshfs ${login}${source} ${mount} -o reconnect,ServerAliveInterval=15,ServerAliveCountMax=3,allow_other,_netdev`,
      `# persistent: ${remote.address} ${mount} fuse.sshfs reconnect,ServerAliveInterval=15,allow_other,_netdev 0 0  (or prefer key-based auth, no password stored)`);
    persist = 'reconnect + ServerAlive keeps the session alive; key-based auth avoids passwords entirely.';
  } else if (remote.type === 'rclone-gdrive' || remote.type === 'rclone-onedrive') {
    const name = remote.type === 'rclone-gdrive' ? 'Google Drive' : 'OneDrive';
    lines.push(`sudo rclone config   # create a '${remote.id}' remote for ${name} on the host, once`,
      `sudo rclone mount ${remote.id}: ${mount} --daemon --vfs-cache-mode writes --allow-other`,
      `# persistent: a systemd unit running the same rclone mount with Restart=always (enable it after the first manual mount works)`);
    persist = 'systemd unit with Restart=always keeps the cloud mount connected across reboots.';
  } else {
    lines.push(`# mount ${remote.address} at ${mount} with the filesystem's own tool, then add it to /etc/fstab with _netdev so it reconnects at boot`);
    persist = 'fstab entry with _netdev keeps it connected at boot.';
  }
  return { id: remote.id, type: remote.type, address: remote.address, mount, steps: lines, persist, verify,
    note: 'Backup-class only: remotes cannot enforce site quotas. Secrets stay on the host; the panel never displays them.' };
}

module.exports = { REMOTE_TYPES, QUOTA_CAPABLE, discovery, loadRemotes, publicRemote, addRemote, removeRemote, requestProvision, provisionStatus, validTarget, remoteSetup };
