const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { refreshStandardDockerfile, standardDockerfileType } = require('./dockerfiles');
const templates = path.resolve(__dirname, '../../templates');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'minipass-native-build-'));

// Exact legacy patterns from dockerfiles.js - using template literals for CMD strings
// previousNativeNode
const previousNativeNode = [
  '# minipass template',
  'FROM node:20-alpine',
  '# Native npm modules can fall back to compiling when no Alpine binary exists.',
  'RUN apk add --no-cache python3 build-base autoconf automake libtool nasm pkgconf',
  'WORKDIR /app',
  'COPY package*.json ./',
  'RUN npm install',
  'COPY . .',
  'RUN npm run build --if-present',
  'EXPOSE 3000',
  "# Prefer the project's declared start command; retain the zero-config index.js fallback.",
  `CMD ["sh", "-c", "if node -e \\"const p=require('./package.json');process.exit(p.scripts&&p.scripts.start?0:1)\\"; then exec npm start; else exec node index.js; fi"]`
].join('\n');

// oldNode
const oldNode = [
  'FROM node:20-alpine',
  'WORKDIR /app',
  'COPY package*.json ./',
  'RUN npm install',
  'COPY . .',
  'RUN npm run build --if-present',
  'EXPOSE 3000',
  "# Prefer the project's declared start command; retain the zero-config index.js fallback.",
  `CMD ["sh", "-c", "if node -e \\"const p=require('./package.json');process.exit(p.scripts&&p.scripts.start?0:1)\\"; then exec npm start; else exec node index.js; fi"]`
].join('\n');

// oldSimpleNode
const oldSimpleNode = [
  'FROM node:20-alpine', 'WORKDIR /app', 'COPY package*.json ./',
  'RUN npm i --omit=dev || true', 'COPY . .', 'EXPOSE 3000', 'CMD ["node", "index.js"]'
].join('\n');

// previousNativeReact
const previousNativeReact = [
  '# minipass template',
  '# build stage + serve (vite emits dist/, CRA emits build/ - normalized to dist/)',
  'FROM node:20-alpine AS build',
  '# Build tools stay in this stage; the serving image remains nginx-only.',
  'RUN apk add --no-cache python3 build-base autoconf automake libtool nasm pkgconf',
  'WORKDIR /app',
  'COPY package*.json ./',
  'RUN npm install',
  'COPY . .',
  'RUN npm run build && (test -d dist || (test -d build && mv build dist) || (echo "BUILD PRODUCED NO dist/ or build/ - add a build script emitting one of them or pick another type" && exit 1))',
  'FROM nginx:alpine',
  '# vite default (+ SPA fallback so deep links like /signup/warehouse load directly):',
  'COPY nginx.conf /etc/nginx/conf.d/default.conf',
  'COPY --from=build /app/dist /usr/share/nginx/html', 'EXPOSE 80'
].join('\n');

// oldReact
const oldReact = [
  '# minipass template',
  '# build stage + serve (vite emits dist/, CRA emits build/ - normalized to dist/)',
  'FROM node:20-alpine AS build', 'WORKDIR /app', 'COPY package*.json ./',
  'RUN npm i || true', 'COPY . .',
  'RUN npm run build && (test -d dist || (test -d build && mv build dist) || (echo "BUILD PRODUCED NO dist/ or build/ - add a build script emitting one of them or pick another type" && exit 1))',
  'FROM nginx:alpine',
  '# vite default (+ SPA fallback so deep links like /signup/warehouse load directly):',
  'COPY nginx.conf /etc/nginx/conf.d/default.conf',
  'COPY --from=build /app/dist /usr/share/nginx/html', 'EXPOSE 80'
].join('\n');

// oldViteReact = oldReact with two replaces
const oldViteReact = oldReact
  .replace('# build stage + serve (vite emits dist/, CRA emits build/ - normalized to dist/)', '# build stage + serve (vite outputs dist/, CRA outputs build/ - adjust COPY below)')
  .replace('RUN npm run build && (test -d dist || (test -d build && mv build dist) || (echo "BUILD PRODUCED NO dist/ or build/ - add a build script emitting one of them or pick another type" && exit 1))', 'RUN npm run build && test -d dist || (echo "BUILD PRODUCED NO dist/ - add a build script emitting dist/ or pick another type" && exit 1)');

// oldLooseReact = oldViteReact with replace
const oldLooseReact = oldViteReact.replace('RUN npm run build && test -d dist || (echo "BUILD PRODUCED NO dist/ - add a build script emitting dist/ or pick another type" && exit 1)', 'RUN npm run build || echo "no build script, copying src as-is"');

// oldUnmarkedReact = oldLooseReact with replaces
const oldUnmarkedReact = oldLooseReact
  .replace('# minipass template\n', '')
  .replace('# vite default (+ SPA fallback so deep links like /signup/warehouse load directly):', '# vite default:')
  .replace('COPY nginx.conf /etc/nginx/conf.d/default.conf\n', '');

// firstReact = oldUnmarkedReact with replaces
const firstReact = oldUnmarkedReact
  .replace('# build stage + serve (vite outputs dist/, CRA outputs build/ - adjust COPY below)', '# build stage + serve (works for vite/cra: npm run build -> dist/build)')
  .replace('# vite default:\n', '')
  .replace('EXPOSE 80', 'COPY --from=build /app/build /usr/share/nginx/html\nEXPOSE 80');

const LEGACY_NODE = [previousNativeNode, oldNode, oldSimpleNode];
const LEGACY_REACT = [previousNativeReact, oldReact, oldViteReact, oldLooseReact, oldUnmarkedReact, firstReact];

const normalized = text => text.replace(/\r\n/g, '\n').trim();

try {
  // Test 1: Current template structure validation
  for (const type of ['node', 'react']) {
    const template = fs.readFileSync(path.join(templates, type, 'Dockerfile'), 'utf8').replace(/\r\n/g, '\n');
    assert(template.startsWith('# minipass template'), `${type}: has marker`);
    assert(template.includes('FROM node:22-alpine'), `${type}: uses Node 22`);
    for (const tool of ['python3', 'build-base', 'autoconf', 'automake', 'libtool', 'nasm']) assert(template.includes(tool), `${type}: has ${tool}`);
    assert(template.includes('git'), `${type}: has git`);
    // Tools precede dependency installation
    assert(template.indexOf('RUN apk add') < template.lastIndexOf('npm ci'), `${type}: tools precede dependency installation`);
    // Correct order: package manifests first, then install, then source (so lifecycle scripts have schemas)
    assert(template.indexOf('COPY package*.json') < template.lastIndexOf('npm ci'), `${type}: package manifests copied before install`);
    assert(template.lastIndexOf('npm ci') < template.indexOf('COPY . .'), `${type}: source copied after install for lifecycle scripts`);
    assert(!/RUN npm (?:i|install).*\|\| true/.test(template), `${type}: install failures must abort the build`);
    // Build-time ARGs for generators
    assert(template.includes('ARG DATABASE_URL='), `${type}: has DATABASE_URL build arg`);
    assert(template.includes('ARG SHADOW_DATABASE_URL='), `${type}: has SHADOW_DATABASE_URL build arg`);
    assert(template.includes('ARG DIRECT_URL'), `${type}: has DIRECT_URL build arg`);
  }

  // React-specific: runtime stage should not have apk add
  const reactTemplate = fs.readFileSync(path.join(templates, 'react', 'Dockerfile'), 'utf8').replace(/\r\n/g, '\n');
  assert(!reactTemplate.split('FROM nginx:alpine')[1].includes('apk add'), 'React runtime does not contain the toolchain');
  // React should have nginx.conf copy
  assert(reactTemplate.includes('COPY nginx.conf'), 'React template copies nginx.conf');

  // Test 2: Legacy files upgrade to current template
  for (const legacy of LEGACY_NODE) {
    const folder = path.join(tmp, 'node', 'legacy-' + Math.random().toString(36).slice(2));
    fs.mkdirSync(folder, { recursive: true });
    const file = path.join(folder, 'Dockerfile');
    fs.writeFileSync(file, legacy.replace(/\r?\n/g, '\r\n'));
    const result = refreshStandardDockerfile(folder, 'node', templates);
    assert.equal(result, 'updated', 'Node legacy file upgraded');
    const template = fs.readFileSync(path.join(templates, 'node', 'Dockerfile'), 'utf8').replace(/\r\n/g, '\n');
    const upgraded = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
    assert.equal(normalized(upgraded), normalized(template), 'Node upgraded matches current template');
    // Idempotent
    assert.equal(refreshStandardDockerfile(folder, 'node', templates), 'current', 'Node upgrade is idempotent');
  }

  for (const legacy of LEGACY_REACT) {
    const folder = path.join(tmp, 'react', 'legacy-' + Math.random().toString(36).slice(2));
    fs.mkdirSync(folder, { recursive: true });
    const file = path.join(folder, 'Dockerfile');
    fs.writeFileSync(file, legacy.replace(/\r?\n/g, '\r\n'));
    const result = refreshStandardDockerfile(folder, 'react', templates);
    assert.equal(result, 'updated', 'React legacy file upgraded');
    const template = fs.readFileSync(path.join(templates, 'react', 'Dockerfile'), 'utf8').replace(/\r\n/g, '\n');
    const upgraded = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
    assert.equal(normalized(upgraded), normalized(template), 'React upgraded matches current template');
    // Idempotent
    assert.equal(refreshStandardDockerfile(folder, 'react', templates), 'current', 'React upgrade is idempotent');
  }

  // Test 3: Custom files are not rewritten
  for (const type of ['node', 'react']) {
    const template = fs.readFileSync(path.join(templates, type, 'Dockerfile'), 'utf8').replace(/\r\n/g, '\n');
    const folder = path.join(tmp, type, 'custom');
    fs.mkdirSync(folder, { recursive: true });
    const file = path.join(folder, 'Dockerfile');
    const custom = template + '\nRUN echo custom-build\n';
    fs.writeFileSync(file, custom);
    assert.equal(refreshStandardDockerfile(folder, type, templates), 'custom', `${type}: retained marker does not authorize rewriting custom files`);
    assert.equal(fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n'), custom, `${type}: custom file preserved`);
  }

  // Test 4: Repository-owned files are not touched
  for (const type of ['node', 'react']) {
    const folder = path.join(tmp, type, 'repo-owned');
    fs.mkdirSync(folder, { recursive: true });
    const file = path.join(folder, 'Dockerfile');
    fs.writeFileSync(file, 'FROM node:22\nRUN echo repository-owned\n');
    assert.equal(refreshStandardDockerfile(folder, type, templates), 'custom', `${type}: repository-owned file not rewritten`);
  }

  // Test 5: Missing Dockerfile returns 'missing'
  for (const type of ['node', 'react']) {
    const folder = path.join(tmp, type, 'missing');
    fs.mkdirSync(folder, { recursive: true });
    assert.equal(refreshStandardDockerfile(folder, type, templates), 'missing', `${type}: missing Dockerfile returns missing`);
  }

  // Test 6: Simple Node template (oldSimpleNode pattern) upgrades
  const simple = 'FROM node:20-alpine\nWORKDIR /app\nCOPY package*.json ./\nRUN npm i --omit=dev || true\nCOPY . .\nEXPOSE 3000\nCMD ["node", "index.js"]\n';
  const simpleFolder = path.join(tmp, 'node', 'simple');
  fs.mkdirSync(simpleFolder, { recursive: true });
  fs.writeFileSync(path.join(simpleFolder, 'Dockerfile'), simple);
  assert.equal(refreshStandardDockerfile(simpleFolder, 'node', templates), 'updated', 'simple Node template upgrades');

  // Test 7: standardDockerfileType detection
  for (const type of ['node', 'react', 'static']) {
    const template = fs.readFileSync(path.join(templates, type, 'Dockerfile'), 'utf8').replace(/\r\n/g, '\n');
    const folder = path.join(tmp, type, 'detect');
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, 'Dockerfile'), template);
    assert.equal(standardDockerfileType(folder, templates), type, `${type}: standardDockerfileType detects current template`);
  }
  // Legacy detection
  const folder = path.join(tmp, 'node', 'detect-legacy');
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, 'Dockerfile'), previousNativeNode);
  assert.equal(standardDockerfileType(folder, templates), 'node', 'legacy Node detected');

  console.log('native npm toolchain and exact-match standard Dockerfile upgrades: OK');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}