// doctor: extracted from the original backend without changing route semantics.
module.exports = function register(ctx) {
  const { APPS_DIR, COMPOSE_BIN, app, appDir, execSync, missingEnvVars, path, readComposeTopo, routes, svc } = ctx;
  const appContainers = (...args) => ctx.appContainers(...args);
  const load = (...args) => ctx.load(...args);
  const parseEnvFile = (...args) => ctx.parseEnvFile(...args);
  const sh = (...args) => ctx.sh(...args);
const LOG_RULES = [
  { re: /relation "([^"]+)" does not exist/, level: 'fail', msg: m => `table "${m[1]}" missing in postgres — run this app's migrations` },
  { re: /FATAL:\s+database "([^"]+)" does not exist/, level: 'fail', msg: m => `database "${m[1]}" missing on the db service — wrong DB name in env?` },
  { re: /FATAL:\s+role "([^"]+)" does not exist/, level: 'fail', msg: m => `db role "${m[1]}" missing — user/password out of sync with the volume?` },
  { re: /password authentication failed/i, level: 'fail', msg: () => 'db password rejected — .env out of sync with the kept volume (recreate resets both)' },
  { re: /getaddrinfo (ENOTFOUND|EAI_AGAIN) ([^\s]+)/i, level: 'fail', msg: m => `DNS fail for "${m[2]}" — wrong service hostname in env? (use db-<type>)` },
  { re: /connect ECONNREFUSED ([^\s:]+):(\d+)/i, level: 'fail', msg: m => `nothing at ${m[1]}:${m[2]} — wrong host/port in env, or that service is down` },
  { re: /127\.0\.0\.1:\d+/, level: 'warn', msg: () => '127.0.0.1 inside a container is the container itself — servers must bind 0.0.0.0 to be reachable, and clients must use the service host, not localhost' },
  { re: /EADDRINUSE[^:]*:?(\d+)?/i, level: 'fail', msg: m => `port ${m[1] || '?'} busy inside the container — app hardcodes a port?` },
  { re: /Cannot find module ([^\s'"]+)/, level: 'fail', msg: m => `missing node module ${m[1]} — incomplete install, rebuild the app` },
  // Uppercase-only identifier so credential values and sentences never match -
  // only the required variable NAME is echoed, never any value.
  { re: /\b([A-Z][A-Z0-9_]{2,}) is required\b/, level: 'fail', msg: m => `container needs env ${m[1]} — add it in the Environment tab and redeploy` },
  { re: /JavaScript heap out of memory|OOMKilled/i, level: 'fail', msg: () => 'out of memory — raise box swap or container limits' },
  { re: /^(?!.*(password|token|secret|key)).*error:/gim, level: 'warn', msg: () => 'error lines present in recent logs', count: true }
];

app.get('/api/apps/:id/doctor', async (req, res) => {
  const meta = load().apps.find(a => a.id === req.params.id);
  if (!meta) return res.status(404).json({ error: 'unknown app' });
  const dir = appDir(APPS_DIR, meta.id);
  const checks = [];
  const containers = await appContainers(meta.id);
  const appC = containers.find(c => /^(app|web|server)$/i.test(c.service)) || containers[0];
  checks.push({
    name: 'containers',
    status: containers.length && containers.every(c => /^running/i.test(c.state || '')) ? 'ok' : 'fail',
    detail: containers.length ? containers.map(c => `${c.service}: ${c.state || '?'}${c.status ? ` (${c.status})` : ''}`).join(', ') : 'no containers'
  });
  if (appC && appC.id) {
    try {
      const insp = await sh(`docker inspect ${appC.id} --format '{{.State.OOMKilled}} {{.State.ExitCode}} {{.RestartCount}}'`, dir);
      const [oom, code, restarts] = insp.trim().split(/\s+/);
      checks.push({
        name: 'oom/crashloop',
        status: oom === 'true' || (parseInt(code, 10) !== 0 && parseInt(restarts, 10) > 3) ? 'fail' : 'ok',
        detail: `OOMKilled=${oom} exit=${code} restarts=${restarts}`
      });
    } catch (e) { checks.push({ name: 'oom/crashloop', status: 'warn', detail: 'inspect failed' }); }
  }
  // landing probe (same candidates as autodetect)
  try {
    const env = parseEnvFile(path.join(dir, '.env'));
    const cport = parseInt(env.PORT, 10) || 3000;
    const net = `${meta.id}_default`;
    const probed = [];
    const probePath = p => execSync(`docker run --rm --network ${net} curlimages/curl:latest -s -o /dev/null -w "%{http_code}" --max-time 5 http://app:${cport}${p}`, { timeout: 15000 }).toString().trim();
    let soft404 = false;
    try {
      const code = probePath(routes.PROBE_SENTINEL);
      soft404 = routes.liveStatus(code);
      probed.push(`${routes.PROBE_SENTINEL}→${code}`);
    } catch { probed.push(`${routes.PROBE_SENTINEL}→unreachable`); }
    const candidates = soft404 ? ['/'] : routes.PROBE_PATHS;
    for (const p of candidates) {
      try {
        const code = probePath(p);
        probed.push(`${p}→${code}`);
        if (routes.liveStatus(code)) {
          const detail = soft404
            ? `catch-all/soft-404 detected; safe default: / (${code})`
            : `first live route: ${p} (${code})${meta.homePath && meta.homePath !== p ? ` - open path set to ${meta.homePath}` : ''}`;
          checks.push({ name: 'landing', status: 'ok', detail });
          break;
        }
      } catch { probed.push(`${p}→unreachable`); }
    }
    if (!checks.some(c => c.name === 'landing')) {
      checks.push({ name: 'landing', status: 'fail', detail: 'no route answers; probed: ' + probed.join(' ') });
    }
  } catch (e) { checks.push({ name: 'landing', status: 'warn', detail: 'probe failed: ' + e.message }); }
  // log signature scan (every enabled app service - the crash is often not in
  // `app`; secrets filtered by rules avoiding credential values)
  try {
    const logSvcs = svc.fullServices(meta, dir).filter(s => s.enabled !== false).map(s => s.name);
    const targets = logSvcs.length ? logSvcs.slice(0, 6) : ['app'];
    const hits = [];
    for (const svcName of targets) {
      let logs = '';
      try { logs = await sh(`${COMPOSE_BIN} logs --tail=150 ${svcName}`, dir); } catch { continue; }
      const tag = targets.length > 1 ? `${svcName}: ` : '';
      for (const rule of LOG_RULES) {
        if (rule.count) {
          const n = (logs.match(rule.re) || []).length;
          if (n > 3) hits.push({ level: rule.level, msg: `${tag}${n} error lines in recent logs - open Logs tab` });
          continue;
        }
        const m = logs.match(rule.re);
        if (m) hits.push({ level: rule.level, msg: tag + rule.msg(m) });
      }
    }
    checks.push(hits.length
      ? { name: 'logs', status: hits.some(h => h.level === 'fail') ? 'fail' : 'warn', detail: hits.map(h => h.msg).join(' | ') }
      : { name: 'logs', status: 'ok', detail: 'no known failure signatures in last 200 lines' });
  } catch (e) { checks.push({ name: 'logs', status: 'warn', detail: 'could not read logs' }); }
  // env-needs: vars the repo code reads but .env doesn't set (read-only scan).
  // Empty counts as unset: a referenced key with no value can't function.
  // Compose-required vars (${VAR:?}) join with the repo's own message.
  try {
    const { need, missing, empty, unset, compose } = missingEnvVars(dir);
    const composeMsg = (compose || []).filter(e => unset.includes(e.key))
      .map(e => `${e.key}${e.message ? ` (${e.message})` : ''}`).join(', ');
    if (!need.length && !compose.length) checks.push({ name: 'env-needs', status: 'ok', detail: 'no env references found in code or compose' });
    else if (!unset.length) checks.push({ name: 'env-needs', status: 'ok', detail: `all ${need.length} code-referenced var${need.length === 1 ? '' : 's'} set` });
    else checks.push({ name: 'env-needs', status: 'fail', detail: `code reads ${unset.length} unset var${unset.length === 1 ? '' : 's'}: ${unset.slice(0, 12).join(', ')}${unset.length > 12 ? '…' : ''}${empty.length ? ` (${empty.length} present but empty)` : ''}${composeMsg ? ` — compose requires: ${composeMsg}` : ''} — add via environment card` });
  } catch (e) { checks.push({ name: 'env-needs', status: 'warn', detail: 'scan failed' }); }
  // topology: repo-shipped compose file the panel does not apply itself.
  // Read-only: names the services, one-shot tasks and required env so the
  // operator can mirror what matters (services, migrations) by hand.
  try {
    const topo = readComposeTopo(path.join(dir, 'code'));
    if (!topo) checks.push({ name: 'topology', status: 'ok', detail: 'no repo compose file - panel manages services' });
    else {
      const names = topo.services.map(s => s.name).join(', ') || 'no services parsed';
      const shots = topo.services.filter(s => s.oneShot).map(s => s.name);
      const reqEnv = (topo.envNeeds || []).filter(e => e.required).map(e => e.key);
      const actions = [...(shots.length ? [`one-shot: ${shots.join(', ')} (run via Migrations)`] : []),
        ...(reqEnv.length ? [`compose requires env: ${reqEnv.join(', ')}`] : [])];
      checks.push({ name: 'topology', status: actions.length ? 'warn' : 'ok', detail: `repo ${topo.file} defines: ${names}${actions.length ? ' — ' + actions.join('; ') : ''}` });
    }
  } catch (e) { checks.push({ name: 'topology', status: 'warn', detail: 'topology scan failed' }); }
  const fails = checks.filter(c => c.status === 'fail').length;
  const warns = checks.filter(c => c.status === 'warn').length;
  res.json({ app: meta.id, checks, summary: fails ? `${fails} fail${warns ? `, ${warns} warn` : ''}` : (warns ? `${warns} warn` : 'all clear') });
});
};
