const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const source = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
const elements = new Map();
const element = id => {
  if (!elements.has(id)) elements.set(id, { innerHTML: '', style: {} });
  return elements.get(id);
};
const toasts = [];
let confirmed = null;
const context = vm.createContext({
  currentApp: 'demo',
  document: { getElementById: element },
  safeHtml: text => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
  uiConfirm: async value => { confirmed = value; return true; },
  toast: (text, ok) => toasts.push({ text, ok }),
  refresh: async () => {},
  loadDeployStatus: () => {}
});
const section = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
vm.runInContext('let remediateSeq=0, remediateCache=[], deployStatusSeq=0, deployLogSeq=0;\n' +
  section('function deploySourceName(', 'let remediateSeq =') +
  section('async function loadRemediations(', 'async function applyRemediation(') +
  section('async function applyRemediation(', 'function deployLastMarkup('), context);
const run = code => vm.runInContext(code, context);
async function main() {
  const stub = { key: 'dockerfile-restore:Dockerfile', kind: 'dockerfile-restore', title: 'Restore <backup>', detail: 'Writes <files>', files: ['Dockerfile'], preview: 'FROM <image>' };
  // failed deploy with suggestions renders escaped cards
  context.fetch = async url => ({ json: async () => url.includes('/remediations') ? [stub] : { ok: true, applied: ['Dockerfile'] } });
  await run('loadRemediations(true)');
  const html = element('remediateBox').innerHTML;
  assert(element('remediateCard').style.display === 'block');
  assert(html.includes('Restore &lt;backup&gt;') && html.includes('FROM &lt;image&gt;'));
  assert(!html.includes('<backup>'), 'suggestion content is HTML-escaped');
  // apply confirms with file list and recommends local rebuild, not a repo pull
  await run('applyRemediation(0)');
  assert(confirmed.title === 'Apply fix?' && confirmed.body.includes('Dockerfile'));
  assert(toasts.at(-1).text.includes('local rebuild') && toasts.at(-1).ok === true);
  const restore = { key: 'dockerfile-restore:Dockerfile', kind: 'dockerfile-restore', service: 'web', revision: 'verified-revision',
    title: 'Restore the original', detail: 'Preserve box edits', files: ['Dockerfile'], preview: 'FROM nginx' };
  let posted;
  context.fetch = async (url, opts) => {
    if (opts) posted = { url, body: JSON.parse(opts.body) };
    return { json: async () => opts ? { ok: true, applied: ['Dockerfile'] } : [restore] };
  };
  await run('loadRemediations(true)');
  assert(element('remediateBox').innerHTML.includes('restore original Dockerfile'));
  await run('applyRemediation(0)');
  assert.equal(posted.url, '/api/apps/demo/remediate');
  assert.deepEqual(posted.body, { key: restore.key, service: restore.service, revision: restore.revision });
  assert(confirmed.body.includes('local rebuild'));

  // Navigating away while the confirmation is open cannot apply to another site.
  posted = null;
  context.uiConfirm = async () => { context.currentApp = 'other'; return true; };
  await run('applyRemediation(0)');
  assert.equal(posted, null);
  context.currentApp = 'demo';
  context.fetch = async () => ({ json: async () => [{ kind: 'diagnostic', title: 'npm edgesOut', detail: 'Exact trigger unknown' }] });
  await run('loadRemediations(true)');
  assert(element('remediateBox').innerHTML.includes('npm edgesOut'));
  assert(!element('remediateBox').innerHTML.includes('<button'), 'diagnosis without a verified repair has no apply button');
  // no failure hides the card without fetching
  let fetched = false;
  context.fetch = async () => { fetched = true; return { json: async () => [] }; };
  await run('loadRemediations(false)');
  assert(!fetched && element('remediateCard').style.display === 'none');
  // stale site responses are ignored
  let finish;
  context.fetch = () => new Promise(resolve => { finish = () => resolve({ json: async () => [stub] }); });
  const pending = run('loadRemediations(true)');
  context.currentApp = 'other';
  await run('loadRemediations(false)');
  finish();
  await pending;
  assert(element('remediateCard').style.display === 'none');
  const compilerError = "pre-build failed: src/main.ts(3,9): error TS2307: Cannot find module './missing'\n[ELIFECYCLE] Command failed";
  context.compilerError = compilerError;
  const history = run('deployHistoryMarkup([{status:"error", error:compilerError}])');
  assert(history.includes('TS2307') && history.includes('[ELIFECYCLE]'), 'history keeps the compiler cause, not only its final footer');
  context.currentApp = 'demo';
  const finishes = [];
  context.fetch = () => new Promise(resolve => finishes.push(text => resolve({ text: async () => text })));
  const older = run('loadDeployLog()');
  const newer = run('loadDeployLog()');
  finishes[1]('new compiler output');
  await newer;
  finishes[0]('old log');
  await older;
  assert.equal(element('deployFullLog').textContent, 'new compiler output', 'older log requests cannot replace newer output');
  const wrongSite = run('loadDeployLog()');
  context.currentApp = 'other';
  element('deployFullLog').textContent = ''; // openSite clears the previous site's log
  finishes[2]('another site log');
  await wrongSite;
  assert.equal(element('deployFullLog').textContent, '', 'site navigation rejects stale log output');
  // A success on the same site also invalidates an in-flight failed-state load.
  context.currentApp = 'demo';
  context.fetch = () => new Promise(resolve => { finish = () => resolve({ json: async () => [stub] }); });
  const stale = run('loadRemediations(true)');
  await run('loadRemediations(false)');
  finish();
  await stale;
  assert(element('remediateCard').style.display === 'none');
  console.log('Remediation UI: escaped recovery preview, service/revision POST, local rebuild guidance, read-only diagnosis and stale/navigation guards: OK');
}
main().catch(e => { console.error(e); process.exitCode = 1; });
