const assert = require('assert');
const fs = require('fs');
const path = require('path');
// The rules live beside the doctor route: extract the const
// (pure data + message functions, no server deps) and test it directly.
const source = fs.readFileSync(path.join(__dirname, '../routes/doctor.js'), 'utf8').replace(/\r\n/g, '\n');
const start = source.indexOf('const LOG_RULES = [');
const end = source.indexOf('];', start);
assert(start > 0 && end > start, 'LOG_RULES block found');
const LOG_RULES = eval(source.slice(start, end + 2) + '\nLOG_RULES');
const hit = text => {
  const out = [];
  for (const rule of LOG_RULES) {
    if (rule.count) continue;
    const m = String(text).match(rule.re);
    if (m) out.push({ level: rule.level, msg: rule.msg(m) });
  }
  return out;
};
const apiCrash = `file:///app/src/server.mjs:19
if(!process.env.APP_ORIGIN)throw new Error('APP_ORIGIN is required');
Error: APP_ORIGIN is required`;
let hits = hit(apiCrash);
assert(hits.some(h => h.level === 'fail' && h.msg.includes('APP_ORIGIN') && h.msg.includes('Environment')), 'required-env crash names the variable and the fix');
// credential values and sentences must never match the required-env rule
assert(!hit('Error: password is required').some(h => h.msg.includes('container needs env')), 'lowercase sentences do not match');
assert(!hit('token=abc123 is required ok').some(h => h.msg.includes('container needs env')), 'adjacent values do not match');
assert(hit('Error: DATABASE_URL is required').some(h => h.msg.includes('DATABASE_URL')), 'other required vars match');
// DNS rule covers retryable lookup failures too (api backend absent)
hits = hit('Error: getaddrinfo EAI_AGAIN api');
assert(hits.some(h => h.level === 'fail' && h.msg.includes('"api"')), 'EAI_AGAIN names the hostname');
hits = hit('Error: getaddrinfo ENOTFOUND db');
assert(hits.some(h => h.level === 'fail' && h.msg.includes('"db"')), 'ENOTFOUND still matches with the shifted group');
// unrelated logs stay quiet
assert.deepEqual(hit('Server listening on port 3000\nReady in 42ms'), []);
console.log('Doctor log rules: required-env naming, credential safety, DNS coverage: OK');
