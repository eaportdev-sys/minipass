// Requests wait internally; the user is not required to retry one site at a time.
function deletionQueue() {
  let tail = Promise.resolve(), pending = 0, draining = false, finishBatch = async () => {};
  return {
    get pending() { return pending + (draining ? 1 : 0); },
    onDrain(action) { finishBatch = action; },
    run(action) {
      pending++;
      const work = tail.catch(() => {}).then(async () => {
        try { return await action(); }
        finally {
          pending--;
          if (!pending) {
            draining = true;
            try { await finishBatch(); } catch (e) { console.error('Shared deletion cleanup:', e.message); }
            finally { draining = false; }
          }
        }
      });
      tail = work.catch(() => {});
      return work;
    }
  };
}
module.exports = { deletionQueue };
