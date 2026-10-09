// Panel-wide error log. Toasts vanish; this file does not. JSON lines in
// <DATA_DIR>/panel-errors.log (on the /srv/panel-data volume, survives
// upgrades). Aggregate facts only - tokens are redacted at write time.
const fs = require('fs');
const path = require('path');
const MAX_BYTES = 512 * 1024;
const MAX_READ = 500;
function logPath() {
  try { return path.join(path.dirname(process.env.DATA_FILE || path.join(__dirname, '../data.json')), 'panel-errors.log'); }
  catch { return path.join(__dirname, '../panel-errors.log'); }
}
function redact(text) {
  return String(text || '')
    .replace(/x-access-token:[^@\s]+@/g, 'x-access-token:***@')
    .replace(/(bearer\s+)[A-Za-z0-9\-._~+/=]{8,}/gi, '$1***')
    .replace(/((?<!access-)(?:password|passwd|secret|token)[-_a-z]*["'\s:=]+)(["']?)([^\s"';,]{4,})/gi, (m, k, q) => k + q + '***');
}
function logEvent({ level = 'error', area = 'panel', site = null, message = '' } = {}) {
  try {
    const file = logPath();
    const entry = JSON.stringify({ at: new Date().toISOString(), level, area, site: site || null, message: redact(message).slice(0, 2000) }) + '\n';
    fs.appendFileSync(file, entry);
    try {
      if (fs.statSync(file).size > MAX_BYTES) {
        const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
        const keep = [];
        let bytes = 0;
        for (let i = lines.length - 1; i >= 0; i--) {
          bytes += lines[i].length + 1;
          if (bytes > MAX_BYTES / 2) break;
          keep.unshift(lines[i]);
        }
        fs.writeFileSync(file, keep.join('\n') + '\n');
      }
    } catch {}
  } catch {}
}
function readEvents(limit = 100) {
  const n = Math.min(500, Math.max(1, parseInt(limit, 10) || 100));
  let lines = [];
  try { lines = fs.readFileSync(logPath(), 'utf8').trim().split('\n').filter(Boolean); }
  catch { return []; }
  const out = [];
  for (const line of lines.slice(-n * 2)) {
    try {
      const e = JSON.parse(line);
      if (e && e.at && e.message) out.push({ at: String(e.at), level: String(e.level || 'error'), area: String(e.area || 'panel'), site: e.site ? String(e.site) : null, message: String(e.message) });
    } catch {}
  }
  return out.slice(-n).reverse();
}
module.exports = { logEvent, readEvents, redact, logPath };
