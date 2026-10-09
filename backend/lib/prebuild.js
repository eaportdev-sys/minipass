// Automatic pre-build: some repositories ship a Dockerfile that expects
// compiled output (dist/, build/, out/) but never compiles it - their own
// docs assume `npm run build` ran locally first. A clean panel clone has no
// such output, so the Dockerfile is left byte-identical and the repo's own
// declared build script runs first in a disposable builder container.
// Triggers only when ALL hold: repo-owned Dockerfile references missing
// output, Dockerfile has no build step of its own, package.json declares a
// build script. Anything else behaves exactly as before.
const fs = require('fs');
const path = require('path');

const BUILDER_IMAGE = 'node:24-bookworm-slim';
const OUTPUT_DIRS = ['dist', 'build', 'out'];

function readFile(dir, name) {
  try {
    const files = fs.readdirSync(dir);
    const hit = files.find(f => f.toLowerCase() === name.toLowerCase());
    return hit ? fs.readFileSync(path.join(dir, hit), 'utf8') : null;
  } catch { return null; }
}

// Panel-seeded template Dockerfiles build themselves; only repo-owned files
// qualify for pre-build assistance.
function isPanelSeeded(dockerfile) {
  const first = String(dockerfile || '').split('\n')[0] || '';
  return first.includes('minipass template') || first.includes('build stage + serve');
}

// The Dockerfile builds itself when any RUN step invokes a build.
function buildsItself(dockerfile) {
  return String(dockerfile || '').split('\n').some(l =>
    /^\s*RUN\b/i.test(l) && /(npm|pnpm|yarn|bun)\s+(run\s+)?build\b|vite\s+build|(?<![\w-])tsc(?![\w-])/i.test(l));
}

// Output dirs the Dockerfile expects via COPY/cp (bounded to the three
// conventional SPA output names; anything exotic stays a loud Docker error).
function expectedOutputs(dockerfile) {
  const found = new Set();
  for (const line of String(dockerfile || '').split('\n')) {
    if (!/^\s*(COPY\b|RUN\b.*\bcp\b)/i.test(line)) continue;
    for (const out of OUTPUT_DIRS) {
      if (new RegExp(`(^|[/\\s"'])${out}(?=[/\\s"']|$)`).test(line)) found.add(out);
    }
  }
  return [...found];
}

function buildScript(ctxDir) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(ctxDir, 'package.json'), 'utf8'));
    const script = pkg && pkg.scripts && pkg.scripts.build;
    return typeof script === 'string' && script.trim() ? script.trim() : null;
  } catch { return null; }
}

function packageManager(ctxDir) {
  const has = f => { try { return fs.existsSync(path.join(ctxDir, f)); } catch { return false; } };
  if (has('pnpm-lock.yaml')) return 'pnpm';
  if (has('yarn.lock')) return 'yarn';
  if (has('package-lock.json')) return 'npm-ci';
  return 'npm';
}

// A .dockerignore that excludes the output dir would silently drop the
// pre-built files from the build context - fail loud with the reason instead.
function ignoreBlocks(ctxDir, outputDir) {
  try {
    const files = fs.readdirSync(ctxDir);
    const hit = files.find(f => f.toLowerCase() === '.dockerignore');
    if (!hit) return false;
    return fs.readFileSync(path.join(ctxDir, hit), 'utf8').split('\n')
      .map(l => l.trim()).filter(l => l && !l.startsWith('#') && !l.startsWith('!'))
      .some(l => l === outputDir || l === outputDir + '/' || l === outputDir + '/*' || l === '**/' + outputDir || l === '**/' + outputDir + '/*');
  } catch { return false; }
}

function plan(ctxDir, { force = false } = {}) {
  const dockerfile = readFile(ctxDir, 'Dockerfile');
  if (!dockerfile || isPanelSeeded(dockerfile) || buildsItself(dockerfile)) return null;
  const missing = expectedOutputs(dockerfile).filter(out => {
    if (force) return true; // approved source edits must not reuse stale output
    try { return !fs.statSync(path.join(ctxDir, out)).isDirectory(); } catch { return true; }
  });
  if (!missing.length) return null;
  const script = buildScript(ctxDir);
  if (!script) return null;
  const outputDir = missing[0];
  if (ignoreBlocks(ctxDir, outputDir)) {
    return { outputDir, blocked: `Dockerfile expects '${outputDir}/' but .dockerignore excludes it - pre-built files would never reach the build. Remove '${outputDir}' from .dockerignore or commit a Dockerfile that builds first.` };
  }
  return { outputDir, script, manager: packageManager(ctxDir) };
}

function installStep(manager) {
  if (manager === 'pnpm') return 'corepack pnpm install --frozen-lockfile';
  if (manager === 'yarn') return 'corepack yarn install --frozen-lockfile';
  if (manager === 'npm-ci') return 'npm ci --no-audit --no-fund';
  return 'npm install --no-audit --no-fund';
}

function buildStep(manager) {
  if (manager === 'pnpm') return 'corepack pnpm run build';
  if (manager === 'yarn') return 'corepack yarn build';
  return 'npm run build';
}

// argv-based (no shell): ctxDir travels as one argv element, the container
// command is assembled from constants only.
function argv(ctxDir, item) {
  return ['run', '--rm',
    '-v', `${ctxDir}:/build`, '-w', '/build', '-e', 'CI=true',
    BUILDER_IMAGE, 'sh', '-c', `${installStep(item.manager)} && ${buildStep(item.manager)}`];
}

async function ensureBuilderImage(run) {
  try { await run(['image', 'inspect', BUILDER_IMAGE]); }
  catch { await run(['image', 'pull', BUILDER_IMAGE]); }
}

module.exports = { BUILDER_IMAGE, OUTPUT_DIRS, plan, argv, ensureBuilderImage, expectedOutputs, buildsItself, isPanelSeeded, packageManager };
