const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
function imageName(templates) {
  const hash = crypto.createHash('sha256');
  for (const name of ['Dockerfile', 'server.js']) hash.update(fs.readFileSync(path.join(templates, 'publisher', name)));
  return 'minipass/publisher:' + hash.digest('hex').slice(0, 12);
}
let building = null;
async function ensure({ docker, templates, run, logged }) {
  const image = imageName(templates);
  try { await run(docker, ['image', 'inspect', image]); return image; } catch {}
  if (!building) building = logged(docker, ['build', '-t', image, path.join(templates, 'publisher')]).then(() => image).finally(() => { building = null; });
  return building;
}
function add(model, image, id, tls = null) {
  const routes = [];
  const network = 'mp-public-' + crypto.createHash('sha256').update(id).digest('hex').slice(0, 8);
  model.config.networks = model.config.networks || {};
  model.config.networks[network] = { name: `${id}_${network}` };
  for (const [name, s] of Object.entries(model.config.services)) {
    if (model.categories[name] !== 'application') continue;
    const keep = [];
    for (let index = 0; index < (s.ports || []).length; index++) {
      const p = s.ports[index];
      if ((p.protocol || 'tcp') !== 'tcp' || p.app_protocol === 'https') { keep.push(p); continue; }
      const route = 'mp-route-' + crypto.createHash('sha256').update(name + ':' + index).digest('hex').slice(0, 12);
      if (model.config.services[route]) throw new Error('Repository uses a reserved publication service name');
      const declaredNetworks = s.networks || { default: null };
      model.config.services[route] = { image, pull_policy: 'never', restart: 'unless-stopped', read_only: true,
        cap_drop: ['ALL'], security_opt: ['no-new-privileges'], mem_limit: '128m', cpus: 0.25,
        environment: { UPSTREAM: `http://${name}:${p.target}`, RELEASE_ID: model.release, ...(tls?{TLS_CERT:tls.cert,TLS_KEY:tls.key}:{}) },
        ports: [{ ...p, target: 8080 }], depends_on: { [name]: { condition: 'service_started' } },
        networks: { ...declaredNetworks, [network]: null }, 'x-minipass': { role: 'routing' } };
      model.categories[route] = 'routing';
      routes.push({ service: name, target: Number(p.target), published: Number(p.published), route, release: model.release });
      if(tls){model.config.services[route].ports[0].app_protocol='https';const service=model.services.find(s=>s.name===name);if(service)service.scheme='https';}
    }
    s.ports = keep;
  }
  model.config['x-minipass'].routes = routes;
  fs.writeFileSync(model.file, require('yaml').stringify(model.config), { mode: 0o600 });
  return routes;
}
module.exports = { ensure, add, imageName };
