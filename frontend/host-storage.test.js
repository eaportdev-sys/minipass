const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const source = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
assert(html.includes('data-view="storage"') && html.includes('id="view-storage"'));
assert(html.includes('id="provisionTarget"') && html.includes('id="remoteAddress"'));
const section = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
const context = vm.createContext({
  safeHtml: text => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
  storageSize: v => String(v),
  document: { getElementById: () => ({ textContent: '', innerHTML: '' }), querySelectorAll: () => [] }
});
vm.runInContext(section('function hostCandidateRows(', 'async function loadHostStorage('), context);
const rows = vm.runInContext(`hostCandidateRows({vgFree:{'ubuntu-vg':1},spares:['/dev/sdb'],freeRegions:[{disk:'/dev/sda',start:1,end:2,bytes:3}]})`, context);
assert(rows.includes('vg:ubuntu-vg') && rows.includes('device:/dev/sdb') && rows.includes('region:/dev/sda:1:2'));
assert(rows.includes('fillProvisionTarget('), 'candidates fill the approval field instead of requiring retyping');
const evil = vm.runInContext(`hostCandidateRows({vgFree:{'<vg>':1},spares:[],freeRegions:[]})`, context);
assert(!evil.includes('<vg>'), 'candidate names are escaped');
const capacity = vm.runInContext(`hostCapacityMarkup({bridge:{mount:{source:'/dev/sda2',target:'/'},appsTotalBytes:100,appsFreeBytes:36},quota:{ready:false,error:'not active'}})`, context);
assert(capacity.includes('/dev/sda2') && capacity.includes('100 total') && capacity.includes('64 used') && capacity.includes('36 free'), 'capacity shows drive size, used and available');
assert(capacity.includes('not active'), 'quota state stays visible below the numbers');
const blocked = vm.runInContext(`hostCapacityMarkup({bridge:{},quota:{ready:false,error:'generic quota error'},setup:{message:'Site files exist and Docker containers are running.'}},{target:'region:/dev/sda:1:2'})`, context);
assert(blocked.includes('Site files exist') && !blocked.includes('generic quota error'), 'specific installer status replaces the generic quota error');
assert(blocked.includes('stop every running site') && blocked.includes('docker compose -p minipass down'), 'running-container blocker has concrete shutdown steps');
assert(blocked.includes('approved installer command'), 'instructions tell the operator to preserve and rerun the approved command');
assert(!blocked.includes('MINIPASS_USE_FREE_SPACE'), 'panel command does not bypass the sudo installer confirmation');
assert(!html.includes('50 GB free recommended at install'), 'obsolete install-size note is not shown in Storage');
assert(source.includes('function showRemoteSetup(') && source.includes('onclick="showRemoteSetup('), 'remotes have a connect flow with host steps');

async function verifyProvisionStatus() {
  const elements = Object.fromEntries(['hostStorageBox', 'hostCandidates', 'hostQuotaState', 'provisionOut'].map(id => [id, { textContent: '', innerHTML: '', className: '' }]));
  const responses = {
    '/api/panel/storage/discovery': { quota: { ready: true }, bridge: {} },
    '/api/panel/storage/provision': { approval: { target: 'region:/dev/sda:1:2', status: 'pending-host' } }
  };
  const loadContext = vm.createContext({
    document: { getElementById: id => elements[id] || null },
    fetch: async url => ({ json: async () => responses[url] }),
    hostCapacityMarkup: () => 'capacity',
    hostCandidateRows: () => 'candidates',
    loadRemotes: () => undefined
  });
  vm.runInContext(section('async function loadHostStorage(', 'async function loadRemotes('), loadContext);
  await vm.runInContext('loadHostStorage()', loadContext);
  assert.equal(elements.provisionOut.textContent, 'Storage setup complete — quotas are active.', 'active quotas replace a stale pending-host approval');

  responses['/api/panel/storage/discovery'].quota.ready = false;
  await vm.runInContext('loadHostStorage()', loadContext);
  assert(elements.provisionOut.textContent.startsWith('Pending host approval: region:/dev/sda:1:2'), 'unfinished setup still shows its exact approved target');
}

verifyProvisionStatus().then(() => console.log('Host storage UI: sidebar view, escaped candidates, exact approvals and completed-state override: OK')).catch(error => { console.error(error); process.exitCode = 1; });
