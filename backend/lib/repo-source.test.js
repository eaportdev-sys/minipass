const assert = require('assert');
const { repoSource } = require('./repo-source');
async function main() {
  for (const defaultBranch of ['main', 'master', 'develop', 'production']) {
    const calls = [];
    const get = async url => { calls.push(url); return url.includes('/branches?') ? [{ name: defaultBranch }, { name: 'feature/api' }] : { default_branch: defaultBranch }; };
    const detected = await repoSource(get, 'owner/project');
    assert.equal(detected.branch, defaultBranch);
    assert.equal(detected.defaultBranch, defaultBranch);
    assert.deepEqual(detected.branches, [defaultBranch, 'feature/api']);
    assert.equal(detected.branchesTruncated, false);
    assert.equal((await repoSource(get, 'owner/project', 'feature/api')).branch, 'feature/api');
    assert(calls.every(url => url.startsWith('/repos/owner/project')));
    let queried = false;
    await assert.rejects(repoSource(async () => { queried = true; }, 'owner/project', 'main;id'), /bad branch/);
    assert.equal(queried, false);
  }
  const unavailable = await repoSource(async url => { if (url.includes('/branches?')) throw new Error('unavailable'); return { default_branch: 'release' }; }, 'owner/project');
  assert.equal(unavailable.branch, 'release', 'branch-list failure never invents main');
  assert.deepEqual(unavailable.branches, ['release']);
  assert(unavailable.branchesTruncated);
  console.log('repository default/selected branches and bounded branch suggestions: OK');
}
main().catch(e => { console.error(e); process.exitCode = 1; });
