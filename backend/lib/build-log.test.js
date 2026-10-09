const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runLogged, failureSummary } = require('./build-log');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'minipass-build-log-'));
const file = path.join(dir, 'deploy.log');
const compiler = "src/main.ts(3,9): error TS2307: Cannot find module './missing' or its corresponding type declarations.";
async function main() {
  try {
    fs.writeFileSync(file, '--- attempt started ---\n');
    await runLogged(process.execPath, ['-e', "process.stdout.write('builder stdout\\n'); process.stderr.write('builder stderr\\n')"], { cwd: dir, logFile: file });
    let text = fs.readFileSync(file, 'utf8');
    assert(text.startsWith('--- attempt started ---'));
    assert(text.includes('builder stdout') && text.includes('builder stderr'));
    const script = `process.stdout.write(${JSON.stringify(compiler + '\n')}); process.stdout.write('chatter\\n'.repeat(30000)); process.stderr.write('[ELIFECYCLE] Command failed with exit code 2.\\n'); process.exitCode=2;`;
    let failure;
    try { await runLogged(process.execPath, ['-e', script], { cwd: dir, logFile: file }); } catch (e) { failure = e; }
    assert(failure && failure.message.includes(compiler), 'compiler stdout survives a long log and a stderr-only lifecycle footer');
    text = fs.readFileSync(file, 'utf8');
    assert(text.includes(compiler) && text.includes('[ELIFECYCLE]') && text.length > 200000, 'full output persists, memory evidence is bounded separately');
    await runLogged(process.execPath, ['-e', "process.stdout.write('DB_PASS'); setImmediate(() => process.stdout.write('WORD=hunter2\\n'))"], { logFile: file });
    text = fs.readFileSync(file, 'utf8');
    assert(text.includes('DB_PASSWORD=***') && !text.includes('hunter2'), 'split-chunk credentials are redacted');
    const duplicate = "#12 134.8 npm error Cannot read properties of null (reading 'edgesOut')\n134.8 npm error Cannot read properties of null (reading 'edgesOut')\n134.8 npm error A complete log of this run can be found in: /root/log\nfailed to solve";
    assert.equal(failureSummary(duplicate).split('\n').length, 1, 'BuildKit duplicate causes and log-path footers do not bury the cause');
    assert(failureSummary(compiler + '\n[ELIFECYCLE] Command failed').includes('TS2307'));
    assert(failureSummary('unclassified failure').includes('unclassified failure'));
    await assert.rejects(runLogged('minipass-missing-test-builder', [], { logFile: file }), /ENOENT/);
    await assert.rejects(runLogged(process.execPath, ['-e', "require('fs').writeFileSync('unexpected-build', 'x')"], { cwd: dir, logFile: path.join(dir, 'missing', 'log') }), /ENOENT/);
    assert(!fs.existsSync(path.join(dir, 'unexpected-build')), 'a build never starts if its log cannot be opened');
    console.log('Build logging: stdout/stderr capture, retained compiler causes, bounded evidence, append preservation, redaction and spawn/log failures: OK');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
main().catch(e => { console.error(e); process.exitCode = 1; });
