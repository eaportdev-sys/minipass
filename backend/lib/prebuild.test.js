const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const prebuild = require('./prebuild');

const VITE_DOCKERFILE = 'FROM nginx:stable-alpine\nWORKDIR /app\nCOPY . .\nRUN cp -r /app/dist/* /usr/share/nginx/html\nEXPOSE 80\n';
const SELF_BUILDING = 'FROM node:24 AS build\nWORKDIR /app\nCOPY . .\nRUN npm install && npm run build\nFROM nginx:alpine\nCOPY --from=build /app/dist/ /usr/share/nginx/html/\n';
const SEEDED = '# minipass template react\nFROM node:24 AS build\nRUN npm run build\n';

function fixture(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'minipass-prebuild-'));
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), content);
  return dir;
}
const dirs = [];
const pkg = build => JSON.stringify({ name: 'app', scripts: build ? { build } : {} });

let dir = fixture({ Dockerfile: VITE_DOCKERFILE, 'package.json': pkg('tsc && vite build') });
dirs.push(dir);
let plan = prebuild.plan(dir);
assert(plan && plan.outputDir === 'dist' && plan.manager === 'npm' && !plan.blocked, 'vite boilerplate Dockerfile triggers an npm pre-build');

dir = fixture({ Dockerfile: VITE_DOCKERFILE, 'package.json': pkg('tsc && vite build'), 'pnpm-lock.yaml': '' });
dirs.push(dir);
assert.equal(prebuild.plan(dir).manager, 'pnpm', 'pnpm lockfile selects corepack pnpm');

dir = fixture({ Dockerfile: SELF_BUILDING, 'package.json': pkg('vite build') });
dirs.push(dir);
assert.equal(prebuild.plan(dir), null, 'Dockerfiles with their own build step are untouched');

dir = fixture({ Dockerfile: SEEDED, 'package.json': pkg('vite build') });
dirs.push(dir);
assert.equal(prebuild.plan(dir), null, 'panel-seeded Dockerfiles are untouched');

dir = fixture({ Dockerfile: VITE_DOCKERFILE, 'package.json': pkg('vite build') });
dirs.push(dir);
fs.mkdirSync(path.join(dir, 'dist'));
assert.equal(prebuild.plan(dir), null, 'existing output dirs need no pre-build');

dir = fixture({ Dockerfile: VITE_DOCKERFILE, 'package.json': pkg('') });
dirs.push(dir);
assert.equal(prebuild.plan(dir), null, 'repos without a build script keep the loud Docker error');

dir = fixture({ Dockerfile: 'FROM nginx:alpine\nCOPY . .\n', 'package.json': pkg('vite build') });
dirs.push(dir);
assert.equal(prebuild.plan(dir), null, 'Dockerfiles expecting no output dir are untouched');

dir = fixture({ Dockerfile: VITE_DOCKERFILE, 'package.json': pkg('vite build'), '.dockerignore': 'node_modules\ndist\n' });
dirs.push(dir);
plan = prebuild.plan(dir);
assert(plan && plan.blocked && plan.blocked.includes('.dockerignore'), 'dockerignored output fails loud with the reason');

dir = fixture({ Dockerfile: VITE_DOCKERFILE, 'package.json': pkg('x') });
dirs.push(dir);
const args = prebuild.argv('/srv/apps/demo/code', { manager: 'pnpm', outputDir: 'dist' });
assert.deepEqual(args.slice(0, 2), ['run', '--rm']);
assert(args.includes('/srv/apps/demo/code:/build'), 'context travels as one argv element');
assert(args.includes('corepack pnpm install --frozen-lockfile') === false, 'install and build join one sh -c from constants');
assert(args.at(-1).includes('corepack pnpm install --frozen-lockfile') && args.at(-1).includes('corepack pnpm run build'));
assert(!args.at(-1).includes('/srv/apps'), 'no host paths inside the container command');

async function main() {
  const pulls = [];
  await prebuild.ensureBuilderImage(async args => { pulls.push(args); if (args[1] === 'inspect') throw new Error('missing'); return ''; });
  assert.deepEqual(pulls[1], ['image', 'pull', prebuild.BUILDER_IMAGE], 'builder image pulls only when absent');
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  console.log('Pre-build detection: repo-owned dist/build/out triggers, self-builders, seeded files, ignore blocks and argv shape: OK');
}
main().catch(e => { console.error(e); process.exitCode = 1; });
