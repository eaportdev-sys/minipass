const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const source = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const section = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
assert(html.includes('onclick="copyLogs()"'));
assert(html.includes('id="logs"') && html.includes('onclick="showBuildLog(true)"'));
const log = { textContent: '' };
const messages = [];
let copied, fallbackText, fallbackCalls = 0;
const context = vm.createContext({
  window: { isSecureContext: true },
  navigator: { clipboard: { writeText: async text => { copied = text; } } },
  document: {
    getElementById: id => { assert.equal(id, 'logs'); return log; },
    createElement: tag => {
      assert.equal(tag, 'textarea');
      return { value: '', style: {}, setAttribute() {}, select() { fallbackText = this.value; }, setSelectionRange() {}, remove() {} };
    },
    body: { appendChild() {} },
    execCommand: command => { assert.equal(command, 'copy'); fallbackCalls++; return true; }
  },
  toast: (text, ok) => messages.push({ text, ok })
});
vm.runInContext(section('async function copyText(', 'async function copyLocal(') + section('async function copyLogs(', 'async function version('), context);
async function main() {
  const text = '  #14 Err:1 invalid signature\nE: <repository> is not signed.\n\nUnicode: → ✓\n';
  log.textContent = text;
  await vm.runInContext('copyLogs()', context);
  assert.equal(copied, text, 'copy raw displayed text without trimming, escaping or fetching');
  assert.equal(fallbackCalls, 0);
  assert.equal(messages.at(-1).ok, true);
  context.window.isSecureContext = false;
  await vm.runInContext('copyLogs()', context);
  assert.equal(fallbackText, text, 'plain HTTP LAN uses the existing clipboard fallback');
  assert.equal(fallbackCalls, 1);
  context.window.isSecureContext = true;
  context.navigator.clipboard.writeText = async () => { throw new Error('permission denied'); };
  await vm.runInContext('copyLogs()', context);
  assert.equal(fallbackCalls, 2, 'denied secure clipboard falls back');
  context.document.execCommand = () => false;
  await vm.runInContext('copyLogs()', context);
  assert.equal(messages.at(-1).ok, false, 'failed copy never reports success');
  const attempts = fallbackCalls;
  for (const placeholder of ['', ' \n ', 'loading…', 'open a website first']) {
    log.textContent = placeholder;
    await vm.runInContext('copyLogs()', context);
    assert.equal(messages.at(-1).text, 'load logs before copying');
  }
  assert.equal(fallbackCalls, attempts, 'empty/loading states are not copied');
  console.log('log copy: exact text, HTTPS and HTTP LAN clipboard paths, permission failure and empty states: OK');
}
main().catch(e => { console.error(e); process.exitCode = 1; });
