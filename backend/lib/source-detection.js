// source-detection: extracted from the original backend without changing route semantics.
module.exports = function createHelpers(ctx) {
  const { APPS_DIR, COMPOSE_BIN, RELATIONAL_DBS, TEMPLATES_DIR, TYPE_PORT, appDir, buildProfile, crypto, deploymentPlan, ensureDockerfile, execFileSync, execSync, findDockerfiles, fs, gh, inferPort, isJekyll, nginxConf, path, quotas, refreshStandardDockerfile, repoAnalysis, resolveServiceDockerfile, standardDockerfileType, svc } = ctx;
  const codeDir = (...args) => ctx.codeDir(...args);
  const envSetManaged = (...args) => ctx.envSetManaged(...args);
  const hostPortsInUse = (...args) => ctx.hostPortsInUse(...args);
  const serviceNameFromSubdir = (...args) => ctx.serviceNameFromSubdir(...args);
function firstSyncClone({ codeDir, templatesDir, type, url, env }) {
  execSync(`git clone --depth 1 "${url}" "${codeDir}.new"`, { stdio: 'pipe', env });
  const plan = deploymentPlan.analyze(codeDir + '.new', { templatesDir });
  for (const f of ['Dockerfile', 'nginx.conf']) {
    if (plan.selected && plan.selected.kind === 'compose') continue;
    const dst = path.join(codeDir + '.new', f);
    const src = path.join(templatesDir, type || 'static', f);
    // Never seed a template Dockerfile over repo variants: an exact-name miss
    // with Dockerfile.* present means the author chose a variant recipe.
    if (f === 'Dockerfile' && findDockerfiles(codeDir + '.new').length) continue;
    if (!fs.existsSync(dst) && fs.existsSync(src)) fs.copyFileSync(src, dst);
  }
  fs.rmSync(codeDir, { recursive: true, force: true });
  fs.renameSync(codeDir + '.new', codeDir);
}

async function currentSha(dir) {
  try {
    const code = path.join(dir, 'code');
    // require code's OWN .git - otherwise rev-parse walks up into the panel repo
    if (!fs.existsSync(path.join(code, '.git'))) return null;
    return execSync('git rev-parse --short HEAD', { cwd: code }).toString().trim();
  } catch { return null; }
}

function createLocalPushStage(dir, meta, pushedSha, pushedBranch) {
  if (!/^[0-9a-f]{40}$/.test(pushedSha || '') || !/^[A-Za-z0-9._/-]{1,64}$/.test(pushedBranch || '')) {
    throw new Error('local push is missing a valid commit sha or branch');
  }
  const bareRepo = path.join(dir, 'repo.git');
  if (!fs.existsSync(path.join(bareRepo, 'HEAD'))) throw new Error('local push repository is not initialized');
  try {
    execFileSync('git', ['check-ref-format', '--branch', pushedBranch], { stdio: 'ignore' });
    execFileSync('git', ['--git-dir', bareRepo, 'show-ref', '--verify', `refs/heads/${pushedBranch}`], { stdio: 'ignore' });
    execFileSync('git', ['--git-dir', bareRepo, 'cat-file', '-e', `${pushedSha}^{commit}`], { stdio: 'ignore' });
  } catch {
    throw new Error(`commit ${pushedSha.slice(0, 7)} or pushed branch '${pushedBranch}' is not available in the local repository`);
  }

  const stageRoot = path.join(dir, '.local-deploy-' + crypto.randomBytes(8).toString('hex'));
  const stageCode = path.join(stageRoot, 'code');
  let retained = false;
  const cleanup = () => {
    if (retained) return;
    try { execFileSync('git', ['--git-dir', bareRepo, 'worktree', 'remove', '--force', stageCode], { stdio: 'ignore' }); } catch {}
    try { fs.rmSync(stageRoot, { recursive: true, force: true }); } catch {}
    try { execFileSync('git', ['--git-dir', bareRepo, 'worktree', 'prune'], { stdio: 'ignore' }); } catch {}
  };
  cleanup();
  try {
    fs.mkdirSync(stageRoot, { recursive: true });
    execFileSync('git', ['--git-dir', bareRepo, 'worktree', 'add', '--force', '--detach', stageCode, pushedSha], { stdio: 'pipe' });

    const sourcePlan = deploymentPlan.analyze(stageCode, { selection: meta.deploymentEntrypoint, templatesDir: TEMPLATES_DIR });
    if (sourcePlan.selected && sourcePlan.selected.kind === 'compose') return { codeDir: stageCode, sha: pushedSha.slice(0, 7), cleanup, retain: () => { retained = true; } };

    const enabled = svc.fullServices(meta || {}, dir).filter(s => s.enabled !== false);
    const lines = ['services:'];
    for (const s of enabled) {
      const ctxDir = path.join(stageCode, s.subdir || '');
      if (!fs.existsSync(ctxDir)) throw new Error(`service '${s.name}' build folder '${s.subdir || '.'}' is absent from pushed commit`);
      // The pushed commit chooses the build file: strict resolution so an
      // ambiguous or stale selection fails loud instead of building wrong.
      let dfName = 'Dockerfile';
      try {
        const df = resolveServiceDockerfile(ctxDir, s.dockerfile, s.type, TEMPLATES_DIR);
        if (df) {
          dfName = df.file;
          if (/^dockerfile$/i.test(df.file)) refreshStandardDockerfile(ctxDir, s.type, TEMPLATES_DIR);
        } else {
          ensureDockerfile(ctxDir, s.type, TEMPLATES_DIR, { modernize: !!((s.buildOptions || (s.name === 'app' && meta.buildOptions) || {}).modernize) });
          // Upgrade only exact historical Node/React templates, including monorepo
          // services and detached local-push checkouts. Never rewrite custom files.
          refreshStandardDockerfile(ctxDir, s.type, TEMPLATES_DIR);
        }
      } catch (e) { throw new Error(`service '${s.name}': ${e.message}`); }
      if (s.type === 'static' || s.type === 'react') {
        const nc = path.join(ctxDir, 'nginx.conf');
        if (!fs.existsSync(nc)) fs.writeFileSync(nc, nginxConf(null));
      }
      lines.push(`  ${s.name}:`, `    build:\n      context: ${JSON.stringify(ctxDir.replace(/\\/g, '/'))}\n      dockerfile: ${dfName}\n      args:\n        BUILDKIT_INLINE_CACHE: 1`);
    }
    const override = path.join(stageRoot, 'compose.override.yml');
    fs.writeFileSync(override, lines.join('\n') + '\n');
    return {
      codeDir: stageCode,
      compose: `${COMPOSE_BIN} -f "${path.join(dir, 'docker-compose.yml')}" -f "${override}"`,
      sha: pushedSha.slice(0, 7),
      cleanup
    };
  } catch (e) {
    cleanup();
    throw e;
  }
}

function requiredDatabases(meta, codeRoot) {
  const dir = appDir(APPS_DIR, meta.id);
  const needs = new Set();
  for (const service of svc.fullServices(meta, dir).filter(s => s.enabled !== false)) {
    const ctx = path.join(codeRoot, service.subdir || '');
    try {
      const a = repoAnalysis.analyzeService(ctx, service.type, service.subdir || '');
      for (const db of a.databaseNeeds || []) if (RELATIONAL_DBS.includes(db) || ['mongo', 'redis'].includes(db)) needs.add(db);
    } catch {}
  }
  return [...needs];
}

function configureDetectedServices(meta, dir, { discoverSiblings = false } = {}) {
  if (!meta.repoUrl || meta.subdir && !discoverSiblings) return [];
  const codeDir = path.join(dir, 'code');
  let analysis;
  try { analysis = repoAnalysis.analyzeRepository(codeDir); } catch { return []; }
  const detected = (analysis.services || []).filter(s => s && s.type && fs.existsSync(path.join(codeDir, s.subdir || '')));
  if (!detected.length) return [];
  const current = svc.fullServices(meta, dir);
  if (detected.length === 1 && current.length === 1 && (current[0].subdir || '') === (detected[0].subdir || '') && current[0].type === detected[0].type) return [];
  const usedNames = new Set(['app']);
  const usedPorts = hostPortsInUse();
  if (meta.hostPort) usedPorts.add(meta.hostPort);
  const nextHost = () => {
    let p = 8000;
    while (usedPorts.has(p) && p < 9000) p++;
    usedPorts.add(p);
    return p;
  };
  const services = detected.map((s, i) => {
    const ctx = path.join(codeDir, s.subdir || '');
    const port = inferPort(ctx, TYPE_PORT[s.type] || 3000);
    return {
      name: i === 0 ? 'app' : serviceNameFromSubdir(s.subdir, usedNames),
      subdir: s.subdir || '',
      type: s.type,
      port,
      hostPort: i === 0 ? (meta.hostPort || nextHost()) : nextHost(),
      enabled: true,
      buildOptions: meta.buildOptions || {}
    };
  });
  meta.services = services;
  meta.type = services[0].type;
  meta.subdir = services[0].subdir;
  meta.hostPort = services[0].hostPort;
  envSetManaged(dir, { APP_TYPE: meta.type, PORT: String(services[0].port), HOST_PORT: String(meta.hostPort) });
  const out = svc.renderProject({ dir, templatesDir: TEMPLATES_DIR, meta });
  meta.services = out.normalized;
  return services.map(s => s.name + ':' + (s.subdir || '.'));
}

function hasStaleRootService(meta, dir) {
  const services = svc.fullServices(meta, dir);
  if (!services.some(s => (s.subdir || '') === '')) return false;
  let analysis;
  try { analysis = repoAnalysis.analyzeRepository(path.join(dir, 'code')); } catch { return false; }
  const desired = (analysis.services || []).map(s => s.subdir || '');
  if (desired.includes('')) return false;
  if (!desired.length) return false;
  const root = services.find(s => (s.subdir || '') === '');
  if (!root) return false;
  try { if (!standardDockerfileType(path.join(dir, 'code'), TEMPLATES_DIR)) return false; } catch { return false; }
  return true;
}

async function detectRepo(repo, { login, token, branch } = {}) {
  const m = String(repo || '').match(/^([^/]+)\/([^/]+?)(\.git)?$/);
  if (!m) throw new Error('repo must be owner/name');
  const get = token
    ? (p) => gh.apiWith(token, p)
    : login
      ? (p) => gh.apiAs(login, p)
      : (p) => gh.apiPublic(p);
  const { repoSource } = require('./repo-source');
  const source = await repoSource(get, `${m[1]}/${m[2]}`, branch);
  const ref = encodeURIComponent(source.branch);
  const t = await get(`/repos/${m[1]}/${m[2]}/git/trees/${ref}?recursive=1`)
    .catch(e => { throw new Error('cannot read repo (private? paste a token): ' + e.message); });
  const tree = (t.tree || []).filter(e => e.type === 'blob').map(e => e.path);
  let pkg = null;
  const pkgPath = tree.filter(p => /(^|\/)package\.json$/.test(p)).sort((a, b) => a.length - b.length)[0];
  if (pkgPath) {
    try {
      const blob = await get(`/repos/${m[1]}/${m[2]}/contents/${pkgPath}?ref=${ref}`);
      if (blob && blob.content) pkg = JSON.parse(Buffer.from(blob.content, 'base64').toString('utf8'));
    } catch {}
  }
  const { decideType, detectPackageManager, expandWorkspaces, matchWorkspaces, findBackends, findFrontends, findRunnableRoot, sqlDatabaseHints, prismaDatabaseHints, databaseConfigHints } = require('./detect');
  const out = decideType(tree, pkg);
  out.packageManager = detectPackageManager({ pkg, files: tree }).manager;
  Object.assign(out, source);
  out.repositorySize = quotas.repositorySize(t);
  // monorepo sub-apps, tool-agnostic: vite heuristic + workspace manifests
  // (npm workspaces, pnpm-workspace.yaml, lerna.json, turbo/nx conventions)
  out.frontends = [];
  const readText = async (p) => {
    try {
      const b = await get(`/repos/${m[1]}/${m[2]}/contents/${p}?ref=${ref}`);
      return b && b.content ? Buffer.from(b.content, 'base64').toString('utf8') : null;
    } catch { return null; }
  };
  const buildFiles = {};
  await Promise.all(['Gemfile', 'Gemfile.lock', '_config.yml', '.nvmrc', '.node-version', '.ruby-version'].filter(p => tree.includes(p)).map(async p => { buildFiles[p] = await readText(p); }));
  out.buildProfile = buildProfile(tree, pkgPath === 'package.json' ? pkg : null, buildFiles);
  if (out.buildProfile.kind === 'jekyll') {
    out.type = 'static'; out.detected = 'jekyll'; out.dbs = [];
    out.reason = 'Jekyll static site - build with Ruby/Node, serve with nginx';
  }
  for (const p of tree) {
    const fm = p.match(/^(.+)\/package\.json$/);
    if (fm && fm[1].split('/').length <= 2 &&
        (tree.includes(`${fm[1]}/vite.config.js`) || tree.includes(`${fm[1]}/vite.config.ts`) || tree.includes(`${fm[1]}/vite.config.mjs`))) {
      if (!out.frontends.includes(fm[1])) out.frontends.push(fm[1]);
    }
  }
  const patterns = expandWorkspaces(tree, pkgPath === 'package.json' ? pkg : null);
  if (tree.includes('pnpm-workspace.yaml')) {
    const y = await readText('pnpm-workspace.yaml');
    if (y) for (const line of y.split('\n')) {
      const mm = line.match(/^\s*-\s*['"]?([^'"]+?)['"]?\s*$/);
      if (mm && !mm[1].startsWith('!')) patterns.push(mm[1]);
    }
  }
  if (tree.includes('lerna.json')) {
    try {
      const l = JSON.parse(await readText('lerna.json'));
      if (l && Array.isArray(l.packages)) patterns.push(...l.packages);
    } catch {}
  }
  if (!patterns.length && tree.some(p => /^(turbo\.json|nx\.json)$/.test(p))) {
    patterns.push('apps/*', 'packages/*');
  }
  for (const d of matchWorkspaces(tree, patterns)) {
    if (!out.frontends.includes(d)) out.frontends.push(d);
  }
  // backend homes: subdirs with runnable package.json that aren't frontends.
  // Frontend markers beyond vite (CRA layout, Angular/Next/Nuxt/Vue configs,
  // UI deps + build script) classify first so they never pose as backends.
  out.backends = [];
  const pkgs = {};
  try {
    // tree markers need no package reads - classify before the capped fetch so
    // CRA/Angular-style dirs are already excluded from pkgDirs below.
    for (const f of findFrontends(tree)) if (!out.frontends.includes(f)) out.frontends.push(f);
    const pkgDirs = [...new Set(tree.filter(p => /(^|\/)package\.json$/.test(p))
      .map(p => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : ''))
      .filter(d => d && d.split('/').length <= 2 && !out.frontends.includes(d)))].slice(0, 8);
    for (const d of pkgDirs) {
      try {
        const blob = await get(`/repos/${m[1]}/${m[2]}/contents/${d}/package.json?ref=${ref}`);
        if (blob && blob.content) pkgs[d] = JSON.parse(Buffer.from(blob.content, 'base64').toString('utf8'));
      } catch { pkgs[d] = null; }
    }
    // package-based pass (UI deps + build script) with the fetched manifests,
    // then backends skip everything classified as a frontend.
    for (const f of findFrontends(tree, pkgs)) if (!out.frontends.includes(f)) out.frontends.push(f);
    out.backends = findBackends(tree, pkgs, out.frontends);
    for (const pkg_ of Object.values(pkgs).filter(Boolean)) {
      for (const db of decideType(['package.json'], pkg_).dbs || []) if (!out.dbs.includes(db)) out.dbs.push(db);
    }
  } catch {}
  out.staticFrontends = out.frontends.filter(d => isJekyll(tree.filter(p => p.startsWith(d + '/')).map(p => p.slice(d.length + 1)), pkgs[d]));
  out.frontends = out.frontends.filter(d => !out.staticFrontends.includes(d));
  // Prisma dependencies do not reveal the database engine. Read only the
  // bounded schema files and use their explicit datasource provider instead.
  const prismaCandidates = tree.filter(p => /(^|\/)schema\.prisma$/i.test(p)).slice(0, 4);
  for (const p of prismaCandidates) {
    const text = await readText(p);
    for (const db of prismaDatabaseHints(text)) {
      if (!out.dbs.includes(db)) out.dbs.push(db);
      if (!out.dbReason) out.dbReason = `Prisma datasource in ${p}`;
    }
  }
  // Standard ORM/framework config files can state the engine even when their
  // package dependency is database-neutral. Dynamic env expressions are not
  // inferred; only explicit literal values preselect a service.
  const configCandidates = tree.filter(p => /(^|\/)(?:knexfile\.(?:js|cjs|mjs|ts)|(?:ormconfig|data-source|typeorm\.config)\.(?:json|js|cjs|mjs|ts)|drizzle\.config\.(?:js|cjs|mjs|ts)|(?:config\/config|sequelize\.config)\.(?:json|js|cjs|mjs|ts)|\.env\.(?:example|sample)|config\/database\.php)$/i.test(p)).slice(0, 12);
  for (const p of configCandidates) {
    const text = await readText(p);
    for (const db of databaseConfigHints(p, text)) {
      // SQLite is file-based: no managed service exists to preselect, so say
      // so explicitly instead of leaving the database pills silent.
      if (db === 'sqlite') {
        if (!out.dbNote) out.dbNote = `SQLite detected in ${p}. Persist the database file, or select a managed SQL database and update DB_CONNECTION.`;
        continue;
      }
      if (db === 'mariadb') out.dbs = (out.dbs || []).filter(item => item !== 'mysql');
      if (!out.dbs.includes(db)) out.dbs.push(db);
      if (!out.dbReason) out.dbReason = `Explicit database setting in ${p}`;
    }
  }
  // Strong SQL dialect signatures provide a bounded fallback. Prefer MariaDB
  // over a generic mysql/mysql2 dependency when a schema says MariaDB.
  const sqlCandidates = tree.filter(p => /(^|\/)(?:(?:baseline|schema|dump)[^/]*\.sql|(?:migrations?|sql)\/[^/]+\.sql)$/i.test(p)).slice(0, 6);
  for (const p of sqlCandidates) {
    const text = await readText(p);
    const hinted = sqlDatabaseHints(text);
    if (!hinted.length) continue;
    for (const db of hinted) {
      if (db === 'mariadb') out.dbs = (out.dbs || []).filter(item => item !== 'mysql');
      if (!out.dbs.includes(db)) out.dbs.push(db);
    }
    if (!out.dbReason) out.dbReason = `Database dialect marker in ${p}`;
  }
  // Nested runnable root: root has no markers but every file shows the app
  // lives in a subfolder (htdocs/, public/, wrapper/). Suggest the correct
  // build folder so create succeeds without manual subdir entry.
  try {
    if (!out.type) {
      const best = findRunnableRoot(tree, pkgs);
      if (best && best.subdir) {
        out.type = best.type;
        out.detected = best.detected;
        out.reason = `${best.reason} (in /${best.subdir})`;
        out.suggestedSubdir = best.subdir;
        if (Array.isArray(best.dbs)) for (const db of best.dbs) if (!out.dbs.includes(db)) out.dbs.push(db);
      }
    } else if (!out.frontends.length && !out.backends.length && !out.staticFrontends.length) {
      const best = findRunnableRoot(tree, pkgs);
      if (best && best.subdir) {
        out.suggestedSubdir = best.subdir;
        if (out.reason && !out.reason.includes(best.subdir)) out.reason = `${out.reason} (in /${best.subdir})`;
      }
    }
  } catch {}
  return out;
}
  return { detectRepo, firstSyncClone, createLocalPushStage, currentSha, configureDetectedServices, hasStaleRootService, requiredDatabases };
};
