const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const source = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
const box = { innerHTML: '', style: {}, remove() {} }, messages = [];
let leftSite = false, refreshed = 0, prompt;
const context = vm.createContext({
  currentApp: 'testsite',
  websiteApps: [{ id: 'testsite', name: 'My website' }], trashApps: [],
  document: { getElementById: () => box },
  safeHtml: text => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
  dbLabel: () => 'postgres',
  uiConfirm: async value => { prompt = value; return true; },
  toast: (text, ok) => messages.push({ text, ok }),
  backToSites: () => { leftSite = true; }, refresh: () => { refreshed++; }
});
vm.runInContext(source.slice(source.indexOf('function siteName('), source.indexOf('let websiteVisibleApps')) + source.slice(source.indexOf('async function rmApp('), source.indexOf('async function showLogs(')), context);
const run = code => vm.runInContext(code, context);
async function main() {
  context.fetch = async () => ({ json: async () => ({ ok: false, error: 'Docker unavailable' }) });
  await run('rmApp("testsite")');
  assert.equal(prompt.requireText, 'My website', 'typed confirmation uses the display name, not the internal id');
  assert(prompt.body.includes('Site ID: testsite'));
  assert(!leftSite, 'failed soft delete does not navigate away as if successful');
  assert(refreshed && messages.at(-1).ok === false);
  context.fetch = async () => ({ json: async () => [{ id: 'testsite', type: 'node', deletedAt: Date.now(), msLeft: 0, cleanupStartedAt: Date.now(), cleanupError: '<failed cleanup>' }] });
  await run('loadTrash()');
  assert(box.innerHTML.includes('retry cleanup'));
  assert(box.innerHTML.includes('disabled>restore'));
  assert(box.innerHTML.includes('&lt;failed cleanup&gt;') && !box.innerHTML.includes('<failed cleanup>'));
  context.fetch = async (url, opts) => ({ json: async () => opts ? { ok: false, destroyed: ['one'], error: 'one cleanup retained', failed: [{ id: 'two' }] } : [{ id: 'two' }] });
  await run('emptyTrash()');
  assert.equal(prompt.requireText, 'empty');
  assert(prompt.body.includes('unused Docker build cache'));
  assert(messages.at(-1).text.includes('1 destroyed') && messages.at(-1).ok === false);
  console.log('Trash UI: soft-delete failure, visible cleanup retry, blocked restore and typed bulk/cache confirmation: OK');
}
main().catch(e => { console.error(e); process.exitCode = 1; });
