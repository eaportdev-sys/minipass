// databases: extracted from the original backend without changing route semantics.
module.exports = function register(ctx) {
  const { APPS_DIR, COMPOSE_BIN, DB_TOOL_TTL_MS, DOCKER_BIN, app, appDir, dbToolLocks, dbToolPorts, dbTools, execSync, fs, normDbs, os, path, svc } = ctx;
  const appContainers = (...args) => ctx.appContainers(...args);
  const attachDatabase = (...args) => ctx.attachDatabase(...args);
  const backupStamp = (...args) => ctx.backupStamp(...args);
  const clearDbToolLease = (...args) => ctx.clearDbToolLease(...args);
  const composeArgv = (...args) => ctx.composeArgv(...args);
  const deploy = (...args) => ctx.deploy(...args);
  const hostPortsInUse = (...args) => ctx.hostPortsInUse(...args);
  const load = (...args) => ctx.load(...args);
  const markDirty = (...args) => ctx.markDirty(...args);
  const repositoryDatabases = (...args) => ctx.repositoryDatabases(...args);
  const runOut = (...args) => ctx.runOut(...args);
  const runToFile = (...args) => ctx.runToFile(...args);
  const save = (...args) => ctx.save(...args);
let dbToolsPulling = false;

app.get('/api/panel/db-tools/images', (req, res) => {
  try {
    res.json({ images: Object.entries(dbTools.TOOLS).map(([type, tool]) => ({ type, tool: tool.label, image: tool.image, present: dbTools.imagePresent(tool.image) })) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/panel/db-tools/pull', async (req, res) => {
  if (dbToolsPulling) return res.status(409).json({ error: 'image download already in progress' });
  dbToolsPulling = true;
  try {
    const results = await dbTools.pullImages();
    res.json({ ok: results.every(r => r.ok), results });
  } catch (e) { res.status(500).json({ error: e.message }); }
  finally { dbToolsPulling = false; }
});

app.get('/api/apps/:id/backup', async (req, res) => {
  const meta = load().apps.find(a => a.id === req.params.id);
  if (!meta) return res.status(404).json({ error: 'unknown app' });
  const stamp = backupStamp();
  const tmp = path.join(os.tmpdir(), `${meta.id}-backup-${stamp}.tar.gz`);
  try {
    await runOut('tar', ['-czf', tmp, '--exclude=node_modules', '-C', appDir(APPS_DIR, meta.id), '.']);
  } catch (e) { return res.status(500).json({ error: 'site backup failed: ' + e.message }); }
  res.download(tmp, `${meta.id}-backup-${stamp}.tar.gz`, () => { try { fs.unlinkSync(tmp); } catch {} });
});

app.get('/api/apps/:id/databases/:type/dump', async (req, res) => {
  const meta = load().apps.find(a => a.id === req.params.id);
  if (!meta) return res.status(404).json({ error: 'unknown app' });
  const type = req.params.type;
  let cfg;
  try { cfg = dbTools.databaseConfig(meta, appDir(APPS_DIR, meta.id), type); }
  catch (e) { return res.status(400).json({ error: e.message }); }
  if (!cfg.host || !cfg.pass || (type !== 'redis' && (!cfg.user || !cfg.db)))
    return res.status(400).json({ error: 'incomplete managed credentials for ' + type });
  const redact = s => String(s).split(cfg.pass).join('***');
  const dir = appDir(APPS_DIR, meta.id);
  const svc = cfg.service;
  const stamp = backupStamp();
  const ext = type === 'redis' ? 'rdb' : type === 'mongo' ? 'archive' : 'sql';
  const tmp = path.join(os.tmpdir(), `${meta.id}-${type}-${stamp}.${ext}`);
  try {
    const ca = composeArgv();
    const cexec = (args) => runOut(ca[0], [...ca.slice(1), 'exec', '-T', ...args], { cwd: dir });
    const cexecTo = (args) => runToFile(ca[0], [...ca.slice(1), 'exec', '-T', ...args], tmp, { cwd: dir });
    if (type === 'postgres') {
      await cexecTo(['-e', `PGPASSWORD=${cfg.pass}`, svc, 'pg_dump', '-U', cfg.user, '-h', 'localhost', cfg.db]);
    } else if (type === 'mysql' || type === 'mariadb') {
      await cexecTo([svc, type === 'mariadb' ? 'mariadb-dump' : 'mysqldump', '-u', cfg.user, `-p${cfg.pass}`, cfg.db]);
    } else if (type === 'mongo') {
      const uri = `mongodb://${encodeURIComponent(cfg.user)}:${encodeURIComponent(cfg.pass)}@localhost:${cfg.port || 27017}/${encodeURIComponent(cfg.db || '')}?authSource=admin`;
      await cexecTo([svc, 'mongodump', `--uri=${uri}`, '--archive']);
    } else if (type === 'redis') {
      const cid = execSync(`${COMPOSE_BIN} ps -q ${svc}`, { cwd: dir }).toString().trim().split('\n')[0] || '';
      if (!/^[a-f0-9]{12,64}$/i.test(cid)) throw new Error('database container not running');
      const lastsave = async () => {
        const o = await cexec([svc, 'redis-cli', '-a', cfg.pass, 'LASTSAVE']);
        return parseInt(String(o).trim(), 10) || 0;
      };
      const before = await lastsave().catch(() => 0);
      await cexec([svc, 'redis-cli', '-a', cfg.pass, 'BGSAVE']);
      let fresh = false;
      for (let i = 0; i < 15; i++) {
        await new Promise(r => setTimeout(r, 1000));
        try { if (await lastsave() > before) { fresh = true; break; } } catch {}
      }
      if (!fresh) throw new Error('redis snapshot did not finish in time');
      await runOut(DOCKER_BIN, ['cp', `${cid}:/data/dump.rdb`, tmp]);
    } else return res.status(400).json({ error: 'unsupported database' });
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch {}
    return res.status(500).json({ error: ('database dump failed: ' + redact(e.message)).slice(0, 300) });
  }
  res.download(tmp, path.basename(tmp), () => { try { fs.unlinkSync(tmp); } catch {} });
});

app.post('/api/apps/:id/db', async (req, res) => {
  try {
    const type = normDbs(req.body.type)[0];
    if (!type) return res.status(400).json({ error: 'unknown database type' });
    const db_ = load();
    const meta = db_.apps.find(a => a.id === req.params.id);
    if (!meta) return res.status(404).json({ error: 'unknown app' });
    const current = normDbs(meta.db);
    if (current.includes(type)) {
      return res.status(400).json({ error: type + ' already attached' });
    }
    const result = attachDatabase(meta, type);
    await markDirty(meta.id, 'db ' + type + ' added');
    if (!(req.body && req.body.apply === true)) return res.json({ ok: true, added: type, keys: result.keys, pending: true });
    try { await deploy(meta.id); } catch (e) { return res.json({ ok: true, added: type, redeployError: e.message }); }
    res.json({ ok: true, added: type, redeployed: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/apps/:id/databases', async (req, res) => {
  try {
    let db_ = load();
    let meta = db_.apps.find(a => a.id === req.params.id);
    if (!meta) return res.status(404).json({ error: 'unknown app' });
    const containers = await appContainers(meta.id);
    db_ = load();
    meta = db_.apps.find(a => a.id === req.params.id);
    if (!meta) return res.status(404).json({ error: 'unknown app' });
    const dir = appDir(APPS_DIR, meta.id);
    const databases = dbTools.describe(meta, dir, containers);
    const labels={postgres:'PostgreSQL',mysql:'MySQL',mariadb:'MariaDB',mongo:'MongoDB',redis:'Redis'};
    for(const d of repositoryDatabases(meta,dir)) {
      if(databases.some(existing=>existing.service===d.service))continue;
      const ct=containers.find(c=>c.service===d.service);
      databases.push({...d,label:labels[d.type] || d.type,state:ct?.state || 'prepared',status:ct?.status || 'Starts and initializes on the first deployment.',tool:null});
    }
    let changed = false;
    const now = Date.now();
    for (const database of databases) {
      if (database.toolState !== 'running') continue;
      const saved = meta.dbTools && meta.dbTools[database.type];
      if (!saved) continue;
      const expires = Date.parse(saved.expiresAt || '');
      if (expires && expires <= now) {
        dbTools.stop(meta.id, database.type);
        clearDbToolLease(meta, database.type);
        database.toolState = 'stopped';
        delete database.toolExpiresAt;
        changed = true;
      } else if (!expires) {
        saved.startedAt = new Date(now).toISOString();
        saved.expiresAt = new Date(now + DB_TOOL_TTL_MS).toISOString();
        database.toolExpiresAt = saved.expiresAt;
        changed = true;
      }
    }
    if (changed) save(db_);
    res.json({ databases, repositoryOwned:meta.executor==='repository-compose'||meta.deploymentEntrypoint?.kind==='compose',toolTtlMinutes: DB_TOOL_TTL_MS / 60000 });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/apps/:id/databases/:type/tool', async (req, res) => {
  const lock = `${req.params.id}:${req.params.type}`;
  if (dbToolLocks.has(lock)) return res.status(409).json({ error: 'database tool is already starting' });
  dbToolLocks.add(lock);
  let reservedPort = null;
  try {
    const db_ = load();
    const meta = db_.apps.find(a => a.id === req.params.id);
    if (!meta) return res.status(404).json({ error: 'unknown app' });
    const type = req.params.type;
    const dir = appDir(APPS_DIR, meta.id);
    if(!dbTools.TOOLS[type])return res.status(400).json({error:'unsupported database type'});
    try {dbTools.databaseConfig(meta,dir,type);}catch(e){return res.status(400).json({error:e.message});}
    const live = dbTools.describe(meta, dir, await appContainers(meta.id)).find(d => d.type === type);
    if (!live || !/^running/i.test(live.state || '')) return res.status(409).json({ error: `${live ? live.label : type} is not running - deploy the site first` });
    const saved = meta.dbTools && meta.dbTools[type];
    let port = saved && parseInt(saved.port, 10);
    if (port < 8900 || port > 8999) port = null;
    if (!port) {
      const used = hostPortsInUse();
      port = 8900;
      while ((used.has(port) || dbToolPorts.has(port)) && port <= 8999) port++;
      if (port > 8999) return res.status(409).json({ error: 'no database UI port available in 8900-8999' });
    }
    if (dbToolPorts.has(port)) return res.status(409).json({ error: `database UI port ${port} is already starting` });
    dbToolPorts.add(port);
    reservedPort = port;
    const out = await dbTools.launch(meta.id, meta, dir, type, port);
    // Reload after the image starts: launches for different database types can
    // finish together, and each must merge rather than overwrite the others.
    const freshDb = load();
    const freshMeta = freshDb.apps.find(a => a.id === meta.id);
    if (!freshMeta) {
      dbTools.stop(meta.id, type);
      throw new Error('site was deleted while the database UI was starting');
    }
    const startedAt = new Date();
    freshMeta.dbTools = { ...(freshMeta.dbTools || {}), [type]: {
      port, tool: out.tool, startedAt: startedAt.toISOString(), expiresAt: new Date(startedAt.getTime() + DB_TOOL_TTL_MS).toISOString()
    } };
    save(freshDb);
    res.json({ ok: true, ...out, expiresAt: freshMeta.dbTools[type].expiresAt });
  } catch (e) { res.status(e.code === 'DB_TOOL_IMAGE_MISSING' ? 409 : 500).json({ error: e.message }); }
  finally {
    dbToolLocks.delete(lock);
    if (reservedPort) dbToolPorts.delete(reservedPort);
  }
});

app.delete('/api/apps/:id/databases/:type/tool', (req, res) => {
  try {
    const db_ = load();
    const meta = db_.apps.find(a => a.id === req.params.id);
    if (!meta) return res.status(404).json({ error: 'unknown app' });
    dbTools.stop(meta.id, req.params.type);
    clearDbToolLease(meta, req.params.type);
    save(db_);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
};
