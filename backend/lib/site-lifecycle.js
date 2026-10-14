// site-lifecycle: extracted from the original backend without changing route semantics.
module.exports = function createHelpers(ctx) {
  const { TRASH_DIR, TRASH_HOLD_MS, creatingSites, dbTools, deletions, deployChildren, deployEpochs, deployLocks, deployOps, deployQueues, execFileSync, lifecycleLocks, panelLog, quotas, redactUrl, trashKey, trashLib, trashOptions } = ctx;
  const load = (...args) => ctx.load(...args);
  const save = (...args) => ctx.save(...args);
  let trashBusy = false;
  let cachePending = false;
  deletions.onDrain(async () => {
    if (!cachePending) return;
    cachePending = false;
    const actor = { username: 'system:shared-cache' };
    try {
      await trashLib.pruneBuildCache(trashOptions());
      if (ctx.store) ctx.store.audit('cache.pruned', null, 'success', {}, actor);
    } catch (e) {
      console.error('Shared build-cache cleanup:', e.message);
      if (ctx.store) ctx.store.audit('cache.pruned', null, 'failure', { error: e.message }, actor);
    }
  });
function lifecycleError(message, status = 409) { return Object.assign(new Error(message), { status }); }

function deployCancelledError() {
  return new Error('deploy cancelled - the site was stopped mid-deploy; containers stay stopped');
}

function trackDeployChild(id, child) {
  if (!child) return child;
  let children = deployChildren.get(id);
  if (!children) { children = new Set(); deployChildren.set(id, children); }
  children.add(child);
  child.once('close', () => {
    const current = deployChildren.get(id);
    if (!current) return;
    current.delete(child);
    if (!current.size) deployChildren.delete(id);
  });
  // Stop may have raced the spawn by a few microtasks.
  const op = deployOps.get(id);
  if (op && op.cancelled) killProcessTree(child);
  return child;
}

function killProcessTree(child) {
  if (!child || !child.pid) return;
  // Deploy commands run as their own process group on Linux. Killing the group
  // terminates the shell, docker compose, and its active build client together.
  if (process.platform !== 'win32') {
    try { process.kill(-child.pid, 'SIGTERM'); } catch { try { child.kill('SIGTERM'); } catch {} }
    const timer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 2000);
    if (timer.unref) timer.unref();
  } else {
    try { execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); }
    catch { try { child.kill('SIGTERM'); } catch {} }
  }
}

function killDeployChildren(id) {
  for (const child of [...(deployChildren.get(id) || [])]) killProcessTree(child);
}

function cancelDeploy(id) {
  const op = deployOps.get(id);
  const busy = !!op || deployQueues.has(id) || deployLocks.has(id);
  if (!busy) return false;
  deployEpochs.set(id, (deployEpochs.get(id) || 0) + 1);
  if (op) op.cancelled = true;
  killDeployChildren(id);
  return true;
}

function checkCancelled(id) {
  const op = deployOps.get(id);
  if (op && op.cancelled) throw deployCancelledError();
}

async function siteLifecycle(id, action, opts = {}) {
  const deployBusy = deployQueues.has(id) || deployLocks.has(id);
  if (creatingSites.has(id) || lifecycleLocks.has(id) || (deployBusy && !opts.allowDeploy)) throw lifecycleError('wait for the current site operation to finish');
  lifecycleLocks.add(id);
  try { return await action(); } finally { lifecycleLocks.delete(id); }
}

async function trashOperation(action) {
  return deletions.run(async () => {
    trashBusy = true;
    try { return await action(); } finally { trashBusy = false; }
  });
}

async function destroyTrashRecord(record, selected, opts = {}) {
  return siteLifecycle(record.id, async () => {
    try {
      const db_ = load();
      if (db_.apps.some(a => a.id === record.id)) throw lifecycleError('a live site reuses this Compose project - cleanup blocked to protect it');
      const siblings = (db_.trash || []).filter(t => t.id === record.id);
      if (siblings.some(t => !selected.has(trashKey(t)))) throw lifecycleError('multiple Trash generations share this name - use Empty trash to destroy them together');
      const dir = trashLib.trashPath(TRASH_DIR, record);
      const images = await trashLib.collectImages({ id: record.id, dir, record, ...trashOptions() });
      const before = load();
      for (const item of before.trash || []) {
        if (item.id === record.id && selected.has(trashKey(item))) item.cleanupStartedAt = item.cleanupStartedAt || Date.now();
        if (trashKey(item) === trashKey(record)) { item.trashImages = images; item.cleanupAttemptAt = Date.now(); delete item.cleanupError; }
      }
      save(before);
      const cleanup = await trashLib.destroySite({ record, trashRoot: TRASH_DIR, images, skipPrune: true,
        protectedImages: [...Object.values(require('./generator').DB_IMAGES), ...dbTools.IMAGES, 'minipass-panel:latest'], ...trashOptions() });
      if (!opts.skipPrune) cachePending = true; // one shared prune after the whole queued batch, not one heavy prune per site
      if (record.storageQuota && record.storageQuota.projectId) await quotas.release(record.id);
      const fresh = load();
      fresh.trash = (fresh.trash || []).filter(t => trashKey(t) !== trashKey(record));
      save(fresh);
      return cleanup;
    } catch (e) {
      const fresh = load();
      const retained = (fresh.trash || []).find(t => trashKey(t) === trashKey(record));
      if (retained) { retained.cleanupError = redactUrl(e.message).slice(-600); retained.cleanupAttemptAt = Date.now(); save(fresh); }
      if (ctx.store) ctx.store.audit('site.destroyed', record, 'failure');
      try { panelLog.logEvent({ level: 'error', area: 'trash-destroy', site: record.id, message: e.message }); } catch {}
      throw e;
    }
  });
}

async function purgeTrash() {
  if (trashBusy || deletions.pending) return;
  try {
    const run = () => trashOperation(async () => {
      const records = (load().trash || []).filter(t => t && t.deletedAt && Date.now() - t.deletedAt >= TRASH_HOLD_MS);
      const selected = new Set(records.map(trashKey));
      for (const record of records) {
        try { await destroyTrashRecord(record, selected); console.log('trash expired:', record.id); }
        catch (e) { console.error('trash cleanup retained:', record.id, e.message); }
      }
    });
    if (ctx.store) await ctx.store.withActor({ username: 'system:expiry' }, run);
    else await run();
  } catch (e) { console.error('trash purge:', e.message); }
}
  return { lifecycleError, deployCancelledError, trackDeployChild, killProcessTree, killDeployChildren, cancelDeploy, checkCancelled, siteLifecycle, trashOperation, destroyTrashRecord, purgeTrash };
};
