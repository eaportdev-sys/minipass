const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { analyze } = require('./deployment-plan');
const { createApp } = require('./generator');
const { readComposeTopo } = require('./compose-read');
const { inventory, isDockerfile } = require('./repository-files');
const { resolveServiceDockerfile, findDockerfiles } = require('./dockerfiles');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'minipass-plan-'));
const templatesDir = path.resolve(__dirname, '../../templates');
function put(folder, name, content) {
  const file = path.join(tmp, folder, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
  return path.join(tmp, folder);
}
const recipe = 'FROM node:24\nWORKDIR /app\nCOPY . .\nEXPOSE 3000\nCMD ["node","server.js"]\n';
const service = { name: 'app', subdir: '', type: 'node', enabled: true };
const options = { services: [service], templatesDir };
try {
  // Complete source inventory, beyond the old count/depth cutoffs.
  for (let i = 0; i < 350; i++) put('large', `files/${i}.js`, 'const x = 1;');
  const root = put('large', 'deep/a/b/c/d/e/f/g/h/compose.dockerfile', 'services:\n  api:\n    image: node:24\n');
  put('large', 'Dockerfile.compose', recipe);
  put('large', 'logo.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1]).toString('latin1'));
  put('large', 'node_modules/ignored/deployment', 'services:\n  ignored:\n    image: node\n');
  let plan = analyze(root, options);
  assert.equal(plan.scan.files, 353);
  assert.equal(plan.scan.complete, true);
  assert(plan.candidates.some(c => c.kind === 'compose' && c.file.endsWith('compose.dockerfile')));
  assert(plan.candidates.some(c => c.kind === 'dockerfile' && c.file === 'Dockerfile.compose'));
  assert(plan.scan.skipped.some(s => s.reason === 'binary file'));
  assert(plan.scan.skipped.some(s => s.file === 'node_modules/'));
  assert(!plan.blockers.some(b => b.code === 'COMPOSE_EXECUTOR_UNSUPPORTED'));
  assert.equal(plan.ready, true, 'valid Compose is now executable, not permanently blocked');

  const names = put('names', 'compose.dockerfile', recipe);
  put('names', 'Dockerfile.compose', 'services:\n  web:\n    build:\n      context: .\n      dockerfile: compose.dockerfile\n      target: runtime\n    environment:\n      APP_ORIGIN: https://${PUBLIC_DOMAIN:?set domain}\n      SECRET: literal-private-credential\n      OPTIONAL: ${OTHER:-literal-private-default}\n');
  put('names', 'launch.sh', 'docker compose -f Dockerfile.compose up -d\n');
  plan = analyze(names, options);
  assert.deepEqual(plan.selected, { kind: 'compose', file: 'Dockerfile.compose' });
  assert.equal(plan.reason, 'Referenced by repository deployment command');
  assert.equal(plan.topology.services[0].build.target, 'runtime');
  assert(plan.blockers.some(b => b.code === 'REQUIRED_ENV' && b.message.includes('PUBLIC_DOMAIN')));
  assert(!plan.blockers.some(b => b.code === 'REQUIRED_ENV' && b.message.includes('APP_ORIGIN')), 'derived value is not falsely required as a separate input');
  assert(!JSON.stringify(plan).includes('literal-private-credential'));
  assert(!JSON.stringify(plan).includes('literal-private-default'));
  assert.equal(readComposeTopo(names, 'Dockerfile.compose').complete, true);
  assert.deepEqual(resolveServiceDockerfile(names, 'compose.dockerfile', 'node', templatesDir), { file: 'compose.dockerfile', source: 'selected' });
  assert.deepEqual(findDockerfiles(names), ['compose.dockerfile'], 'a Dockerfile-looking Compose filename is not offered as a build recipe');
  plan = analyze(names, { ...options, env: { PUBLIC_DOMAIN: 'example.test' } });
  assert(!plan.blockers.some(b => b.code === 'REQUIRED_ENV'));

  const ambiguity = put('ambiguous', 'recipe.production', recipe);
  put('ambiguous', 'recipe.development', recipe);
  plan = analyze(ambiguity, options);
  assert(plan.blockers.some(b => b.code === 'ENTRYPOINT_CHOICE'));
  plan = analyze(ambiguity, { ...options, selection: { kind: 'dockerfile', file: 'recipe.production' }, services: [{ ...service, dockerfile: 'recipe.production' }] });
  assert.equal(plan.ready, true);
  fs.unlinkSync(path.join(ambiguity, 'recipe.production'));
  assert(analyze(ambiguity, { ...options, selection: { kind: 'dockerfile', file: 'recipe.production' } }).blockers.some(b => b.code === 'STALE_SELECTION'));

  const reference = put('references', 'build.entry', recipe);
  put('references', 'other.entry', recipe);
  put('references', 'package.json', { name: 'generic-site', scripts: { start: 'node server.js', release: 'docker build -f "build.entry" .' } });
  plan = analyze(reference, { ...options, services: [{ ...service, dockerfile: 'build.entry' }] });
  assert.equal(plan.selected.file, 'build.entry');
  assert.equal(plan.ready, true);
  assert(plan.manifests.some(m => m.commands.some(c => c.name === 'start')));
  assert(!fs.existsSync(path.join(reference, 'executed')), 'detection never executes source instructions');
  put('references', 'README.md', 'Example: docker compose -f not-in-repo up\n');
  assert(analyze(reference, { ...options, services: [{ ...service, dockerfile: 'build.entry' }] }).warnings.length);
  put('references', 'release.sh', 'docker compose -f "$PLAN" up\n');
  assert(analyze(reference, options).blockers.some(b => b.code === 'UNRESOLVED_REFERENCE'));

  const overlay = put('overlays', 'base', 'services:\n  web:\n    image: nginx\n');
  put('overlays', 'prod', 'services:\n  web:\n    image: nginx\n');
  put('overlays', 'release.sh', 'docker compose -f base -f prod up\n');
  assert.deepEqual(analyze(overlay).selected.files, ['base', 'prod'], 'an ordered multi-file invocation is selected as one deployment path');
  assert(!analyze(overlay).blockers.some(b => b.code === 'COMPOSE_OVERLAY'));
  const broken = put('broken', 'odd.entry', 'services:\n  web:\n    image: a\n    image: b\n');
  assert(analyze(broken).blockers.some(b => b.code === 'INVALID_COMPOSE'));

  const oversized = put('oversized', 'build.instructions', 'x'.repeat(100));
  assert.equal(analyze(oversized, {}, { maxFileBytes: 50 }).scan.complete, false);
  assert(analyze(oversized, {}, { maxFileBytes: 50 }).blockers.some(b => b.code === 'INCOMPLETE_SCAN'));
  assert.equal(inventory(root, { maxTextBytes: 10 }).complete, false);
  const utf16 = put('encoding', 'instructions', 'placeholder');
  fs.writeFileSync(path.join(utf16, 'instructions'), Buffer.from([0xff, 0xfe, 0x46, 0, 0x52, 0]));
  assert.equal(analyze(utf16).scan.complete, false, 'UTF-16 instructions are disclosed, not silently misclassified as binary');
  const linked = put('links', 'Dockerfile', recipe);
  const outside = put('outside', 'entry', 'services:\n  foreign:\n    image: node\n');
  fs.symlinkSync(outside, path.join(linked, 'external'), process.platform === 'win32' ? 'junction' : 'dir');
  const linkedPlan = analyze(linked, options);
  assert.equal(linkedPlan.scan.complete, false);
  assert(linkedPlan.scan.issues.some(i => i.file === 'external'));
  assert(!linkedPlan.candidates.some(c => c.file.includes('external')), 'instruction discovery never follows source symlinks out of the checkout');
  assert(!isDockerfile('A README mentions FROM nginx in a sentence.'));
  assert(isDockerfile('# syntax=docker/dockerfile:1\nARG IMAGE=node\nFROM ${IMAGE}\n'));
  const ignoredExample = put('commented', 'Dockerfile', recipe);
  put('commented', 'release.sh', '# Example only: docker compose -f missing up\n');
  assert.equal(analyze(ignoredExample, options).ready, true, 'commented examples are evidence, not executable deployment requirements');

  // Dockerless supported repositories still get a build environment, while
  // image-only Compose can be registered without being force-seeded.
  const applications = path.join(tmp, 'applications');
  const starter = createApp({ appsDir: applications, templatesDir, name: 'starter', type: 'static', db: 'none' });
  assert(analyze(path.join(starter.dir, 'code'), { ...options, services: [{ ...service, type: 'static' }] }).ready);
  const pending = path.join(applications, 'compose-site', 'code');
  fs.mkdirSync(pending, { recursive: true });
  fs.writeFileSync(path.join(pending, 'deploy.instructions'), 'services:\n  web:\n    image: nginx:alpine\n');
  fs.mkdirSync(path.join(pending, '.git'));
  const registered = createApp({ appsDir: applications, templatesDir, name: 'compose-site', type: 'static', repoUrl: 'https://example.test/repo.git', db: 'none' });
  assert(registered.hasDeclaredCompose);
  assert(!fs.existsSync(path.join(pending, 'Dockerfile')), 'declared topology is not overwritten by a panel recipe');
  assert(!fs.existsSync(path.join(pending, 'nginx.conf')), 'unsupported topology is not injected with panel source configuration');
  const explicit = path.join(applications, 'explicit-site', 'code');
  fs.mkdirSync(path.join(explicit, '.git'), { recursive: true });
  fs.writeFileSync(path.join(explicit, 'Dockerfile'), recipe);
  fs.writeFileSync(path.join(explicit, 'recipe.production'), recipe);
  fs.writeFileSync(path.join(explicit, 'release.sh'), 'docker build -f recipe.production .\n');
  const authoredCreate = createApp({ appsDir: applications, templatesDir, name: 'explicit-site', type: 'static', repoUrl: 'https://example.test/repo.git', db: 'none' });
  assert(fs.readFileSync(path.join(authoredCreate.dir, 'docker-compose.yml'), 'utf8').includes('dockerfile: recipe.production'), 'creation follows the explicit build reference rather than the conventional filename');
  console.log('Deployment plan: full source inventory, content-based entrypoints, references, choices, derived env, explicit limits, no execution and safe registration: OK');
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
