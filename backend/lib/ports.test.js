const assert = require('assert');
const { parsePublishedPorts, nextFreePort, planRebind } = require('./ports');

const bound = parsePublishedPorts(
  'aaa111 0.0.0.0:8003->80/tcp, :::8003->80/tcp\n' +
  'bbb222 0.0.0.0:8004->80/tcp\n' +
  'ccc333 80/tcp\n' +
  'ddd444 \n'
);
assert.deepEqual([...bound.keys()].sort((a, b) => a - b), [8003, 8004]);
assert(bound.get(8003).has('aaa111'));
assert(!bound.has(80), 'exposed-only ports are not bindings');

assert.equal(nextFreePort(8003, new Set([8003, 8004])), 8005);
assert.equal(nextFreePort(8002, new Set([8003])), 8002);
assert.equal(nextFreePort(9000, new Set([9000])), null, 'exhausted range returns null');

// our own container holding our port: no move
assert.deepEqual(
  planRebind([{ name: 'app', hostPort: 8003 }], { bound, own: ['aaa111'], registryOthers: new Set() }),
  []
);
// foreign container squatting: move past every taken port
assert.deepEqual(
  planRebind([{ name: 'app', hostPort: 8003 }], { bound, own: ['zzz999'], registryOthers: new Set() }),
  [{ name: 'app', from: 8003, to: 8005 }]
);
// registry claim by another site counts even when nothing runs there yet
assert.deepEqual(
  planRebind([{ name: 'app', hostPort: 8010 }], { bound: new Map(), own: [], registryOthers: new Set([8010, 8011]) }),
  [{ name: 'app', from: 8010, to: 8012 }]
);
// two services in one site chain past each other
assert.deepEqual(
  planRebind(
    [{ name: 'app', hostPort: 8003 }, { name: 'client', hostPort: 8004 }],
    { bound, own: [], registryOthers: new Set() }
  ),
  [{ name: 'app', from: 8003, to: 8005 }, { name: 'client', from: 8004, to: 8006 }]
);
console.log('deploy-time host port rebind: OK');
