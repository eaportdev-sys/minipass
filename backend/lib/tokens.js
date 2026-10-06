const crypto = require('crypto');

const FORMATS = ['base64url', 'hex', 'base64', 'uuid'];

function mintToken(format = 'base64url', bytes = 32) {
  if (!FORMATS.includes(format)) throw new Error('unsupported token format');
  if (format === 'uuid') return crypto.randomUUID();
  const n = Math.min(128, Math.max(16, parseInt(bytes, 10) || 32));
  const buf = crypto.randomBytes(n);
  if (format === 'hex') return buf.toString('hex');
  if (format === 'base64') return buf.toString('base64');
  return buf.toString('base64url');
}

module.exports = { FORMATS, mintToken };
