let siteListPoll = false;
async function pollSiteList() {
  if (siteListPoll || document.hidden) return;
  const view = document.getElementById('view-websites');
  if (!view || !view.classList.contains('active')) return;
  const ids = [...document.querySelectorAll('[id^="appPower-"]')].map(el => el.id.slice('appPower-'.length));
  if (!ids.length) return;
  siteListPoll = true;
  try {
    await hydrateAppCards(websiteVisibleApps.filter(a => ids.includes(a.id)), appsRefreshSeq);
  } finally { siteListPoll = false; }
}
setInterval(() => { if (!currentApp) pollSiteList(); }, 10000);
setInterval(async () => {
  if (!currentApp) return;
  let st;
  try { st = await (await fetch(`/api/apps/${currentApp}/status`)).json(); } catch { return; }
  const op = st.deployOp && st.deployOp.source !== 'manual' ? st.deployOp : null;
  const slot = !op ? null : (op.source === 'local-push' ? 'local' : 'hook');
  const recv = !op && st.pushEvent && (Date.now() - st.pushEvent.at) < 120000;
  updatePowerStates(st);
  if (st.app) renderRouteChoices(st.app);
  // Server-side manual builds (create's background build, list-view redeploys)
  // have no browser-side tracker, unlike runDeploy. Surface them in the main
  // progress box so an opened site shows elapsed time instead of a bare pulse.
  const mop = st.deployOp && (st.deployOp.source === 'manual' || st.deployOp.source === 'local') && manualDeployActive !== currentApp ? st.deployOp : null;
  if (mop) {
    manualOpShown = { app: currentApp, startedAt: mop.startedAt };
    const box = document.getElementById('deployProg');
    if (box) {
      box.style.display = 'block';
      const s = Math.floor((Date.now() - mop.startedAt) / 1000);
      const bar = document.getElementById('deployBar');
      const pctv = Math.min(95, 2 + (Date.now() - mop.startedAt) / 90000 * 93);
      bar.style.width = pctv.toFixed(0) + '%';
      bar.style.background = '#4caf50';
      document.getElementById('deployPct').textContent = pctv.toFixed(0) + '%';
      document.getElementById('deployTime').textContent = s + 's';
      document.getElementById('deployStage').textContent = 'deploying… (started in background)';
    }
  } else if (manualOpShown && manualOpShown.app === currentApp) {
    manualOpShown = null;
    const d = st.lastDeploy;
    const box = document.getElementById('deployProg');
    if (box && box.style.display !== 'none') {
      document.getElementById('deployBar').style.width = '100%';
      document.getElementById('deployPct').textContent = '100%';
      if (d && d.status === 'ok') {
        document.getElementById('deployBar').style.background = '#4caf50';
        document.getElementById('deployStage').textContent = 'done — live';
        toast('background deploy finished', true);
      } else {
        document.getElementById('deployBar').style.background = 'var(--danger)';
        document.getElementById('deployStage').textContent = 'failed';
        toast('background deploy failed: ' + ((d && d.error) || 'unknown'), false);
      }
      setTimeout(() => { box.style.display = 'none'; }, 15000);
    }
    refreshSiteData();
  }
  for (const p of ['hook', 'local']) {
    const box = document.getElementById(p + 'Prog');
    if (!box) continue;
    if (p !== slot && remoteOp && remoteOp.slot === p) {
      const bar = document.getElementById(p + 'Bar');
      const pct = document.getElementById(p + 'Pct');
      const stage = document.getElementById(p + 'Stage');
      const d = st.lastDeploy;
      const secs = d && d.durationMs != null ? Math.round(d.durationMs / 1000) : null;
      bar.style.width = '100%'; pct.textContent = '100%';
      if (d && d.status === 'ok') {
        bar.style.background = '#4caf50';
        stage.textContent = `done — live via ${remoteOp.source}${secs != null ? ` in ${secs}s` : ''}`;
        toast(`deployed via ${remoteOp.source}${secs != null ? ` in ${secs}s` : ''}`, true);
      } else {
        bar.style.background = 'var(--danger)';
        stage.textContent = `failed via ${remoteOp.source}`;
        toast(`deploy via ${remoteOp.source} failed: ` + ((d && d.error) || 'unknown'), false);
      }
      refreshSiteData();
      setTimeout(() => { box.style.display = 'none'; }, 15000);
    }
    if (p !== slot && !(p === 'local' && recv)) box.style.display = 'none';
  }
  if (recv && !remoteOp) {
    const box = document.getElementById('localProg');
    if (box) {
      box.style.display = 'block';
      document.getElementById('localStage').textContent = 'receiving push…';
      document.getElementById('localBar').style.width = '4%';
      document.getElementById('localPct').textContent = '';
      document.getElementById('localTime').textContent = Math.floor((Date.now() - st.pushEvent.at) / 1000) + 's';
    }
  }
  if (!op) { remoteOp = null; return; }
  remoteOp = { app: currentApp, source: op.source, startedAt: op.startedAt, slot };
  const box = document.getElementById(slot + 'Prog');
  if (!box) return;
  box.style.display = 'block';
  const s = Math.floor((Date.now() - op.startedAt) / 1000);
  document.getElementById(slot + 'Time').textContent = s + 's';
  const pctv = Math.min(95, 2 + (Date.now() - op.startedAt) / 90000 * 93);
  document.getElementById(slot + 'Bar').style.width = pctv.toFixed(0) + '%';
  document.getElementById(slot + 'Pct').textContent = pctv.toFixed(0) + '%';
  document.getElementById(slot + 'Stage').textContent = `deploying via ${op.source}…`;
}, 3000);