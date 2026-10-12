const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const source = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
const messages = [];
let refreshed = 0;
const calls = { token: [], account: [], link: [] };
const respond = { token: { ok: true }, account: { ok: true }, link: { ok: true, pulled: true }, repos: { repos: [] } };
const els = {
  gitSiteToken: { value: 'tok123' },
  gitRepoLink: { value: 'owner/name' },
  gitRepoPick: { value: '', innerHTML: '', style: {} },
  gitAccount: { value: '' }
};
const siteMeta = {};
const context = vm.createContext({
  currentApp: 'demo',
  document: { getElementById: id => els[id] || { value: '' }, createElement: () => ({ remove() {} }) },
  safeHtml: text => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
  refresh: () => { refreshed++; },
  setTimeout: () => 0,
  siteById: () => siteMeta,
  fetch: async (url, opts) => {
    const body = opts && opts.body ? JSON.parse(opts.body) : {};
    if (url.includes('/git-token')) { calls.token.push(body); return { json: async () => respond.token }; }
    if (url.includes('/git-account')) { calls.account.push(body); return { json: async () => respond.account }; }
    if (url.includes('/api/github/link')) { calls.link.push(body); return { json: async () => respond.link }; }
    if (url.includes('/git-repos')) { return { json: async () => respond.repos }; }
    throw new Error('unexpected ' + url);
  }
});
els.toasts = { appendChild: d => messages.push({ text: d.textContent, ok: !String(d.className).includes('err') }) };
vm.runInContext(source.slice(source.indexOf('async function useAccount('), source.indexOf('async function showLogs(')), context);
const run = code => vm.runInContext(code, context);
const reset = () => {
  calls.token.length = 0; calls.account.length = 0; calls.link.length = 0; messages.length = 0; refreshed = 0;
  respond.token = { ok: true }; respond.account = { ok: true }; respond.link = { ok: true, pulled: true };
  for (const k of Object.keys(siteMeta)) delete siteMeta[k];
};
async function main() {
  // token + repo, nothing linked yet: saves, then links (no login key posted)
  await run('saveSiteToken()');
  assert.deepEqual(calls.token, [{ token: 'tok123' }]);
  assert.deepEqual(calls.link, [{ appId: 'demo', repo: 'owner/name' }]);
  assert.equal(els.gitSiteToken.value, '');
  assert.equal(els.gitRepoLink.value, '');
  assert(messages.at(-1).ok === true && messages.at(-1).text.includes('downloaded'));
  assert(messages.at(-1).text.includes('confirm services below'));
  assert.equal(refreshed, 1);
  // repo already linked (e.g. token expired, repasting): no owner/name needed, no link call
  reset();
  respond.token = { ok: true, repo: 'owner/name', verified: true };
  els.gitSiteToken.value = 'newtok'; els.gitRepoLink.value = '';
  await run('saveSiteToken()');
  assert.equal(calls.token.length, 1);
  assert.equal(calls.link.length, 0);
  assert(messages.at(-1).ok === true && messages.at(-1).text.includes('connected to owner/name'));
  // repasted token cannot read the linked repo: says so instead of pretending
  reset();
  respond.token = { ok: true, repo: 'owner/name', verified: false, verifyError: 'github api 403: Resource not accessible' };
  els.gitSiteToken.value = 'newtok'; els.gitRepoLink.value = '';
  await run('saveSiteToken()');
  assert.equal(calls.link.length, 0);
  assert(messages.at(-1).ok === false && messages.at(-1).text.includes('cannot read owner/name'));
  // linked repo, field refilled with the same repo: still no link call
  reset();
  respond.token = { ok: true, repo: 'owner/name', verified: true };
  els.gitSiteToken.value = 'newtok'; els.gitRepoLink.value = 'owner/name';
  await run('saveSiteToken()');
  assert.equal(calls.link.length, 0);
  // linked repo, field holds a different repo: switches via link, old code stays
  reset();
  respond.token = { ok: true, repo: 'owner/name', verified: true };
  respond.link = { ok: true, pulled: false, codePresent: true, pullNote: 'code on disk is from owner/name - redeploy pulls other/repo' };
  els.gitSiteToken.value = 'newtok'; els.gitRepoLink.value = 'other/repo';
  await run('saveSiteToken()');
  assert.deepEqual(calls.link, [{ appId: 'demo', repo: 'other/repo' }]);
  assert(messages.at(-1).ok === true && messages.at(-1).text.includes('code on disk'));
  // link saved but download failed: says so, flagged as failure
  reset();
  respond.link = { ok: true, pulled: false, codePresent: false, pullNote: 'download failed: boom' };
  els.gitSiteToken.value = 'newtok'; els.gitRepoLink.value = 'owner/name';
  await run('saveSiteToken()');
  assert(messages.at(-1).ok === false && messages.at(-1).text.includes('not downloaded'));
  // token, no repo anywhere: saves only
  reset();
  els.gitSiteToken.value = 'tok123'; els.gitRepoLink.value = '';
  await run('saveSiteToken()');
  assert.equal(calls.token.length, 1);
  assert.equal(calls.link.length, 0);
  assert(messages.at(-1).text.includes('site token saved'));
  // empty token: error, no requests
  reset();
  els.gitSiteToken.value = '  ';
  await run('saveSiteToken()');
  assert.equal(calls.token.length + calls.link.length, 0);
  assert(messages.at(-1).ok === false);
  // bad repo, nothing linked: token saved, link skipped
  reset();
  els.gitSiteToken.value = 'tok123'; els.gitRepoLink.value = 'not-a-repo';
  await run('saveSiteToken()');
  assert.equal(calls.token.length, 1);
  assert.equal(calls.link.length, 0);
  assert(messages.at(-1).text.includes('owner/name'));
  // account + repo: saves account, then links with it
  reset();
  els.gitAccount.value = 'someone'; els.gitRepoLink.value = 'owner/name';
  await run('useAccount()');
  assert.deepEqual(calls.account, [{ login: 'someone' }]);
  assert.deepEqual(calls.link, [{ appId: 'demo', repo: 'owner/name', login: 'someone' }]);
  assert(messages.at(-1).text.includes('connected'));
  // account with linked repo and a stored site token: says the token stays first
  reset();
  respond.account = { ok: true, repo: 'owner/name' };
  siteMeta.github = { hasToken: true };
  els.gitAccount.value = 'someone'; els.gitRepoLink.value = '';
  await run('useAccount()');
  assert.equal(calls.link.length, 0);
  assert(messages.at(-1).text.includes('still used first'));
  // unlink with repo filled: only unlinks, never links
  reset();
  els.gitAccount.value = ''; els.gitRepoLink.value = 'owner/name';
  await run('useAccount()');
  assert.deepEqual(calls.account, [{ login: '' }]);
  assert.equal(calls.link.length, 0);
  assert(messages.at(-1).text.includes('unlinked'));
  // repo picker: lists credential-visible repos, picking fills the input
  reset();
  respond.repos = { repos: [{ full_name: 'owner/name', private: true, default_branch: 'main' }, { full_name: 'owner/other', private: false }] };
  els.gitRepoPick.value = '';
  await run('listSiteRepos()');
  assert(els.gitRepoPick.innerHTML.includes('owner/other') && els.gitRepoPick.innerHTML.includes('(private)'));
  assert(messages.at(-1).text.includes('2 repos'));
  els.gitRepoPick.value = 'owner/other';
  await run('pickSiteRepo()');
  assert.equal(els.gitRepoLink.value, 'owner/other');
  // picker with no credential: backend error surfaces
  reset();
  respond.repos = { error: 'save a site token or connect an account first' };
  await run('listSiteRepos()');
  assert(messages.at(-1).ok === false && messages.at(-1).text.includes('first'));
  console.log('Setup git connect: repaste reuses the stored link, download-on-connect, switch/unlink/validation, repo picker: OK');
}
main().catch(e => { console.error(e); process.exitCode = 1; });
