// Discover repository instructions. Findings are advisory: launch is never
// conditional on a complete scan or approval of a source-analysis report.
const fs = require('fs');
const path = require('path');
const { inventory, sourceFile, isDockerfile } = require('./repository-files');
const { parseCompose, COMPOSE_FILES } = require('./compose-read');
const { detectPackageManager } = require('./detect');
const { resolveServiceDockerfile, standardDockerfileType } = require('./dockerfiles');
const { redact } = require('./panel-log');

function preview(command) {
  const text = typeof command === 'string' ? command : JSON.stringify(command);
  return redact(text).replace(/(\b[A-Z][A-Z0-9_]*=)(?:"[^"\n]*"|'[^'\n]*'|[^\s]+)/g, '$1[redacted]')
    .replace(/(--(?:password|passwd|secret|token|api-key|access-key)(?:=|\s+))(?:"[^"]*"|'[^']*'|[^\s]+)/gi, '$1[redacted]')
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^/\s]+@/gi, '$1[redacted]@').slice(0, 500);
}
function references(text, source) {
  const refs = [];
  // Extract literal -f/--file arguments only; do not interpret shell expansion,
  // invoke scripts, or treat documentation prose as executable instructions.
  for (const match of text.matchAll(/\bdocker(?:-compose|\s+(?:compose|(?:buildx\s+)?build))\b([^\n;`]*)(?:$|[\n;`])/g)) {
    const kind = /compose/.test(match[0].split(/\s+-/)[0]) ? 'compose' : 'dockerfile';
    const files = [];
    for (const arg of match[1].matchAll(/(?:^|\s)(?:-f\s*|--file(?:=|\s+))(?:("[^"]+")|('[^']+')|([^\s"'<>|&]+))/g)) {
      const file = (arg[1] || arg[2] || arg[3]).replace(/^["']|["']$/g, '');
      files.push(file);
    }
    const linePrefix = text.slice(text.lastIndexOf('\n', match.index) + 1, match.index);
    const profiles = [...match[1].matchAll(/(?:^|\s)--profile(?:=|\s+)(?:"([^"]+)"|'([^']+)'|([^\s"'<>|&]+))/g)].map(m => m[1] || m[2] || m[3]);
    if (files.length) refs.push({ source, kind, files, profiles, documentation: /\.(?:md|rst|txt)$/i.test(source) || /^\s*#/.test(linePrefix) });
  }
  return refs;
}
function relativeReference(root, source, file) {
  if (/[${}~]/.test(file) || path.isAbsolute(file) || /^[A-Za-z]:/.test(file)) return null;
  const rootPath = path.posix.normalize(file.replace(/\\/g, '/')).replace(/^\.\//, '');
  if (sourceFile(root, rootPath)) return rootPath;
  const localPath = path.posix.normalize(path.posix.join(path.posix.dirname(source), rootPath));
  return sourceFile(root, localPath) ? localPath : null;
}
function analyze(root, { selection = null, services = [], templatesDir, env = {} } = {}, options = {}) {
  const scan = inventory(root, options);
  const candidates = [], refs = [], manifests = [], blockers = [], warnings = [];
  const issue = (code, message, file = null) => warnings.push({ code, message, file });
  for (const [file, text] of scan.texts) {
    if (!/^\s*\{/.test(text)) refs.push(...references(text, file));
    if (isDockerfile(text)) candidates.push({ kind: 'dockerfile', file, generated: !!(templatesDir && standardDockerfileType(path.join(root, path.posix.dirname(file)), templatesDir, path.posix.basename(file))) });
    // Content first, names only help expose malformed conventional files.
    if (/(?:^|\n)\s*["']?services["']?\s*:/.test(text) || /"services"\s*:\s*\{/.test(text) || COMPOSE_FILES.includes(path.posix.basename(file))) {
      let topo;
      try { topo = parseCompose(text, file); } catch { topo = { file, complete: false, errors: ['INVALID_YAML'], services: [], envNeeds: [] }; }
      if (topo && (topo.complete || COMPOSE_FILES.includes(path.posix.basename(file)) || /^(?:\s|#[^\n]*\n)*["']?(?:services|version|name|x-[\w-]+)["']?\s*:/.test(text))) candidates.push({ kind: 'compose', file, topology: topo });
    }
    // Manifests by content too: valid JSON may have an unconventional name.
    if (/^\s*\{/.test(text)) {
      try {
        const json = JSON.parse(text);
        if (json && typeof json === 'object' && !Array.isArray(json)) {
          if (json.scripts && (json.dependencies || json.devDependencies || json.name || path.posix.basename(file) === 'package.json')) {
            manifests.push({ file, kind: 'javascript', manager: detectPackageManager({ pkg: json, files: scan.files.filter(f => path.posix.dirname(f) === path.posix.dirname(file)) }).manager,
              commands: Object.entries(json.scripts).filter(([, v]) => typeof v === 'string').map(([name, command]) => ({ name, command: preview(command) })) });
            // JSON escapes obscure literal shell -f references; inspect scripts as strings.
             for (const [name, command] of Object.entries(json.scripts)) if (typeof command === 'string') refs.push(...references(command, file).map(r => ({ ...r, commandName: name })));
          }
          if (json.require && (json.require.php || Object.keys(json.require).some(k => k.includes('/')))) {
            manifests.push({ file, kind: 'php', manager: 'composer', commands: Object.entries(json.scripts || {}).map(([name, command]) => ({ name, command: preview(command) })) });
          }
        }
      } catch {}
    }
  }
  const evidence = [];
  for (const reference of refs) {
    const targets = reference.files.map(f => relativeReference(root, reference.source, f));
     evidence.push({ source: reference.source, kind: reference.kind, files: targets.filter(Boolean), profiles: reference.profiles, documentation: reference.documentation, ...(reference.commandName ? { commandName: reference.commandName } : {}) });
    for (let i = 0; i < targets.length; i++) {
      if (!targets[i]) {
        const message = 'A deployment file reference is missing, dynamic, or outside the source tree. Select and review the entrypoint.';
        if (reference.documentation) warnings.push({ file: reference.source, message });
        else issue('UNRESOLVED_REFERENCE', message, reference.source);
      } else if (!candidates.some(c => c.kind === reference.kind && c.file === targets[i])) {
        issue('INVALID_REFERENCED_FILE', 'The referenced file could not be recognized as ' + reference.kind + ' instructions.', targets[i]);
      }
    }
  }
  // Preserve a declared ordered invocation as one selectable entrypoint. Do not
  // hand-merge YAML: Compose will apply overlay/include/extends semantics.
  const invocationKey = c => JSON.stringify([c.files || [c.file], c.profiles || []]);
  for (const e of evidence.filter(e => e.kind === 'compose' && (e.files.length > 1 || e.profiles.length))) {
    if (!e.files.length || e.files.some(f => !candidates.some(c => c.kind === 'compose' && c.file === f))) continue;
    const first = candidates.find(c => c.kind === 'compose' && c.file === e.files[0]);
     const group = { kind: 'compose', file: e.files[0], files: e.files, profiles: e.profiles, topology: first.topology };
    if (!candidates.some(c => c.files && invocationKey(c) === invocationKey(group))) candidates.push(group);
  }
  if (!scan.complete) issue('INCOMPLETE_SCAN', 'Some source files were not analyzed. Review the listed exclusions/errors before deploying.');
  const compose = candidates.filter(c => c.kind === 'compose');
  const docker = candidates.filter(c => c.kind === 'dockerfile');
  const authored = docker.filter(c => !c.generated);
  const folders = new Set(services.filter(s => s.enabled !== false).map(s => s.subdir || '.'));
  const eligible = compose.length ? compose : authored.length ? authored : docker.filter(c => !services.length || folders.has(path.posix.dirname(c.file)));
  const invocations = evidence.filter(e => e.kind === 'compose' && !e.documentation && e.files.length);
  const scoreInvocation = e => {
    const text = [e.commandName || '', ...e.files].join(' ').toLowerCase();
    if (/(?:^|[\s:._/-])(?:prod|production|release|deploy)(?=[\s:._/-]|$)/.test(text)) return 0;
    if (/(?:^|[\s:._/-])(?:test|testing|ci)(?=[\s:._/-]|$)/.test(text)) return 3;
    if (/(?:^|[\s:._/-])(?:dev|development|debug)(?=[\s:._/-]|$)/.test(text)) return 2;
    return 1;
  };
  const declaredGroups = [...new Map(invocations.map(e => [invocationKey(e), e])).values()]
    .map(e => ({ evidence: e, candidate: candidates.find(c => c.kind === 'compose' && invocationKey(c) === invocationKey(e)) }))
    .filter(e => e.candidate).sort((a, b) => scoreInvocation(a.evidence) - scoreInvocation(b.evidence) || invocationKey(a.evidence).localeCompare(invocationKey(b.evidence)));
  let selected = null, reason = null;
  if (selection) {
    selected = candidates.find(c => c.kind === selection.kind && c.file === selection.file && invocationKey(c) === invocationKey(selection));
    if (!selected) issue('STALE_SELECTION', 'The saved deployment entrypoint is missing or no longer recognizable.', selection.file);
    reason = 'Saved selection';
    // Older auto-detection saved a production override by itself. When it
    // cannot define a runtime and the repository declares exactly one ordered
    // launch command using it, restore that complete invocation, not a guessed
    // merge. Explicit runnable standalone recipes remain unchanged.
    if (selected?.kind === 'compose' && !selected.files && selected.topology?.services.some(s => !s.image && !s.build) && !(selected.topology.references || []).length) {
      const parents = declaredGroups.filter(e => e.candidate.files?.includes(selected.file));
      if (parents.length === 1) {
        selected = parents[0].candidate;
        reason = 'Repository-declared base and overlay for the selected production override';
      }
    }
  }
  if (!selected) {
     const buildFiles = [...new Set(evidence.filter(e => e.kind === 'dockerfile' && !e.documentation).flatMap(e => e.files))];
    if (!invocations.length && buildFiles.length === 1) {
      selected = candidates.find(c => c.kind === 'dockerfile' && c.file === buildFiles[0]);
      reason = 'Referenced by repository deployment command';
    }
     if (!selected && declaredGroups.length && (declaredGroups[0].candidate.files?.length > 1 || declaredGroups[0].candidate.profiles?.length)) {
       selected = declaredGroups[0].candidate;
       reason = 'Ordered Compose files/profiles declared by repository command';
    }
    const explicit = [...new Set(evidence.filter(e => !e.documentation).flatMap(e => e.files).filter(f => eligible.some(c => c.file === f)))];
    if (selected) { /* a complete declared invocation already wins */ }
    else if (explicit.length === 1) {
      selected = eligible.find(c => c.file === explicit[0]); reason = 'Referenced by repository deployment command';
    } else if (eligible.length === 1) { selected = eligible[0]; reason = 'Only discovered entrypoint of this kind'; }
    else if (eligible.length > 1) {
      // Multiple Dockerfiles in independent configured folders are not competing
      // project entrypoints; each service still resolves/validates its own recipe.
      const roots = new Set(eligible.map(c => path.posix.dirname(c.file)));
      const configured = new Set(services.filter(s => s.enabled !== false).map(s => s.subdir || '.'));
      if (compose.length || roots.size !== eligible.length || [...roots].some(r => !configured.has(r))) {
        // Prefer conventional production recipes over development examples.
        // An explicit repository command still wins above; Setup can override.
        const score = c => {
          const name = path.posix.basename(c.file).toLowerCase();
          if (/(?:^|[._-])(?:prod|production)(?:[._-]|$)/.test(name)) return 0;
          if (/^(?:compose|docker-compose)\.ya?ml$/.test(name) || name === 'dockerfile') return 1;
          return /(?:^|[._-])(?:dev|development|test|example)(?:[._-]|$)/.test(name) ? 3 : 2;
        };
        selected = [...eligible].sort((a, b) => score(a) - score(b) || a.file.localeCompare(b.file))[0];
        reason = 'Automatically detected deployment file';
        issue('ALTERNATE_ENTRYPOINTS', `Using ${selected.file}; alternate deployment files are available in Setup.`);
      }
      else reason = 'Separate recipes in configured service folders';
    } else reason = 'No container recipe declared; use supported manifest-driven build environment';
  }
  let topology = null;
  if (selected && selected.kind === 'compose') {
    const t = selected.topology;
    if (!t.complete) issue('INVALID_COMPOSE', 'Compose could not be read completely: ' + t.errors.join(', '), t.file);
    // Never expose literal environment values/defaults or unredacted commands.
    topology = { file: t.file, services: t.services.map(s => ({ ...s, image: s.image == null ? null : preview(s.image), command: s.command == null ? null : preview(s.command), entrypoint: s.entrypoint == null ? null : preview(s.entrypoint) })),
      envNeeds: t.envNeeds.map(e => ({ key: e.key, required: e.required, services: e.services })) };
    for (const e of t.envNeeds) if (e.required && (!(e.key in env) || (!e.allowEmpty && !String(env[e.key]).trim()))) issue('REQUIRED_ENV', `Compose requires ${e.key}. Set it in Environment; derived service variables are not separate inputs.`, t.file);
    for (const ref of t.references || []) {
      const relative = typeof ref.file === 'string' ? path.posix.normalize(path.posix.join(path.posix.dirname(t.file), ref.file)) : '';
      if (!relative || !sourceFile(root, relative)) issue('MISSING_COMPOSE_REFERENCE', `Repository ${ref.kind} must refer to a readable file inside this checkout.`, t.file);
    }
    for (const s of selected.files && selected.files.length > 1 ? [] : t.services) {
      for (const dep of s.dependsOn) if (!t.services.some(d => d.name === dep)) issue('MISSING_DEPENDENCY', `Service ${s.name} depends on undeclared service ${dep}.`, t.file);
      for (const entry of s.envFiles) {
        const envPath = path.posix.normalize(path.posix.join(path.posix.dirname(t.file), entry.path || ''));
        if (entry.required && !sourceFile(root, envPath)) issue('MISSING_ENV_FILE', `Service ${s.name} requires an env file that is missing or outside the source tree.`, t.file);
      }
      if (s.build && !s.build.inline) {
        const context = path.posix.normalize(path.posix.join(path.posix.dirname(t.file), s.build.context));
        const recipe = path.posix.normalize(path.posix.join(context, s.build.dockerfile || 'Dockerfile'));
        if (!candidates.some(c => c.kind === 'dockerfile' && c.file === recipe)) issue('MISSING_RECIPE', `Service ${s.name} references an unreadable or unrecognized build recipe.`, recipe);
      }
    }
    warnings.push({ file: t.file, message: 'Compose runs the repository services, commands and dependency conditions as declared.' });
  } else if (!compose.length) {
    for (const s of services.filter(s => s.enabled !== false)) {
      const context = path.join(root, s.subdir || '');
      try {
        const resolved = resolveServiceDockerfile(context, s.dockerfile, s.type, templatesDir);
        if (!resolved) issue('MISSING_BUILD_ENVIRONMENT', `Service ${s.name} has no build recipe or prepared supported build environment.`, s.subdir || '.');
        if (selected && selected.kind === 'dockerfile' && path.posix.dirname(selected.file) === (s.subdir || '.') && resolved && path.posix.basename(selected.file) !== resolved.file) issue('RECIPE_MISMATCH', `Service ${s.name} would build ${resolved.file}, not the selected ${path.posix.basename(selected.file)}. Save the selected build file first.`, selected.file);
        if (resolved && !isDockerfile(scan.texts.get(path.posix.join(s.subdir || '', resolved.file)))) issue('INVALID_RECIPE', `Service ${s.name} build file was not completely recognized as Dockerfile instructions.`, resolved.file);
      } catch { issue('SERVICE_RECIPE_CHOICE', `Service ${s.name} has an ambiguous or stale build-file selection. Choose its recipe in Setup.`, s.subdir || '.'); }
    }
  }
  const servicePlans = services.filter(s => s.enabled !== false).map(s => {
    let recipe = null, generated = false;
    try { const r = resolveServiceDockerfile(path.join(root, s.subdir || ''), s.dockerfile, s.type, templatesDir); recipe = r && r.file;
      generated = !!(recipe && templatesDir && standardDockerfileType(path.join(root, s.subdir || ''), templatesDir, recipe)); } catch {}
    return { name: s.name, folder: s.subdir || '.', type: s.type, recipe, generated, port: s.port || null, hostPort: s.hostPort || null };
  });
  return { version: 1, advisory: true, analyzedAt: new Date().toISOString(), fingerprint: scan.fingerprint, ready: true,
    scan: { complete: scan.complete, files: scan.files.length, textFiles: scan.texts.size, bytes: scan.bytes, skipped: scan.skipped, issues: scan.issues },
    selected: selected ? { kind: selected.kind, file: selected.file, ...(selected.files ? { files: selected.files, profiles: selected.profiles || [] } : {}) } : null, reason, selection: selection || null,
    candidates: candidates.map(c => ({ kind: c.kind, file: c.file, ...(c.files ? { files: c.files, profiles: c.profiles || [] } : {}), generated: !!c.generated, complete: c.topology ? c.topology.complete : true })),
    evidence, manifests, topology, services: servicePlans, blockers, warnings };
}
function persist(dir, plan) {
  const file = path.join(dir, '.deployment-plan.json');
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(plan, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
  return plan;
}
function analyzeResolvedTopology(topology) {
  return { file:topology.file, services:topology.services.map(s=>({...s, image:s.image==null?null:preview(s.image), command:s.command==null?null:preview(s.command),entrypoint:s.entrypoint==null?null:preview(s.entrypoint)})),envNeeds:topology.envNeeds.map(e=>({key:e.key,required:e.required,services:e.services})) };
}
module.exports = { analyze, persist, references, analyzeResolvedTopology };
