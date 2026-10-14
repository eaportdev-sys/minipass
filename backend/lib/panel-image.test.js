const assert = require('assert');
const fs = require('fs');
const path = require('path');

const dockerfile = fs.readFileSync(path.join(__dirname, '..', 'Dockerfile'), 'utf8');
const instructions = dockerfile.replace(/^\s*#.*$/gm, '').replace(/\\\r?\n\s*/g, ' ');
const install = instructions.split(/\r?\n/).find(line => /^RUN apk add\b/.test(line));
assert(install, 'Panel installs its Docker CLI dependencies');
for (const pkg of ['docker-cli', 'docker-compose', 'docker-cli-buildx']) {
  assert(install.split(/\s+/).includes(pkg), `${pkg} must be installed inside the panel`);
}
assert(install.includes('&& docker compose version'), 'Image build checks Compose is usable');
assert(install.includes('&& docker buildx version'), 'Image build checks BuildKit plugin is usable');
assert(!/\|\||2>/.test(install), 'Missing Docker dependencies must fail visibly, not be swallowed');
console.log('Panel image installs and validates Compose and BuildKit/buildx: OK');
