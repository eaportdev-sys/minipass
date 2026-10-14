const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { needsDockerfileOptIn } = require('./generator');
const { fullServices, renderProject } = require('./services');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'minipass-services-'));
try {
  fs.mkdirSync(path.join(tmp, 'code', 'client'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'code', 'client', 'Dockerfile'), 'FROM nginx:alpine\nEXPOSE 80\n');
  fs.writeFileSync(path.join(tmp, 'docker-compose.yml'), `services:
  app:
    build:
      context: ././code/client
      dockerfile: Dockerfile
    ports:
      - "8004:80"
    expose:
      - "80"
`);
  const legacy = fullServices({ type: 'react' }, tmp);
  assert.equal(legacy[0].subdir, 'client', 'legacy ././code context retains its real subfolder');
  assert.equal(legacy[0].port, 80);

  const bad = fs.mkdtempSync(path.join(os.tmpdir(), 'minipass-services-bad-compose-'));
  try {
    fs.mkdirSync(path.join(bad, 'code'), { recursive: true });
    fs.writeFileSync(path.join(bad, 'code', 'Dockerfile'), 'FROM node:22-alpine\nEXPOSE 3000\n');
    fs.writeFileSync(path.join(bad, '.env'), 'HOST_PORT=8012\n');
    fs.writeFileSync(path.join(bad, 'docker-compose.yml'), `services:
  app:
    build: ./code
    build:
      args:
        BUILDKIT_INLINE_CACHE: 1
    ports:
      - "8012:3000"
    expose:
      - "3000"
  db-mariadb:
    image: mariadb:11.8

volumes:
  dbdata-mariadb:
`);
    renderProject({ dir: bad, templatesDir: path.resolve(__dirname, '../../templates'), meta: { type: 'node', hostPort: 8012 } });
    const repaired = fs.readFileSync(path.join(bad, 'docker-compose.yml'), 'utf8');
    const appBlock = repaired.match(/  app:\n([\s\S]*?)(?:\n  [a-z0-9-]+:|\nvolumes:|$)/)[1];
    assert.equal((appBlock.match(/^    build:/gm) || []).length, 1, 'renderProject repairs duplicate build keys');
    assert(appBlock.includes('BUILDKIT_INLINE_CACHE: 1'), 'inline cache arg is retained inside the single build block');
    assert(repaired.includes('  db-mariadb:'), 'database services are preserved while repairing app compose');
  } finally { fs.rmSync(bad, { recursive: true, force: true }); }

  const api = path.join(tmp, 'code', 'server');
  fs.mkdirSync(api, { recursive: true });
  fs.writeFileSync(path.join(api, 'package.json'), '{"scripts":{"start":"node dist/index.js"}}');
  assert.equal(needsDockerfileOptIn(api, 'node'), false, 'Node package with a start script can use the standard Dockerfile');
  fs.writeFileSync(path.join(api, 'Dockerfile'), 'FROM node:20-alpine\n');
  assert.equal(needsDockerfileOptIn(api, 'node'), false, 'existing Dockerfile never offers replacement');

  const nodeTemplate = fs.readFileSync(path.resolve(__dirname, '../../templates/node/Dockerfile'), 'utf8');
  assert(nodeTemplate.includes('npm run build --if-present') && nodeTemplate.includes('pnpm run build --if-present'), 'standard Node image builds compiled projects with the detected manager');
  assert(nodeTemplate.includes('start:built') && nodeTemplate.includes('next start'), 'standard Node image prefers production start scripts/framework start');
   assert(nodeTemplate.includes("'index.js'") && nodeTemplate.includes('exec node'), 'standard Node image retains the simple index.js fallback alongside declared main/server entrypoints');

  const { serviceBlock } = require('./generator');
  const rootDefault = serviceBlock({ svcName: 'app', ctx: './code', port: 3000, host: 8000, portEnv: null });
  assert(!/dockerfile:/.test(rootDefault), 'root default omits the dockerfile line (legacy bytes)');
  const rootVariant = serviceBlock({ svcName: 'app', ctx: './code', port: 3000, host: 8000, portEnv: null, dockerfile: 'Dockerfile.web' });
  assert(rootVariant.includes('dockerfile: Dockerfile.web'), 'root variant names its build file');
  const subDefault = serviceBlock({ svcName: 'web', ctx: './code/web', port: 80, host: 8001, portEnv: 'PORT_WEB' });
  assert(subDefault.includes('dockerfile: Dockerfile'), 'subfolder default keeps the explicit line (legacy bytes)');

  // renderProject builds with the detected variant, never seeds over it
  const variant = fs.mkdtempSync(path.join(os.tmpdir(), 'minipass-services-variant-'));
  try {
    fs.mkdirSync(path.join(variant, 'code'), { recursive: true });
    fs.writeFileSync(path.join(variant, 'code', 'Dockerfile.web'), 'FROM node:24-alpine\nEXPOSE 3000\n');
    fs.writeFileSync(path.join(variant, '.env'), 'HOST_PORT=8000\n');
    fs.writeFileSync(path.join(variant, 'docker-compose.yml'), 'services:\n  app:\n    build:\n      context: ./code\n      args:\n        BUILDKIT_INLINE_CACHE: 1\n    ports:\n      - "8000:3000"\n    expose:\n      - "3000"\n');
    const meta = { type: 'node', hostPort: 8000, services: [{ name: 'app', subdir: '', type: 'node', port: 3000, hostPort: 8000, enabled: true }] };
    renderProject({ dir: variant, templatesDir: path.resolve(__dirname, '../../templates'), meta });
    const yml = fs.readFileSync(path.join(variant, 'docker-compose.yml'), 'utf8');
    assert(yml.includes('dockerfile: Dockerfile.web'), 'compose builds the detected variant');
    assert(!fs.existsSync(path.join(variant, 'code', 'Dockerfile')), 'no template seeded over the variant');
    // a compose file naming a variant migrates the pin forward
    const migrated = fullServices({ type: 'node', hostPort: 8000 }, variant);
    assert.equal(migrated[0].dockerfile, 'Dockerfile.web', 'legacy compose variant migrates to the pin');
    // explicit pin wins even beside an exact file
    fs.writeFileSync(path.join(variant, 'code', 'Dockerfile'), 'FROM node:22\n');
    const pinned = { type: 'node', hostPort: 8000, services: [{ name: 'app', subdir: '', type: 'node', port: 3000, hostPort: 8000, enabled: true, dockerfile: 'Dockerfile.web' }] };
    renderProject({ dir: variant, templatesDir: path.resolve(__dirname, '../../templates'), meta: pinned });
    assert(fs.readFileSync(path.join(variant, 'docker-compose.yml'), 'utf8').includes('dockerfile: Dockerfile.web'), 'stored pin beats the exact file');
    // ambiguous variants render the default here and fail loud at deploy/add time
    fs.writeFileSync(path.join(variant, 'code', 'Dockerfile.api'), 'FROM node:22\n');
    fs.unlinkSync(path.join(variant, 'code', 'Dockerfile'));
    const amb = { type: 'node', hostPort: 8000, services: [{ name: 'app', subdir: '', type: 'node', port: 3000, hostPort: 8000, enabled: true }] };
    renderProject({ dir: variant, templatesDir: path.resolve(__dirname, '../../templates'), meta: amb });
    const ambYml = fs.readFileSync(path.join(variant, 'docker-compose.yml'), 'utf8');
    assert(!/dockerfile:/.test(ambYml), 'ambiguity never auto-picks (default omits the line at root)');
    assert(!fs.existsSync(path.join(variant, 'code', 'Dockerfile')), 'ambiguity never seeds a shadowing template');
  } finally { fs.rmSync(variant, { recursive: true, force: true }); }

  console.log('service context and Dockerfile validation: OK');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
