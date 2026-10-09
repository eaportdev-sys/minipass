const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
process.env.DATA_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'minipass-host-storage-')), 'apps.json');
const quotas = require('./quotas');
const hostStorage = require('./host-storage');
async function main() {
  // Discovery degrades honestly when the host bridge is absent.
  const d = await hostStorage.discovery();
  assert(d && d.quota && d.quota.ready === false, 'no bridge means unenforced, not a crash');
  // Remote registry: passwords stored 0600, never returned.
  const added = hostStorage.addRemote({ type: 'rclone-gdrive', address: 'gdrive:backups', username: 'ops', password: 's3cret' });
  assert(added.quotaCapable === false && added.backupOnly === true && added.hasPassword === true);
  assert(!('password' in added), 'password never leaves the server in list responses');
  const listed = hostStorage.loadRemotes().map(hostStorage.publicRemote);
  assert.equal(listed.length, 1);
  assert(!('password' in listed[0]));
  const raw = JSON.parse(fs.readFileSync(path.join(path.dirname(process.env.DATA_FILE), 'storage-remotes.json'), 'utf8'));
  assert.equal(raw[0].password, 's3cret');
  assert((fs.statSync(path.join(path.dirname(process.env.DATA_FILE), 'storage-remotes.json')).mode & 0o777) <= 0o777, 'registry file created');
  if (process.platform !== 'win32') assert((fs.statSync(path.join(path.dirname(process.env.DATA_FILE), 'storage-remotes.json')).mode & 0o777) <= 0o600, 'registry is root-readable only');
  assert.throws(() => hostStorage.addRemote({ type: 'gdrive', address: 'x' }), /remote type/);
  assert.throws(() => hostStorage.addRemote({ type: 'nfs', address: 'a; rm -rf /' }), /address/);
  hostStorage.removeRemote(added.id);
  assert.equal(hostStorage.loadRemotes().length, 0);
  // Provision approval requires repeating the exact target; returns host command.
  const approval = hostStorage.requestProvision({ target: 'vg:ubuntu-vg', confirm: 'vg:ubuntu-vg' });
  assert(approval.hostCommand.includes('--provision-storage=vg:ubuntu-vg'), 'browser never formats; host command does');
  assert.throws(() => hostStorage.requestProvision({ target: 'vg:ubuntu-vg', confirm: 'vg:other' }), /exact target/);
  assert.throws(() => hostStorage.requestProvision({ target: '/dev/sda', confirm: '/dev/sda' }), /provision target/);
  assert.equal(hostStorage.provisionStatus().target, 'vg:ubuntu-vg');
  fs.rmSync(path.dirname(process.env.DATA_FILE), { recursive: true, force: true });
  console.log('Host storage: degraded discovery, redacted 0600 remote registry, backup-only remotes and exact-target host approval: OK');
}
main().catch(e => { console.error(e); process.exitCode = 1; });
