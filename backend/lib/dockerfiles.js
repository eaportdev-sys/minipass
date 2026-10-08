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
const LEGACY = { node: [oldNode, oldSimpleNode], react: [oldReact, oldViteReact, oldLooseReact, oldUnmarkedReact, firstReact] };
const normalized = text => text.replace(/\r\n/g, '\n').trim();

function refreshStandardDockerfile(ctxDir, type, templatesDir) {
  if (!LEGACY[type]) return 'unchanged';
  const file = path.join(ctxDir, 'Dockerfile');
  let current;
  try { current = fs.readFileSync(file, 'utf8'); }
  catch (e) { if (e.code === 'ENOENT') return 'missing'; throw e; }
  const template = fs.readFileSync(path.join(templatesDir, type, 'Dockerfile'), 'utf8');
  if (normalized(current) === normalized(template)) return 'current';
  if (!LEGACY[type].some(old => normalized(current) === old)) return 'custom';
  fs.writeFileSync(file, template);
  return 'updated';
}

module.exports = { refreshStandardDockerfile };
