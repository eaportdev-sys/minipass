let fileTreeApp = null;
let fileTreeNodes = new Map();
let selectedFile = '';
let lastOpen = null;
function joinFilePath(dir, name) { return dir ? `${dir}/${name}` : name; }
async function loadFileDir(dir, force) {
  if (!currentApp) return;
  const appId = currentApp;
  let node = fileTreeNodes.get(dir);
  if (!node) { node = { open: dir === '', items: null, loading: false, error: '' }; fileTreeNodes.set(dir, node); }
  if (!force && node.items) return;
  node.loading = true;
  node.error = '';
  renderFileTree();
  try {
    const files = await (await fetch(`/api/apps/${appId}/files?path=${encodeURIComponent(dir)}`)).json();
    if (appId !== currentApp || fileTreeApp !== appId) return;
    if (files.error) { node.error = files.error; node.items = []; }
    else node.items = files;
  } catch (e) {
    if (appId === currentApp && fileTreeApp === appId) { node.error = e.message; node.items = []; }
  }
  node.loading = false;
  renderFileTree();
}
function renderFileTreeDir(dir, depth) {
  const node = fileTreeNodes.get(dir);
  if (!node) return '';
  if (node.loading && !node.items) return `<div class="file-tree-note" style="padding-left:${10 + depth * 16}px">loading…</div>`;
  if (node.error) return `<div class="file-tree-note error" style="padding-left:${10 + depth * 16}px">${safeHtml(node.error)}</div>`;
  if (!node.items || !node.items.length) return `<div class="file-tree-note" style="padding-left:${10 + depth * 16}px">(empty)</div>`;
  return node.items.map(item => {
    const full = joinFilePath(dir, item.name);
    const encoded = safeHtml(full);
    if (item.dir) {
      const child = fileTreeNodes.get(full);
      const open = !!(child && child.open);
      return `<div class="file-tree-branch"><button class="file-tree-row folder" style="padding-left:${8 + depth * 16}px" data-path="${encoded}" onclick="toggleFileDir(this.dataset.path)" aria-expanded="${open}">` +
        `<span class="tree-chevron">${open ? '▾' : '▸'}</span><span class="tree-icon">▰</span><span>${safeHtml(item.name)}</span></button>` +
        (open ? `<div>${renderFileTreeDir(full, depth + 1)}</div>` : '') + `</div>`;
    }
    return `<button class="file-tree-row file${selectedFile === full ? ' active' : ''}" style="padding-left:${8 + depth * 16}px" data-path="${encoded}" onclick="openFile(this.dataset.path)">` +
      `<span class="tree-chevron"></span><span class="tree-icon">▪</span><span>${safeHtml(item.name)}</span></button>`;
  }).join('');
}
function renderFileTree() {
  const box = document.getElementById('fileList');
  if (box) box.innerHTML = renderFileTreeDir('', 0) || '<div class="file-tree-note">(empty)</div>';
}
async function listFiles(dir = '') {
  if (!currentApp) return;
  if (fileTreeApp !== currentApp) {
    fileTreeApp = currentApp;
    fileTreeNodes = new Map([['', { open: true, items: null, loading: false, error: '' }]]);
    selectedFile = '';
    lastOpen = null;
    document.getElementById('filePath').value = '';
    document.getElementById('fileEdit').value = '';
  }
  const path = dir || '';
  let node = fileTreeNodes.get(path);
  if (!node) { node = { open: true, items: null, loading: false, error: '' }; fileTreeNodes.set(path, node); }
  node.open = true;
  await loadFileDir(path, path === '');
}
async function toggleFileDir(dir) {
  let node = fileTreeNodes.get(dir);
  if (!node) { node = { open: false, items: null, loading: false, error: '' }; fileTreeNodes.set(dir, node); }
  node.open = !node.open;
  renderFileTree();
  if (node.open && !node.items) await loadFileDir(dir, false);
}
async function refreshFileTree() {
  if (!currentApp) return;
  if (fileTreeApp !== currentApp) return listFiles('');
  const loaded = [...fileTreeNodes.entries()].filter(([, node]) => node.items).map(([dir]) => dir);
  if (!loaded.includes('')) loaded.unshift('');
  await Promise.all(loaded.map(dir => loadFileDir(dir, true)));
}
async function openFile(p) {
  const id = currentApp;
  const fp = p || document.getElementById('filePath').value.trim() || 'index.html';
  if (!id) { document.getElementById('fileEdit').value = 'no app selected'; return; }
  selectedFile = fp;
  lastOpen = { path: fp, ok: false };
  document.getElementById('filePath').value = fp;
  document.getElementById('fileOut').textContent = 'opening ' + fp + '…';
  renderFileTree();
  try {
    const r = await (await fetch(`/api/apps/${id}/file?path=${encodeURIComponent(fp)}`)).json();
    if (currentApp !== id) return;
    if (r.error) { document.getElementById('fileEdit').value = ''; document.getElementById('fileOut').textContent = r.error; return; }
    document.getElementById('fileEdit').value = r.content || '';
    document.getElementById('fileOut').textContent = `opened ${fp}`;
    lastOpen = { path: fp, ok: true };
  } catch (e) { if (currentApp === id) document.getElementById('fileEdit').value = 'open failed: ' + e.message; }
}
async function saveFile() {
  const id = currentApp;
  const filePath = document.getElementById('filePath').value.trim();
  if (!id || !filePath) { toast('enter a file path first', false); return; }
  // Never save over a file that failed to open (too large, binary, missing):
  // the editor is empty and saving would wipe the real content.
  if (lastOpen && lastOpen.path === filePath && !lastOpen.ok) {
    toast('that file did not open - refusing to save over it', false);
    return;
  }
  const body = { path: filePath, content: document.getElementById('fileEdit').value };
  document.getElementById('fileOut').textContent = 'saving… (redeploy to apply)';
  try {
    const r = await (await fetch(`/api/apps/${id}/file`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();
    document.getElementById('fileOut').textContent = JSON.stringify(r, null, 2);
    selectedFile = filePath;
    await refreshFileTree(); refresh(); loadServices();
  } catch (e) { document.getElementById('fileOut').textContent = 'save failed: ' + e.message; }
}
async function deleteFile() {
  const id = currentApp;
  const fp = document.getElementById('filePath').value;
  if (!id || !fp) return;
  const ok = await uiConfirm({
    title: 'Delete ' + fp + '?', body: 'From ' + id + '. This cannot be undone.',
    confirmLabel: 'Delete', danger: true
  });
  if (!ok) return;
  document.getElementById('fileOut').textContent = 'deleting… (redeploy to apply)';
  try {
    const r = await (await fetch(`/api/apps/${id}/file?path=${encodeURIComponent(fp)}`, { method: 'DELETE' })).json();
    document.getElementById('fileOut').textContent = JSON.stringify(r, null, 2);
    document.getElementById('filePath').value = ''; document.getElementById('fileEdit').value = '';
    selectedFile = '';
    lastOpen = null;
    await refreshFileTree(); refresh(); loadServices();
  } catch (e) { document.getElementById('fileOut').textContent = 'delete failed: ' + e.message; }
}
function upModeChange() {
  const mode = document.getElementById('upMode').value;
  const pick = document.getElementById('upPick');
  pick.value = '';
  pick.removeAttribute('multiple');
  pick.removeAttribute('webkitdirectory');
  pick.removeAttribute('accept');
  if (mode === 'zip') pick.setAttribute('accept', '.zip');
  if (mode === 'files') pick.setAttribute('multiple', '');
  if (mode === 'folder') pick.setAttribute('webkitdirectory', '');
}
async function uploadUnified() {
  const id = currentApp;
  const mode = document.getElementById('upMode').value;
  const input = document.getElementById('upPick');
  const files = [...input.files];
  const out = document.getElementById('fileOut');
  if (!id || !files.length) { out.textContent = 'open a website and pick something to upload'; return; }
  out.textContent = `uploading ${mode} (${files.length} file(s))… (redeploy after)`;
  try {
    let url, fd = new FormData();
    if (mode === 'zip') {
      url = `/api/apps/${id}/upload`;
      fd.append('zip', files[0]);
    } else {
      url = `/api/apps/${id}/upload-files`;
      for (const f of files) {
        const rel = mode === 'folder' ? (f.webkitRelativePath.split('/').slice(1).join('/') || f.name) : f.name;
        fd.append('files', f);
        fd.append('paths', rel);
      }
    }
    const r = await (await fetch(url, { method: 'POST', body: fd })).json();
    out.textContent = JSON.stringify(r, null, 2); refreshFileTree(); refresh(); loadServices();
  } catch (e) { out.textContent = 'upload failed: ' + e.message; }
  input.value = '';
}