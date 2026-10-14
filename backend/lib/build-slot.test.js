const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const createHelpers = require('./deployment-state');

function fakeCtx() {
  return {
    deployOps: new Map(), deployQueues: new Map(), deployEpochs: new Map(), lifecycleLocks: new Set(),
    fs, path,
    panelLog: { logEvent() {} },
    deployCancelledError: () => new Error('cancelled'),
  };
}
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'minipass-build-slot-'));
(async () => {
  const { withBuildSlot } = createHelpers(fakeCtx());
  const order = [];
  const gate = {};
  const a = withBuildSlot('a', dir, async () => { order.push('a-start'); await new Promise(r => { gate.a = r; }); order.push('a-end'); });
  const b = withBuildSlot('b', dir, async () => { order.push('b'); });
  const c = withBuildSlot('c', dir, async () => { order.push('c'); });
  await new Promise(r => setTimeout(r, 20));
  assert.deepEqual(order, ['a-start'], 'second and third deploys queue behind the first: ' + order);
  gate.a();
  await Promise.all([a, b, c]);
  assert.deepEqual(order, ['a-start', 'a-end', 'b', 'c'], 'FIFO release order: ' + order);

  // A throwing build still releases the slot.
  const { withBuildSlot: w2 } = createHelpers(fakeCtx());
  const seq = [];
  const f1 = w2('x', dir, async () => { seq.push('x'); throw new Error('boom'); }).catch(e => seq.push('err:' + e.message));
  const f2 = w2('y', dir, async () => { seq.push('y'); });
  await Promise.all([f1, f2]);
  assert.deepEqual(seq, ['x', 'y', 'err:boom'], 'slot released immediately on failure: ' + seq);

  // A cancelled deploy never takes the slot.
  const cancelled = fakeCtx();
  cancelled.deployOps.set('z', { cancelled: true });
  const { withBuildSlot: w3 } = createHelpers(cancelled);
  let ran = false;
  await assert.rejects(() => w3('z', dir, async () => { ran = true; }), /cancelled/);
  assert(!ran, 'cancelled deploy does not run');

  // Parallelism is opt-in for bigger hosts.
  process.env.MINIPASS_MAX_BUILDS = '2';
  try {
    const { withBuildSlot: w4 } = createHelpers(fakeCtx());
    let inside = 0, peak = 0;
    const job = () => w4('p', dir, async () => { inside++; peak = Math.max(peak, inside); await new Promise(r => setTimeout(r, 20)); inside--; });
    await Promise.all([job(), job(), job()]);
    assert.equal(peak, 2, 'two builds run together when allowed, peak=' + peak);
  } finally { delete process.env.MINIPASS_MAX_BUILDS; }
  console.log('Global build slot: FIFO, failure release, cancel guard, opt-in parallelism: OK');
  fs.rmSync(dir, { recursive: true, force: true });
})().catch(e => { console.error(e); process.exitCode = 1; });
