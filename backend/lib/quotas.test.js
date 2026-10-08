const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const quotas = require('./quotas');
assert.equal(quotas.limitBytes('5'), 5000000000);
assert.equal(quotas.limitBytes('7.125'), 7125000000);
assert.equal(quotas.limitBytes(200), 200000000000);
for (const value of ['', null, undefined, -1, 0, 0.01, '5;rm', 'Infinity', 'NaN', '1e3', '1.0001', 1000001]) assert.throws(() => quotas.limitBytes(value));
assert.deepEqual(quotas.repositorySize({ tree: [{ type: 'blob', size: 128 }, { type: 'tree', size: 999 }, { type: 'blob', size: 256 }] }), { bytes: 384, complete: true, basis: 'selected-branch blobs', excludes: 'Git history, LFS downloads, dependencies, build output and database data' });
assert(!quotas.repositorySize({ truncated: true, tree: [{ type: 'blob', size: 100 }] }).complete);
assert(!quotas.repositorySize({ tree: [{ type: 'blob' }] }).complete);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'minipass-quota-test-'));
try {
  const text = 'services:\n  app:\n    build: ./code\n  db:\n    image: postgres:16-alpine\n    volumes:\n      - dbdata:/var/lib/postgresql/data\n\nvolumes:\n  dbdata:\n  dbdata-redis:\n';
  fs.writeFileSync(path.join(dir, 'docker-compose.yml'), text);
  quotas.bindDatabases(dir);
  const charged = fs.readFileSync(path.join(dir, 'docker-compose.yml'), 'utf8');
  assert.equal(quotas.databaseBindings(dir).length, 2);
  assert(charged.startsWith(text.slice(0, text.indexOf('\nvolumes:'))), 'service blocks/passwords stay identical');
  assert(charged.includes('device: ' + JSON.stringify(path.join(dir, '.dbdata/dbdata').replace(/\\/g, '/'))));
  assert(fs.existsSync(path.join(dir, '.dbdata/dbdata-redis')));
  quotas.bindDatabases(dir);
  assert.equal(fs.readFileSync(path.join(dir, 'docker-compose.yml'), 'utf8'), charged, 'existing bound-volume definitions round-trip without duplication');
  fs.appendFileSync(path.join(dir, 'docker-compose.yml'), '  dbdata-mysql:\n');
  quotas.bindDatabases(dir);
  assert.equal((fs.readFileSync(path.join(dir, 'docker-compose.yml'), 'utf8').match(/driver: local/g) || []).length, 3);
  fs.writeFileSync(path.join(dir, 'docker-compose.yml'), 'services:\n  db-mongo:\n    image: mongo:7\n    volumes:\n      - dbdata-mongo:/data/db\n\nvolumes:\n  dbdata-mongo:\n');
  quotas.bindDatabases(dir);
  const mongo = fs.readFileSync(path.join(dir, 'docker-compose.yml'), 'utf8');
  assert(mongo.includes('./.dbdata/db-mongo-configdb:/data/configdb'));
  assert(fs.existsSync(path.join(dir, '.dbdata/db-mongo-configdb')));
  quotas.bindDatabases(dir);
  assert.equal(fs.readFileSync(path.join(dir, 'docker-compose.yml'), 'utf8'), mongo);
} finally { fs.rmSync(dir, { recursive: true, force: true }); }
async function main() {
  await assert.rejects(() => quotas.request('GET', '/status', null, path.join(os.tmpdir(), 'minipass-no-such-quota-socket-' + process.pid)), e => e.status === 503 && /not ready/.test(e.message));
  await quotas.ensure({ id: 'legacy' });
  const verifyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'minipass-quota-volumes-test-'));
  try {
    fs.writeFileSync(path.join(verifyDir, 'docker-compose.yml'), 'services:\n  db:\n    image: postgres:16-alpine\n    volumes:\n      - dbdata:/var/lib/postgresql/data\n\nvolumes:\n  dbdata:\n');
    assert.throws(() => quotas.databaseBindings(verifyDir), /outside/);
    quotas.bindDatabases(verifyDir);
    const binding = quotas.databaseBindings(verifyDir)[0];
    const calls = [];
    const read = async args => {
      calls.push(args);
      return { stdout: args[1] === 'ls' ? 'demo_dbdata\nother_dbdata' : JSON.stringify({ type: 'none', o: 'bind', device: binding.device }) };
    };
    await quotas.verifyDatabases('demo', verifyDir, read);
    assert(calls.every(args => args.includes('ls') || args.includes('inspect')), 'verification is read-only');
    await assert.rejects(() => quotas.verifyDatabases('demo', verifyDir, async args => ({ stdout: args[1] === 'ls' ? 'demo_dbdata' : '{}' })), /outside the site allowance/);
  } finally { fs.rmSync(verifyDir, { recursive: true, force: true }); }
  const pipe = process.platform === 'win32' ? '\\\\.\\pipe\\minipass-quota-test-' + process.pid : path.join(os.tmpdir(), 'minipass-quota-test-' + process.pid + '.sock');
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', b => { body += b; });
    req.on('end', () => {
      assert.equal(Number(req.headers['content-length']), Buffer.byteLength(body), 'host bridge receives explicit JSON body length, not chunked encoding');
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/failure') { res.statusCode = 409; res.end(JSON.stringify({ error: 'budget reserved elsewhere' })); }
      else res.end(JSON.stringify({ ready: true, sent: body ? JSON.parse(body) : null }));
    });
  });
  await new Promise(resolve => server.listen(pipe, resolve));
  try {
    assert.deepEqual(await quotas.request('POST', '/sites/demo', { limitBytes: 5000000000 }, pipe), { ready: true, sent: { limitBytes: 5000000000 } });
    await assert.rejects(() => quotas.request('GET', '/failure', null, pipe), e => e.status === 409 && e.message === 'budget reserved elsewhere');
  } finally { await new Promise(resolve => server.close(resolve)); }
  console.log('Storage allowances: custom GB validation, source-size estimates, quota-scoped database mounts, round trips and fail-closed host errors: OK');
}
main().catch(e => { console.error(e); process.exitCode = 1; });
