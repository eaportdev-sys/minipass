const fs = require('fs');
const path = require('path');

// Historical standard files are frozen here. A marker alone is not ownership:
// users may have customized a generated file while retaining its first comment.
const oldNode = [
  'FROM node:20-alpine',
  'WORKDIR /app',
  'COPY package*.json ./',
  'RUN npm install',
  'COPY . .',
  'RUN npm run build --if-present',
  'EXPOSE 3000',
  "# Prefer the project's declared start command; retain the zero-config index.js fallback.",
  'CMD ["sh", "-c", "if node -e \\"const p=require(\'./package.json\');process.exit(p.scripts&&p.scripts.start?0:1)\\"; then exec npm start; else exec node index.js; fi"]'
].join('\n');
const oldSimpleNode = [
  'FROM node:20-alpine', 'WORKDIR /app', 'COPY package*.json ./',
  'RUN npm i --omit=dev || true', 'COPY . .', 'EXPOSE 3000', 'CMD ["node", "index.js"]'
].join('\n');
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
  'CMD ["sh", "-c", "if node -e \\"const p=require(\'./package.json\');process.exit(p.scripts&&p.scripts.start?0:1)\\"; then exec npm start; else exec node index.js; fi"]'
].join('\n');
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
const oldViteReact = oldReact
  .replace('# build stage + serve (vite emits dist/, CRA emits build/ - normalized to dist/)', '# build stage + serve (vite outputs dist/, CRA outputs build/ - adjust COPY below)')
  .replace('RUN npm run build && (test -d dist || (test -d build && mv build dist) || (echo "BUILD PRODUCED NO dist/ or build/ - add a build script emitting one of them or pick another type" && exit 1))', 'RUN npm run build && test -d dist || (echo "BUILD PRODUCED NO dist/ - add a build script emitting dist/ or pick another type" && exit 1)');
const oldLooseReact = oldViteReact.replace('RUN npm run build && test -d dist || (echo "BUILD PRODUCED NO dist/ - add a build script emitting dist/ or pick another type" && exit 1)', 'RUN npm run build || echo "no build script, copying src as-is"');
const oldUnmarkedReact = oldLooseReact
  .replace('# minipass template\n', '')
  .replace('# vite default (+ SPA fallback so deep links like /signup/warehouse load directly):', '# vite default:')
  .replace('COPY nginx.conf /etc/nginx/conf.d/default.conf\n', '');
const firstReact = oldUnmarkedReact
  .replace('# build stage + serve (vite outputs dist/, CRA outputs build/ - adjust COPY below)', '# build stage + serve (works for vite/cra: npm run build -> dist/build)')
  .replace('# vite default:\n', '')
  .replace('EXPOSE 80', 'COPY --from=build /app/build /usr/share/nginx/html\nEXPOSE 80');
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
  'COPY --from=build /app/dist /usr/share/nginx/html',
  'EXPOSE 80'
].join('\n');
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
const normalized = text => text.replace(/\r\n/g, '\n').trim();
const previousManagerNode = text => text.startsWith('# minipass template\n# Universal Node.js template') &&
  text.includes('ARG PACKAGE_MANAGER=npm') &&
  (text.includes('RUN npm run build --if-present') || text.includes('pnpm run build --if-present')) &&
  (text.includes('exec npm start; else exec node index.js; fi') || text.includes('No production start script found')) &&
  text.trim().endsWith('"]');
const previousManagerReact = text => text.startsWith('# minipass template\n# Universal React/Vite/CRA/Next') &&
  text.includes('ARG PACKAGE_MANAGER=npm') &&
  (text.includes('RUN npm run build &&') || text.includes('pnpm run build; elif')) &&
  text.includes('COPY --from=build /app/dist /usr/share/nginx/html') &&
  text.trim().endsWith('EXPOSE 80');
const LEGACY = { node: [previousManagerNode, previousNpmNode, previousNativeNode, oldNode, oldSimpleNode], react: [previousManagerReact, previousNpmReact, previousNativeReact, oldReact, oldViteReact, oldLooseReact, oldUnmarkedReact, firstReact] };

function legacyMatch(type, current) {
  const n = normalized(current);
  return (LEGACY[type] || []).some(old => typeof old === 'function' ? old(n) : n === normalized(old));
}

function refreshStandardDockerfile(ctxDir, type, templatesDir) {
  if (!LEGACY[type]) return 'unchanged';
  const file = path.join(ctxDir, 'Dockerfile');
  let current;
  try { current = fs.readFileSync(file, 'utf8'); }
  catch (e) { if (e.code === 'ENOENT') return 'missing'; throw e; }
  const template = fs.readFileSync(path.join(templatesDir, type, 'Dockerfile'), 'utf8');
  if (normalized(current) === normalized(template)) return 'current';
  if (!legacyMatch(type, current)) return 'custom';
  fs.writeFileSync(file, template);
  return 'updated';
}

function standardDockerfileType(ctxDir, templatesDir, filename) {
  let current;
  try {
    const file = path.join(ctxDir, filename || 'Dockerfile');
    if (!fs.lstatSync(file).isFile()) return null;
    current = normalized(fs.readFileSync(file, 'utf8'));
  } catch { return null; }
  for (const type of ['static', 'node', 'react']) {
    let template = '';
    try { template = normalized(fs.readFileSync(path.join(templatesDir, type, 'Dockerfile'), 'utf8')); } catch {}
    if ((template && current === template) || legacyMatch(type, current)) return type;
  }
  return null;
}

// Candidate build files at a service context root: the exact Dockerfile
// first, then Dockerfile.* variants alphabetically (bounded). Repos authored
// for container hosts (Coolify/Dokploy convention) often ship their blessed
// recipe as Dockerfile.web instead of Dockerfile - detection must see those
// instead of silently seeding the generic template over them.
function findDockerfiles(ctxDir, limit = 10) {
  let files = [];
  try { files = fs.readdirSync(ctxDir); } catch { return []; }
  const exact = files.find(f => /^dockerfile$/i.test(f));
  const variants = files.filter(f => /^dockerfile\.[A-Za-z0-9][A-Za-z0-9._-]*$/i.test(f))
    .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
  const out = [...(exact ? [exact] : []), ...variants];
  return out.slice(0, Math.max(1, limit));
}

function validDockerfileName(n) {
  return typeof n === 'string' && n.length <= 64 &&
    /^dockerfile(\.[A-Za-z0-9][A-Za-z0-9._-]*)?$/i.test(n || '');
}

// Effective build file for a service context. selected is the stored service
// choice (exact filename); null selects automatically: exact Dockerfile wins,
// a lone variant is used, several variants fail loud with names (never guess),
// none returns null so callers fall back to seeding/failing as before.
// A legacy panel seed loses to repo variants: the seed was generated, the
// variant was authored. type/templatesDir enable that check - without them
// an exact Dockerfile always wins.
function resolveServiceDockerfile(ctxDir, selected, type, templatesDir) {
  const cands = findDockerfiles(ctxDir);
  const list = cands.length ? cands.join(', ') : 'none found';
  if (selected != null && String(selected) !== '') {
    if (!validDockerfileName(selected)) throw new Error(`bad Dockerfile name '${selected}'`);
    const target = path.join(path.resolve(ctxDir), path.basename(selected));
    let st = null;
    try { st = fs.statSync(target); } catch {}
    if (!st || !st.isFile()) throw new Error(`selected Dockerfile '${selected}' not found in this service folder (found: ${list})`);
    return { file: path.basename(selected), source: 'selected' };
  }
  const exact = cands.find(f => /^dockerfile$/i.test(f));
  const variants = cands.filter(f => !/^dockerfile$/i.test(f));
  if (exact) {
    if (type && templatesDir && variants.length) {
      try {
        if (legacyMatch(type, fs.readFileSync(path.join(ctxDir, exact), 'utf8'))) {
          if (variants.length === 1) return { file: variants[0], source: 'repo-variant' };
          throw new Error(`multiple Dockerfiles found (${[exact, ...variants].join(', ')}) - select the build file in Setup > services`);
        }
      } catch (e) { if (/multiple Dockerfiles/.test(e.message)) throw e; }
    }
    return { file: exact, source: 'repo' };
  }
  if (variants.length === 1) return { file: variants[0], source: 'auto' };
  if (variants.length > 1) throw new Error(`multiple Dockerfiles found (${variants.join(', ')}) - select the build file in Setup > services`);
  return null;
}

module.exports = { refreshStandardDockerfile, standardDockerfileType, findDockerfiles, validDockerfileName, resolveServiceDockerfile };
