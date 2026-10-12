const assert = require('assert');
const { steadyPoll } = require('./health');

// Empty or non-running snapshots never count as steady.
assert.deepEqual(steadyPoll(new Map(), new Map()), { steady: false });
assert.deepEqual(
  steadyPoll(new Map(), new Map([['a', { running: false, startedAt: 't1' }]])),
  { steady: false });

// First sighting is not steadiness - the streak needs two matching polls.
const first = new Map([['a', { running: true, startedAt: 't1' }]]);
assert.deepEqual(steadyPoll(new Map(), first), { steady: false });
// Same instance still running on the next poll is steady.
assert.deepEqual(steadyPoll(first, new Map([['a', { running: true, startedAt: 't1' }]])), { steady: true });
// A restart between polls (new StartedAt) resets the streak - crash loops
// can never pass by being caught mid-iteration twice.
assert.deepEqual(steadyPoll(first, new Map([['a', { running: true, startedAt: 't2' }]])), { steady: false });
// A replaced container (new id) is not the same release.
assert.deepEqual(steadyPoll(first, new Map([['b', { running: true, startedAt: 't1' }]])), { steady: false });
// Missing StartedAt (failed inspect) never counts - fail closed, not open.
assert.deepEqual(steadyPoll(first, new Map([['a', { running: true, startedAt: '' }]])), { steady: false });

console.log('deploy health gate steadiness: OK');
