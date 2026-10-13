async function refresh() {
  const seq = ++appsRefreshSeq;
  const apps = await (await fetch('/api/apps')).json();
  if (seq !== appsRefreshSeq || !Array.isArray(apps)) return apps;
  websiteApps = apps;
  const ids = new Set(apps.map(a => a.id));
  for (const id of websiteStates.keys()) if (!ids.has(id)) { websiteStates.delete(id); websiteStateSeq.delete(id); }
  renderWebsites();
  // keep detail header + global terminal picker in sync
  if (currentApp && !apps.some(a => a.id === currentApp)) backToSites(false);
  else if (currentApp) fillSiteHeader(apps.find(a => a.id === currentApp));
  const tsel = document.getElementById('termApp');
  if (tsel) {
    const prev = tsel.value;
    tsel.innerHTML = apps.map(a => `<option value="${a.id}">${safeHtml(siteName(a))} (${a.id})</option>`).join('');
    if (apps.some(a => a.id === prev)) tsel.value = prev;
  }
  return apps;
}
function appCardMarkup(a) {
  const services = appPublishedServices(a);
  const facts = [a.domain, dbLabel(a) !== 'none' ? 'DB: ' + dbLabel(a) : '', services.length > 1 ? services.length + ' services' : ''].filter(Boolean).join(' · ');
  return `<div class="website-row" id="card-${a.id}" role="row">` +
    `<div class="website-name" role="cell"><button class="website-name-link" onclick="openSite('${a.id}')">${safeHtml(siteName(a))}</button>${a.dirty ? '<span class="website-pending" title="Saved changes — redeploy to apply" aria-label="Changes pending">●</span>' : ''}<div class="website-facts" title="${safeHtml(facts)}">${safeHtml(facts || 'No managed database')}</div>${a.name && a.name !== a.id ? `<div class="website-facts" title="Internal site ID">${safeHtml(a.id)}</div>` : ''}</div>` +
    `<div class="website-runtime" role="cell"><span class="badge type">${safeHtml(a.type === 'node' ? 'Node.js' : a.type === 'php' ? 'PHP' : a.type === 'react' ? 'React' : a.type === 'static' ? 'Static' : a.type)}</span></div>` +
    `<div role="cell"><span id="appState-${a.id}" class="website-state is-checking">Checking</span></div>` +
    `<div class="website-urls" role="cell">${appLinksMarkup(a, services)}</div>` +
    `<div class="website-actions" role="cell"><button id="appPower-${a.id}" class="power-control website-power is-checking" onclick="deploy('${a.id}')" title="Checking deployment state" aria-label="Checking ${safeHtml(a.id)}" disabled><span class="power-symbol">⏻</span></button><span id="appLifecycle-${a.id}"><button disabled>…</button></span><details class="website-menu"><summary aria-label="More actions for ${safeHtml(a.id)}">⋯</summary><div><button onclick="openSite('${a.id}')">Manage site</button><button class="btn danger" onclick="rmApp('${a.id}')">Move to Trash</button></div></details></div></div>`;
}
function websitePageData(apps, { search = '', type = '', sort = 'name', page = 1, size = 10 } = {}) {
  const words = search.toLowerCase().trim().split(/\s+/).filter(Boolean);
  const filtered = apps.filter(a => {
    const text = [a.id, a.name, a.domain, a.repoUrl, a.github && a.github.repo, a.type, dbLabel(a), ...appPublishedServices(a).map(s => s.name)].filter(Boolean).join(' ').toLowerCase();
    return (!type || a.type === type) && words.every(word => text.includes(word));
  }).sort((a, b) => (sort === 'type' ? String(a.type).localeCompare(String(b.type)) : 0) || (siteName(a).localeCompare(siteName(b)) || a.id.localeCompare(b.id)) * (sort === 'name-desc' ? -1 : 1));
  size = [10, 25, 50].includes(Number(size)) ? Number(size) : 10;
  const pages = Math.max(1, Math.ceil(filtered.length / size));
  page = Math.max(1, Math.min(pages, Number(page) || 1));
  const start = (page - 1) * size;
  return { apps: filtered.slice(start, start + size), total: filtered.length, page, pages, start };
}
function filterWebsites() { websitePage = 1; renderWebsites(); }
function changeWebsitePage(delta) { websitePage += delta; renderWebsites(); }
function renderWebsites() {
  const seq = ++websiteRenderSeq;
  const data = websitePageData(websiteApps, {
    search: document.getElementById('websiteSearch').value,
    type: document.getElementById('websiteType').value,
    sort: document.getElementById('websiteSort').value,
    size: document.getElementById('websitePageSize').value,
    page: websitePage
  });
  websitePage = data.page;
  websiteVisibleApps = data.apps;
  document.getElementById('websiteCount').textContent = `${websiteApps.length} site${websiteApps.length === 1 ? '' : 's'}`;
  document.getElementById('apps').innerHTML = !websiteApps.length
    ? '<div class="websites-empty"><b>No websites yet</b><span>Create your first site to get started.</span><button class="btn primary" onclick="openCreate()">+ Create website</button></div>'
    : !data.total ? '<div class="websites-empty"><b>No matching sites</b><span>Try another search or runtime.</span></div>'
      : '<div role="table" aria-label="Websites"><div class="website-columns" role="row"><span role="columnheader">Website</span><span role="columnheader">Runtime</span><span role="columnheader">Status</span><span role="columnheader">Published URLs</span><span role="columnheader">Actions</span></div>' + data.apps.map(appCardMarkup).join('') + '</div>';
  document.getElementById('websitePagination').style.display = websiteApps.length ? 'flex' : 'none';
  document.getElementById('websiteRange').textContent = data.total ? `${data.start + 1}–${data.start + data.apps.length} of ${data.total}${data.total !== websiteApps.length ? ' matches' : ' sites'}` : '0 matches';
  document.getElementById('websitePage').textContent = `${data.page} / ${data.pages}`;
  document.getElementById('websitePrev').disabled = data.page <= 1;
  document.getElementById('websiteNext').disabled = data.page >= data.pages;
  for (const a of data.apps) {
    const cached = websiteStates.get(a.id);
    if (cached) setAppCardState(a.id, cached.state, cached.running);
  }
  if (document.getElementById('view-websites').classList.contains('active') && !document.hidden) hydrateAppCards(data.apps, appsRefreshSeq, seq);
}
function appPublishedServices(a) {
  const list = Array.isArray(a.services) && a.services.length
    ? a.services
    : [{ name: 'app', type: a.type, hostPort: a.hostPort, enabled: true }];
  return list.filter(s => s.enabled !== false && s.hostPort);
}
function appLinksMarkup(a, services) {
  if (!services.length) return '<span class="website-facts">Not published</span>';
  return services.map(s => {
    const path = s.homePath != null ? s.homePath : (s.name === 'app' ? (a.homePath || '') : '');
    const url = publishedServiceUrl(a, { ...s, homePath: path });
    return `<a class="website-url" href="${safeHtml(url)}" title="${safeHtml((s.name || 'app') + ': ' + url)}" target="_blank" rel="noopener noreferrer">${services.length > 1 ? '<span>' + safeHtml(s.name) + '</span>' : ''}<span>${safeHtml(url.replace(/^http:\/\//, ''))}</span><span aria-hidden="true">↗</span></a>`;
  }).join('');
}
function setAppCardState(id, state, running, canStart = true) {
  websiteStates.set(id, { state, running, canStart });
  websiteStateSeq.set(id, (websiteStateSeq.get(id) || 0) + 1);
  const power = document.getElementById('appPower-' + id);
  const lifecycle = document.getElementById('appLifecycle-' + id);
  if (!power || !lifecycle) return;
  const label = state === 'deploying' ? 'Deploying' : state === 'checking' ? 'Checking' : running ? 'Redeploy' : !canStart ? 'Deploy' : state === 'failed' ? 'Retry' : 'Deploy';
  setPowerState('appPower-' + id, state, label);
  power.disabled = state === 'deploying' || state === 'checking';
  power.title = state === 'deploying' ? 'Deployment in progress' : running ? 'Rebuild and redeploy this site' : 'Build and deploy this site';
  power.setAttribute('aria-label', label + ' ' + id);
  const status = document.getElementById('appState-' + id);
  if (status) { status.className = 'website-state is-' + state; status.textContent = state === 'deploying' ? 'Deploying' : state === 'checking' ? 'Checking' : state === 'failed' ? 'Unavailable' : running ? 'Running' : 'Off'; }
  lifecycle.innerHTML = state === 'deploying' || state === 'checking'
    ? '<button disabled>…</button>'
    : running ? `<button onclick="stopApp('${id}')" aria-label="Stop ${safeHtml(id)}">Stop</button>`
      : canStart ? `<button onclick="startApp('${id}')" aria-label="Start ${safeHtml(id)}">Start</button>`
        : `<button onclick="deploy('${id}')" aria-label="Deploy ${safeHtml(id)}">Deploy</button>`;
}
function publishedServiceUrl(a, s) {
  const publicUrl = a.accessMode==='local'?a.localUrl:a.publicUrl || (a.executor === 'repository-compose' && a.domain ? `https://${a.domain}` : null);
  if (publicUrl && (s.primary || s.hostPort === a.hostPort)) {
    const origin = (publicUrl.match(/^https?:\/\/[^/]+/) || [publicUrl])[0];
    return s.homePath ? origin + (s.homePath.startsWith('/') ? s.homePath : '/' + s.homePath) : publicUrl;
  }
  return `${s.scheme || 'http'}://${location.hostname}:${s.hostPort}${s.homePath || ''}`;
}
async function websiteStatusRequest(id, current) {
  if (websiteStatusActive < 4) websiteStatusActive++;
  else await new Promise(resolve => websiteStatusWaiters.push(resolve));
  try {
    if (!current()) return null;
    return await (await fetch(`/api/apps/${encodeURIComponent(id)}/status`)).json();
  } finally {
    const next = websiteStatusWaiters.shift();
    if (next) next(); else websiteStatusActive--;
  }
}
async function hydrateAppCards(apps, seq, renderSeq = websiteRenderSeq) {
  let index = 0;
  const current = () => seq === appsRefreshSeq && renderSeq === websiteRenderSeq && document.getElementById('view-websites').classList.contains('active');
  // Only the visible page is probed; cap simultaneous Docker status lookups.
  await Promise.all(Array.from({ length: Math.min(4, apps.length) }, async () => {
    while (index < apps.length && current()) {
      const a = apps[index++];
      const version = websiteStateSeq.get(a.id) || 0;
      try {
        const st = await websiteStatusRequest(a.id, current);
        if (!current() || version !== (websiteStateSeq.get(a.id) || 0)) continue;
        if (!st || st.error) throw new Error('status unavailable');
        const running = appIsRunning(st);
        const canStart = appCanStart(st);
        const crashed = !st.deploying && appCrashed(st);
        setAppCardState(a.id, st.deploying ? 'deploying' : (crashed ? 'failed' : (running ? 'deployed' : 'off')), running, canStart);
      } catch {
        if (current() && version === (websiteStateSeq.get(a.id) || 0)) setAppCardState(a.id, 'failed', false);
      }
    }
  }));
}
