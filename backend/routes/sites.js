// sites: extracted from the original backend without changing route semantics.
module.exports = function register(ctx) {
  const { APPS_DIR, COMPOSE_BIN, TEMPLATES_DIR, app, appDir, appPubKey, composeInputs, createApp, creatingSites, crypto, dockerfileProtection, fs, gh, importProtection, lifecycleLocks, localAccess, missingEnvVars, normDbs, panelLog, path, quotas, redactUrl, remediate, siteIdentity, svc, trashLib } = ctx;
  const applyEnvDefaults = (...args) => ctx.applyEnvDefaults(...args);
  const attachDatabase = (...args) => ctx.attachDatabase(...args);
  const cleanDomain = (...args) => ctx.cleanDomain(...args);
  const configureDetectedServices = (...args) => ctx.configureDetectedServices(...args);
  const detectRepo = (...args) => ctx.detectRepo(...args);
  const deploy = (...args) => ctx.deploy(...args);
  const ensureDatabaseAliases = (...args) => ctx.ensureDatabaseAliases(...args);
  const envSetManaged = (...args) => ctx.envSetManaged(...args);
  const lifecycleError = (...args) => ctx.lifecycleError(...args);
  const load = (...args) => ctx.load(...args);
  const markDirty = (...args) => ctx.markDirty(...args);
  const pubApp = (...args) => ctx.pubApp(...args);
  const publicServices = (...args) => ctx.publicServices(...args);
  const refreshDeploymentPlan = (...args) => ctx.refreshDeploymentPlan(...args);
  const remediationContext = (...args) => ctx.remediationContext(...args);
  const remediationSuggestions = (...args) => ctx.remediationSuggestions(...args);
  const repositoryDatabases = (...args) => ctx.repositoryDatabases(...args);
  const requiredDatabases = (...args) => ctx.requiredDatabases(...args);
  const save = (...args) => ctx.save(...args);
  const sh = (...args) => ctx.sh(...args);
  const siteLifecycle = (...args) => ctx.siteLifecycle(...args);
  const syncProvisionedDomain = (...args) => ctx.syncProvisionedDomain(...args);
app.get('/health', (req, res) => res.send('ok'));

app.get('/api/apps/:id/repokey', (req, res) => {
  const k = appPubKey(appDir(APPS_DIR, req.params.id));
  if (!k) return res.status(500).json({ error: 'no repo key (ssh-keygen unavailable?)' });
  res.json({ pubkey: k });
});

app.get('/api/types', (req, res) => {
  res.json([
    { id: 'static', label: 'Static HTML' },
    { id: 'react', label: 'React (build + serve)' },
    { id: 'node', label: 'Node.js' },
    { id: 'php', label: 'PHP + Apache' }
  ]);
});

app.get('/api/apps', (req, res) => res.json(load().apps.map(meta => ({
  ...pubApp(meta),
  services: publicServices(meta, appDir(APPS_DIR, meta.id))
}))));

app.post('/api/apps', async (req, res) => {
  let creatingId = null;
  try {
    const { name, type, repoUrl, db, port, domain } = req.body;
    if (typeof name !== 'string' || !name.trim()) return res.status(400).json({ error: 'Site name is required.', field: 'name' });
    if (!type) return res.status(400).json({ error: 'application type required' });
    if (!['static', 'react', 'node', 'php'].includes(type)) return res.status(400).json({ error: 'unsupported application type' });
    const rawName = siteIdentity.displayName(name);
    const id = req.body.pendingId || siteIdentity.allocate(APPS_DIR, load(), new Set([...creatingSites, ...lifecycleLocks]));
    if (lifecycleLocks.has(id) || creatingSites.has(id) || [...load().apps, ...(load().trash || [])].some(a => a.id === id)) return res.status(409).json({ error: 'site identity is already registered or busy' });
    const draft = req.body.pendingId ? siteIdentity.pending(APPS_DIR, id) : null;
    const storageBytes = quotas.limitBytes(req.body.storageGB ?? 5);
    creatingId = id;
    creatingSites.add(id);
    let appDomain;
    try { appDomain = cleanDomain(domain); }
    catch (e) { return res.status(400).json({ error: e.message }); }
    const accessMode=req.body.access===undefined?(appDomain?'public':'local'):req.body.access==='local'?'local':req.body.access==='domain'?'public':null;
    if(!accessMode)return res.status(400).json({error:'invalid access choice',field:'access'});
    if(accessMode==='public'&&!appDomain&&req.body.prepareOnly!==true)return res.status(400).json({error:'Enter a domain or select Local / LAN.',field:'domain'});
    if(accessMode==='local')appDomain='';
    const token = crypto.randomBytes(16).toString('hex');
    // localhost: auto-assign host port 8000+ so app is reachable without a domain
    const existing = load().apps;
    const used = new Set(existing.map(a => a.hostPort).filter(Boolean));
    let hostPort = parseInt(req.body.hostPort, 10) || 8000;
    while (used.has(hostPort) && hostPort < 9000) hostPort++;
    // site-owned git connection: fresh token per build, validated BEFORE anything
    // is created, stored on the site only - never the shared pool.
    let finalRepoUrl = repoUrl || '';
    let siteToken = String(req.body.gitToken || '').trim() || null;
    let explicitBranch = String(req.body.branch || '').trim() || null;
    if (explicitBranch && !/^[A-Za-z0-9._\/-]+$/.test(explicitBranch)) {
      return res.status(400).json({ error: `bad branch name '${explicitBranch}'` });
    }
    let ghLink = null;
    const ghRepo = req.body.ghRepo;
    if (ghRepo && ghRepo.repo) {
      const parts = String(ghRepo.repo).split('/');
      if (parts.length !== 2 || !parts[0] || !parts[1]) return res.status(400).json({ error: 'repo must be owner/name' });
      if (!siteToken) {
        // public repo: verify unauthenticated, clone token-free. No auto-webhook
        // without a token - polling/manual redeploy stays available.
        const info = await gh.apiPublic(`/repos/${parts[0]}/${parts[1]}`)
          .catch(() => { throw new Error('repo is not public - paste a site token for private repos'); });
        finalRepoUrl = info.clone_url;
        ghLink = { repo: info.full_name, branch: explicitBranch || info.default_branch, login: null, sha: null, pollMinutes: 0, enabled: false, token: null };
      } else {
        const me = await gh.apiWith(siteToken, '/user')
          .catch(() => { throw new Error('site token rejected by github - regenerate and repaste'); });
        const info = await gh.apiWith(siteToken, `/repos/${parts[0]}/${parts[1]}`)
          .catch(() => { throw new Error('token cannot read ' + ghRepo.repo + ' - check repo access on the token'); });
        let head = null;
        try {
          const br = explicitBranch || info.default_branch;
          const c = await gh.apiWith(siteToken, `/repos/${parts[0]}/${parts[1]}/commits/${encodeURIComponent(br)}`);
          head = c && c.sha;
        } catch {}
        finalRepoUrl = info.clone_url;
        ghLink = { repo: info.full_name, branch: explicitBranch || info.default_branch, login: me.login, sha: head, pollMinutes: 0, enabled: false, token: siteToken };
      }
    } else if (finalRepoUrl) {
      const m = finalRepoUrl.match(/github\.com[:/]([^/]+)\/([^/]+?)(\.git)?\/?$/i);
      if (m && siteToken) ghLink = { repo: `${m[1]}/${m[2]}`, branch: explicitBranch, login: null, sha: null, pollMinutes: 0, enabled: false, token: siteToken };
      else if (m && !siteToken) {
        // pasted public URL: link it token-free after a public readability check,
        // so pull/poll work unauthenticated and the webhook stays manual.
        const pub = await gh.apiPublic(`/repos/${m[1]}/${m[2]}`).catch(() => null);
        if (pub) ghLink = { repo: pub.full_name, branch: explicitBranch || pub.default_branch, login: null, sha: null, pollMinutes: 0, enabled: false, token: null };
      }
      else siteToken = null;
    }
    const dbs = normDbs(req.body.dbs !== undefined ? req.body.dbs : db);
    const packageManager = ['npm', 'pnpm', 'yarn', 'bun'].includes(req.body.packageManager) ? req.body.packageManager : 'npm';
    const subdir = String(req.body.subdir || '').replace(/^\/+|\/+$/g, '').replace(/\.\./g, '') || '';
    if (draft && (draft.repoUrl !== finalRepoUrl || draft.branch !== explicitBranch || draft.subdir !== subdir)) throw lifecycleError('pending checkout uses a different source - cancel and reopen before changing repositories, branches or folders');
    let entrypoint=req.body.deploymentEntrypoint || null;
    if(entrypoint&&(!['compose','dockerfile'].includes(entrypoint.kind)||typeof entrypoint.file!=='string'))return res.status(400).json({error:'invalid deployment file choice'});
    if(finalRepoUrl||req.body.prepareOnly===true||entrypoint) {
      const pendingDir=siteIdentity.stage(APPS_DIR,id);fs.mkdirSync(pendingDir,{recursive:true});
      fs.writeFileSync(path.join(pendingDir,'.pending-create.json'),JSON.stringify({id,repoUrl:finalRepoUrl,branch:explicitBranch,subdir}),{mode:0o600});
      const prepared=createApp({appsDir:path.dirname(pendingDir),templatesDir:TEMPLATES_DIR,name:id,type,repoUrl:finalRepoUrl,db:dbs,domain:appDomain,hostPort,gitToken:siteToken,subdir,gitBranch:explicitBranch,prepareOnly:true,selection:entrypoint});
      const plan=prepared.plan;
      let repositoryDatabases=[];try{if(plan.selected?.kind==='compose')repositoryDatabases=composeInputs.declaredDatabases(path.join(prepared.dir,'code'),plan.selected);}catch{}
      if(req.body.prepareOnly===true) return res.json({ok:true,prepared:true,pendingId:id,plan,repositoryDatabases});
      entrypoint=plan.selected;
    }
    // Every new site must receive an enforced allowance. Never silently turn
    // the agreed quota/capacity requirement into an optional or fake limit.
    const reserved = await quotas.reserve(id, storageBytes);
    if (!reserved.enforced || !reserved.projectId) throw Object.assign(new Error('Host did not confirm quota enforcement. Repair host storage setup before creating a site.'), { status: 503 });
    const storageQuota = { projectId: reserved.projectId, limitBytes: storageBytes, enforced: true };
    siteIdentity.copyDraft(APPS_DIR,id);
    const pendingDir = appDir(APPS_DIR, id);
    fs.mkdirSync(pendingDir, { recursive: true });
    fs.writeFileSync(path.join(pendingDir, '.pending-create.json'), JSON.stringify({ id, repoUrl: finalRepoUrl, branch: explicitBranch, subdir }), { mode: 0o600 });
    const created = createApp({ appsDir: APPS_DIR, templatesDir: TEMPLATES_DIR, name: id, type, repoUrl: finalRepoUrl, db: dbs, port, domain: appDomain, hostPort, gitToken: siteToken, subdir, gitBranch: explicitBranch, standardDockerfile: req.body.standardDockerfile === true, modernizeBuild: req.body.modernizeBuild === true,selection:entrypoint });
    siteIdentity.writeName(created.dir, id, rawName);
    if (storageQuota) {
      fs.writeFileSync(path.join(created.dir, '.storage-quota.json'), JSON.stringify({ projectId: storageQuota.projectId, limitBytes: storageBytes }), { mode: 0o600 });
      quotas.bindDatabases(created.dir);
    }
    envSetManaged(created.dir, { COMPOSE_PROJECT_NAME: id });
    const db_ = load();
    const meta = { id, name: rawName, type: created.type || type, repoUrl: finalRepoUrl, github: ghLink, db: created.hasDeclaredCompose ? [] : dbs, domain: appDomain, accessMode, deploymentEntrypoint:entrypoint,token, hostPort, accessHost: req.hostname, packageManager, subdir: created.subdir || '', storageQuota, buildOptions: { modernize: req.body.modernizeBuild === true }, createdAt: new Date().toISOString() };
    if(entrypoint&&entrypoint.kind==='compose')meta.repositoryDatabases=composeInputs.declaredDatabases(path.join(created.dir,'code'),entrypoint);
    let detectedServices = [];
    try { if (!created.hasDeclaredCompose) detectedServices = configureDetectedServices(meta, created.dir, { discoverSiblings: !subdir }); }
    catch (e) { console.error(id, 'auto service detection:', e.message); }
    // Capture repository env sources before the first deploy. Never fail an
    // otherwise valid create solely because the private snapshot could not be written.
    try { if (!created.hasDeclaredCompose) applyEnvDefaults(meta, created.dir, req.hostname, req.protocol); }
    catch (e) { console.error(id, 'env defaults snapshot:', e.message); }
    db_.apps = db_.apps.filter(a => a.id !== id).concat([meta]);
    save(db_);
    siteIdentity.removeDraft(APPS_DIR,id);
    try {
      const autoDbs = [];
      for (const need of created.hasDeclaredCompose ? [] : requiredDatabases(meta, path.join(created.dir, 'code'))) {
        if (!normDbs(meta.db).includes(need)) {
          const r = attachDatabase(meta, need);
          if (r.attached) autoDbs.push(need);
        }
      }
      const healed = ensureDatabaseAliases(meta);
      if (autoDbs.length || healed.length) {
        svc.renderProject({ dir: created.dir, templatesDir: TEMPLATES_DIR, meta });
        panelLog.logEvent({ level: 'info', area: 'create', site: id, message: `database wiring detected: ${autoDbs.join(', ') || 'aliases'}` });
      }
    } catch (e) { console.error(id, 'auto database detection:', e.message); }
    try { fs.unlinkSync(path.join(created.dir, '.pending-create.json')); } catch {}
    // Source linking and automatic deployment are separate choices. The first
    // build is manual and automation stays off until explicitly enabled.
    const webhookNote = ghLink ? 'github linked - automation disabled' : 'no github automation';
    if (detectedServices.length) panelLog.logEvent({ level: 'info', area: 'create', site: id, message: 'services detected: ' + detectedServices.join(', ') });
    // Creation-time env report: code-referenced vars missing from the generated
    // .env, so the operator knows before the first deploy instead of via a
    // crash loop. Read-only, capped, never fails the create.
    let envNeeds = [];
    try { envNeeds = missingEnvVars(created.dir).unset.slice(0, 12); } catch {}
    if (envNeeds.length) panelLog.logEvent({ level: 'warn', area: 'create', site: id, message: `Source references unset variables (${envNeeds.join(', ')}). Set required values in Environment; external credentials are not invented.` });
    if(created.hasDeclaredCompose) try {
      const selected=refreshDeploymentPlan(meta,created.dir).selected;
      if(selected&&selected.kind==='compose') {
        if(localAccess.isLocal(meta)){meta.accessMode='local';meta.localUrl=localAccess.address(meta,path.join(created.dir,'code'),selected);const state=load(),stored=state.apps.find(a=>a.id===id);if(stored){Object.assign(stored,{accessMode:meta.accessMode,localUrl:meta.localUrl});save(state);}}
        const inputs=composeInputs.provision({dir:created.dir,root:path.join(created.dir,'code'),selection:selected,meta,fresh:true});
        syncProvisionedDomain(meta,created.dir,inputs);
        if(inputs.changed.length)panelLog.logEvent({level:'info',area:'create',site:id,message:'Repository database inputs prepared: '+inputs.changed.join(', ')});
      }
    }catch(e){panelLog.logEvent({level:'warn',area:'create',site:id,message:'Repository input initialization needs review: '+e.message});}
    const plan = refreshDeploymentPlan(meta, created.dir);
    panelLog.logEvent({ level: 'info', area: 'create', site: id, message: 'Site created with its enforced storage allowance and repository configuration.' });
    // Initial launch is the normal Create workflow, independent of later
    // GitHub/push automation. Return promptly; progress and failures persist in
    // site events, build output and deployment history. Explicit save-only API
    // fixtures/imports may use launch:false; the create UI never sends it.
    const launching = req.body.launch !== false;
    if (launching) deploy(id, { source: 'create', skipSync: true, originHost: req.hostname })
      .catch(e => console.error(id, 'initial launch failed:', redactUrl(e.message)));
    res.json({ ...pubApp(meta), plan, deploying: launching, localUrl: meta.localUrl || `http://localhost:${hostPort}`, webhook: `/webhook/${id}?token=${token}`, webhookNote, storageEnforced: true, ...(envNeeds.length ? { envNeeds } : {}) });
  } catch (e) {
    const error = redactUrl(e.message);
    try { panelLog.logEvent({ level: 'error', area: 'create', site: creatingId, message: error }); } catch {}
    const needsDockerfile = /no Dockerfile in build context and type/i.test(error);
    const needsModernization = /Jekyll static build needs modernization/i.test(error);
    let pendingId=null;try{if(creatingId){siteIdentity.pending(APPS_DIR,creatingId);pendingId=creatingId;}}catch{}
    res.status(needsDockerfile || needsModernization ? 409 : (e.status || 500)).json({ error, needsDockerfile, needsModernization, ...(pendingId ? { pendingId } : {}) });
  } finally {
    if (creatingId) creatingSites.delete(creatingId);
  }
});

app.delete('/api/apps/pending/:id', async (req, res) => {
  try {
    const id = String(req.params.id || '').toLowerCase().replace(/[^a-z0-9-]/g, '-');
    if (!trashLib.validId(id)) return res.status(400).json({ error: 'bad site id' });
    if (creatingSites.has(id)) return res.status(409).json({ error: 'site creation is still in progress' });
    if (load().apps.some(a => a.id === id)) return res.status(409).json({ error: 'site is already registered' });
    const dir = appDir(APPS_DIR, id);
    if (fs.existsSync(path.join(dir, 'docker-compose.yml'))) return res.status(409).json({ error: 'refusing to remove a composed site' });
    const staged=siteIdentity.draftDir(APPS_DIR,id);
    if(fs.existsSync(staged))siteIdentity.sourceOnly(staged,id);
    if(fs.existsSync(dir))siteIdentity.sourceOnly(dir,id);
    const hadFiles = fs.existsSync(dir);
    let charged = fs.existsSync(path.join(dir, '.storage-quota.json'));
    try { await quotas.usage(id); charged = true; }
    catch (e) { if (charged || (e.status !== 404 && e.status !== 503)) throw e; }
    fs.rmSync(dir, { recursive: true, force: true });
    const removedDraft=siteIdentity.removeDraft(APPS_DIR,id);
    // The quota bridge is optional for legacy pending checkouts, but a saved
    // reservation must never silently leak after a successful cancellation.
    if (charged) await quotas.release(id);
    res.json({ ok: true, removed: hadFiles||removedDraft });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/apps/:id/remediate', async (req, res) => {
  try {
    const key = String((req.body && req.body.key) || '');
    if (!remediate.VALID_KEY.test(key)) return res.status(400).json({ error: 'unknown remediation' });
    await siteLifecycle(req.params.id, async () => {
      const meta = load().apps.find(a => a.id === req.params.id);
      if (!meta) throw lifecycleError('unknown app', 404);
      const dir = appDir(APPS_DIR, meta.id);
      // Recompute server-side; the client preview is never trusted.
      const requestedService = String((req.body && req.body.service) || '');
      const matches = remediationSuggestions(meta, dir).filter(s => s.key === key && (!requestedService || s.service === requestedService));
      if (matches.length !== 1) throw lifecycleError('remediation no longer applies or is ambiguous - refresh suggestions', 409);
      const match = matches[0];
      if (match.revision && match.revision !== (req.body && req.body.revision)) throw lifecycleError('Files changed - refresh the recovery preview before applying', 409);
      const ctxDir = remediationContext(dir, match.subdir);
      if (!/^[A-Za-z0-9_-]{1,32}$/.test(match.service || '')) throw lifecycleError('invalid recovery service name', 400);
      const result = match.kind === 'dockerfile-fix'
        ? remediate.apply(ctxDir, match, { backupRoot: path.join(dir, '.remediation-backups', match.service),
          beforeApply: approval => dockerfileProtection.save(dir, match.service, match.subdir, approval) })
        : remediate.apply(ctxDir, match, { backupRoot: path.join(dir, '.remediation-backups', match.service),
          beforeApply: approval => importProtection.save(dir, match.service, match.subdir, approval) });
      if (match.kind === 'import-repair' || match.kind === 'dockerfile-fix') result.protected = true;
      if (result.backup) result.backup = path.relative(dir, result.backup).split(path.sep).join('/');
      if (match.kind === 'import-repair') {
        const fresh = load();
        const stored = fresh.apps.find(a => a.id === meta.id);
        if (!stored) throw lifecycleError('site metadata disappeared after saving the import correction', 409);
        stored.pendingImportBuilds = [...new Set([...(stored.pendingImportBuilds || []), match.service])];
        save(fresh);
      }
      try { panelLog.logEvent({ level: 'warn', area: 'remediate', site: meta.id, message: `applied ${key}: ${result.applied.join(', ')}` }); } catch {}
      await markDirty(meta.id, 'remediation applied: ' + key);
      res.json({ ok: true, saved: true, ...result, note: result.protected ? (match.kind === 'dockerfile-fix' ? 'approved Dockerfile adaptation retained outside Git and revalidated on redeploy; remote repository unchanged' : 'approved import correction retained outside Git and revalidated on redeploy; remote repository unchanged') : 'box-local change - use local rebuild to preserve box edits; commit to the repo to keep it' });
    });
  } catch (e) {
    panelLog.logEvent({ level: 'error', area: 'remediate', site: req.params.id, message: e.message });
    res.status(e.status || 500).json({ error: e.message });
  }
});

app.get('/api/apps/:id/suggest', async (req, res) => {
  try {
    const meta = load().apps.find(a => a.id === req.params.id);
    if (!meta || !meta.repoUrl) return res.status(400).json({ error: 'no repo linked' });
    const m = String(meta.repoUrl).match(/github\.com[:/]([^/]+)\/([^/]+?)(\.git)?\/?$/i);
    if (!m) return res.json({ suggestions: [] });
    const r = await detectRepo(`${m[1]}/${m[2]}`, { login: meta.github && meta.github.login, token: meta.github && meta.github.token, branch: meta.github && meta.github.branch });
    const have = new Set(svc.fullServices(meta, appDir(APPS_DIR, meta.id)).map(s => s.subdir || ''));
    res.json({
      suggestions: (r.frontends || []).filter(f => !have.has(f)),
      staticSuggestions: (r.staticFrontends || []).filter(f => !have.has(f)),
      backends: (r.backends || []).filter(b => !have.has(b))
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/apps/:id/allow-backend', (req, res) => {
  try {
    const db_ = load();
    const meta = db_.apps.find(a => a.id === req.params.id);
    if (!meta) return res.status(404).json({ error: 'unknown app' });
    meta.allowBackend = !(req.body && req.body.allow === false);
    save(db_);
    res.json({ ok: true, allowBackend: !!meta.allowBackend });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/apps/:id/regenerate', (req, res) => {
  try {
    const db_ = load();
    const meta = db_.apps.find(a => a.id === req.params.id);
    if (!meta) return res.status(404).json({ error: 'unknown app' });
    meta.token = crypto.randomBytes(16).toString('hex');
    save(db_);
    res.json({ ok: true, token: meta.token, webhook: `/webhook/${meta.id}?token=${meta.token}` });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/apps/:id/logs', async (req, res) => {
  try {
    // service names go to the shell - strict charset or no logs
    const meta = load().apps.find(a => a.id === req.params.id);
    if (!meta) return res.status(404).json({ error: 'unknown app' });
    const fallback = (svc.fullServices(meta, appDir(APPS_DIR, meta.id))[0] || {}).name || 'app';
    const svcName = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(req.query.service || '') ? req.query.service : fallback;
    const tail = Math.max(10, Math.min(500, parseInt(req.query.tail, 10) || 100));
    const out = await sh(`${COMPOSE_BIN} logs --tail=${tail} ${svcName}`, appDir(APPS_DIR, req.params.id));
    res.type('text/plain').send(out);
  } catch (e) { res.status(500).send(e.message); }
});
};
