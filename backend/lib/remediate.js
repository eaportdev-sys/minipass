// One-click remediations for failed deploys. Detection is automatic; every fix
// is explicit, previewed, box-files-only (never committed or pushed), and
// visible in git status afterwards. The panel suggests - it never invents
// customer code on its own.
const fs = require('fs');
const path = require('path');
const prebuild = require('./prebuild');

const VALID_KEY = /^[a-z-]+:[A-Za-z0-9_.\/-]{1,120}$/;

function inside(ctxDir, rel) {
  const resolved = path.resolve(ctxDir, rel);
  return resolved === path.resolve(ctxDir) || resolved.startsWith(path.resolve(ctxDir) + path.sep) ? resolved : null;
}

function readText(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch { return null; }
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

function suggest(ctxDir, errorText, templateDockerfile) {
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
  // Dockerfile that expects uncompiled output: offer the standard build recipe
  // with the current file kept as a backup. Only when the repo has a build
  // script (otherwise there is nothing standard to run).
  try {
    const files = fs.readdirSync(ctxDir);
    const dfName = files.find(f => /^dockerfile$/i.test(f));
    if (dfName) {
      const df = fs.readFileSync(path.join(ctxDir, dfName), 'utf8');
      const item = prebuild.plan(ctxDir);
      if ((item && (item.outputDir || item.blocked)) && !prebuild.buildsItself(df) && !prebuild.isPanelSeeded(df) && templateDockerfile) {
        suggestions.push({
          key: 'dockerfile-replace:Dockerfile',
          kind: 'dockerfile-replace',
          title: 'Replace Dockerfile with the standard build recipe',
          detail: `This Dockerfile expects '${(item.outputDir || 'dist')}/' without building it. The current file is kept as ${dfName}.minipass-bak; the standard recipe compiles the repo (lockfile toolchain) then serves the output. Review the diff in Files, then redeploy.`,
          files: [dfName, dfName + '.minipass-bak'],
          preview: templateDockerfile
        });
      }
    }
  } catch {}
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
  if (suggestion.kind === 'dockerfile-replace') {
    const dfName = (suggestion.files && suggestion.files[0]) || 'Dockerfile';
    const dfPath = inside(ctxDir, dfName);
    if (!dfPath || path.resolve(path.dirname(dfPath)) !== path.resolve(ctxDir)) throw new Error('remediation path escapes the build folder');
    if (!fs.existsSync(dfPath)) throw new Error('Dockerfile is gone - re-run suggestions');
    fs.copyFileSync(dfPath, dfPath + '.minipass-bak');
    fs.writeFileSync(dfPath, suggestion.preview);
    return { applied: [dfName, dfName + '.minipass-bak'] };
  }
  throw new Error('unknown remediation');
}

module.exports = { VALID_KEY, suggest, apply, missingModules, importedNames };
