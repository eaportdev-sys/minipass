// Stream builder stdout AND stderr into the current attempt's host-persisted
// log. Keep only bounded evidence in memory, including compiler errors printed
// to stdout before a package manager's short stderr/ELIFECYCLE footer.
const fs = require('fs');
const { spawn } = require('child_process');
const { StringDecoder } = require('string_decoder');
const { redact } = require('./panel-log');
const MAX_TAIL = 64 * 1024;
const CAUSE = /error TS\d+|npm (?:ERR!|error)(?! (?:A complete log|For a full report))|ERR_(?:PNPM|YARN)_|Module not found|Cannot find module|(?:Syntax|Type|Reference)Error:|\bError:|ERROR in/i;
function cleanLine(line) {
  return redact(line.replace(/\x1b\[[0-9;]*m/g, '').replace(/^\s*(?:#\d+\s+)?\d+\.\d+\s+/, '').trim());
}
function failureSummary(text) {
  const lines = String(text || '').split(/\r?\n/).map(cleanLine).filter(Boolean);
  const causes = lines.filter(line => CAUSE.test(line));
  return [...new Set(causes.length ? causes : lines.slice(-12))].slice(0, 8)
    .map(line => line.slice(0, 500)).join('\n').slice(0, 1600);
}
function runLogged(bin, args, { cwd, env = process.env, logFile } = {}) {
  return new Promise((resolve, reject) => {
    let fd;
    let child;
    let settled = false;
    let logError = null;
    let tail = '';
    const causes = [];
    const channels = [0, 1].map(() => ({ decoder: new StringDecoder('utf8'), pending: '' }));
    const finish = error => {
      if (settled) return;
      settled = true;
      try { if (fd != null) fs.closeSync(fd); } catch (e) { error = error || e; }
      if (error) reject(error); else resolve();
    };
    const write = text => {
      const safe = redact(text);
      fs.writeFileSync(fd, safe);
      tail = (tail + safe).slice(-MAX_TAIL);
      for (const line of safe.split(/\r?\n/)) {
        const clean = cleanLine(line);
        if (causes.length < 20 && CAUSE.test(clean) && !causes.includes(clean)) causes.push(clean.slice(0, 500));
      }
    };
    const receive = (channel, data, end = false) => {
      if (settled || logError) return;
      try {
        channel.pending += end ? channel.decoder.end() : channel.decoder.write(data);
        const split = end ? channel.pending.length : channel.pending.lastIndexOf('\n') + 1;
        if (split) { write(channel.pending.slice(0, split)); channel.pending = channel.pending.slice(split); }
        // A script can emit an unbounded line without newlines. Bound its carry
        // too, while still writing all output to disk.
        if (channel.pending.length > MAX_TAIL) { write(channel.pending); channel.pending = ''; }
      } catch (e) { logError = e; try { child.kill(); } catch {} }
    };
    try {
      fd = fs.openSync(logFile, 'a');
      child = spawn(bin, args, { cwd, env });
      child.stdout.on('data', data => receive(channels[0], data));
      child.stderr.on('data', data => receive(channels[1], data));
      child.on('error', finish);
      child.on('close', code => {
        if (settled) return;
        for (const channel of channels) receive(channel, null, true);
        if (logError) return finish(logError);
        if (code === 0) return finish();
        const detail = failureSummary(causes.length ? causes.join('\n') : tail);
        finish(new Error(`${bin} exited with code ${code}${detail ? ': ' + detail : ''}`));
      });
    } catch (e) { finish(e); }
  });
}
module.exports = { runLogged, failureSummary };
