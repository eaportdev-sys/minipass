// Runs only in an ephemeral, unprivileged verification container in production.
// No host mounts, panel credentials, Docker socket or customer login secrets.
const VERSION = 3;
const safeUrl = value => {
  try { const u = new URL(value); u.username = ''; u.password = ''; u.search = ''; u.hash = ''; return u.toString(); }
  catch { return 'invalid URL'; }
};
function optionalExternalFont(kind, url, pageUrl) {
  if (kind !== 'font') return false;
  try {
    const resource = new URL(url), page = new URL(pageUrl);
    return ['http:', 'https:'].includes(resource.protocol) && resource.origin !== page.origin;
  } catch { return false; }
}
async function verify({ targets = [], probes = [], localCa = null, executablePath = '/usr/bin/chromium' }) {
  if(localCa) {
    const fs=require('fs'),path=require('path'),os=require('os'),tls=require('tls'),crypto=require('crypto');
    const ca=new crypto.X509Certificate(localCa);
    if(!ca.ca)throw new Error('Local trust input is not a certificate authority');
    // Trust just this site's CA in this disposable browser, never ignore all
    // certificate errors or change the host/panel/browser's global trust store.
    const file=path.join(os.tmpdir(),'minipass-local-ca.crt');fs.writeFileSync(file,localCa);
    const exec=require('child_process').execFileSync;
    // New Chromium uses the XDG store; older distro versions use ~/.pki.
    for(const db of [path.join(os.homedir(),'.pki','nssdb'),path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(),'.local','share'),'pki','nssdb')]) {
      fs.mkdirSync(db,{recursive:true});
      exec('certutil',['-N','--empty-password','-d','sql:'+db]);
      exec('certutil',['-A','-d','sql:'+db,'-n','Minipass local site','-t','C,,','-i',file]);
    }
    if(typeof tls.setDefaultCACertificates!=='function')throw new Error('Verifier runtime cannot trust the local CA safely; rebuild its current image');
    tls.setDefaultCACertificates([...tls.getCACertificates('default'),localCa]);
  }
  const { chromium } = require('playwright-core');
  const result = { version: VERSION, ok: true, pages: [], probes: [], errors: [], warnings: [] };
  const browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  try {
    const context = await browser.newContext({ viewport: { width: 1200, height: 800 }, ignoreHTTPSErrors: false });
    await context.setExtraHTTPHeaders({ 'Cache-Control': 'no-cache', Pragma: 'no-cache' });
    for (const target of targets) {
      const page = await context.newPage();
      const failures = [], warnings = [], assets = [], api = [], pageErrors = [];
      const report = { service: target.service, url: safeUrl(target.url), ok: false, status: null, kind: null, assets, api, errors: failures, warnings };
      const requestIssue = (kind, url, message) => {
        if (optionalExternalFont(kind, url, page.url() === 'about:blank' ? target.url : page.url())) {
          warnings.push('Optional external font unavailable (browser fallback): ' + message);
        } else failures.push(message);
      };
      page.on('pageerror', e => pageErrors.push(String(e.message).replace(/https?:\/\/[^\s]+/g, u => safeUrl(u)).slice(0, 300)));
      page.on('requestfailed', r => {
        if (r.failure() && r.failure().errorText === 'net::ERR_ABORTED') return;
        requestIssue(r.resourceType(), r.url(), `${r.resourceType()} ${safeUrl(r.url())}: ${r.failure() && r.failure().errorText || 'request failed'}`);
      });
      page.on('response', r => {
        const kind = r.request().resourceType();
        const item = { url: safeUrl(r.url()), status: r.status(), type: kind };
        if (['stylesheet', 'script', 'font', 'image', 'media'].includes(kind)) { assets.push(item); if (r.status() >= 400) requestIssue(kind, r.url(), `${kind} failed (${r.status()}): ${item.url}`); }
        if (['fetch', 'xhr'].includes(kind)) { api.push(item); if (r.status() === 404 || r.status() >= 500) failures.push(`API request failed (${r.status()}): ${item.url}`); }
      });
      try {
        // Choose a live landing route, not an assumed /health or a soft-404.
        const rootProbe = await context.request.get(target.url, { timeout: 5000, failOnStatusCode: false });
        if (rootProbe.status() === 404) {
          const sentinel = await context.request.get(new URL('/.minipass-verification-route-does-not-exist', target.url).toString(), { timeout: 5000, failOnStatusCode: false });
          const soft = sentinel.status() >= 200 && sentinel.status() < 400;
          for (const route of target.candidatePaths || []) {
            if (soft && route !== '/' && !(target.declaredPaths || []).includes(route)) continue;
            const candidate = new URL(route, target.url).toString();
            const response = await context.request.get(candidate, { timeout: 5000, failOnStatusCode: false });
            if (response.status() >= 200 && response.status() < 400 || [401, 403].includes(response.status())) { target.url = candidate; report.url = safeUrl(candidate); break; }
          }
        }
        const response = await page.goto(target.url, { waitUntil: 'networkidle', timeout: 25000 }).catch(async error => {
          // Long polling/websockets should not fail an otherwise loaded page.
          if (error.name === 'TimeoutError' && await page.evaluate(() => document.readyState !== 'loading')) return null;
          throw error;
        });
        report.status = response ? response.status() : null;
        if (target.release) {
          const current = response ? response.headers()['x-minipass-release'] : (await context.request.get(target.url, { timeout: 5000 })).headers()['x-minipass-release'];
          if (current !== target.release) failures.push(target.local?'The local address did not reach this site/release. Use the allocated local URL shown in Deploy; do not copy another site\'s port.':'The configured public URL did not reach this release. Check its proxy/DNS/cache, or select local/LAN access instead.');
          report.releaseMatched = current === target.release;
        }
        if (report.status != null && report.status >= 400 && ![401, 403].includes(report.status)) failures.push('Landing response was ' + report.status);
        const html = await page.evaluate(() => document.contentType.includes('html'));
        report.kind = html ? 'website' : 'api';
        if (html && [401, 403].includes(report.status)) failures.push('Website authentication prevents browser/asset verification; provide a public verification landing page');
        if (!html && /health|ready|live/i.test(new URL(target.url).pathname)) {
          try { const value = JSON.parse(await page.locator('body').innerText()); if (value.ok === false || value.healthy === false || value.ready === false) failures.push('Health/readiness response reports not ready despite HTTP 200'); } catch {}
        }
        if (html) {
          // Exercise real browser CSP, stylesheet/script loading and hydration.
          // Unlike curl, Chromium enforces upgrade-insecure-requests and CORS.
          await page.waitForTimeout(1800);
          for (let i = 0; i < 3; i++) { await page.evaluate(() => window.scrollBy(0, window.innerHeight)); await page.waitForTimeout(200); }
          await page.evaluate(() => window.scrollTo(0, 0));
          const dom = await page.evaluate(() => ({ text: document.body && document.body.innerText.trim().length || 0,
            controls: document.body && document.body.querySelectorAll('input,button,canvas,svg,img,video').length || 0,
            requiresHttps: [...document.querySelectorAll('meta[http-equiv]')].some(m => m.httpEquiv.toLowerCase() === 'content-security-policy' && /upgrade-insecure-requests/.test(m.content)),
            styles: [...document.querySelectorAll('link[rel="stylesheet"]')].map(l => ({ href: l.href, loaded: !!l.sheet })) }));
          if (!dom.text && !dom.controls) failures.push('The browser rendered an empty page');
          for (const style of dom.styles) if (!style.loaded) failures.push('Stylesheet did not load: ' + safeUrl(style.href));
          if (new URL(target.url).protocol === 'http:' && (dom.requiresHttps || response && /upgrade-insecure-requests/.test(response.headers()['content-security-policy'] || '')) && failures.some(e => /https:|SSL|TLS|stylesheet/i.test(e))) {
            failures.push('This repository requires HTTPS for its assets. Select local HTTPS in Deploy (no public domain needed), or configure an external HTTPS route. Security headers were preserved, not stripped.');
          }
          failures.push(...pageErrors.map(e => 'Uncaught browser error: ' + e));
          report.screenshot = (await page.screenshot({ type: 'png' })).toString('base64');
          report.rendered = dom.text > 0 || dom.controls > 0;
        }
        report.ok = failures.length === 0;
      } catch (e) { failures.push(String(e.message).replace(/https?:\/\/[^\s]+/g, u => safeUrl(u)).slice(0, 400)); }
      result.pages.push(report);
      result.warnings.push(...warnings.map(e => `${target.service}: ${e}`));
      if (!report.ok) result.errors.push(...failures.map(e => `${target.service}: ${e}`));
      await page.close();
    }
    for (const probe of probes) {
      const attempts = [];
      let exists = false;
      let catchAll = false;
      try {
        const sentinel = new URL('/.minipass-verification-route-does-not-exist', probe.urls[0]).toString();
        const response = await context.request.get(sentinel, { timeout: 5000, failOnStatusCode: false });
        catchAll = response.status() >= 200 && response.status() < 400;
      } catch {}
      for (const candidate of probe.urls.filter(u => !catchAll || new URL(u).pathname === '/' || (probe.declaredPaths || []).includes(new URL(u).pathname))) {
        try {
          const response = await context.request.get(candidate, { timeout: 5000, failOnStatusCode: false });
          const status = response.status();
          attempts.push({ url: safeUrl(candidate), status });
          if (/health|ready|live/i.test(new URL(candidate).pathname) && status >= 200 && status < 400) {
            try { const value = await response.json(); if (value.ok === false || value.healthy === false || value.ready === false) { attempts.at(-1).error = 'readiness JSON reports failure'; break; } } catch {}
          }
          if (status >= 200 && status < 400 || status === 401 || status === 403) { exists = true; break; }
        } catch { attempts.push({ url: safeUrl(candidate), error: 'connection/TLS failed' }); }
      }
      result.probes.push({ service: probe.service, ok: exists, attempts });
      if (!exists) result.errors.push(`${probe.service}: no declared/source HTTP route responded successfully (404 and 5xx are not live)`);
    }
    result.ok = result.errors.length === 0 && (result.pages.length > 0 || result.probes.length > 0);
    if (!result.pages.length && !result.probes.length) result.errors.push('No website/API endpoint could be verified; declare a published port or HTTP expose/PORT and an open route');
    await context.close();
    return result;
  } finally { await browser.close(); }
}
if (require.main === module) {
  let input = '', started = false;
  process.stdin.setEncoding('utf8');
  const finish = async () => {
    if (started) return; started = true; process.stdin.pause();
    try { process.stdout.write(JSON.stringify(await verify(JSON.parse(input.trim()))), () => process.exit(0)); }
    catch (e) { process.stdout.write(JSON.stringify({ ok: false, errors: ['Browser verifier failed: ' + String(e.message).slice(0, 500)] }), () => process.exit(1)); }
  };
  process.stdin.on('data', d => { input += d; if (input.length > 512 * 1024) process.exit(2); if (input.includes('\n')) finish(); });
  process.stdin.on('end', finish);
}
module.exports = { VERSION, verify, safeUrl, optionalExternalFont };
