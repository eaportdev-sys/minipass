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
assert(source.includes('function showRemoteSetup(') && source.includes('onclick="showRemoteSetup('), 'remotes have a connect flow with host steps');
console.log('Host storage UI: sidebar view, escaped candidates and approval-shaped targets: OK');