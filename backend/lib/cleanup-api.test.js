const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');
const { once } = require('events');

// Isolated live server: no customer metadata, container builds, repository clones,
// or existing admin credentials. Run explicitly for the cleanup release.
async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'minipass-cleanup-api-'));
  const apps = path.join(tmp, 'apps');
  const site = path.join(apps, 'test-cleanup');
  fs.mkdirSync(path.join(site, 'code'), { recursive: true });
  fs.writeFileSync(path.join(site, 'code/index.html'), '<h1>test</h1>');
  fs.writeFileSync(path.join(site, 'code/Dockerfile'), 'FROM nginx:alpine\nEXPOSE 80\n');
  fs.writeFileSync(path.join(site, 'docker-compose.yml'), 'services:\n  app:\n    build: ./code\n    ports:\n      - "8000:80"\n');
  fs.writeFileSync(path.join(site, '.env'), 'APP_NAME=test-cleanup\nPORT=80\nCUSTOM=value\n');
  fs.writeFileSync(path.join(tmp, 'apps.json'), JSON.stringify({ apps: [{ id: 'test-cleanup', name: 'Cleanup fixture', type: 'static', hostPort: 8000, db: [] }] }));
  let child, exit;
  try {
    const listener = net.createServer();
    listener.listen(0, '127.0.0.1');
    await once(listener, 'listening');
    const port = listener.address().port;
    await new Promise(resolve => listener.close(resolve));
    const base = `http://127.0.0.1:${port}`;
    child = spawn(process.execPath, ['server.js'], { cwd: path.resolve(__dirname, '..'),
      env: { ...process.env, PORT: String(port), APPS_DIR: apps, DATA_FILE: path.join(tmp, 'apps.json'), PANEL_DB_FILE: path.join(tmp, 'panel.sqlite') }, stdio: ['ignore', 'pipe', 'pipe'] });
    exit = once(child, 'exit');
    let log = '';
    const capture = b => { log = (log + b).slice(-8000); };
    child.stdout.on('data', capture); child.stderr.on('data', capture);
    let ready = false;
    for (let i = 0; i < 100; i++) {
      if (child.exitCode !== null) throw new Error('Throwaway server exited: ' + log);
      try { ready = (await fetch(base + '/health')).ok; } catch {}
      if (ready) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert(ready, 'throwaway server became ready: ' + log);
    assert.equal((await fetch(base + '/api/apps')).status, 401, 'admin gate preserved');
    const setup = await fetch(base + '/api/panel/setup', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'cleanup-test-password-only', acceptTerms: true }) });
    assert.equal(setup.status, 200);
    const headers = { Cookie: setup.headers.get('set-cookie').split(';')[0], 'Content-Type': 'application/json' };
    const list = await (await fetch(base + '/api/apps', { headers })).json();
    assert.equal(list[0].id, 'test-cleanup');
    assert.equal(list[0].services[0].port, 80);
    const services = await (await fetch(base + '/api/apps/test-cleanup/services', { headers })).json();
    assert.equal(services.services[0].name, 'app');
    const env = await (await fetch(base + '/api/apps/test-cleanup/env', { headers })).json();
    assert(env.vars.some(v => v.key === 'CUSTOM' && v.value === 'value'));
    assert.equal((await fetch(base + '/api/apps/test-cleanup/preflight', { headers })).status, 404, 'abandoned local report endpoint removed');
    assert.equal((await fetch(base + '/api/github/preflight', { method: 'POST', headers, body: JSON.stringify({ repo: 'not-a-real-repository' }) })).status, 404, 'abandoned clone/report endpoint removed without Git execution');
    const ui = await (await fetch(base + '/')).text();
    assert(ui.includes('id="svcList"'));
    const accounts = await (await fetch(base + '/accounts.js')).text();
    assert(accounts.includes('function dbLabel(') && !accounts.includes('function dirtyBadge('));
    console.log('Cleanup API: isolated authenticated server, active site/env/services/UI retained; orphan endpoints 404: OK');
  } finally {
    if (child && child.exitCode === null) child.kill();
    if (exit) await exit;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
main().catch(e => { console.error(e); process.exitCode = 1; });
