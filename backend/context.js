// Shared configuration and small platform helpers. Workflows and routes live in separate modules.
module.exports = function createContext() {
  const deployNow = (...args) => ctx.deployNow(...args);
  const deployRepositoryCompose = (...args) => ctx.deployRepositoryCompose(...args);
  const deploymentRunners = (...args) => ctx.deploymentRunners(...args);
  const snapshotImages = (...args) => ctx.snapshotImages(...args);
  const rollbackImages = (...args) => ctx.rollbackImages(...args);
  const waitStable = (...args) => ctx.waitStable(...args);
  const deploySh = (...args) => ctx.deploySh(...args);
  const recordDeploy = (...args) => ctx.recordDeploy(...args);
  const markDirty = (...args) => ctx.markDirty(...args);
  const refreshDeploymentPlan = (...args) => ctx.refreshDeploymentPlan(...args);
  const syncProvisionedDomain = (...args) => ctx.syncProvisionedDomain(...args);
  const autodetectHome = (...args) => ctx.autodetectHome(...args);
  const deploy = (...args) => ctx.deploy(...args);
  const rebindHostPorts = (...args) => ctx.rebindHostPorts(...args);
  const resolveBuildManager = (...args) => ctx.resolveBuildManager(...args);
  const detectRepo = (...args) => ctx.detectRepo(...args);
  const firstSyncClone = (...args) => ctx.firstSyncClone(...args);
  const createLocalPushStage = (...args) => ctx.createLocalPushStage(...args);
  const currentSha = (...args) => ctx.currentSha(...args);
  const configureDetectedServices = (...args) => ctx.configureDetectedServices(...args);
  const hasStaleRootService = (...args) => ctx.hasStaleRootService(...args);
  const requiredDatabases = (...args) => ctx.requiredDatabases(...args);
  const cleanDomain = (...args) => ctx.cleanDomain(...args);
  const envMergeManaged = (...args) => ctx.envMergeManaged(...args);
  const dbAliasLines = (...args) => ctx.dbAliasLines(...args);
  const attachDatabase = (...args) => ctx.attachDatabase(...args);
  const ensureDatabaseAliases = (...args) => ctx.ensureDatabaseAliases(...args);
  const serviceNameFromSubdir = (...args) => ctx.serviceNameFromSubdir(...args);
  const hostPortsInUse = (...args) => ctx.hostPortsInUse(...args);
  const serviceCandidate = (...args) => ctx.serviceCandidate(...args);
  const suggestedDefaults = (...args) => ctx.suggestedDefaults(...args);
  const managedKeys = (...args) => ctx.managedKeys(...args);
  const envSetManaged = (...args) => ctx.envSetManaged(...args);
  const envDeleteKeys = (...args) => ctx.envDeleteKeys(...args);
  const applyEnvDefaults = (...args) => ctx.applyEnvDefaults(...args);
  const parseEnvFile = (...args) => ctx.parseEnvFile(...args);
  const lifecycleError = (...args) => ctx.lifecycleError(...args);
  const deployCancelledError = (...args) => ctx.deployCancelledError(...args);
  const trackDeployChild = (...args) => ctx.trackDeployChild(...args);
  const killProcessTree = (...args) => ctx.killProcessTree(...args);
  const killDeployChildren = (...args) => ctx.killDeployChildren(...args);
  const cancelDeploy = (...args) => ctx.cancelDeploy(...args);
  const checkCancelled = (...args) => ctx.checkCancelled(...args);
  const siteLifecycle = (...args) => ctx.siteLifecycle(...args);
  const trashOperation = (...args) => ctx.trashOperation(...args);
  const destroyTrashRecord = (...args) => ctx.destroyTrashRecord(...args);
  const purgeTrash = (...args) => ctx.purgeTrash(...args);
  const pollGithub = (...args) => ctx.pollGithub(...args);
  const removeGithubHook = (...args) => ctx.removeGithubHook(...args);
  const createGithubHook = (...args) => ctx.createGithubHook(...args);
  const githubHead = (...args) => ctx.githubHead(...args);
  const setGithubAutomation = (...args) => ctx.setGithubAutomation(...args);
  const clearDbToolLease = (...args) => ctx.clearDbToolLease(...args);
  const stopExpiredDbTools = (...args) => ctx.stopExpiredDbTools(...args);
  const migrateTarget = (...args) => ctx.migrateTarget(...args);
  const migrateDirOk = (...args) => ctx.migrateDirOk(...args);
  const migrateDirProblem = (...args) => ctx.migrateDirProblem(...args);
  const migrateRunArgv = (...args) => ctx.migrateRunArgv(...args);
  const migrationFailure = (...args) => ctx.migrationFailure(...args);
  const migrationResponse = (...args) => ctx.migrationResponse(...args);
  const panelAuthed = (...args) => ctx.panelAuthed(...args);
  const panelToken = (...args) => ctx.panelToken(...args);
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { exec, execSync, execFileSync, spawn } = require('child_process');
const http = require('http');
const { WebSocketServer } = require('ws');
const { createApp, appDir, normDbs, dbService, nginxConf, ensureDockerfile, needsDockerfileOptIn, inferPort, TYPE_PORT } = require('./lib/generator');
const { gitEnv, pubKey, appPubKey, appGitEnv } = require('./lib/ssh');
const svc = require('./lib/services');
const deployMarkers = require('./lib/deploy-markers');
const dbTools = require('./lib/db-tools');
const migrations = require('./lib/migrations');
const routes = require('./lib/routes');
const envDefaults = require('./lib/env-defaults');
const tokens = require('./lib/tokens');
const portsLib = require('./lib/ports');
const storage = require('./lib/storage');
const hostStorage = require('./lib/host-storage');
const trashLib = require('./lib/trash');
const quotas = require('./lib/quotas');
const panelLog = require('./lib/panel-log');
const prebuild = require('./lib/prebuild');
const { runLogged, failureSummary } = require('./lib/build-log');
const remediate = require('./lib/remediate');
const importProtection = require('./lib/import-protection');
const dockerfileProtection = require('./lib/dockerfile-protection');
const siteIdentity = require('./lib/site-identity');
const { refreshStandardDockerfile, standardDockerfileType, findDockerfiles, validDockerfileName, resolveServiceDockerfile, isInfraDockerfile, nonInfraDockerfiles, BYPASS_DOCKERFILE } = require('./lib/dockerfiles');
const { hasRunnableEntry } = require('./lib/detect');
const { buildProfile, readBuildProfile, localBuildProfile, isJekyll } = require('./lib/build-profile');
const repoAnalysis = require('./lib/repo-analysis');
const deploymentPlan = require('./lib/deployment-plan');
const { sourceFile, readSource, isDockerfile } = require('./lib/repository-files');
const repositoryCompose = require('./lib/repository-compose');
const publication = require('./lib/publication');
const composeInputs = require('./lib/compose-inputs');
const localAccess = require('./lib/local-access');
const { PanelStore } = require('./lib/panel-store');
const { PanelAccounts } = require('./lib/panel-accounts');
const { deletionQueue } = require('./lib/deletion-queue');
const PORT = process.env.PORT || 3001;
const APPS_DIR = path.resolve(__dirname, process.env.APPS_DIR || '../apps');
const TRASH_HOLD_MS = 48 * 3600 * 1000;
const TRASH_DIR = path.join(APPS_DIR, '.trash');
function pickDir(cands) { for (const c of cands) { try { if (fs.existsSync(c)) return c; } catch {} } return cands[0]; }
const TEMPLATES_DIR = pickDir([path.resolve(__dirname, '../templates'), path.join(__dirname, 'templates'), path.join(process.cwd(), 'templates')]);
const FRONTEND_DIR = pickDir([path.resolve(__dirname, '../frontend'), path.join(__dirname, 'frontend'), path.join(process.cwd(), 'frontend')]);
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data.json');
fs.mkdirSync(APPS_DIR, { recursive: true });
try { fs.mkdirSync(TRASH_DIR, { recursive: true }); } catch {}
fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
const store = new PanelStore({ file: process.env.PANEL_DB_FILE || path.join(path.dirname(DATA_FILE), 'panel.sqlite'), legacyFile: DATA_FILE, authFile: path.join(path.dirname(DATA_FILE), 'panel-auth.json') });
panelLog.attachStore(store);
const accounts = new PanelAccounts(store);
const deletions = deletionQueue();
const app = express();
const lifecycleLocks = new Set();
const creatingSites = new Set();
const AUTO_DEPLOY = false;
const gh = require('./lib/github');
const TERMS_TEXT = [
  'MINIPASS OPERATOR TERMS (v0.1, localhost testing build)',
  '',
  '1. You operate this panel. Every site it builds, runs, or exposes is yours.',
  '2. Deployed apps run arbitrary code from connected repos. You are responsible',
  '   for the content, behavior, and legal compliance of everything you deploy.',
  '3. Database engines run under their own upstream licenses (e.g. MySQL/MariaDB GPL-2.0,',
  '   MongoDB SSPL). Commercial use is your call to clear, not ours.',
  '4. Backups are your responsibility until automated backups exist. Download them',
  '   from the site Files tab and store them somewhere that is not this box.',
  '5. This is a testing build with no warranty of any kind (see LICENSE).',
  '6. Do not expose the panel to the public internet until an auth + TLS review',
  '   says otherwise. Localhost / trusted-LAN use only for now.'
].join('\n');
function load() {
  return store.load();
}
function save(d) { store.save(d); }
function pubApp(a) {
  const g = a.github || null;
  const pub = g ? { repo: g.repo, branch: g.branch, login: g.login, sha: g.sha, pollMinutes: g.pollMinutes, enabled: g.enabled === true, hasToken: !!g.token } : g;
  // SPA/static servers commonly return index.html for every path. Old landing
  // detection therefore mistook /health/live for their homepage. Preserve an
  // operator-set path, otherwise frontend roots always open at /.
  const homePath = ['static', 'react'].includes(a.type) && !a.homePathManual ? '' : (a.homePath || '');
  return { ...a, repositoryDatabases:repositoryDatabases(a,appDir(APPS_DIR,a.id)),name: a.name || a.id, homePath, github: pub, autoDeploy: AUTO_DEPLOY };
}
function repositoryDatabases(meta,dir) {
  try {
    const plan=JSON.parse(fs.readFileSync(path.join(dir,'.deployment-plan.json'),'utf8'));
    if(plan.selected?.kind==='compose'&&plan.topology)return plan.topology.services.flatMap(s=>{
      const type=composeInputs.typeOf(s.image);
      return type&&!s.oneShot?[{service:s.name,type,image:s.image,repositoryOwned:true}]:[];
    });
  }catch{}
  return meta.repositoryDatabases || [];
}
function publicServices(meta, dir) {
  return svc.fullServices(meta, dir).map(s => {
    if (s.repositoryOwned) return { ...s, homePath: s.primary ? meta.homePath || s.homePath || '' : s.homePath || '', dockerfiles: [], dockerfile: s.dockerfile || null };
    const frontendRoot = ['static', 'react'].includes(s.type) && !(s.name === 'app' && meta.homePathManual);
    const homePath = s.name === 'app'
      ? (frontendRoot ? '' : (meta.homePath || ''))
      : (frontendRoot ? '' : (s.homePath || ''));
    // Build file candidates for this service folder + the effective file.
    // Lenient here: ambiguous or stale selections fall back to the default
    // and fail loud with names at deploy/add time.
    const ctxDir = path.join(dir, 'code', s.subdir || '');
    let dockerfiles = [];
    let dockerfile = 'Dockerfile';
    try { dockerfiles = findDockerfiles(ctxDir); } catch {}
    if (s.dockerfile && validDockerfileName(s.dockerfile) && dockerfiles.includes(s.dockerfile)) dockerfile = s.dockerfile;
    else {
      try {
        const r = resolveServiceDockerfile(ctxDir, null, s.type, TEMPLATES_DIR);
        if (r) dockerfile = r.file;
      } catch {}
    }
    return { ...s, homePath, dockerfile, dockerfiles };
  });
}
let COMPOSE_BIN = process.env.COMPOSE_BIN || 'docker compose';
try { execSync('docker compose version', { stdio: 'ignore' }); }
catch { try { execSync('docker-compose --version', { stdio: 'ignore' }); COMPOSE_BIN = 'docker-compose'; } catch {} }
function sh(cmd, cwd, env) {
  return new Promise((res, rej) => {
    exec(cmd, { cwd, env: env || process.env, maxBuffer: 10 * 1024 * 1024 }, (e, stdout, stderr) => {
      if (e) rej(new Error(stderr || e.message)); else res(stdout);
    });
  });
}
function runOut(bin, args, opts = {}) {
  return new Promise((res, rej) => {
    const { onSpawn, captureStderr, input, timeout, acceptExitCodes = [0], ...spawnOpts } = opts;
    const p = spawn(bin, args, spawnOpts);
    p.stdin.on('error', () => {}); // cancellation may close an interactive verifier's input
    if (onSpawn) onSpawn(p);
    if (input !== undefined) p.stdin.end(input);
    const timer = timeout ? setTimeout(() => p.kill(), timeout) : null;
    const chunks = [];
    const errChunks = [];
    let settled = false;
    // Process errors usually put the actionable cause first and a long stack
    // afterward. Preserve both ends so migration failures do not degrade into
    // only `at Client.acquireRawConnection` frames.
    const errDetail = () => {
      const raw = Buffer.concat(errChunks).toString().trim();
      if (raw.length <= 1800) return raw;
      return raw.slice(0, 900) + '\n…\n' + raw.slice(-700);
    };
    p.stdout.on('data', d => chunks.push(d));
    p.stderr.on('data', d => {
      if (captureStderr) chunks.push(d);
      errChunks.push(d);
      if (errChunks.length > 32) errChunks.shift();
    });
    p.on('error', e => { if (timer) clearTimeout(timer); if (!settled) { settled = true; rej(e); } });
    p.on('close', code => {
      if (timer) clearTimeout(timer);
      if (settled) return;
      settled = true;
      if (acceptExitCodes.includes(code)) res(Buffer.concat(chunks));
      else {
        const detail = errDetail();
        rej(new Error(`${bin} exited with code ${code}${detail ? `: ${detail}` : ''}`));
      }
    });
  });
}
function runToFile(bin, args, file, opts = {}) {
  return new Promise((res, rej) => {
    const out = fs.createWriteStream(file);
    out.on('error', rej);
    const p = spawn(bin, args, opts);
    const errChunks = [];
    const errTail = () => Buffer.concat(errChunks).toString().slice(-500);
    p.stdout.on('data', d => {
      if (!out.write(d)) { p.stdout.pause(); out.once('drain', () => { try { p.stdout.resume(); } catch {} }); }
    });
    p.stderr.on('data', d => { errChunks.push(d); if (errChunks.length > 32) errChunks.shift(); });
    p.on('error', e => { out.destroy(); rej(e); });
    p.on('close', code => {
      out.end(() => {
        if (code === 0) res();
        else rej(new Error(`${bin} exited with code ${code}${errTail() ? `: ${errTail()}` : ''}`));
      });
    });
  });
}
function composeArgv() { return String(COMPOSE_BIN).trim().split(/\s+/); }
const DOCKER_BIN = process.env.DOCKER_BIN || 'docker';
function backupStamp() { return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19); }
const pollState = new Map();
const redactUrl = s => String(s).replace(/x-access-token:[^@]+@/g, 'x-access-token:***@');
const LEGACY_PANEL_PHP_DOCKERFILE = [
  'FROM php:8.2-apache',
  'WORKDIR /var/www/html',
  'COPY . /var/www/html/',
  'EXPOSE 80'
].join('\n');
const deployLocks = new Set();
const deployQueues = new Map();
const deployEpochs = new Map();
const deployChildren = new Map();
const deployOps = new Map();
const pushEvents = new Map();
const RELATIONAL_DBS = ['postgres', 'mysql', 'mariadb'];
const storageRequests = new Map();
async function appContainers(id) {
  let containers = [];
  try {
    const meta=load().apps.find(a=>a.id===id);
    if(meta&&(meta.executor==='repository-compose'||meta.deploymentEntrypoint?.kind==='compose')) {
      const inspected=await repositoryCompose.inspectProject({id,docker:DOCKER_BIN,run:runOut});
      return inspected.map(c=>({id:c.Id,service:c.Config.Labels['com.docker.compose.service'],image:c.Config.Image,state:c.State.Status,status:c.State.Health?c.State.Health.Status:c.State.Status,exitCode:c.State.ExitCode,
        role:(meta.repositoryServices||[]).find(s=>s.name===c.Config.Labels['com.docker.compose.service'])?.role||'application'}));
    }
    const out = await sh(`${COMPOSE_BIN} ps --format json`, appDir(APPS_DIR, id));
    let arr = [];
    try {
      const parsed = JSON.parse(out.trim() || '[]');
      arr = Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      arr = out.trim().split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    }
    containers = arr.map(c => ({
      id: c.ID || c.Id || c.id,
      service: c.Service || c.service || c.Name || c.name,
      image: c.Image || c.image,
      state: c.State || c.state,
      status: c.Status || c.status,
      role: ((load().apps.find(a => a.id === id) || {}).repositoryServices || []).find(s => s.name === (c.Service || c.service))?.role || 'application'
    }));
  } catch {}
  return containers;
}
const STANDARD_DOCKER_TYPES = ['node', 'react', 'php', 'static'];
function remediationContext(dir, subdir) {
  const root = fs.realpathSync(path.join(dir, 'code'));
  const context = fs.realpathSync(path.resolve(dir, 'code', subdir || ''));
  if (context !== root && !context.startsWith(root + path.sep)) throw lifecycleError('build folder must stay inside the repository', 400);
  return context;
}
function remediationSuggestions(meta, dir) {
  const services = svc.fullServices(meta || {}, dir);
  const protectedCards = [...importProtection.cards(dir, services), ...dockerfileProtection.cards(dir, services)];
  const out = [];
  const last = meta.lastDeploy && meta.lastDeploy.status !== 'ok' ? String(meta.lastDeploy.error || '') : '';
  if (!last) return protectedCards;
  // The deploy record truncates; the persisted log tail keeps the evidence
  // (tsc error lines, missing-module paths) suggestions match against.
  let evidence = last;
  try {
    const log = fs.readFileSync(path.join(dir, 'deploy.log'), 'utf8');
    evidence = log.split('\n').slice(-300).join('\n') + '\n' + last;
  } catch {}
  for (const s of svc.fullServices(meta || {}, dir).filter(s => s.enabled !== false)) {
    if (/^db(-|$)/.test(s.name || '')) continue;
    if (meta.lastDeploy.service && meta.lastDeploy.service !== s.name) continue;
    const ctxDir = remediationContext(dir, s.subdir);
    let template = null;
    try { template = fs.readFileSync(path.join(TEMPLATES_DIR, s.type, 'Dockerfile'), 'utf8'); } catch {}
    for (const suggestion of remediate.suggest(ctxDir, evidence, template, last)) {
      out.push({ service: s.name, subdir: s.subdir || '', ...suggestion });
    }
  }
  return [...out, ...protectedCards];
}
const DB_TOOL_TTL_MS = 30 * 60 * 1000;
const dbToolLocks = new Set();
const dbToolPorts = new Set();
const MIGRATE_CMD_RE = migrations.COMMAND_RE;
const MIGRATE_DIR_RE = migrations.DIR_RE;
const { readEnvVars, missingEnvVars } = require('./lib/env-needs');
const { readComposeTopo } = require('./lib/compose-read');
const trashKey = record => record.trashDir || record.id;
const trashOptions = () => ({ docker: DOCKER_BIN, compose: composeArgv() });
function codeDir(id) { return path.join(appDir(APPS_DIR, id), 'code'); }
const JUNK = new Set(['__MACOSX', '.DS_Store', 'Thumbs.db']);
function isInfraFile(base, root = null, relative = base) {
  if (/^dockerfile$/i.test(base || '') || base === 'nginx.conf') return true;
  // Arbitrarily named recipes have the same overwrite protection once present.
  // New files can be uploaded for discovery; existing build instructions cannot
  // be replaced by uploads or the ordinary source editor.
  try { const file = root && sourceFile(root, relative); return !!(file && isDockerfile(readSource(file).text)); } catch { return false; }
}
function safeRel(base, rel) {
  const resolved = path.resolve(base, '.' + path.sep + (rel || ''));
  if (resolved !== base && !resolved.startsWith(base + path.sep)) throw new Error('bad path');
  return resolved;
}
const uploadMany = require('multer')({ dest: '/tmp/minipass-uploads/', limits: { fileSize: 50 * 1024 * 1024, files: 100 } });
fs.mkdirSync('/tmp/minipass-uploads', { recursive: true });
const upload = require('multer')({ dest: '/tmp/minipass-uploads/', limits: { fileSize: 50 * 1024 * 1024 } });
const REPO_DIR = (() => {
  for (const c of ['/repo', path.resolve(__dirname, '..')]) {
    try { if (fs.existsSync(path.join(c, '.git'))) return c; } catch {}
  }
  return null;
})();
  const ctx = { __dirname, express, cors, fs, os, path, crypto, exec, execSync, execFileSync, spawn, http, WebSocketServer, createApp, appDir, normDbs, dbService, nginxConf, ensureDockerfile, needsDockerfileOptIn, inferPort, TYPE_PORT, gitEnv, pubKey, appPubKey, appGitEnv, svc, deployMarkers, dbTools, migrations, routes, envDefaults, tokens, portsLib, storage, hostStorage, trashLib, quotas, panelLog, prebuild, runLogged, failureSummary, remediate, importProtection, dockerfileProtection, siteIdentity, refreshStandardDockerfile, standardDockerfileType, findDockerfiles, validDockerfileName, resolveServiceDockerfile, isInfraDockerfile, nonInfraDockerfiles, BYPASS_DOCKERFILE, hasRunnableEntry, buildProfile, readBuildProfile, localBuildProfile, isJekyll, repoAnalysis, deploymentPlan, sourceFile, readSource, isDockerfile, repositoryCompose, publication, composeInputs, localAccess, PanelStore, PanelAccounts, deletionQueue, PORT, APPS_DIR, TRASH_HOLD_MS, TRASH_DIR, pickDir, TEMPLATES_DIR, FRONTEND_DIR, DATA_FILE, store, accounts, deletions, app, lifecycleLocks, creatingSites, AUTO_DEPLOY, gh, TERMS_TEXT, load, save, pubApp, repositoryDatabases, publicServices, COMPOSE_BIN, sh, runOut, runToFile, composeArgv, DOCKER_BIN, backupStamp, pollState, redactUrl, LEGACY_PANEL_PHP_DOCKERFILE, deployLocks, deployQueues, deployEpochs, deployChildren, deployOps, pushEvents, RELATIONAL_DBS, storageRequests, appContainers, STANDARD_DOCKER_TYPES, remediationContext, remediationSuggestions, DB_TOOL_TTL_MS, dbToolLocks, dbToolPorts, MIGRATE_CMD_RE, MIGRATE_DIR_RE, readEnvVars, missingEnvVars, readComposeTopo, trashKey, trashOptions, codeDir, JUNK, isInfraFile, safeRel, uploadMany, upload, REPO_DIR };
  Object.assign(ctx, require('./lib/deployment-executor')(ctx));
  Object.assign(ctx, require('./lib/deployment-state')(ctx));
  Object.assign(ctx, require('./lib/source-detection')(ctx));
  Object.assign(ctx, require('./lib/site-configuration')(ctx));
  Object.assign(ctx, require('./lib/site-lifecycle')(ctx));
  Object.assign(ctx, require('./lib/github-polling')(ctx));
  Object.assign(ctx, require('./lib/database-support')(ctx));
app.use(cors());
  require('./routes/webhooks')(ctx);
app.use(express.json());
  Object.assign(ctx, require('./routes/auth').registerAuth({ ...ctx, terms: TERMS_TEXT }));
  require('./routes/audit').registerAudit(ctx);
app.use('/api/apps/:id', (req, res, next) => {
  if (!['GET', 'HEAD'].includes(req.method) && lifecycleLocks.has(req.params.id)) return res.status(409).json({ error: 'site lifecycle operation in progress - retry when it finishes' });
  next();
});
app.use((req, res, next) => {
  if (!req.path.startsWith('/api') && !req.path.startsWith('/webhook') && !req.path.startsWith('/terminal')) res.set('Cache-Control', 'no-store');
  next();
});
app.use(express.static(FRONTEND_DIR, { maxAge: 0, etag: false }));
app.use('/api/apps/:id', (req, res, next) => {
  if (req.method === 'GET' || !/^\/(?:services(?:\/|$)|db$|api-backend$|migrate(?:-run|-check)?$)/.test(req.path)) return next();
  const meta = load().apps.find(a => a.id === req.params.id);
  if (!meta) return next();
  let owned = meta.executor === 'repository-compose';
  try { const plan = JSON.parse(fs.readFileSync(path.join(appDir(APPS_DIR, meta.id), '.deployment-plan.json'), 'utf8')); owned = owned || plan.selected && plan.selected.kind === 'compose'; } catch {}
  if (owned) return res.status(409).json({ error: 'The repository owns its services, databases and migration tasks. Edit its Compose instructions or environment, then redeploy; declared migrations run automatically.' });
  next();
});
  require('./routes/databases')(ctx);
  require('./routes/sites')(ctx);
  require('./routes/panel')(ctx);
  require('./routes/git')(ctx);
  require('./routes/storage')(ctx);
  require('./routes/deployment')(ctx);
  require('./routes/doctor')(ctx);
  require('./routes/services')(ctx);
  require('./routes/remediation')(ctx);
  require('./routes/migrations')(ctx);
  require('./routes/lifecycle')(ctx);
  require('./routes/environment')(ctx);
  require('./routes/files')(ctx);
setInterval(pollGithub, 60 * 1000);
setInterval(stopExpiredDbTools, 30000).unref();
setInterval(purgeTrash, 60 * 1000).unref();
purgeTrash();
try {
  const swept = deployMarkers.sweep(path.dirname(DATA_FILE));
  if (swept) console.log(`cleared ${swept} orphaned deploy marker(s)`);
} catch (e) { console.error('deploy marker sweep:', e.message); }
  return ctx;
};
