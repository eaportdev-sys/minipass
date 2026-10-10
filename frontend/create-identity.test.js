const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const source = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
const elements = new Map();
function element(id) {
  if (!elements.has(id)) elements.set(id, { value: '', style: {}, classList: { remove() {} } });
  return elements.get(id);
}
const context = vm.createContext({
  document: { getElementById: element, querySelector: query => ({ value: query.includes('apptype') ? 'node' : 'local' }), querySelectorAll: () => [] },
  toast() {}, refresh() {}, accessChanged() {}
});
const section = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
vm.runInContext('let createModalSession=1, createCleanupPromise=Promise.resolve(), createPendingId=null, createStandardDockerfile=false, createConnectRequest=0, createDetectRequest=0, createDetectRepo="", createStorageAvailable=null, modalLogin=null;\n' +
  section('async function createApp(', 'async function detectType(') +
  section('function resetCreateForm(', 'function useCreateStandardDockerfile(') +
  section('function useCreateStandardDockerfile(', 'function closeCreate(') +
  section('function closeCreate(', 'function toggleTheme('), context);
const run = code => vm.runInContext(code, context);
function form() { element('name').value = 'Same display name'; element('createStorageGB').value = '1'; }
async function main() {
  form();
  const id = 'site-' + 'a'.repeat(24);
  const calls = [];
  context.fetch = async (url, options) => {
    calls.push({ url, method: options.method, body: options.body && JSON.parse(options.body) });
    return { json: async () => ({ error: 'missing Dockerfile', needsDockerfile: true, pendingId: id }) };
  };
  await run('createApp()');
  assert.equal(run('createPendingId'), id);
  assert(!calls[0].body.pendingId, 'first build has no name-derived id');
  await run('useCreateStandardDockerfile()');
  assert.equal(calls[1].body.pendingId, id, 'explicit retry reuses only server-issued pending identity');
  assert.equal(calls[1].body.standardDockerfile, true, 'standard Dockerfile approval reaches the retry request');
  context.fetch = async (url, options) => { calls.push({ url, method: options.method }); return { json: async () => ({ ok: true }) }; };
  run('closeCreate()');
  await run('createCleanupPromise');
  assert.equal(calls.at(-1).url, '/api/apps/pending/' + id);
  assert.equal(run('createPendingId'), null);
  assert.equal(element('name').value, '');
  const count = calls.length;
  form(); run('closeCreate()');
  await run('createCleanupPromise');
  assert.equal(calls.length, count, 'cancel without a server-issued draft never deletes a name-based directory');
  form();
  run('createPendingId="' + id + '"');
  context.fetch = async (url, options) => { calls.push({ url, method: options.method, body: options.body && JSON.parse(options.body) }); return { json: async () => ({ id, name: 'Same display name' }) }; };
  await run('createApp()');
  assert.equal(run('createPendingId'), null);
  assert.equal(calls.at(-1).url, '/api/apps', 'successful create does not cancel its registered identity');
  form();
  let finish;
  context.fetch = () => new Promise(resolve => { finish = () => resolve({ json: async () => ({ error: 'old response', pendingId: id }) }); });
  const stale = run('createApp()');
  await new Promise(resolve => setImmediate(resolve));
  run('resetCreateForm()');
  finish(); await stale;
  assert.equal(run('createPendingId'), null, 'an old modal response cannot attach its pending checkout to a new form');
  console.log('Create identity UI: server-issued draft retries, targeted cancellation, same-name safety, success/reset and stale response guards: OK');
}
main().catch(e => { console.error(e); process.exitCode = 1; });
