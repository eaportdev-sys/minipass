// Forward repository HTTP responses unchanged (including CSP). The opaque
// identity prevents public verification from accepting an old/other website.
const http = require('http');
const https = require('https');
const { pipeline } = require('stream');
const upstream = new URL(process.env.UPSTREAM);
const transport = upstream.protocol === 'https:' ? https : http;
const tls = process.env.TLS_CERT && process.env.TLS_KEY ? {cert:process.env.TLS_CERT,key:process.env.TLS_KEY} : null;
const forwardHeaders=req=>({ ...req.headers, 'x-forwarded-host': req.headers.host, 'x-forwarded-proto': req.socket.encrypted?'https':req.headers['x-forwarded-proto'] || 'http' });
const handle = (req, res) => {
  const headers = forwardHeaders(req);
  const outgoing = transport.request({ hostname: upstream.hostname, port: upstream.port, method: req.method, path: req.url, headers }, incoming => {
    res.writeHead(incoming.statusCode, { ...incoming.headers, 'x-minipass-release': process.env.RELEASE_ID });
    pipeline(incoming, res, () => {});
  });
  outgoing.on('error', () => { if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'text/plain', 'x-minipass-release': process.env.RELEASE_ID }); res.end('Repository upstream is unavailable'); });
  pipeline(req, outgoing, () => {});
};
const server = tls ? https.createServer(tls,handle) : http.createServer(handle);
server.on('upgrade', (req, socket, head) => {
  const outgoing = transport.request({ hostname: upstream.hostname, port: upstream.port, path: req.url, method: req.method, headers: forwardHeaders(req) });
  outgoing.on('upgrade', (incoming, remote, received) => {
    socket.write(`HTTP/1.1 ${incoming.statusCode} ${incoming.statusMessage}\r\n` + Object.entries(incoming.headers).map(([k,v]) => `${k}: ${v}`).join('\r\n') + '\r\n\r\n');
    if (received.length) socket.write(received); if (head.length) remote.write(head);
    socket.pipe(remote); remote.pipe(socket);
    socket.on('error', () => remote.destroy()); remote.on('error', () => socket.destroy());
  });
  outgoing.on('error', () => socket.destroy()); outgoing.end();
});
server.listen(8080, '0.0.0.0');
