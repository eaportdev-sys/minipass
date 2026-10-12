const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const markers = require('./deploy-markers');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'minipass-markers-'));
try {
  // mark/unmark round-trip
  markers.mark(dir, 'site-abc123');
  assert(fs.existsSync(path.join(dir, '.deploy-site-abc123')), 'marker file created');
  markers.unmark(dir, 'site-abc123');
  assert(!fs.existsSync(path.join(dir, '.deploy-site-abc123')), 'marker file removed');

  // site ids cannot escape the data dir
  const evil = markers.markerPath(dir, '../../etc-evil');
  assert(path.dirname(evil) === dir, 'traversal in site id stays inside the data dir: ' + evil);
  assert(!evil.includes('..'), 'no parent segments in marker path');

  // concurrent sites each hold their own marker
  markers.mark(dir, 'site-one');
  markers.mark(dir, 'site-two');
  assert.deepEqual(markers.active(dir).sort(), ['.deploy-site-one', '.deploy-site-two'], 'both deploys visible to the host');

  // one finishing does not clear the other
  markers.unmark(dir, 'site-one');
  assert.deepEqual(markers.active(dir), ['.deploy-site-two'], 'remaining deploy still blocks upgrades');

  // stale markers (killed panel, clock far ahead) do not block forever
  const past = Date.now() - markers.MARKER_TTL_MS - 1000;
  const stale = path.join(dir, '.deploy-site-old');
  fs.writeFileSync(stale, 'x');
  fs.utimesSync(stale, new Date(past), new Date(past));
  assert(!markers.active(dir).includes('.deploy-site-old'), 'stale marker ignored by the host check');

  // boot sweep removes everything orphaned, including the stale one
  assert.equal(markers.sweep(dir), 2, 'sweep removes all orphaned markers');
  assert.deepEqual(markers.active(dir), [], 'no markers after boot sweep');

  // missing dir never throws
  assert.deepEqual(markers.active(path.join(dir, 'nope')), [], 'missing dir reads as no deploys');
  assert.equal(markers.sweep(path.join(dir, 'nope')), 0, 'missing dir sweeps to zero');
  markers.mark(path.join(dir, 'nope'), 'site-x');
  markers.unmark(path.join(dir, 'nope'), 'site-x');

  console.log('deploy markers: host-visible upgrade guard: OK');
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
