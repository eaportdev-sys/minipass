const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
process.env.DATA_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'minipass-panel-log-')), 'data.json');
const log = require('./panel-log');
assert(log.redact('see x-access-token:abc123@github.com/x').includes('x-access-token:***@'));
assert(!log.redact('see x-access-token:abc123@github.com/x').includes('abc123'));
assert(log.redact('DB_PASSWORD=hunter2 ok').includes('***') && !log.redact('DB_PASSWORD=hunter2 ok').includes('hunter2'));
assert(log.redact('plain message').includes('plain message'));
log.logEvent({ level: 'warn', area: 'create', site: 'demo', message: 'quota not enforced' });
log.logEvent({ area: 'trash', site: 'demo', message: 'cleanup failed' });
fs.appendFileSync(log.logPath(), 'not-json\n');
let events = log.readEvents(10);
assert.equal(events.length, 2, 'corrupt lines are skipped, newest first');
assert.equal(events[0].area, 'trash');
assert.equal(events[1].level, 'warn');
assert.deepEqual(log.readEvents(1).length, 1);
assert.deepEqual(log.readEvents(99999).length, 2, 'limit is clamped');
const failure = { at: '2026-10-09T09:02:39.000Z', status: 'error', source: 'local',
  error: "build failed - running containers untouched: npm error Cannot read properties of null (reading 'edgesOut') DB_PASSWORD=hunter2" };
const app = { id: 'testsite', lastDeploy: failure, deployHistory: [failure,
  { at: '2026-10-09T08:00:00.000Z', status: 'error', source: 'webhook', error: 'older failure' },
  { at: '2026-10-09T07:00:00.000Z', status: 'ok' }] };
let failures = log.readErrors([app], 100).filter(e => e.site === 'testsite');
assert.equal(failures.length, 2, 'retained failures are visible before the new logging hook; successes excluded');
assert.equal(failures[0].area, 'deploy-local');
assert(failures[0].message.includes('edgesOut') && !failures[0].message.includes('hunter2'));
log.logEvent(log.deploymentEvent(app.id, failure));
failures = log.readErrors([app], 100).filter(e => e.site === 'testsite');
assert.equal(failures.length, 2, 'persisted and metadata copies of the same attempt are deduplicated');
assert.equal(log.readErrors([app], 1).length, 1);
assert.equal(log.readErrors([], 100).filter(e => e.site === 'testsite').length, 1, 'saved failures survive removal of site metadata');
for (let i = 0; i < 3000; i++) log.logEvent({ area: 'fill', message: 'x'.repeat(200) });
events = log.readEvents(500);
assert(events.length <= 500 && events.length > 0, 'log rotates under the cap');
assert(fs.statSync(log.logPath()).size <= 512 * 1024 + 4096);
console.log('Panel error log: redaction, deployment history fallback, deduplication, newest-first reads and rotation: OK');
