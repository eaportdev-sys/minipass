const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const envDefaults = require('./env-defaults');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'minipass-env-defaults-'));
try {
  fs.mkdirSync(path.join(tmp, 'server'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'client'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'server', '.env.example'), [
    'CORS_ORIGIN=http://localhost:5173',
    'APP_URL="http://localhost:5173"',
    'JWT_SECRET=change-this-to-a-random-secret',
    'API_SECRET=',
    'NODE_ENV=development'
  ].join('\n'));
  fs.writeFileSync(path.join(tmp, 'client', '.env.example'), [
    'VITE_API_URL=http://localhost:3000/api',
    'REMOTE_ASSET_URL=https://cdn.example.test/assets',
    'ODD_SERVICE=http://localhost:3000/v1'
  ].join('\n'));
  fs.writeFileSync(path.join(tmp, 'server', '.env'), 'FROM_REPO_ENV=kept-once\nAPI_SECRET=actual-local-secret\n');
  const services = [
    { name: 'app', subdir: 'server', type: 'node', port: 3000, hostPort: 8002, enabled: true },
    { name: 'client', subdir: 'client', type: 'react', port: 80, hostPort: 8004, enabled: true }
  ];
  const origins = envDefaults.publishedOrigins(services, '10.0.0.250', 'http');
  assert.equal(origins.frontend, 'http://10.0.0.250:8004');
  assert.equal(origins.backend, 'http://10.0.0.250:8002');
  const stateDir = path.join(tmp, 'panel-state');
  fs.mkdirSync(stateDir);
  const snapshot = envDefaults.snapshotDefaults(stateDir, tmp, services);
  assert(snapshot.sources.includes('server/.env'));
  assert(snapshot.sources.includes('server/.env.example'));
  assert.equal(snapshot.values.FROM_REPO_ENV, 'kept-once');
  assert.equal(snapshot.values.API_SECRET, 'actual-local-secret');
  assert(snapshot.originals.API_SECRET.includes(''));
  assert.notEqual(snapshot.values.JWT_SECRET, 'change-this-to-a-random-secret');
  const savedJwtSecret = snapshot.values.JWT_SECRET;
  fs.writeFileSync(path.join(tmp, 'server', '.env'), 'FROM_REPO_ENV=changed-later\n');
  fs.writeFileSync(path.join(tmp, 'server', '.env.example'), 'APP_URL=https://changed.example\n');
  const unchanged = envDefaults.snapshotDefaults(stateDir, tmp, services);
  assert.equal(unchanged.values.FROM_REPO_ENV, 'kept-once');
  assert.equal(unchanged.values.APP_URL, 'http://localhost:5173');
  assert.equal(unchanged.values.JWT_SECRET, savedJwtSecret);
  const result = envDefaults.resolvedDefaults(tmp, services, origins, unchanged.values, unchanged.originals);
  assert.equal(result.values.CORS_ORIGIN, origins.frontend);
  assert.equal(result.values.APP_URL, origins.frontend);
  assert.equal(result.values.VITE_API_URL, origins.backend + '/api');
  assert.equal(result.values.ODD_SERVICE, origins.backend + '/v1');
  assert.equal(result.values.REMOTE_ASSET_URL, 'https://cdn.example.test/assets');
  assert.equal(result.values.NODE_ENV, 'production');
  assert.notEqual(result.values.JWT_SECRET, 'change-this-to-a-random-secret');
  assert(result.values.JWT_SECRET.length >= 40);
  assert.equal(result.values.JWT_SECRET, savedJwtSecret);
  assert.equal(result.values.API_SECRET, 'actual-local-secret');
  assert.equal(envDefaults.correctedValue('CORS_ORIGIN', 'http://localhost:5173,https://custom.example', result, origins), origins.frontend + ',https://custom.example');
  assert.equal(envDefaults.correctedValue('JWT_SECRET', 'change-this-to-a-random-secret', result, origins), result.values.JWT_SECRET);
  assert.equal(envDefaults.correctedValue('API_SECRET', '', result, origins), 'actual-local-secret');
  assert.equal(envDefaults.correctedValue('JWT_SECRET', 'real-user-secret', result, origins), null);
  assert.equal(envDefaults.correctedValue('APP_URL', 'https://custom.example', result, origins), null);
  assert.equal(envDefaults.frontendOrigin([{ type: 'node', hostPort: 8002 }], '10.0.0.250', 'http'), null);
  console.log('repository environment defaults and frontend origins: OK');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
