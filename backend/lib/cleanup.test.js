const assert = require('assert');
const fs = require('fs');
const path = require('path');

// Every production library must have a path from the server, not just a unit
// test. Literal require() includes lazy imports inside endpoint functions.
const backend = path.resolve(__dirname, '..');
const reached = new Set();
const packages = new Set();
function visit(file) {
  file = path.resolve(file);
  if (reached.has(file)) return;
  reached.add(file);
  const text = fs.readFileSync(file, 'utf8');
  for (const m of text.matchAll(/\brequire\(['"]([^'"]+)['"]\)/g)) {
    const target = m[1];
    if (!target.startsWith('.')) {
      packages.add(target.startsWith('@') ? target.split('/').slice(0, 2).join('/') : target.split('/')[0]);
      continue;
    }
    const resolved = require.resolve(path.resolve(path.dirname(file), target));
    assert(resolved.startsWith(backend + path.sep), 'production module import stays inside backend');
    visit(resolved);
  }
}
visit(path.join(backend, 'server.js'));
for (const name of fs.readdirSync(__dirname).filter(n => n.endsWith('.js') && !n.endsWith('.test.js'))) {
  assert(reached.has(path.join(__dirname, name)), `orphan production library: ${name}`);
}
for (const name of Object.keys(require('../package.json').dependencies)) {
  assert(packages.has(name), `unused runtime dependency: ${name}`);
}

const frontend = path.resolve(backend, '../frontend');
const html = fs.readFileSync(path.join(frontend, 'index.html'), 'utf8');
const included = new Set([...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map(m => m[1]));
for (const name of fs.readdirSync(frontend).filter(n => n.endsWith('.js') && !n.endsWith('.test.js'))) {
  assert(included.has(name), `orphan frontend module: ${name}`);
}
console.log('Cleanup: production libraries reachable, runtime dependencies used, frontend modules loaded: OK');
