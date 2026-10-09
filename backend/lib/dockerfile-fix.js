// Build-environment adaptation for repository-owned Dockerfiles. Never touches
// application source: only the container build recipe (base image tag + build
// tools) changes, previewed and explicitly approved. Fixing the upstream repo
// is the last resort - the panel launches the site with a retained approval
// that is revalidated on every deploy instead.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const conflict = message => Object.assign(new Error(message), { status: 409 });
const MAX_BYTES = 64 * 1024;

function dockerfileName(ctxDir) {
  let files = [];
  try { files = fs.readdirSync(ctxDir); } catch { return null; }
  const hit = files.find(f => /^dockerfile$/i.test(f));
  if (!hit) return null;
  try { if (!fs.lstatSync(path.join(ctxDir, hit)).isFile() || fs.lstatSync(path.join(ctxDir, hit)).isSymbolicLink()) return null; } catch { return null; }
  return hit;
}
function readDockerfile(ctxDir) {
  const name = dockerfileName(ctxDir);
  if (!name) return null;
  try {
    const text = fs.readFileSync(path.join(ctxDir, name), 'utf8');
    if (Buffer.byteLength(text) > MAX_BYTES) return null;
    return { name, text };
  } catch { return null; }
}
function packageScripts(ctxDir) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(ctxDir, 'package.json'), 'utf8'));
    return (pkg && pkg.scripts) || {};
  } catch { return {}; }
}
function gitIgnored(ctxDir) {
  try {
    const files = fs.readdirSync(ctxDir);
    const hit = files.find(f => f.toLowerCase() === '.dockerignore');
    if (!hit) return false;
    return fs.readFileSync(path.join(ctxDir, hit), 'utf8').split('\n')
      .map(l => l.trim()).filter(l => l && !l.startsWith('#') && !l.startsWith('!'))
      .some(l => l === '.git' || l === '.git/' || l === '.git/*' || l === '**/.git' || l === '**/.git/*');
  } catch { return false; }
}
// Signals from a failed Docker build log.
function signals(errorText) {
  const text = String(errorText || '');
  const gitMissing = /exec:\s*"git":\s*executable file not found in \$PATH/i.test(text);
  let requiredMajor = null, currentMajor = null;
  const req = text.match(/required:\s*\{\s*node:\s*['"]>=(\d+)/);
  const cur = text.match(/current:\s*\{\s*node:\s*'v(\d+)/);
  if (req) requiredMajor = parseInt(req[1], 10);
  if (cur) currentMajor = parseInt(cur[1], 10);
  const engineMismatch = !!(requiredMajor && currentMajor && requiredMajor > currentMajor);
  return { gitMissing, engineMismatch, requiredMajor };
}
function nodeFroms(lines) {
  const out = [];
  lines.forEach((line, i) => {
    const m = line.match(/^\s*FROM\s+(?:docker\.io\/library\/)?node:(\d+)((?:[.-][\w.]+)*)(?:\s+AS\s+\S+)?\s*$/i);
    if (m) out.push({ index: i, major: parseInt(m[1], 10), suffix: m[2] || '' });
  });
  return out;
}
function installIndex(lines) {
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*RUN\b.*\b(npm|pnpm|yarn)\s+(install|ci)\b/.test(lines[i])) return i;
  }
  return -1;
}
function hasGit(lines, suffix) {
  const alpine = /alpine/i.test(suffix);
  return lines.some(l => alpine ? /(^|\s)apk\s+add\b.*\bgit\b/.test(l) : /(^|\s)apt(-get)?\s+install\b.*\bgit\b/.test(l));
}
function gitLine(suffix) {
  return /alpine/i.test(suffix)
    ? 'RUN apk add --no-cache git'
    : 'RUN apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/*';
}
function panelSeeded(text) {
  const first = String(text || '').split('\n')[0] || '';
  return first.includes('minipass template') || first.includes('build stage + serve');
}
// A proposal with _plan, or { diagnostic } when no verified edit applies.
function propose(ctxDir, errorText) {
  const sig = signals(errorText);
  if (!sig.gitMissing && !sig.engineMismatch) return null;
  const df = readDockerfile(ctxDir);
  if (!df) return null;
  if (panelSeeded(df.text)) return null; // panel-owned files use their own flow
  const lines = df.text.split('\n');
  const froms = nodeFroms(lines);
  if (!froms.length) {
    return { diagnostic: 'The build needs a newer Node.js runtime or a git binary, but this Dockerfile pins no node base image. Review its FROM lines manually; Minipass will not guess the intended image.' };
  }
  const needBump = sig.engineMismatch && froms.some(f => f.major < sig.requiredMajor);
  const needGit = sig.gitMissing && !froms.every(f => hasGit(lines, f.suffix));
  if (!needBump && !needGit) return null;
  const targetMajor = sig.requiredMajor || Math.max(...froms.map(f => f.major));
  const replacements = [];
  const after = lines.slice();
  const bumped = [];
  for (const f of froms) {
    if (f.major < targetMajor) {
      const escaped = f.suffix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const next = after[f.index].replace(new RegExp(`node:${f.major}${escaped}`, 'i'), `node:${targetMajor}${f.suffix}`);
      replacements.push({ index: f.index, before: lines[f.index], after: next });
      after[f.index] = next;
      bumped.push(`node:${f.major}${f.suffix} -> node:${targetMajor}${f.suffix}`);
    }
  }
  let insertion = null;
  if (needGit) {
    const at = installIndex(after);
    if (at < 0) return { diagnostic: 'The build needs git for install lifecycle scripts, but no package-install step was found to attach it to. Review the Dockerfile manually.' };
    const suffix = froms[0].suffix;
    if (!hasGit(after, suffix)) insertion = { at, line: gitLine(suffix) };
  }
  const before = lines.join('\n');
  if (insertion) after.splice(insertion.at, 0, insertion.line);
  const fixed = after.join('\n');
  if (before === fixed) return null;
  const diff = [`--- a/${df.name}`, `+++ b/${df.name}`];
  const events = [...replacements.map(r => ({ ...r, insert: false })), ...(insertion ? [{ ...insertion, insert: true }] : [])]
    .sort((a, b) => (a.insert ? a.at : a.index) - (b.insert ? b.at : b.index));
  for (const e of events) {
    if (e.insert) diff.push(`+ ${e.line}`);
    else { diff.push(`- ${e.before}`); diff.push(`+ ${e.after}`); }
  }
  const key = 'dockerfile-fix:' + df.name;
  const scripts = packageScripts(ctxDir);
  const prepare = ['prepare', 'preinstall', 'postinstall'].filter(k => typeof scripts[k] === 'string' && scripts[k].trim()).map(k => `${k}: ${scripts[k].trim()}`);
  const warnings = [];
  if (prepare.length && gitIgnored(ctxDir)) warnings.push(`Install lifecycle scripts (${prepare.join('; ')}) need repository metadata, but .dockerignore excludes .git from the build context. git alone may not satisfy them; a follow-up failure will say so exactly.`);
  return {
    key, kind: 'dockerfile-fix', title: `Adapt the repository Dockerfile build environment${bumped.length ? ` (${bumped.join(', ')})` : ''}${insertion ? ' + git' : ''}`,
    detail: `Build evidence: ${[sig.engineMismatch ? `package engines require node >= ${sig.requiredMajor}` : null, sig.gitMissing ? 'install lifecycle scripts need a git binary' : null].filter(Boolean).join('; ')}. ` +
      `Only the build recipe changes (${[bumped.length ? 'base image ' + bumped.join(', ') : null, insertion ? 'build-tool git before package install' : null].filter(Boolean).join('; ')}). ` +
      `Application source, lockfiles and the remote repository stay untouched. Approval is retained outside the checkout and revalidated on redeploy; upstream Dockerfile changes stop deployment for review. ` +
      (warnings.length ? warnings.join(' ') + ' ' : '') +
      `Fixing the repository itself remains the last resort if this adaptation cannot cover a failure.`,
    files: [df.name], preview: diff.slice(0, 60).join('\n'), revision: hash([before, fixed]), nextDeploy: 'local',
    _plan: { name: df.name, base: before, fixed, fromTag: froms.map(f => `node:${f.major}${f.suffix}`).join(','), toMajor: targetMajor, gitAdded: insertion ? insertion.line : null }
  };
}
// Evidence seen per build folder so apply() can re-derive without trusting
// client-sent file contents.
const lastEvidence = new Map();
function noteEvidence(ctxDir, errorText) { lastEvidence.set(ctxDir, String(errorText || '')); }
function plans(ctxDir) {
  const proposal = propose(ctxDir, lastEvidence.get(ctxDir) || '');
  if (!proposal || proposal.diagnostic) return [];
  const { _plan, ...pub } = proposal;
  return [{ ...pub, _plan }];
}
function suggest(ctxDir) {
  const proposal = propose(ctxDir, lastEvidence.get(ctxDir) || '');
  if (!proposal) return [];
  if (proposal.diagnostic) return [{ kind: 'diagnostic', title: 'Repository build environment problem',
    detail: proposal.diagnostic + ' Minipass will not guess the intended image or install step.', files: [], preview: '' }];
  const { _plan, ...pub } = proposal;
  return [pub];
}
function approval(plan) {
  return { key: plan.key, revision: plan.revision, name: plan._plan.name, base: plan._plan.base, fixed: plan._plan.fixed,
    fromTag: plan._plan.fromTag, toMajor: plan._plan.toMajor, gitAdded: plan._plan.gitAdded, files: plan.files };
}
function apply(ctxDir, suggestion, { backupRoot, beforeApply } = {}) {
  const plan = plans(ctxDir).find(p => p.key === suggestion.key);
  if (!plan || plan.revision !== suggestion.revision) throw conflict('Dockerfile or build evidence changed - refresh the preview before applying');
  const file = path.join(ctxDir, plan._plan.name);
  let stat;
  try { stat = fs.lstatSync(file); } catch { throw conflict('Dockerfile is missing - refresh the preview'); }
  if (!stat.isFile() || stat.isSymbolicLink()) throw conflict('Dockerfile is unsafe - refresh the preview');
  if (fs.readFileSync(file, 'utf8') !== plan._plan.base) throw conflict('Dockerfile changed - refresh the preview before applying');
  if (beforeApply) beforeApply(approval(plan));
  const root = backupRoot || path.join(ctxDir, '.minipass-dockerfile-fixes');
  const dir = path.join(root, plan.revision);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const backup = path.join(dir, plan._plan.name);
  if (!fs.existsSync(backup)) fs.writeFileSync(backup, plan._plan.base, { flag: 'wx', mode: 0o600 });
  else if (fs.readFileSync(backup, 'utf8') !== plan._plan.base) throw conflict('Existing Dockerfile-fix backup differs; it will not be overwritten');
  const temp = file + '.minipass-df-' + crypto.randomBytes(8).toString('hex');
  try {
    fs.writeFileSync(temp, plan._plan.fixed, { flag: 'wx', mode: stat.mode });
    fs.renameSync(temp, file);
  } finally { try { fs.unlinkSync(temp); } catch {} }
  return { applied: [plan._plan.name], nextDeploy: 'local', backup: dir };
}
module.exports = { signals, propose, suggest, plans, apply, approval, noteEvidence, dockerfileName };
