const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const elements = new Map();
const element = id => {
  if (!elements.has(id)) elements.set(id, { value: '', checked: false, textContent: '', innerHTML: '', style: {}, attributes: {},
    setAttribute(k, v) { this.attributes[k] = v; }, focus() { this.focused = true; } });
  return elements.get(id);
};
const context = vm.createContext({ currentApp: 'first',
  document: { getElementById: element, querySelector: () => ({ value: 'static' }), querySelectorAll: () => [] },
  safeHtml: t => String(t == null ? '' : t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
  renderDeployMarkup: (box, html) => { box.innerHTML = html; }, toast() {}, refresh() {}, closeCreate() {}, refreshSiteData: async () => {}, loadEnv() {},
});
vm.runInContext(fs.readFileSync(path.join(__dirname, 'deployment-plan.js'), 'utf8'), context);
const creation = fs.readFileSync(path.join(__dirname, 'create.js'), 'utf8');
vm.runInContext('let createModalSession=1, createCleanupPromise=Promise.resolve(), createPendingId=null, createStandardDockerfile=false, createBusyOps=0, createDetectedManager="npm";\n' + creation.slice(0, creation.indexOf('async function detectType(')), context);
const run = code => vm.runInContext(code, context);
const fixture = { ready: false, candidates: [{ kind: 'compose', file: 'production.recipe' }], selected: { kind: 'compose', file: 'production.recipe' },
  reason: 'Detected source', warnings: [{ message: '<img src=x onerror=boom>' }], topology: { services: [{ name: 'migrate', oneShot: true, image: 'node:24' }] } };
async function main() {
  let requests = [];
  context.fetch = async (url, opts) => { requests.push({ url, body: JSON.parse(opts.body) }); return { json: async () => ({ error: 'fixture failure' }) }; };
  element('name').value = '   '; await run('createApp()');
  assert.equal(requests.length, 0); assert(element('name').focused);
  element('name').value = 'Site'; element('repo').value = 'https://example.test/source.git';
  element('createStorageGB').value = '5';
  await run('createApp()');
  assert.equal(requests.length, 1, 'create submits once, without a required source-preview round trip');
  assert.equal(requests[0].url, '/api/apps'); assert(!requests[0].body.prepareOnly);
  assert.equal(requests[0].body.storageGB, '5', 'normal creation requests the required site allowance');
  context.fetch = async () => ({ ok: true, json: async () => fixture }); await run('loadDeploymentPlan()');
  const html = element('deploymentPlan').innerHTML;
  assert(html.includes('does not approve or block deployment'));
  assert(html.includes('not proof that every application feature works'));
  assert(html.includes('&lt;img') && !html.includes('<img'));
  assert(!html.includes('Deployment blocked') && !html.includes('browser/API verification'));
  assert(element('deploymentFileSetup').innerHTML.includes('auto-detect'));
  let sent;
  context.fetch = async (url, opts) => { sent = { url, body: JSON.parse(opts.body) }; return { json: async () => ({ ok: true }) }; };
  element('deploymentEntrypoint').value = '0'; await run('saveDeploymentEntrypoint()');
  assert.equal(sent.body.selection.file, 'production.recipe');
  await run('saveDeploymentEntrypoint(true)'); assert.equal(sent.body.selection, null);
  const originalLoad = context.loadDeploymentPlan; context.loadDeploymentPlan = () => {};
  await run('saveSiteAccess(true)'); assert.equal(sent.url, '/api/apps/first/access'); assert.deepEqual(sent.body, { access: 'local' });
  context.loadDeploymentPlan = originalLoad;
  let finish;
  context.fetch = () => new Promise(resolve => { finish = () => resolve({ ok: true, json: async () => ({ ...fixture, reason: 'OLD RESPONSE' }) }); });
  const old = run('loadDeploymentPlan()'); context.currentApp = 'second';
  context.fetch = async () => ({ ok: true, json: async () => ({ ...fixture, reason: 'CURRENT RESPONSE' }) }); await run('loadDeploymentPlan()');
  finish(); await old;
  assert(element('deploymentPlan').innerHTML.includes('CURRENT RESPONSE')); assert(!element('deploymentPlan').innerHTML.includes('OLD RESPONSE'));
  console.log('Basic workflow UI: one create request, mandatory site allowance, optional source overrides, advisory detection and stale-response protection: OK');
}
main().catch(e => { console.error(e); process.exitCode = 1; });
