const fs = require('fs');
const path = require('path');

const SKIP = new Set(['.git', 'build', 'coverage', 'dist', 'node_modules', 'test', 'tests', '__tests__', 'vendor']);
const SOURCE_EXT = /\.(?:cjs|js|jsx|mjs|php|ts|tsx)$/i;

function safeRoute(value) {
  const route = String(value || '').trim();
  if (!route.startsWith('/') || route.length > 120) return null;
  if (!/^\/[A-Za-z0-9._~!&'()+,;=@%/-]*$/.test(route) || /[:*${}\\]/.test(route)) return null;
  return route.replace(/\/{2,}/g, '/');
}

function routeScore(route) {
  const exact = {
    '/health/live': 0, '/health/ready': 1, '/health': 2,
    '/api/health/live': 3, '/api/health/ready': 4, '/api/health': 5,
    '/docs': 6, '/swagger': 7, '/api': 8, '/v1': 9, '/': 20
  };
  if (exact[route] != null) return exact[route];
  if (/health|ready|live/i.test(route)) return 10;
  if (/docs|swagger|openapi/i.test(route)) return 11;
  if (/^\/api(?:\/|$)/i.test(route)) return 12;
  return 15;
}

function extractRoutes(source) {
  // Strip comments before matching so examples and disabled routes do not turn
  // into published links. This is deliberately conservative: direct app/server
  // registrations are trusted; router registrations are candidates that still
  // need runtime validation because they may be mounted under a prefix.
  const text = String(source || '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split(/\r?\n/).filter(line => !/^\s*\/\//.test(line)).join('\n');
  const found = [];
  const add = (raw, direct, why) => {
    const route = safeRoute(raw);
    if (route && !found.some(x => x.path === route && x.direct === direct)) found.push({ path: route, direct, why });
  };
  const direct = /\b(app|server|fastify)\s*\.\s*(?:get|route)\s*\(\s*(['"`])(\/[^'"`]*)\2/g;
  const router = /\brouter\s*\.\s*(?:get|route)\s*\(\s*(['"`])(\/[^'"`]*)\1/g;
  const laravel = /\bRoute\s*::\s*get\s*\(\s*(['"])(\/[^'"]*)\1/g;
  let m;
  while ((m = direct.exec(text))) add(m[3], true, `${m[1]}.get`);
  while ((m = laravel.exec(text))) add(m[2], true, 'Route::get');
  while ((m = router.exec(text))) add(m[2], false, 'router.get');
  return found.sort((a, b) => routeScore(a.path) - routeScore(b.path) || a.path.localeCompare(b.path));
}

function detectOpenPaths(root, maxFiles = 250) {
  const found = [];
  let visited = 0;
  const walk = (dir, depth = 0) => {
    if (depth > 5 || visited >= maxFiles) return;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (visited >= maxFiles) break;
      if (entry.isDirectory()) {
        if (!SKIP.has(entry.name)) walk(path.join(dir, entry.name), depth + 1);
        continue;
      }
      if (!entry.isFile() || !SOURCE_EXT.test(entry.name)) continue;
      visited++;
      const file = path.join(dir, entry.name);
      let text = '';
      try {
        const st = fs.statSync(file);
        if (st.size > 512 * 1024) continue;
        text = fs.readFileSync(file, 'utf8');
      } catch { continue; }
      for (const item of extractRoutes(text)) {
        if (!found.some(x => x.path === item.path && x.direct === item.direct)) found.push({ ...item, file: path.relative(root, file).replace(/\\/g, '/') });
      }
    }
  };
  walk(root);
  return found.sort((a, b) => {
    if (a.direct !== b.direct) return a.direct ? -1 : 1;
    return routeScore(a.path) - routeScore(b.path) || a.path.localeCompare(b.path);
  });
}

module.exports = { safeRoute, routeScore, extractRoutes, detectOpenPaths };
