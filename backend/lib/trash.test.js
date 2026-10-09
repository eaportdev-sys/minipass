const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const trash = require('./trash');
const imageId = n => 'sha256:' + n.toString(16).padStart(64, '0');

function fakeDocker() {
  const images = new Map([
    [imageId(1), { tags: ['demo-app:latest'], project: 'demo', service: 'app' }],
    [imageId(2), { tags: [], parent: imageId(1), project: 'demo', service: 'app' }],
    [imageId(3), { tags: ['demo-web:latest', 'shared-copy:latest'], project: 'demo', service: 'web' }],
    [imageId(4), { tags: ['postgres:16-alpine'], project: null }],
    [imageId(5), { tags: ['minipass-panel:latest'], project: 'minipass', service: 'panel' }],
    [imageId(6), { tags: ['other-app:latest'], project: 'other', service: 'app' }],
    [imageId(7), { tags: ['demo_worker:latest'], project: null }],
    [imageId(8), { tags: ['dpage/pgadmin4:9.18.0'], project: null }]
  ]);
  let containers = [{ id: 'a'.repeat(12), name: 'demo-app-1', project: 'demo', image: imageId(1) },
    { id: 'b'.repeat(12), name: 'other-app-1', project: 'other', image: imageId(6) },
    { id: 'c'.repeat(12), name: 'minipass-demo-dbui-postgres', image: imageId(8) }];
  let volumes = ['demo_dbdata'], networks = ['demo_default'];
  const calls = [];
  const fake = { images, calls, fail: '', run: async (bin, args, cwd) => {
    calls.push({ bin, args, cwd });
    if (args.includes('down')) {
      assert.equal(args[args.indexOf('-p') + 1], 'demo', 'moved folder never changes Compose project identity');
      if (fake.fail === 'down') throw new Error('down failed');
      containers = containers.filter(c => c.project !== 'demo'); volumes = []; networks = [];
      return '';
    }
    if (args[0] === 'ps') {
      const filter = args[args.indexOf('--filter') + 1];
      return args.includes('--format') ? containers.map(c => `${c.id} ${c.name}`).join('\n') : containers.filter(c => c.project === filter.split('=').at(-1)).map(c => c.id).join('\n');
    }
    if (args[0] === 'container') { containers = containers.filter(c => !args.includes(c.id)); return ''; }
    if (args[0] === 'volume' || args[0] === 'network') {
      if (args[1] === 'ls') return (args[0] === 'volume' ? volumes : networks).join('\n');
      return '';
    }
    if (args[0] === 'builder') { if (fake.fail === 'cache') throw new Error('prune failed'); return 'cache cleared'; }
    assert.equal(args[0], 'image');
    if (args[1] === 'ls') {
      const filter = args.includes('--filter') ? args[args.indexOf('--filter') + 1] : '';
      return [...images].filter(([id, info]) => !filter || (filter.startsWith('reference=') ? info.tags.includes(filter.slice(10)) : info.project === filter.split('=').at(-1))).map(([id]) => id).join('\n');
    }
    if (args[1] === 'inspect') {
      const id = args.at(-1), info = images.get(id);
      assert(info, 'inspect only existing image');
      assert(!args.includes('--format'), 'image data is parsed from full JSON, never Go templates');
      // Docker 29 containerd-store shape: Parent/Config may be absent entirely.
      const payload = { Id: id, RepoTags: info.tags };
      if (info.parent) payload.Parent = info.parent;
      if (info.project || info.service) payload.Config = { Labels: { ...(info.project ? { 'com.docker.compose.project': info.project } : {}), ...(info.service ? { 'com.docker.compose.service': info.service } : {}) } };
      return JSON.stringify([payload]);
    }
    assert.equal(args[1], 'rm');
    assert(!args.includes('--force') && !args.includes('-f'), 'never force image removal');
    assert(args.includes('--no-prune'), 'unowned untagged parents are not implicitly deleted');
    const ref = args.at(-1);
    const entry = [...images].find(([id, info]) => id === ref || info.tags.includes(ref));
    assert(entry, 'remove only existing image references');
    const [id, info] = entry;
    if (fake.fail === 'image' || containers.some(c => c.image === id)) throw new Error('image in use');
    if ([...images.values()].some(i => i.parent === id)) throw new Error('image has dependent children');
    if (ref === id) images.delete(id);
    else { info.tags = info.tags.filter(t => t !== ref); if (!info.tags.length) images.delete(id); }
    return '';
  } };
  return fake;
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minipass-trash-test-'));
  const record = { id: 'demo', trashDir: 'demo-123', services: [{ name: 'app' }, { name: 'web' }, { name: 'worker' }] };
  const setup = () => {
    const dir = path.join(root, record.trashDir);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'docker-compose.yml'), 'services:\n  app:\n    build: ./code\n  web:\n    build: ./code/web\n  db:\n    image: postgres:16-alpine\n');
    fs.writeFileSync(path.join(dir, 'private-data'), 'private site content');
    return dir;
  };
  try {
    let dir = setup(), fake = fakeDocker();
    const options = { id: record.id, dir, record, run: fake.run, compose: ['docker', 'compose'] };
    const inventory = await trash.rememberImages(options);
    assert.deepEqual(inventory.map(i => i.id).sort(), [1, 2, 3, 7].map(imageId).sort());
    assert(!inventory.some(i => i.id === imageId(4) || i.id === imageId(5) || i.id === imageId(8)));
    // Remember an unlabeled historical image after its tag moves to a new build.
    fake.images.get(imageId(7)).tags = [];
    fake.images.set(imageId(9), { tags: ['demo_worker:latest'], project: null });
    const next = await trash.rememberImages(options);
    assert(next.some(i => i.id === imageId(7)) && next.some(i => i.id === imageId(9)));
    const result = await trash.destroySite({ record, trashRoot: root, images: next, run: fake.run });
    assert(!fs.existsSync(dir));
    for (const n of [1, 2, 7, 9]) assert(!fake.images.has(imageId(n)), 'site-only image removed');
    for (const n of [3, 4, 5, 6, 8]) assert(fake.images.has(imageId(n)), 'shared, unrelated, panel and database/admin images retained');
    assert.deepEqual(fake.images.get(imageId(3)).tags, ['shared-copy:latest']);
    assert(result.buildCachePruned && result.sharedImages === 1);
    const prune = fake.calls.find(c => c.args[0] === 'builder');
    assert.deepEqual(prune.args, ['builder', 'prune', '--all', '--force']);
    assert(!fake.calls.some(c => ['system', 'volume'].includes(c.args[0]) && c.args.includes('prune')));
    for (const failure of ['down', 'image', 'cache']) {
      dir = setup(); fake = fakeDocker(); fake.fail = failure;
      await assert.rejects(() => trash.destroySite({ record, trashRoot: root, run: fake.run }), /failed; Trash entry kept/);
      assert(fs.existsSync(path.join(dir, 'private-data')), 'failures keep source files for retry');
      fake.fail = '';
      await trash.destroySite({ record, trashRoot: root, run: fake.run });
      assert(!fs.existsSync(dir), 'partial cleanup retry is idempotent');
    }
    assert.throws(() => trash.trashPath(root, { id: 'demo', trashDir: '../other' }), /invalid trash directory/);
    assert.throws(() => trash.trashPath(root, { id: 'demo', trashDir: 'other-site' }), /does not match/);
    assert.throws(() => trash.trashPath(root, { id: 'minipass' }), /invalid trash site/);
    dir = setup(); fake = fakeDocker();
    fake.images.get(imageId(1)).project = 'other';
    const collision = await trash.collectImages({ id: 'demo', dir, record, run: fake.run });
    assert(!collision.some(i => i.id === imageId(1)), 'foreign Compose project labels win over a generated-tag collision');
    fs.writeFileSync(path.join(dir, '.images.json'), 'not JSON');
    await assert.rejects(() => trash.collectImages({ id: 'demo', dir, record, run: fake.run }));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
  console.log('Trash cleanup: exact project identity, owned/history images, shared preservation, cache approval, failure retention and retry: OK');
}
module.exports = { fakeDocker };
if (require.main === module) main().catch(e => { console.error(e); process.exitCode = 1; });
