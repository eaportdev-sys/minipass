// Real Chromium checks with synthetic HTTP fixtures; no production sites,
// outbound internet requests, Docker or application deployment required.
const assert = require('assert');
const http = require('http');
const { verify } = require('./browser-runner');
async function main() {
  const servers = [];
  const listen = async handler => {
    const server = http.createServer(handler); servers.push(server);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    return 'http://127.0.0.1:' + server.address().port;
  };
  try {
    const external = await listen((req, res) => {
      if (req.url.startsWith('/reset')) return req.socket.destroy();
      if (req.url.startsWith('/cors')) { res.setHeader('Content-Type', 'font/woff2'); res.end('fixture font without CORS permission'); return; }
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.writeHead(404); res.end('not found');
    });
    const origin = await listen((req, res) => {
      const mode = new URL(req.url, 'http://fixture.test').pathname.slice(1);
      if (['external-reset', 'external-404', 'external-cors', 'local-font', 'missing-css', 'missing-js', 'broken-api', 'uncaught', 'empty'].includes(mode)) {
        const font = mode === 'external-reset' ? external + '/reset.woff2?token=private'
          : mode === 'external-404' ? external + '/missing.woff2'
          : mode === 'external-cors' ? external + '/cors.woff2'
          : mode === 'local-font' ? '/missing.woff2' : null;
        res.setHeader('Content-Type', 'text/html');
        res.end(`<!doctype html><html><head>${font ? `<style>@font-face{font-family:Fixture;src:url('${font}')}body{font-family:Fixture,sans-serif}</style>` : ''}${mode === 'missing-css' ? '<link rel="stylesheet" href="/missing.css">' : ''}</head><body>${mode === 'empty' ? '' : '<p>Visible fixture using fallback text</p>'}${mode === 'missing-js' ? '<script src="/missing.js"></script>' : ''}${mode === 'broken-api' ? '<script>fetch("/api/fail")</script>' : ''}${mode === 'uncaught' ? '<script>throw new Error("fixture runtime failure")</script>' : ''}</body></html>`);
      } else { res.writeHead(req.url === '/api/fail' ? 500 : 404); res.end('not found'); }
    });
    const modes = ['external-reset', 'external-404', 'external-cors', 'local-font', 'missing-css', 'missing-js', 'broken-api', 'uncaught', 'empty'];
    const run = services => verify({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', targets: services.map(service => ({ service, url: origin + '/' + service })) });
    const passing = await run(modes.filter(mode => mode.startsWith('external-')));
    assert(passing.ok && passing.errors.length === 0 && passing.warnings.length >= 3, 'external font failures alone must pass the aggregate deployment gate');
    assert(passing.pages.find(p => p.service === 'external-cors').warnings.some(w => w.includes('net::ERR_FAILED')), 'reproduce Chromium CORS font ERR_FAILED');
    const report = await run(modes.filter(mode => !mode.startsWith('external-')));
    for (const mode of modes) {
      const page = [...passing.pages, ...report.pages].find(p => p.service === mode);
      assert.equal(page.status, 200, JSON.stringify(page.errors));
      assert(page.screenshot, mode + ' captures the real browser rendering');
      if (mode.startsWith('external-')) {
        assert(page.ok && page.rendered && page.errors.length === 0, JSON.stringify(page.errors));
        assert(page.warnings.some(w => w.includes('Optional external font unavailable')), mode + ' remains visible as a warning');
      } else {
        assert(!page.ok && page.errors.length > 0, mode + ' must still fail');
        assert.equal(page.warnings.length, 0);
      }
    }
    assert(report.warnings.length === 0 && report.errors.length >= 6 && !report.ok);
    assert(!JSON.stringify(passing.warnings).includes('token=private'), 'font warnings never expose query credentials');
    console.log('LIVE PASS: real Chromium network/HTTP external font failures pass with visible warnings and fallback rendering; local fonts, CSS, JS, API, uncaught errors and empty pages still fail.');
  } finally {
    await Promise.all(servers.map(server => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); })));
  }
}
main().catch(e => { console.error(e); process.exitCode = 1; });
