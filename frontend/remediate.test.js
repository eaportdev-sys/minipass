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
vm.runInContext('let remediateSeq=0, remediateCache=[], deployStatusSeq=0;\n' +
  section('async function loadRemediations(', 'async function applyRemediation(') +
  section('async function applyRemediation(', 'function deployLastMarkup('), context);
const run = code => vm.runInContext(code, context);
async function main() {
  const stub = { key: 'missing-module:src/common/utils.ts', title: 'Create <stub>', detail: 'Writes <files>', files: ['src/common/utils.ts'], preview: 'export const x = <any>;' };
  // failed deploy with suggestions renders escaped cards
  context.fetch = async url => ({ json: async () => url.includes('/remediations') ? [stub] : { ok: true, applied: ['src/common/utils.ts'] } });
  await run('loadRemediations(true)');
  const html = element('remediateBox').innerHTML;
  assert(element('remediateCard').style.display === 'block');
  assert(html.includes('Create &lt;stub&gt;') && html.includes('export const x = &lt;any&gt;;'));
  assert(!html.includes('<stub>'), 'suggestion content is HTML-escaped');
  // apply confirms with file list, posts the key, toasts redeploy
  await run('applyRemediation(0)');
  assert(confirmed.title === 'Apply fix?' && confirmed.body.includes('src/common/utils.ts'));
  assert(toasts.at(-1).text.includes('redeploy to build') && toasts.at(-1).ok === true);
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
  console.log('Remediation UI: escaped suggestion cards, confirm-with-files, redeploy toast and stale guards: OK');
}
main().catch(e => { console.error(e); process.exitCode = 1; });
