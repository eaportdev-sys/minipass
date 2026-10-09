// Bounded, read-only source inspection. Only propose replacing a missing
// relative named-import path when one existing module declares all required
// exports. Matching exports are evidence, not proof of intended behavior:
// every change is previewed and explicitly approved before it is written.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const parser = require('@babel/parser');
const LIMITS = { files: 600, bytes: 8 * 1024 * 1024, fileBytes: 256 * 1024, entries: 15000, depth: 16 };
const EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs'];
const SKIP = new Set(['.git', 'node_modules', 'vendor', 'dist', 'build', 'out', 'coverage', '.next', '.nuxt', '.output', '.cache', '.minipass-import-repairs']);
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const slash = value => value.split(path.sep).join('/');
const conflict = message => Object.assign(new Error(message), { status: 409 });
function safeFile(root, rel) {
  if (!/^[A-Za-z0-9_.\/-]+$/.test(rel || '') || rel.startsWith('/') || rel.split('/').some(s => !s || s === '..' || s === '.' || SKIP.has(s))) return null;
  let file = root;
  try {
    const parts = rel.split('/');
    for (let i = 0; i < parts.length; i++) {
      file = path.join(file, parts[i]);
      const stat = fs.lstatSync(file);
      if (stat.isSymbolicLink() || (i < parts.length - 1 ? !stat.isDirectory() : !stat.isFile())) return null;
    }
    return file;
  } catch { return null; }
}
function bindings(node) {
  if (!node) return [];
  if (node.type === 'Identifier') return [node.name];
  if (node.type === 'RestElement') return bindings(node.argument);
  if (node.type === 'AssignmentPattern') return bindings(node.left);
  if (node.type === 'ArrayPattern') return node.elements.flatMap(bindings);
  if (node.type === 'ObjectPattern') return node.properties.flatMap(p => bindings(p.value || p.argument));
  return [];
}
function declared(node) {
  const value = new Set(), type = new Set();
  if (!node) return { value, type };
  const names = node.type === 'VariableDeclaration' ? node.declarations.flatMap(d => bindings(d.id)) : bindings(node.id);
  const typeOnly = ['TSInterfaceDeclaration', 'TSTypeAliasDeclaration'].includes(node.type);
  if (typeOnly || node.declare) names.forEach(n => type.add(n));
  else if (['VariableDeclaration', 'FunctionDeclaration', 'ClassDeclaration', 'TSEnumDeclaration'].includes(node.type)) names.forEach(n => value.add(n));
  if (['ClassDeclaration', 'TSEnumDeclaration'].includes(node.type)) names.forEach(n => type.add(n));
  return { value, type };
}
function inspect(text, file) {
  const jsx = /\.(?:tsx|jsx|js|mjs|cjs)$/i.test(file);
  const ast = parser.parse(text, { sourceType: 'unambiguous', plugins: ['typescript', 'decorators-legacy', ...(jsx ? ['jsx'] : [])] });
  const body = ast.program.body;
  const locals = { value: new Set(), type: new Set() };
  const exports = { value: new Set(), type: new Set() };
  for (const node of body) {
    const defs = declared(node.type === 'ExportNamedDeclaration' ? node.declaration : node);
    for (const kind of ['value', 'type']) for (const name of defs[kind]) locals[kind].add(name);
  }
  for (const node of body) {
    if (node.type !== 'ExportNamedDeclaration' || node.source) continue; // no guessed re-exports
    const defs = declared(node.declaration);
    for (const kind of ['value', 'type']) for (const name of defs[kind]) exports[kind].add(name);
    for (const spec of node.specifiers) {
      if (spec.type !== 'ExportSpecifier' || spec.local.type !== 'Identifier' || spec.exported.type !== 'Identifier') continue;
      const typeOnly = node.exportKind === 'type' || spec.exportKind === 'type';
      if (!typeOnly && locals.value.has(spec.local.name)) exports.value.add(spec.exported.name);
      if (locals.type.has(spec.local.name) || (typeOnly && locals.value.has(spec.local.name))) exports.type.add(spec.exported.name);
    }
  }
  // Re-exports and namespace/default imports cannot be inferred from a symbol
  // match. Keep them in a missing-path group so it cannot be partially repaired.
  const imports = body.filter(n => ['ImportDeclaration', 'ExportNamedDeclaration', 'ExportAllDeclaration'].includes(n.type) && n.source);
  return { exports, imports };
}
function scan(ctxDir, limits = LIMITS) {
  const root = fs.realpathSync(ctxDir), files = [];
  let complete = true, entriesSeen = 0, bytes = 0;
  const walk = (dir, rel = '', depth = 0) => {
    if (depth > limits.depth) { complete = false; return; }
    let entries;
    try {
      entries = [];
      const handle = fs.opendirSync(dir);
      try {
        let entry;
        while ((entry = handle.readSync())) {
          if (++entriesSeen > limits.entries) { complete = false; break; }
          entries.push(entry);
        }
      } finally { handle.closeSync(); }
      entries.sort((a, b) => a.name.localeCompare(b.name));
    }
    catch { complete = false; return; }
    for (const entry of entries) {
      if (SKIP.has(entry.name)) continue;
      if (entry.isSymbolicLink()) { complete = false; continue; }
      const relative = rel ? rel + '/' + entry.name : entry.name;
      if (entry.isDirectory()) walk(path.join(dir, entry.name), relative, depth + 1);
      else if (entry.isFile() && EXTENSIONS.some(ext => entry.name.toLowerCase().endsWith(ext)) && !/\.d\.[mc]?ts$/i.test(entry.name)) {
        const file = safeFile(root, relative);
        if (!file) { complete = false; continue; }
        try {
          const size = fs.statSync(file).size;
          if (size > limits.fileBytes || bytes + size > limits.bytes || files.length >= limits.files) { complete = false; continue; }
          bytes += size;
          const buffer = fs.readFileSync(file);
          const text = buffer.toString('utf8');
          if (!Buffer.from(text, 'utf8').equals(buffer)) { complete = false; continue; }
          files.push({ file: relative, text, ...inspect(text, relative) });
        } catch { complete = false; }
      }
    }
  };
  walk(root);
  return { root, files, complete };
}
function missingBase(root, source, request) {
  if (!/^\.\.?\//.test(request) || !/^[A-Za-z0-9_.\/-]+$/.test(request)) return null;
  const dest = path.resolve(root, path.dirname(source), request);
  if (!dest.startsWith(root + path.sep)) return null;
  const rel = slash(path.relative(root, dest));
  if (rel.split('/').some(s => SKIP.has(s))) return null;
  const ext = path.extname(request);
  if (ext && !EXTENSIONS.includes(ext)) return null;
  const base = ext ? dest.slice(0, -ext.length) : dest;
  const possibilities = [dest, ...EXTENSIONS.map(e => base + e), base + '.d.ts', ...EXTENSIONS.map(e => path.join(dest, 'index' + e))];
  // Existing symlinks/opaque files are not a license to redirect an import.
  if (possibilities.some(f => { try { const stat = fs.lstatSync(f); return stat.isFile() || stat.isSymbolicLink() || (f === dest && stat.isDirectory()); } catch { return false; } })) return null;
  return slash(path.relative(root, base));
}
function replacementRequest(source, request, target) {
  const oldExt = path.extname(request), newExt = path.extname(target);
  let targetPath = target.slice(0, -newExt.length);
  if (oldExt) {
    const compatible = oldExt === newExt || (oldExt === '.js' && newExt === '.ts') || (oldExt === '.mjs' && newExt === '.mts') || (oldExt === '.cjs' && newExt === '.cts');
    if (!compatible) return null;
    targetPath += oldExt;
  }
  let rel = path.posix.relative(path.posix.dirname(source), targetPath);
  if (!rel.startsWith('.')) rel = './' + rel;
  return rel;
}
function plans(ctxDir, limits) {
  const scanned = scan(ctxDir, limits);
  const groups = new Map();
  for (const source of scanned.files) for (const node of source.imports) {
    const request = node.source.value;
    const base = missingBase(scanned.root, source.file, request);
    if (!base) continue;
    if (!groups.has(base)) groups.set(base, []);
    const requirements = node.type === 'ImportDeclaration' ? node.specifiers.map(spec => spec.type === 'ImportSpecifier' && spec.imported.type === 'Identifier'
      ? { name: spec.imported.name, typeOnly: node.importKind === 'type' || spec.importKind === 'type' } : null) : [];
    groups.get(base).push({ source, node, request, requirements, eligible: requirements.length > 0 && requirements.every(Boolean) && node.end - node.start <= 4096 });
  }
  const result = [];
  const catalogue = scanned.files.map(f => [f.file, hash(f.text)]).sort((a, b) => a[0].localeCompare(b[0]));
  for (const [base, refs] of groups) {
    if (result.length >= 20) break;
    const requirements = refs.flatMap(ref => ref.requirements).filter(Boolean);
    const importerPaths = new Set(refs.map(ref => ref.source.file.replace(/\.(?:tsx?|jsx?|[mc]ts|[mc]js)$/, '')));
    const candidates = scanned.files.filter(file => !refs.some(ref => ref.source.file === file.file) && requirements.length && requirements.every(req => file.exports.value.has(req.name) || (req.typeOnly && file.exports.type.has(req.name))) &&
      !file.imports.some(node => {
        if (!/^\.\.?\//.test(node.source.value)) return false;
        const target = slash(path.relative(scanned.root, path.resolve(scanned.root, path.dirname(file.file), node.source.value))).replace(/\.(?:tsx?|jsx?|[mc]ts|[mc]js)$/, '');
        return missingBase(scanned.root, file.file, node.source.value) === base || importerPaths.has(target) || importerPaths.has(target + '/index');
      }));
    const diagnostic = reason => ({ kind: 'diagnostic', unresolved: base, title: `Unresolved source import: ${base}`,
      detail: `'${base}' cannot be resolved by this source check. ${reason} Affected files: ${[...new Set(refs.map(ref => ref.source.file))].join(', ')}. Minipass will not generate code or choose an ambiguous module.`, files: [], preview: '' });
    if (!scanned.complete) { result.push({ public: diagnostic('The bounded source scan was incomplete; no import edit can be verified.') }); continue; }
    if (refs.length > 50 || refs.some(ref => !ref.eligible)) { result.push({ public: diagnostic('This import includes an unsupported/default/namespace/re-export form or exceeds the repair limit; review it manually.') }); continue; }
    if (candidates.length !== 1) { result.push({ public: diagnostic(candidates.length ? `Multiple modules declare the required exports: ${candidates.map(f => f.file).slice(0, 8).join(', ')}.` : 'No existing module declaring all required named exports was found.') }); continue; }
    const target = candidates[0];
    const edits = refs.map(ref => ({ ...ref, to: replacementRequest(ref.source.file, ref.request, target.file) }));
    if (edits.some(edit => !edit.to)) { result.push({ public: diagnostic('The candidate uses an incompatible import extension; changing module-resolution rules would be unsafe.') }); continue; }
    const changes = new Map();
    const diff = [];
    for (const edit of edits) {
      const source = edit.source;
      if (!changes.has(source.file)) changes.set(source.file, { file: source.file, before: source.text, edits: [] });
      const quote = source.text[edit.node.source.start];
      const replacement = quote + edit.to + quote;
      changes.get(source.file).edits.push({ start: edit.node.source.start, end: edit.node.source.end, replacement });
      const before = source.text.slice(edit.node.start, edit.node.end);
      const offset = edit.node.source.start - edit.node.start;
      const after = before.slice(0, offset) + replacement + before.slice(edit.node.source.end - edit.node.start);
      diff.push(`--- a/${source.file}\n+++ b/${source.file}\n@@ line ${edit.node.loc.start.line} @@\n` + before.split('\n').map(l => '-' + l).join('\n') + '\n' + after.split('\n').map(l => '+' + l).join('\n'));
    }
    for (const change of changes.values()) {
      change.after = change.before;
      for (const edit of change.edits.sort((a, b) => b.start - a.start)) change.after = change.after.slice(0, edit.start) + edit.replacement + change.after.slice(edit.end);
    }
    const key = 'import-repair:' + hash([base, target.file]).slice(0, 24);
    const revision = hash([catalogue, key, [...changes.values()].map(c => [c.file, c.after])]);
    result.push({ root: scanned.root, changes: [...changes.values()], public: {
      key, kind: 'import-repair', unresolved: base, title: `Correct imports to ${target.file}`,
      detail: `Source check: '${base}' is unresolved. '${target.file}' is the only eligible scanned module declaring all required exports (${[...new Set(requirements.map(req => req.name))].join(', ')}). Review that it is the intended implementation; matching names alone cannot prove behavior. Only import paths in ${changes.size} file(s) will change. Existing implementations, Dockerfiles and lockfiles stay untouched. Apply explicitly, then use local rebuild. Commit the changes to your repository for future deployments.`,
      files: [...changes.keys()], preview: diff.join('\n\n'), revision, nextDeploy: 'local'
    } });
  }
  return result;
}
function suggest(ctxDir, limits) { return plans(ctxDir, limits).map(plan => plan.public); }
function hasImport(ctxDir, file, request) {
  try {
    const full = safeFile(fs.realpathSync(ctxDir), String(file || '').replace(/\\/g, '/'));
    if (!full || fs.statSync(full).size > LIMITS.fileBytes) return false;
    return inspect(fs.readFileSync(full, 'utf8'), file).imports.some(node => node.source.value === request);
  } catch { return false; }
}
function ensureDirectory(directory) {
  const full = path.resolve(directory), root = path.parse(full).root;
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
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw conflict('Import-repair backup path must contain only real directories');
  }
}
function apply(ctxDir, suggestion, { backupRoot = path.join(ctxDir, '.minipass-import-repairs') } = {}) {
  const plan = plans(ctxDir).find(p => p.public.key === suggestion.key);
  if (!plan || plan.public.revision !== suggestion.revision) throw conflict('Source files or candidate exports changed - refresh the import-repair preview');
  const backupDir = path.join(backupRoot, plan.public.revision);
  const prepared = [], swapped = [];
  try {
    ensureDirectory(backupDir);
    for (const change of plan.changes) {
      const file = safeFile(plan.root, change.file);
      if (!file || fs.readFileSync(file, 'utf8') !== change.before) throw conflict('Source changed - refresh the preview');
      const backup = path.join(backupDir, change.file);
      ensureDirectory(path.dirname(backup));
      if (fs.existsSync(backup)) {
        const existing = safeFile(backupDir, change.file);
        if (!existing || fs.readFileSync(existing, 'utf8') !== change.before) throw conflict('Existing import-repair backup differs; it will not be overwritten');
      } else fs.writeFileSync(backup, change.before, { flag: 'wx', mode: 0o600 });
      const temp = file + '.minipass-import-' + crypto.randomBytes(8).toString('hex');
      const item = { ...change, relative: change.file, file, temp };
      prepared.push(item);
      fs.writeFileSync(temp, change.after, { flag: 'wx', mode: fs.statSync(file).mode });
    }
    // Recheck the entire source catalogue before replacing the first file.
    const current = plans(ctxDir).find(p => p.public.key === suggestion.key);
    if (!current || current.public.revision !== suggestion.revision) throw conflict('Source changed while preparing the import repair - refresh the preview');
    for (const item of prepared) {
      if (safeFile(plan.root, item.relative) !== item.file || fs.readFileSync(item.file, 'utf8') !== item.before) throw conflict('Source changed while applying the import repair');
      fs.renameSync(item.temp, item.file);
      swapped.push(item);
    }
    return { applied: plan.public.files, nextDeploy: 'local', backup: backupDir };
  } catch (e) {
    const unrestored = [];
    for (const item of swapped.reverse()) {
      const temp = item.file + '.minipass-import-rollback-' + crypto.randomBytes(8).toString('hex');
      try {
        if (!safeFile(plan.root, slash(path.relative(plan.root, item.file))) || fs.readFileSync(item.file, 'utf8') !== item.after) throw new Error('source changed');
        fs.writeFileSync(temp, item.before, { flag: 'wx', mode: fs.statSync(item.file).mode });
        fs.renameSync(temp, item.file);
      } catch { unrestored.push(slash(path.relative(plan.root, item.file))); }
      finally { try { fs.unlinkSync(temp); } catch {} }
    }
    if (unrestored.length) throw new Error(`Import repair only partially restored; review ${unrestored.join(', ')}. Original files remain in ${backupDir}. ${e.message}`);
    throw e;
  } finally {
    for (const item of prepared) { try { if (safeFile(plan.root, item.relative) === item.file) fs.unlinkSync(item.temp); } catch {} }
  }
}
module.exports = { LIMITS, suggest, apply, inspect, hasImport };
