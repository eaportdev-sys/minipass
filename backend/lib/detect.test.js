const assert = require('assert');
const { decideType, detectPackageManager, findBackends, findFrontends, prismaDatabaseHints, databaseConfigHints, sqlDatabaseHints, hasRunnableEntry } = require('./detect');

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

// Laravel apps carry a root package.json that is only the Vite asset pipeline -
// composer.json + artisan must win over the vite/react heuristics above.
const laravelPkg = { scripts: { build: 'vite build', dev: 'vite' }, devDependencies: { vite: '^8.0.0', 'laravel-vite-plugin': '^3.0.0', tailwindcss: '^4.0.0' } };
const laravel = decideType(
  ['composer.json', 'artisan', 'package.json', 'vite.config.js', 'routes/web.php', 'resources/views/welcome.blade.php', 'config/database.php'],
  laravelPkg
);
assert.equal(laravel.type, 'php', JSON.stringify(laravel));
assert(laravel.reason.includes('asset pipeline'), JSON.stringify(laravel));

// PHP without Laravel markers keeps the old behavior: a React root package
// still classifies as a frontend, plain composer projects as PHP.
const spaOverPhp = decideType(['composer.json', 'package.json', 'vite.config.js'],
  { scripts: { build: 'vite build' }, dependencies: { react: '^18.0.0' } });
assert.equal(spaOverPhp.type, 'react', JSON.stringify(spaOverPhp));
const plainPhp = decideType(['composer.json', 'index.php'], null);
assert.equal(plainPhp.type, 'php', JSON.stringify(plainPhp));

// Next.js runs as a Node server (build + start) - never the nginx static
// template, even when a vite config sits alongside next.config in one repo.
const nextPkg = { scripts: { dev: 'node run.mjs dev', build: 'node run.mjs build', start: 'next dev -p 3000' }, dependencies: { next: '16.3.4', react: '^19.0.0', 'react-dom': '^19.0.0' } };
const nextRoot = decideType(['package.json', 'next.config.ts', 'vite.config.ts', 'app/page.tsx'], nextPkg);
assert.equal(nextRoot.type, 'node', JSON.stringify(nextRoot));
assert.equal(nextRoot.detected, 'next', JSON.stringify(nextRoot));
assert(decideType(['package.json'], { dependencies: { '@neondatabase/serverless': '^1.0.0' } }).dbs.includes('postgres'), 'Neon driver requires postgres');
const nextNoBuild = decideType(['package.json', 'next.config.js'], { scripts: { start: 'next start' }, dependencies: { next: '^15.0.0' } });
assert.equal(nextNoBuild.type, 'node', JSON.stringify(nextNoBuild));
const nuxtRoot = decideType(['package.json', 'nuxt.config.ts'], { scripts: { build: 'nuxt build', start: 'node .output/server/index.mjs' }, dependencies: { nuxt: '^3.0.0' } });
assert.equal(nuxtRoot.type, 'node', JSON.stringify(nuxtRoot));
assert.equal(nuxtRoot.detected, 'start-script', JSON.stringify(nuxtRoot));
const nuxtDev = decideType(['package.json', 'nuxt.config.ts'], { scripts: { build: 'nuxt build', start: 'nuxt dev' }, dependencies: { nuxt: '^3.0.0' } });
assert.equal(nuxtDev.type, 'node', JSON.stringify(nuxtDev));
assert.equal(nuxtDev.detected, 'nuxt', JSON.stringify(nuxtDev));
// The generic rule: any unknown framework with a production start script is a
// node server with no framework patch needed.
const futureFw = decideType(['package.json'], { scripts: { build: 'zapp build', start: 'zapp-serve --port 3000' } });
assert.equal(futureFw.type, 'node', JSON.stringify(futureFw));
assert.equal(futureFw.detected, 'start-script', JSON.stringify(futureFw));
// A declared production server wins even for SPA deps: trust the runtime.
const spaServer = decideType(['package.json', 'vite.config.ts'], { scripts: { build: 'vite build', start: 'serve -s dist' }, dependencies: { react: '^19.0.0' } });
assert.equal(spaServer.type, 'node', JSON.stringify(spaServer));

// One package-manager read for every detector: field wins, then lockfiles.
assert.deepEqual(detectPackageManager({ pkg: { packageManager: 'pnpm@9.1.0' }, files: [] }), { manager: 'pnpm', version: '9.1.0', source: 'packageManager' });
assert.deepEqual(detectPackageManager({ pkg: { packageManager: 'yarn' }, files: [] }), { manager: 'yarn', version: null, source: 'packageManager' });
assert.deepEqual(detectPackageManager({ pkg: { packageManager: 'foo@1' }, files: ['yarn.lock'] }), { manager: 'yarn', version: null, source: 'lockfile' });
assert.deepEqual(detectPackageManager({ pkg: {}, files: ['apps/web/pnpm-lock.yaml'] }), { manager: 'pnpm', version: null, source: 'lockfile' });
assert.deepEqual(detectPackageManager({ pkg: null, files: ['sub\\yarn.lock'] }), { manager: 'yarn', version: null, source: 'lockfile' });
assert.deepEqual(detectPackageManager({ pkg: {}, files: ['bun.lockb'] }), { manager: 'bun', version: null, source: 'lockfile' });
assert.deepEqual(detectPackageManager({ pkg: {}, files: ['package-lock.json'] }), { manager: 'npm', version: null, source: 'lockfile' });
assert.deepEqual(detectPackageManager({}), { manager: 'npm', version: null, source: 'default' });

// Next/Nuxt subdirs are not suggested as static frontends ...
const ssrTree = ['web/package.json', 'web/next.config.js', 'web/src/app.tsx', 'shop/nuxt.config.ts', 'shop/package.json'];
const ssrPkgs = {
  web: { scripts: { build: 'next build', start: 'next dev' }, dependencies: { next: '^15.0.0', react: '^19.0.0' } },
  shop: { scripts: { build: 'nuxt build', start: 'nuxt dev' }, dependencies: { nuxt: '^3.0.0' } }
};
const ssrFronts = findFrontends(ssrTree, ssrPkgs);
assert(!ssrFronts.includes('web') && !ssrFronts.includes('shop'), 'next/nuxt dirs are not static frontends: ' + ssrFronts);
// ... a Next dir with a production start script is a node backend, while a
// dev-only start script stays unsuggested (dev servers are not backends).
const prodNext = findBackends(['srv/package.json'], { srv: { scripts: { build: 'next build', start: 'next start' } } }, []);
assert(prodNext.includes('srv'), 'production next start is a backend: ' + prodNext);
const devNext = findBackends(['web/package.json'], ssrPkgs, []);
assert(!devNext.includes('web'), 'dev-only next start is not a backend: ' + devNext);

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
assert.deepEqual(databaseConfigHints('.env.example', 'DB_CONNECTION=sqlite\nDB_HOST=127.0.0.1'), ['sqlite']);
assert.deepEqual(databaseConfigHints('config/database.php', `'default' => env('DB_CONNECTION', 'mysql')`), ['mysql']);
assert.deepEqual(databaseConfigHints('config/database.php', `'default' => env('DB_CONNECTION', 'sqlite')`), ['sqlite']);
assert.deepEqual(databaseConfigHints('src/data-source.ts', 'export default { type: process.env.DB_TYPE }'), []);
assert.deepEqual(databaseConfigHints('drizzle.config.ts', `export default { dialect: 'sqlite' }`), ['sqlite']);
assert.deepEqual(databaseConfigHints('config/config.js', `// dialect: 'mysql'\nmodule.exports = { dialect: 'postgres' }`), ['postgres']);
assert.deepEqual(databaseConfigHints('config/config.json', `{"development":{"dialect":"mysql"},"production":{"dialect":"postgres"}}`), []);

assert.deepEqual(sqlDatabaseHints('CREATE EXTENSION IF NOT EXISTS pgcrypto;'), ['postgres']);
assert.deepEqual(sqlDatabaseHints('id BIGINT AUTO_INCREMENT PRIMARY KEY ENGINE=InnoDB;'), ['mysql']);
assert.deepEqual(sqlDatabaseHints('-- MariaDB dump\nENGINE=InnoDB;'), ['mariadb']);

// Runnable-entry gate agrees with the template seeder: real entries pass,
// script samples and dev-only servers fail fast with a named fix.
assert(hasRunnableEntry(['package.json', 'src/main.js'], { scripts: { start: 'node src/main.js' } }, 'node').runnable);
assert(hasRunnableEntry(['server.js'], null, 'node').runnable);
assert(!hasRunnableEntry(['connection.js', 'query.js'], null, 'node').runnable, 'sample scripts are not a server');
assert(!hasRunnableEntry(['package.json'], { scripts: { start: 'vite', build: 'vite build' } }, 'node').runnable, 'dev server start is not production');
assert(hasRunnableEntry(['index.html'], null, 'static').runnable);
assert(!hasRunnableEntry(['README.md'], null, 'static').runnable);
assert(hasRunnableEntry(['package.json'], { scripts: { build: 'vite build' } }, 'react').runnable);
assert(!hasRunnableEntry(['package.json'], { scripts: { dev: 'vite' } }, 'react').runnable);
assert(hasRunnableEntry(['index.php'], null, 'php').runnable);
assert(!hasRunnableEntry(['README.md'], null, 'php').runnable);

// Tooling-only manifests (grunt, no start/entry/server) with an index.html read
// static, not node.
const hover = decideType(['index.html', 'package.json', 'css/hover.css'], { devDependencies: { grunt: '~0.4.1' } });
assert.equal(hover.type, 'static', JSON.stringify(hover));
const emptyStatic = decideType(['README.md', 'index.html', 'package.json', 'script.js'], null);
assert.equal(emptyStatic.type, 'static', JSON.stringify(emptyStatic));
const emptyServer = decideType(['server.js', 'package.json'], null);
assert.equal(emptyServer.type, 'node', JSON.stringify(emptyServer));
assert.equal(emptyServer.detected, 'server-entry', JSON.stringify(emptyServer));

console.log('frontend/backend folder classification: OK');
