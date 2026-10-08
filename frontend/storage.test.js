const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const source = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
const box = { innerHTML: '' };
const context = vm.createContext({
  currentApp: 'one', document: { getElementById: id => { assert.equal(id, 'siteStorage'); return box; } },
  safeHtml: text => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
});
vm.runInContext(source.slice(source.indexOf('function storageSize('), source.indexOf('function runtimeKind(')), context);
const run = code => vm.runInContext(code, context);
assert.equal(run('storageSize(0)'), '0 B');
assert.equal(run('storageSize(null)'), 'unavailable');
assert.equal(run('storageSize(1073741824)'), '1.0 GiB');
context.report = { disk: { totalBytes: 23 * 1024 ** 3, freeBytes: 1024 ** 3, usedPercent: 95, low: true }, containers: [{ service: '<script>', state: 'running', writableBytes: 0, rootFsBytes: null }], warnings: ['<error>'] };
const html = run('storageMarkup(report)');
assert(html.includes('low disk space') && html.includes('writable layer: 0 B'));
assert(html.includes('Filesystem: unavailable'));
assert(!html.includes('<script>') && !html.includes('<error>'));
async function main() {
  const finishes = [];
  context.fetch = url => new Promise(resolve => { finishes.push(report => resolve({ ok: true, json: async () => report })); });
  const first = run('loadStorage()');
  context.currentApp = 'two';
  const second = run('loadStorage()');
  finishes[1]({ containers: [{ service: 'new-site', state: 'stopped', rootFsBytes: 0, writableBytes: 0 }] });
  await second;
  finishes[0]({ containers: [{ service: 'old-site', state: 'running' }] });
  await first;
  assert(box.innerHTML.includes('new-site') && !box.innerHTML.includes('old-site'), 'site switches reject stale storage responses');
  context.fetch = async () => { throw new Error('network'); };
  await run('loadStorage()');
  assert(box.innerHTML.includes('Storage unavailable'));
  console.log('storage UI: byte formatting, missing sizes, HTML escaping and stale site response protection: OK');
}
main().catch(e => { console.error(e); process.exitCode = 1; });
