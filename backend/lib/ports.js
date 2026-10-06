// Host-port bookkeeping. The panel claims 8000+ ports in its registry at create
// time, but the real world moves: orphans from deleted sites, manual `docker
// run` containers, or hand edits can squat a stored port. These pure helpers
// decide a rebind; server.js persists it (meta + compose) before `up`.
function parsePublishedPorts(text) {
  // `docker ps --format "{{.ID}} {{.Ports}}"` lines, e.g.
  // "abc123 0.0.0.0:8003->80/tcp, :::8003->80/tcp". Exposed-but-unpublished
  // ports ("80/tcp" with no "->") are correctly ignored.
  const bound = new Map(); // hostPort -> Set(containerId)
  for (const line of String(text || '').split('\n')) {
    const m = line.match(/^(\S+)\s+(.*)$/);
    if (!m) continue;
    const re = /(\d{1,3}(?:\.\d{1,3}){3}|::|[0-9a-f:]*):(\d+)->\d+\/tcp/gi;
    let mm;
    while ((mm = re.exec(m[2]))) {
      const p = parseInt(mm[2], 10);
      if (!(p > 0 && p < 65536)) continue;
      if (!bound.has(p)) bound.set(p, new Set());
      bound.get(p).add(m[1]);
    }
  }
  return bound;
}

function nextFreePort(want, taken, min = 8000, max = 9000) {
  const used = new Set([...taken].map(Number));
  let p = parseInt(want, 10);
  if (!p || p < 1) p = min;
  p = Math.max(min, Math.min(max, p));
  while (used.has(p) && p < max) p++;
  return used.has(p) ? null : p; // null: whole range exhausted, let `up` say so
}

// services: [{ name, hostPort }]. bound: parsePublishedPorts output.
// own: container IDs of this site (they legitimately hold our ports).
// registryOthers: ports claimed by OTHER sites in the panel registry.
// Returns [{ name, from, to }]; empty when everything is fine.
function planRebind(services, { bound, own, registryOthers }) {
  const holders = bound instanceof Map ? bound : new Map();
  const ownIds = [...(own || [])].map(String);
  const foreign = new Set([...(registryOthers || [])].map(Number));
  const taken = new Set([...holders.keys(), ...foreign]);
  const moves = [];
  for (const s of services || []) {
    const port = parseInt(s.hostPort, 10);
    if (!port) continue;
    const ids = holders.get(port) || new Set();
    const squatted = [...ids].some(h => !ownIds.some(o => o === h || o.startsWith(h) || h.startsWith(o)));
    if (!squatted && !foreign.has(port)) continue;
    const to = nextFreePort(port + 1, taken);
    if (!to) continue;
    taken.add(to);
    moves.push({ name: s.name, from: port, to });
  }
  return moves;
}

module.exports = { parsePublishedPorts, nextFreePort, planRebind };
