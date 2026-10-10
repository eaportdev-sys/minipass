const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const source = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
const start = source.indexOf('function lifecycleError(');
const end = source.indexOf('async function trashOperation(', start);
const context = vm.createContext({
  creatingSites: new Set(), lifecycleLocks: new Set(), deployQueues: new Map(), deployLocks: new Set(), deployOps: new Map()
});
vm.runInContext(source.slice(start, end), context);
const run = code => vm.runInContext(code, context);
async function main() {
  assert.equal(run('cancelDeploy("ghost")'), false, 'no in-flight deploy means nothing to cancel');
  run('deployOps.set("site-a", { source: "manual", startedAt: Date.now() })');
  run('checkCancelled("site-a")');
  assert.equal(run('cancelDeploy("site-a")'), true);
  assert.throws(() => run('checkCancelled("site-a")'), /stopped mid-deploy/);
  // stop proceeds despite a busy deploy queue once it flagged cancellation
  run('deployQueues.set("site-a", Promise.resolve())');
  run('globalThis.ran = false');
  await run('(async () => { await siteLifecycle("site-a", async () => { globalThis.ran = true; }, { allowDeploy: true }); })()');
  assert(run('globalThis.ran'), 'stop takes the lifecycle lock while the deploy drains');
  assert(!context.lifecycleLocks.has('site-a'), 'lifecycle lock releases');
  // ...but without the stop flag the same state still refuses
  run('globalThis.ran = false');
  await assert.rejects(run('(async () => { await siteLifecycle("site-a", async () => { globalThis.ran = true; }); })()'), /wait for the current site operation/);
  assert(!run('globalThis.ran'));
  // ordinary creation locks still block even stop
  run('creatingSites.add("site-b")');
  await assert.rejects(run('(async () => { await siteLifecycle("site-b", async () => {}, { allowDeploy: true }); })()'), /wait for the current site operation/);
  console.log('Lifecycle: mid-deploy stop cancels and proceeds, other guards hold, locks release: OK');
}
main().catch(e => { console.error(e); process.exitCode = 1; });
