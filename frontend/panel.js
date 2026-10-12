async function version() {
  try {
    const v = await (await fetch('/api/panel/version')).json();
    renderPanelVersion(v);
    // landed mid-restart (manual refresh) -> resume watching instead of sitting stale
    if (v.restarting && !restartTimer) watchRestart(300000);
  } catch {
    const status = document.getElementById('ver');
    status.className = 'panel-state is-failed';
    status.textContent = 'unreachable';
    document.getElementById('upgradeState').textContent = 'Could not read panel version information.';
  }
}
function renderPanelVersion(v, secondsLeft = null) {
  document.getElementById('verRunning').textContent = v.running || 'unknown';
  document.getElementById('verRepo').textContent = v.repo || 'unknown';
  const status = document.getElementById('ver');
  const state = document.getElementById('upgradeState');
  const countdown = document.getElementById('upgradeCountdown');
  const button = document.getElementById('upgradeBtn');
  if (!v.upgradeable) {
    status.className = 'panel-state is-failed';
    status.textContent = 'upgrade unavailable';
    state.textContent = 'Repository is not mounted. Add the /repo volume before using self-upgrade.';
  } else if (v.restarting) {
    status.className = 'panel-state is-busy';
    status.textContent = 'restart pending';
    state.textContent = 'The current panel remains online while the host applies the newly built image.';
  } else if (v.running === 'dev') {
    status.className = 'panel-state is-checking';
    status.textContent = 'development';
    state.textContent = 'Development build is running. You can still sync and rebuild from Git.';
  } else {
    status.className = 'panel-state is-ok';
    status.textContent = 'up to date';
    state.textContent = 'The running image matches the checked-out repository version.';
  }
  button.disabled = !v.upgradeable || !!v.restarting;
  countdown.textContent = secondsLeft == null ? '' : `${secondsLeft}s left`;
}
async function upgrade() {
  document.getElementById('upgradeBtn').disabled = true;
  document.getElementById('upgradeState').textContent = 'Fetching origin/main and starting a background image build…';
  document.getElementById('upOut').textContent = 'Waiting for build output…';
  try {
    const r = await (await fetch('/api/panel/upgrade', { method: 'POST' })).json();
    if (r.error) {
      document.getElementById('upgradeState').textContent = r.error;
      document.getElementById('upOut').textContent = 'Upgrade did not start.';
      document.getElementById('upgradeBtn').disabled = false;
      return;
    }
    document.getElementById('upgradeState').textContent = `Building target ${r.target || 'from origin/main'}; the running panel stays online.`;
    if (r.restarting || r.building) watchRestart(300000);
  } catch (e) {
    document.getElementById('upgradeState').textContent = 'Upgrade failed to start.';
    document.getElementById('upOut').textContent = e.message;
    document.getElementById('upgradeBtn').disabled = false;
  }
}
let restartTimer = null;
async function watchRestart(deadlineMs) {
  if (restartTimer) clearInterval(restartTimer);
  const out = document.getElementById('upOut');
  const end = Date.now() + (deadlineMs || 180000);
  restartTimer = setInterval(async () => {
    const left = Math.max(0, Math.ceil((end - Date.now()) / 1000));
    try {
      const v = await (await fetch('/api/panel/version')).json();
      renderPanelVersion(v, left);
      if (!v.restarting) { clearInterval(restartTimer); restartTimer = null; location.reload(); return; }
      let log = '';
      try { log = await (await fetch('/api/panel/upgrade-log')).text(); } catch {}
      out.textContent = log || 'Waiting for build output…';
      out.scrollTop = out.scrollHeight;
      if (/BUILD FAILED/i.test(log)) {
        const status = document.getElementById('ver');
        status.className = 'panel-state is-failed';
        status.textContent = 'build failed';
        document.getElementById('upgradeState').textContent = 'Image build failed. The currently running panel was left untouched.';
      } else if (/build ok - restart flagged/i.test(log)) {
        document.getElementById('upgradeState').textContent = 'Build complete. Waiting for the host restart job to activate the new image.';
      }
    } catch (e) {
      const status = document.getElementById('ver');
      status.className = 'panel-state is-busy';
      status.textContent = 'reconnecting';
      document.getElementById('upgradeState').textContent = 'Panel is restarting. Reconnecting automatically…';
      document.getElementById('upgradeCountdown').textContent = `${left}s left`;
    }
    if (left <= 0) {
      clearInterval(restartTimer); restartTimer = null;
      document.getElementById('upgradeCountdown').textContent = 'timed out';
      document.getElementById('upgradeState').textContent = 'Automatic reconnect timed out. Refresh the page manually.';
    }
  }, 3000);
}
async function scan() {
  const out = document.getElementById('maintOut');
  out.textContent = 'Scanning /srv/apps…';
  const r = await (await fetch('/api/panel/scan', { method: 'POST' })).json();
  out.textContent = r.error ? r.error : `${r.found && r.found.length ? r.found.join('\n') : 'No orphaned sites found.'}\n${r.total != null ? `Total sites: ${r.total}` : ''}`.trim();
  refresh();
}
async function showKey() {
  document.getElementById('keyOut').textContent = 'Loading panel key…';
  const r = await (await fetch('/api/panel/pubkey')).json();
  document.getElementById('keyOut').textContent =
    (r.pubkey || r.error) + '\n\nOnly needed for SSH remotes (git@github.com:…) — skip this if your sites pull over HTTPS + token.';
}