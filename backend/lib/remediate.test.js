const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const remediate = require('./remediate');

const VITE_DOCKERFILE = 'FROM nginx:stable-alpine\nWORKDIR /app\nCOPY . .\nRUN cp -r /app/dist/* /usr/share/nginx/html\nEXPOSE 80\n';
const TEMPLATE = fs.readFileSync(path.join(__dirname, '../../templates/react/Dockerfile'), 'utf8');
const NPM_CRASH = "build failed - running containers untouched: npm error Cannot read properties of null (reading 'edgesOut')";

const dirs = [];
function fixture(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'minipass-remediate-'));
  dirs.push(dir);
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.join(dir, path.dirname(name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), content);
  }
  return dir;
}
const pkg = JSON.stringify({ scripts: { build: 'tsc && vite build' } });
const errorText = `src/common/i18n.ts(7,30): error TS2307: Cannot find module './utils' or its corresponding type declarations.\nsrc/components/utils/development-tools/TanStackRouterDevelopmentTools.tsx(2,30): error TS2307: Cannot find module '../../../common/utils' or its corresponding type declarations.\n`;

let dir = fixture({
  'package.json': pkg,
  'src/common/i18n.ts': `import { isProduction } from "./utils";\nconsole.log(isProduction);\n`,
  'src/components/utils/development-tools/TanStackRouterDevelopmentTools.tsx': `import { isProduction } from "../../../common/utils";\nexport const x = isProduction;\n`
});
let suggestions = remediate.suggest(dir, errorText, null);
assert.equal(suggestions.length, 1, 'one stub for the shared missing module');
assert.equal(suggestions[0].key, 'missing-module:src/common/utils.ts');
assert(suggestions[0].preview.includes('export const isProduction'), 'stub exports the imported names');
assert(!suggestions[0].preview.includes('import.meta'), 'stub invents no behavior');
const applied = remediate.apply(dir, suggestions[0]);
assert.deepEqual(applied.applied, ['src/common/utils.ts']);
assert(fs.existsSync(path.join(dir, 'src/common/utils.ts')));
assert.throws(() => remediate.apply(dir, suggestions[0]), /already exists/);

dir = fixture({ Dockerfile: VITE_DOCKERFILE, 'package.json': pkg });
suggestions = remediate.suggest(dir, 'build failed', TEMPLATE);
assert.equal(suggestions.length, 0, 'a repo Dockerfile expecting output must never be replaced by a generic npm recipe');
assert.throws(() => remediate.apply(dir, { key: 'dockerfile-replace:Dockerfile', kind: 'dockerfile-replace' }), /unknown remediation/);

const recoveryFiles = { Dockerfile: TEMPLATE, 'Dockerfile.minipass-bak': VITE_DOCKERFILE,
  'package.json': pkg, 'pnpm-lock.yaml': 'lockfileVersion: 9.0\n',
  'src/common/utils.ts': 'export const isProduction = import.meta.env.PROD;\n' };
dir = fixture(recoveryFiles);
suggestions = remediate.suggest(dir, NPM_CRASH, TEMPLATE);
assert.equal(suggestions.length, 1);
assert.equal(suggestions[0].kind, 'dockerfile-restore');
assert(suggestions[0].detail.includes('pnpm') && suggestions[0].detail.includes('local rebuild'));
assert.equal(suggestions[0].preview, VITE_DOCKERFILE, 'preview is the actual backup, not invented code');
const out = remediate.apply(dir, suggestions[0]);
assert.deepEqual(out.applied, ['Dockerfile', 'Dockerfile.minipass-replaced']);
assert.equal(out.nextDeploy, 'local');
assert.equal(fs.readFileSync(path.join(dir, 'Dockerfile'), 'utf8'), VITE_DOCKERFILE, 'original restored byte-identically');
assert.equal(fs.readFileSync(path.join(dir, 'Dockerfile.minipass-replaced'), 'utf8'), TEMPLATE, 'replaced recipe kept for undo');
for (const name of ['Dockerfile.minipass-bak', 'package.json', 'pnpm-lock.yaml', 'src/common/utils.ts']) {
  assert.equal(fs.readFileSync(path.join(dir, name), 'utf8'), recoveryFiles[name], name + ' stays unchanged');
}
assert(!remediate.suggest(dir, NPM_CRASH, TEMPLATE).some(s => s.key), 'cannot re-apply after restoration');

dir = fixture(recoveryFiles);
suggestions = remediate.suggest(dir, NPM_CRASH, TEMPLATE);
fs.appendFileSync(path.join(dir, 'Dockerfile.minipass-bak'), '# changed\n');
assert.throws(() => remediate.apply(dir, suggestions[0]), /changed/);
assert.equal(fs.readFileSync(path.join(dir, 'Dockerfile'), 'utf8'), TEMPLATE, 'stale preview cannot overwrite current Dockerfile');
assert(!fs.existsSync(path.join(dir, 'Dockerfile.minipass-replaced')));

dir = fixture({ ...recoveryFiles, 'Dockerfile.minipass-replaced': 'older saved recipe' });
assert.throws(() => remediate.apply(dir, remediate.suggest(dir, NPM_CRASH, TEMPLATE)[0]), /EEXIST/);
assert.equal(fs.readFileSync(path.join(dir, 'Dockerfile'), 'utf8'), TEMPLATE);
assert.equal(fs.readFileSync(path.join(dir, 'Dockerfile.minipass-replaced'), 'utf8'), 'older saved recipe');
assert(!fs.readdirSync(dir).some(n => n.includes('.minipass-restore-')), 'failed recovery cleans its own temporary file');

for (const overrides of [{ Dockerfile: TEMPLATE + '# custom edit\n' },
  { 'Dockerfile.minipass-bak': '' }, { 'Dockerfile.minipass-bak': TEMPLATE },
  { 'package.json': '' }, { 'Dockerfile.minipass-bak': 'FROM nginx\n' }]) {
  dir = fixture({ ...recoveryFiles, ...overrides });
  suggestions = remediate.suggest(dir, NPM_CRASH, TEMPLATE);
  assert.equal(suggestions.length, 1);
  assert.equal(suggestions[0].kind, 'diagnostic');
  assert(!suggestions[0].key, 'no apply button for an unverified repair');
}
dir = fixture({ Dockerfile: TEMPLATE, 'package.json': pkg });
assert.equal(remediate.suggest(dir, NPM_CRASH, TEMPLATE)[0].kind, 'diagnostic', 'missing backup is diagnosed, not fabricated');
dir = fixture(recoveryFiles);
assert.deepEqual(remediate.suggest(dir, NPM_CRASH, TEMPLATE, 'another latest failure'), [], 'stale log errors do not offer restore for a different latest failure');

assert.deepEqual(remediate.suggest(dir, 'unrelated failure', TEMPLATE).filter(s => s.kind === 'missing-module'), [], 'no stub without TS2307 evidence');
assert.throws(() => remediate.apply(dir, { key: 'missing-module:../escape.ts', kind: 'missing-module', files: ['../escape.ts'], preview: 'x' }), /escapes/);
assert.throws(() => remediate.apply(dir, { key: 'bogus', kind: 'bogus' }), /unknown remediation/);
for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });

async function main() { console.log('Remediations: verified backup restoration, pnpm/local rebuild guidance, stale/custom/empty backup refusal, atomic preservation and no generic replacement: OK'); }
main().catch(e => { console.error(e); process.exitCode = 1; });
