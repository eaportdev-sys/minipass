// Retained Dockerfile build-environment approvals. Lives outside code/ and is
// never a Git commit. Only byte-exact, revalidated adaptations may be replayed
// or suspended for pull; anything else stops the deploy before any build.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const fix = require('./dockerfile-fix');
const MAX_RECORD_BYTES = 256 * 1024;
const digest = record => crypto.createHash('sha256').update(JSON.stringify(record)).digest('hex');
const conflict = message => Object.assign(new Error(message), { status: 409 });
function folder(siteDir, service) {
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(service || '')) throw conflict('Invalid Dockerfile-fix service');
  return path.join(siteDir, '.dockerfile-fixes', service);
}
function recordPath(siteDir, service, key) {
  if (!/^dockerfile-fix:[A-Za-z0-9_.\/-]{1,120}$/.test(key || '')) throw conflict('Invalid Dockerfile-fix key');
  return path.join(folder(siteDir, service), 'approval.json');
}
function realDirectory(dir, create = false) {
  if (create) {
    const full = path.resolve(dir), root = path.parse(full).root;
    let current = root;
    for (const part of full.slice(root.length).split(path.sep)) {
      if (!part) continue;
      current = path.join(current, part);
      let stat;
      try { stat = fs.lstatSync(current); }
      catch (e) {
        if (e.code !== 'ENOENT') throw e;
        fs.mkdirSync(current, { mode: 0o700 });
        stat = fs.lstatSync(current);
      }
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw conflict('Dockerfile-fix path must contain only real directories');
    }
    return true;
  }
  try { fs.lstatSync(dir); } catch (e) { if (e.code === 'ENOENT') return false; throw e; }
  let current = path.resolve(dir);
  while (true) {
    const stat = fs.lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw conflict('Dockerfile-fix path must contain only real directories');
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return true;
}
function readRecord(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_RECORD_BYTES) throw conflict('Unsafe saved Dockerfile approval');
  let record;
  try { record = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { throw conflict('Saved Dockerfile approval is unreadable'); }
  if (record.version !== 1 || typeof record.key !== 'string' || typeof record.base !== 'string' || typeof record.fixed !== 'string' ||
      typeof record.name !== 'string' || typeof record.subdir !== 'string' || typeof record.toMajor !== 'number') throw conflict('Invalid saved Dockerfile approval');
  if (record.envAdded !== undefined && (!Array.isArray(record.envAdded) || record.envAdded.some(l => typeof l !== 'string'))) throw conflict('Invalid saved Dockerfile approval');
  record.envAdded = record.envAdded || [];
  return record;
}
function list(siteDir, service) {
  const dir = folder(siteDir, service);
  if (!realDirectory(dir)) return [];
  const file = path.join(dir, 'approval.json');
  try { fs.lstatSync(file); } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  const record = readRecord(file);
  if (record.service !== service || recordPath(siteDir, service, record.key) !== file) throw conflict('Invalid saved Dockerfile approval');
  return [record];
}
function save(siteDir, service, subdir, approval) {
  const file = recordPath(siteDir, service, approval.key);
  realDirectory(path.dirname(file), true);
  const existing = list(siteDir, service);
  if (existing.length && existing[0].key !== approval.key) throw conflict('Another Dockerfile adaptation is already protected for this service; remove it first');
  const record = { ...approval, version: 1, service, subdir: subdir || '', approvedAt: new Date().toISOString() };
  const data = JSON.stringify(record);
  if (Buffer.byteLength(data) > MAX_RECORD_BYTES) throw conflict('Dockerfile approval is too large to persist');
  const temp = file + '.' + crypto.randomBytes(8).toString('hex') + '.tmp';
  try {
    fs.writeFileSync(temp, data, { flag: 'wx', mode: 0o600 });
    let stat;
    try { stat = fs.lstatSync(file); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (stat && (!stat.isFile() || stat.isSymbolicLink())) throw conflict('Unsafe saved Dockerfile-approval file');
    fs.renameSync(temp, file);
  } finally { try { fs.unlinkSync(temp); } catch {} }
  return record;
}
function context(codeDir, service, record) {
  if (record.subdir !== (service.subdir || '')) throw conflict(`Protected Dockerfile for service '${service.name}' belongs to a different build folder`);
  let stat;
  try { stat = fs.lstatSync(codeDir); } catch { throw conflict('Protected Dockerfile checkout is missing'); }
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw conflict('Protected Dockerfile checkout is missing or unsafe');
  const root = fs.realpathSync(codeDir);
  const dest = path.resolve(root, service.subdir || '');
  if (dest !== root && !dest.startsWith(root + path.sep)) throw conflict('Protected Dockerfile context escapes the repository');
  let current = root;
  for (const part of path.relative(root, dest).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const s = fs.lstatSync(current);
    if (!s.isDirectory() || s.isSymbolicLink()) throw conflict('Protected Dockerfile context is missing or unsafe');
  }
  return dest;
}
function dockerfilePath(ctxDir, record) {
  if (!/^dockerfile$/i.test(record.name || '')) throw conflict('Protected Dockerfile name is invalid');
  const file = path.join(ctxDir, record.name);
  let stat;
  try { stat = fs.lstatSync(file); } catch { throw conflict(`Protected Dockerfile '${record.name}' is missing`); }
  if (!stat.isFile() || stat.isSymbolicLink()) throw conflict(`Protected Dockerfile '${record.name}' is unsafe`);
  return file;
}
// Re-derive the adaptation against current files. Returns 'fixed' (already
// applied), 'base' (needs replay), 'rebase' (upstream changed but the same
// adaptation still derives cleanly) or throws for review.
function classify(ctxDir, record) {
  const file = dockerfilePath(ctxDir, record);
  const text = fs.readFileSync(file, 'utf8');
  if (text === record.fixed) return 'fixed';
  if (text === record.base) return 'base';
  fix.noteEvidence(ctxDir, evidenceFor(record));
  const fresh = fix.plans(ctxDir).find(p => p.key === record.key);
  const sameEnv = JSON.stringify((fresh && fresh._plan.envAdded) || []) === JSON.stringify(record.envAdded);
  if (fresh && fresh._plan.toMajor === record.toMajor && fresh._plan.gitAdded === record.gitAdded && sameEnv) {
    record.base = fresh._plan.base;
    record.fixed = fresh._plan.fixed;
    record.revision = fresh.revision;
    return 'rebase';
  }
  throw conflict(`Protected Dockerfile adaptation for '${record.name}' no longer matches: upstream or box edits changed the recipe. Review a new preview or remove this protection. Running containers are untouched`);
}
function evidenceFor(record) {
  // Re-derivation needs the original failure shape, not the log itself: the
  // adaptation signature (pinned tags, required major, git line) is enough.
  const parts = [];
  if (record.gitAdded) parts.push('Error: exec: "git": executable file not found in $PATH');
  if (record.toMajor) parts.push(`required: { node: '>=${record.toMajor}' } current: { node: 'v0.0.0' }`);
  for (const line of record.envAdded) {
    const m = line.match(/^ARG\s+([A-Z_][A-Z0-9_]*)=/);
    if (m) parts.push(`Cannot resolve environment variable: ${m[1]}\nnpm error command failed`);
  }
  return parts.join('\n');
}
function writeFile(file, text) {
  const temp = file + '.minipass-df-' + crypto.randomBytes(8).toString('hex');
  try {
    fs.writeFileSync(temp, text, { flag: 'wx', mode: fs.statSync(file).mode });
    fs.renameSync(temp, file);
  } finally { try { fs.unlinkSync(temp); } catch {} }
}
function run(siteDir, services, codeDir, mode, log = () => {}) {
  const work = [];
  for (const service of services.filter(s => s.enabled !== false && !/^db(-|$)/.test(s.name))) {
    for (const record of list(siteDir, service.name)) {
      const ctxDir = context(codeDir, service, record);
      work.push({ service, record: { ...record }, ctxDir });
    }
  }
  const changed = [];
  for (const { service, record, ctxDir } of work) {
    const file = dockerfilePath(ctxDir, record);
    if (mode === 'suspend') {
      const state = classify(ctxDir, record);
      if (state === 'fixed') {
        let head = null;
        try {
          const rel = path.relative(codeDir, file).split(path.sep).join('/');
          head = execFileSync('git', ['show', 'HEAD:' + rel], { cwd: codeDir, encoding: 'utf8', maxBuffer: 256 * 1024 });
        } catch { head = null; }
        if (head !== null && head.replace(/\r\n/g, '\n') === record.fixed.replace(/\r\n/g, '\n')) {
          log(`verified protected Dockerfile adaptation for '${service.name}' is already upstream (no source write needed)`);
          continue;
        }
        if (head === null || head.replace(/\r\n/g, '\n') !== record.base.replace(/\r\n/g, '\n')) throw conflict(`Cannot safely remove the protected Dockerfile adaptation in '${record.name}' before Git sync; repository HEAD differs. Review or commit the adaptation first`);
        writeFile(file, record.base);
        changed.push(service.name);
        log(`temporarily removed protected Dockerfile adaptation for '${service.name}': ${record.name}`);
      } else if (state === 'base') {
        log(`verified protected Dockerfile adaptation for '${service.name}' (already at upstream recipe)`);
      } else {
        throw conflict(`Protected Dockerfile adaptation for '${service.name}' needs review before Git sync. Running containers are untouched`);
      }
    } else {
      const state = classify(ctxDir, record);
      if (state === 'fixed') {
        log(`verified protected Dockerfile adaptation for '${service.name}' (no source write needed)`);
      } else if (state === 'base' || state === 'rebase') {
        if (state === 'rebase') {
          const stored = recordPath(siteDir, service.name, record.key);
          const full = { ...readRecord(stored), base: record.base, fixed: record.fixed, revision: record.revision };
          fs.writeFileSync(stored, JSON.stringify(full), { mode: 0o600 });
          log(`rebased protected Dockerfile adaptation for '${service.name}' onto the updated upstream recipe`);
        }
        writeFile(file, record.fixed);
        changed.push(service.name);
        log(`reapplied protected Dockerfile adaptation for '${service.name}': ${record.name}`);
      }
    }
  }
  return [...new Set(changed)];
}
function cards(siteDir, services) {
  return services.flatMap(service => list(siteDir, service.name).map(record => ({
    kind: 'dockerfile-protection', service: service.name, subdir: record.subdir, protectionKey: record.key, revision: digest(record),
    title: `Protected Dockerfile adaptation: ${record.name}`,
    detail: `Approved ${record.approvedAt}. Retained outside Git and checked on every deployment. Only the exact approved recipe may be replayed. Upstream recipe changes stop deployment for review. Remove protection to trust repository source instead; this does not undo current edits.`,
    files: [record.name], preview: ''
  })));
}
function remove(siteDir, service, key, revision) {
  const record = list(siteDir, service).find(r => r.key === key);
  if (!record || digest(record) !== revision) throw conflict('Saved Dockerfile approval changed - refresh before removing protection');
  fs.unlinkSync(recordPath(siteDir, service, key));
}
module.exports = { save, list, run, cards, remove };
