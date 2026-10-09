// Panel-owned approvals live outside code/ and are never Git commits. Only
// byte-exact, revalidated import changes may be replayed or suspended for pull.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const repair = require('./import-repair');
const MAX_RECORD_BYTES = 32 * 1024 * 1024;
const digest = record => crypto.createHash('sha256').update(JSON.stringify(record)).digest('hex');
const conflict = message => Object.assign(new Error(message), { status: 409 });
function folder(siteDir, service) {
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(service || '')) throw conflict('Invalid import-protection service');
  return path.join(siteDir, '.import-repairs', service);
}
function recordPath(siteDir, service, key) {
  if (!/^import-repair:[a-f0-9]{24}$/.test(key || '')) throw conflict('Invalid import-protection key');
  return path.join(folder(siteDir, service), key.slice('import-repair:'.length) + '.json');
}
function realDirectory(dir, create = false) {
  if (create) repair.ensureDirectory(dir);
  else {
    try { fs.lstatSync(dir); } catch (e) { if (e.code === 'ENOENT') return false; throw e; }
    // Check every ancestor too, not just the leaf folder.
    let current = path.resolve(dir);
    while (true) {
      const stat = fs.lstatSync(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw conflict('Import-protection path must contain only real directories');
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
  return true;
}
function list(siteDir, service) {
  const dir = folder(siteDir, service);
  if (!realDirectory(dir)) return [];
  const records = [];
  const handle = fs.opendirSync(dir);
  try {
    let entry, count = 0;
    while ((entry = handle.readSync())) {
      if (++count > 40) throw conflict('Too many saved import approvals; review .import-repairs before deploying');
      if (!/^[a-f0-9]{24}\.json$/.test(entry.name)) continue;
      const file = path.join(dir, entry.name);
      if (!entry.isFile() || entry.isSymbolicLink() || fs.lstatSync(file).size > MAX_RECORD_BYTES) throw conflict('Unsafe or oversized saved import approval');
      let record;
      try { record = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { throw conflict('Saved import approval is unreadable; review ' + entry.name); }
      if (record.version !== 1 || record.service !== service || recordPath(siteDir, service, record.key) !== file || typeof record.subdir !== 'string' || !record.target || typeof record.target.file !== 'string' || !/^[a-f0-9]{64}$/.test(record.target.digest || '') || !Array.isArray(record.files) || !record.files.length || record.files.length > 50) throw conflict('Invalid saved import approval');
      records.push(record);
    }
  } finally { handle.closeSync(); }
  return records;
}
function disabled(siteDir, service) {
  const dir = folder(siteDir, service);
  if (!realDirectory(dir)) return [];
  const file = path.join(dir, 'disabled.json');
  let stat;
  try { stat = fs.lstatSync(file); } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16384) throw conflict('Unsafe import-protection removal record');
  const keys = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(keys) || keys.length > 200 || keys.some(key => !/^import-repair:[a-f0-9]{24}$/.test(key))) throw conflict('Invalid import-protection removal record');
  return keys;
}
function writeJson(file, value) {
  const temp = file + '.' + crypto.randomBytes(8).toString('hex') + '.tmp';
  try {
    fs.writeFileSync(temp, JSON.stringify(value), { flag: 'wx', mode: 0o600 });
    let stat;
    try { stat = fs.lstatSync(file); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (stat && (!stat.isFile() || stat.isSymbolicLink())) throw conflict('Unsafe import-protection record file');
    fs.renameSync(temp, file);
  } finally { try { fs.unlinkSync(temp); } catch {} }
}
function save(siteDir, service, subdir, approval) {
  const file = recordPath(siteDir, service, approval.key);
  realDirectory(path.dirname(file), true);
  const existing = list(siteDir, service);
  if (existing.length >= 20 && !existing.some(r => r.key === approval.key)) throw conflict('Saved import-approval limit reached');
  if (existing.some(r => r.key !== approval.key && r.files.some(f => approval.files.some(c => c.file === f.file)))) throw conflict('Another protected import correction edits the same file. Commit that correction upstream or remove its protection before approving this separate repair');
  const record = { ...approval, version: 1, service, subdir: subdir || '', approvedAt: new Date().toISOString() };
  const data = JSON.stringify(record);
  if (Buffer.byteLength(data) > MAX_RECORD_BYTES) throw conflict('Import approval is too large to persist');
  const skipped = disabled(siteDir, service);
  writeJson(file, record);
  if (skipped.includes(record.key)) writeJson(path.join(path.dirname(file), 'disabled.json'), skipped.filter(key => key !== record.key));
  return record;
}
function context(codeDir, service, record) {
  if (record.subdir !== (service.subdir || '')) throw conflict(`Protected imports for service '${service.name}' belong to a different build folder`);
  const stat = fs.lstatSync(codeDir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw conflict('Protected import checkout is missing or unsafe');
  const root = fs.realpathSync(codeDir);
  const dest = path.resolve(root, service.subdir || '');
  if (dest !== root && !dest.startsWith(root + path.sep)) throw conflict('Protected import context escapes the repository');
  let current = root;
  for (const part of path.relative(root, dest).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const stat = fs.lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw conflict('Protected import context is missing or unsafe');
  }
  return dest;
}
function migrate(siteDir, service, codeDir) {
  const dir = path.join(siteDir, '.remediation-backups', service.name);
  if (!realDirectory(dir)) return;
  const existing = list(siteDir, service.name);
  const skipped = disabled(siteDir, service.name);
  // Bound discovery of old backups. Never infer approval from arbitrary source.
  const handle = fs.opendirSync(dir);
  try {
    let entry, count = 0;
    while ((entry = handle.readSync())) {
      if (++count > 40) throw conflict('Too many legacy import backups to inspect safely');
      if (!/^[a-f0-9]{64}$/.test(entry.name) || !entry.isDirectory() || entry.isSymbolicLink()) continue;
      if (existing.some(r => r.revision === entry.name)) continue;
      const ctxDir = context(codeDir, service, { subdir: service.subdir || '' });
      const approval = repair.recoverApproval(ctxDir, path.join(dir, entry.name), entry.name);
      if (approval && !skipped.includes(approval.key) && !existing.some(r => r.key === approval.key)) existing.push(save(siteDir, service.name, service.subdir, approval));
    }
  } finally { handle.closeSync(); }
}
function run(siteDir, services, codeDir, mode, log = () => {}) {
  const work = [];
  for (const service of services.filter(s => s.enabled !== false && !/^db(-|$)/.test(s.name))) {
    for (const record of list(siteDir, service.name)) {
      const ctxDir = context(codeDir, service, record);
      try { repair.validateApproval(ctxDir, record); }
      catch (e) { throw conflict(`Protected import repair for '${service.name}' needs review: ${e.message}. Open Deploy to review a new preview or remove this protection. Running containers are untouched`); }
      work.push({ service, record, ctxDir });
    }
  }
  const changed = [];
  for (const { service, record, ctxDir } of work) {
    const backupRoot = path.join(siteDir, '.remediation-backups', service.name, mode === 'suspend' ? 'sync' : 'replay');
    let result;
    if (mode === 'suspend') {
      result = repair.suspend(ctxDir, record, (file, before) => {
        try {
          const rel = path.relative(codeDir, path.join(ctxDir, file)).split(path.sep).join('/');
          const head = execFileSync('git', ['show', 'HEAD:' + rel], { cwd: codeDir, encoding: 'utf8', maxBuffer: repair.LIMITS.fileBytes + 1 });
          // An upstream commit already containing the approved correction must
          // not be undone. In that case Git sees no local modification.
          if (head.replace(/\r\n/g, '\n') === record.files.find(f => f.file === file).after.replace(/\r\n/g, '\n')) return 'fixed';
          return head.replace(/\r\n/g, '\n') === before.replace(/\r\n/g, '\n');
        } catch { return false; }
      }, { backupRoot });
    } else result = repair.replay(ctxDir, record, { backupRoot });
    if (result.applied.length) {
      changed.push(service.name);
      log(`${mode === 'suspend' ? 'temporarily removed' : 'reapplied'} approved import repair for '${service.name}': ${result.applied.join(', ')}`);
    } else log(`verified approved import repair for '${service.name}' (no source write needed)`);
  }
  return [...new Set(changed)];
}
function cards(siteDir, services) {
  return services.flatMap(service => list(siteDir, service.name).map(record => ({
    kind: 'import-protection', service: service.name, subdir: record.subdir, protectionKey: record.key, revision: digest(record),
    title: `Protected import correction: ${record.target.file}`,
    detail: `Approved ${record.approvedAt}. Retained outside Git and checked on every deployment. Only the exact approved imports and unchanged destination may be replayed. Changed or ambiguous source stops for review. Remove protection to trust repository source instead; this does not undo current edits.`,
    files: record.files.map(f => f.file), preview: ''
  })));
}
function remove(siteDir, service, key, revision) {
  const record = list(siteDir, service).find(r => r.key === key);
  if (!record || digest(record) !== revision) throw conflict('Saved import approval changed - refresh before removing protection');
  const skipped = [...new Set([...disabled(siteDir, service), key])];
  if (skipped.length > 200) throw conflict('Import-protection removal limit reached; review the saved registry');
  // A removal must not be silently undone by legacy backup enrollment later.
  writeJson(path.join(folder(siteDir, service), 'disabled.json'), skipped);
  fs.unlinkSync(recordPath(siteDir, service, key));
}
module.exports = { save, list, migrate, run, cards, remove };
