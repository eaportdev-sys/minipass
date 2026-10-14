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
    if (!claimed.has(id) && !busy.has(id) && !fs.existsSync(path.join(appsDir, id)) && !fs.existsSync(path.join(appsDir, '.trash', id)) && !fs.existsSync(path.join(appsDir,'.drafts',id))) return id;
  }
  throw new Error('could not allocate a unique site id');
}
function readPending(dir,id) {
  const file=path.join(dir,'.pending-create.json');
  const stat=fs.lstatSync(dir),mark=fs.lstatSync(file);
  if(!stat.isDirectory()||stat.isSymbolicLink()||!mark.isFile()||mark.isSymbolicLink()||mark.size>4096)throw invalid('unsafe pending site checkout');
  const record=JSON.parse(fs.readFileSync(file,'utf8'));
  if(record.id!==id)throw invalid('pending checkout identity does not match');
  return {...record,directory:dir};
}
function draftDir(appsDir,id) {
  if (!newId(id)) throw invalid('invalid pending site id');
  const parent=path.join(appsDir,'.drafts');
  if(fs.existsSync(parent)){const stat=fs.lstatSync(parent);if(!stat.isDirectory()||stat.isSymbolicLink())throw invalid('unsafe source staging directory');}
  return path.join(parent,id);
}
function pending(appsDir, id) {
  const staged=draftDir(appsDir,id);
  const dir=fs.existsSync(staged)?staged:path.join(appsDir,id);
  try {
    return readPending(dir,id);
  } catch (e) {
    if (e.status) throw e;
    throw invalid('pending checkout is missing or unreadable - cancel and reopen creation');
  }
}
function sourceOnly(dir,id) {
  const record=readPending(dir,id);
  const allowed=new Set(['.pending-create.json','code','deploy-key','deploy-key.pub']);
  for(const entry of fs.readdirSync(dir)) {
    const stat=fs.lstatSync(path.join(dir,entry));
    if(!allowed.has(entry)||stat.isSymbolicLink()||(entry==='code'?!stat.isDirectory():!stat.isFile()))throw Object.assign(new Error('Draft contains deployment/data files; refusing to move or replace it automatically.'),{status:409});
  }
  return record;
}
function stage(appsDir,id) {
  const staged=draftDir(appsDir,id),active=path.join(appsDir,id);
  if(fs.existsSync(staged)){sourceOnly(staged,id);return staged;}
  fs.mkdirSync(path.dirname(staged),{recursive:true,mode:0o700});
  if(fs.existsSync(active)&&fs.existsSync(path.join(active,'.pending-create.json'))) {
    // Upgrade recovery for source-only previews made by older panels. Move the
    // draft, not its inode/project assignment; never adopt a real site/database.
    sourceOnly(active,id);fs.renameSync(active,staged);
  }
  return staged;
}
function copyDraft(appsDir,id) {
  const staged=draftDir(appsDir,id),active=path.join(appsDir,id);
  if(!fs.existsSync(staged))return false;
  sourceOnly(staged,id);
  if(fs.existsSync(active)) {
    const entries=fs.readdirSync(active);
    if(entries.some(name=>!['deploy-key','deploy-key.pub'].includes(name)))sourceOnly(active,id);
    else {
      if(fs.lstatSync(active).isSymbolicLink())throw invalid('unsafe site directory');
      for(const name of entries){const stat=fs.lstatSync(path.join(active,name));if(stat.isSymbolicLink()||!stat.isFile())throw invalid('unsafe pending deploy key');}
    }
  }
  fs.mkdirSync(active,{recursive:true});
  // COPY creates quota-inheriting inodes. Renaming an existing checkout into
  // the allocated directory would leave its old, uncharged project IDs intact.
  fs.copyFileSync(path.join(staged,'.pending-create.json'),path.join(active,'.pending-create.json'));
  for(const name of ['code','deploy-key','deploy-key.pub']) {
    const src=path.join(staged,name);if(fs.existsSync(src))fs.cpSync(src,path.join(active,name),{recursive:true,dereference:false});
  }
  return true;
}
function removeDraft(appsDir,id) {
  const dir=draftDir(appsDir,id);
  if(!fs.existsSync(dir))return false;
  sourceOnly(dir,id);fs.rmSync(dir,{recursive:true,force:true});return true;
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
module.exports = { displayName, allocate, newId, pending, draftDir,sourceOnly,stage,copyDraft,removeDraft,writeName, readName };
