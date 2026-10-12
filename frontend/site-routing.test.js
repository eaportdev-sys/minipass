const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const idxDoc = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const idxScripts = [...idxDoc.matchAll(/<script src="([^"]+)"><\/script>/g)].map(m => m[1]).filter(f => !/^https?:\/\//.test(f));
const source = idxScripts.map(f => fs.readFileSync(path.join(__dirname, f), 'utf8')).join('\n');
const section = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));

const historyCalls = [];
const listeners = {};
const calls = [];
const location = { pathname: '/', search: '', hash: '' };
const context = vm.createContext({
  location,
  URLSearchParams,
  history: {
    pushState: (...a) => historyCalls.push(['push', ...a]),
    replaceState: (...a) => historyCalls.push(['replace', ...a])
  },
  window: { addEventListener: (ev, fn) => { listeners[ev] = fn; } },
  currentApp: null,
  calls,
  showView: () => {},
  refresh: async () => [],
  loadTrash: async () => {}
});
const run = code => vm.runInContext(code, context);
vm.runInContext(section('const SITE_TABS', 'function openSite('), context);
vm.runInContext(section('function backToSites(', 'function fillSiteHeader('), context);
assert(listeners.popstate, 'Back/Forward restores the panel route');

// Site visits push entries; repeats do not stack duplicates.
run(`rememberSiteRoute('site-abc', 'deploy', true)`);
assert.deepEqual(historyCalls.pop(), ['push', { site: 'site-abc', tab: 'deploy' }, '', '/#site=site-abc&tab=deploy']);
location.hash = '#site=site-abc&tab=deploy';
run(`rememberSiteRoute('site-abc', 'deploy', true)`);
assert.equal(historyCalls.length, 0, 'repeat visit to the open site adds no entry');
// Tab switches only update the current entry.
run(`rememberSiteRoute('site-abc', 'logs')`);
assert.deepEqual(historyCalls.pop(), ['replace', { site: 'site-abc', tab: 'logs' }, '', '/#site=site-abc&tab=logs']);

// Leaving for the list pushes; history-driven returns replace.
location.hash = '#site=site-abc&tab=logs';
run('backToSites()');
assert.equal(historyCalls.pop()[0], 'push', 'leaving a site pushes the list entry');
location.hash = '#site=site-abc&tab=logs';
run('backToSites(false)');
assert.equal(historyCalls.pop()[0], 'replace', 'history-driven return replaces');

// Back/Forward drives navigation without writing history.
run('openSite = (...a) => calls.push(["openSite", ...a]); backToSites = (...a) => calls.push(["backToSites", ...a]);');
location.hash = '#site=site-xyz&tab=environment';
listeners.popstate();
assert.deepEqual(calls.pop(), ['openSite', 'site-xyz', 'environment', false], 'Back to a site reopens it without pushing');
location.hash = '';
listeners.popstate();
assert.deepEqual(calls.pop(), ['backToSites', false], 'Back to the list returns without pushing');
assert.equal(historyCalls.length, 0, 'history navigation writes no entries');

console.log('site routing: Back/Forward across list, sites and tabs: OK');
