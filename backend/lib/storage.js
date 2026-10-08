// Aggregate filesystem/Docker metadata only. No file contents, logs, commands,
// environment values, mount paths, or usage history are collected or returned.
const fs = require('fs');
const { execFile } = require('child_process');
const { promisify } = require('util');
const exec = promisify(execFile);
const bytes = value => Number.isSafeInteger(value) && value >= 0 ? value : null;

function diskUsage(stat) {
  const totalBytes = bytes(stat.bsize * stat.blocks);
  const freeBytes = bytes(stat.bsize * stat.bavail);
  const usedBytes = bytes(stat.bsize * (stat.blocks - stat.bfree));
  if (!totalBytes || freeBytes === null || usedBytes === null || freeBytes + usedBytes > totalBytes) return null;
  const usedPercent = Math.ceil(100 * usedBytes / (usedBytes + freeBytes || 1));
  return { totalBytes, freeBytes, usedBytes, usedPercent, low: usedPercent >= 90 || freeBytes < 2 * 1024 ** 3 };
}

const FORMAT = '{"project":{{json (index .Config.Labels "com.docker.compose.project")}},"service":{{json (index .Config.Labels "com.docker.compose.service")}},"name":{{json .Name}},"state":{{json .State.Status}},"writableBytes":{{json .SizeRw}},"rootFsBytes":{{json .SizeRootFs}},"hasMounts":{{if .Mounts}}true{{else}}false{{end}}}';

function containerUsage(text, project) {
  return String(text || '').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)).filter(c => c.project === project).map(c => ({
    name: String(c.name || '').replace(/^\//, ''), service: String(c.service || ''), state: String(c.state || ''),
    writableBytes: bytes(c.writableBytes), rootFsBytes: bytes(c.rootFsBytes), hasMounts: c.hasMounts === true
  }));
}

async function measureStorage({ id, dir, run = (args) => exec('docker', args, { timeout: 25000, maxBuffer: 1024 * 1024 }), statfs = fs.promises.statfs }) {
  if (!/^[a-z0-9-]{1,32}$/.test(id)) throw new Error('invalid site id');
  const report = { measuredAt: new Date().toISOString(), disk: null, dockerAvailable: false, containers: [], warnings: [] };
  await Promise.all([
    (async () => {
      try { report.disk = diskUsage(await statfs(dir)); } catch {}
      if (!report.disk) report.warnings.push('Site-files disk capacity is unavailable.');
    })(),
    (async () => {
      try {
        const listed = await run(['ps', '-a', '--filter', 'label=com.docker.compose.project=' + id, '--format', '{{.ID}}']);
        const ids = String(listed.stdout || '').trim().split(/\s+/).filter(Boolean);
        if (ids.length > 128 || ids.some(cid => !/^[0-9a-f]{12,64}$/.test(cid))) throw new Error('invalid container list');
        if (ids.length) {
          const inspected = await run(['container', 'inspect', '--size', '--format', FORMAT, ...ids]);
          report.containers = containerUsage(inspected.stdout, id);
        }
        report.dockerAvailable = true;
      } catch { report.warnings.push('Container sizes unavailable: Docker may be unreachable, or a container changed during measurement.'); }
    })()
  ]);
  return report;
}

module.exports = { bytes, diskUsage, containerUsage, measureStorage };
