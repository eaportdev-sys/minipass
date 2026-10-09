const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const remediate = require('./remediate');

const VITE_DOCKERFILE = 'FROM nginx:stable-alpine\nWORKDIR /app\nCOPY . .\nRUN cp -r /app/dist/* /usr/share/nginx/html\nEXPOSE 80\n';
const TEMPLATE = '# minipass template react\nFROM node AS build\nRUN npm run build\n';

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
assert.equal(suggestions.length, 1);
assert.equal(suggestions[0].kind, 'dockerfile-replace');
assert(suggestions[0].preview.includes('npm run build'));
const out = remediate.apply(dir, suggestions[0]);
assert.deepEqual(out.applied, ['Dockerfile', 'Dockerfile.minipass-bak']);
assert.equal(fs.readFileSync(path.join(dir, 'Dockerfile.minipass-bak'), 'utf8'), VITE_DOCKERFILE, 'original kept as backup');
assert(fs.readFileSync(path.join(dir, 'Dockerfile'), 'utf8').startsWith('# minipass template'));

assert.deepEqual(remediate.suggest(dir, 'unrelated failure', TEMPLATE).filter(s => s.kind === 'missing-module'), [], 'no stub without TS2307 evidence');
assert.throws(() => remediate.apply(dir, { key: 'missing-module:../escape.ts', kind: 'missing-module', files: ['../escape.ts'], preview: 'x' }), /escapes/);
assert.throws(() => remediate.apply(dir, { key: 'bogus', kind: 'bogus' }), /unknown remediation/);
for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });

async function main() { console.log('Remediations: TS2307 stub suggestions with previews, Dockerfile replace with backup, path confinement: OK'); }
main().catch(e => { console.error(e); process.exitCode = 1; });
