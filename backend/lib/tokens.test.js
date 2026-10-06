const assert = require('assert');
const { FORMATS, mintToken } = require('./tokens');

assert.deepEqual([...FORMATS].sort(), ['base64', 'base64url', 'hex', 'uuid']);
const url = mintToken('base64url', 32);
assert(/^[A-Za-z0-9_-]{40,}$/.test(url), 'base64url shape');
assert.equal(mintToken('hex', 16).length, 32);
assert(mintToken('base64', 16).includes('=') || /^[A-Za-z0-9+/]+={0,2}$/.test(mintToken('base64', 16)));
assert(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(mintToken('uuid')), 'uuid v4 shape');
assert.notEqual(mintToken('hex', 32), mintToken('hex', 32), 'random each call');
assert.equal(mintToken('hex', 1).length, 32, 'clamps tiny sizes up');
assert.equal(mintToken('hex', 999).length, 256, 'clamps huge sizes down');
assert.throws(() => mintToken('password'), /unsupported/);
console.log('one-shot secret generator: OK');
