// Host-enforced ext4 project quotas. The panel never needs a privileged mount
// or access to the host's block devices; a root-only Unix socket owns allocation.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const exec = promisify(execFile);
const GB = 1000000000;
const validId = id => id !== 'minipass' && /^[a-z0-9][a-z0-9-]{0,31}$/.test(id || '');
function limitBytes(value) {
  if (!/^(?:[1-9]\d*|0)(?:\.\d{1,3})?$/.test(String(value ?? ''))) throw Object.assign(new Error('storage allowance must be a number in GB (up to 3 decimal places)'), { status: 400 });
  const n = Math.round(Number(value) * GB);
  if (!Number.isSafeInteger(n) || n < 100000000 || n > 1000000 * GB) throw Object.assign(new Error('storage allowance must be between 0.1 and 1,000,000 GB'), { status: 400 });
  return n;
}
function request(method, route, body, socketPath = process.env.QUOTA_SOCKET || path.join(path.dirname(process.env.DATA_FILE || path.join(__dirname, '../data.json')), 'storage-quotas.sock')) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : '';
    const fail = () => reject(Object.assign(new Error('Storage quotas are not ready. Run the Linux installer on the host; check its maintenance/reboot instructions.'), { status: 503 }));
    const req = http.request({ socketPath, path: route, method, headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }, timeout: 15000 }, res => {
      let text = '';
      res.on('data', chunk => { text += chunk; if (text.length > 65536) req.destroy(); });
      res.on('error', fail);
      res.on('end', () => {
        try {
          const data = JSON.parse(text);
          if (res.statusCode >= 400) reject(Object.assign(new Error(data.error || 'Storage quota operation failed'), { status: res.statusCode }));
          else resolve(data);
        } catch { fail(); }
      });
    });
    req.on('error', fail);
    req.on('timeout', () => req.destroy());
    req.end(payload);
  });
}
const siteRoute = id => { if (!validId(id)) throw new Error('invalid quota site id'); return '/sites/' + id; };
const status = () => request('GET', '/status');
const reserve = (id, bytes) => request('POST', siteRoute(id), { limitBytes: bytes });
const usage = id => request('GET', siteRoute(id));
const release = id => request('DELETE', siteRoute(id));
async function ensure(meta) {
  if (!meta.storageQuota || !meta.storageQuota.projectId) return; // legacy or recorded-but-unenforced: nothing to verify
  const current = await usage(meta.id);
  if (!current.enforced || current.projectId !== meta.storageQuota.projectId || current.limitBytes !== meta.storageQuota.limitBytes) throw Object.assign(new Error('site storage quota is not enforced or differs from its saved allowance; repair host quota setup before continuing'), { status: 503 });
}

function databaseBindings(dir) {
  const text = fs.readFileSync(path.join(dir, 'docker-compose.yml'), 'utf8');
  const offset = text.search(/^volumes:[ \t]*\r?$/m);
  if (offset < 0) return [];
  const volumes = text.slice(offset);
  const result = [];
  for (const m of volumes.matchAll(/^  (dbdata(?:-(?:postgres|mysql|mariadb|mongo|redis))?):[^\n]*\n((?:[ \t]{4}[^\n]*(?:\n|$))*)/gm)) {
    const name = m[1], block = m[2];
    let device;
    try { device = JSON.parse((block.match(/^      device: (.+)$/m) || [])[1]); } catch {}
    if (!/^    driver: local$/m.test(block) || !/^      type: none$/m.test(block) || !/^      o: bind$/m.test(block) || device !== path.join(dir, '.dbdata', name).replace(/\\/g, '/')) throw new Error('managed database volume is outside this site storage allowance; explicit migration/repair is required');
    result.push({ name, device });
  }
  return result;
}
async function verifyDatabases(id, dir, run = args => exec(process.env.DOCKER_BIN || 'docker', args, { timeout: 15000, maxBuffer: 1024 * 1024 })) {
  if (!validId(id)) throw new Error('invalid quota site id');
  const expected = databaseBindings(dir);
  if (!expected.length) return;
  const listed = await run(['volume', 'ls', '--quiet']);
  const names = new Set(String(listed.stdout || '').trim().split(/\s+/));
  for (const binding of expected) {
    const name = id + '_' + binding.name;
    if (!names.has(name)) continue; // first deploy creates the charged volume
    const inspected = await run(['volume', 'inspect', '--format', '{{json .Options}}', name]);
    const options = JSON.parse(inspected.stdout);
    if (!options || options.type !== 'none' || options.o !== 'bind' || options.device !== binding.device) throw new Error('existing managed database volume is outside the site allowance; migrate it explicitly before deploying (no data has been changed)');
  }
}

// Keep Docker named-volume lifecycles, but bind their data into the charged
// site directory. Legacy sites/volumes are NEVER automatically migrated.
function quotaVolumes(text, dir) {
  return text.replace(/^  (dbdata(?:-(?:postgres|mysql|mariadb|mongo|redis))?):[ \t]*\r?$/gm, (header, name, offset, source) => {
    if (/^\r?\n[ \t]{4}/.test(source.slice(offset + header.length))) return header;
    const data = path.join(dir, '.dbdata', name);
    fs.mkdirSync(data, { recursive: true });
    return `  ${name}:\n    driver: local\n    driver_opts:\n      type: none\n      o: bind\n      device: ${JSON.stringify(data.replace(/\\/g, '/'))}`;
  });
}
function bindDatabases(dir) {
  const file = path.join(dir, 'docker-compose.yml');
  const original = fs.readFileSync(file, 'utf8');
  let text = original;
  // The official Mongo image also declares /data/configdb. Bind it explicitly
  // so Docker cannot create an uncharged anonymous database-data volume.
  const { parseComposeServices } = require('./services');
  for (const block of parseComposeServices(text)) {
    if (!['db', 'db-mongo'].includes(block.name) || !block.lines.some(l => /^    image: mongo:/.test(l))) continue;
    const before = `  ${block.name}:\n` + block.lines.join('\n');
    if (before.includes(':/data/configdb')) continue;
    const name = block.name + '-configdb';
    const after = before.replace(/^(      - [^\n]+:\/data\/db)[ \t]*$/m, `$1\n      - ${JSON.stringify('./.dbdata/' + name + ':/data/configdb')}`);
    if (after === before) throw new Error('managed MongoDB data mount is missing; cannot enforce its storage allowance');
    fs.mkdirSync(path.join(dir, '.dbdata', name), { recursive: true });
    text = text.replace(before, after);
  }
  // Only newly generated empty managed-volume definitions are changed. Already
  // bound definitions round-trip intact when adding services/databases later.
  const offset = text.search(/^volumes:\s*$/m);
  if (offset < 0) return;
  const out = text.slice(0, offset) + quotaVolumes(text.slice(offset), dir);
  if (out !== original) fs.writeFileSync(file, out);
}
function repositorySize(tree) {
  const blobs = (tree.tree || []).filter(e => e.type === 'blob');
  const total = blobs.reduce((sum, e) => sum + (Number.isSafeInteger(e.size) && e.size >= 0 ? e.size : 0), 0);
  const bytes = Array.isArray(tree.tree) && Number.isSafeInteger(total) ? total : null;
  const complete = bytes !== null && !tree.truncated && blobs.every(e => Number.isSafeInteger(e.size) && e.size >= 0);
  return { bytes, complete, basis: 'selected-branch blobs', excludes: 'Git history, LFS downloads, dependencies, build output and database data' };
}
module.exports = { GB, validId, limitBytes, request, status, reserve, usage, release, ensure, bindDatabases, databaseBindings, verifyDatabases, quotaVolumes, repositorySize };
