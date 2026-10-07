const assert = require('assert');
const { decideType, findBackends, findFrontends, prismaDatabaseHints, databaseConfigHints, sqlDatabaseHints } = require('./detect');

// Mirrors docker/awesome-compose shapes: CRA frontend, express backend, angular.
const tree = [
  'react-express-mysql/frontend/package.json',
  'react-express-mysql/frontend/public/index.html',
  'react-express-mysql/frontend/src/index.js',
  'react-express-mysql/backend/package.json',
  'react-express-mysql/backend/src/index.js',
  'angular/angular/package.json',
  'angular/angular/angular.json',
  'angular/angular/src/main.ts',
  'shop/vite.config.ts',
  'shop/package.json',
  'shop/src/main.tsx',
  'shop/index.html'
];
const cra = { scripts: { start: 'react-scripts start', build: 'react-scripts build' }, dependencies: { react: '^17.0.2', 'react-dom': '^17.0.2' } };
const api = { main: 'src/index.js', scripts: { start: 'node src/index.js' }, dependencies: { express: '^4.17.1', mysql2: '^2.1.0' } };
const ng = { scripts: { build: 'ng build', start: 'ng serve' }, dependencies: { '@angular/core': '^14.0.0' } };
const vite = { scripts: { build: 'tsc && vite build' }, dependencies: { react: '^18.0.0' } };
const pkgs = {
  'react-express-mysql/frontend': cra,
  'react-express-mysql/backend': api,
  'angular/angular': ng,
  'shop': vite
};

const fronts = findFrontends(tree, pkgs).sort();
assert(fronts.includes('react-express-mysql/frontend'), 'CRA layout is a frontend: ' + fronts);
assert(fronts.includes('angular/angular'), 'angular.json is a frontend: ' + fronts);
assert(fronts.includes('shop'), 'vite config is a frontend: ' + fronts);

const backs = findBackends(tree, pkgs, fronts);
assert.deepEqual(backs, ['react-express-mysql/backend'], 'only the express dir is a backend: ' + backs);

// legacy two-arg call keeps working for existing callers
assert(findBackends(['x/package.json'], { x: api }).includes('x'));

// decideType still calls CRA folders react (folder-scoped Add-service flow)
const r = decideType(['package.json', 'public/index.html', 'src/index.js'], cra);
assert.equal(r.type, 'react', JSON.stringify(r));

assert.deepEqual(prismaDatabaseHints(`
  generator client { provider = "prisma-client-js" }
  datasource db {
    provider = "postgresql"
    url = env("DATABASE_URL")
  }
`), ['postgres']);
assert.deepEqual(prismaDatabaseHints('datasource db { provider = "mysql" }'), ['mysql']);
assert.deepEqual(prismaDatabaseHints('datasource db { provider = "mongodb" }'), ['mongo']);
assert.deepEqual(prismaDatabaseHints('datasource db { provider = "sqlite" }'), []);

assert.deepEqual(databaseConfigHints('config/config.json', '{"production":{"dialect":"postgres"}}'), ['postgres']);
assert.deepEqual(databaseConfigHints('src/data-source.ts', `export default { type: 'mariadb' }`), ['mariadb']);
assert.deepEqual(databaseConfigHints('drizzle.config.ts', `export default { dialect: 'postgresql' }`), ['postgres']);
assert.deepEqual(databaseConfigHints('knexfile.js', `module.exports = { client: 'mysql2' }`), ['mysql']);
assert.deepEqual(databaseConfigHints('.env.example', 'DB_CONNECTION=pgsql\nDB_HOST=127.0.0.1'), ['postgres']);
assert.deepEqual(databaseConfigHints('config/database.php', `'default' => env('DB_CONNECTION', 'mysql')`), ['mysql']);
assert.deepEqual(databaseConfigHints('src/data-source.ts', 'export default { type: process.env.DB_TYPE }'), []);
assert.deepEqual(databaseConfigHints('drizzle.config.ts', `export default { dialect: 'sqlite' }`), []);
assert.deepEqual(databaseConfigHints('config/config.js', `// dialect: 'mysql'\nmodule.exports = { dialect: 'postgres' }`), ['postgres']);
assert.deepEqual(databaseConfigHints('config/config.json', `{"development":{"dialect":"mysql"},"production":{"dialect":"postgres"}}`), []);

assert.deepEqual(sqlDatabaseHints('CREATE EXTENSION IF NOT EXISTS pgcrypto;'), ['postgres']);
assert.deepEqual(sqlDatabaseHints('id BIGINT AUTO_INCREMENT PRIMARY KEY ENGINE=InnoDB;'), ['mysql']);
assert.deepEqual(sqlDatabaseHints('-- MariaDB dump\nENGINE=InnoDB;'), ['mariadb']);

console.log('frontend/backend folder classification: OK');
