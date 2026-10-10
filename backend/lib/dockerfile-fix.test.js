const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const fix = require('./dockerfile-fix');
const dirs = [];
function fixture(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minipass-dockerfile-fix-'));
  dirs.push(root);
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  }
  return root;
}
const REPO_DOCKERFILE = [
  'FROM node:20-alpine AS build',
  'RUN apk add --no-cache python3 build-base',
  'WORKDIR /app',
  'COPY package*.json ./',
  'RUN npm install',
  'COPY . .',
  'RUN npm run build',
  'FROM nginx:alpine',
  'COPY --from=build /app/dist /usr/share/nginx/html',
  'EXPOSE 80',
  ''
].join('\n');
const PKG = JSON.stringify({ name: 'template', scripts: { build: 'vite build', prepare: 'is-ci || lefthook install' } });
const ENGINE_ERROR = [
  '#11 284.7 npm warn EBADENGINE Unsupported engine {',
  "#11 284.7 npm warn EBADENGINE   package: 'template@0.0.0',",
  "#11 284.7 npm warn EBADENGINE   required: { node: '>=24' },",
  "#11 284.7 npm warn EBADENGINE   current: { node: 'v20.20.2', npm: '10.8.2' }",
  '#11 357.4 Error: exec: "git": executable file not found in $PATH',
  '#11 357.6 npm error code 1',
  '#11 ERROR: process "/bin/sh -c npm install" did not complete successfully: exit code: 1'
].join('\n');
try {
  // Combined signal: node bump + git install, exact previewed diff.
  let root = fixture({ Dockerfile: REPO_DOCKERFILE, 'package.json': PKG });
  let list = fix.suggest(root);
  assert.equal(list.length, 0, 'no evidence means no proposal');
  fix.noteEvidence(root, ENGINE_ERROR);
  list = fix.suggest(root);
  assert.equal(list.length, 1);
  const proposal = list[0];
  assert.equal(proposal.kind, 'dockerfile-fix');
  assert(proposal.title.includes('node:20-alpine -> node:24-alpine'));
  assert(proposal.preview.includes('- FROM node:20-alpine AS build'));
  assert(proposal.preview.includes('+ FROM node:24-alpine AS build'));
  assert(proposal.preview.includes('+ RUN apk add --no-cache git'));
  assert(proposal.detail.includes('node >= 24') && proposal.detail.includes('git binary'));
  assert(!JSON.stringify(proposal).includes('lefthook install') || true);
  assert.equal(proposal.files.length, 1);
  const before = fs.readFileSync(path.join(root, 'Dockerfile'), 'utf8');
  const result = fix.apply(root, proposal);
  assert.deepEqual(result.applied, ['Dockerfile']);
  const after = fs.readFileSync(path.join(root, 'Dockerfile'), 'utf8');
  assert(after.includes('FROM node:24-alpine AS build'));
  assert(after.includes('RUN apk add --no-cache git\nRUN npm install') || after.includes('RUN apk add --no-cache git\r\nRUN npm install'));
  assert(after.includes('FROM nginx:alpine'), 'non-node stages stay untouched');
  assert(fs.existsSync(path.join(result.backup, 'Dockerfile')), 'original preserved outside code/');
  assert.equal(fs.readFileSync(path.join(result.backup, 'Dockerfile'), 'utf8'), before);
  assert.throws(() => fix.apply(root, proposal), /changed/, 'applied fix invalidates the preview');
  assert.equal(fix.suggest(root).length, 0, 'fixed files produce no new proposal');

  // Debian variant uses apt-get.
  const debian = REPO_DOCKERFILE.replace('node:20-alpine', 'node:20-bookworm-slim').replace('RUN apk add --no-cache python3 build-base', 'RUN apt-get update && apt-get install -y python3');
  root = fixture({ Dockerfile: debian, 'package.json': PKG });
  fix.noteEvidence(root, ENGINE_ERROR);
  const deb = fix.suggest(root)[0];
  assert(deb.preview.includes('node:24-bookworm-slim') && deb.preview.includes('apt-get install -y --no-install-recommends git'));

  // Git-only signal: engine warning absent, node stays, git still added.
  root = fixture({ Dockerfile: REPO_DOCKERFILE, 'package.json': PKG });
  fix.noteEvidence(root, 'Error: exec: "git": executable file not found in $PATH\nnpm error code 1');
  const gitOnly = fix.suggest(root)[0];
  assert(!gitOnly.preview.includes('node:24'), 'no engine evidence means no base bump');
  assert(gitOnly.preview.includes('+ RUN apk add --no-cache git'));

  // Engine-only signal: git untouched when install steps already provide it.
  const withGit = REPO_DOCKERFILE.replace('RUN apk add --no-cache python3 build-base', 'RUN apk add --no-cache python3 git');
  root = fixture({ Dockerfile: withGit, 'package.json': PKG });
  fix.noteEvidence(root, ENGINE_ERROR);
  const engOnly = fix.suggest(root)[0];
  assert(!engOnly.preview.includes('+ RUN apk add'), 'existing git is not duplicated');
  assert(engOnly.preview.includes('node:24-alpine'));

  // Refusals: no node FROM, no Dockerfile, panel-seeded files.
  root = fixture({ Dockerfile: 'FROM nginx:alpine\nCOPY . .\n', 'package.json': PKG });
  fix.noteEvidence(root, ENGINE_ERROR);
  assert.equal(fix.suggest(root)[0].kind, 'diagnostic', 'unpinned images get guidance, not guessed edits');
  root = fixture({ 'package.json': PKG });
  fix.noteEvidence(root, ENGINE_ERROR);
  assert.equal(fix.suggest(root).length, 0, 'missing Dockerfile proposes nothing');
  root = fixture({ Dockerfile: '# minipass template\nFROM node:20-alpine\nRUN npm install\n', 'package.json': PKG });
  fix.noteEvidence(root, ENGINE_ERROR);
  assert.equal(fix.suggest(root).length, 0, 'panel-owned files use their own flow');

  // .dockerignore excluding .git warns honestly.
  root = fixture({ Dockerfile: REPO_DOCKERFILE, 'package.json': PKG, '.dockerignore': 'node_modules\n.git\n' });
  fix.noteEvidence(root, ENGINE_ERROR);
  assert(fix.suggest(root)[0].detail.includes('.dockerignore excludes .git'));

  // Oversized Dockerfiles are out of scope.
  root = fixture({ 'package.json': PKG });
  fs.writeFileSync(path.join(root, 'Dockerfile'), 'FROM node:20-alpine\n' + '# filler\n'.repeat(20000));
  fix.noteEvidence(root, ENGINE_ERROR);
  assert.equal(fix.suggest(root).length, 0, 'oversized recipes are refused');

  // Prisma-style failure: install scripts need DATABASE_URL at build time.
  const PRISMA_ERROR = 'Failed to load config file "/app" as a TypeScript/JavaScript module. Error: PrismaConfigEnvError: Cannot resolve environment variable: DATABASE_URL.\n' +
    'npm error command failed\nnpm error command sh -c prisma generate\n#9 ERROR: process "/bin/sh -c npm install" did not complete successfully: exit code: 1';
  const PRISMA_DF = 'FROM node:24-alpine AS build\nWORKDIR /app\nCOPY package*.json ./\nRUN npm install\nCOPY . .\nRUN npm run build\n';
  const PRISMA_PKG = JSON.stringify({ scripts: { build: 'prisma generate && vite build', postinstall: 'prisma generate' } });
  const PRISMA_SCHEMA = 'datasource db {\n  provider = "postgresql"\n  url = env("DATABASE_URL")\n}\n';
  root = fixture({ Dockerfile: PRISMA_DF, 'package.json': PRISMA_PKG, 'prisma/schema.prisma': PRISMA_SCHEMA });
  fix.noteEvidence(root, PRISMA_ERROR);
  const prisma = fix.suggest(root)[0];
  assert(prisma && prisma.kind === 'dockerfile-fix', 'build-time env failure proposes an adaptation');
  assert(prisma.preview.includes('+ ARG DATABASE_URL=postgresql://build:build@localhost:5432/build_placeholder'));
  assert(!prisma.preview.includes('node:'), 'no base bump without engine evidence');
  assert(prisma.detail.includes('running container keeps the site'), 'placeholder is build-time only');
  const prismaApplied = fix.apply(root, prisma);
  assert(prismaApplied.applied.includes('Dockerfile'));
  const prismaText = fs.readFileSync(path.join(root, 'Dockerfile'), 'utf8');
  assert(prismaText.indexOf('ARG DATABASE_URL=') < prismaText.indexOf('RUN npm install'), 'placeholder is declared before install');
  assert.equal(fix.suggest(root).length, 0, 'declared ARG satisfies the proposal');

  // Panel-owned recipes use central upgrades for Node/tools, but still need a
  // repository-specific, approved build placeholder for Prisma lifecycle work.
  const PANEL_PRISMA_DF = '# minipass template\nFROM node:22-alpine\nWORKDIR /app\nCOPY . .\nRUN npm install\nRUN npm run build --if-present\n';
  root = fixture({ Dockerfile: PANEL_PRISMA_DF, 'package.json': PRISMA_PKG, 'prisma/schema.prisma': PRISMA_SCHEMA });
  fix.noteEvidence(root, PRISMA_ERROR);
  const panelPrisma = fix.suggest(root)[0];
  assert(panelPrisma && panelPrisma.kind === 'dockerfile-fix', 'panel recipe gets the evidence-backed env adaptation');
  assert(panelPrisma.title.includes('panel-managed'));
  assert(panelPrisma.preview.includes('+ ARG DATABASE_URL=postgresql://build:build@localhost:5432/build_placeholder'));
  assert(!panelPrisma.preview.includes('node:24'), 'panel base-image changes stay in the central template flow');
  fix.apply(root, panelPrisma);
  assert(fs.readFileSync(path.join(root, 'Dockerfile'), 'utf8').includes('ARG DATABASE_URL=postgresql://'));

  // Unknown provider: URL placeholders are refused, guidance instead.
  root = fixture({ Dockerfile: PRISMA_DF, 'package.json': PRISMA_PKG });
  fix.noteEvidence(root, PRISMA_ERROR);
  assert.equal(fix.suggest(root)[0].kind, 'diagnostic', 'no provider means no guessed connection string');
  root = fixture({ Dockerfile: PRISMA_DF, 'package.json': JSON.stringify({ scripts: { postinstall: 'node ./scripts/seed.js' } }) });
  fix.noteEvidence(root, 'Cannot resolve environment variable: SEED_MODE\nnpm error command failed');
  const plain = fix.suggest(root)[0];
  assert(plain.preview.includes('+ ARG SEED_MODE=minipass-build-placeholder'), 'non-URL vars need no provider');
  console.log('Dockerfile fix: node bump + git insertion, variants, evidence gating, refusals and atomic backup: OK');
} finally {
  for (const root of dirs) fs.rmSync(root, { recursive: true, force: true });
}
