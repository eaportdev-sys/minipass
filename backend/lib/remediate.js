// One-click remediations for failed deploys. Detection is automatic; every fix
// is explicit, previewed, box-files-only (never committed or pushed), and
// visible in git status afterwards. The panel suggests - it never invents
// customer code on its own.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const prebuild = require('./prebuild');
const { failureSummary } = require('./build-log');
const importRepair = require('./import-repair');

const VALID_KEY = /^[a-z-]+:[A-Za-z0-9_.\/-]{1,120}$/;

function inside(ctxDir, rel) {
  const resolved = path.resolve(ctxDir, rel);
  return resolved === path.resolve(ctxDir) || resolved.startsWith(path.resolve(ctxDir) + path.sep) ? resolved : null;
}

function readText(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch { return null; }
}

function regularText(file) {
  try { return fs.lstatSync(file).isFile() ? fs.readFileSync(file, 'utf8') : null; }
  catch { return null; }
}
function restoreRevision(current, original) {
  return crypto.createHash('sha256').update(JSON.stringify([current, original])).digest('hex');
}

// TS2307 entries: file(line,col): error TS2307: Cannot find module 'X'
function missingModules(errorText) {
  const out = [];
  for (const line of String(errorText || '').split('\n')) {
    const clean = line.replace(/\x1b\[[0-9;]*m/g, '').replace(/^\s*(?:#\d+\s+)?\d+\.\d+\s+/, '');
    const m = clean.match(/(?:^|:\s+)([A-Za-z0-9_.\/\\-]+\.(?:tsx?|jsx?|[mc]ts|[mc]js))(?:(?:\(\d+,\s*\d+\):)|(?::\d+:\d+\s*-))\s*error\s+TS2307:\s*Cannot find module\s+'([^']+)'/);
    if (m) out.push({ file: m[1].trim(), request: m[2] });
  }
  return out;
}

// Resolve a relative import to a repo path; null when external or ambiguous.
function resolveRequest(ctxDir, fromFile, request) {
  if (!request.startsWith('.')) return null;
  const base = path.resolve(ctxDir, path.dirname(fromFile), request);
  if (!inside(ctxDir, path.relative(ctxDir, base))) return null;
  const cands = [`${base}.ts`, `${base}.tsx`, `${base}.d.ts`, path.join(base, 'index.ts'), path.join(base, 'index.tsx')];
  if (cands.some(c => { try { return fs.statSync(c).isFile(); } catch { return false; } })) return null; // exists after all
  return path.relative(ctxDir, base).split(path.sep).join('/');
}

function suggest(ctxDir, errorText, templateDockerfile, latestError = errorText) {
  // Inspect source even when the latest install failure prevented tsc from
  // running. This can show a separate, previewed import correction alongside
  // Dockerfile recovery instead of hiding the source problem until another build.
  const suggestions = importRepair.suggest(ctxDir);
  const seen = new Set();
  for (const { file, request } of missingModules(errorText)) {
    const rel = resolveRequest(ctxDir, file, request);
    const identity = rel || `${file}:${request}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    const checked = rel && suggestions.find(s => s.unresolved === rel);
    if (checked) {
      checked.detail = `The compiler reported TS2307 in ${file}. ` + checked.detail;
      continue;
    }
    // The build record is historical after a saved correction. Do not keep
    // diagnosing an import that the current source no longer contains.
    if (!importRepair.hasImport(ctxDir, file, request)) continue;
    suggestions.push({
      kind: 'diagnostic',
      title: `TypeScript cannot resolve '${request}'`,
      detail: `The compiler reported TS2307 in ${file}.${rel ? ` No matching TypeScript module was found at ${rel}.` : ''} Check the source files, path casing, import aliases and declared dependencies. A placeholder export could compile but break runtime behavior, so Minipass does not generate one.`,
      files: [], preview: ''
    });
  }
  // Never replace a repository Dockerfile merely because it expects dist/.
  // The pre-build already handles that without changing the build recipe.
  // An earlier panel replacement can be undone, but only from an actual backup
  // while the current file still exactly matches the panel recipe.
  const npmCrash = /Cannot read properties of null\s*\(reading ['"]edgesOut['"]\)/i.test(String(latestError || ''));
  let restore = null;
  try {
    const files = fs.readdirSync(ctxDir);
    const dfName = files.find(f => /^dockerfile$/i.test(f));
    if (dfName) {
      const df = regularText(path.join(ctxDir, dfName));
      const backup = regularText(path.join(ctxDir, dfName + '.minipass-bak'));
      const pkg = JSON.parse(readText(path.join(ctxDir, 'package.json')) || '{}');
      const normalize = text => String(text || '').replace(/\r\n/g, '\n').trim();
      const repoBuild = pkg && pkg.scripts && typeof pkg.scripts.build === 'string' && pkg.scripts.build.trim();
      if (npmCrash && df && backup && templateDockerfile && normalize(df) === normalize(templateDockerfile) &&
          !prebuild.isPanelSeeded(backup) && !prebuild.buildsItself(backup) &&
          prebuild.expectedOutputs(backup).length && repoBuild) {
        const manager = prebuild.packageManager(ctxDir).replace('npm-ci', 'npm');
        restore = {
          key: 'dockerfile-restore:' + dfName,
          kind: 'dockerfile-restore',
          title: 'Restore the backed-up repository Dockerfile',
          detail: `npm crashed internally during dependency installation (edgesOut). The current Dockerfile matches the panel's replacement; ${dfName}.minipass-bak contains the previous output-serving recipe. Restore that exact backup; Minipass can pre-build missing output using ${manager} and the repository's build script. This does not establish npm's exact crash trigger or guarantee a successful build. Source files and lockfiles are untouched. Use local rebuild afterwards to preserve box edits.`,
          files: [dfName, dfName + '.minipass-replaced'],
          preview: backup,
          revision: restoreRevision(df, backup),
          nextDeploy: 'local'
        };
        suggestions.push(restore);
      }
    }
  } catch {}
  if (npmCrash && !restore) suggestions.push({
    kind: 'diagnostic', title: 'npm dependency installer crashed (edgesOut)',
    detail: 'npm failed internally while resolving dependencies, before the application build. This summary does not establish the exact trigger. No verified Dockerfile backup recovery is available here; Minipass will not delete lockfiles, force dependencies or overwrite a custom Dockerfile.',
    files: [], preview: ''
  });
  if (!npmCrash && !suggestions.length && /pre-build failed|ELIFECYCLE|error TS\d+/i.test(String(latestError || ''))) suggestions.push({
    kind: 'diagnostic', title: 'Repository pre-build failed',
    detail: 'The last deployment\'s repository build command failed. This does not establish that its Dockerfile is wrong. After source edits, use local rebuild to verify them. Compiler and installer details are retained in the latest build log; Minipass will not replace the Dockerfile or invent application code to hide the failure.',
    files: [], preview: failureSummary(errorText)
  });
  return suggestions;
}

function apply(ctxDir, suggestion, options = {}) {
  if (!suggestion || !VALID_KEY.test(suggestion.key || '')) throw new Error('unknown remediation');
  if (suggestion.kind === 'import-repair') return importRepair.apply(ctxDir, suggestion, options);
  if (suggestion.kind === 'dockerfile-restore') {
    const dfName = (suggestion.files && suggestion.files[0]) || 'Dockerfile';
    const dfPath = inside(ctxDir, dfName);
    if (!dfPath || path.resolve(path.dirname(dfPath)) !== path.resolve(ctxDir)) throw new Error('remediation path escapes the build folder');
    const current = regularText(dfPath);
    const original = regularText(dfPath + '.minipass-bak');
    if (!current || !original || original !== suggestion.preview ||
        restoreRevision(current, original) !== suggestion.revision) throw new Error('Dockerfile or backup changed - refresh the preview');
    // Preserve both the original backup and the replaced recipe. Never overwrite
    // an older recovery copy or follow a symlink to another file.
    const temp = dfPath + '.minipass-restore-' + crypto.randomBytes(8).toString('hex');
    try {
      fs.writeFileSync(temp, original, { flag: 'wx', mode: fs.statSync(dfPath).mode });
      fs.copyFileSync(dfPath, dfPath + '.minipass-replaced', fs.constants.COPYFILE_EXCL);
      fs.renameSync(temp, dfPath);
    } finally {
      try { fs.unlinkSync(temp); } catch {}
    }
    return { applied: [dfName, dfName + '.minipass-replaced'], nextDeploy: 'local' };
  }
  throw new Error('unknown remediation');
}

module.exports = { VALID_KEY, suggest, apply, missingModules };
