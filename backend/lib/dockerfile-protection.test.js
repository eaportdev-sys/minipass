const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const fix = require('./dockerfile-fix');
const protection = require('./dockerfile-protection');
const dirs = [];
const DOCKERFILE = [
  'FROM node:20-alpine AS build',
  'RUN apk add --no-cache python3 build-base',
  'WORKDIR /app',
  'COPY package*.json ./',
  'RUN npm install',
  'COPY . .',
  'RUN npm run build',
  'FROM nginx:alpine',
  'COPY --from=build /app/dist /usr/share/nginx/html',
  ''
].join('\n');
const PKG = JSON.stringify({ name: 'template', scripts: { build: 'vite build', prepare: 'is-ci || lefthook install' } });
const ERROR = 'Error: exec: "git": executable file not found in $PATH\n' +
  "required: { node: '>=24' }, current: { node: 'v20.20.2', npm: '10.8.2' }\nERROR: process \"/bin/sh -c npm install\" did not complete successfully";
const service = { name: 'app', enabled: true, subdir: '' };
function fixture() {
  const site = fs.mkdtempSync(path.join(os.tmpdir(), 'minipass-protected-dockerfile-'));
  dirs.push(site);
  const code = path.join(site, 'code');
  fs.mkdirSync(code, { recursive: true });
  fs.writeFileSync(path.join(code, 'Dockerfile'), DOCKERFILE);
  fs.writeFileSync(path.join(code, 'package.json'), PKG);
  return { site, code };
}
const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' });
function init(f) {
  git(f.code, ['init', '-b', 'main']);
  git(f.code, ['config', 'user.name', 'Dockerfile fix test']);
  git(f.code, ['config', 'user.email', 'test@example.invalid']);
  git(f.code, ['config', 'core.autocrlf', 'false']);
  git(f.code, ['add', '.']);
  git(f.code, ['commit', '-m', 'Original recipe']);
}
function approve(f) {
  fix.noteEvidence(f.code, ERROR);
  const proposal = fix.suggest(f.code).find(s => s.key);
  fix.apply(f.code, proposal, { backupRoot: path.join(f.site, '.remediation-backups', 'app'),
    beforeApply: approval => protection.save(f.site, 'app', '', approval) });
  return protection.list(f.site, 'app')[0];
}
const read = f => fs.readFileSync(path.join(f.code, 'Dockerfile'), 'utf8');
try {
  const f = fixture();
  init(f);
  const record = approve(f);
  assert(record && record.fixed.includes('node:24-alpine') && record.fixed.includes('apk add --no-cache git'));
  assert(read(f).includes('node:24-alpine'));

  // Ordinary redeploy: suspend for pull, unrelated upstream change, replay.
  protection.run(f.site, [service], f.code, 'suspend');
  assert.equal(read(f), DOCKERFILE, 'only the approved adaptation is removed before sync');
  const upstream = fs.mkdtempSync(path.join(os.tmpdir(), 'minipass-dockerfile-upstream-'));
  dirs.push(upstream);
  git(upstream, ['-c', 'core.autocrlf=false', 'clone', f.code, '.']);
  git(upstream, ['config', 'user.name', 'Dockerfile fix test']);
  git(upstream, ['config', 'user.email', 'test@example.invalid']);
  fs.writeFileSync(path.join(upstream, 'readme.txt'), 'upstream update\n');
  git(upstream, ['add', '.']);
  git(upstream, ['commit', '-m', 'Unrelated upstream update']);
  git(f.code, ['pull', '--ff-only', upstream, 'main']);
  assert.deepEqual(protection.run(f.site, [service], f.code, 'replay'), ['app']);
  assert(read(f).includes('node:24-alpine') && fs.existsSync(path.join(f.code, 'readme.txt')));

  // Upstream bumps node itself but still below requirement: rebase, keep working.
  fs.writeFileSync(path.join(upstream, 'Dockerfile'), DOCKERFILE.replace('node:20-alpine', 'node:22-alpine'));
  git(upstream, ['add', '.']);
  git(upstream, ['commit', '-m', 'Upstream tries node 22']);
  protection.run(f.site, [service], f.code, 'suspend');
  git(f.code, ['pull', '--ff-only', upstream, 'main']);
  assert.deepEqual(protection.run(f.site, [service], f.code, 'replay'), ['app']);
  assert(read(f).includes('node:24-alpine'), 'same adaptation rebases onto the new upstream recipe');

  // Upstream fixes everything itself: stop for review, never overwrite.
  fs.writeFileSync(path.join(upstream, 'Dockerfile'), DOCKERFILE.replace('node:20-alpine', 'node:24-alpine').replace('RUN apk add --no-cache python3 build-base', 'RUN apk add --no-cache python3 git'));
  git(upstream, ['add', '.']);
  git(upstream, ['commit', '-m', 'Upstream fixes the recipe']);
  protection.run(f.site, [service], f.code, 'suspend');
  git(f.code, ['pull', '--ff-only', upstream, 'main']);
  assert.throws(() => protection.run(f.site, [service], f.code, 'replay'), /no longer matches/);
  const upstreamFixed = read(f);
  assert(upstreamFixed.includes('node:24-alpine') && !upstreamFixed.includes('minipass'), 'review stop never rewrites upstream work');
  const card = protection.cards(f.site, [service])[0];
  assert(card.protectionKey && card.kind === 'dockerfile-protection');
  assert.throws(() => protection.remove(f.site, 'app', card.protectionKey, 'stale'), /changed/);
  protection.remove(f.site, 'app', card.protectionKey, card.revision);
  assert.equal(protection.list(f.site, 'app').length, 0);
  assert.equal(read(f), upstreamFixed, 'removing protection does not undo the recipe');

  // Hand-edited box recipe blocks the deploy before any build.
  const g = fixture();
  init(g);
  approve(g);
  fs.writeFileSync(path.join(g.code, 'Dockerfile'), read(g) + '# hand edit\n');
  assert.throws(() => protection.run(g.site, [{ ...service }], g.code, 'replay'), /no longer matches/);

  // Build-time env approvals replay across pulls the same way.
  const p = fixture();
  fs.writeFileSync(path.join(p.code, 'Dockerfile'), 'FROM node:24-alpine AS build\nWORKDIR /app\nCOPY package*.json ./\nRUN npm install\nCOPY . .\n');
  fs.writeFileSync(path.join(p.code, 'package.json'), JSON.stringify({ scripts: { postinstall: 'prisma generate' } }));
  fs.mkdirSync(path.join(p.code, 'prisma'));
  fs.writeFileSync(path.join(p.code, 'prisma/schema.prisma'), 'datasource db {\n  provider = "postgresql"\n  url = env("DATABASE_URL")\n}\n');
  init(p);
  const PRISMA_ERROR = 'Cannot resolve environment variable: DATABASE_URL.\nnpm error command failed\nnpm error command sh -c prisma generate';
  fix.noteEvidence(p.code, PRISMA_ERROR);
  const pProposal = fix.suggest(p.code).find(s => s.key);
  fix.apply(p.code, pProposal, { backupRoot: path.join(p.site, '.remediation-backups', 'app'),
    beforeApply: approval => protection.save(p.site, 'app', '', approval) });
  assert(fs.readFileSync(path.join(p.code, 'Dockerfile'), 'utf8').includes('ARG DATABASE_URL=postgresql://'));
  assert.deepEqual(protection.run(p.site, [service], p.code, 'replay'), [], 'already-applied env needs no rewrite');
  protection.run(p.site, [service], p.code, 'suspend');
  assert(!fs.readFileSync(path.join(p.code, 'Dockerfile'), 'utf8').includes('ARG DATABASE_URL='), 'suspend removes only the approved ARG');
  assert.deepEqual(protection.run(p.site, [service], p.code, 'replay'), ['app']);

  // Symlinked registry or checkout is refused.
  const h = fixture();
  init(h);
  approve(h);
  const sink = fixture();
  fs.renameSync(path.join(h.site, '.dockerfile-fixes'), path.join(sink.site, 'stolen'));
  fs.symlinkSync(path.join(sink.site, 'stolen'), path.join(h.site, '.dockerfile-fixes'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => protection.run(h.site, [service], h.code, 'replay'), /real directories/);
  console.log('Protected Dockerfile: approve/suspend/pull/replay, upstream rebase, review stops, hand-edit refusal and removal: OK');
} finally { for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true }); }
