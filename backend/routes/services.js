// services: extracted from the original backend without changing route semantics.
module.exports = function register(ctx) {
  const { APPS_DIR, DOCKER_BIN, STANDARD_DOCKER_TYPES, TEMPLATES_DIR, TYPE_PORT, app, appDir, composeInputs, deployLocks, deployQueues, ensureDockerfile, findDockerfiles, fs, inferPort, localAccess, localBuildProfile, needsDockerfileOptIn, nginxConf, panelLog, path, readBuildProfile, repositoryCompose, resolveServiceDockerfile, svc } = ctx;
  const applyEnvDefaults = (...args) => ctx.applyEnvDefaults(...args);
  const deploy = (...args) => ctx.deploy(...args);
  const envDeleteKeys = (...args) => ctx.envDeleteKeys(...args);
  const envSetManaged = (...args) => ctx.envSetManaged(...args);
  const hostPortsInUse = (...args) => ctx.hostPortsInUse(...args);
  const load = (...args) => ctx.load(...args);
  const markDirty = (...args) => ctx.markDirty(...args);
  const pubApp = (...args) => ctx.pubApp(...args);
  const publicServices = (...args) => ctx.publicServices(...args);
  const refreshDeploymentPlan = (...args) => ctx.refreshDeploymentPlan(...args);
  const runOut = (...args) => ctx.runOut(...args);
  const save = (...args) => ctx.save(...args);
  const serviceCandidate = (...args) => ctx.serviceCandidate(...args);
  const siteLifecycle = (...args) => ctx.siteLifecycle(...args);
  const syncProvisionedDomain = (...args) => ctx.syncProvisionedDomain(...args);
app.get('/api/apps/:id/deployment-plan', (req, res) => {
  try {
    const meta = load().apps.find(a => a.id === req.params.id);
    if (!meta) return res.status(404).json({ error: 'unknown app' });
    const dir = appDir(APPS_DIR, meta.id);
    // Never replace a detached-source deployment's plan with the old checkout
    // while it is being reviewed/built. Otherwise rescan source, including edits
    // performed outside the panel; persisted reports are not trusted as current.
    if (deployLocks.has(meta.id) && fs.existsSync(path.join(dir, '.deployment-plan.json'))) return res.json(JSON.parse(fs.readFileSync(path.join(dir, '.deployment-plan.json'), 'utf8')));
    const plan = refreshDeploymentPlan(meta, dir, meta.composeSource || path.join(dir, 'code'));
    plan.publicUrl = meta.publicUrl || '';
    res.json(plan);
  } catch (e) { res.status(500).json({ error: 'Deployment analysis failed: ' + e.message }); }
});

app.post('/api/apps/:id/deployment-plan', async (req, res) => {
  try {
    if (deployQueues.has(req.params.id) || deployLocks.has(req.params.id)) return res.status(409).json({ error: 'wait for the current deployment to finish' });
    const db_ = load();
    const meta = db_.apps.find(a => a.id === req.params.id);
    if (!meta) return res.status(404).json({ error: 'unknown app' });
    const dir = appDir(APPS_DIR, meta.id);
    const previous = refreshDeploymentPlan(meta, dir);
    const choice = req.body.selection;
    if (meta.executor === 'repository-compose' && choice && choice.kind !== 'compose') return res.status(409).json({ error: 'This site runs a repository-owned topology; changing to a single generated service requires an explicit site/data migration' });
    if (choice !== null && (!choice || !previous.candidates.some(c => c.kind === choice.kind && c.file === choice.file && JSON.stringify(c.files || [c.file]) === JSON.stringify(choice.files || [choice.file]) && JSON.stringify(c.profiles || []) === JSON.stringify(choice.profiles || [])))) return res.status(400).json({ error: 'choose a discovered deployment entrypoint' });
    if (choice && choice.kind === 'dockerfile') {
      const services = svc.fullServices(meta, dir);
      const service = services.find(s => (s.subdir || '.') === path.posix.dirname(choice.file));
      if (!service) return res.status(409).json({ error: 'add a service for this file’s build folder in Setup first' });
      const filename = path.posix.basename(choice.file);
      resolveServiceDockerfile(path.join(dir, 'code', service.subdir || ''), filename, service.type, TEMPLATES_DIR);
      service.dockerfile = filename;
      meta.services = services;
      svc.renderProject({ dir, templatesDir: TEMPLATES_DIR, meta });
    }
    if (choice) meta.deploymentEntrypoint = { kind: choice.kind, file: choice.file, ...(choice.files ? { files: choice.files, profiles: choice.profiles || [] } : {}) };
    else delete meta.deploymentEntrypoint;
    save(db_);
    await markDirty(meta.id, 'deployment entrypoint saved');
    res.json({ ok: true, saved: true, pending: true, plan: refreshDeploymentPlan(meta, dir) });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.post(['/api/apps/:id/access', '/api/apps/:id/verification'], async (req, res) => {
  try {
    await siteLifecycle(req.params.id,async()=>{
    if (deployQueues.has(req.params.id) || deployLocks.has(req.params.id)) return res.status(409).json({ error: 'wait for deployment to finish' });
    const db_ = load(); const meta = db_.apps.find(a => a.id === req.params.id);
    if (!meta) return res.status(404).json({ error: 'unknown app' });
    const local=req.body.access==='local';
    const selected=refreshDeploymentPlan(meta,appDir(APPS_DIR,meta.id)).selected;
    const url=req.body.url ? localAccess.validPublicUrl(String(req.body.url).trim()) : null;
    if(!local)localAccess.validateTarget(url,meta,db_.apps);
    meta.publicUrl=local?null:url;
    meta.accessMode=local||!url?'local':'public';
    if(req.body.scheme&& !['http','https'].includes(req.body.scheme))return res.status(400).json({error:'invalid local scheme'});
    if(req.body.scheme)meta.localScheme=req.body.scheme;
    if(selected&&selected.kind==='compose'&&meta.accessMode==='local')meta.localUrl=localAccess.address(meta,path.join(appDir(APPS_DIR,meta.id),'code'),selected);
    save(db_);
    await markDirty(meta.id, 'site address saved');
    const dir=appDir(APPS_DIR,meta.id);
    const plan=refreshDeploymentPlan(meta,dir);
    let provisioningError=null;
    if(plan.selected&&plan.selected.kind==='compose') try {
      const containers=await repositoryCompose.inspectProject({id:meta.id,docker:DOCKER_BIN,run:runOut});
      const volumes=String(await runOut(DOCKER_BIN,['volume','ls','-q','--filter','label=com.docker.compose.project='+meta.id])).trim().split(/\s+/).filter(Boolean);
      const result=composeInputs.provision({dir,root:path.join(dir,'code'),selection:plan.selected,meta,containers,volumes,replaceOrigins:local});
      syncProvisionedDomain(meta,dir,result);
      if(result.issues.length)provisioningError=result.issues.map(i=>i.message).join(' ');
      refreshDeploymentPlan(meta,dir);
    }catch(e){provisioningError=panelLog.redact(e.message);}
    res.json({ ok: true, saved: true, publicUrl: meta.publicUrl, localUrl:meta.localUrl || null,accessMode:meta.accessMode,...(provisioningError?{provisioningError}:{}) });
    });
  } catch (e) { res.status(e.status||400).json({ error: e.message }); }
});

app.post('/api/apps/:id/compose-inputs', async (req,res)=>{
  try {
    await siteLifecycle(req.params.id,async()=>{
    const meta=load().apps.find(a=>a.id===req.params.id);
    if(!meta)return res.status(404).json({error:'unknown app'});
    const dir=appDir(APPS_DIR,meta.id),root=path.join(dir,'code');
    const plan=refreshDeploymentPlan(meta,dir,root);
    if(!plan.selected||plan.selected.kind!=='compose')return res.json({ok:true,plan,changed:[]});
    if(localAccess.isLocal(meta)){meta.accessMode='local';meta.localUrl=localAccess.address(meta,root,plan.selected);const state=load(),stored=state.apps.find(a=>a.id===meta.id);if(stored){Object.assign(stored,{accessMode:'local',localUrl:meta.localUrl});save(state);}}
    const containers=await repositoryCompose.inspectProject({id:meta.id,docker:DOCKER_BIN,run:runOut});
    const volumes=String(await runOut(DOCKER_BIN,['volume','ls','-q','--filter','label=com.docker.compose.project='+meta.id])).trim().split(/\s+/).filter(Boolean);
    const result=composeInputs.provision({dir,root,selection:plan.selected,meta,containers,volumes});
    syncProvisionedDomain(meta,dir,result);
    if(result.changed.length)await markDirty(meta.id,'repository database inputs initialized');
    res.json({ok:true,...result,plan:refreshDeploymentPlan(meta,dir,root)});
    });
  }catch(e){res.status(e.status||500).json({error:panelLog.redact(e.message)});}
});

app.get('/api/apps/:id/local-ca',(req,res)=>{
  if(!load().apps.some(a=>a.id===req.params.id))return res.status(404).end();
  const file=path.join(appDir(APPS_DIR,req.params.id),'.local-tls','ca.crt');
  if(!fs.existsSync(file))return res.status(404).end();
  res.set('Cache-Control','no-store').download(file,'minipass-local-ca.crt',{dotfiles:'allow'},e=>{if(e&&!res.headersSent)res.status(e.status||404).end();});
});

app.get('/api/apps/:id/services', (req, res) => {
  const meta = load().apps.find(a => a.id === req.params.id);
  if (!meta) return res.status(404).json({ error: 'unknown app' });
  const dir = appDir(APPS_DIR, meta.id);
  const buildProfiles = {};
  for (const s of svc.fullServices(meta, dir)) {
    try { buildProfiles[s.name] = { ...localBuildProfile(path.join(dir, 'code', s.subdir || ''), TEMPLATES_DIR), modernize: !!((s.buildOptions || (s.name === 'app' && meta.buildOptions) || {}).modernize) }; }
    catch (e) { buildProfiles[s.name] = { kind: null, warnings: [e.message] }; }
  }
  let repositoryOwned = meta.executor === 'repository-compose';
  try { const p = JSON.parse(fs.readFileSync(path.join(dir, '.deployment-plan.json'), 'utf8')); repositoryOwned = repositoryOwned || p.selected && p.selected.kind === 'compose'; } catch {}
  res.json({ services: publicServices(meta, dir), repositoryServices: meta.repositoryServices || [], repositoryOwned: !!repositoryOwned, buildProfiles, dirty: meta.dirty || null, homePath: pubApp(meta).homePath, homePathManual: !!meta.homePathManual });
});

app.post('/api/apps/:id/services/:name/dockerfile', async (req, res) => {
  try {
    if (deployQueues.has(req.params.id) || deployLocks.has(req.params.id)) return res.status(409).json({ error: 'wait for the current deployment to finish' });
    const db_ = load();
    const meta = db_.apps.find(a => a.id === req.params.id);
    if (!meta) return res.status(404).json({ error: 'unknown app' });
    const dir = appDir(APPS_DIR, meta.id);
    const services = svc.fullServices(meta, dir);
    const service = services.find(s => s.name === req.params.name);
    if (!service) return res.status(404).json({ error: 'unknown service' });
    const ctxDir = path.join(dir, 'code', service.subdir || '');
    const raw = req.body && req.body.dockerfile != null ? String(req.body.dockerfile) : '';
    if (!raw || raw === 'Dockerfile') {
      delete service.dockerfile;
    } else {
      let r;
      try { r = resolveServiceDockerfile(ctxDir, raw, service.type, TEMPLATES_DIR); }
      catch (e) { return res.status(400).json({ error: e.message, dockerfiles: findDockerfiles(ctxDir) }); }
      service.dockerfile = r.file;
    }
    meta.services = services;
    svc.renderProject({ dir, templatesDir: TEMPLATES_DIR, meta });
    save(db_);
    await markDirty(meta.id, 'service ' + service.name + ' build file set');
    res.json({ ok: true, saved: true, pending: true, dockerfile: service.dockerfile || 'Dockerfile' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/apps/:id/services/:name/build-profile', async (req, res) => {
  try {
    if (deployQueues.has(req.params.id) || deployLocks.has(req.params.id)) return res.status(409).json({ error: 'wait for the current deployment to finish' });
    const db_ = load();
    const meta = db_.apps.find(a => a.id === req.params.id);
    if (!meta) return res.status(404).json({ error: 'unknown app' });
    const dir = appDir(APPS_DIR, meta.id);
    const services = svc.fullServices(meta, dir);
    const service = services.find(s => s.name === req.params.name);
    if (!service) return res.status(404).json({ error: 'unknown service' });
    const ctx = path.join(dir, 'code', service.subdir || '');
    const profile = localBuildProfile(ctx, TEMPLATES_DIR);
    if (profile.kind !== 'jekyll') return res.status(400).json({ error: 'no Jekyll build detected in this service folder' });
    if (profile.customDockerfile) return res.status(409).json({ error: 'custom Dockerfile preserved - configure the Jekyll build in that file instead' });
    if (profile.blockedReason) return res.status(400).json({ error: profile.blockedReason });
    const modernize = req.body.modernize === true;
    if (profile.needsModernization && !modernize) return res.status(409).json({ error: 'enable build-only modernization for these legacy dependencies' });
    ensureDockerfile(ctx, 'static', TEMPLATES_DIR, { modernize });
    service.type = 'static'; service.port = 80; service.homePath = ''; service.openPaths = []; service.homePathManual = false;
    service.buildOptions = { modernize };
    meta.services = services;
    if (service.name === 'app') {
      meta.type = 'static'; meta.buildOptions = { modernize }; meta.homePath = ''; meta.homePathManual = false; meta.openPaths = [];
      envSetManaged(dir, { APP_TYPE: 'static', PORT: '80' });
    }
    svc.renderProject({ dir, templatesDir: TEMPLATES_DIR, meta });
    save(db_);
    await markDirty(meta.id, 'Jekyll static build configured');
    res.json({ ok: true, saved: true, pending: true, type: 'static', modernize });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/apps/:id/services/check', (req, res) => {
  const meta = load().apps.find(a => a.id === req.params.id);
  if (!meta) return res.status(404).json({ error: 'unknown app' });
  const check = serviceCandidate(meta, appDir(APPS_DIR, meta.id), req.query, true);
  if (check.error) return res.status(400).json({ ok: false, error: check.error, dockerfiles: check.dockerfiles || [] });
  const profile = localBuildProfile(check.ctxDir, TEMPLATES_DIR);
  if (profile.blockedReason && !profile.customDockerfile) return res.status(400).json({ ok: false, error: profile.blockedReason });
  res.json({
    ok: true,
    name: check.name,
    subdir: check.subdir,
    type: check.type,
    detected: check.detected.detected,
    reason: check.detected.reason,
    needsDockerfile: needsDockerfileOptIn(check.ctxDir, check.type),
    dockerfiles: check.dockerfiles || [],
    dockerfile: check.dockerfile || 'Dockerfile',
    buildProfile: profile
  });
});

app.post('/api/apps/:id/services/dockerfile', async (req, res) => {
  try {
    const db_ = load();
    const meta = db_.apps.find(a => a.id === req.params.id);
    if (!meta) return res.status(404).json({ error: 'unknown app' });
    const type = String((req.body && req.body.type) || '').trim();
    if (!STANDARD_DOCKER_TYPES.includes(type)) return res.status(400).json({ error: 'choose node, react, php, or static' });
    const rawSub = String((req.body && req.body.subdir) || '').trim().replace(/\\/g, '/');
    const subdir = rawSub.replace(/^\/+|\/+$/g, '');
    if (subdir && (subdir.split('/').includes('..') || !/^[A-Za-z0-9._/-]+$/.test(subdir))) return res.status(400).json({ error: 'bad subfolder' });
    const dir = appDir(APPS_DIR, meta.id);
    const ctxDir = path.resolve(dir, 'code', subdir);
    const codeRoot = path.resolve(dir, 'code');
    if (ctxDir !== codeRoot && !ctxDir.startsWith(codeRoot + path.sep)) return res.status(400).json({ error: 'subfolder must stay inside the repository' });
    try { if (!fs.statSync(ctxDir).isDirectory()) return res.status(400).json({ error: 'subfolder is not a directory in the repository' }); }
    catch { return res.status(400).json({ error: 'subfolder does not exist in the repository' }); }
    try {
      const have = findDockerfiles(ctxDir);
      if (have.length)
        return res.status(409).json({ error: `a Dockerfile is already there (${have.join(', ')}) - edit it instead` });
    } catch (e) { return res.status(500).json({ error: e.message }); }
    const tpl = path.join(TEMPLATES_DIR, type, 'Dockerfile');
    try {
      if (type === 'static' && readBuildProfile(ctxDir).kind === 'jekyll') ensureDockerfile(ctxDir, type, TEMPLATES_DIR, { modernize: req.body.modernizeBuild === true });
      else fs.copyFileSync(tpl, path.join(ctxDir, 'Dockerfile'));
    }
    catch (e) { return res.status(500).json({ error: 'standard template missing: ' + e.message }); }
    const seeded = ['Dockerfile'];
    if ((type === 'react' || type === 'static') && !fs.existsSync(path.join(ctxDir, 'nginx.conf'))) {
      try {
        fs.copyFileSync(path.join(TEMPLATES_DIR, type, 'nginx.conf'), path.join(ctxDir, 'nginx.conf'));
        seeded.push('nginx.conf');
      } catch {}
    }
    await markDirty(meta.id, 'standard Dockerfile added to ' + (subdir || 'root'));
    res.json({ ok: true, seeded, note: 'box-local file - commit it to the repo so fresh clones and rebuilds keep it' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/apps/:id/services', async (req, res) => {
  try {
    const db_ = load();
    const meta = db_.apps.find(a => a.id === req.params.id);
    if (!meta) return res.status(404).json({ error: 'unknown app' });
    const dir = appDir(APPS_DIR, meta.id);
    const candidate = serviceCandidate(meta, dir, req.body);
    if (candidate.error) return res.status(400).json({ error: candidate.error, dockerfiles: candidate.dockerfiles || [] });
    const { name, requestedType, subdir, detected, type, services } = candidate;
    const { inferPort, TYPE_PORT } = require('../lib/generator');
    const profile = localBuildProfile(path.join(dir, 'code', subdir), TEMPLATES_DIR);
    if (profile.blockedReason && !profile.customDockerfile) return res.status(400).json({ error: profile.blockedReason });
    if (profile.needsModernization && req.body.modernizeBuild !== true) return res.status(409).json({ error: 'enable build-only modernization for this service' });
    const port = type === 'static' && profile.kind === 'jekyll' && !profile.customDockerfile
      ? 80 : inferPort(path.join(dir, 'code', subdir), TYPE_PORT[type] || 3000, candidate.dockerfile || undefined);
    const used = hostPortsInUse();
    let hostPort = 8000;
    while (used.has(hostPort) && hostPort < 9000) hostPort++;
    used.add(hostPort);
    meta.services = [...services, { name, subdir, type, port, hostPort, enabled: true, buildOptions: { modernize: req.body.modernizeBuild === true }, ...(candidate.dockerSource === 'selected' ? { dockerfile: candidate.dockerfile } : {}) }];
    const out = svc.renderProject({ dir, templatesDir: TEMPLATES_DIR, meta });
    meta.services = out.normalized;
    // A new service contributes its .env/.env.example exactly once. This also
    // resolves frontend/API localhost placeholders now that its role is known.
    try { applyEnvDefaults(meta, dir, req.hostname, req.protocol); }
    catch (e) { console.error(meta.id, 'env defaults snapshot:', e.message); }
    save(db_);
    await markDirty(meta.id, 'service ' + name + ' added');
    const correctedFrom = requestedType !== 'auto' && requestedType !== type ? requestedType : null;
    if (!(req.body && req.body.apply === true)) return res.json({ ok: true, added: name, type, correctedFrom, detected: detected.detected, pending: true });
    try { await deploy(meta.id); } catch (e) { return res.json({ ok: true, added: name, redeployError: e.message }); }
    res.json({ ok: true, added: name, type, correctedFrom, detected: detected.detected, redeployed: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/apps/:id/services/:name', async (req, res) => {
  try {
    const db_ = load();
    const meta = db_.apps.find(a => a.id === req.params.id);
    if (!meta) return res.status(404).json({ error: 'unknown app' });
    const dir = appDir(APPS_DIR, meta.id);
    if (req.params.name === 'app') return res.status(400).json({ error: 'primary service cannot be removed - delete the app instead' });
    let services = svc.fullServices(meta, dir);
    if (services.length <= 1) return res.status(400).json({ error: 'cannot remove the last service' });
    if (!services.some(s => s.name === req.params.name)) return res.status(404).json({ error: 'unknown service' });
    meta.services = services.filter(s => s.name !== req.params.name);
    svc.renderProject({ dir, templatesDir: TEMPLATES_DIR, meta });
    envDeleteKeys(dir, [svc.portEnvName(req.params.name)]);
    save(db_);
    await markDirty(meta.id, 'service ' + req.params.name + ' removed');
    if (!(req.body && req.body.apply === true)) return res.json({ ok: true, removed: true, pending: true });
    try { await deploy(meta.id); } catch (e) { return res.json({ ok: true, removed: true, redeployError: e.message }); }
    res.json({ ok: true, removed: true, redeployed: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/apps/:id/services/:name/enable', async (req, res) => {
  try {
    const db_ = load();
    const meta = db_.apps.find(a => a.id === req.params.id);
    if (!meta) return res.status(404).json({ error: 'unknown app' });
    const dir = appDir(APPS_DIR, meta.id);
    const services = svc.fullServices(meta, dir);
    const target = services.find(s => s.name === req.params.name);
    if (!target) return res.status(404).json({ error: 'unknown service' });
    target.enabled = !(req.body && req.body.enabled === false);
    meta.services = services;
    try {
      svc.renderProject({ dir, templatesDir: TEMPLATES_DIR, meta });
    } catch (e) { return res.status(400).json({ error: e.message }); }
    save(db_);
    await markDirty(meta.id, 'service ' + target.name + (target.enabled ? ' enabled' : ' disabled'));
    if (!(req.body && req.body.apply === true)) return res.json({ ok: true, enabled: target.enabled, pending: true });
    try { await deploy(meta.id); } catch (e) { return res.json({ ok: true, redeployError: e.message }); }
    res.json({ ok: true, enabled: target.enabled, redeployed: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/apps/:id/api-backend', async (req, res) => {
  try {
    const db_ = load();
    const meta = db_.apps.find(a => a.id === req.params.id);
    if (!meta) return res.status(404).json({ error: 'unknown app' });
    const dir = appDir(APPS_DIR, meta.id);
    if (!['static', 'react'].includes(meta.type) && !(svc.fullServices(meta, dir).some(s => (s.type === 'static' || s.type === 'react') && s.enabled !== false))) {
      return res.status(400).json({ error: 'api link needs a static/react frontend service on this site' });
    }
    const frontName = (req.body && req.body.service) || null;
    const all = svc.fullServices(meta, dir);
    const front = frontName
      ? all.find(s => s.name === frontName && (s.type === 'static' || s.type === 'react') && s.enabled !== false)
      : all.find(s => (s.type === 'static' || s.type === 'react') && s.enabled !== false);
    if (!front) return res.status(400).json({ error: 'no enabled static/react service to link from' });
    const ctxDir = path.join(dir, 'code', front.subdir || '');
    const ymlPath = path.join(dir, 'docker-compose.yml');
    if (!fs.existsSync(ymlPath)) return res.status(400).json({ error: 'app has no compose file' });
    const target = (req.body && req.body.target) || null;
    let yml = fs.readFileSync(ymlPath, 'utf8');
    if (!target) {
      envDeleteKeys(dir, ['API_HOST', 'API_PORT']);
      fs.writeFileSync(path.join(ctxDir, 'nginx.conf'), nginxConf(null));
      // global: old buggy links may have stamped several services
      yml = yml.replace(/\n    extra_hosts:\n      - "host\.docker\.internal:host-gateway"\n/g, '\n');
      fs.writeFileSync(ymlPath, yml);
      meta.apiBackend = null;
      meta.apiLinkOff = true;
      save(db_);
      await markDirty(meta.id, 'api link removed');
      if (!(req.body && req.body.apply === true)) return res.json({ ok: true, unlinked: true, pending: true });
      try { await deploy(meta.id); } catch (e) { return res.json({ ok: true, unlinked: true, redeployError: e.message }); }
      return res.json({ ok: true, unlinked: true, redeployed: true });
    }
    // sibling service (same site, same private network) vs other site (via host gateway)
    let proxy, label;
    if (String(target).startsWith('svc:')) {
      const sname = target.slice(4);
      const list = svc.fullServices(meta, dir);
      const s = list.find(x => x.name === sname && x.enabled !== false);
      if (!s) return res.status(404).json({ error: 'unknown sibling service' });
      if (s.name === front.name) return res.status(400).json({ error: 'cannot link a service to itself' });
      proxy = { host: s.name, port: parseInt(s.port, 10) || 3000 };
      label = s.name;
    } else {
      const t = db_.apps.find(a => a.id === target);
      if (!t) return res.status(404).json({ error: 'unknown target app' });
      if (t.id === meta.id) return res.status(400).json({ error: 'cannot link an app to itself' });
      if (!t.allowBackend) return res.status(400).json({ error: `${t.id} has not opted in as an API backend` });
      if (!t.hostPort) return res.status(400).json({ error: 'target has no published port' });
      proxy = { host: 'host.docker.internal', port: t.hostPort };
      label = t.id;
      // splice extra_hosts into the FRONTEND's own block (first env_file in the
      // file may belong to another service); skip when already present there
      const ymlLines = yml.split('\n');
      let inFront = false;
      for (let i = 0; i < ymlLines.length; i++) {
        if (/^  [A-Za-z0-9_-]+:\s*$/.test(ymlLines[i])) inFront = ymlLines[i].trim().replace(/:$/, '') === front.name;
        else if (/^[^ ]/.test(ymlLines[i])) inFront = false;
        if (!inFront) continue;
        if (/^\s*extra_hosts:/.test(ymlLines[i])) break;
        if (/^    env_file: \.env$/.test(ymlLines[i])) {
          ymlLines.splice(i + 1, 0, '    extra_hosts:', '      - "host.docker.internal:host-gateway"');
          break;
        }
      }
      yml = ymlLines.join('\n');
      fs.writeFileSync(ymlPath, yml);
    }
    // the link IS these two env vars - the conf below renders from them
    envSetManaged(dir, { API_HOST: proxy.host, API_PORT: String(proxy.port) });
    fs.writeFileSync(path.join(ctxDir, 'nginx.conf'), nginxConf(proxy));
    meta.apiBackend = { app: label, port: proxy.port, service: front.name };
    delete meta.apiLinkOff;
    save(db_);
    await markDirty(meta.id, 'api link changed');
    if (!(req.body && req.body.apply === true)) return res.json({ ok: true, linked: label, pending: true });
    try { await deploy(meta.id); } catch (e) { return res.json({ ok: true, linked: label, redeployError: e.message }); }
    res.json({ ok: true, linked: label, redeployed: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
};
