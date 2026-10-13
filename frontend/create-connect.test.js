const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const idxDoc = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const idxScripts = [...idxDoc.matchAll(/<script src="([^"]+)"><\/script>/g)].map(m => m[1]).filter(f => !/^https?:\/\//.test(f));
const source = idxScripts.map(f => fs.readFileSync(path.join(__dirname, f), 'utf8')).join('\n');
const elements = new Map();
function element(id) {
  if (!elements.has(id)) {
    const classes = new Set();
    elements.set(id, {
      value: '', textContent: '', innerHTML: '', style: {}, title: '', disabled: false,
      classList: {
        add: c => classes.add(c), remove: c => classes.delete(c),
        toggle: (c, force) => { if (force) classes.add(c); else classes.delete(c); },
        has: c => classes.has(c)
      }
    });
  }
  return elements.get(id);
}
const messages = [];
const context = vm.createContext({
  document: {
    getElementById: element,
    querySelector: () => ({ checked: false }),
    querySelectorAll: () => []
  },
  safeHtml: text => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
  toast: (text, ok) => messages.push({ text, ok }),
  fetch: null
});
const section = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
vm.runInContext('let createModalSession=1, createConnectRequest=0, createDetectRequest=0, createDetectRepo="", createDetectedManager="npm", modalLogin=null;\n' +
  section('function storageSize(', 'function storageMarkup(') +
  section('async function modalListRepos(', 'async function ghDisconnect(') +
  section('async function detectType(', 'function setSubdir('), context);
const run = code => vm.runInContext(code, context);
const tick = () => new Promise(resolve => setImmediate(resolve));
async function main() {
  // empty token: error, no request, controls untouched
  element('ghModalToken').value = '  ';
  let fetched = 0;
  context.fetch = async () => { fetched++; return { json: async () => ({}) }; };
  await run('modalListRepos()');
  assert.equal(fetched, 0);
  assert.equal(messages.at(-1).ok, false);
  assert.equal(element('ghModalConnect').disabled, false);

  // list repos: locked row + waiting state while the preview runs
  element('ghModalToken').value = 'tok123';
  let release;
  context.fetch = () => new Promise(resolve => { release = () => resolve({ json: async () => ({ login: 'someone', repos: [{ full_name: 'owner/repo', private: false }] }) }); });
  const listing = run('modalListRepos()');
  await tick();
  assert.equal(element('ghModalConnect').disabled, true, 'list button waits while preview runs');
  assert.equal(element('ghModalConnect').textContent, 'Loading…');
  assert.equal(element('ghModalToken').disabled, true, 'token waits while preview runs');
  assert.equal(element('ghrepo').disabled, true, 'repo picker waits while preview runs');
  assert(element('ghConnState').textContent.includes('GitHub'));
  assert(element('ghConnState').classList.has('inline-dots'), 'waiting dots show while preview runs');
  release(); await listing;
  assert.equal(element('ghModalConnect').disabled, false, 'controls restore after listing');
  assert.equal(element('ghModalToken').disabled, false);
  assert.equal(element('ghrepo').disabled, false);
  assert.equal(element('ghConnState').classList.has('inline-dots'), false);
  assert(element('ghrepo').innerHTML.includes('owner/repo'));
  assert(element('ghConnState').textContent.includes('Connected as someone'));

  // preview error: restored + failure shown, no repo fill
  element('ghrepo').innerHTML = '<option value="">GitHub repo…</option>';
  context.fetch = async () => ({ json: async () => ({ error: 'bad credentials' }) });
  await run('modalListRepos()');
  assert.equal(element('ghModalConnect').disabled, false);
  assert.equal(element('ghModalConnect').textContent, 'List repos');
  assert.equal(element('ghrepo').innerHTML, '<option value="">GitHub repo…</option>');
  assert(element('ghConnState').textContent.includes('failed'));
  assert.equal(messages.at(-1).ok, false);

  // stale preview (form reset mid-flight): controls still restore, late repos ignored
  context.fetch = () => new Promise(resolve => { release = () => resolve({ json: async () => ({ login: 'late', repos: [{ full_name: 'owner/late', private: false }] }) }); });
  const staleList = run('modalListRepos()');
  await tick();
  run('createModalSession++');
  release(); await staleList;
  assert.equal(element('ghModalConnect').disabled, false, 'stale preview still restores controls');
  assert(!element('ghrepo').innerHTML.includes('owner/late'), 'stale preview cannot fill a new form');
  run('createModalSession=1');

  // repo select: picker locked + waiting state while detection reads the repo
  element('ghrepo').value = 'owner/repo';
  element('branch').value = '';
  context.fetch = () => new Promise(resolve => { release = () => resolve({ json: async () => ({ type: 'node', dbs: [], branch: 'main', defaultBranch: 'main', branches: ['main'], repositorySize: { bytes: 1048576, complete: true } }) }); });
  const detecting = run('detectType()');
  await tick();
  assert.equal(element('ghrepo').disabled, true, 'repo picker waits while detection runs');
  assert(element('createDetectState').textContent.includes('Detecting'));
  assert(element('createDetectState').classList.has('inline-dots'), 'waiting dots show while detection runs');
  release(); await detecting;
  assert.equal(element('ghrepo').disabled, false, 'picker restores after detection');
  assert.equal(element('createDetectState').classList.has('inline-dots'), false);
  assert(element('createDetectState').textContent.includes('Detected'));

  // stale detection: picker restores, late result ignored
  context.fetch = () => new Promise(resolve => { release = () => resolve({ json: async () => ({ type: 'php', dbs: [] }) }); });
  const staleDetect = run('detectType()');
  await tick();
  assert.equal(element('ghrepo').disabled, true);
  run('createModalSession++');
  release(); await staleDetect;
  assert.equal(element('ghrepo').disabled, false, 'stale detection still restores the picker');
  assert(!element('createDetectState').textContent.includes('Detected PHP'), 'stale detection cannot overwrite a new form');
  console.log('Create connect UI: token list and repo select wait with visible loading, stale-safe restore: OK');
}
main().catch(e => { console.error(e); process.exitCode = 1; });
