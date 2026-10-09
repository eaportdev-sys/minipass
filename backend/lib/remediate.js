// One-click remediations for failed deploys. Detection is automatic; every fix
// is explicit, previewed, box-files-only (never committed or pushed), and
// visible in git status afterwards. The panel suggests - it never invents
// customer code on its own.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const prebuild = require('./prebuild');

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
    const m = line.match(/^(.+?)\(\d+,\d+\):\s*error\s+TS2307:\s*Cannot find module\s+'([^']+)'/);
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

// Identifier names imported from the missing module across the repo.
function importedNames(ctxDir, request) {
  const names = new Set();
  const walk = dir => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (['node_modules', '.git', 'dist', 'build', 'out'].includes(e.name)) continue;
        walk(full);
      } else if (e.isFile() && /\.(ts|tsx)$/.test(e.name)) {
        const text = readText(full);
        if (!text) continue;
        for (const m of text.matchAll(/import\s*(?:\{([^}]*)\}|(\*\s*as\s+[\w$]+)|([\w$]+))\s*from\s*['"]([^'"]+)['"]/g)) {
          if (m[4] !== request) continue;
          if (m[1]) for (const part of m[1].split(',')) {
            const name = (part.trim().split(/\s+as\s+/).pop() || '').trim();
            if (/^[\w$]+$/.test(name) && name !== 'type') names.add(name);
          }
          else if (m[3]) names.add(m[3]);
        }
      }
    }
  };
  walk(ctxDir);
  return [...names].slice(0, 20);
}

function stubPreview(names) {
  return '// minipass remediation stub - created with operator approval. The upstream\n// repository never shipped this module; verify its runtime behavior.\n' +
    names.map(n => `export const ${n} = undefined as any;`).join('\n') + '\n';
}

function suggest(ctxDir, errorText, templateDockerfile, latestError = errorText) {
  const suggestions = [];
  const seen = new Set();
  for (const { file, request } of missingModules(errorText)) {
    const rel = resolveRequest(ctxDir, file, request);
    if (!rel || seen.has(rel)) continue;
    seen.add(rel);
    const names = importedNames(ctxDir, request);
    if (!names.length) continue;
    const target = rel + '.ts';
    suggestions.push({
      key: `missing-module:${target}`,
      kind: 'missing-module',
      title: `Create missing module ${target}`,
      detail: `TypeScript cannot find '${request}' (imported by ${file} and others). This writes a stub exporting ${names.join(', ')} - review its runtime behavior, then redeploy. Box files only; your repo is untouched until you commit.`,
      files: [target],
      preview: stubPreview(names)
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
  return suggestions;
}

function apply(ctxDir, suggestion) {
  if (!suggestion || !VALID_KEY.test(suggestion.key || '')) throw new Error('unknown remediation');
  if (suggestion.kind === 'missing-module') {
    const target = suggestion.files && suggestion.files[0];
    const dest = target && inside(ctxDir, target);
    if (!dest || !dest.endsWith('.ts')) throw new Error('remediation path escapes the build folder');
    if (fs.existsSync(dest)) throw new Error('target already exists - re-run suggestions');
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, suggestion.preview);
    return { applied: [path.relative(ctxDir, dest).split(path.sep).join('/')] };
  }
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

module.exports = { VALID_KEY, suggest, apply, missingModules, importedNames };
