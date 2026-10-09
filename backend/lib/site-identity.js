const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const invalid = message => Object.assign(new Error(message), { status: 400 });
const newId = id => typeof id === 'string' && /^site-[a-f0-9]{24}$/.test(id);
function displayName(value) {
  const name = String(value || '').trim();
  if (!name || name.length > 80 || /[\x00-\x1f\x7f\\/]/.test(name) || /:\/\//.test(name)) throw invalid('site name must be 1–80 characters, without paths or control characters; put the repository URL in Code source');
  return name;
}
function allocate(appsDir, metadata, busy = new Set(), random = () => crypto.randomBytes(12).toString('hex')) {
  const claimed = new Set([...(metadata.apps || []), ...(metadata.trash || [])].map(a => a.id));
  for (let i = 0; i < 20; i++) {
    const id = 'site-' + random();
    if (!newId(id)) throw new Error('invalid generated site id');
    if (!claimed.has(id) && !busy.has(id) && !fs.existsSync(path.join(appsDir, id)) && !fs.existsSync(path.join(appsDir, '.trash', id))) return id;
  }
  throw new Error('could not allocate a unique site id');
}
function pending(appsDir, id) {
  if (!newId(id)) throw invalid('invalid pending site id');
  const dir = path.join(appsDir, id), file = path.join(dir, '.pending-create.json');
  try {
    const stat = fs.lstatSync(dir), mark = fs.lstatSync(file);
    if (!stat.isDirectory() || stat.isSymbolicLink() || !mark.isFile() || mark.isSymbolicLink() || mark.size > 4096) throw invalid('unsafe pending site checkout');
    const record = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (record.id !== id) throw invalid('pending checkout identity does not match');
    return record;
  } catch (e) {
    if (e.status) throw e;
    throw invalid('pending checkout is missing or unreadable - cancel and reopen creation');
  }
}
function writeName(dir, id, name) {
  fs.writeFileSync(path.join(dir, '.site.json'), JSON.stringify({ id, name }), { mode: 0o600 });
}
function readName(dir, id) {
  try {
    const file = path.join(dir, '.site.json'), stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) return id;
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    return saved.id === id ? displayName(saved.name) : id;
  } catch { return id; }
}
module.exports = { displayName, allocate, newId, pending, writeName, readName };
