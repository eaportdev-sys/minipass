function openTerm() {
  if (!currentApp) return;
  const svc = document.getElementById('termSvc').value || 'app';
  connectTerm('term', currentApp, 'site', svc);
}
function openTermGlobal() {
  const id = document.getElementById('termApp').value;
  if (!id) return;
  connectTerm('termGlobal', id, 'global');
}
// Remote-trigger watcher: webhook/poll/local-push deploys happen with no browser
// involved, so poll /status while a site is open and mirror the progress UI into
// the card the trigger came from (webhook card vs local-git card). Manual ops
// stay with runDeploy to avoid double toasts.
// Power states are source-specific: only the trigger handling the current deploy
// pulses yellow. The persistent site control reflects the whole deployment.
function setPowerState(id, state, label) {
  const el = document.getElementById(id);
  if (!el) return;
  for (const s of ['checking', 'deployed', 'deploying', 'off', 'failed', 'idle']) el.classList.remove('is-' + s);
  el.classList.add('is-' + state);
  el.dataset.state = state;
  const text = el.querySelector('.power-label');
  if (text) text.textContent = label;
  if (id === 'sitePower') {
    el.disabled = state === 'deploying' || state === 'checking';
    const canStart = el.dataset.canStart !== '0';
    el.title = state === 'deployed' ? 'Site is deployed — click to stop'
      : state === 'off' || state === 'failed' ? (canStart ? 'Site is off — click to start' : 'Site has no built container yet — click to deploy')
        : label;
  }
}
function sourceSlot(source) {
  if (source === 'local-push') return 'local';
  if (source === 'webhook' || source === 'poll') return 'hook';
  return null;
}
function containerUp(c) {
  const state = (c && c.state) || '';
  // A restart-looping container flickers through `running` between crashes.
  // Counting it as up makes the card flip-flop and hides the crash loop.
  return /^running/i.test(state) && !/^restarting/i.test(state);
}
function appIsRunning(st) {
  const containers = (st && st.containers) || [];
  const enabled = ((st && st.services) || []).filter(s => s.enabled !== false);
  if (enabled.length) return enabled.every(s => containers.some(c => c.service === s.name && containerUp(c)));
  const appContainers = containers.filter(c => !/^db(-|$)/i.test(c.service || ''));
  return appContainers.length > 0 && appContainers.every(containerUp);
}
function appCrashed(st) {
  const containers = (st && st.containers) || [];
  return containers.some(c => /restarting|exited|dead|failed/i.test((c && c.state) || ''));
}
function appCanStart(st) {
  const containers = (st && st.containers) || [];
  return containers.length > 0 || !!(st && st.liveDeploy) || !!(st && st.lastDeploy && st.lastDeploy.status === 'ok');
}
function updatePowerStates(st) {
  const receiving = st && !st.deployOp && st.pushEvent && (Date.now() - st.pushEvent.at) < 120000;
  const activeSlot = st && st.deployOp ? sourceSlot(st.deployOp.source) : (receiving ? 'local' : null);
  const deploying = !!(st && st.deploying) || !!receiving;
  const running = appIsRunning(st);
  const canStart = appCanStart(st);
  const sitePower = document.getElementById('sitePower');
  if (sitePower) sitePower.dataset.canStart = canStart ? '1' : '0';
  setPowerState('sitePower', deploying ? 'deploying' : (running ? 'deployed' : 'off'), deploying ? 'Deploying' : (running ? 'Deployed' : (canStart ? 'Off' : 'Not deployed')));
  const liveSlot = sourceSlot(st && st.liveDeploy && st.liveDeploy.source);
  const failedSlot = st && st.lastDeploy && st.lastDeploy.status !== 'ok' ? sourceSlot(st.lastDeploy.source) : null;
  const githubEnabled = !!(st && st.app && st.app.github && st.app.github.enabled === true);
  for (const slot of ['hook', 'local']) {
    if (activeSlot) setPowerState(slot + 'Power', slot === activeSlot ? 'deploying' : 'idle', slot === activeSlot ? 'Deploying' : 'Idle');
    else if (slot === 'hook' && !githubEnabled) setPowerState('hookPower', 'off', 'Disabled');
    else if (!running) setPowerState(slot + 'Power', 'off', 'Off');
    else if (failedSlot === slot) setPowerState(slot + 'Power', 'failed', 'Failed');
    else if (liveSlot === slot) setPowerState(slot + 'Power', 'deployed', 'Deployed');
    else setPowerState(slot + 'Power', 'idle', 'Idle');
  }
}
let remoteOp = null;
let manualDeployActive = null;
let manualOpShown = null;
// The Websites list has no open site, so the 3s detail poller below stays
// idle there. Poll visible cards on a slower cadence instead, or a background
// create-build looks stuck at "checking…/busy…" for its whole run.