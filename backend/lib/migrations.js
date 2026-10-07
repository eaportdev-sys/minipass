const fs = require('fs');
const path = require('path');

const SKIP_DIRS = new Set([
  '.git', '.next', '.nuxt', '.output', '.venv', 'build', 'coverage',
  'dist', 'node_modules', 'target', 'vendor'
]);
const COMMAND_RE = /^(?:[A-Za-z0-9_][A-Za-z0-9_ .:/=-]{0,199}|\.\/node_modules\/\.bin\/[A-Za-z0-9_.-]+(?: [A-Za-z0-9_ .:/=-]{0,160})?)$/;
const DIR_RE = /^[A-Za-z0-9_][A-Za-z0-9_./-]{0,80}$/;

function cleanRel(value) {
  const s = String(value || '').replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+|\/+$/g, '');
  return s === '.' ? '' : s;
}

// A command runs inside a service image, so its cwd is relative to that
// service's build context - not relative to the repository. Prefer the most
// specific service when build contexts are nested.
function targetFor(projectDir, services) {
  const project = cleanRel(projectDir);
  const matches = (services || [])
    .filter(s => s && s.enabled !== false)
    .map(s => ({ ...s, subdir: cleanRel(s.subdir) }))
    .filter(s => !s.subdir || project === s.subdir || project.startsWith(s.subdir + '/'))
    .sort((a, b) => b.subdir.length - a.subdir.length);
  const service = matches[0];
  if (!service) return { service: null, dir: '', runnable: false };
  const dir = service.subdir ? project.slice(service.subdir.length).replace(/^\//, '') : project;
  return { service: service.name, dir, runnable: true };
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function readText(file, max = 256 * 1024) {
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > max) return '';
    return fs.readFileSync(file, 'utf8');
  } catch { return ''; }
}

function exists(dir, name) {
  try { return fs.existsSync(path.join(dir, name)); } catch { return false; }
}

function anyFile(files, ...names) {
  return names.some(n => files.has(n));
}

function walkDirs(root, maxDepth = 4, maxDirs = 300) {
  const out = [];
  const visit = (dir, rel, depth) => {
    if (out.length >= maxDirs) return;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    const files = new Set(entries.filter(e => e.isFile()).map(e => e.name));
    out.push({ dir, rel: cleanRel(rel), files });
    if (depth >= maxDepth) return;
    for (const e of entries) {
      if (out.length >= maxDirs) break;
      if (!e.isDirectory() || e.isSymbolicLink() || SKIP_DIRS.has(e.name)) continue;
      visit(path.join(dir, e.name), rel ? `${rel}/${e.name}` : e.name, depth + 1);
    }
  };
  visit(root, '', 0);
  return out;
}

function npmRunner(pkg, files, script) {
  const declared = String((pkg && pkg.packageManager) || '').toLowerCase();
  if (declared.startsWith('pnpm') || files.has('pnpm-lock.yaml')) return `pnpm run ${script}`;
  if (declared.startsWith('yarn') || files.has('yarn.lock')) return `yarn ${script}`;
  if (declared.startsWith('bun') || files.has('bun.lock') || files.has('bun.lockb')) return `bun run ${script}`;
  return `npm run ${script}`;
}

function frameworkFrom(text) {
  const s = String(text || '').toLowerCase();
  if (s.includes('prisma')) return 'Prisma';
  if (s.includes('knex')) return 'Knex';
  if (s.includes('sequelize')) return 'Sequelize';
  if (s.includes('typeorm')) return 'TypeORM';
  if (s.includes('drizzle')) return 'Drizzle';
  if (s.includes('mikro-orm')) return 'MikroORM';
  return 'Project script';
}

function verifyFor(framework) {
  return ({
    Knex: './node_modules/.bin/knex migrate:list',
    Prisma: './node_modules/.bin/prisma migrate status',
    Sequelize: './node_modules/.bin/sequelize-cli db:migrate:status',
    MikroORM: './node_modules/.bin/mikro-orm migration:list'
  })[framework] || '';
}

// Invoke the repository binary directly. New npm versions can ignore npx's old
// --no-install flag and still contact the registry, so that flag is not a hard
// local-only guarantee.
function localOnlyCommand(command) {
  const cmd = String(command || '').trim();
  const match = cmd.match(/^npx(?:\s+--no-install)?\s+([A-Za-z0-9_.-]+)(?=\s|$)/);
  if (!match) return cmd;
  return cmd.replace(match[0], `./node_modules/.bin/${match[1]}`);
}

function detectMigrations(codeDir, services) {
  const found = [];
  const seen = new Set();
  const add = (candidate) => {
    const repoDir = cleanRel(candidate.repoDir);
    const target = targetFor(repoDir, services);
    const command = candidate.command || '';
    const safeCommand = !command || COMMAND_RE.test(command);
    const item = {
      framework: candidate.framework,
      phase: candidate.phase || 'deploy',
      command,
      check: candidate.check || '',
      why: candidate.why || '',
      repoDir: repoDir || '.',
      service: target.service,
      dir: target.dir,
      runnable: !!command && safeCommand && target.runnable,
      explicit: !!candidate.explicit
    };
    if (!safeCommand) item.problem = 'The detected command name contains characters the safe runner does not accept; wrap it in a simple project script.';
    else if (!target.runnable) item.problem = 'No enabled service image contains this repository folder.';
    else if (!candidate.command) item.problem = candidate.problem || 'Detected, but no safe universal command can be inferred.';
    const key = [item.framework, item.command, item.service || '', item.dir, item.problem || ''].join('|');
    if (!seen.has(key)) { seen.add(key); found.push(item); }
  };

  for (const entry of walkDirs(codeDir)) {
    const { dir, rel, files } = entry;
    const pkg = files.has('package.json') ? readJson(path.join(dir, 'package.json')) : null;
    const deps = { ...((pkg && pkg.dependencies) || {}), ...((pkg && pkg.devDependencies) || {}) };
    if (pkg && pkg.scripts) {
      for (const [name, value] of Object.entries(pkg.scripts)) {
        if (/^(db:)?seed/i.test(name)) continue;
        if (!/migrat|baseline|^db:(init|setup)$/i.test(name) && !/migrat|baseline/i.test(String(value || ''))) continue;
        const framework = frameworkFrom(`${name} ${value}`);
        const phase = /baseline|^db:(init|setup)$/i.test(name) ? 'initial' : 'deploy';
        add({
          framework,
          phase,
          command: npmRunner(pkg, files, name),
          check: verifyFor(framework),
          why: `${name} script in ${rel || 'repository root'}/package.json`,
          repoDir: rel,
          explicit: true
        });
      }
    }

    if (files.has('migration-runner.js') || exists(dir, 'dist/migration-runner.js')) {
      const runner = exists(dir, 'dist/migration-runner.js') ? 'node dist/migration-runner.js' : 'node migration-runner.js';
      add({ framework: 'Project migration runner', command: `${runner} all`, why: 'Project migration runner found', repoDir: rel, explicit: true });
    }

    if (anyFile(files, 'knexfile.js', 'knexfile.ts', 'knexfile.cjs', 'knexfile.mjs'))
      add({ framework: 'Knex', command: './node_modules/.bin/knex migrate:latest', check: './node_modules/.bin/knex migrate:list', why: 'Knex configuration found; uses the repository-installed Knex version', repoDir: rel });

    if (exists(dir, 'prisma/schema.prisma') || files.has('schema.prisma'))
      add({ framework: 'Prisma', command: './node_modules/.bin/prisma migrate deploy', check: './node_modules/.bin/prisma migrate status', why: 'Prisma schema found; uses the repository-installed Prisma version', repoDir: rel });

    if (files.has('.sequelizerc') || deps['sequelize-cli'] || (exists(dir, 'migrations') && exists(dir, 'config')))
      add({ framework: 'Sequelize', command: './node_modules/.bin/sequelize-cli db:migrate', check: './node_modules/.bin/sequelize-cli db:migrate:status', why: 'Sequelize migration setup found; uses the repository-installed CLI', repoDir: rel });

    if (deps.typeorm || [...files].some(f => /^(ormconfig|data-source)\.(js|cjs|mjs|ts|json)$/.test(f)))
      add({ framework: 'TypeORM', command: '', why: 'TypeORM found', repoDir: rel, problem: 'Add a package.json migration script that includes the project data-source option.' });

    if (deps['drizzle-orm'] && [...files].some(f => /^drizzle\.config\.(js|cjs|mjs|ts)$/.test(f)))
      add({ framework: 'Drizzle', command: './node_modules/.bin/drizzle-kit migrate', why: 'Drizzle configuration found; uses the repository-installed CLI', repoDir: rel });

    if (deps['@mikro-orm/core'])
      add({ framework: 'MikroORM', command: './node_modules/.bin/mikro-orm migration:up', check: './node_modules/.bin/mikro-orm migration:list', why: 'MikroORM dependency found; uses the repository-installed CLI', repoDir: rel });

    if (files.has('manage.py'))
      add({ framework: 'Django', command: 'python manage.py migrate --noinput', check: 'python manage.py showmigrations --plan', why: 'Django manage.py found', repoDir: rel });

    if (files.has('alembic.ini'))
      add({ framework: 'Alembic', command: 'alembic upgrade head', check: 'alembic current', why: 'Alembic configuration found', repoDir: rel });

    const composer = files.has('composer.json') ? readJson(path.join(dir, 'composer.json')) : null;
    const phpDeps = { ...((composer && composer.require) || {}), ...((composer && composer['require-dev']) || {}) };
    if (files.has('artisan') && (phpDeps['laravel/framework'] || exists(dir, 'database/migrations')))
      add({ framework: 'Laravel', command: 'php artisan migrate --force', check: 'php artisan migrate:status', why: 'Laravel Artisan migration setup found', repoDir: rel });

    if (composer && (phpDeps['doctrine/migrations'] || phpDeps['doctrine/doctrine-migrations-bundle']) && exists(dir, 'bin/console'))
      add({ framework: 'Doctrine', command: 'php bin/console doctrine:migrations:migrate --no-interaction', check: 'php bin/console doctrine:migrations:status', why: 'Doctrine Migrations setup found', repoDir: rel });

    const gemfile = files.has('Gemfile') ? readText(path.join(dir, 'Gemfile')) : '';
    if (/\bgem\s+['"]rails['"]/.test(gemfile) && exists(dir, 'db/migrate'))
      add({ framework: 'Rails', command: 'bundle exec rails db:migrate', check: 'bundle exec rails db:migrate:status', why: 'Rails migrations directory found', repoDir: rel });

    if (files.has('flyway.conf'))
      add({ framework: 'Flyway', command: 'flyway migrate', check: 'flyway info', why: 'Flyway configuration found', repoDir: rel });

    if (files.has('liquibase.properties'))
      add({ framework: 'Liquibase', command: 'liquibase update', check: 'liquibase status', why: 'Liquibase configuration found', repoDir: rel });

    if (files.has('dbmate.yml') || files.has('.dbmate.yml'))
      add({ framework: 'dbmate', command: 'dbmate up', check: 'dbmate status', why: 'dbmate configuration found', repoDir: rel });

    if ([...files].some(f => /\.csproj$/i.test(f)) && exists(dir, 'Migrations'))
      add({ framework: 'EF Core', command: 'dotnet ef database update', check: 'dotnet ef migrations list', why: 'Entity Framework migrations directory found', repoDir: rel });

    if ((/^(migrations?|sql)$/i.test(path.basename(dir))) && [...files].some(f => /\.sql$/i.test(f))) {
      const parent = cleanRel(path.posix.dirname(rel.replace(/\\/g, '/')));
      add({ framework: 'SQL files', command: '', why: `SQL migration files found in ${rel || '.'}`, repoDir: parent === '.' ? '' : parent, problem: 'Choose the database client and declare a command; SQL files alone do not identify the target database.' });
    }
  }

  const useful = found.filter(item => {
    if (item.runnable) return true;
    if (item.framework === 'TypeORM' && found.some(x => x.runnable && x.framework === 'TypeORM' && x.repoDir === item.repoDir)) return false;
    if (item.framework === 'SQL files' && found.some(x => x.runnable && x.repoDir === item.repoDir)) return false;
    return true;
  });
  return useful.sort((a, b) => {
    if (a.runnable !== b.runnable) return a.runnable ? -1 : 1;
    if (a.explicit !== b.explicit) return a.explicit ? -1 : 1;
    if (a.phase !== b.phase) return a.phase === 'deploy' ? -1 : 1;
    return `${a.framework}:${a.repoDir}`.localeCompare(`${b.framework}:${b.repoDir}`);
  });
}

module.exports = { COMMAND_RE, DIR_RE, cleanRel, targetFor, localOnlyCommand, detectMigrations };
