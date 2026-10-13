const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { VERSION } = require('./browser-runner');
const routes = require('./routes');
let building = null;
function imageName(templates) {
  const hash = crypto.createHash('sha256').update(String(VERSION));
  for (const file of [path.join(__dirname, 'browser-runner.js'), path.join(templates, 'verifier', 'Dockerfile'), path.join(templates, 'verifier', 'package.json')]) hash.update(fs.readFileSync(file));
  return 'minipass/verifier:' + hash.digest('hex').slice(0, 12);
}
async function ensure({ docker, templates, dataDir, run, logged }) {
  const image = imageName(templates);
  try { await run(docker, ['image', 'inspect', image]); return image; } catch {}
  if (!building) building = (async () => {
    const temp = fs.mkdtempSync(path.join(dataDir, '.browser-build-'));
    try {
      for (const name of ['Dockerfile', 'package.json']) fs.copyFileSync(path.join(templates, 'verifier', name), path.join(temp, name));
      fs.copyFileSync(path.join(__dirname, 'browser-runner.js'), path.join(temp, 'runner.js'));
      await logged(docker, ['build', '-t', image, temp]);
    } finally { fs.rmSync(temp, { recursive: true, force: true }); }
    return image;
  })().finally(() => { building = null; });
  return building;
}
function validPublicUrl(value) {
  const u = new URL(value);
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.search || u.hash) throw new Error('Verification URL must be a plain HTTP/HTTPS website URL without credentials/query/fragment');
  return u.toString();
}
function targetsFor({ services, config, root, originHost, publicUrl, homePath = '' }) {
  const targets = [], probes = [];
  for (const s of services) {
    if (s.role && s.role !== 'application') continue;
    const definition = config && config.services[s.name];
    const httpPort = s.port || Number((definition && definition.expose || [])[0]) || Number(definition && definition.environment && definition.environment.PORT);
    const folder = path.join(root, s.subdir || '');
    const candidates = routes.detectOpenPaths(folder);
    const paths = candidates.length ? candidates.map(c => c.path) : routes.PROBE_PATHS;
    if (s.hostPort) {
      const primaryUrl = publicUrl && (s.primary || services.filter(s => !s.role || s.role === 'application').filter(s => s.hostPort)[0] === s) ? validPublicUrl(publicUrl) : null;
      const origin = primaryUrl ? new URL(primaryUrl).origin : `${s.scheme || 'http'}://${originHost}:${s.hostPort}`;
      const entry = s.homePath || (s.primary ? homePath : '') || '/';
      targets.push({ service: s.name, url: primaryUrl && !s.homePath && !(s.primary && homePath) ? primaryUrl : origin + (entry.startsWith('/') ? entry : '/' + entry),
        candidatePaths: s.frontend || ['static', 'react'].includes(s.type) ? ['/'] : [...new Set([...paths, '/'])], declaredPaths: candidates.map(c => c.path) });
    } else if (definition) {
      let declaredPort = httpPort;
      if (!declaredPort && definition.build) {
        try { declaredPort = require('./generator').inferPort(definition.build.context, 0, definition.build.dockerfile || 'Dockerfile'); } catch {}
      }
      if (!declaredPort) continue; // a worker has no HTTP contract to invent
      probes.push({ service: s.name, declaredPaths: candidates.map(c => c.path), urls: [...new Set([...paths, '/'])].slice(0, 16).map(p => `http://${s.name}:${declaredPort}${p}`) });
    }
  }
  return { targets, probes };
}
async function execute({ id, dir, image, docker, network, targets, probes, localCa = null, run, check = () => {} }) {
  const name = `minipass-verify-${id}-${crypto.randomBytes(6).toString('hex')}`;
  let report;
  try {
    check();
    const networks = [].concat(network);
    const args = ['create', '-i', '--name', name, '--label', `minipass.verification.site=${id}`, '--network', networks[0], '--add-host', 'host.docker.internal:host-gateway',
      '--cap-drop=ALL', '--security-opt=no-new-privileges', '--read-only', '--memory=768m', '--cpus=1', '--pids-limit=256',
      '--tmpfs', '/tmp:rw,nosuid,size=256m', '--tmpfs', '/home/node:rw,nosuid,uid=1000,gid=1000,size=64m', image];
    await run(docker, args);
    for (const other of networks.slice(1)) await run(docker, ['network', 'connect', other, name]);
    const output = await run(docker, ['start', '-a', '-i', name], { input: JSON.stringify({ targets, probes,localCa }) + '\n', timeout: 120000, acceptExitCodes: [0, 1] });
    report = JSON.parse(String(output));
    check();
  } catch (e) {
    check();
    report = { ok: false, errors: ['Browser verification could not run: ' + e.message], pages: [], probes: [] };
  } finally { try { await run(docker, ['rm', '-f', name], { cleanup: true }); } catch {} }
  report.at = new Date().toISOString();
  for (const [i, page] of (report.pages || []).entries()) {
    if (page.screenshot) {
      fs.writeFileSync(path.join(dir, `.verification-${i}.png`), Buffer.from(page.screenshot, 'base64'), { mode: 0o600 });
      delete page.screenshot;
      page.screenshotIndex = i;
    }
  }
  fs.writeFileSync(path.join(dir, '.verification.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
  return report;
}
module.exports = { ensure, execute, targetsFor, validPublicUrl, imageName };
