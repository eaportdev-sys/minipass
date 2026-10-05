const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { needsDockerfileOptIn } = require('./generator');
const { fullServices } = require('./services');

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
