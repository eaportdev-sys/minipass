const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Freeze password generation so byte-sensitive legacy output can be compared
// exactly while adding new database types.
const originalRandomBytes = crypto.randomBytes;
crypto.randomBytes = n => Buffer.alloc(n);
const { DB_IMAGES, normDbs, dbEnv, dbService } = require('./generator');
const { databaseConfig } = require('./db-tools');
const { decideType, sqlDatabaseHints } = require('./detect');
const password = 'A'.repeat(24);

try {
  assert.deepEqual(dbEnv('postgres', 'sample'), {
    lines: ['DB_HOST=db', 'DB_PORT=5432', 'DB_NAME=sample', 'DB_USER=sample', `DB_PASSWORD=${password}`, `POSTGRES_PASSWORD=${password}`],
    compose: `  db:\n    image: postgres:16-alpine\n    restart: unless-stopped\n    environment:\n      POSTGRES_DB: sample\n      POSTGRES_USER: sample\n      POSTGRES_PASSWORD: ${password}\n    volumes:\n      - dbdata:/var/lib/postgresql/data`
  }, 'legacy single PostgreSQL output remains byte-identical');

  assert.deepEqual(dbEnv('mysql', 'sample'), {
    lines: ['DB_HOST=db', 'DB_PORT=3306', 'DB_NAME=sample', 'DB_USER=sample', `DB_PASSWORD=${password}`, `MYSQL_ROOT_PASSWORD=${password}`],
    compose: `  db:\n    image: mysql:8\n    restart: unless-stopped\n    environment:\n      MYSQL_DATABASE: sample\n      MYSQL_USER: sample\n      MYSQL_PASSWORD: ${password}\n      MYSQL_ROOT_PASSWORD: ${password}\n    volumes:\n      - dbdata:/var/lib/mysql`
  }, 'legacy single MySQL output remains byte-identical');

  const maria = dbEnv('mariadb', 'sample');
  assert.equal(DB_IMAGES.mariadb, 'mariadb:11.8');
  assert(maria.compose.includes('image: mariadb:11.8'));
  assert(maria.compose.includes('MARIADB_DATABASE: sample'));
  assert(maria.lines.includes('DB_HOST=db'));
  assert(maria.lines.includes(`MARIADB_ROOT_PASSWORD=${password}`));

  const multi = dbService('mariadb', 'Sample App', 'db-mariadb', 'dbdata-mariadb');
  assert(multi.lines.includes('MARIADB_HOST=db-mariadb'));
  assert.equal(multi.url, `mysql://sampleapp:${password}@db-mariadb:3306/sampleapp`);
  assert.equal(multi.info.port, 3306);
  assert.deepEqual(normDbs(['mysql', 'mariadb', 'mysql']), ['mysql', 'mariadb']);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'minipass-mariadb-'));
  try {
    fs.writeFileSync(path.join(tmp, '.env'), `MARIADB_HOST=db-mariadb\nMARIADB_PORT=3306\nMARIADB_DB=sample\nMARIADB_USER=sample\nMARIADB_PASSWORD=${password}\n`);
    assert.deepEqual(databaseConfig({ db: ['mariadb'] }, tmp, 'mariadb'), {
      service: 'db-mariadb', host: 'db-mariadb', port: 3306, user: 'sample', pass: password, db: 'sample'
    });
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }

  const detected = decideType(['package.json'], { dependencies: { mariadb: '^3.0.0' }, scripts: { start: 'node index.js' } });
  assert.deepEqual(detected.dbs, ['mariadb']);
  assert.deepEqual(sqlDatabaseHints('DEFAULT COLLATE=utf8mb4_uca1400_ai_ci;'), ['mariadb']);
  assert.deepEqual(sqlDatabaseHints('-- MariaDB dump 10.19'), ['mariadb']);
  assert.deepEqual(sqlDatabaseHints('COLLATE=utf8mb4_0900_ai_ci;'), []);
  console.log('database generation and MariaDB support: OK');
} finally {
  crypto.randomBytes = originalRandomBytes;
}
