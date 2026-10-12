const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const idxDoc = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const idxScripts = [...idxDoc.matchAll(/<script src="([^"]+)"><\/script>/g)].map(m => m[1]).filter(f => !/^https?:\/\//.test(f));
const source = idxScripts.map(f => fs.readFileSync(path.join(__dirname, f), 'utf8')).join('\n');
let autoArg = undefined;
const els = {};
const context = vm.createContext({
  document: { getElementById: id => els[id] || (els[id] = { style: {}, textContent: '', value: '' }) },
  location: { origin: 'http://panel:3001' },
  setGithubAutomation: async v => { autoArg = v; }
});
vm.runInContext(source.slice(source.indexOf('function fillGithubAutomation('), source.indexOf('async function copyText(')), context);
const run = code => vm.runInContext(code, context);
const ids = ['githubAutomationOff', 'githubAutomationOn', 'githubAutomationOffTitle', 'githubAutomationOffMeta', 'githubAutomationEnable', 'hookUrl', 'pollSel', 'pollState'];
const fresh = () => { for (const id of ids) els[id] = { style: {}, textContent: '', value: '' }; autoArg = undefined; };
async function main() {
  // globally off, stale enabled: parked notice + disable rewiring
  fresh();
  await run(`fillGithubAutomation({ id: 'demo', autoDeploy: false, github: { repo: 'o/n', branch: 'main', enabled: true } })`);
  assert.equal(els.githubAutomationOff.style.display, 'block');
  assert.equal(els.githubAutomationOn.style.display, 'none');
  assert.equal(els.githubAutomationOffTitle.textContent, 'Automatic deploys disabled');
  assert(els.githubAutomationOffMeta.textContent.includes('parked') && els.githubAutomationOffMeta.textContent.includes('switch it off below'));
  assert.equal(els.githubAutomationEnable.textContent, 'disable leftover automation');
  await els.githubAutomationEnable.onclick();
  assert.equal(autoArg, false);
  // globally off, clean: enable hidden
  fresh();
  await run(`fillGithubAutomation({ id: 'demo', autoDeploy: false, github: { repo: 'o/n' } })`);
  assert.equal(els.githubAutomationEnable.style.display, 'none');
  // globally on, disabled: normal panel, defaults restored after the rewire above
  fresh();
  await run(`fillGithubAutomation({ id: 'demo', autoDeploy: true, github: { repo: 'o/n' } })`);
  assert.equal(els.githubAutomationOffTitle.textContent, 'GitHub automation is disabled');
  assert.equal(els.githubAutomationEnable.textContent, 'enable github automation');
  await els.githubAutomationEnable.onclick();
  assert.equal(autoArg, true);
  // globally on, enabled: live panel with hook url + poll state
  fresh();
  await run(`fillGithubAutomation({ id: 'demo', autoDeploy: true, github: { repo: 'o/n', branch: 'main', enabled: true, pollMinutes: 5, sha: 'abc123' } })`);
  assert.equal(els.githubAutomationOn.style.display, 'block');
  assert(els.hookUrl.textContent.includes('/webhook/demo'));
  assert.equal(els.pollSel.value, '5');
  console.log('Setup automation panel: parked state, leftover disable, defaults restore and live panel: OK');
}
main().catch(e => { console.error(e); process.exitCode = 1; });
