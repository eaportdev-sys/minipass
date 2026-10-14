// migrations: extracted from the original backend without changing route semantics.
module.exports = function register(ctx) {
  const { APPS_DIR, MIGRATE_CMD_RE, app, appDir, migrations, path, svc } = ctx;
  const appContainers = (...args) => ctx.appContainers(...args);
  const load = (...args) => ctx.load(...args);
  const migrateDirOk = (...args) => ctx.migrateDirOk(...args);
  const migrateDirProblem = (...args) => ctx.migrateDirProblem(...args);
  const migrateRunArgv = (...args) => ctx.migrateRunArgv(...args);
  const migrateTarget = (...args) => ctx.migrateTarget(...args);
  const migrationResponse = (...args) => ctx.migrationResponse(...args);
  const refreshDeploymentPlan = (...args) => ctx.refreshDeploymentPlan(...args);
  const runOut = (...args) => ctx.runOut(...args);
  const save = (...args) => ctx.save(...args);
app.post('/api/apps/:id/migrate', (req, res) => {
  try {
    const db_ = load();
    const meta = db_.apps.find(a => a.id === req.params.id);
    if (!meta) return res.status(404).json({ error: 'unknown app' });
    const c = String((req.body && (req.body.command ?? req.body.cmd)) || '').trim();
    if (c && !MIGRATE_CMD_RE.test(c)) return res.status(400).json({ error: 'bad command (letters/numbers/space _ . : / - = only)' });
    const dir = String((req.body && req.body.dir) || '').trim().replace(/^\/+|\/+$/g, '');
    if (!migrateDirOk(dir)) return res.status(400).json({ error: 'bad migrate folder' });
    const check = String((req.body && req.body.check) || '').trim();
    if (check && !MIGRATE_CMD_RE.test(check)) return res.status(400).json({ error: 'bad verify command' });
    const dirAbs = appDir(APPS_DIR, meta.id);
    meta.migrateCmd = c;
    meta.migrateDir = dir;
    meta.migrateCheck = check;
    if (req.body && req.body.service !== undefined)
      meta.migrateSvc = migrateTarget(meta, dirAbs, String(req.body.service || '').trim());
    else if (!meta.migrateSvc) meta.migrateSvc = migrateTarget(meta, dirAbs, '');
    const problem = migrateDirProblem(meta, dirAbs, meta.migrateSvc, dir);
    if (problem) return res.status(400).json({ error: problem });
    save(db_);
    res.json({ ok: true, migrateCmd: meta.migrateCmd, migrateSvc: meta.migrateSvc, migrateDir: meta.migrateDir, migrateCheck: meta.migrateCheck });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/apps/:id/migrate-run', async (req, res) => {
  try {
    const meta = load().apps.find(a => a.id === req.params.id);
    if (!meta) return res.status(404).json({ error: 'unknown app' });
    const cmd = String((req.body && req.body.command) || (meta && meta.migrateCmd) || '').trim();
    if (!cmd) return res.status(400).json({ error: 'no migrate command saved' });
    if (!MIGRATE_CMD_RE.test(cmd)) return res.status(400).json({ error: 'bad command (letters/numbers/space _ . : / - = only)' });
    const dirIn = String((req.body && req.body.dir) || '').trim().replace(/^\/+|\/+$/g, '');
    if (!migrateDirOk(dirIn)) return res.status(400).json({ error: 'bad migrate folder' });
    const dirAbs = appDir(APPS_DIR, meta.id);
    const svcName = migrateTarget(meta, dirAbs, String((req.body && req.body.service) || meta.migrateSvc || ''));
    // An explicitly sent dir (even empty = service root) wins - the boxes are
    // the truth for one-shot runs. Only fall back to saved when absent.
    const dir = (req.body && req.body.dir !== undefined) ? dirIn : (meta.migrateDir || '');
    const problem = migrateDirProblem(meta, dirAbs, svcName, dir);
    if (problem) return res.status(400).json({ error: problem });
    const argv = migrateRunArgv(svcName, dir, cmd);
    const cap = { cwd: dirAbs, captureStderr: true };
    const out = await runOut(argv[0], argv.slice(1), cap);
    res.json({ ok: true, service: svcName, output: String(out).slice(-4000) || '(no output)' });
  } catch (e) { res.status(500).json({ error: migrationResponse('migrate run failed: ', e) }); }
});

app.post('/api/apps/:id/migrate-check', async (req, res) => {
  try {
    const meta = load().apps.find(a => a.id === req.params.id);
    if (!meta) return res.status(404).json({ error: 'unknown app' });
    const cmd = String((req.body && req.body.check) || (meta && meta.migrateCheck) || '').trim();
    if (!cmd) return res.status(400).json({ error: 'no verify command saved' });
    if (!MIGRATE_CMD_RE.test(cmd)) return res.status(400).json({ error: 'bad verify command' });
    const dirIn = String((req.body && req.body.dir) || '').trim().replace(/^\/+|\/+$/g, '');
    if (!migrateDirOk(dirIn)) return res.status(400).json({ error: 'bad migrate folder' });
    const dirAbs = appDir(APPS_DIR, meta.id);
    const svcName = migrateTarget(meta, dirAbs, String((req.body && req.body.service) || meta.migrateSvc || ''));
    const dir = (req.body && req.body.dir !== undefined) ? dirIn : (meta.migrateDir || '');
    const problem = migrateDirProblem(meta, dirAbs, svcName, dir);
    if (problem) return res.status(400).json({ error: problem });
    const argv = migrateRunArgv(svcName, dir, cmd);
    const out = await runOut(argv[0], argv.slice(1), { cwd: dirAbs, captureStderr: true });
    res.json({ ok: true, service: svcName, output: String(out).slice(-4000) || '(no output)' });
  } catch (e) { res.status(500).json({ error: migrationResponse('verify failed: ', e) }); }
});

app.get('/api/apps/:id/migrate-suggest', async (req, res) => {
  try {
    const meta = load().apps.find(a => a.id === req.params.id);
    if (!meta) return res.status(404).json({ error: 'unknown app' });
    const dir = appDir(APPS_DIR, meta.id);
    const plan=refreshDeploymentPlan(meta,dir);
    if(plan.selected?.kind==='compose') {
      const states=await appContainers(meta.id);
      return res.json({repositoryOwned:true,suggestions:[],tasks:(plan.topology?.services||[]).filter(s=>s.oneShot).map(s=>({name:s.name,command:s.command,dependsOn:s.dependencyConditions,state:states.find(c=>c.service===s.name)?.state||'pending',exitCode:states.find(c=>c.service===s.name)?.exitCode,
        completed:states.some(c=>c.service===s.name&&c.state==='exited'&&c.exitCode===0)}))});
    }
    const services = svc.fullServices(meta, dir);
    const detected = migrations.detectMigrations(path.join(dir, 'code'), services);
    // cmd/svc aliases keep older frontends useful during a rolling panel update.
    const suggestions = detected.slice(0, 30).map(x => ({ ...x, cmd: x.command, svc: x.service }));
    res.json({ suggestions });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
};
