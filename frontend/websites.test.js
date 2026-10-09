const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// Exercise the actual plain-JS list functions without browser dependencies.
const source = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
const elements = new Map();
const element = id => {
  if (!elements.has(id)) elements.set(id, {
    value: '', textContent: '', innerHTML: '', style: {}, dataset: {},
    classList: { contains: () => true, add() {}, remove() {} },
    querySelector: () => null, setAttribute() {}
  });
  return elements.get(id);
};
const context = vm.createContext({
  window: { fetch: async () => ({ json: async () => [] }) },
  document: { hidden: true, getElementById: element },
  location: { hostname: 'localhost' }
});
const section = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
vm.runInContext(source.slice(0, source.indexOf('const SITE_TABS')) +
  section('function dbLabel(', 'function dirtyBadge(') +
  section('function safeHtml(', 'async function loadDatabases(') +
  section('function setPowerState(', 'function sourceSlot(') +
  section('function appIsRunning(', 'function updatePowerStates('), context);
const run = code => vm.runInContext(code, context);
const json = code => JSON.parse(JSON.stringify(run(code)));
context.fixtures = Array.from({ length: 100 }, (_, i) => ({
  id: 'site-' + String(i).padStart(3, '0'),
  type: ['static', 'react', 'node', 'php'][i % 4],
  hostPort: 8000 + i, db: i % 2 ? ['postgres', 'redis'] : 'mysql',
  domain: i === 15 ? 'demo.example.com' : '',
  github: { repo: 'owner/project-' + i }
}));
assert.equal(json('websitePageData(fixtures)').apps.length, 10);
assert.equal(json('websitePageData(fixtures)').pages, 10);
assert.equal(json('websitePageData(fixtures, {page:10})').apps[0].id, 'site-090');
assert.equal(json('websitePageData(fixtures, {page:500})').page, 10);
assert.equal(json('websitePageData(fixtures, {page:-1})').page, 1);
assert.equal(json('websitePageData(fixtures, {size:25})').pages, 4);
assert.equal(json('websitePageData(fixtures, {size:50})').apps.length, 50);
assert.equal(json('websitePageData(fixtures, {size:1000})').apps.length, 10);
assert.equal(json('websitePageData(fixtures, {type:"php"})').total, 25);
assert.equal(json('websitePageData(fixtures, {search:"DEMO.EXAMPLE PHP"})').apps[0].id, 'site-015');
assert.equal(json('websitePageData(fixtures, {search:"owner/project-99"})').total, 1);
assert.equal(json('websitePageData(fixtures, {search:"missing"})').pages, 1);
assert.equal(json('websitePageData([], {page:2})').page, 1);
assert.equal(json('websitePageData(fixtures, {sort:"name-desc"})').apps[0].id, 'site-099');
assert.equal(context.fixtures[0].id, 'site-000', 'sorting must not mutate metadata');
context.named = [{ id: 'site-' + 'a'.repeat(24), name: 'Same name', type: 'node' }, { id: 'site-' + 'b'.repeat(24), name: 'Same name', type: 'static' }];
assert.equal(json('websitePageData(named, {search:"same name"})').total, 2);
assert(run('appCardMarkup(named[0])').includes('Same name'));
assert(run('appCardMarkup(named[0])').includes("openSite('" + context.named[0].id + "')"), 'actions always target ids even when labels match');
context.unsafeName = { id: 'site-' + 'c'.repeat(24), name: '<unsafe name>', type: 'static' };
assert(run('appCardMarkup(unsafeName)').includes('&lt;unsafe name&gt;'));
context.multi = {
  id: 'multi', type: 'react', domain: '<unsafe>', dirty: true, homePath: '/legacy',
  services: [
    { name: 'app', enabled: true, hostPort: 8200, homePath: '/' },
    { name: 'api', enabled: true, hostPort: 8201, homePath: '/health' },
    { name: 'disabled', enabled: false, hostPort: 8202 }
  ]
};
const markup = run('appCardMarkup(multi)');
assert(markup.includes('http://localhost:8200/'));
assert(markup.includes('http://localhost:8201/health'));
assert(!markup.includes('8202'));
assert(markup.includes('&lt;unsafe&gt;') && !markup.includes('<unsafe>'));
assert(markup.includes('Changes pending'));
assert(markup.includes('Move to Trash'));
assert.equal(json('websitePageData([multi], {search:"api"})').total, 1);
assert.equal(json('websitePageData([multi], {search:"disabled"})').total, 0);
run('websiteApps=fixtures; renderWebsites()');
assert.equal(element('websiteCount').textContent, '100 sites');
assert.equal(element('websiteRange').textContent, '1–10 of 100 sites');
run('changeWebsitePage(9)');
assert.equal(element('websiteNext').disabled, true);
element('websiteSearch').value = 'site-001';
run('filterWebsites()');
assert.equal(element('websiteRange').textContent, '1–1 of 1 matches');
run('websiteApps=[]; renderWebsites()');
assert(element('apps').innerHTML.includes('No websites yet'));

async function statusTests() {
  let concurrent = 0, maximum = 0, requests = 0;
  context.fetch = async () => {
    requests++;
    maximum = Math.max(maximum, ++concurrent);
    await new Promise(resolve => setImmediate(resolve));
    concurrent--;
    return { json: async () => ({ containers: [{ service: 'app', state: 'running' }] }) };
  };
  await run('hydrateAppCards(fixtures.slice(0,10), appsRefreshSeq)');
  assert.equal(requests, 10);
  assert.equal(maximum, 4);
  requests = 0;
  await Promise.all([
    run('hydrateAppCards(fixtures.slice(0,10), appsRefreshSeq)'),
    run('hydrateAppCards(fixtures.slice(10,20), appsRefreshSeq)')
  ]);
  assert.equal(requests, 20);
  assert.equal(maximum, 4, 'overlapping polls share the same four-request limit');
  assert.equal(element('appState-site-000').textContent, 'Running');
  assert(element('appLifecycle-site-000').innerHTML.includes('Stop'));
  run('setAppCardState("site-000", "deploying", false)');
  assert.equal(element('appPower-site-000').disabled, true);
  assert.equal(element('appState-site-000').textContent, 'Deploying');
  let finish;
  context.fetch = () => new Promise(resolve => { finish = () => resolve({ json: async () => ({ containers: [] }) }); });
  const manual = run('hydrateAppCards(fixtures.slice(0,1), appsRefreshSeq)');
  run('setAppCardState("site-000", "deploying", false)');
  finish();
  await manual;
  assert.equal(element('appState-site-000').textContent, 'Deploying', 'old status cannot clear a new deploy');
  const stale = run('hydrateAppCards(fixtures.slice(0,1), appsRefreshSeq)');
  run('websiteRenderSeq++');
  finish();
  await stale;
  assert.equal(element('appState-site-000').textContent, 'Deploying', 'old page requests are ignored');
  context.fetch = async () => ({ json: async () => ({ containers: [] }) });
  await run('hydrateAppCards(fixtures.slice(0,1), appsRefreshSeq)');
  assert.equal(element('appState-site-000').textContent, 'Off');
  assert(element('appLifecycle-site-000').innerHTML.includes('Start'));
  context.fetch = async () => { throw new Error('offline'); };
  await run('hydrateAppCards(fixtures.slice(0,1), appsRefreshSeq)');
  assert.equal(element('appState-site-000').textContent, 'Unavailable');
  console.log('website list: 100-site pagination, search, URLs, bounded status and stale guards: OK');
}
statusTests().catch(e => { console.error(e); process.exitCode = 1; });
