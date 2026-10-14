// deployment-state: extracted from the original backend without changing route semantics.
module.exports = function createHelpers(ctx) {
  const { APPS_DIR, DATA_FILE, DOCKER_BIN, TEMPLATES_DIR, appDir, composeInputs, crypto, deployEpochs, deployMarkers, deployOps, deployQueues, deploymentPlan, envDefaults, fs, lifecycleLocks, localAccess, panelLog, path, portsLib, readEnvVars, repositoryCompose, routes, svc } = ctx;
  const cleanDomain = (...args) => ctx.cleanDomain(...args);
  const codeDir = (...args) => ctx.codeDir(...args);
  const deployCancelledError = (...args) => ctx.deployCancelledError(...args);
  const deployNow = (...args) => ctx.deployNow(...args);
  const deploySh = (...args) => ctx.deploySh(...args);
  const envSetManaged = (...args) => ctx.envSetManaged(...args);
  const hostPortsInUse = (...args) => ctx.hostPortsInUse(...args);
  const load = (...args) => ctx.load(...args);
  const runOut = (...args) => ctx.runOut(...args);
  const save = (...args) => ctx.save(...args);
  const sh = (...args) => ctx.sh(...args);
async function recordDeploy(id, rec) {
  const op = deployOps.get(id);
  if (op) {
    rec.source = rec.source || op.source;
    if (!rec.durationMs) rec.durationMs = Date.now() - op.startedAt;
  }
  if (rec.status === 'error') {
    rec.error = panelLog.redact(rec.error || 'Deployment failed').slice(0, 2000);
    panelLog.logEvent(panelLog.deploymentEvent(id, rec));
    try { fs.appendFileSync(path.join(appDir(APPS_DIR, id), 'deploy.log'), `\n--- ERROR ${rec.at || new Date().toISOString()} ---\n${rec.error}\n`); }
    catch (e) { console.error('Deployment error log could not be written:', e.message); }
    if (op) op.failureRecorded = true;
  }
  else if (rec.status === 'ok') panelLog.logEvent({ at: rec.at, level: 'info', area: 'deploy-' + (rec.source || op?.source || 'manual'), site: id, message: 'Deployment completed; declared runtime services passed the stability check.' });
  try {
    const db2 = load();
    const m = db2.apps.find(a => a.id === id);
    if (m) {
      m.lastDeploy = rec;
      if (rec.status === 'ok') {
        delete m.dirty;
        if (Array.isArray(m.pendingImportBuilds) && Array.isArray(rec.services)) {
          m.pendingImportBuilds = m.pendingImportBuilds.filter(name => !rec.services.includes(name));
          if (!m.pendingImportBuilds.length) delete m.pendingImportBuilds;
        }
        m.lastGoodDeploy = { at: rec.at, sha: rec.sha, status: rec.status, source: rec.source || null, durationMs: rec.durationMs != null ? rec.durationMs : null };
      }
      m.deployHistory = [{ at: rec.at, sha: rec.sha, status: rec.status, source: rec.source || null, durationMs: rec.durationMs != null ? rec.durationMs : null, error: rec.error || null }, ...(m.deployHistory || [])].slice(0, 10);
      save(db2);
    }
  } catch {}
}

async function markDirty(id, reason) {
  try {
    const db2 = load();
    const m = db2.apps.find(a => a.id === id);
    if (m && !m.dirty) { m.dirty = { reason, at: new Date().toISOString() }; save(db2); }
  } catch {}
  // Source mutations (Files, uploads, repository sync and setup edits) all
  // refresh the same persisted plan. Analysis errors never undo a saved file.
  try {
    const meta = load().apps.find(a => a.id === id);
    if (meta) {
      const dir = appDir(APPS_DIR, id);
      const plan = refreshDeploymentPlan(meta, dir);
      if (plan.selected && plan.selected.kind === 'compose') {
        // Keep existing values/data, but stop locking legacy generated aliases
        // as though they were authoritative repository deployment inputs.
        fs.writeFileSync(path.join(dir, '.env.managed'), 'COMPOSE_PROJECT_NAME\nDOMAIN\n');
      }
    }
  } catch (e) { panelLog.logEvent({ level: 'warn', area: 'deployment-plan', site: id, message: 'Plan refresh failed: ' + e.message }); }
}

function refreshDeploymentPlan(meta, dir, root = path.join(dir, 'code')) {
  let entryDir = root;
  if (meta.deploymentEntrypoint && meta.deploymentEntrypoint.kind === 'compose') entryDir = path.dirname(path.join(root, meta.deploymentEntrypoint.file));
  const defaultEnv = readEnvVars(path.join(entryDir, '.env'));
  const plan = deploymentPlan.analyze(root, {
    selection: meta.deploymentEntrypoint || null, services: svc.fullServices(meta, dir), templatesDir: TEMPLATES_DIR,
    env: Object.fromEntries([...defaultEnv, ...readEnvVars(path.join(dir, '.env'))].map(v => [v.key, v.value]))
  });
  try {
    const resolved = JSON.parse(fs.readFileSync(path.join(dir,'.resolved-plan.json'),'utf8'));
    if (resolved.fingerprint === plan.fingerprint && resolved.envDigest === crypto.createHash('sha256').update(fs.readFileSync(path.join(dir,'.env'))).digest('hex')) {
      plan.topology = resolved.topology;
      plan.resolved = true;
      plan.blockers = plan.blockers.filter(b=>!['REQUIRED_ENV','MISSING_RECIPE','MISSING_DEPENDENCY','MISSING_ENV_FILE'].includes(b.code));
      plan.ready = plan.blockers.length===0;
    }
  } catch {}
  try { plan.provisioning=JSON.parse(fs.readFileSync(path.join(dir,'.compose-inputs.json'),'utf8')).actions || []; } catch {}
  plan.localUrl=meta.localUrl || '';plan.accessMode=meta.accessMode || (localAccess.isLocal(meta)?'local':'public');
  if(!plan.localUrl&&plan.accessMode==='local'&&plan.selected?.kind==='compose')try{plan.localUrl=localAccess.address(meta,root,plan.selected);}catch{}
  if(!plan.localUrl&&plan.accessMode==='local'&&meta.hostPort)try{const host=localAccess.hostname(meta.accessHost);plan.localUrl=`http://${host.includes(':')?'['+host+']':host}:${Number(meta.hostPort)}/`;}catch{}
  plan.repositoryDatabases=[];try{if(plan.selected?.kind==='compose')plan.repositoryDatabases=composeInputs.declaredDatabases(root,plan.selected);}catch{}
  plan.localCaReady=fs.existsSync(path.join(dir,'.local-tls','ca.crt'));
  return deploymentPlan.persist(dir, plan);
}

function syncProvisionedDomain(meta,dir,result) {
  if(!result.changed.includes('DOMAIN'))return;
  const value=envDefaults.parseExample(fs.readFileSync(path.join(dir,'.env'),'utf8')).find(v=>v.key==='DOMAIN');
  if(!value)return;
  const domain=cleanDomain(value.value);
  const db_=load(),stored=db_.apps.find(a=>a.id===meta.id);
  if(stored){stored.domain=domain;save(db_);}
  meta.domain=domain;
}

async function autodetectHome(id) {
  try {
    const dir = appDir(APPS_DIR, id);
    const fresh = load().apps.find(a => a.id === id);
    if (!fresh) return;
    const services = svc.fullServices(fresh, dir).filter(s => s.enabled !== false);
    const networks = new Map();
    if (fresh.executor === 'repository-compose') {
      for (const container of await repositoryCompose.inspectProject({ id, docker: DOCKER_BIN, run: runOut })) {
        networks.set(container.Config.Labels['com.docker.compose.service'], Object.keys(container.NetworkSettings.Networks || {})[0]);
      }
    }
    const cands = routes.PROBE_PATHS;
    const results = [];
    for (const service of services) {
      const net = networks.get(service.name) || `${id}_default`;
      if (['static', 'react'].includes(service.type)) {
        results.push({ name: service.name, path: '', openPaths: [{ path: '/', code: 200, live: true, source: 'frontend' }] });
        continue;
      }
      const ctxDir = path.join(fresh.composeSource || path.join(dir, 'code'), service.subdir || '');
      const sourceRoutes = routes.detectOpenPaths(ctxDir);
      const directRoutes = sourceRoutes.filter(r => r.direct).map(r => r.path);
      const mountedRoutes = sourceRoutes.filter(r => !r.direct).map(r => r.path);
      const sourceCandidates = [...new Set([...directRoutes, ...mountedRoutes])]
        .sort((a, b) => routes.routeScore(a) - routes.routeScore(b)).slice(0, 24);
      const discovered = new Map(sourceCandidates.map(p => [p, {
        path: p, code: null, live: null, source: directRoutes.includes(p) ? 'direct' : 'router'
      }]));
      const probeOne = async (p, record = true) => {
        try {
          const url = `http://${service.name}:${parseInt(service.port, 10) || 3000}${p}`;
          const code = String(await runOut(DOCKER_BIN, ['run', '--rm', '--network', net, 'curlimages/curl:latest', '-s', '-o', '/dev/null', '-w', '%{http_code}', '--max-time', '5', url], { timeout: 25000 })).trim();
          const item = discovered.get(p) || { path: p, source: 'probe' };
          item.code = parseInt(code, 10) || null;
          item.live = routes.liveStatus(code);
          if (record) discovered.set(p, item);
          return item;
        } catch { return null; }
      };
      // Probe every literal source route so multi-route APIs can present all
      // valid entry points. A successful deliberately-missing path means this
      // app has a catch-all/soft-404 (common in PHP front controllers and SPAs),
      // so guessed health paths cannot prove anything and root is the safe default.
      const sentinel = await probeOne(routes.PROBE_SENTINEL, false);
      const soft404 = !!(sentinel && sentinel.live);
      let live = [];
      if (soft404) {
        const root = await probeOne('/');
        if (root && root.live) live = [root];
      } else {
        for (const p of sourceCandidates) await probeOne(p);
        if (sourceCandidates.length && ![...discovered.values()].some(x => x.live)) {
          await new Promise(r => setTimeout(r, 2000));
          for (const p of sourceCandidates) await probeOne(p);
        }
        live = [...discovered.values()].filter(x => x.live)
          .sort((a, b) => routes.routeScore(a.path) - routes.routeScore(b.path));
        if (!live.length) {
          const fallbacks = cands.filter(p => !discovered.has(p));
          for (let round = 0; round < 2 && !live.length; round++) {
            if (round) await new Promise(r => setTimeout(r, 2000));
            for (const p of fallbacks) {
              const item = await probeOne(p);
              if (item && item.live) { live = [item]; break; }
            }
          }
        }
      }
      const currentPath = service.name === 'app' ? (fresh.homePath || '/') : (service.homePath || '/');
      let found = routes.chooseOpenPath(live, currentPath);
      // A direct app.get/server.get/Route::get declaration is more useful than
      // publishing a known-bad root when Docker cannot run the curl probe.
      const anyResponse = [...discovered.values()].some(x => x.code != null);
      if (found == null && directRoutes.length && !anyResponse) found = directRoutes[0];
      if (found != null) {
        const openPaths = [...discovered.values()]
          .filter(x => sourceCandidates.includes(x.path) || x.live)
          .sort((a, b) => Number(b.live === true) - Number(a.live === true) || routes.routeScore(a.path) - routes.routeScore(b.path));
        results.push({ name: service.name, path: found === '/' ? '' : found, openPaths });
      }
    }
    if (!results.length) return;
    const db3 = load();
    const m3 = db3.apps.find(a => a.id === id);
    if (!m3) return;
    let changed = false;
    for (const result of results) {
      if (result.name === 'app') {
        if (!m3.homePathManual && (m3.homePath || '') !== result.path) { m3.homePath = result.path; changed = true; }
        if (JSON.stringify(m3.openPaths || []) !== JSON.stringify(result.openPaths || [])) { m3.openPaths = result.openPaths || []; changed = true; }
      } else if (Array.isArray(m3.services)) {
        const stored = m3.services.find(s => s.name === result.name);
        if (stored && (stored.homePath || '') !== result.path) { stored.homePath = result.path; changed = true; }
        if (stored && JSON.stringify(stored.openPaths || []) !== JSON.stringify(result.openPaths || [])) { stored.openPaths = result.openPaths || []; changed = true; }
      }
    }
    if (changed) save(db3);
  } catch (e) { console.error(id, 'autodetect:', e.message); }
}

function deploy(id, opts = {}) {
  if (lifecycleLocks.has(id)) return Promise.reject(new Error('site lifecycle operation in progress'));
  const epoch = deployEpochs.get(id) || 0;
  const previous = deployQueues.get(id) || Promise.resolve();
  const run = previous.catch(() => {}).then(() => {
    if ((deployEpochs.get(id) || 0) !== epoch) throw deployCancelledError();
    return deployNow(id, opts);
  });
  deployQueues.set(id, run);
  // Host-visible marker so the upgrade job defers its restart while any site
  // deploy is queued or running. Cleared only when no queue remains for the
  // site, so overlapping deploys never drop coverage early.
  deployMarkers.mark(path.dirname(DATA_FILE), id);
  const clear = () => { if (deployQueues.get(id) === run) deployQueues.delete(id); if (!deployQueues.has(id)) deployMarkers.unmark(path.dirname(DATA_FILE), id); };
  run.then(clear, clear);
  return run;
}

async function rebindHostPorts(id, dir, meta, composeCmd) {
  const enabled = svc.fullServices(meta || {}, dir).filter(s => s.enabled !== false && s.hostPort);
  if (!enabled.length) return [];
  let own = [];
  try { own = String(await deploySh(id, `${composeCmd} ps -q`, dir)).split(/\s+/).map(s => s.trim()).filter(Boolean); }
  catch { own = []; }
  let bound;
  try {
    bound = portsLib.parsePublishedPorts(await sh('docker ps --format "{{.ID}} {{.Ports}}"', dir));
  } catch {
    return []; // docker unreachable - keep stored ports, `up` reports the truth
  }
  const selfPorts = new Set(enabled.map(s => parseInt(s.hostPort, 10)));
  const registryOthers = new Set([...hostPortsInUse()].filter(p => !selfPorts.has(p)));
  const moves = portsLib.planRebind(enabled.map(s => ({ name: s.name, hostPort: s.hostPort })), { bound, own, registryOthers });
  if (!moves.length) return [];
  const byName = new Map(moves.map(m => [m.name, m.to]));
  for (const s of enabled) if (byName.has(s.name)) s.hostPort = byName.get(s.name);
  if (!meta.services || !meta.services.length) meta.services = enabled;
  const primary = enabled.find(s => s.name === 'app') || enabled[0];
  meta.hostPort = primary.hostPort;
  envSetManaged(dir, { HOST_PORT: String(primary.hostPort) });
  svc.renderProject({ dir, templatesDir: TEMPLATES_DIR, meta });
  const db = load();
  const m = db.apps.find(a => a.id === id);
  if (m) { m.services = meta.services; m.hostPort = meta.hostPort; save(db); }
  return moves.map(m => ({ service: m.name, from: m.from, to: m.to }));
}

function resolveBuildManager(meta, codeDir) {
  try {
    const { detectPackageManager } = require('./detect');
    const pkg = JSON.parse(fs.readFileSync(path.join(codeDir, 'package.json'), 'utf8'));
    return detectPackageManager({ pkg, files: fs.readdirSync(codeDir) }).manager;
  } catch {}
  const stored = meta && meta.packageManager;
  if (['npm', 'pnpm', 'yarn', 'bun'].includes(stored)) return stored;
  return 'npm';
}
  return { recordDeploy, markDirty, refreshDeploymentPlan, syncProvisionedDomain, autodetectHome, deploy, rebindHostPorts, resolveBuildManager };
};
