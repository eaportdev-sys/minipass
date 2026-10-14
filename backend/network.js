// network: extracted from the original backend without changing route semantics.
module.exports = function createHelpers(ctx) {
  const { APPS_DIR, COMPOSE_BIN, PORT, WebSocketServer, app, appDir, execSync, http, panelAuthed, spawn, store, svc } = ctx;
  const load = (...args) => ctx.load(...args);
const server = http.createServer(app);

let shuttingDown = false;

function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  server.close(() => { store.close(); process.exit(0); });
  setTimeout(() => process.exit(0), 5000).unref();
}

process.on('SIGTERM', shutdown);

process.on('SIGINT', shutdown);

const wss = new WebSocketServer({ server, path: '/terminal' });

wss.on('connection', (ws, req) => {
  if (!panelAuthed(req)) { try { ws.send('panel login required - sign in and reconnect\r\n'); } catch {} return ws.close(1008, 'login required'); }
  const q = new URL(req.url, 'http://x').searchParams;
  const id = q.get('app');
  const meta = id && load().apps.find(a => a.id === id);
  if (!meta) { ws.send('unknown website\r\n'); return ws.close(1008, 'unknown website'); }
  const dir = appDir(APPS_DIR, id);
  const services = svc.fullServices(meta, dir);
  const requested = q.get('service');
  const service = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(requested || '') && (requested !== 'app' || services.some(s => s.name === 'app')) ? requested : (services[0] || {}).name || 'app';
  let cid = '';
  try { cid = execSync(`${COMPOSE_BIN} ps -q ${service}`, { cwd: dir }).toString().trim().split('\n')[0]; }
  catch {}
  if (!cid) { ws.send('container not running - deploy or start this service first\r\n'); return ws.close(); }
  if (!/^[a-f0-9]{12,64}$/i.test(cid)) { ws.send('invalid container id\r\n'); return ws.close(1011, 'invalid container id'); }
  const command = `docker exec -it -e TERM=xterm-256color ${cid} /bin/sh`;
  const p = spawn('script', ['-q', '-f', '-e', '-c', command, '/dev/null'], { cwd: dir });
  const send = d => { if (ws.readyState === 1) ws.send(d.toString()); };
  p.stdout.on('data', send);
  p.stderr.on('data', send);
  p.stdin.on('error', () => {});
  p.on('error', e => {
    send(`terminal failed to start: ${e.message}\r\n`);
    if (ws.readyState === 1) ws.close(1011, 'terminal failed to start');
  });
  p.on('close', code => {
    send(`\r\nterminal exited${code ? ` (${code})` : ''}\r\n`);
    if (ws.readyState === 1) ws.close(1000, 'shell exited');
  });
  ws.on('message', m => { if (!p.stdin.destroyed && p.stdin.writable) p.stdin.write(m); });
  ws.on('close', () => { if (!p.killed) p.kill(); });
});

server.listen(PORT, () => console.log(`minipaas on :${PORT}, apps in ${APPS_DIR}`));
};
