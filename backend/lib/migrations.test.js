const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { COMMAND_RE, targetFor, localOnlyCommand, detectMigrations } = require('./migrations');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'minipass-migrations-'));
const put = (name, content = '') => {
  const file = path.join(tmp, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
};

try {
  const splitServices = [
    { name: 'web', subdir: 'client', enabled: true },
    { name: 'api', subdir: 'server', enabled: true }
  ];
  assert.deepEqual(targetFor('server', splitServices), { service: 'api', dir: '', runnable: true });
  assert.deepEqual(targetFor('server/jobs', splitServices), { service: 'api', dir: 'jobs', runnable: true });
  assert.deepEqual(targetFor('', splitServices), { service: null, dir: '', runnable: false });

  put('package.json', JSON.stringify({ scripts: { migrate: 'cd server && npm run migrate' } }));
  put('server/package.json', JSON.stringify({
    scripts: { migrate: 'knex migrate:latest', 'db:init': 'node baseline.js', 'db:seed': 'node seed.js' },
    dependencies: { knex: '^3.0.0' }
  }));
  put('server/knexfile.js', 'module.exports = {\n  development: { client: "mysql" }\n};');
  put('server/jobs/manage.py', '');
  put('server/python/alembic.ini', '');
  put('server/sequelize/package.json', JSON.stringify({ dependencies: { 'sequelize-cli': '^6.0.0' } }));
  put('server/typeorm/package.json', JSON.stringify({ dependencies: { typeorm: '^0.3.0' } }));
  put('server/drizzle/package.json', JSON.stringify({ dependencies: { 'drizzle-orm': '^0.44.0' } }));
  put('server/drizzle/drizzle.config.ts', '');
  put('server/mikro/package.json', JSON.stringify({ dependencies: { '@mikro-orm/core': '^6.0.0' } }));
  put('server/laravel/composer.json', JSON.stringify({ require: { 'laravel/framework': '^12.0' } }));
  put('server/laravel/artisan', '');
  put('server/laravel/database/migrations/.keep', '');
  put('server/doctrine/composer.json', JSON.stringify({ require: { 'doctrine/migrations': '^3.0' } }));
  put('server/doctrine/bin/console', '');
  put('server/rails/Gemfile', "gem 'rails'\n");
  put('server/rails/db/migrate/001_create.rb', '');
  put('server/flyway/flyway.conf', '');
  put('server/liquibase/liquibase.properties', '');
  put('server/dbmate/dbmate.yml', '');
  put('server/dotnet/App.csproj', '<Project />');
  put('server/dotnet/Migrations/.keep', '');
  put('server/custom/migration-runner.js', '');
  put('server/raw/sql/001_create.sql', 'CREATE TABLE example (id int);');
  put('client/prisma/schema.prisma', 'datasource db {}');

  const detected = detectMigrations(tmp, splitServices);
  const migrateScript = detected.find(x => x.command === 'npm run migrate' && x.service === 'api');
  assert(migrateScript, 'server migration script detected');
  assert.equal(migrateScript.dir, '', 'service root must not become server/server');
  assert.equal(migrateScript.framework, 'Knex');
  assert.equal(migrateScript.check, './node_modules/.bin/knex migrate:list --env development');
  assert.equal(localOnlyCommand('npx knex migrate:latest'), './node_modules/.bin/knex migrate:latest');
  assert.equal(localOnlyCommand('npx --no-install knex migrate:latest'), './node_modules/.bin/knex migrate:latest');
  assert.equal(localOnlyCommand('./node_modules/.bin/knex migrate:latest'), './node_modules/.bin/knex migrate:latest');
  assert.equal(localOnlyCommand('npm run migrate'), 'npm run migrate');
  assert(COMMAND_RE.test('./node_modules/.bin/knex migrate:latest'));
  assert(COMMAND_RE.test('./node_modules/.bin/knex migrate:latest --env development'));

  const initial = detected.find(x => x.command === 'npm run db:init');
  assert(initial, 'initialization script detected');
  assert.equal(initial.phase, 'initial');
  assert(!detected.some(x => x.command === 'npm run db:seed'), 'seed scripts are excluded');

  const django = detected.find(x => x.framework === 'Django');
  assert.deepEqual({ service: django.service, dir: django.dir }, { service: 'api', dir: 'jobs' });

  const prisma = detected.find(x => x.framework === 'Prisma');
  assert.deepEqual({ service: prisma.service, dir: prisma.dir }, { service: 'web', dir: '' });

  for (const framework of ['Alembic', 'Sequelize', 'Drizzle', 'MikroORM', 'Laravel', 'Doctrine', 'Rails', 'Flyway', 'Liquibase', 'dbmate', 'EF Core', 'Project migration runner'])
    assert(detected.some(x => x.framework === framework && x.runnable), `${framework} runner detected`);
  assert(detected.some(x => x.framework === 'TypeORM' && !x.runnable), 'ambiguous TypeORM setup is not guessed');
  assert(detected.some(x => x.framework === 'SQL files' && !x.runnable), 'raw SQL needs an explicit database client');

  const rootScript = detected.find(x => x.repoDir === '.' && x.command === 'npm run migrate');
  assert(rootScript && !rootScript.runnable, 'repo-root runner is unavailable without a root-context service');

  const rootServices = [{ name: 'app', subdir: '', enabled: true }];
  const fromRoot = detectMigrations(tmp, rootServices);
  const nested = fromRoot.find(x => x.framework === 'Knex' && x.repoDir === 'server' && x.command.startsWith('./node_modules/.bin/knex'));
  assert.deepEqual({ service: nested.service, dir: nested.dir }, { service: 'app', dir: 'server' });
  assert.equal(nested.command, './node_modules/.bin/knex migrate:latest --env development');

  console.log('migration detection: OK');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
