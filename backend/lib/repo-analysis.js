// Repository analysis used by service creation and managed-database wiring.
// Read-only: never runs repository code or rewrites build files.
const path = require('path');
const { decideType, findBackends, findFrontends, prismaDatabaseHints, sqlDatabaseHints, databaseConfigHints } = require('./detect');
const { standardDockerfileType, findDockerfiles } = require('./dockerfiles');
const { inventory, readSource } = require('./repository-files');


function readText(file) {
  try {
    return readSource(file).text || '';
  } catch { return ''; }
}
function readJson(file) {
  try { return JSON.parse(readText(file)); } catch { return null; }
}
function collectPaths(root) {
  return inventory(root, { read: false }).files;
}

function analyzeService(ctxDir, type, subdir) {
  const paths = collectPaths(ctxDir);
  const pkg = readJson(path.join(ctxDir, 'package.json'));
  const detected = decideType(paths, pkg);
  const hints = [...(detected.dbs || []), ...prismaDatabaseHints(readText(path.join(ctxDir, 'prisma/schema.prisma')))];
  for (const p of paths) {
    if (/\.sql$/i.test(p)) hints.push(...sqlDatabaseHints(readText(path.join(ctxDir, p))));
    if (/(knexfile|ormconfig|drizzle|typeorm|sequelize|config\/database)/i.test(p)) {
      hints.push(...databaseConfigHints(p, readText(path.join(ctxDir, p))));
    }
  }
  return { subdir, type, databaseNeeds: [...new Set(hints)].filter(db => db !== 'sqlite') };
}

function analyzeRepository(codeDir) {
  const paths = collectPaths(codeDir);
  const pkg = readJson(path.join(codeDir, 'package.json'));
  const typeResult = decideType(paths, pkg);
  const pkgs = {};
  for (const p of paths) if (p.endsWith('package.json')) pkgs[p.slice(0, -13) || '.'] = readJson(path.join(codeDir, p));
  const frontends = findFrontends(paths, pkgs);
  const backends = findBackends(paths, pkgs, frontends);
  const services = [];
  const rootScripts = (pkg && pkg.scripts) || {};
  let rootDockerfileIsRuntime = false;
  try {
    rootDockerfileIsRuntime = findDockerfiles(codeDir).some(file => !standardDockerfileType(codeDir, path.resolve(__dirname, '../../templates'), file));
  } catch {}
  const rootHasRuntimeMarker = !!(paths.includes('package.json') && (
    rootScripts.start || paths.some(p => /^(?:next|nuxt)\.config\.(?:js|mjs|cjs|ts)$/.test(p)) ||
    paths.some(p => /^(?:server|index|app)\.(?:js|mjs|cjs|ts)$/.test(p)) ||
    paths.includes('composer.json') || paths.includes('index.php') || paths.includes('index.html') || rootDockerfileIsRuntime
  ));
  const hasSubApps = frontends.length || backends.length;
  if (typeResult.type && (!hasSubApps || rootHasRuntimeMarker)) services.push(analyzeService(codeDir, typeResult.type, ''));
  for (const f of frontends) services.push(analyzeService(path.join(codeDir, f), 'react', f));
  for (const b of backends) services.push(analyzeService(path.join(codeDir, b), 'node', b));
  if (!services.length && typeResult.type) services.push(analyzeService(codeDir, typeResult.type, ''));
  return { services };
}

module.exports = { analyzeRepository, analyzeService };
