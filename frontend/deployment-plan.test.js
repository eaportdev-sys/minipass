const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const elements = new Map();
const element = id => {
  if (!elements.has(id)) elements.set(id, { value: '', textContent: '', innerHTML: '', style: {}, attributes: {},
    setAttribute(k, v) { this.attributes[k] = v; }, focus() { this.focused = true; } });
  return elements.get(id);
};
const context = vm.createContext({
  currentApp: 'first',
  document: { getElementById: element, querySelector: () => ({ value: 'static' }), querySelectorAll: () => [] },
  safeHtml: t => String(t == null ? '' : t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
  renderDeployMarkup: (box, html) => { box.innerHTML = html; }, toast() {}, refresh() {}, closeCreate() {}, refreshSiteData: async () => {},
});
vm.runInContext(fs.readFileSync(path.join(__dirname, 'deployment-plan.js'), 'utf8'), context);
const creation = fs.readFileSync(path.join(__dirname, 'create.js'), 'utf8');
vm.runInContext('let createModalSession=1, createCleanupPromise=Promise.resolve(), createPendingId=null, createStandardDockerfile=false, createBusyOps=0, createDetectedManager="npm";\n' + creation.slice(0, creation.indexOf('async function detectType(')), context);
const run = code => vm.runInContext(code, context);
const fixture = { ready: false, scan: { complete: true, files: 410, textFiles: 400 }, candidates: [{ kind: 'compose', file: 'unexpected.entry', complete: true }],
  selected: { kind: 'compose', file: 'unexpected.entry' }, reason: 'Repository reference',
  blockers: [{ code: 'BLOCKED', message: '<img src=x onerror=boom>', file: '<file>' }],
  manifests: [], topology: { services: [{ name: 'migrate', oneShot: true, build: { context: '.', dockerfile: 'recipe' }, dependsOn: ['db'], dependencyConditions: { db: 'service_healthy' }, env: [{ key: 'APP_ORIGIN', refs: ['PUBLIC_DOMAIN'], derived: true }] }], envNeeds: [{ key: 'PUBLIC_DOMAIN', required: true }] } };
async function main() {
  let requests = 0;
  context.fetch = async () => { requests++; throw new Error('should not request'); };
  element('name').value = '   ';
  await run('createApp()');
  assert.equal(requests, 0);
  assert.equal(element('createNameError').textContent, 'Site name is required.');
  assert.equal(element('name').attributes['aria-invalid'], 'true');
  assert(element('name').focused);
  element('name').value = 'Valid name';
  run('createBusyOps=1');
  await run('createApp()');
  assert.equal(requests, 0, 'programmatic create cannot bypass busy detection');
  run('createBusyOps=0');
  element('createStorageGB').value = '1';
  context.fetch = async () => ({ json: async () => ({ error: 'Site name is required.', field: 'name' }) });
  await run('createApp()');
  assert.equal(element('createNameError').textContent, 'Site name is required.');

  context.fetch = async () => ({ ok: true, json: async () => fixture });
  await run('loadDeploymentPlan()');
  const html = element('deploymentPlan').innerHTML;
  assert(html.includes('410 source files'));
  assert(html.includes('Deployment blocked'));
  assert(html.includes('required one-shot task') && html.includes('service_healthy'));
  assert(html.includes('APP_ORIGIN ← PUBLIC_DOMAIN'));
  assert(html.includes('&lt;img') && !html.includes('<img'));
  assert(html.includes('save selection'));
  context.currentApp='first';
  context.reportPlan={...fixture,verification:{ok:false,at:'2026-10-13',errors:['Stylesheet failed <unsafe>'],pages:[{service:'web',url:'http://example.test',status:200,ok:false,assets:[],screenshotIndex:0}],probes:[{service:'api',ok:true}]}};
  const reportHtml=run('deploymentPlanMarkup(reportPlan)');
  assert(reportHtml.includes('Last browser/API verification — failed'));
  assert(reportHtml.includes('Stylesheet failed &lt;unsafe&gt;'));
  assert(reportHtml.includes('/api/apps/first/verification/screenshot/0'));
  context.provisioningPlan={...fixture,provisioning:[{key:'SQL_PASSWORD',service:'database',reason:'database password generated'},{key:'DB_CONNECTION',service:'api',reason:'repository database connection linked'}]};
  const privateInputs=run('deploymentPlanMarkup(provisioningPlan)');
  assert(privateInputs.includes('Prepared repository inputs (values kept private)'));
  assert(privateInputs.includes('DB_CONNECTION')&&privateInputs.includes('database password generated'));
  const originalLoad=context.loadDeploymentPlan;
  context.loadEnv=()=>{};context.loadDeploymentPlan=()=>{};
  context.fetch=async(url,opts)=>{sent={url,body:JSON.parse(opts.body)};return{json:async()=>({ok:true,changed:['DB_CONNECTION'],issues:[]})}};
  let sent;
  await run('prepareComposeInputs()');
  assert.equal(sent.url,'/api/apps/first/compose-inputs');
  context.loadDeploymentPlan=originalLoad;
  element('deploymentEntrypoint').value = '0';
  sent=null;
  context.fetch = async (url, opts) => { sent = { url, body: JSON.parse(opts.body) }; return { json: async () => ({ ok: true }) }; };
  await run('saveDeploymentEntrypoint()');
  assert.equal(sent.url, '/api/apps/first/deployment-plan');
  assert.deepEqual(sent.body.selection, { kind: 'compose', file: 'unexpected.entry' });
  await run('saveDeploymentEntrypoint(true)');
  assert.equal(sent.body.selection, null);

  let finish;
  context.fetch = () => new Promise(resolve => { finish = () => resolve({ ok: true, json: async () => ({ ...fixture, reason: 'OLD RESPONSE' }) }); });
  const old = run('loadDeploymentPlan()');
  context.currentApp = 'second';
  context.fetch = async () => ({ ok: true, json: async () => ({ ...fixture, reason: 'CURRENT RESPONSE' }) });
  await run('loadDeploymentPlan()');
  finish(); await old;
  assert(element('deploymentPlan').innerHTML.includes('CURRENT RESPONSE'));
  assert(!element('deploymentPlan').innerHTML.includes('OLD RESPONSE'));
  console.log('Workflow UI: inline name validation, busy gate, escaped persistent plan, saved entrypoints and stale response isolation: OK');
}
main().catch(e => { console.error(e); process.exitCode = 1; });
