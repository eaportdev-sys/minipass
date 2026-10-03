// Stack detection from a repo file listing. Pure function - unit-testable.
// Returns { type|null, detected, reason }. Types match templates/*.
function decideType(paths, pkg) {
  const list = (paths || []).filter(Boolean);
  const root = name => list.includes(name);
  const any = re => list.some(p => re.test(p));
  const shallowest = re => {
    const hit = list.filter(p => re.test(p)).sort((a, b) => a.length - b.length);
    return hit[0] || null;
  };

  const pkgPath = shallowest(/(^|\/)package\.json$/);
  if (pkgPath) {
    const deps = { ...((pkg && pkg.dependencies) || {}), ...((pkg && pkg.devDependencies) || {}) };
    const scripts = (pkg && pkg.scripts) || {};
    const reactish = deps.react || deps['react-dom'] || deps['react-scripts'] || deps.next ||
      deps.gatsby || deps['@vitejs/plugin-react'] || deps['@vitejs/plugin-react-swc'] ||
      any(/next\.config\.(js|mjs|ts)/);
    if (reactish) {
      if (!scripts.build) return { type: 'react', detected: 'react', reason: `${pkgPath} uses React but has no build script - react template needs "npm run build" -> dist/` };
      return { type: 'react', detected: 'react', reason: `${pkgPath} + React deps` };
    }
    if (any(/vite\.config\.(js|ts|mjs|cjs)/)) {
      if (!scripts.build) return { type: null, detected: 'vite', reason: 'vite project without a build script - add "build" emitting dist/ or pick manually' };
      return { type: 'react', detected: 'vite', reason: 'vite project (built + served as static)' };
    }
    return { type: 'node', detected: 'node', reason: `${pkgPath} with no frontend markers` };
  }
  if (root('composer.json') || shallowest(/(^|\/)index\.php$/) || any(/\.php$/)) {
    return { type: 'php', detected: 'php', reason: 'composer.json / php files present' };
  }
  if (root('index.html') || root('index.htm')) {
    return { type: 'static', detected: 'static', reason: 'index.html at root' };
  }
  if (root('requirements.txt') || root('pyproject.toml') || root('setup.py') || any(/\.py$/)) {
    return { type: null, detected: 'python', reason: 'python apps have no template yet - pick manually' };
  }
  if (any(/\.rb$/)) return { type: null, detected: 'ruby', reason: 'ruby apps have no template yet - pick manually' };
  if (any(/go\.mod$/)) return { type: null, detected: 'go', reason: 'go apps have no template yet - pick manually' };
  return { type: null, detected: null, reason: 'no recognizable markers (package.json, composer.json, index.php, index.html) - pick manually' };
}

module.exports = { decideType };
