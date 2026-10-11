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
  assert.equal(needsDockerfileOptIn(api, 'node'), true, 'Node package without Dockerfile needs explicit opt-in');
  fs.writeFileSync(path.join(api, 'Dockerfile'), 'FROM node:20-alpine\n');
  assert.equal(needsDockerfileOptIn(api, 'node'), false, 'existing Dockerfile never offers replacement');

  const nodeTemplate = fs.readFileSync(path.resolve(__dirname, '../../templates/node/Dockerfile'), 'utf8');
  assert(nodeTemplate.includes('RUN npm run build --if-present'), 'standard Node image builds compiled projects');
  assert(nodeTemplate.includes('exec npm start'), 'standard Node image uses a declared start script');
  assert(nodeTemplate.includes('exec node index.js'), 'standard Node image retains the simple index.js fallback');

  console.log('service context and Dockerfile validation: OK');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
