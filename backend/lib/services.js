// Multi-service sites: one folder, N runnable services (api + web + ...), each
// independently enable/disable/remove-able. DB blocks + volumes are never touched.
const fs = require('fs');
const path = require('path');
const { serviceBlock, ensureDockerfile, nginxConf, inferPort, TYPE_PORT } = require('./generator');

const isDbSvc = n => /^db(-|$)/.test(n || '');

function validSvcName(n) {
  return typeof n === 'string' && /^[a-z0-9][a-z0-9-]{0,30}$/.test(n);
}

function portEnvName(svcName) {
  return 'PORT_' + svcName.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

// Split generated compose services into [{name, lines}] (db + app alike).
function parseComposeServices(text) {
  const blocks = [];
  const lines = String(text).split('\n');
  let inServices = false;
  let cur = null;
  const flush = () => { if (cur) { blocks.push(cur); cur = null; } };
  for (const line of lines) {
    if (/^volumes:\s*$/.test(line)) { flush(); inServices = false; continue; }
    if (/^[A-Za-z].*:\s*$/.test(line) && !/^  /.test(line)) {
      // some other top-level key (networks:, x-*, ...) - stop service parsing
      if (!/^services:\s*$/.test(line)) { flush(); inServices = false; continue; }
      inServices = true;
      continue;
    }
    if (!inServices) continue;
    const m = line.match(/^  ([A-Za-z0-9_-]+):\s*$/);
    if (m) { flush(); cur = { name: m[1], lines: [] }; }
    else if (cur && (/^    /.test(line) || line.trim() === '')) cur.lines.push(line);
    else if (cur) flush();
  }
  flush();
  return blocks.filter(b => b.lines.some(l => l.trim() !== ''));
}

function parseServiceBlock(b) {
  const text = b.lines.join('\n');
  let ctx = './code';
  const m = text.match(/context: \.\/code(?:\/([^\s]+))?/);
  if (m) ctx = './code' + (m[1] ? '/' + m[1] : '');
  let port = null;
  let host = null;
  const pm = text.match(/- "(\d+):(\d+)"/);
  if (pm) { host = parseInt(pm[1], 10); port = parseInt(pm[2], 10); }
  else {
    const em = text.match(/- "(\d+)"/);
    if (em) port = parseInt(em[1], 10);
  }
  return { ctx, port, host };
}

// Normalize meta to a services list, migrating legacy single-service layouts once.
function fullServices(meta, dir) {
  if (meta.services && meta.services.length) return meta.services;
  const entry = {
    name: 'app', subdir: meta.subdir || '', type: meta.type,
    port: null, hostPort: meta.hostPort || null, enabled: true
  };
  try {
    const text = fs.readFileSync(path.join(dir, 'docker-compose.yml'), 'utf8');
    const appBlock = parseComposeServices(text).find(b => !isDbSvc(b.name));
    if (appBlock) {
      if (appBlock.name !== 'app') entry.name = appBlock.name;
      const p = parseServiceBlock(appBlock);
      entry.subdir = p.ctx === './code' ? '' : p.ctx.replace(/^\.\/code\/?/, '');
      if (p.port) entry.port = p.port;
      if (p.host) entry.hostPort = p.host;
    }
  } catch {}
  if (!entry.port) {
    try {
      entry.port = inferPort(path.join(dir, 'code', entry.subdir), TYPE_PORT[meta.type] || 3000);
    } catch { entry.port = TYPE_PORT[meta.type] || 3000; }
  }
  return [entry];
}

// Rewrite compose: fresh ENABLED app services, verbatim db blocks + volumes.
// Throws when nothing would run (refuses to strand an empty project).
function renderProject({ dir, templatesDir, meta }) {
  const all = fullServices(meta, dir);
  const enabled = all.filter(s => s.enabled !== false);
  if (!enabled.length) throw new Error('cannot disable the last running service - delete the app instead');
  const ymlPath = path.join(dir, 'docker-compose.yml');
  const text = fs.readFileSync(ymlPath, 'utf8');
  const keptDb = parseComposeServices(text)
    .filter(b => isDbSvc(b.name))
    .map(b => `  ${b.name}:\n` + b.lines.join('\n').replace(/\s+$/, ''))
    .join('\n');
  const volIdx = text.search(/^volumes:\s*$/m);
  const volumes = volIdx >= 0 ? text.slice(volIdx).replace(/\s*$/, '') : '';
  const envPath = path.join(dir, '.env');
  let envLines = [];
  try { envLines = fs.readFileSync(envPath, 'utf8').split('\n'); } catch {}
  const setEnv = (k, v) => {
    const i = envLines.findIndex(l => new RegExp(`^\\s*${k}\\s*=`).test(l));
    if (i >= 0) envLines[i] = `${k}=${v}`;
    else envLines.push(`${k}=${v}`);
  };
  const managedPath = path.join(dir, '.env.managed');
  let managed = new Set();
  try { managed = new Set(fs.readFileSync(managedPath, 'utf8').split('\n').map(s => s.trim()).filter(Boolean)); } catch {}
  const chunks = [];
  for (const s of enabled) {
    const ctxDir = path.join(dir, 'code', s.subdir || '');
    ensureDockerfile(ctxDir, s.type, templatesDir);
    if (s.type === 'static' || s.type === 'react') {
      try {
        if (!fs.existsSync(path.join(ctxDir, 'nginx.conf'))) fs.writeFileSync(path.join(ctxDir, 'nginx.conf'), nginxConf(null));
      } catch {}
    }
    const isPrimary = s.name === 'app';
    const penv = isPrimary ? null : portEnvName(s.name);
    if (penv) {
      const p = parseInt(s.port, 10) || 3000;
      setEnv(penv, String(p));
      managed.add(penv);
    }
    chunks.push(serviceBlock({
      svcName: s.name,
      ctx: s.subdir ? `./code/${s.subdir}` : './code',
      port: parseInt(s.port, 10) || 3000,
      host: s.hostPort || null,
      portEnv: penv
    }));
  }
  let out = `services:\n${chunks.join('')}`;
  if (keptDb) out += `${keptDb}\n`;
  if (volumes) out += `\n${volumes}\n`;
  else out += '\n'; // legacy files end with a blank line - keep round-trips byte-identical
  fs.writeFileSync(ymlPath, out);
  try { fs.writeFileSync(envPath, envLines.join('\n').replace(/\s*$/, '') + '\n'); } catch {}
  try { fs.writeFileSync(managedPath, [...managed].join('\n') + '\n'); } catch {}
  return { services: enabled.length, normalized: all };
}

module.exports = { isDbSvc, validSvcName, portEnvName, parseComposeServices, fullServices, renderProject };
