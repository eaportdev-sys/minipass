const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { ensureDockerfile, needsDockerfileOptIn, createApp } = require('./generator');
const templates = path.resolve(__dirname, '../../templates');
const dockerfile = fs.readFileSync(path.join(templates, 'node', 'Dockerfile'), 'utf8');
const command = JSON.parse(dockerfile.match(/^CMD (.*)$/m)[1])[2];
const entryCode = command.match(/entry=\$\(node -e "([^"]+)"\)/)[1];
const scriptCode = command.match(/script=\$\(node -e "([^"]+)"/)[1];
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'minipass-node-start-'));
const node = (code, dir) => execFileSync(process.execPath, ['-e', code], { cwd: dir, encoding: 'utf8', stdio: 'pipe' }).trim();
const fixture = (name, pkg, files) => {
  const dir = path.join(tmp, name); fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg));
  for (const file of files) { fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true }); fs.writeFileSync(path.join(dir, file), 'console.log("fixture");'); }
  return dir;
};
try {
  for (const main of ['server.js', 'lib/service.cjs', 'api entry.mjs']) {
    const dir = fixture('main-' + Math.random(), { main }, [main]);
    assert.equal(node(entryCode, dir).replace(/\\/g, '/'), './' + main);
    assert(!needsDockerfileOptIn(dir, 'node')); assert.equal(ensureDockerfile(dir, 'node', templates), 'seeded-node');
  }
  const plain = fixture('plain', {}, ['server.js']); assert.equal(node(entryCode, plain), './server.js');
  const index = fixture('index', {}, ['index.js']); assert.equal(node(entryCode, index), './index.js');
  const built = fixture('built', { main: 'dist/app.js', scripts: { build: 'tsc' } }, []);
  assert(!needsDockerfileOptIn(built, 'node')); assert.equal(ensureDockerfile(built, 'node', templates), 'seeded-node');
  fs.mkdirSync(path.join(built, 'dist')); fs.writeFileSync(path.join(built, 'dist/app.js'), ''); assert.equal(node(entryCode, built).replace(/\\/g, '/'), './dist/app.js');
  fs.writeFileSync(path.join(tmp, 'foreign.js'), '');
  const outside = fixture('outside', { main: '../foreign.js' }, []); assert.throws(() => node(entryCode, outside));
  const start = fixture('start', { scripts: { start: 'next dev' } }, []); assert.equal(node(scriptCode, start), 'start', 'repository start commands are not vetoed as development scripts');
  const prod = fixture('prod', { scripts: { start: 'node dev.js', 'start:prod': 'node app.js' } }, []); assert.equal(node(scriptCode, prod), 'start:prod');
  const apps = path.join(tmp, 'apps'), source = path.join(apps, 'env-test', 'code'); fs.mkdirSync(path.join(source, '.git'), { recursive: true });
  fs.writeFileSync(path.join(source, 'package.json'), '{"main":"server.js"}'); fs.writeFileSync(path.join(source, 'server.js'), '');
  const originalEnv='PORT=8087\nAPP_VALUE=repository-value\nQUOTED_VALUE=\'text "quoted" # kept\'\nMULTILINE="line one\nline two"\n';
  fs.writeFileSync(path.join(source, '.env'), originalEnv); fs.writeFileSync(path.join(source, '.env.example'), 'APP_VALUE=example-value\nMISSING_VALUE=example-default\n');
  const created = createApp({ appsDir: apps, templatesDir: templates, name: 'env-test', type: 'node', repoUrl: 'https://example.test/source.git' });
  const env = require('dotenv').parse(fs.readFileSync(path.join(created.dir, '.env')));
  assert.equal(env.PORT, '8087'); assert.equal(env.APP_VALUE, 'repository-value'); assert.equal(env.MISSING_VALUE, 'example-default');
  assert.equal(env.QUOTED_VALUE,'text "quoted" # kept');assert.equal(env.MULTILINE,'line one\nline two');
  assert.equal(fs.readFileSync(path.join(source, '.env'), 'utf8'), originalEnv, 'repository environment is not rewritten');
  assert(fs.readFileSync(path.join(created.dir, 'docker-compose.yml'), 'utf8').includes('8000:8087'));
  const frontend=path.join(apps,'frontend','code');fs.mkdirSync(path.join(frontend,'.git'),{recursive:true});
  fs.writeFileSync(path.join(frontend,'package.json'),'{"dependencies":{"react":"19"},"scripts":{"build":"vite build"}}');
  fs.writeFileSync(path.join(frontend,'.env'),'PORT=5173\n');
  const staticApp=createApp({appsDir:apps,templatesDir:templates,name:'frontend',type:'react',repoUrl:'https://example.test/frontend.git'});
  assert.equal(staticApp.appPort,80,'frontend development PORT does not override the production nginx listener');
  const custom=path.join(apps,'custom','code');fs.mkdirSync(path.join(custom,'.git'),{recursive:true});
  fs.writeFileSync(path.join(custom,'Dockerfile'),'FROM node:24\nEXPOSE 4321\nCMD ["node","server.js"]\n');fs.writeFileSync(path.join(custom,'.env'),'PORT=65536\n');
  const authored=createApp({appsDir:apps,templatesDir:templates,name:'custom',type:'node',repoUrl:'https://example.test/custom.git'});
  assert.equal(authored.appPort,4321,'an invalid source port cannot hide an authored Dockerfile EXPOSE');
  assert(!dockerfile.includes('BUILD PRODUCED NO .next/'), 'a framework dependency alone does not veto the repository build output');
  console.log('Node launch: declared main/start, server fallbacks, built output, source env precedence and no framework approval gate: OK');
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
