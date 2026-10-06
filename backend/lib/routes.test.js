const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PROBE_PATHS, safeRoute, routeScore, extractRoutes, detectOpenPaths } = require('./routes');

assert.equal(safeRoute('/health'), '/health');
assert.equal(safeRoute('/users/:id'), null);
assert.equal(safeRoute('${prefix}/health'), null);
assert(PROBE_PATHS.includes('/healthz'));
assert(PROBE_PATHS.includes('/api/healthz'));
assert(routeScore('/healthz') < routeScore('/health'));

const extracted = extractRoutes(`
  // app.get('/disabled', handler)
  app.get('/health', handler)
  app.get("/healthz", function(req, res) { res.send('ok') })
  app.get('/users/:id', handler)
  router.get('/accounts', handler)
  fastify.get('/docs', handler)
  Route::get('/status', handler);
`);
assert(extracted.some(x => x.path === '/health' && x.direct));
assert(extracted.some(x => x.path === '/healthz' && x.direct));
assert(extracted.some(x => x.path === '/docs' && x.direct));
assert(extracted.some(x => x.path === '/status' && x.direct));
assert(extracted.some(x => x.path === '/accounts' && !x.direct));
assert(!extracted.some(x => x.path === '/disabled' || x.path.includes(':')));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'minipass-routes-'));
try {
  fs.mkdirSync(path.join(tmp, 'src'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'node_modules', 'dep'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'src', 'app.ts'), "app.get(\"/healthz\", function(req, res) { res.send('ok') });\n");
  fs.writeFileSync(path.join(tmp, 'node_modules', 'dep', 'index.js'), "app.get('/wrong', fn);\n");
  const routes = detectOpenPaths(tmp);
  assert.equal(routes[0].path, '/healthz');
  assert.equal(routes[0].file, 'src/app.ts');
  assert(!routes.some(x => x.path === '/wrong'));
  console.log('source route detection: OK');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
