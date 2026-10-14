// database-support: extracted from the original backend without changing route semantics.
module.exports = function createHelpers(ctx) {
  const { MIGRATE_DIR_RE, dbTools, fs, migrations, path, svc } = ctx;
  const composeArgv = (...args) => ctx.composeArgv(...args);
  const load = (...args) => ctx.load(...args);
  const save = (...args) => ctx.save(...args);
function clearDbToolLease(meta, type) {
  const saved = meta.dbTools && meta.dbTools[type];
  if (!saved) return false;
  delete saved.startedAt;
  delete saved.expiresAt;
  return true;
}

function stopExpiredDbTools() {
  try {
    const db_ = load();
    const now = Date.now();
    let changed = false;
    for (const meta of db_.apps) {
      for (const [type, saved] of Object.entries(meta.dbTools || {})) {
        const expires = saved && Date.parse(saved.expiresAt || '');
        if (expires && expires <= now) {
          dbTools.stop(meta.id, type);
          clearDbToolLease(meta, type);
          changed = true;
        }
      }
    }
    if (changed) save(db_);
  } catch (e) { console.error('database UI expiry:', e.message); }
}

function migrateTarget(meta, dir, svcName) {
  const list = svc.fullServices(meta, dir).filter(s => s.enabled !== false);
  if (svcName && list.some(s => s.name === svcName)) return svcName;
  if (list.some(s => s.name === 'app')) return 'app';
  return (list[0] && list[0].name) || 'app';
}

function migrateDirOk(d) {
  return !d || (MIGRATE_DIR_RE.test(d) && !d.split('/').includes('..'));
}

function migrateDirProblem(meta, dirAbs, svcName, dir) {
  if (!dir) return null;
  const list = svc.fullServices(meta, dirAbs).filter(s => s.enabled !== false);
  const svcObj = list.find(s => s.name === svcName) || null;
  const base = path.join(dirAbs, 'code', (svcObj && svcObj.subdir) || '');
  let st = null;
  try { st = fs.statSync(path.join(base, dir)); } catch { return `migrate folder '${dir}' not found in the repo`; }
  if (!st.isDirectory()) return `'${dir}' is a file - use its folder instead`;
  return null;
}

function migrateRunArgv(svcName, dir, cmd) {
  const localCmd = migrations.localOnlyCommand(cmd);
  const inner = dir ? `cd ${dir} && ${localCmd}` : localCmd;
  return [...composeArgv(), 'run', '--rm', svcName, 'sh', '-c', inner];
}

function migrationFailure(error) {
  const raw = String((error && error.message) || error || 'migration failed');
  const missingModule = raw.match(/Cannot find module '((?:@[^'/]+\/)?[^'./][^']*)'/);
  if (missingModule) {
    return (`migration dependency '${missingModule[1]}' is not installed in this app image. Add it to package.json dependencies, redeploy (or local rebuild after a Files-tab edit), then retry. Minipass never installs packages during a migration. Original error: ` + raw).slice(0, 1200);
  }
  if (/node_modules\/\.bin\/[A-Za-z0-9_.-]+[^\n]*(?:not found|No such file)|will be installed|npm (?:error|err!).*(?:canceled|cancelled)|could not determine executable/i.test(raw)) {
    return 'migration tool is not installed in this app image. Add the CLI to package.json dependencies/devDependencies, redeploy, then retry. Minipass will not download an unpinned latest version during a migration.';
  }
  const redacted = raw.replace(/((?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?):\/\/[^:\s/@]+):[^@\s/]+@/gi, '$1:***@');
  const useful = redacted.split(/\r?\n/).filter(line => !/^\s*at\b/.test(line) && !/^Node\.js v/i.test(line));
  const concise = useful.join('\n').trim() || redacted;
  if (/ECONNREFUSED[^\n]*(?:127\.0\.0\.1|::1|localhost)/i.test(redacted)) {
    return ('database connection refused at localhost. Inside an app container, localhost is the app itself, not the managed database. Configure the project to use process.env.DB_HOST and process.env.DB_PORT, then local rebuild and retry. Original error: ' + concise).slice(0, 1200);
  }
  if (/ER_NOT_SUPPORTED_AUTH_MODE|does not support authentication protocol|caching_sha2_password/i.test(redacted)) {
    return ('MySQL 8 authentication (caching_sha2_password) is not supported by the repository\u2019s old `mysql` package. Fix in source: replace dependency `mysql` with `mysql2`, set the Knex client to `mysql2`, redeploy, then retry. Testing alternative: recreate the site with MariaDB. Original error: ' + concise).slice(0, 1200);
  }
  return concise.slice(0, 1200);
}

function migrationResponse(prefix, error) {
  const message = prefix + migrationFailure(error);
  return message.length > 500 ? message.slice(0, 497) + '...' : message;
}
  return { clearDbToolLease, stopExpiredDbTools, migrateTarget, migrateDirOk, migrateDirProblem, migrateRunArgv, migrationFailure, migrationResponse };
};
