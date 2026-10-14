// deployment-executor: extracted from the original backend without changing route semantics.
module.exports = function createHelpers(ctx) {
  const { APPS_DIR, COMPOSE_BIN, DOCKER_BIN, LEGACY_PANEL_PHP_DOCKERFILE, TEMPLATES_DIR, appDir, appGitEnv, composeInputs, crypto, deployChildren, deployLocks, deployOps, deploymentPlan, dockerfileProtection, ensureDockerfile, exec, execSync, failureSummary, fs, gh, importProtection, localAccess, missingEnvVars, nginxConf, normDbs, panelLog, path, portsLib, prebuild, publication, pushEvents, readBuildProfile, redactUrl, refreshStandardDockerfile, repositoryCompose, resolveServiceDockerfile, runLogged, standardDockerfileType, svc, trashLib } = ctx;
  const appContainers = (...args) => ctx.appContainers(...args);
  const attachDatabase = (...args) => ctx.attachDatabase(...args);
  const autodetectHome = (...args) => ctx.autodetectHome(...args);
  const checkCancelled = (...args) => ctx.checkCancelled(...args);
  const codeDir = (...args) => ctx.codeDir(...args);
  const composeArgv = (...args) => ctx.composeArgv(...args);
  const configureDetectedServices = (...args) => ctx.configureDetectedServices(...args);
  const createLocalPushStage = (...args) => ctx.createLocalPushStage(...args);
  const currentSha = (...args) => ctx.currentSha(...args);
  const deployCancelledError = (...args) => ctx.deployCancelledError(...args);
  const ensureDatabaseAliases = (...args) => ctx.ensureDatabaseAliases(...args);
  const envSetManaged = (...args) => ctx.envSetManaged(...args);
  const firstSyncClone = (...args) => ctx.firstSyncClone(...args);
  const hasStaleRootService = (...args) => ctx.hasStaleRootService(...args);
  const load = (...args) => ctx.load(...args);
  const migrateRunArgv = (...args) => ctx.migrateRunArgv(...args);
  const migrateTarget = (...args) => ctx.migrateTarget(...args);
  const migrationFailure = (...args) => ctx.migrationFailure(...args);
  const migrationResponse = (...args) => ctx.migrationResponse(...args);
  const parseEnvFile = (...args) => ctx.parseEnvFile(...args);
  const rebindHostPorts = (...args) => ctx.rebindHostPorts(...args);
  const recordDeploy = (...args) => ctx.recordDeploy(...args);
  const refreshDeploymentPlan = (...args) => ctx.refreshDeploymentPlan(...args);
  const requiredDatabases = (...args) => ctx.requiredDatabases(...args);
  const resolveBuildManager = (...args) => ctx.resolveBuildManager(...args);
  const runOut = (...args) => ctx.runOut(...args);
  const save = (...args) => ctx.save(...args);
  const sh = (...args) => ctx.sh(...args);
  const syncProvisionedDomain = (...args) => ctx.syncProvisionedDomain(...args);
  const trackDeployChild = (...args) => ctx.trackDeployChild(...args);
function deploySh(id, cmd, cwd, env) {
  checkCancelled(id);
  return new Promise((res, rej) => {
    const child = exec(cmd, { cwd, env: env || process.env, maxBuffer: 10 * 1024 * 1024,
      detached: process.platform !== 'win32' }, (e, stdout, stderr) => {
      if (e) rej(new Error(stderr || e.message)); else res(stdout);
    });
    trackDeployChild(id, child);
  });
}

async function snapshotImages(id, dir) {
  const snaps = [];
  try {
    const out = await deploySh(id, `${COMPOSE_BIN} ps -q`, dir);
    for (const cid of out.trim().split('\n').filter(Boolean)) {
      try {
        const name = execSync(`docker inspect ${cid.trim()} --format '{{.Config.Image}}'`).toString().trim();
        const imgId = execSync(`docker inspect ${cid.trim()} --format '{{.Image}}'`).toString().trim();
        if (name && imgId) snaps.push({ name, imgId });
      } catch {}
    }
  } catch {}
  return snaps;
}

async function rollbackImages(dir, snaps) {
  if (!snaps.length) return;
  for (const s of snaps) {
    try { execSync(`docker tag ${s.imgId} ${s.name}`); } catch {}
  }
  await sh(`${COMPOSE_BIN} up -d --remove-orphans`, dir);
}

async function waitStable(id, dir, meta, only = null) {
  const { steadyPoll } = require('./health');
  const all = svc.fullServices(meta || {}, dir).filter(s => s.enabled !== false);
  const names = new Set((only && only.length ? all.filter(s => only.includes(s.name)) : all).map(s => s.name));
  let steady = 0;
  let prev = new Map();
  let lastRel = [];
  for (let i = 0; i < 10; i++) {
    if (i) await new Promise(r => setTimeout(r, 3000));
    checkCancelled(id); // stop mid-verify aborts before any rollback restart
    let cs = [];
    try { cs = await appContainers(id); } catch { prev = new Map(); continue; }
    const rel = cs.filter(c => names.has(c.service));
    lastRel = rel;
    if (rel.length && rel.some(c => /exited|dead|failed|removing/i.test(c.state || ''))) {
      return { ok: false, detail: rel.map(c => `${c.service}=${c.state}`).join(', ') };
    }
    if (rel.length && rel.every(c => /^running/i.test(c.state || ''))) {
      // `running` alone is restart-blind: a crash loop caught mid-iteration
      // reads as healthy. Require the same container instances (StartedAt)
      // across polls before counting the streak.
      const curr = new Map();
      for (const c of rel) {
        if (!c.id) continue;
        try {
          const insp = await sh(`docker inspect ${c.id} --format '{{.Id}} {{.State.Status}} {{.State.StartedAt}}'`, dir);
          const parts = insp.trim().split(/\s+/);
          curr.set(parts[0], { running: /^running/i.test(parts[1] || ''), startedAt: parts.slice(2).join(' ') });
        } catch { /* inspect failed: container gone mid-poll - not steady */ }
      }
      if (curr.size === rel.length && steadyPoll(prev, curr).steady) {
        if (++steady >= 2) return { ok: true };
      } else steady = 0;
      prev = curr;
    } else { steady = 0; prev = new Map(); }
  }
  // Name the crash-looping service instead of a bare timeout.
  let restarts = '';
  try {
    const counts = [];
    for (const c of lastRel) {
      if (!c.id) continue;
      try {
        const n = (await sh(`docker inspect ${c.id} --format '{{.RestartCount}}'`, dir)).trim();
        if (parseInt(n, 10) > 0) counts.push(`${c.service} restarted ${n}x`);
      } catch {}
    }
    if (counts.length) restarts = ` (${counts.join(', ')})`;
  } catch {}
  return { ok: false, detail: `containers never stabilized within 60s${restarts}` };
}

async function deployNow(id, opts = {}) {
  // The queue above serializes builds. Keep the lock as live UI state and as a
  // defensive invariant against any future call that bypasses the queue.
  if (deployLocks.has(id)) throw new Error('internal deploy queue violation');
  deployLocks.add(id);
  const opSource = ['create', 'webhook', 'poll', 'local-push', 'manual', 'local'].includes(opts.source) ? opts.source : 'manual';
  deployOps.set(id, { source: opSource, startedAt: Date.now() });
  pushEvents.delete(id);
  let localStage = null;
  try {
  const dir = appDir(APPS_DIR, id);
  const meta = load().apps.find(a => a.id === id);
  const codeDir = path.join(dir, 'code');
  if (!meta) throw new Error('unknown app');
  const buildLog = path.join(dir, 'deploy.log');
  // One log per attempt. Clear before any preflight/pre-build output, not just
  // before Docker build (which used to erase successful pre-build evidence).
  fs.writeFileSync(buildLog, `--- deploy ${opSource} started ${new Date().toISOString()} ---\n`);
  panelLog.logEvent({ level: 'info', area: 'deploy-' + opSource, site: id, message: 'Deployment started: inspecting repository instructions, preparing declared inputs, installing/building and starting services.' });
  let buildCodeDir = codeDir;
  let composeCmd = meta.storageQuota ? `${COMPOSE_BIN} -p ${id}` : COMPOSE_BIN;
  let sourceSha = null;

  if (opSource === 'local-push') {
    try {
      localStage = createLocalPushStage(dir, meta, opts.pushedSha, opts.pushedBranch);
      buildCodeDir = localStage.codeDir;
      if (localStage.compose) composeCmd = localStage.compose + (meta.storageQuota ? ` -p ${id}` : '');
      sourceSha = localStage.sha;
    } catch (e) {
      await recordDeploy(id, {
        sha: /^[0-9a-f]{40}$/.test(opts.pushedSha || '') ? opts.pushedSha.slice(0, 7) : null,
        at: new Date().toISOString(), status: 'error',
        error: ('local checkout failed - running containers untouched: ' + e.message).slice(-500)
      });
      throw e;
    }
  } else if (meta.repoUrl) {
    if (!opts.skipSync) {
    const isSsh = /^(git@|ssh:\/\/)/i.test(meta.repoUrl);
    const url = isSsh ? meta.repoUrl : gh.authUrlFor(meta, meta.repoUrl);
    const env = isSsh ? appGitEnv(dir) : process.env;
    try {
      const protectedServices = svc.fullServices(meta, dir);
      for (const service of protectedServices.filter(s => s.enabled !== false)) importProtection.migrate(dir, service, codeDir);
      if (fs.existsSync(path.join(codeDir, '.git'))) {
        importProtection.run(dir, protectedServices, codeDir, 'suspend', line => fs.appendFileSync(buildLog, line + '\n'));
        dockerfileProtection.run(dir, protectedServices, codeDir, 'suspend', line => fs.appendFileSync(buildLog, line + '\n'));
      }
      if (!fs.existsSync(path.join(codeDir, '.git'))) {
        firstSyncClone({ codeDir, templatesDir: TEMPLATES_DIR, type: meta.type, url, env });
      } else {
        let branch = (meta.github && meta.github.branch) || 'main';
        try { branch = execSync('git branch --show-current', { cwd: codeDir }).toString().trim() || branch; } catch {}
        await deploySh(id, `git pull --ff-only "${url}" "${branch}"`, codeDir, env);
      }
    } catch (e) {
      let msg = redactUrl(e.stderr ? String(e.stderr) : e.message);
      // A failed pull must not leave exact approved corrections removed.
      try {
        importProtection.run(dir, svc.fullServices(meta, dir), codeDir, 'replay', line => fs.appendFileSync(buildLog, line + '\n'));
        dockerfileProtection.run(dir, svc.fullServices(meta, dir), codeDir, 'replay', line => fs.appendFileSync(buildLog, line + '\n'));
      }
      catch (restoreError) { msg += '\nImport protection needs review: ' + restoreError.message; }
      if (deployOps.get(id) && deployOps.get(id).cancelled) throw deployCancelledError();
      const sha0 = await currentSha(dir);
      await recordDeploy(id, { sha: sha0, at: new Date().toISOString(), status: 'error', error: ('git sync failed - running containers untouched: ' + msg).slice(-500) });
      throw new Error(msg);
    }
  } // end pull (local rebuilds skip the sync: box files are the source of truth)
  }
  // Read the actual checkout to choose its executor. Analysis is advice, not
  // permission to launch: Docker/Compose report real build and runtime failures.
  const sourcePlan = refreshDeploymentPlan(meta, dir, buildCodeDir);
  try {
    const unset = missingEnvVars(dir).unset;
    if (unset.length) {
      const message = `Source references unset variables (${unset.slice(0, 12).join(', ')}${unset.length > 12 ? ', …' : ''}). Set required values in Environment; external credentials are not invented.`;
      fs.appendFileSync(buildLog, '--- configuration warning: ' + message + ' ---\n');
      panelLog.logEvent({ level: 'warn', area: 'configuration', site: id, message });
    }
  } catch {}
  if (sourcePlan.selected && sourcePlan.selected.kind === 'compose') {
    deployOps.get(id).executor = 'repository-compose';
    const result = await deployRepositoryCompose(meta, dir, buildCodeDir, sourcePlan, opts, sourceSha);
    if (localStage && localStage.retain) localStage.retain();
    return result;
  }
  if (meta.executor === 'repository-compose') throw new Error('The repository Compose entrypoint is missing; restore its instructions before deploying (existing services are untouched)');
  if (sourcePlan.selected?.kind === 'dockerfile') {
    const services = svc.fullServices(meta, dir);
    const service = services.find(s => (s.subdir || '.') === path.posix.dirname(sourcePlan.selected.file));
    if (service && !service.dockerfile) {
      service.dockerfile = path.posix.basename(sourcePlan.selected.file);
      meta.services = services;
      const state = load(), stored = state.apps.find(a => a.id === id);
      if (stored) { stored.services = services; save(state); }
    }
  }
  // Normalize the persisted project before its first Docker command.
  try {
    const ymlPath = path.join(dir, 'docker-compose.yml');
    const before = fs.existsSync(ymlPath) ? fs.readFileSync(ymlPath, 'utf8') : '';
    const detectedServices = opSource !== 'local-push' && (!meta.services || !meta.services.length || hasStaleRootService(meta, dir)) ? configureDetectedServices(meta, dir) : [];
    if (detectedServices.length) {
      const dbSvc = load();
      const stored = dbSvc.apps.find(a => a.id === id);
      if (stored) { Object.assign(stored, { services: meta.services, type: meta.type, subdir: meta.subdir, hostPort: meta.hostPort }); save(dbSvc); }
      fs.appendFileSync(buildLog, `--- service wiring: detected ${detectedServices.join(', ')} ---\n`);
    }
    svc.renderProject({ dir, templatesDir: TEMPLATES_DIR, meta });
    const after = fs.existsSync(ymlPath) ? fs.readFileSync(ymlPath, 'utf8') : '';
    if (before && before !== after) fs.appendFileSync(buildLog, '--- project compose normalized before deploy ---\n');
  } catch (e) {
    await recordDeploy(id, { sha: sourceSha || await currentSha(dir), at: new Date().toISOString(), status: 'error', error: ('compose repair failed - running containers untouched: ' + e.message).slice(-500) });
    throw e;
  }
  try {
    const unset = missingEnvVars(dir).unset;
    if (unset.length) fs.appendFileSync(buildLog, `--- env warning: code references unset vars (${unset.slice(0, 12).join(', ')}${unset.length > 12 ? ', …' : ''}) - add values in Environment if the app requires them ---\n`);
  } catch {}
  // Preserve own-container claims while rebinding taken publication ports.
  try {
    const moved = await rebindHostPorts(id, dir, meta, composeCmd);
    if (moved.length) fs.appendFileSync(buildLog, moved.map(u => `host port ${u.from} taken - ${u.service} moved to ${u.to}\n`).join(''));
  } catch (e) {
    if (deployOps.get(id) && deployOps.get(id).cancelled) throw deployCancelledError();
    await recordDeploy(id, { sha: sourceSha || await currentSha(dir), at: new Date().toISOString(), status: 'error', error: ('host port rebind failed - running containers untouched: ' + e.message).slice(-500) });
    throw e;
  }
  // Repository-driven database guard: before any build/container swap, read the
  // enabled service folders and attach missing managed DBs. This prevents the
  // common "build succeeded, API crash-loops with DATABASE_URL is required"
  // failure from create/link flows and old sites alike.
  try {
    const needed = requiredDatabases(meta, buildCodeDir);
    const current = normDbs(meta.db);
    const added = [];
    for (const dbType of needed) {
      if (!current.includes(dbType)) {
        const r = attachDatabase(meta, dbType);
        if (r.attached) added.push(dbType);
        current.push(dbType);
      }
    }
    const healed = ensureDatabaseAliases(meta);
    if (added.length || healed.length) {
      svc.renderProject({ dir, templatesDir: TEMPLATES_DIR, meta });
      fs.appendFileSync(buildLog, `--- database wiring: ${added.length ? 'attached ' + added.join(', ') : 'aliases refreshed'}${healed.length ? ' (' + healed.join(', ') + ')' : ''} ---\n`);
    }
  } catch (e) {
    const shaDb = sourceSha || await currentSha(dir);
    await recordDeploy(id, { sha: shaDb, at: new Date().toISOString(), status: 'error', error: ('database wiring failed - running containers untouched: ' + e.message).slice(-500) });
    throw e;
  }
  // All deployment sources, including detached local-push checkouts and local
  // rebuilds, pass the same approval gate before any build or container swap.
  const replayedImportServices = new Set();
  try {
    const protectedServices = svc.fullServices(meta, dir);
    for (const service of protectedServices.filter(s => s.enabled !== false)) importProtection.migrate(dir, service, codeDir);
    for (const name of importProtection.run(dir, protectedServices, buildCodeDir, 'replay', line => fs.appendFileSync(buildLog, line + '\n'))) replayedImportServices.add(name);
    for (const name of dockerfileProtection.run(dir, protectedServices, buildCodeDir, 'replay', line => fs.appendFileSync(buildLog, line + '\n'))) replayedImportServices.add(name);
  } catch (e) {
    const failure = 'import protection blocked deployment - running containers untouched: ' + e.message;
    fs.appendFileSync(buildLog, failure + '\n');
    await recordDeploy(id, { sha: sourceSha || await currentSha(dir), at: new Date().toISOString(), status: 'error', error: failure });
    throw new Error(failure);
  }
  // self-heal seeded build files: a panel-seeded Dockerfile/nginx.conf that later
  // vanished (swept, deleted, never committed) kills the build cryptically.
  // Re-seed when the repo shape is unambiguous, fail loud otherwise.
  try {
    for (const s of svc.fullServices(meta || {}, dir).filter(s => s.enabled !== false)) {
      const ctxDir = path.join(buildCodeDir, s.subdir || '');
      // Strict build-file resolution: ambiguous variants or a stale saved
      // selection fail loud here with candidate names before anything builds.
      let df = null;
      try { df = resolveServiceDockerfile(ctxDir, s.dockerfile, s.type, TEMPLATES_DIR); }
      catch (e) { throw new Error(`service '${s.name}': ${e.message}`); }
      if (!df) {
        const detected = svc.detectServiceType(ctxDir);
        if (detected.type && detected.type !== s.type) {
          throw new Error(`service '${s.name}' is configured as '${s.type}' but '${s.subdir || '.'}' is detected as '${detected.type}' - change the service type`);
        }
      }
      const profile = readBuildProfile(ctxDir);
      if (profile.kind === 'jekyll' && s.type !== 'static' && standardDockerfileType(ctxDir, TEMPLATES_DIR)) {
        throw new Error(`service '${s.name}' is a Jekyll static site, not ${s.type} - open Setup and choose Use Jekyll static build`);
      }
      if (!df) {
        ensureDockerfile(ctxDir, s.type, TEMPLATES_DIR, { modernize: !!((s.buildOptions || (s.name === 'app' && meta.buildOptions) || {}).modernize) });
        // Native build prerequisites also apply to ordinary repo/local rebuilds.
        refreshStandardDockerfile(ctxDir, s.type, TEMPLATES_DIR);
      } else if (/^dockerfile$/i.test(df.file)) {
        // Native build prerequisites also apply to ordinary repo/local rebuilds.
        // Variant recipes are author-owned: never template-refresh them.
        refreshStandardDockerfile(ctxDir, s.type, TEMPLATES_DIR);
      }
      // Refresh panel-owned PHP images so existing sites gain standard Apache
      // rewrite support. The pre-marker legacy file is recognized only by an
      // exact byte-normalized match; repository/custom Dockerfiles stay sacred.
      if (s.type === 'php') {
        const df = path.join(ctxDir, 'Dockerfile');
        const tpl = path.join(TEMPLATES_DIR, 'php', 'Dockerfile');
        try {
          const current = fs.readFileSync(df, 'utf8').replace(/\r\n/g, '\n').trim();
          if ((standardDockerfileType(ctxDir, TEMPLATES_DIR) === 'php' || current === LEGACY_PANEL_PHP_DOCKERFILE) && fs.existsSync(tpl)) {
            fs.copyFileSync(tpl, df);
          }
        } catch {}
      }
      if (s.type === 'static' || s.type === 'react') {
        try {
          if (!fs.existsSync(path.join(ctxDir, 'nginx.conf'))) fs.writeFileSync(path.join(ctxDir, 'nginx.conf'), nginxConf(null));
        } catch {}
      }
    }
  } catch (e) {
    const shaSe = sourceSha || await currentSha(dir);
    await recordDeploy(id, { sha: shaSe, at: new Date().toISOString(), status: 'error', error: ('missing build file - running containers untouched: ' + e.message).slice(-500) });
    throw e;
  }
  // automatic pre-build: a repo-owned Dockerfile that expects compiled output
  // (dist/) without compiling it gets the repo's own build script run first in
  // a disposable builder container. The Dockerfile itself is never modified;
  // services that build themselves, lack a build script, or already have the
  // output behave exactly as before.
  let prebuildService = null;
  try {
    for (const s of svc.fullServices(meta || {}, dir).filter(s => s.enabled !== false)) {
      if (/^db(-|$)/.test(s.name || '')) continue;
      const ctxDir = path.join(buildCodeDir, s.subdir || '');
      const force = replayedImportServices.has(s.name) || (Array.isArray(meta.pendingImportBuilds) && meta.pendingImportBuilds.includes(s.name)) || importProtection.list(dir, s.name).length > 0;
      const recipe = resolveServiceDockerfile(ctxDir, s.dockerfile, s.type, TEMPLATES_DIR);
      const item = prebuild.plan(ctxDir, { force, dockerfile: recipe && recipe.file });
      if (!item) continue;
      prebuildService = s.name;
      if (item.blocked) throw new Error(`service '${s.name}' pre-build blocked - running containers untouched: ${item.blocked}`);
      fs.appendFileSync(buildLog, `--- pre-building service '${s.name}' folder '${s.subdir || '.'}' (${item.manager} run build) ${force ? 'after approved import correction' : `for missing '${item.outputDir}/'`} ---\n`);
      const tracked = child => trackDeployChild(id, child);
      await prebuild.ensureBuilderImage(args => args[1] === 'pull'
        ? runLogged(DOCKER_BIN, args, { cwd: dir, logFile: buildLog, detached: process.platform !== 'win32', onSpawn: tracked })
        : runOut(DOCKER_BIN, args, { cwd: dir, detached: process.platform !== 'win32', onSpawn: tracked }));
      checkCancelled(id);
      await runLogged(DOCKER_BIN, prebuild.argv(ctxDir, item), { cwd: dir, logFile: buildLog,
        detached: process.platform !== 'win32', onSpawn: tracked });
    }
  } catch (e) {
    if (deployOps.get(id) && deployOps.get(id).cancelled) throw deployCancelledError();
    const shaPb = sourceSha || await currentSha(dir);
    const failure = panelLog.redact(`pre-build failed${prebuildService ? ` for service '${prebuildService}'` : ''} - running containers untouched: ` + e.message).slice(0, 2000);
    await recordDeploy(id, { sha: shaPb, at: new Date().toISOString(), status: 'error', service: prebuildService, error: failure });
    throw new Error(failure);
  }
  // every build streams to deploy.log (host-persisted, per app) so the UI can show
  // the builder output; failures return the tail instead of a bare exit code.
  // --remove-orphans: disabled/removed services actually disappear.
  // opts.only: rebuild just these services, the rest stay untouched and running.
  const only = Array.isArray(opts.only)
    ? [...new Set(opts.only.filter(s => /^[A-Za-z0-9_-]{1,32}$/.test(s || '')))]
    : [];
  const scope = only.join(' ');
  // auto-link before nginx rendering: exactly one backend sibling + frontend(s)
  // present and no explicit choice on record = wire it on this same deploy.
  // Manual unlink sets apiLinkOff so this never fights back.
  try {
    const autoSvcs = svc.fullServices(meta, dir);
    const autoFronts = autoSvcs.filter(s => (s.type === 'static' || s.type === 'react') && s.enabled !== false);
    const autoBacks = autoSvcs.filter(s => s.type !== 'static' && s.type !== 'react' && s.enabled !== false);
    if (!meta.apiBackend && !meta.apiLinkOff && autoFronts.length >= 1 && autoBacks.length === 1) {
      const b = autoBacks[0];
      meta.apiBackend = { app: b.name, port: parseInt(b.port, 10) || 3000, service: autoFronts[0].name, auto: true };
      const dbAuto = load();
      const mAuto = dbAuto.apps.find(a => a.id === id);
      if (mAuto) { mAuto.apiBackend = meta.apiBackend; save(dbAuto); }
    }
  } catch {}
  // heal: static/react must ship our nginx.conf (SPA fallback, proxy when linked).
  // Only files WE seeded (marker headers) are ever refreshed - repo-owned files are sacred.
  // Proxy target comes from env (the link lives there), meta only migrates old links forward.
  // heal: every enabled static/react SERVICE gets a working nginx.conf.
  // Only files WE seeded (marker headers) are ever refreshed - repo-owned files are sacred.
  // The api link lands on its recorded service (or the first frontend); others stay plain.
  try {
    const services = svc.fullServices(meta || {}, dir);
    const fronts = services.filter(s => (s.type === 'static' || s.type === 'react') && s.enabled !== false);
    const envNow = parseEnvFile(path.join(dir, '.env'));
    let proxy = null;
    const ab = meta && meta.apiBackend;
    if (ab && ab.app) {
      const sib = services.find(s => s.name === ab.app.replace(/^svc:/, '') && s.enabled !== false);
      if (sib) {
        proxy = { host: sib.name, port: parseInt(sib.port, 10) || 3000 };
      } else {
        const t = load().apps.find(a => a.id === ab.app);
        if (t && t.hostPort) proxy = { host: 'host.docker.internal', port: t.hostPort };
      }
      if (proxy && (envNow.API_PORT !== String(proxy.port) || envNow.API_HOST !== proxy.host)) {
        envSetManaged(dir, { API_HOST: proxy.host, API_PORT: String(proxy.port) });
      }
    }
    if (!proxy && envNow.API_HOST && envNow.API_PORT) proxy = { host: envNow.API_HOST, port: envNow.API_PORT };
    const linkedSvc = (ab && ab.service) || (fronts[0] && fronts[0].name);
    for (const f of fronts) {
      const ctx = path.join(buildCodeDir, f.subdir || '');
      const df = path.join(ctx, 'Dockerfile');
      if (f.type === 'static' && readBuildProfile(ctx).kind !== 'jekyll' && fs.existsSync(df)) {
        const first = (fs.readFileSync(df, 'utf8').split('\n')[0] || '');
        if (first.includes('minipass template') || first.includes('build stage + serve')) {
          const tplDf = path.join(TEMPLATES_DIR, f.type, 'Dockerfile');
          if (fs.existsSync(tplDf)) fs.copyFileSync(tplDf, df);
        }
      }
      const wantProxy = linkedSvc === f.name ? proxy : null;
      const nc = path.join(ctx, 'nginx.conf');
      let cur = null;
      try { cur = fs.readFileSync(nc, 'utf8'); } catch {}
      if (cur === null) {
        fs.writeFileSync(nc, nginxConf(wantProxy));
      } else if (cur.includes('# minipass-managed') && cur !== nginxConf(wantProxy)) {
        fs.writeFileSync(nc, nginxConf(wantProxy));
      }
    }
  } catch {}
  const sha = sourceSha || await currentSha(dir);
  const stamp = () => new Date().toISOString();
  // atomic deploy: snapshot running images, build WITHOUT touching containers,
  // swap only on success, health-gate the new containers, roll back on failure.
  const snaps = await snapshotImages(id, dir);
  checkCancelled(id);
  const scopeSuffix = scope ? ` ${scope}` : '';
  fs.appendFileSync(buildLog, '--- Docker image build ---\n');
  const buildOffset = fs.statSync(buildLog).size;
  const buildManager = resolveBuildManager(meta, typeof buildCodeDir === 'string' ? buildCodeDir : codeDir);
  try {
    await deploySh(id, `${composeCmd} build --build-arg PACKAGE_MANAGER=${buildManager}${scopeSuffix} >> "${buildLog}" 2>&1`, dir);
  } catch (e) {
    if (deployOps.get(id) && deployOps.get(id).cancelled) {
      const cancelled = 'deploy cancelled - active build terminated and containers stay stopped';
      try { fs.appendFileSync(buildLog, `\n--- ${cancelled} ---\n`); } catch {}
      await recordDeploy(id, { sha, at: stamp(), status: 'error', error: cancelled });
      throw deployCancelledError();
    }
    let tail = '';
    try {
      const lines = fs.readFileSync(buildLog).subarray(buildOffset).toString('utf8').split('\n');
      // The last lines are usually just the summary; the cause (npm error
      // codes, tsc errors, ELIFECYCLE) sits above. Prefer cause lines so the
      // Deploy tab names the failure without SSH.
      tail = failureSummary(lines.slice(-500).join('\n'));
    } catch {}
    await recordDeploy(id, { sha, at: stamp(), status: 'error', error: panelLog.redact('build failed - running containers untouched: ' + (tail || e.message)).trim().slice(0, 2000) });
    throw new Error('build failed - running containers untouched: ' + (tail || e.message).trim().split('\n').slice(-3).join(' '));
  }
  if (opts.skipSync) {
    try { fs.appendFileSync(buildLog, '--- built from local box files (git sync skipped) ---\n'); } catch {}
  }
  // pre-swap migrations: one-off container from the fresh image, DBs already up.
  // Fail = abort before anything is swapped; running containers untouched.
  // Runs in the configured migrate service (knex usually lives in the backend
  // service, not 'app'), with an optional cd into its subfolder.
  const migrateCmd = String((meta && meta.migrateCmd) || '').trim();
  if (migrateCmd) {
    const migrateSvc = migrateTarget(meta, dir, meta.migrateSvc);
    const argv = migrateRunArgv(migrateSvc, meta.migrateDir || '', migrateCmd);
    try {
      checkCancelled(id);
      const out = await runOut(argv[0], argv.slice(1), { cwd: dir, captureStderr: true,
        detached: process.platform !== 'win32', onSpawn: child => trackDeployChild(id, child) });
      try { fs.appendFileSync(buildLog, `\n--- migrate (${migrateSvc}) ---\n` + String(out).slice(-2000)); } catch {}
    } catch (e) {
      if (deployOps.get(id) && deployOps.get(id).cancelled) throw deployCancelledError();
      const reason = migrationFailure(e);
      const failure = migrationResponse('migration failed - running containers untouched: ', e);
      try { fs.appendFileSync(buildLog, `\n--- migrate failed (${migrateSvc}) ---\n${reason}\n`); } catch {}
      await recordDeploy(id, { sha, at: stamp(), status: 'error', error: failure });
      throw new Error(failure);
    }
  }
  try {
    checkCancelled(id); // a stop during the build wins: never start containers afterwards
    await deploySh(id, `${composeCmd} up -d --remove-orphans${scopeSuffix} >> "${buildLog}" 2>&1`, dir);
  } catch (e) {
    if (deployOps.get(id) && deployOps.get(id).cancelled) {
      await recordDeploy(id, { sha, at: stamp(), status: 'error', error: 'deploy cancelled - the site was stopped mid-deploy; containers stay stopped' });
      throw new Error('deploy cancelled - the site was stopped mid-deploy; containers stay stopped');
    }
    await recordDeploy(id, { sha, at: stamp(), status: 'error', error: String(e.message).slice(-500) });
    throw e;
  }
  const gate = await waitStable(id, dir, meta, only.length ? only : null);
  if (!gate.ok) {
    await rollbackImages(dir, snaps).catch(() => {});
    await recordDeploy(id, { sha, at: stamp(), status: 'error', error: ('new containers unhealthy - rolled back: ' + gate.detail).slice(-500) });
    throw new Error('new containers unhealthy - rolled back: ' + gate.detail);
  }
  await recordDeploy(id, { sha, at: stamp(), status: 'ok', runtime: gate.detail || 'Application containers are running steadily', services: only.length ? only : svc.fullServices(meta, dir).filter(s => s.enabled !== false).map(s => s.name) });
  // Landing-path discovery is optional follow-up work. Do not hold the deploy
  // lock (and keep the UI pulsing) after the release is already healthy/live.
  autodetectHome(id).catch(e => console.error(id, 'home detection:', e.message));
  return true;
  } catch (e) {
    // Also retain failures before the build stage (source sync, staging, etc.).
    // Stage-specific failures already recorded above must not be duplicated.
    const op = deployOps.get(id);
    if (op && !op.failureRecorded) {
      await recordDeploy(id, { at: new Date().toISOString(), status: 'error',
        error: panelLog.redact(e.message).slice(0, 2000) });
    }
    throw e;
  } finally {
    const cancelled = !!(deployOps.get(id) && deployOps.get(id).cancelled);
    if (localStage) localStage.cleanup();
    deployChildren.delete(id);
    deployLocks.delete(id);
    deployOps.delete(id);
    // Cancellation must clear live UI state immediately; no image was swapped,
    // so the optional post-deploy inventory is unnecessary and must not delay Stop.
    if (!cancelled) {
      try {
        const retained = load().apps.find(a => a.id === id);
        if (retained) await trashLib.rememberImages({ id, dir: appDir(APPS_DIR, id), record: retained, docker: DOCKER_BIN, compose: composeArgv() });
      } catch (e) { console.error(id, 'image inventory unavailable:', e.message); }
    }
  }
}

function deploymentRunners(id, dir) {
  const options = { cwd: dir, detached: process.platform !== 'win32', onSpawn: child => trackDeployChild(id, child) };
  return {
    run: (bin, args, extra = {}) => { const { cleanup, ...opts } = extra; if (!cleanup) checkCancelled(id); return runOut(bin, args, { ...options, ...opts }); },
    logged: (bin, args, extra = {}) => { checkCancelled(id); return runLogged(bin, args, { ...options, logFile: path.join(dir, 'deploy.log'), ...extra }); }
  };
}

async function deployRepositoryCompose(meta, dir, root, plan, opts, sourceSha) {
  const io = deploymentRunners(meta.id, dir);
  const entrypoint = { ...plan.selected };
  const launchPath = (entrypoint.files || [entrypoint.file]).join(' + ');
  fs.appendFileSync(path.join(dir, 'deploy.log'), '--- repository launch path: ' + launchPath + ' ---\n');
  panelLog.logEvent({ level: 'info', area: 'launch-path', site: meta.id, message: 'Following repository Compose invocation: ' + launchPath });
  const containers=await repositoryCompose.inspectProject({id:meta.id,docker:DOCKER_BIN,run:io.run});
  if(!localAccess.isLocal(meta))localAccess.validateTarget(meta.publicUrl,meta,load().apps);
  const declared=composeInputs.declarations(root,entrypoint).services;
  const bound = portsLib.parsePublishedPorts(String(await io.run(DOCKER_BIN, ['ps', '--format', '{{.ID}} {{.Ports}}'])));
  const occupied = new Set(bound.keys());
  for (const c of containers) {
    let service=c.Config.Labels['com.docker.compose.service'];
    if(!declared[service]&&String(c.Config.Image).startsWith('minipass/publisher:')){const upstream=(c.Config.Env || []).find(e=>e.startsWith('UPSTREAM='));try{service=new URL(upstream.slice(9)).hostname;}catch{}}
    if(!declared[service])continue;
    for(const values of Object.values(c.NetworkSettings.Ports || {}))for(const p of values || []){const port=Number(p.HostPort),holders=bound.get(port)||new Set();if([...holders].every(cid=>containers.some(c=>c.Id.startsWith(cid))))occupied.delete(port);}
  }
  for(const site of load().apps.filter(a=>a.id!==meta.id))for(const s of svc.fullServices(site,appDir(APPS_DIR,site.id)))if(s.hostPort)occupied.add(Number(s.hostPort));
  if(localAccess.isLocal(meta)) {
    meta.accessMode='local';
    meta.hostPort=portsLib.nextFreePort(meta.hostPort||8000,occupied,8000,8999);
    meta.localUrl=localAccess.address(meta,root,entrypoint);
  }
  const volumes=String(await io.run(DOCKER_BIN,['volume','ls','-q','--filter','label=com.docker.compose.project='+meta.id])).trim().split(/\s+/).filter(Boolean);
  const inputs=composeInputs.provision({dir,root,selection:entrypoint,meta,containers,volumes});
  syncProvisionedDomain(meta,dir,inputs);
  if(inputs.changed.length)fs.appendFileSync(path.join(dir,'deploy.log'),'--- repository database inputs prepared: '+inputs.changed.join(', ')+' ---\n');
  for(const issue of inputs.issues)fs.appendFileSync(path.join(dir,'deploy.log'),'--- configuration note: '+issue.message+' ---\n');
  plan=refreshDeploymentPlan(meta,dir,root);
  const config = await repositoryCompose.resolve({ compose: composeArgv(), id: meta.id, dir, root, entrypoint, run: io.run });
  const originWarnings=localAccess.applyOrigins(config,dir,root,entrypoint,meta);
  for(const warning of originWarnings)fs.appendFileSync(path.join(dir,'deploy.log'),'--- '+warning+' ---\n');
  // Publish only keys and redacted command summaries from the authoritative
  // combined model. Literal env values never enter the report/API response.
  const resolvedTopology = require('./compose-read').parseCompose(require('yaml').stringify(config),entrypoint.file);
  const safeSummary = deploymentPlan.analyzeResolvedTopology(resolvedTopology);
  fs.writeFileSync(path.join(dir,'.resolved-plan.json'),JSON.stringify({fingerprint:plan.fingerprint,envDigest:crypto.createHash('sha256').update(fs.readFileSync(path.join(dir,'.env'))).digest('hex'),topology:safeSummary}),{mode:0o600});
  plan.topology=safeSummary;plan.resolved=true;
  plan.blockers=plan.blockers.filter(b=>!['REQUIRED_ENV','MISSING_RECIPE','MISSING_DEPENDENCY','MISSING_ENV_FILE'].includes(b.code));
  plan.ready=plan.blockers.length===0;deploymentPlan.persist(dir,plan);
  await repositoryCompose.inferImagePorts(config, { docker: DOCKER_BIN, ...io });
  // Preserve claims held by the same declared service, but do not steal a port
  // from a differently named old service during executor/source migration.
  const model = repositoryCompose.prepare(config, { id: meta.id, dir, root, meta: { ...meta, deploymentEntrypoint: entrypoint }, occupied: [...occupied] });
  const apps = model.services.filter(s => s.role === 'application').sort((a, b) => Number(b.frontend) - Number(a.frontend));
  for (const service of apps) {
    const previous = (meta.services || []).find(s => s.name === service.name);
    if (previous) for (const key of ['homePath', 'openPaths']) if (previous[key] !== undefined) service[key] = previous[key];
  }
  const primary = apps.find(s => s.hostPort) || apps[0];
  if (primary) primary.primary = true;
  if(localAccess.isLocal(meta)&&primary&&primary.hostPort) {
    const actual=localAccess.address(meta,root,entrypoint,primary.hostPort);
    meta.localUrl=actual;
    localAccess.applyOrigins(model.config,dir,root,entrypoint,meta);
    const state=load(),stored=state.apps.find(a=>a.id===meta.id);if(stored){Object.assign(stored,{localUrl:actual,accessMode:'local'});save(state);}
  }
  model.services = [...apps, ...model.services.filter(s => s.role !== 'application')];
  const tls=localAccess.isLocal(meta)&&meta.localUrl&&meta.localUrl.startsWith('https:')?await localAccess.ensureTls({dir,host:meta.accessHost||'localhost',run:io.run}):null;
  if (tls) {
    const publisher = await publication.ensure({ docker: DOCKER_BIN, templates: TEMPLATES_DIR, ...io });
    publication.add(model, publisher, meta.id, tls);
    model.services.push(...repositoryCompose.publicServices(model.config, root).filter(s => s.role === 'routing'));
  }
  const result = await repositoryCompose.deploy({ model, compose: composeArgv(), docker: DOCKER_BIN, id: meta.id, dir, ...io,
    check: () => checkCancelled(meta.id), notify: phase => fs.appendFileSync(path.join(dir, 'deploy.log'), `--- repository ${phase} ---\n`) });
  const db_ = load();
  const stored = db_.apps.find(a => a.id === meta.id);
  Object.assign(stored, { executor: 'repository-compose', deploymentEntrypoint: entrypoint, services: apps, repositoryServices: model.services,
    repositoryDatabases:Object.entries(config.services).flatMap(([service,s])=>model.categories[service]==='database'?[{service,type:composeInputs.typeOf(s.image),image:s.image,repositoryOwned:true}]:[]),
    composePorts: model.ports, hostPort: primary && primary.hostPort || null, type: primary && primary.type || meta.type,
    composeSource: root === path.join(dir, 'code') ? null : root, publicUrl: meta.publicUrl || null, localUrl:meta.localUrl || null,accessMode:meta.accessMode || null,db: [] });
  if (primary && !stored.homePathManual) stored.homePath = primary.homePath === '/' ? '' : primary.homePath || '';
  save(db_);
  await recordDeploy(meta.id, { sha: sourceSha || await currentSha(dir), at: new Date().toISOString(), status: 'ok',
    services: apps.map(s => s.name), runtime: result.runtime, tasks: result.tasks });
  autodetectHome(meta.id).catch(e => console.error(meta.id, 'home detection:', e.message));
  return true;
}
  return { deployNow, deployRepositoryCompose, deploymentRunners, snapshotImages, rollbackImages, waitStable, deploySh };
};
