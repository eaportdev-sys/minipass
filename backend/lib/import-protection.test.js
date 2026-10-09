const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const repair = require('./import-repair');
const protection = require('./import-protection');
const dirs = [];
const sources = {
  'src/use.ts': 'import { ready } from "./missing";\nexport const value = ready;\n',
  'src/other.ts': 'import { ready as available } from "./missing";\nexport const another = available;\n',
  'src/actual.ts': 'export const ready = true;\n',
  'src/unrelated.ts': 'export const unrelated = 1;\n'
};
const service = { name: 'app', enabled: true, subdir: '' };
function write(root, file, text) { fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); fs.writeFileSync(path.join(root, file), text); }
function fixture(subdir = '') {
  const site = fs.mkdtempSync(path.join(os.tmpdir(), 'minipass-protected-import-'));
  dirs.push(site);
  const code = path.join(site, 'code'), ctx = path.join(code, subdir);
  for (const [file, text] of Object.entries(sources)) write(ctx, file, text);
  return { site, code, ctx, service: { ...service, subdir } };
}
function approve(f) {
  const proposal = repair.suggest(f.ctx).find(s => s.key);
  repair.apply(f.ctx, proposal, { backupRoot: path.join(f.site, '.remediation-backups', f.service.name),
    beforeApply: approval => protection.save(f.site, f.service.name, f.service.subdir, approval) });
  return protection.list(f.site, f.service.name)[0];
}
const read = (f, file) => fs.readFileSync(path.join(f.ctx, file), 'utf8');
const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' });
function init(f) {
  git(f.code, ['init', '-b', 'main']);
  git(f.code, ['config', 'user.name', 'Import repair test']);
  git(f.code, ['config', 'user.email', 'test@example.invalid']);
  git(f.code, ['config', 'core.autocrlf', 'false']);
  git(f.code, ['add', '.']);
  git(f.code, ['commit', '-m', 'Original broken imports']);
}
try {
  let f = fixture();
  init(f);
  const record = approve(f);
  assert(record && record.version === 1 && record.files.length === 2);
  assert(!fs.existsSync(path.join(f.code, '.import-repairs')));
  assert.equal(protection.run(f.site, [f.service], f.code, 'replay').length, 0, 'already-correct imports are not rewritten');
  write(f.ctx, 'src/unrelated.ts', 'export const unrelated = 2;\n');
  protection.run(f.site, [f.service], f.code, 'suspend');
  assert.equal(read(f, 'src/use.ts'), sources['src/use.ts']);
  assert.equal(read(f, 'src/unrelated.ts'), 'export const unrelated = 2;\n', 'sync preparation never resets unrelated box edits');
  assert.deepEqual(protection.run(f.site, [f.service], f.code, 'replay'), ['app']);
  assert(read(f, 'src/use.ts').includes('"./actual"'));
  assert.equal(read(f, 'src/unrelated.ts'), 'export const unrelated = 2;\n');

  // Real Git fast-forward: unrelated upstream commits can arrive while the
  // approved edits are temporarily suspended; no fixture reset discards work.
  const upstream = fs.mkdtempSync(path.join(os.tmpdir(), 'minipass-protected-upstream-'));
  dirs.push(upstream);
  git(upstream, ['-c', 'core.autocrlf=false', 'clone', f.code, '.']);
  git(upstream, ['config', 'user.name', 'Import repair test']);
  git(upstream, ['config', 'user.email', 'test@example.invalid']);
  git(upstream, ['config', 'core.autocrlf', 'false']);
  write(upstream, 'readme.txt', 'upstream update\n');
  git(upstream, ['add', '.']);
  git(upstream, ['commit', '-m', 'Unrelated upstream update']);
  protection.run(f.site, [f.service], f.code, 'suspend');
  git(f.code, ['pull', '--ff-only', upstream, 'main']);
  protection.run(f.site, [f.service], f.code, 'replay');
  assert(fs.existsSync(path.join(f.code, 'readme.txt')));
  assert(read(f, 'src/use.ts').includes('./actual'));
  assert.equal(read(f, 'src/unrelated.ts'), 'export const unrelated = 2;\n');
  const logs = [];
  protection.run(f.site, [f.service], f.code, 'suspend', line => logs.push(line));
  assert.throws(() => git(f.code, ['pull', '--ff-only', path.join(upstream, 'missing'), 'main']));
  protection.run(f.site, [f.service], f.code, 'replay', line => logs.push(line));
  assert(read(f, 'src/use.ts').includes('./actual'), 'failed sync can restore approved edits without a reset');
  assert(logs.some(line => line.includes('temporarily removed')) && logs.some(line => line.includes('reapplied')));

  // Once upstream contains the exact correction, suspend must leave it alone.
  for (const file of record.files) write(upstream, file.file, file.after);
  git(upstream, ['add', '.']);
  git(upstream, ['commit', '-m', 'Fix imports upstream']);
  protection.run(f.site, [f.service], f.code, 'suspend');
  git(f.code, ['pull', '--ff-only', upstream, 'main']);
  assert.deepEqual(protection.run(f.site, [f.service], f.code, 'suspend'), []);
  assert.deepEqual(protection.run(f.site, [f.service], f.code, 'replay'), []);

  // Restart / completely fresh checkout: registry is independent of code/.
  f = fixture('web');
  const saved = approve(f);
  const stage = path.join(f.site, 'stage');
  for (const [file, text] of Object.entries(sources)) write(path.join(stage, 'web'), file, text);
  const restarted = require('./import-protection');
  assert.deepEqual(restarted.run(f.site, [f.service], stage, 'replay'), ['app']);
  assert(fs.readFileSync(path.join(stage, 'web/src/use.ts'), 'utf8').includes('./actual'));
  assert.throws(() => protection.run(f.site, [{ ...f.service, subdir: '' }], stage, 'replay'), /different build folder/);
  for (const changedFile of ['src/use.ts', 'src/actual.ts']) {
    const before = read(f, changedFile);
    write(f.ctx, changedFile, before + '// source changed\n');
    assert.throws(() => protection.run(f.site, [f.service], f.code, 'replay'), /needs review/);
    assert.equal(read(f, changedFile), before + '// source changed\n', 'conflicts never overwrite changed source');
    write(f.ctx, changedFile, before);
  }
  write(f.ctx, 'src/competing.ts', 'export const ready = false;\n');
  assert.throws(() => protection.run(f.site, [f.service], f.code, 'replay'), /no longer unique/);
  fs.unlinkSync(path.join(f.ctx, 'src/competing.ts'));
  write(f.ctx, 'src/new-user.ts', 'import { ready } from "./missing";\n');
  assert.throws(() => protection.run(f.site, [f.service], f.code, 'replay'), /needs review/, 'new import sites require new approval');
  fs.unlinkSync(path.join(f.ctx, 'src/new-user.ts'));
  write(f.ctx, 'broken.ts', 'export const broken = (');
  assert.throws(() => protection.run(f.site, [f.service], f.code, 'replay'), /needs review/, 'incomplete parsing refuses replay');
  fs.unlinkSync(path.join(f.ctx, 'broken.ts'));
  write(f.ctx, 'src/use.ts', saved.files.find(x => x.file === 'src/use.ts').before);
  assert.deepEqual(protection.run(f.site, [f.service], f.code, 'replay'), ['app'], 'a mix of original and already-correct files is supported');
  const card = protection.cards(f.site, [f.service])[0];
  assert(card.protectionKey && !card.key && !card.detail.includes(sources['src/use.ts']), 'UI exposes no original source snapshots');
  assert.throws(() => protection.remove(f.site, 'app', card.protectionKey, 'stale'), /changed/);
  protection.remove(f.site, 'app', card.protectionKey, card.revision);
  assert.equal(protection.list(f.site, 'app').length, 0);
  assert(read(f, 'src/use.ts').includes('./actual'), 'removing protection does not undo source edits');

  // Existing 3820c84 repair is enrolled only from an exact original preview.
  f = fixture();
  let proposal = repair.suggest(f.ctx).find(s => s.key);
  repair.apply(f.ctx, proposal, { backupRoot: path.join(f.site, '.remediation-backups/app') });
  protection.migrate(f.site, f.service, f.code);
  assert.equal(protection.list(f.site, 'app').length, 1);
  protection.migrate(f.site, f.service, f.code);
  assert.equal(protection.list(f.site, 'app').length, 1, 'legacy enrollment is idempotent');
  const legacyCard = protection.cards(f.site, [f.service])[0];
  protection.remove(f.site, 'app', legacyCard.protectionKey, legacyCard.revision);
  protection.migrate(f.site, f.service, f.code);
  assert.equal(protection.list(f.site, 'app').length, 0, 'explicit removal permanently suppresses legacy reenrollment');
  f = fixture();
  proposal = repair.suggest(f.ctx).find(s => s.key);
  repair.apply(f.ctx, proposal, { backupRoot: path.join(f.site, '.remediation-backups/app') });
  write(f.ctx, 'src/use.ts', read(f, 'src/use.ts') + '// later box edit\n');
  protection.migrate(f.site, f.service, f.code);
  assert.equal(protection.list(f.site, 'app').length, 0, 'changed legacy files cannot be auto-approved');

  f = fixture();
  const sink = fixture();
  fs.symlinkSync(sink.site, path.join(f.site, '.import-repairs'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => approve(f), /real directories/);
  assert.equal(read(f, 'src/use.ts'), sources['src/use.ts'], 'failed persistence happens before any source write');
  fs.unlinkSync(path.join(f.site, '.import-repairs'));
  approve(f);
  const file = path.join(f.site, '.import-repairs/app', protection.list(f.site, 'app')[0].key.split(':')[1] + '.json');
  fs.writeFileSync(file, '{broken');
  assert.throws(() => protection.run(f.site, [f.service], f.code, 'replay'), /unreadable/);
  console.log('Protected imports: real Git FF/sync failure/upstream fix, fresh checkout, strict changed/ambiguous/incomplete guards, service scope, legacy approval recovery, safe persistence and explicit removal: OK');
} finally { for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true }); }
