const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { normDbs } = require('./generator');
const { readEnvVars } = require('./env-needs');
const siteConfig = require('./site-configuration')({
  fs, path, normDbs, readEnvVars,
  appDir: (a, n) => path.join(a, n),
});

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'minipass-fill-db-vars-'));
try {
  const dir = path.join(tmp, 'fill1');
  fs.mkdirSync(path.join(dir, 'code'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'code', 'index.js'), [
    'const u = process.env.MONGODB_URI;',
    'const p = process.env.REDIS_PORT;',
    'const c = process.env.CI;',
    'const m = process.env.MONGO_URL;',
    'const h = process.env.BACKUP_MONGO_HOST;',
    'module.exports = [u, p, c, m, h];'
  ].join('\n'));
  fs.writeFileSync(path.join(dir, 'code', '.env.example'), 'MONGODB_URI=mongodb://localhost:27017/dev\n');
  fs.writeFileSync(path.join(dir, '.env'), [
    'MONGO_URL=mongodb://u:p@db-mongo:27017/app?authSource=admin',
    'MONGO_HOST=db-mongo',
    'REDIS_URL=redis://:p@db-redis:6379',
    'REDIS_PORT=6379',
    'BACKUP_MONGO_HOST=',
    ''
  ].join('\n'));
  const meta = { id: 'fill1', db: ['mongo', 'redis'], services: [{ name: 'app', subdir: '', enabled: true }] };
  const filled = siteConfig.fillDatabaseVars(dir, meta);
  assert.deepEqual([...filled].sort(), ['BACKUP_MONGO_HOST', 'MONGODB_URI'], 'only resolvable missing names fill: ' + filled);
  const env = Object.fromEntries(readEnvVars(path.join(dir, '.env')).map(v => [v.key, v.value]));
  assert.equal(env.MONGODB_URI, 'mongodb://u:p@db-mongo:27017/app?authSource=admin', 'local example URL maps to the managed URL');
  assert.equal(env.BACKUP_MONGO_HOST, 'db-mongo', 'present-but-empty keys get their resolved value');
  assert.equal(env.REDIS_PORT, '6379', 'existing values are never overwritten');
  assert(!('CI' in env), 'non-database names keep the honest warning');
  const managed = fs.readFileSync(path.join(dir, '.env.managed'), 'utf8').split('\n').map(s => s.trim()).filter(Boolean);
  assert(managed.includes('MONGODB_URI') && managed.includes('BACKUP_MONGO_HOST'), 'filled keys are tracked managed');
  assert.equal(siteConfig.fillDatabaseVars(dir, meta).length, 0, 'second run is a no-op');
  console.log('Database variable auto-fill from evidence: OK');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
