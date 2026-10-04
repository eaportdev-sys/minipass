// Stack detection from a repo file listing. Pure function - unit-testable.
// Returns { type|null, detected, reason, dbs[] }. Types match templates/*.
function decideType(paths, pkg) {
  const list = (paths || []).filter(Boolean);
  const root = name => list.includes(name);
  const any = re => list.some(p => re.test(p));
  const shallowest = re => {
    const hit = list.filter(p => re.test(p)).sort((a, b) => a.length - b.length);
    return hit[0] || null;
  };

  // database hints from driver deps (confident packages only)
  const deps = { ...(((pkg || {}).dependencies) || {}), ...(((pkg || {}).devDependencies) || {}) };
  const dbs = [];
  if (deps.pg || deps.postgres || deps['pg-hstore']) dbs.push('postgres');
  if (deps.mysql || deps.mysql2) dbs.push('mysql');
  if (deps.mongoose || deps.mongodb) dbs.push('mongo');
  if (deps.redis || deps.ioredis || deps.bull || deps.bullmq) dbs.push('redis');
  if (any(/prisma\/schema\.prisma$/)) {
    // prisma provider needs schema content - flag postgres only on explicit mention is overreach; skip
  }

  const pkgPath = shallowest(/(^|\/)package\.json$/);
  if (pkgPath) {
    const scripts = (pkg && pkg.scripts) || {};
    const reactish = deps.react || deps['react-dom'] || deps['react-scripts'] || deps.next ||
      deps.gatsby || deps['@vitejs/plugin-react'] || deps['@vitejs/plugin-react-swc'] ||
      any(/next\.config\.(js|mjs|ts)/);
    if (reactish) {
      if (!scripts.build) return { type: 'react', detected: 'react', dbs, reason: `${pkgPath} uses React but has no build script - react template needs "npm run build" -> dist/` };
      return { type: 'react', detected: 'react', dbs, reason: `${pkgPath} + React deps` };
    }
    if (any(/vite\.config\.(js|ts|mjs|cjs)/)) {
      if (!scripts.build) return { type: null, detected: 'vite', dbs, reason: 'vite project without a build script - add "build" emitting dist/ or pick manually' };
      return { type: 'react', detected: 'vite', dbs, reason: 'vite project (built + served as static)' };
    }
    return { type: 'node', detected: 'node', dbs, reason: `${pkgPath} with no frontend markers` };
  }
  if (root('composer.json') || shallowest(/(^|\/)index\.php$/) || any(/\.php$/)) {
    return { type: 'php', detected: 'php', dbs, reason: 'composer.json / php files present' };
  }
  if (root('index.html') || root('index.htm')) {
    return { type: 'static', detected: 'static', dbs, reason: 'index.html at root' };
  }
  if (root('requirements.txt') || root('pyproject.toml') || root('setup.py') || any(/\.py$/)) {
    return { type: null, detected: 'python', dbs, reason: 'python apps have no template yet - pick manually' };
  }
  if (any(/\.rb$/)) return { type: null, detected: 'ruby', dbs, reason: 'ruby apps have no template yet - pick manually' };
  if (any(/go\.mod$/)) return { type: null, detected: 'go', dbs, reason: 'go apps have no template yet - pick manually' };
  return { type: null, detected: null, dbs, reason: 'no recognizable markers (package.json, composer.json, index.php, index.html) - pick manually' };
}

// Monorepo sub-apps from workspace manifests (npm/pnpm/lerna) or tooling
// conventions (turbo/nx), resolved against dirs that actually hold a package.json.
// Pure - unit-test with fixtures.
function expandWorkspaces(tree, rootPkg) {
  const patterns = [];
  if (rootPkg && rootPkg.workspaces) {
    const w = Array.isArray(rootPkg.workspaces) ? rootPkg.workspaces : rootPkg.workspaces.packages;
    if (Array.isArray(w)) patterns.push(...w);
  }
  return patterns;
}

function matchWorkspaces(tree, patterns) {
  const found = [];
  const dirsWithPkg = new Set(tree.filter(p => /(^|\/)package\.json$/.test(p)).map(p => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '')));
  for (const pat of patterns) {
    if (typeof pat !== 'string' || !pat) continue;
    if (pat.includes('*')) {
      const prefix = pat.split('*')[0];
      for (const d of dirsWithPkg) {
        if (d && d.startsWith(prefix) && !d.slice(prefix.length).includes('/')) found.push(d);
      }
    } else {
      const base = pat.replace(/\/$/, '');
      if (base && dirsWithPkg.has(base)) found.push(base);
    }
  }
  return [...new Set(found)];
}

// Backend sub-app folders: package.json with a start script or main entry, not a
// frontend, depth <= 2. pkgs maps dir -> parsed package.json (null when unreadable).
// Pure - unit-test with fixtures.
function findBackends(tree, pkgs) {
  const found = [];
  const dirs = new Set(
    tree.filter(p => /(^|\/)package\.json$/.test(p))
      .map(p => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : ''))
      .filter(d => d && d.split('/').length <= 2)
  );
  for (const d of dirs) {
    const pkg = pkgs[d];
    if (!pkg || typeof pkg !== 'object') continue;
    const scripts = pkg.scripts || {};
    if (scripts.start || pkg.main) found.push(d);
  }
  return [...new Set(found)];
}

module.exports = { decideType, expandWorkspaces, matchWorkspaces, findBackends };
