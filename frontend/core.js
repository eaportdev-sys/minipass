let currentApp = null;
let serviceCheckTimer = null;
let serviceCheckSeq = 0;
let appsRefreshSeq = 0;
let deployStatusSeq = 0;
// Global 401 tripwire: any data call that comes back unauthorized drops to the
// login view. Login/setup endpoints are excluded so wrong passwords just show
// their own error instead of looping.
const _fetch = window.fetch.bind(window);
window.fetch = (...a) => _fetch(...a).then(r => {
  if (r.status === 401 && !/^\/api\/panel\/(?:login|setup|auth-status|terms-text)(?:$|\?)/.test(String(a[0] || ''))) showLogin();
  return r;
});
const dbPopupSlots = new Map();
let websiteApps = [];
let trashApps = [];
// Sites with a delete request in flight: the card stays gone even when a list
// refresh or status poll lands before the server finishes compose down.
let deletingSiteIds = new Set();
// Trash rows being destroyed: same treatment - slow cleanups must not
// flicker back when trash is reloaded mid-operation.
let deletingTrashIds = new Set();
function siteName(site) { return (site && (site.name || site.id)) || ''; }
function siteById(id) { return websiteApps.find(a => a.id === id) || trashApps.find(a => a.id === id) || { id }; }
let websiteVisibleApps = [];
let websitePage = 1;
let websiteRenderSeq = 0;
const websiteStates = new Map();
const websiteStateSeq = new Map();
let websiteStatusActive = 0;
const websiteStatusWaiters = [];
