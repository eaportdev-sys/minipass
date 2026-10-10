// Static deployment readiness analysis for a repository. Pure functions where
// possible; never executes repository code. Returns a structured report.
const fs = require('fs');
const path = require('path');
const { decideType, findBackends, findFrontends, prismaDatabaseHints, sqlDatabaseHints, databaseConfigHints } = require('./detect');
const { detectMigrations } = require('./migrations');
const { parseExample, exampleFiles, exampleDefaults } = require('./env-defaults');
const { readBuildProfile, localBuildProfile } = require('./build-profile');
const { refreshStandardDockerfile, standardDockerfileType } = require('./dockerfiles');
const { routes: routeLib } = require('./routes');
const { inferPort } = require('./generator');

const MAX_FILE_BYTES = 256 * 1024;
const MAX_SOURCE_SCAN = 200;

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}
function readText(file, max = MAX_FILE_BYTES) {
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.isSymbolicLink() || st.size > max) return '';
    return fs.readFileSync(file, 'utf8');
  } catch { return ''; }
}
function exists(dir, name) {
  try { return fs.existsSync(path.join(dir, name)); } catch { return false; }
}

function collectPaths(ctxDir) {
  const out = [];
  const skip = new Set(['.git', 'node_modules', 'dist', 'build', '.next', '.nuxt', '.output', 'vendor', 'target', 'coverage']);
  const walk = (dir, rel = '', depth = 0) => {
    if (depth > 6 || out.length >= MAX_SOURCE_SCAN) return;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (out.length >= MAX_SOURCE_SCAN) break;
      if (skip.has(e.name)) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(dir, e.name), r, depth + 1);
      else if (e.isFile()) out.push(r.replace(/\\/g, '/'));
    }
  };
  walk(ctxDir);
  return out;
}

function analyzeService(ctxDir, type, subdir) {
  const paths = collectPaths(ctxDir);
  const pkg = paths.includes('package.json') ? readJson(path.join(ctxDir, 'package.json')) : null;
  const pkgScripts = pkg && pkg.scripts ? pkg.scripts : {};
  const pkgDeps = { ...((pkg && pkg.dependencies) || {}), ...((pkg && pkg.devDependencies) || {}) };
  const profile = readBuildProfile(ctxDir);

  // Build command
  let buildCmd = pkgScripts.build || null;
  if (!buildCmd && type === 'react') buildCmd = 'npm run build'; // fallback hint
  if (!buildCmd && type === 'static' && profile.kind === 'jekyll') buildCmd = 'bundle exec jekyll build';

  // Start command
  let startCmd = pkgScripts.start || null;
  if (!startCmd && type === 'node') startCmd = 'npm start';
  if (!startCmd && (type === 'react' || type === 'static')) startCmd = 'nginx serves dist/';
  if (!startCmd && type === 'php') startCmd = 'Apache';

  // Internal port
  const port = inferPort(ctxDir, type === 'react' || type === 'static' ? 80 : 3000);

  // Dockerfile
  let dockerfile = null;
  let dockerfileStatus = 'missing';
  try {
    const files = fs.readdirSync(ctxDir);
    const dfName = files.find(f => /^dockerfile$/i.test(f));
    if (dfName) {
      dockerfile = dfName;
      const text = fs.readFileSync(path.join(ctxDir, dfName), 'utf8');
      const seeded = standardDockerfileType(ctxDir, path.join(__dirname, '..', '..', 'templates'));
      dockerfileStatus = seeded ? 'panel-seeded' : 'repository-owned';
    }
  } catch {}

  // Environment requirements
  const envExamples = exampleDefaults(ctxDir, [{ subdir: '', type, enabled: true }]);
  const requiredEnv = Object.keys(envExamples).filter(k => {
    // Filter out built-ins and optional-looking keys
    return !/^(NODE_ENV|HOST|TRUST_PROXY)$/i.test(k);
  });

  // Database detection
  const migrations = detectMigrations(ctxDir, [{ name: 'app', subdir, type, port, enabled: true }]);
  const prismaHints = prismaDatabaseHints(readText(path.join(ctxDir, 'prisma/schema.prisma')));
  const sqlHints = paths.filter(p => /\.sql$/i.test(p)).map(p => sqlDatabaseHints(readText(path.join(ctxDir, p)))).flat();
  const configHints = paths.filter(p => /(knexfile|ormconfig|drizzle|typeorm|sequelize|config\/database)/i.test(p))
    .map(p => databaseConfigHints(p, readText(path.join(ctxDir, p)))).flat();

  // Build-time requirements
  const buildTimeNeeds = [];
  if (pkgScripts.prepare || pkgScripts.preinstall || pkgScripts.postinstall) {
    if (pkgScripts.prepare?.includes('prisma') || pkgScripts.postinstall?.includes('prisma')) buildTimeNeeds.push('DATABASE_URL (Prisma generate)');
    if (pkgScripts.prepare?.includes('husky') || pkgScripts.postinstall?.includes('husky')) buildTimeNeeds.push('Git (Husky install)');
    if (pkgScripts.prepare?.includes('lefthook')) buildTimeNeeds.push('Git (Lefthook install)');
  }
  const gitIgnored = exists(ctxDir, '.dockerignore') && fs.readFileSync(path.join(ctxDir, '.dockerignore'), 'utf8').includes('.git');

  // Migration commands
  const migrationInfo = migrations.filter(m => m.runnable || m.explicit).map(m => ({
    framework: m.framework,
    command: m.command,
    check: m.check,
    phase: m.phase,
    repoDir: m.repoDir,
    runnable: m.runnable,
    problem: m.problem,
    warning: m.warning
  }));

  // Routes
  let openPaths = [];
  if (type !== 'static' && type !== 'react') {
    try { openPaths = routeLib.detectOpenPaths(ctxDir).map(r => r.path); } catch {}
  }

  // Service suggestions
  const subApps = { frontends: [], backends: [] };
  try {
    const allPaths = collectPaths(path.resolve(ctxDir, '..'));
    const pkgs = {};
    for (const p of allPaths) if (p.endsWith('package.json')) pkgs[p.slice(0, -13) || '.'] = readJson(path.join(ctxDir, '..', p));
    subApps.frontends = findFrontends(allPaths, pkgs).filter(f => f !== subdir);
    subApps.backends = findBackends(allPaths, pkgs, subApps.frontends).filter(b => b !== subdir);
  } catch {}

  return {
    subdir,
    type,
    profile: { kind: profile.kind, warnings: profile.warnings },
    buildCmd,
    startCmd,
    port,
    dockerfile,
    dockerfileStatus,
    requiredEnv,
    buildTimeNeeds,
    gitIgnored,
    migrationInfo,
    prismaHints,
    sqlHints,
    configHints,
    openPaths: openPaths.slice(0, 20),
    subApps,
    hasPackageJson: !!pkg,
    pkgName: pkg?.name,
    pkgManager: pkg?.packageManager || (exists(ctxDir, 'pnpm-lock.yaml') ? 'pnpm' : exists(ctxDir, 'yarn.lock') ? 'yarn' : exists(ctxDir, 'bun.lockb') || exists(ctxDir, 'bun.lock') ? 'bun' : 'npm')
  };
}

function analyzeRepository(codeDir, explicitType, explicitSubdir) {
  // If caller already chose a type/folder, analyze only that
  if (explicitType && explicitSubdir !== undefined) {
    const ctxDir = path.join(codeDir, explicitSubdir);
    if (!fs.existsSync(ctxDir)) return { error: `Subfolder ${explicitSubdir} not found` };
    const service = analyzeService(ctxDir, explicitType, explicitSubdir);
    return { services: [service], monorepo: false };
  }

  // Otherwise, do whole-repo detection
  const paths = collectPaths(codeDir);
  const pkg = paths.includes('package.json') ? readJson(path.join(codeDir, 'package.json')) : null;
  const pkgDeps = { ...((pkg && pkg.dependencies) || {}), ...((pkg && pkg.devDependencies) || {}) };
  const typeResult = decideType(paths, pkg);
  const pkgs = {};
  for (const p of paths) if (p.endsWith('package.json')) pkgs[p.slice(0, -13) || '.'] = readJson(path.join(codeDir, p));

  const frontends = findFrontends(paths, pkgs);
  const backends = findBackends(paths, pkgs, frontends);

  // If single root service, return it
  const services = [];
  if (frontends.length === 1 && backends.length === 0) {
    services.push(analyzeService(codeDir, typeResult.type || 'static', frontends[0] || ''));
  } else if (backends.length === 1 && frontends.length === 0) {
    services.push(analyzeService(codeDir, typeResult.type || 'node', backends[0] || ''));
  } else {
    for (const f of frontends) services.push(analyzeService(path.join(codeDir, f), 'react', f));
    for (const b of backends) services.push(analyzeService(path.join(codeDir, b), 'node', b));
    if (!services.length && typeResult.type) services.push(analyzeService(codeDir, typeResult.type, ''));
  }

  return {
    services,
    monorepo: services.length > 1,
    detectedType: typeResult.type,
    detectedReason: typeResult.reason,
    rootDbs: typeResult.dbs
  };
}

function readinessReport(analysis) {
  if (analysis.error) return { ready: false, error: analysis.error, recommendations: [] };

  const recommendations = [];
  const blockers = [];
  const warnings = [];

  for (const s of analysis.services) {
    // Dockerfile
    if (!s.dockerfile) {
      blockers.push({ code: 'NO_DOCKERFILE', service: s.subdir || 'root', message: `No Dockerfile in ${s.subdir || 'repository root'}. Add one or use the panel standard template.`, fixable: true, fix: 'use-standard-dockerfile' });
    } else if (s.dockerfileStatus === 'repository-owned') {
      // Check if it's a legacy panel template that needs upgrade
      const legacy = refreshStandardDockerfile(path.dirname(path.join('/tmp', s.dockerfile || '')), s.type, path.join(__dirname, '..', '..', 'templates'));
      if (legacy === 'updated') warnings.push({ code: 'LEGACY_DOCKERFILE', service: s.subdir || 'root', message: 'Repository Dockerfile matches a legacy panel template; it will be upgraded on deploy.', fixable: true, fix: 'auto-upgrade' });
    }

    // Build command
    if (!s.buildCmd && (s.type === 'react' || s.type === 'node' || s.profile?.kind === 'jekyll')) {
      warnings.push({ code: 'NO_BUILD_SCRIPT', service: s.subdir || 'root', message: 'No build script in package.json; panel will run `npm run build` or equivalent.', fixable: false });
    }

    // Start command
    if (!s.startCmd && s.type === 'node') {
      blockers.push({ code: 'NO_START_CMD', service: s.subdir || 'root', message: 'No start script in package.json; the container will not know how to run the application.', fixable: false });
    }

    // Build-time env
    for (const need of s.buildTimeNeeds) {
      blockers.push({ code: 'BUILD_TIME_ENV', service: s.subdir || 'root', message: `Build-time environment required: ${need}`, fixable: need.includes('DATABASE_URL') ? true : false, fix: need.includes('DATABASE_URL') ? 'build-arg-placeholder' : (need.includes('Git') ? 'add-git-to-dockerfile' : null) });
    }

    // Git in .dockerignore
    if (s.gitIgnored && s.buildTimeNeeds.some(n => n.includes('Git'))) {
      warnings.push({ code: 'GIT_IGNORED', service: s.subdir || 'root', message: '.dockerignore excludes .git; Git-dependent install scripts may fail.', fixable: false });
    }

    // Migrations
    for (const m of s.migrationInfo) {
      if (m.runnable) {
        recommendations.push({ code: 'MIGRATION', service: s.subdir || 'root', message: `${m.framework} migrations detected in ${m.repoDir || '.'}: ${m.command}`, phase: m.phase, command: m.command, check: m.check });
      } else if (m.problem) {
        warnings.push({ code: 'MIGRATION_INCOMPLETE', service: s.subdir || 'root', message: `${m.framework} migrations detected but ${m.problem}` });
      }
    }

    // Database hints
    const dbHints = [...new Set([...s.prismaHints, ...s.sqlHints, ...s.configHints])];
    if (dbHints.length) {
      recommendations.push({ code: 'DATABASE_HINTS', service: s.subdir || 'root', message: `Detected database types: ${dbHints.join(', ')}`, hint: dbHints });
    }

    // Port
    if (s.port && (s.type === 'react' && s.port !== 80)) {
      warnings.push({ code: 'REACT_PORT', service: s.subdir || 'root', message: `React service exposes port ${s.port} but the panel serves React via nginx on port 80.` });
    }

    // Open paths
    if (s.openPaths.length && s.type !== 'static' && s.type !== 'react') {
      recommendations.push({ code: 'ROUTES', service: s.subdir || 'root', message: `Detected API routes: ${s.openPaths.slice(0, 8).join(', ')}${s.openPaths.length > 8 ? '…' : ''}`, paths: s.openPaths });
    }

    // Sub-apps
    if (s.subApps.frontends.length || s.subApps.backends.length) {
      recommendations.push({ code: 'SUB_APPS', service: s.subdir || 'root', message: `Additional services available: ${s.subApps.frontends.map(f => f + ' (frontend)').join(', ')} ${s.subApps.backends.map(b => b + ' (backend)').join(', ')}`, frontends: s.subApps.frontends, backends: s.subApps.backends });
    }
  }

  // Overall readiness
  const ready = blockers.length === 0;

  return { ready, blockers, warnings, recommendations, monorepo: analysis.monorepo };
}

module.exports = { analyzeRepository, analyzeService, readinessReport, collectPaths };