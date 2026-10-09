const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { parseComposeServices } = require('./services');
const exec = promisify(execFile);
const validId = id => id !== 'minipass' && /^[a-z0-9][a-z0-9-]{0,31}$/.test(id || '');
const validImage = id => /^sha256:[a-f0-9]{64}$/.test(id || '');
const lines = text => String(text || '').trim().split(/\s+/).filter(Boolean);

// Full `docker image inspect` JSON, parsed defensively: field names differ
// across Docker versions and image stores (e.g. Docker 29's containerd store
// has no `.Parent`), while Go `--format` templates fail hard on a missing key.
async function inspectImage(cli, image) {
  const parsed = JSON.parse(await cli.docker(['image', 'inspect', image]));
  const info = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!info || typeof info !== 'object') throw new Error('Docker returned invalid image data');
  const labels = (info.Config && info.Config.Labels) || {};
  return {
    id: info.Id || null,
    parent: typeof info.Parent === 'string' ? info.Parent : null,
    tags: Array.isArray(info.RepoTags) ? info.RepoTags.filter(t => typeof t === 'string') : [],
    project: typeof labels['com.docker.compose.project'] === 'string' ? labels['com.docker.compose.project'] : null,
    service: typeof labels['com.docker.compose.service'] === 'string' ? labels['com.docker.compose.service'] : null
  };
}

function builtServices(dir, record) {
  let names = (record.services || []).map(s => s.name);
  try {
    names.push(...parseComposeServices(fs.readFileSync(path.join(dir, 'docker-compose.yml'), 'utf8'))
      .filter(b => b.lines.some(l => /^    build:/.test(l))).map(b => b.name));
  } catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (!names.length) names.push('app');
  return [...new Set(names.filter(n => /^[a-z0-9][a-z0-9_-]{0,31}$/.test(n) && !/^db(?:-|$)/.test(n)))];
}

function ownedTags(project, services) {
  return new Set(services.flatMap(s => [`${project}-${s}:latest`, `${project}_${s}:latest`]));
}

function trashPath(root, record) {
  if (!validId(record.id)) throw new Error('invalid trash site id');
  const name = record.trashDir || record.id;
  if (!/^[a-z0-9][a-z0-9-]{0,119}$/.test(name)) throw new Error('invalid trash directory');
  if (name !== record.id && !name.startsWith(record.id + '-')) throw new Error('trash directory does not match this site');
  const dir = path.resolve(root, name);
  if (path.dirname(dir) !== path.resolve(root)) throw new Error('trash directory must stay inside Trash');
  try { if (!fs.lstatSync(dir).isDirectory()) throw new Error('trash directory is not a regular directory'); }
  catch (e) { if (e.code !== 'ENOENT') throw e; }
  return dir;
}

function runners({ docker = process.env.DOCKER_BIN || 'docker', compose = ['docker', 'compose'], run } = {}) {
  const execute = run || (async (bin, args, cwd) => (await exec(bin, args, { cwd, timeout: 180000, maxBuffer: 10 * 1024 * 1024 })).stdout);
  return {
    docker: async args => String(await execute(docker, args)),
    compose: async (args, cwd) => String(await execute(compose[0], [...compose.slice(1), ...args], cwd))
  };
}

async function collectImages({ id, dir, record, ...options }) {
  if (!validId(id)) throw new Error('invalid site id');
  const cli = runners(options);
  const names = builtServices(dir, record);
  const expected = ownedTags(id, names);
  const ids = new Set(lines(await cli.docker(['image', 'ls', '--all', '--no-trunc', '--quiet', '--filter', 'label=com.docker.compose.project=' + id])));
  for (const ref of expected) {
    for (const image of lines(await cli.docker(['image', 'ls', '--no-trunc', '--quiet', '--filter', 'reference=' + ref]))) ids.add(image);
  }
  let saved = [];
  try { saved = JSON.parse(fs.readFileSync(path.join(dir, '.images.json'), 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (!Array.isArray(saved)) throw new Error('invalid site image inventory');
  if (Array.isArray(record.trashImages)) saved.push(...record.trashImages);
  const prior = new Set(saved.filter(x => x.project === id && validImage(x.id)).map(x => x.id));
  if (prior.size) {
    const available = new Set(lines(await cli.docker(['image', 'ls', '--all', '--no-trunc', '--quiet'])));
    for (const image of prior) if (available.has(image)) ids.add(image);
  }
  if ([...ids].some(x => !validImage(x))) throw new Error('Docker returned an invalid image id');
  const result = [];
  for (const image of ids) {
    const info = await inspectImage(cli, image);
    const tags = (info.tags || []).filter(t => typeof t === 'string');
    const labeled = info.project === id;
    const known = prior.has(image);
    if (info.project && !labeled) continue; // Generated tag collisions do not confer ownership.
    if (!labeled && !known && !tags.some(t => expected.has(t))) continue;
    const services = labeled && /^[a-z0-9][a-z0-9_-]{0,31}$/.test(info.service || '') ? [...names, info.service] : names;
    const own = ownedTags(id, services);
    result.push({ id: image, parent: validImage(info.parent) ? info.parent : null, project: id, owned: labeled || known, tags: tags.filter(t => own.has(t)) });
  }
  return result;
}

async function rememberImages(options) {
  const images = await collectImages(options);
  fs.writeFileSync(path.join(options.dir, '.images.json'), JSON.stringify(images), { mode: 0o600 });
  return images;
}

async function stopSiteTools({ id, ...options }) {
  if (!validId(id)) throw new Error('invalid site id');
  const cli = runners(options);
  const names = new Set(['postgres', 'mysql', 'mariadb', 'mongo', 'redis'].map(t => `minipass-${id}-dbui-${t}`));
  const output = await cli.docker(['ps', '-a', '--format', '{{.ID}} {{.Names}}']);
  const ids = String(output).trim().split('\n').map(l => l.trim().split(/\s+/)).filter(p => names.has(p[1])).map(p => p[0]);
  if (ids.some(cid => !/^[a-f0-9]{12,64}$/.test(cid))) throw new Error('invalid container id');
  if (ids.length) await cli.docker(['container', 'rm', '--force', ...ids]);
}

async function destroySite({ record, trashRoot, images, protectedImages = [], ...options }) {
  const dir = trashPath(trashRoot, record);
  const cli = runners(options);
  const protect = new Set(protectedImages);
  // Capture before down; reuse this inventory if a later step needs a retry.
  const inventory = images || await collectImages({ id: record.id, dir, record, ...options });
  const step = async (label, action) => {
    try { return await action(); }
    catch { throw new Error(`${label} failed; Trash entry kept. Check Docker availability, resource use or filesystem permissions, then retry.`); }
  };
  await step('Database admin container removal', () => stopSiteTools({ id: record.id, ...options }));
  if (fs.existsSync(path.join(dir, 'docker-compose.yml'))) {
    await step('Site containers and volumes removal', () => cli.compose(['-p', record.id, 'down', '--volumes', '--remove-orphans'], dir));
  }
  await step('Remaining site resources removal', async () => {
    const filter = 'label=com.docker.compose.project=' + record.id;
    const containers = lines(await cli.docker(['ps', '-a', '--quiet', '--no-trunc', '--filter', filter]));
    if (containers.some(id => !/^[a-f0-9]{12,64}$/.test(id))) throw new Error('invalid container id');
    if (containers.length) await cli.docker(['container', 'rm', '--force', ...containers]);
    for (const kind of ['volume', 'network']) {
      const resources = lines(await cli.docker([kind, 'ls', '--quiet', '--filter', filter]));
      if (resources.some(name => !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(name))) throw new Error('invalid resource name');
      for (const name of resources) await cli.docker([kind, 'rm', name]);
    }
  });
  let removedImages = 0, sharedImages = 0;
  await step('Site built images removal', async () => {
    // Classic-builder history can have dependent children. Remove descendants
    // first rather than force-removing a parent that another image still needs.
    const byId = new Map(inventory.map(i => [i.id, i]));
    const depth = (image, seen = new Set()) => {
      if (!image || seen.has(image.id)) return 0;
      seen.add(image.id);
      return 1 + depth(byId.get(image.parent), seen);
    };
    for (const image of [...inventory].sort((a, b) => depth(b) - depth(a))) {
      if (!validImage(image.id) || image.project !== record.id) throw new Error('invalid inventory');
      // Recheck existence after earlier removals and any external Docker work.
      const available = new Set(lines(await cli.docker(['image', 'ls', '--all', '--no-trunc', '--quiet'])));
      if (!available.has(image.id)) continue;
      const current = await inspectImage(cli, image.id);
      const tags = current.tags || [];
      const mine = new Set(image.tags || []);
      const foreign = tags.filter(t => !mine.has(t));
      // An explicit external alias/base image is shared; never delete its ID.
      for (const tag of tags.filter(t => mine.has(t) && !protect.has(t))) await cli.docker(['image', 'rm', '--no-prune', tag]);
      if (foreign.length || tags.some(t => protect.has(t))) { sharedImages++; continue; }
      const stillAvailable = new Set(lines(await cli.docker(['image', 'ls', '--all', '--no-trunc', '--quiet'])));
      if (stillAvailable.has(image.id)) await cli.docker(['image', 'rm', '--no-prune', image.id]);
      removedImages++;
    }
  });
  // Operator-approved global UNUSED cache cleanup: no image/volume/system prune.
  await step('Unused build cache cleanup', () => cli.docker(['builder', 'prune', '--all', '--force']));
  await step('Site files removal', async () => fs.rmSync(dir, { recursive: true, force: true }));
  return { removedImages, sharedImages, buildCachePruned: true };
}

module.exports = { validId, trashPath, builtServices, ownedTags, collectImages, rememberImages, stopSiteTools, destroySite };
