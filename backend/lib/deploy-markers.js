const fs = require('fs');
const path = require('path');

// Deploy markers on the shared data volume. The host upgrade job recreates
// the panel container, which kills in-memory deploy queues and orphans the
// deploy with a stale status - so the host must not restart mid-deploy.
// One file per queued site deploy; the host defers while a fresh one exists.
const MARKER_TTL_MS = 30 * 60 * 1000;

function markerPath(dir, id) {
  const safe = String(id || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64) || 'unknown';
  return path.join(dir, `.deploy-${safe}`);
}

function mark(dir, id) {
  try { fs.writeFileSync(markerPath(dir, id), String(Date.now())); } catch {}
}

function unmark(dir, id) {
  try { fs.rmSync(markerPath(dir, id), { force: true }); } catch {}
}

// Fresh boot has no active deploys by definition - anything left behind is
// from a killed panel and must not block upgrades forever. Returns the
// number of stale markers removed.
function sweep(dir) {
  let files = [];
  try { files = fs.readdirSync(dir); } catch { return 0; }
  let removed = 0;
  for (const f of files) {
    if (!f.startsWith('.deploy-')) continue;
    try { fs.rmSync(path.join(dir, f), { force: true }); removed++; } catch {}
  }
  return removed;
}

// Names of markers written within the TTL - the set the host must defer to.
function active(dir, now = Date.now(), ttlMs = MARKER_TTL_MS) {
  let files = [];
  try { files = fs.readdirSync(dir); } catch { return []; }
  return files.filter(f => {
    if (!f.startsWith('.deploy-')) return false;
    try { return now - fs.statSync(path.join(dir, f)).mtimeMs < ttlMs; }
    catch { return false; }
  });
}

module.exports = { MARKER_TTL_MS, markerPath, mark, unmark, sweep, active };
