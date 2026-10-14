const assert = require('assert');
const { optionalExternalFont, safeUrl } = require('./browser-runner');
const landing = 'http://site.example.test:8001/';
assert(optionalExternalFont('font', 'https://fonts.example.test/font.woff2', landing));
assert(optionalExternalFont('font', 'http://site.example.test:8900/font.woff2', landing), 'origin includes the port');
assert(!optionalExternalFont('font', landing + 'missing.woff2', landing), 'same-origin packaging failures remain fatal');
for (const kind of ['stylesheet', 'script', 'image', 'media', 'document', 'fetch', 'xhr']) {
  assert(!optionalExternalFont(kind, 'https://cdn.example.test/resource', landing), kind + ' remains fatal regardless of origin');
}
assert(!optionalExternalFont('font', 'invalid', landing));
assert(!optionalExternalFont('font', 'data:font/woff2;base64,AA==', landing));
assert.equal(safeUrl('https://user:secret@fonts.example.test/font.woff2?token=secret#private'), 'https://fonts.example.test/font.woff2');
console.log('Browser font policy: external fonts warn; same-origin assets, scripts/styles/APIs and invalid URLs retain failure checks: OK');
