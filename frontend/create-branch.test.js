const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const source = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
const elements = new Map();
const element = id => {
  if (!elements.has(id)) elements.set(id, { value: '', textContent: '', innerHTML: '', style: {}, title: '' });
  return elements.get(id);
};
const pills = [{ value: 'postgres', checked: false }, { value: 'mysql', checked: false }];
const context = vm.createContext({ document: { getElementById: element, querySelector: () => ({ value: 'local' }), querySelectorAll: () => pills } });
const section = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
vm.runInContext('let createModalSession=1, createDetectRequest=0, createConnectRequest=0, createDetectRepo="", createStandardDockerfile=false, createStorageAvailable=null, modalLogin=null;\n' +
  section('async function detectType(', 'function setSubdir(') +
  section('function safeHtml(', 'async function loadDatabases(') +
  section('function resetCreateForm(', 'function useCreateStandardDockerfile(') +
  section('function accessChanged(', 'function openCreate('), context);
const run = code => vm.runInContext(code, context);
async function main() {
  const bodies = [];
  context.fetch = async (url, opts) => {
    const body = JSON.parse(opts.body);
    bodies.push(body);
    const defaultBranch = body.repo === 'owner/other' ? 'production' : 'master';
    const branch = body.branch || defaultBranch;
    return { json: async () => ({ branch, defaultBranch, branches: [defaultBranch, 'feature/api'], type: branch === 'feature/api' ? 'node' : 'php', dbs: branch === 'feature/api' ? ['postgres'] : [], dbNote: branch === 'feature/api' ? '' : 'SQLite detected' }) };
  };
  element('repo').value = 'https://github.com/owner/project';
  await run('detectType()');
  assert.equal(bodies[0].branch, '');
  assert.equal(element('branch').value, 'master');
  assert.equal(element('branchDefault').textContent, '(default)');
  assert(element('createBranches').innerHTML.includes('feature/api'));
  assert(element('createDetectState').textContent.includes('on master'));
  element('branch').value = 'feature/api';
  await run('detectType()');
  assert.equal(bodies[1].branch, 'feature/api');
  assert(pills[0].checked);
  assert.equal(element('dbDetectNote').style.display, 'none');
  assert(element('createDetectState').textContent.includes('Node.js + postgres on feature/api'));
  element('repo').value = 'https://github.com/owner/other';
  await run('detectType()');
  assert.equal(bodies[2].branch, '', 'new repository starts from its own default branch');
  assert.equal(element('branch').value, 'production');
  let finish;
  context.fetch = () => new Promise(resolve => { finish = () => resolve({ json: async () => ({ branch: 'production', defaultBranch: 'production', type: 'php', dbs: [] }) }); });
  const pending = run('detectType()');
  element('branch').value = 'feature/typed';
  finish();
  await pending;
  assert.equal(element('branch').value, 'feature/typed', 'in-flight detection cannot overwrite a typed branch');
  const stale = run('detectType()');
  run('resetCreateForm()');
  finish();
  await stale;
  assert.equal(element('branch').value, '');
  assert.equal(element('createBranches').innerHTML, '');
  assert.equal(element('branchDefault').textContent, '');
  context.fetch = async () => ({ json: async () => ({ branch: 'main', defaultBranch: 'main', type: 'static', buildProfile: { kind: 'jekyll', output: '_site', needsModernization: true, warnings: ['Repository Node: v14.18.0'] } }) });
  element('repo').value = 'https://github.com/owner/static-site';
  await run('detectType()');
  assert.equal(element('createBuildProfile').style.display, 'block');
  assert.equal(element('createModernBuildRow').style.display, 'flex');
  assert(element('createBuildNote').textContent.includes('Node 24'));
  assert(element('createBuildNote').textContent.includes('_site'));
  assert.equal(element('createModernBuild').checked, false, 'modernization is opt-in');
  element('createModernBuild').checked = true;
  run('resetCreateForm()');
  assert.equal(element('createModernBuild').checked, false);
  assert.equal(element('createBuildProfile').style.display, 'none');
  context.fetch = async () => ({ json: async () => ({ branch: 'main', type: 'node' }) });
  element('repo').value = 'https://github.com/owner/backend';
  await run('detectType()');
  assert.equal(element('createBuildProfile').style.display, 'none', 'ordinary Node apps do not inherit static build setup');
  console.log('create branch selection, branch-aware detection and reset guards: OK');
}
main().catch(e => { console.error(e); process.exitCode = 1; });
