let auditSeq = 0;
let auditOffset = 0;
let auditTotal = 0;
function auditTable(columns, rows) {
  if (!rows.length) return '<div class="meta">No matching records.</div>';
  const h = safeHtml;
  return `<div class="audit-table-wrap"><table class="audit-table"><thead><tr>${columns.map(c => `<th>${h(c)}</th>`).join('')}</tr></thead><tbody>${rows.map(row => `<tr>${columns.map(c => `<td>${h(row[c] == null ? '' : typeof row[c] === 'object' ? JSON.stringify(row[c]) : String(row[c]))}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
}
async function loadAudit(reset = false) {
  if (reset) auditOffset = 0;
  const seq = ++auditSeq;
  const params = new URLSearchParams({ offset: String(auditOffset), limit: '50' });
  for (const key of ['actor','action','site','from','to']) {
    const value = document.getElementById('audit-' + key).value.trim();
    if (value) params.set(key, ['from','to'].includes(key) ? new Date(value).toISOString() : value);
  }
  const box = document.getElementById('auditHistory');
  try {
    const response = await fetch('/api/panel/audit?' + params);
    const data = await response.json();
    if (seq !== auditSeq) return;
    if (!response.ok) throw new Error(data.error || 'Audit history unavailable');
    auditTotal = data.total;
    box.innerHTML = auditTable(['occurred_at','actor_username','action','site_name','site_id','outcome','ip_address','details'], data.rows);
    document.getElementById('auditRange').textContent = `${data.offset + (data.rows.length ? 1 : 0)}–${data.offset + data.rows.length} of ${data.total}`;
    document.getElementById('auditPrev').disabled = auditOffset === 0;
    document.getElementById('auditNext').disabled = auditOffset + 50 >= auditTotal;
    loadOperators();
  } catch (e) { if (seq === auditSeq) box.textContent = e.message; }
}
function auditPage(direction) { auditOffset = Math.max(0, auditOffset + direction * 50); loadAudit(); }
function auditExample(which) {
  document.getElementById('auditSql').value = which === 'sites'
    ? 'SELECT id, name, state, deleted_at, deleted_by, destroyed_at FROM panel_sites ORDER BY updated_at DESC'
    : "SELECT occurred_at, actor_username, action, site_name, outcome FROM audit_events WHERE action IN ('site.deleted', 'site.restored', 'site.destroyed') ORDER BY id DESC";
}
async function runAuditQuery() {
  const button = document.getElementById('auditQueryBtn'), box = document.getElementById('auditQueryResult');
  button.disabled = true; box.textContent = 'Querying…';
  try {
    const response = await fetch('/api/panel/audit/query', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sql: document.getElementById('auditSql').value }) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Query failed');
    box.innerHTML = `<div class="meta">${data.rows.length} rows · ${data.durationMs} ms${data.truncated ? ' · showing the first 200 rows' : ''}</div>` + auditTable(data.columns, data.rows);
  } catch (e) { box.textContent = e.message; }
  finally { button.disabled = false; }
}
async function loadOperators() {
  const card = document.getElementById('operatorCard');
  card.style.display = panelUser?.role === 'admin' ? '' : 'none';
  if (panelUser?.role !== 'admin') return;
  try {
    const response = await fetch('/api/panel/operators'), rows = await response.json();
    if (!response.ok) throw new Error(rows.error);
    document.getElementById('operatorList').innerHTML = rows.map(user => `<div class="operator-row"><span><b>${safeHtml(user.username)}</b> · ${safeHtml(user.role)} · ${user.disabled ? 'disabled' : 'enabled'}</span><button onclick="setOperatorDisabled('${safeHtml(user.id)}',${!user.disabled})">${user.disabled ? 'Enable' : 'Disable'}</button></div>`).join('');
  } catch (e) { document.getElementById('operatorList').textContent = e.message; }
}
async function createOperator() {
  const password = document.getElementById('operatorPassword');
  try {
    const response = await fetch('/api/panel/operators', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: document.getElementById('operatorUsername').value.trim(), password: password.value, role: document.getElementById('operatorRole').value }) });
    const data = await response.json(); password.value = '';
    if (!response.ok) throw new Error(data.error);
    document.getElementById('operatorUsername').value = ''; toast('Operator account created'); loadOperators(); loadAudit(true);
  } catch (e) { password.value = ''; toast(e.message, false); }
}
async function setOperatorDisabled(id, disabled) {
  if (!await uiConfirm({ title: disabled ? 'Disable operator?' : 'Enable operator?', body: disabled ? 'Their active sessions will be revoked. Historical audit records are kept.' : 'Allow this operator to sign in again.', confirmLabel: disabled ? 'Disable' : 'Enable', danger: disabled })) return;
  try {
    const response = await fetch('/api/panel/operators/' + encodeURIComponent(id), { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ disabled }) });
    const data = await response.json(); if (!response.ok) throw new Error(data.error); loadOperators(); loadAudit(true);
  } catch (e) { toast(e.message, false); }
}
