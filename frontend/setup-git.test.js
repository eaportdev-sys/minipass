const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const source = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
const messages = [];
let refreshed = 0, posted = null;
const els = {
  gitRepoLink: { value: '  owner/name  ' },
  gitAccount: { value: '' }
};
const context = vm.createContext({
  currentApp: 'demo',
  document: { getElementById: id => els[id] || { value: '' }, createElement: () => ({ remove() {} }) },
  refresh: () => { refreshed++; },
  setTimeout: () => 0
});
els.toasts = { appendChild: d => messages.push({ text: d.textContent, ok: !String(d.className).includes('err') }) };
vm.runInContext(source.slice(source.indexOf('async function useAccount('), source.indexOf('async function showLogs(')), context);
const run = code => vm.runInContext(code, context);
async function main() {
  context.fetch = async (url, opts) => { posted = JSON.parse(opts.body); return { json: async () => ({ ok: true, repoUrl: 'https://github.com/owner/name.git' }) }; };
  await run('linkRepo()');
  assert.deepEqual(posted, { appId: 'demo', repo: 'owner/name' });
  assert.equal(els.gitRepoLink.value, '', 'input clears after a successful link');
  assert(messages.at(-1).ok === true && messages.at(-1).text.includes('owner/name'));
  assert.equal(refreshed, 1);
  els.gitRepoLink.value = 'not-a-repo';
  await run('linkRepo()');
  assert(messages.at(-1).ok === false && messages.at(-1).text.includes('owner/name'));
  context.fetch = async () => ({ json: async () => ({ ok: false, error: 'repo is not public' }) });
  els.gitRepoLink.value = 'owner/name';
  await run('linkRepo()');
  assert(messages.at(-1).ok === false && messages.at(-1).text.includes('not public'));
  console.log('Setup git link: validation, post shape, success and failure toasts: OK');
}
main().catch(e => { console.error(e); process.exitCode = 1; });
