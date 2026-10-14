let siteEventSeq = 0;
async function loadSiteEvents() {
  const box = document.getElementById('siteEvents');
  const id = currentApp, seq = ++siteEventSeq;
  if (!id) { box.textContent = 'Open a website first.'; return; }
  box.textContent = 'Loading site history…';
  try {
    const response = await fetch(`/api/apps/${encodeURIComponent(id)}/events?limit=100`);
    const data = await response.json();
    if (currentApp !== id || seq !== siteEventSeq) return;
    if (!response.ok) throw new Error(data.error || 'Site history unavailable');
    const events = data.events || [];
    box.innerHTML = events.length ? events.map(e => `<div class="site-event ${e.level === 'error' ? 'is-error' : e.level === 'warn' ? 'is-warning' : ''}"><div class="meta">${safeHtml(e.at)} · ${safeHtml(e.level)} · ${safeHtml(e.area)}</div><pre>${safeHtml(e.message)}</pre></div>`).join('') : '<div class="meta">No site events recorded yet.</div>';
  } catch (e) { if (currentApp === id && seq === siteEventSeq) box.textContent = e.message; }
}
async function copySiteEvents() {
  const text = document.getElementById('siteEvents').textContent;
  toast(await copyText(text) ? 'Site history copied' : 'Copy failed — select and copy manually');
}
