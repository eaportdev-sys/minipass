const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const source = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
const box = { textContent: '' };
const toasts = [];
const context = vm.createContext({
  document: { getElementById: id => { assert.equal(id, 'panelErrors'); return box; }, querySelectorAll: () => [] },
  toast: (text, ok) => toasts.push({ text, ok }),
  copyText: async text => text.includes('COPYABLE')
});
const section = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
vm.runInContext(section('function panelErrorText(', 'function accessChanged('), context);
const run = code => vm.runInContext(code, context);
const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
assert(html.includes('data-view="errors" onclick="showView(\'errors\')">Error log'));
assert(html.includes('id="view-errors"'));
assert.equal((html.match(/id="panelErrors"/g) || []).length, 1, 'one error log, accessible from the sidebar');
assert(section('function showView(', 'function panelErrorText(').includes("if (view === 'errors') loadPanelErrors()"));
assert(run(`panelErrorText({ at: '2026-10-09T12:00:00.000Z', level: 'warn', area: 'create', site: 'demo', message: 'quota <issue>' })`)
  === '2026-10-09 12:00:00 [warn] create (demo): quota <issue>');
async function main() {
  context.fetch = async () => ({ json: async () => [{ at: '2026-10-09T12:00:00Z', level: 'error', area: 'deploy-local', site: 'old', message: "COPYABLE failure\nnpm error Cannot read properties of null (reading 'edgesOut')" }] });
  await run('loadPanelErrors()');
  assert(box.textContent.includes('COPYABLE failure'));
  assert(box.textContent.includes('deploy-local (old)') && box.textContent.includes('edgesOut'));
  await run('copyPanelErrors()');
  assert.equal(toasts.at(-1).ok, true);
  context.fetch = async () => ({ json: async () => [] });
  await run('loadPanelErrors()');
  assert(box.textContent.startsWith('No recorded errors'));
  await run('copyPanelErrors()');
  assert.equal(toasts.at(-1).ok, false);
  context.fetch = async () => { throw new Error('network'); };
  await run('loadPanelErrors()');
  assert(box.textContent.startsWith('Could not load'));
  console.log('Panel error log UI: timestamped rendering, empty/error states and copy guards: OK');
}
main().catch(e => { console.error(e); process.exitCode = 1; });
