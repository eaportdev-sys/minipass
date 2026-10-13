// Static deployment readiness analysis for a repository. Pure functions where
// possible; never executes repository code. Returns a structured report.
const fs = require('fs');
const path = require('path');
const { decideType, detectPackageManager, findBackends, findFrontends, prismaDatabaseHints, sqlDatabaseHints, databaseConfigHints } = require('./detect');
const { detectMigrations } = require('./migrations');
const { parseExample, exampleFiles, exampleDefaults } = require('./env-defaults');
const { readBuildProfile, localBuildProfile } = require('./build-profile');
const { refreshStandardDockerfile, standardDockerfileType, findDockerfiles } = require('./dockerfiles');
const { readComposeTopo } = require('./compose-read');
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

function sourceEnvKeys(ctxDir, paths) {
  const keys = new Set();
  const pats = [
    /process\.env\.([A-Z][A-Z0-9_]{1,80})/g,
    /process\.env\[['"]([A-Z][A-Z0-9_]{1,80})['"]\]/g,
    /env\(\s*['"]([A-Z][A-Z0-9_]{1,80})['"]\s*\)/g
  ];
  for (const p of (paths || []).filter(p => /\.(?:js|mjs|cjs|ts|tsx|jsx|php)$/i.test(p)).slice(0, 80)) {
    const text = readText(path.join(ctxDir, p), 64 * 1024);
    for (const re of pats) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(text)) && keys.size < 80) keys.add(m[1]);
    }
  }
  return [...keys];
}

function analyzeService(ctxDir, type, subdir) {
  const paths = collectPaths(ctxDir);
  const pkg = paths.includes('package.json') ? readJson(path.join(ctxDir, 'package.json')) : null;
  const detected = decideType(paths, pkg);
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

  // Dockerfile (exact name wins; a lone variant counts as the recipe;
  // several variants with no exact pick stay ambiguous for the operator).
  let dockerfile = null;
  let dockerfileStatus = 'missing';
  let dockerfileCandidates = [];
  try {
    const files = fs.readdirSync(ctxDir);
    dockerfileCandidates = findDockerfiles(ctxDir);
    const exact = files.find(f => /^dockerfile$/i.test(f));
    const variants = dockerfileCandidates.filter(f => !/^dockerfile$/i.test(f));
    const dfName = exact || (variants.length === 1 ? variants[0] : null);
    if (dfName) {
      dockerfile = dfName;
      const seeded = standardDockerfileType(ctxDir, path.join(__dirname, '..', '..', 'templates'), dfName);
      dockerfileStatus = seeded ? 'panel-seeded' : 'repository-owned';
    } else if (variants.length > 1) {
      dockerfileStatus = 'ambiguous';
    }
  } catch {}

  // Environment requirements
  const envExamples = exampleDefaults(ctxDir, [{ subdir: '', type, enabled: true }]);
  const requiredEnv = [...new Set([...Object.keys(envExamples), ...sourceEnvKeys(ctxDir, paths)])].filter(k => {
    // Filter out built-ins and optional-looking keys
    return !/^(NODE_ENV|HOST|TRUST_PROXY)$/i.test(k);
  });

  // Database detection
  const migrations = detectMigrations(ctxDir, [{ name: 'app', subdir, type, port, enabled: true }]);
  const prismaHints = prismaDatabaseHints(readText(path.join(ctxDir, 'prisma/schema.prisma')));
  const sqlHints = paths.filter(p => /\.sql$/i.test(p)).map(p => sqlDatabaseHints(readText(path.join(ctxDir, p)))).flat();
  const configHints = paths.filter(p => /(knexfile|ormconfig|drizzle|typeorm|sequelize|config\/database)/i.test(p))
    .map(p => databaseConfigHints(p, readText(path.join(ctxDir, p)))).flat();
  const databaseNeeds = [...new Set([...(detected.dbs || []), ...prismaHints, ...sqlHints, ...configHints])].filter(db => db !== 'sqlite');

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
    dockerfileCandidates,
    requiredEnv,
    buildTimeNeeds,
    gitIgnored,
    migrationInfo,
    prismaHints,
    sqlHints,
    configHints,
    databaseNeeds,
    openPaths: openPaths.slice(0, 20),
    subApps,
    hasPackageJson: !!pkg,
    pkgName: pkg?.name,
    pkgManager: detectPackageManager({ pkg, files: paths }).manager,
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

  const services = [];
  const rootScripts = (pkg && pkg.scripts) || {};
  let rootDockerfileIsRuntime = paths.some(p => /^dockerfile(\.[A-Za-z0-9][A-Za-z0-9._-]*)?$/i.test(p));
  try { if (rootDockerfileIsRuntime && standardDockerfileType(codeDir, path.join(__dirname, '..', '..', 'templates'))) rootDockerfileIsRuntime = false; } catch {}
  const rootHasRuntimeMarker = !!(paths.includes('package.json') && (
    rootScripts.start || paths.some(p => /^(?:next|nuxt)\.config\.(?:js|mjs|cjs|ts)$/.test(p)) ||
    paths.some(p => /^(?:server|index|app)\.(?:js|mjs|cjs|ts)$/.test(p)) ||
    paths.includes('composer.json') || paths.includes('index.php') || paths.includes('index.html') ||
    rootDockerfileIsRuntime
  ));
  const hasSubApps = frontends.length || backends.length;
  if (typeResult.type && (!hasSubApps || rootHasRuntimeMarker)) services.push(analyzeService(codeDir, typeResult.type, ''));
  for (const f of frontends) services.push(analyzeService(path.join(codeDir, f), 'react', f));
  for (const b of backends) services.push(analyzeService(path.join(codeDir, b), 'node', b));
  if (!services.length && typeResult.type) services.push(analyzeService(codeDir, typeResult.type, ''));

  let topology = null;
  try { topology = readComposeTopo(codeDir); } catch { topology = null; }
  return {
    services,
    monorepo: services.length > 1,
    detectedType: typeResult.type,
    detectedReason: typeResult.reason,
    rootDbs: typeResult.dbs,
    topology
  };
}

function readinessReport(analysis) {
  if (analysis.error) return { ready: false, error: analysis.error, recommendations: [] };

  const recommendations = [];
  const blockers = [];
  const warnings = [];

  // Repo-shipped topology the panel manages itself: surface what it declares
  // (services, one-shot tasks, required env) so nothing is discovered via a
  // failed build. Advisory only - the panel does not apply repo compose.
  const topo = analysis.topology;
  if (topo && Array.isArray(topo.services)) {
    const shots = topo.services.filter(s => s.oneShot).map(s => s.name);
    for (const name of shots) {
      recommendations.push({ code: 'TOPOLOGY_ONESHOT', service: '', message: `Repo ${topo.file} runs '${name}' as a one-shot task - run it via Migrations, not as a service.`, fixable: false });
    }
    const reqEnv = (topo.envNeeds || []).filter(e => e.required);
    for (const e of reqEnv) {
      recommendations.push({ code: 'TOPOLOGY_ENV', service: (e.services || []).join(', ') || '', message: `Repo ${topo.file} requires env ${e.key}${e.message ? ` (${e.message})` : ''} - provide it in Environment.`, fixable: false });
    }
  }

  for (const s of analysis.services) {
    // Dockerfile
    if (!s.dockerfile) {
      if (s.dockerfileStatus === 'ambiguous') {
        blockers.push({ code: 'AMBIGUOUS_DOCKERFILE', service: s.subdir || 'root', message: `Multiple Dockerfiles in ${s.subdir || 'repository root'} (${(s.dockerfileCandidates || []).join(', ')}). Select the build file in Setup > services.`, fixable: false });
      } else {
        blockers.push({ code: 'NO_DOCKERFILE', service: s.subdir || 'root', message: `No Dockerfile in ${s.subdir || 'repository root'}. Add one or use the panel standard template.`, fixable: true, fix: 'use-standard-dockerfile' });
      }
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
    const dbHints = [...new Set([...(s.databaseNeeds || []), ...s.prismaHints, ...s.sqlHints, ...s.configHints])];
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
