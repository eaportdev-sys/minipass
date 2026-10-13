const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const idxDoc = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const idxScripts = [...idxDoc.matchAll(/<script src="([^"]+)"><\/script>/g)].map(m => m[1]).filter(f => !/^https?:\/\//.test(f));
const source = idxScripts.map(f => fs.readFileSync(path.join(__dirname, f), 'utf8')).join('\n');
const elements = new Map();
const element = id => { if (!elements.has(id)) elements.set(id, { value: 'Dockerfile.web', textContent: '', innerHTML: '', style: {} }); return elements.get(id); };
const messages = [];
let refreshed = 0;
const calls = [];
const context = vm.createContext({
  document: { getElementById: element },
  toast: (text, ok) => messages.push({ text, ok }),
  refreshSiteData: () => { refreshed++; },
  fetch: async (url, opts) => { calls.push({ url, body: JSON.parse(opts.body) }); return { json: async () => ({ ok: true, saved: true, pending: true, dockerfile: 'Dockerfile.web' }) }; }
});
const section = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
vm.runInContext('let currentApp="demo";\n' + section('async function saveServiceDockerfile(', 'async function toggleService('), context);
const run = code => vm.runInContext(code, context);
async function main() {
  await run('saveServiceDockerfile("app")');
  assert.equal(calls[0].url, '/api/apps/demo/services/app/dockerfile');
  assert.deepEqual(calls[0].body, { dockerfile: 'Dockerfile.web' });
  assert(messages.at(-1).ok === true && messages.at(-1).text.includes('Dockerfile.web') && messages.at(-1).text.includes('redeploy'));
  assert.equal(refreshed, 1);
  context.fetch = async () => ({ json: async () => ({ ok: false, error: 'stale pick' }) });
  await run('saveServiceDockerfile("app")');
  assert(messages.at(-1).ok === false && messages.at(-1).text.includes('stale pick'));
  console.log('Service Dockerfile UI: variant pick saves with redeploy note, failures surface: OK');
}
main().catch(e => { console.error(e); process.exitCode = 1; });
