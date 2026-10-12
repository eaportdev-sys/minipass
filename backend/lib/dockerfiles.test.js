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

// previousNpmNode: npm-only install block, superseded by the PACKAGE_MANAGER build arg
const previousNpmNode = [
  '# minipass template',
  '# Universal Node.js template — uses pre-built base image with shared cache',
  '# syntax = docker/dockerfile:1.4',
  'FROM minipass/node:22 AS build',
  '',
  '# Build-time environment for generator scripts (prisma generate, drizzle-kit, etc.).',
  '# These are ARG defaults only; the running container uses the site\'s real env.',
  'ARG DATABASE_URL=postgresql://build:build@localhost:5432/build_placeholder',
  'ARG SHADOW_DATABASE_URL=postgresql://build:build@localhost:5432/build_placeholder_shadow',
  'ARG DIRECT_URL',
  '',
  '# Copy package manifests first for optimal layer caching.',
  'COPY package*.json ./',
  '',
  '# Install dependencies with SHARED npm cache mount (persistent across all sites/builds).',
  '# --prefer-offline uses cache when available, falls back to network.',
  'RUN --mount=type=cache,target=/root/.npm,sharing=locked \\',
  '    if [ -f package-lock.json ] || [ -f npm-shrinkwrap.json ]; then \\',
  '      npm ci --prefer-offline; \\',
  '    else \\',
  '      npm install --prefer-offline; \\',
  '    fi',
  '',
  '# Copy source after install so lifecycle scripts (prepare, postinstall) have schemas/configs.',
  'COPY . .',
  '',
  '# Run build script if defined (tsc, nest build, etc.). Harmless if absent.',
  'RUN npm run build --if-present',
  '',
  '# Runtime stage — smaller, no build tools',
  'FROM minipass/node:22-runtime',
  '',
  'WORKDIR /app',
  '',
  '# Copy built application from build stage',
  'COPY --from=build /app/node_modules ./node_modules',
  'COPY --from=build /app/package*.json ./',
  'COPY --from=build /app/dist ./dist 2>/dev/null || true',
  'COPY --from=build /app/build ./build 2>/dev/null || true',
  'COPY --from=build /app ./',
  '',
  'EXPOSE 3000',
  '',
  '# Prefer the project\'s declared start command; retain the zero-config index.js fallback.',
  'CMD ["sh", "-c", "if node -e \\"const p=require(\'./package.json\');process.exit(p.scripts&&p.scripts.start?0:1)\\"; then exec npm start; else exec node index.js; fi"]'
].join('\n');
// previousNpmReact: npm-only install block, superseded by the PACKAGE_MANAGER build arg
const previousNpmReact = [
  '# minipass template',
  '# Universal React/Vite/CRA/Next (static export) template.',
  '# Build stage includes BuildKit cache mount + git + generator placeholders.',
  '# Serve stage is pure nginx - no Node in production image.',
  '# syntax = docker/dockerfile:1.4',
  'FROM minipass/node:22 AS build',
  '',
  '# Build-time environment for generator scripts (prisma generate, etc.).',
  '# These are ARG defaults only; the running container uses the site\'s real env.',
  'ARG DATABASE_URL=postgresql://build:build@localhost:5432/build_placeholder',
  'ARG SHADOW_DATABASE_URL=postgresql://build:build@localhost:5432/build_placeholder_shadow',
  'ARG DIRECT_URL',
  '',
  '# Copy package manifests first for optimal layer caching.',
  'COPY package*.json ./',
  '',
  '# Install dependencies with SHARED npm cache mount (persistent across all sites/builds).',
  '# --prefer-offline uses cache when available, falls back to network.',
  'RUN --mount=type=cache,target=/root/.npm,sharing=locked \\',
  '    if [ -f package-lock.json ] || [ -f npm-shrinkwrap.json ]; then \\',
  '      npm ci --prefer-offline; \\',
  '    else \\',
  '      npm install --prefer-offline; \\',
  '    fi',
  '',
  '# Copy source after install so lifecycle scripts have schemas/configs.',
  'COPY . .',
  '',
  '# Build the production bundle. Vite emits dist/, CRA emits build/.',
  '# Root build scripts for full-stack repos sometimes emit exactly one nested',
  '# frontend bundle (for example web/dist or client/build); normalize that too',
  '# instead of forcing a separate service when the repository already builds root.',
  'RUN npm run build && \\',
  '    if [ -d dist ]; then \\',
  '      true; \\',
  '    elif [ -d build ]; then \\',
  '      mv build dist; \\',
  '    else \\',
  '      outputs="$(find . \\',
  '        -path \'./node_modules\' -prune -o \\',
  '        -path \'*/node_modules\' -prune -o \\',
  '        -mindepth 3 -maxdepth 4 -type f \\( -path \'*/dist/index.html\' -o -path \'*/build/index.html\' \\) -print)"; \\',
  '      count="$(printf \'%s\\n\' "$outputs" | sed \'/^$/d\' | wc -l | tr -d \' \')"; \\',
  '      if [ "$count" = "1" ]; then \\',
  '        out="$(dirname "$(printf \'%s\\n\' "$outputs" | sed \'/^$/d\' | head -n 1)")"; \\',
  '        cp -a "$out" dist; \\',
  '      else \\',
  '        echo "BUILD PRODUCED NO root dist/ or build/. Found $count nested frontend outputs; set the build folder or make the root build emit one dist/."; \\',
  '        exit 1; \\',
  '      fi; \\',
  '    fi',
  '',
  '# Serve stage: pure nginx, no Node.js',
  'FROM nginx:alpine',
  '',
  '# SPA fallback so deep links like /signup/warehouse load directly.',
  'COPY nginx.conf /etc/nginx/conf.d/default.conf',
  'COPY --from=build /app/dist /usr/share/nginx/html',
  '',
  'EXPOSE 80'
].join('\n');
const LEGACY_NODE = [previousNpmNode, previousNativeNode, oldNode, oldSimpleNode];
const LEGACY_REACT = [previousNpmReact, previousNativeReact, oldReact, oldViteReact, oldLooseReact, oldUnmarkedReact, firstReact];

const normalized = text => text.replace(/\r\n/g, '\n').trim();

try {
  const baseNode = fs.readFileSync(path.join(templates, 'base', 'node.Dockerfile'), 'utf8').replace(/\r\n/g, '\n');
  assert(baseNode.includes('python3 build-base'), 'base node image includes native build toolchain for dependency install');
  assert(baseNode.includes('sqlite-dev'), 'base node image includes sqlite headers for better-sqlite3');
  assert(!baseNode.includes('npm install -g /tmp/precompiled'), 'base node image does not globally install optional precompiled tarballs');
  assert(!/COPY[^\n]*(?:2>|\|\|)/.test(baseNode), 'base node image COPY instructions do not use shell redirection');
  const baseScript = fs.readFileSync(path.join(__dirname, '../../build-base-images.sh'), 'utf8').replace(/\r\n/g, '\n');
  assert(baseScript.includes('--tag "${PREFIX}/node:22"') && baseScript.includes('--file templates/base/node.Dockerfile'), 'node:22 tag is built from the build-tool image, not runtime');
  assert(!baseScript.includes('docker tag "${PREFIX}/node:22-runtime" "${PREFIX}/node:22"'), 'node:22 is not an alias to runtime');

  // Test 1: Current template structure validation
  for (const type of ['node', 'react']) {
    const template = fs.readFileSync(path.join(templates, type, 'Dockerfile'), 'utf8').replace(/\r\n/g, '\n');
    assert(template.startsWith('# minipass template'), `${type}: has marker`);
    if (type === 'node') {
      assert(template.includes('FROM minipass/node:22'), 'node: uses minipass base image');
      assert(template.includes('npm ci --prefer-offline'), 'node: uses npm ci with cache');
      assert(template.includes('--mount=type=cache'), 'node: uses BuildKit cache mount');
      assert(template.includes('ARG PACKAGE_MANAGER=npm'), 'node: manager chosen at build time, npm default');
      assert(template.includes('pnpm install --dangerously-allow-all-builds --frozen-lockfile'), 'node: installs pnpm repos non-interactively with corepack');
      assert(template.includes('yarn install --frozen-lockfile'), 'node: installs yarn repos with corepack');
      assert(template.includes('start:built'), 'node: avoids dev start scripts when a production script exists');
    } else {
      assert(template.includes('FROM minipass/node:22 AS build'), 'react: uses minipass base image for build');
      assert(template.includes('FROM nginx:alpine'), 'react: uses nginx for serving');
      assert(template.includes('npm ci --prefer-offline'), 'react: uses npm ci with cache');
      assert(template.includes('ARG PACKAGE_MANAGER=npm'), 'react: manager chosen at build time, npm default');
      assert(template.includes('pnpm install --dangerously-allow-all-builds --frozen-lockfile'), 'react: installs pnpm repos non-interactively with corepack');
      assert(template.includes('yarn install --frozen-lockfile'), 'react: installs yarn repos with corepack');
    }
    // Tools are in base image; template focuses on app build
    // Correct order: source before install so lifecycle scripts have schemas/configs.
    assert(template.indexOf('COPY . .') < template.lastIndexOf('npm ci'), `${type}: source copied before install for lifecycle scripts`);
    assert(!/RUN npm (?:i|install).*\|\| true/.test(template), `${type}: install failures must abort the build`);
    assert(!/COPY[^\n]*(?:2>|\|\|)/.test(template), `${type}: COPY instructions do not use shell redirection`);
    // Build-time ARGs for generators
    assert(template.includes('ARG DATABASE_URL='), `${type}: has DATABASE_URL build arg`);
    assert(template.includes('ARG SHADOW_DATABASE_URL='), `${type}: has SHADOW_DATABASE_URL build arg`);
    assert(template.includes('ARG DIRECT_URL'), `${type}: has DIRECT_URL build arg`);
  }

  // React-specific: runtime stage should use nginx for serving
  const reactTemplate = fs.readFileSync(path.join(templates, 'react', 'Dockerfile'), 'utf8').replace(/\r\n/g, '\n');
  assert(reactTemplate.includes('FROM nginx:alpine'), 'React uses nginx for serving');
  assert(reactTemplate.includes('COPY --from=build /app/dist'), 'React copies built assets');
  assert(reactTemplate.includes('*/dist/index.html'), 'React can normalize a single nested frontend dist output');
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
