const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { TextDecoder } = require('util');

// No filename or depth cutoff. Inventory all source files; explicitly disclose
// exclusions and safety limits. Never follow symlinks or run repository code.
const GENERATED = new Set(['.git', 'node_modules', 'vendor', '.next', '.nuxt', '.venv', '__pycache__']);
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_TEXT_BYTES = 64 * 1024 * 1024;
function sourceFile(root, relative) {
  if (typeof relative !== 'string' || !relative || relative.includes('\\') || path.isAbsolute(relative)) return null;
  const parts = relative.split('/');
  if (parts.some(p => !p || p === '.' || p === '..')) return null;
  let file = path.resolve(root);
  try {
    for (const part of parts) {
      file = path.join(file, part);
      if (fs.lstatSync(file).isSymbolicLink()) return null;
    }
    return fs.lstatSync(file).isFile() ? file : null;
  } catch { return null; }
}
function readSource(file, maxBytes = MAX_FILE_BYTES) {
  const st = fs.lstatSync(file);
  if (!st.isFile() || st.isSymbolicLink()) return { reason: 'not a regular source file' };
  const fd = fs.openSync(file, 'r');
  const sample = Buffer.alloc(Math.min(8192, st.size));
  try { fs.readSync(fd, sample, 0, sample.length, 0); } finally { fs.closeSync(fd); }
  if (sample.length >= 2 && ((sample[0] === 0xff && sample[1] === 0xfe) || (sample[0] === 0xfe && sample[1] === 0xff))) return { reason: 'UTF-16 source requires encoding conversion before analysis', incomplete: true };
  if (sample.includes(0) || /^(?:%PDF-|GIF8|PK\x03\x04)/.test(sample.toString('latin1')) || sample.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return { reason: 'binary file' };
  if (st.size > maxBytes) return { reason: 'file exceeds text analysis size limit', incomplete: true };
  const buf = fs.readFileSync(file);
  if (buf.includes(0)) return { reason: 'binary file' };
  try { return { text: new TextDecoder('utf-8', { fatal: true }).decode(buf), bytes: buf.length }; }
  catch { return { reason: 'non-UTF-8 file', incomplete: true }; }
}
function inventory(root, options = {}) {
  const texts = new Map(), files = [], skipped = [], issues = [];
  const hash = crypto.createHash('sha256');
  const pending = [{ dir: root, rel: '' }];
  let bytes = 0;
  while (pending.length) {
    const { dir, rel } = pending.pop();
    let entries;
    try {
      if (fs.lstatSync(dir).isSymbolicLink()) throw new Error('symbolic link directory');
      entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    } catch { issues.push({ file: rel || '.', reason: 'directory could not be read safely' }); continue; }
    for (const entry of entries) {
      const name = rel ? `${rel}/${entry.name}` : entry.name;
      const file = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) { issues.push({ file: name, reason: 'symbolic link was not followed' }); continue; }
      if (entry.isDirectory()) {
        if (GENERATED.has(entry.name)) skipped.push({ file: name + '/', reason: 'generated dependencies, cache or Git internals' });
        else pending.push({ dir: file, rel: name });
        continue;
      }
      if (!entry.isFile()) { issues.push({ file: name, reason: 'special file was not read' }); continue; }
      files.push(name);
      try {
        const st = fs.lstatSync(file);
        hash.update(JSON.stringify([name, st.size, st.mtimeMs]));
        if (options.read === false) continue;
        const result = readSource(file, options.maxFileBytes || MAX_FILE_BYTES);
        if (result.text !== undefined) {
          if (bytes + result.bytes > (options.maxTextBytes || MAX_TEXT_BYTES)) {
            issues.push({ file: name, reason: 'total text analysis size limit reached' });
          } else {
            texts.set(name, result.text); bytes += result.bytes;
            hash.update(result.text);
          }
        } else (result.incomplete ? issues : skipped).push({ file: name, reason: result.reason });
      } catch { issues.push({ file: name, reason: 'file could not be read' }); }
    }
  }
  return { files: files.sort(), texts, skipped, issues, complete: issues.length === 0, bytes, fingerprint: hash.digest('hex') };
}
function isDockerfile(text) {
  // Content classifier, not a substitute for the engine's build validation.
  const lines = String(text).replace(/^\uFEFF/, '').split(/\r?\n/).filter(l => l.trim() && !/^\s*#/.test(l));
  if (!lines.length || !/^(?:ARG|FROM)\s+/i.test(lines[0].trim())) return false;
  return lines.some(l => /^\s*FROM\s+(?:--\S+\s+)*\S+/i.test(l));
}
module.exports = { inventory, sourceFile, readSource, isDockerfile, MAX_FILE_BYTES };
