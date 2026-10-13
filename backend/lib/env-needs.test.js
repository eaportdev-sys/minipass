const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { scanEnvNeeds, readEnvVars, missingEnvVars } = require('./env-needs');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'minipass-env-needs-'));
try {
  const code = path.join(tmp, 'code');
  const apiSrc = path.join(code, 'services', 'api', 'src');
  fs.mkdirSync(apiSrc, { recursive: true });
  fs.writeFileSync(path.join(apiSrc, 'server.mjs'),
    'if(!process.env.APP_ORIGIN)throw new Error("APP_ORIGIN is required");\n' +
    'const port = Number(process.env.PORT ?? 4000);\n' +
    'const url = process.env["DATABASE_URL"];\n');
  fs.writeFileSync(path.join(code, 'web.mjs'), 'fetch(process.env.API_URL + "/x");\nconsole.log(process.env.PATH);\n');
  fs.writeFileSync(path.join(code, '.env.example'), 'APP_ORIGIN=\n');
  // skipped: vendored, generated output, oversized
  fs.mkdirSync(path.join(code, 'node_modules', 'dep'), { recursive: true });
  fs.writeFileSync(path.join(code, 'node_modules', 'dep', 'index.js'), 'process.env.SKIP_ME');
  fs.mkdirSync(path.join(code, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(code, 'dist', 'out.js'), 'process.env.SKIP_DIST');
  fs.writeFileSync(path.join(code, 'big.js'), 'x'.repeat(201 * 1024) + 'process.env.SKIP_BIG');

  const need = scanEnvNeeds(tmp);
  assert(need.includes('APP_ORIGIN'), 'required var in nested service found');
  assert(need.includes('PORT') && need.includes('DATABASE_URL') && need.includes('API_URL'), 'bracket and plain refs found');
  assert(!need.includes('PATH'), 'noise filtered');
  assert(!need.some(k => k.startsWith('SKIP_')), 'node_modules/dist/oversized skipped');

  fs.writeFileSync(path.join(tmp, '.env'), 'PORT=4000\nAPI_URL=\nDATABASE_URL=postgres://x\n');
  const rep = missingEnvVars(tmp);
  assert.deepEqual(rep.missing, ['APP_ORIGIN'], 'only truly absent keys are missing');
  assert.deepEqual(rep.empty, ['API_URL'], 'empty values count as unset');
  assert.deepEqual(rep.unset, ['APP_ORIGIN', 'API_URL']);

  assert.deepEqual(readEnvVars(path.join(tmp, '.env')), [
    { key: 'PORT', value: '4000' },
    { key: 'API_URL', value: '' },
    { key: 'DATABASE_URL', value: 'postgres://x' }
  ]);
  assert.deepEqual(readEnvVars(path.join(tmp, 'no-such-file')), []);
  console.log('Env needs: nested scan, skips, noise, missing/empty split: OK');
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
