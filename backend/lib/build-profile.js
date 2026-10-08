const fs = require('fs');
const path = require('path');

function isJekyll(paths, pkg, gemfile = '') {
  const files = new Set(paths || []);
  if (!files.has('Gemfile') || !files.has('_config.yml')) return false;
  if ((files.has('artisan') && files.has('composer.json')) || files.has('config.ru')) return false;
  const start = String(pkg && pkg.scripts && pkg.scripts.start || '');
  if (/(?:^|[;&|]\s*)(?:node|tsx|ts-node|nodemon)\s/.test(start) && !/\bjekyll\s+serve\b/.test(start)) return false;
  const build = String(pkg && pkg.scripts && pkg.scripts.build || '');
  return /\bjekyll\s+build\b/.test(build) || /^\s*gem\s+['"](?:jekyll|github-pages)['"]/m.test(gemfile) ||
    files.has('index.md') || files.has('_layouts') || files.has('_posts') || [...files].some(p => /^_(?:layouts|posts)\//.test(p));
}

function safeOutput(value) {
  const output = String(value || '_site').replace(/^\.\//, '').replace(/\/$/, '');
  if (!/^[A-Za-z0-9_./-]+$/.test(output) || output.startsWith('/') || output.split('/').some(p => !p || p === '..' || p === '.') || ['node_modules', 'vendor', '.git'].some(p => output.split('/').includes(p))) {
    throw new Error('static output must be a relative build folder inside the repository');
  }
  return output;
}

function buildProfile(paths, pkg, files = {}) {
  const declaredNode = String(files['.nvmrc'] || files['.node-version'] || pkg && pkg.engines && pkg.engines.node || '').trim();
  const ruby = String(files.Gemfile || '').match(/^\s*ruby\s+['"]([^'"]+)['"]/m);
  const declaredRuby = String(files['.ruby-version'] || ruby && ruby[1] || '').trim();
  if (!isJekyll(paths, pkg, files.Gemfile)) return { kind: null, declaredNode, declaredRuby, warnings: [] };
  const deps = { ...pkg && pkg.dependencies, ...pkg && pkg.devDependencies };
  const build = String(pkg && pkg.scripts && pkg.scripts.build || '');
  const commandOutput = build.match(/\bjekyll\s+build\b[^;&|]*\s(?:--destination|-d)\s+['"]?([A-Za-z0-9_./-]+)/);
  const configOutput = String(files['_config.yml'] || '').match(/^destination:\s*['"]?([A-Za-z0-9_./-]+)['"]?\s*(?:#.*)?$/m);
  const output = safeOutput(commandOutput && commandOutput[1] || configOutput && configOutput[1] || '_site');
  const oldWebpack = /^[~^]?5\.(\d+)\./.exec(String(deps.webpack || ''));
  const legacySass = !!deps['node-sass'];
  const legacyWebpack = !!(oldWebpack && Number(oldWebpack[1]) < 61);
  const legacyRubyLock = /BUNDLED WITH\s+1\./.test(String(files['Gemfile.lock'] || ''));
  const blockedReason = legacySass && Object.values(pkg && pkg.scripts || {}).some(s => /\bnode-sass\b/.test(s))
    ? 'Migrate node-sass CLI scripts to Sass in the repository; build-only package replacement cannot safely rewrite commands.' : '';
  const warnings = [];
  if (declaredNode) warnings.push(`Repository Node: ${declaredNode}. Standard Jekyll build uses Node 24.`);
  if (declaredRuby) warnings.push(`Repository Ruby: ${declaredRuby}. Standard Jekyll build uses Ruby 3.3.`);
  if (legacySass || legacyWebpack || legacyRubyLock) warnings.push('Legacy build dependencies need modernization. Enable the build-only compatibility option.');
  if (legacyRubyLock) warnings.push('Legacy Ruby lockfile: build-only modernization refreshes gems within the Gemfile constraints.');
  if (blockedReason) warnings.push(blockedReason);
  return { kind: 'jekyll', type: 'static', output, usesNode: !!pkg, declaredNode, declaredRuby, legacySass, legacyWebpack, legacyRubyLock, needsModernization: legacySass || legacyWebpack || legacyRubyLock, blockedReason, warnings };
}

function readBuildProfile(ctxDir) {
  let paths = [], pkg = null;
  try { paths = fs.readdirSync(ctxDir); } catch { return buildProfile([], null); }
  const files = {};
  for (const name of ['Gemfile', 'Gemfile.lock', '_config.yml', '.nvmrc', '.node-version', '.ruby-version', 'package.json']) {
    try {
      const stat = fs.lstatSync(path.join(ctxDir, name));
      if (stat.isFile() && stat.size <= 128 * 1024) files[name] = fs.readFileSync(path.join(ctxDir, name), 'utf8');
    } catch {}
  }
  try { pkg = JSON.parse(files['package.json']); } catch {}
  return buildProfile(paths, pkg, files);
}

function recipeText(profile, templatesDir, modernize = false) {
  return fs.readFileSync(path.join(templatesDir, 'static', 'builders', 'jekyll.Dockerfile'), 'utf8')
    .replace('ARG MINIPASS_STATIC_OUTPUT=_site', 'ARG MINIPASS_STATIC_OUTPUT=' + safeOutput(profile.output))
    .replace('ARG MINIPASS_MODERNIZE=0', 'ARG MINIPASS_MODERNIZE=' + (modernize ? '1' : '0'));
}

const normalizeRecipe = text => text.replace(/\r\n/g, '\n').trim()
  .replace(/^ARG MINIPASS_STATIC_OUTPUT=[A-Za-z0-9_./-]+$/m, 'ARG MINIPASS_STATIC_OUTPUT=_site')
  .replace(/^ARG MINIPASS_MODERNIZE=[01]$/m, 'ARG MINIPASS_MODERNIZE=0');

function staticRecipeOwnership(ctxDir, templatesDir, profile = readBuildProfile(ctxDir)) {
  const names = fs.readdirSync(ctxDir);
  if (names.some(f => /^dockerfile$/i.test(f) && f !== 'Dockerfile')) return 'custom';
  if (!names.includes('Dockerfile')) return 'missing';
  const file = path.join(ctxDir, 'Dockerfile');
  if (!fs.lstatSync(file).isFile()) return 'custom';
  const current = fs.readFileSync(file, 'utf8');
  const { standardDockerfileType } = require('./dockerfiles');
  return standardDockerfileType(ctxDir, templatesDir) || normalizeRecipe(current) === normalizeRecipe(recipeText(profile, templatesDir)) ? 'standard' : 'custom';
}

function localBuildProfile(ctxDir, templatesDir) {
  const profile = readBuildProfile(ctxDir);
  if (profile.kind !== 'jekyll') return profile;
  const customDockerfile = staticRecipeOwnership(ctxDir, templatesDir, profile) === 'custom';
  return { ...profile, customDockerfile, needsModernization: profile.needsModernization && !customDockerfile };
}

function prepareStaticBuild(ctxDir, templatesDir, { modernize = false } = {}) {
  const profile = readBuildProfile(ctxDir);
  if (profile.kind !== 'jekyll') return { profile, prepared: false };
  const ownership = staticRecipeOwnership(ctxDir, templatesDir, profile);
  if (ownership === 'custom') return { profile, prepared: false, custom: true };
  if (profile.blockedReason) throw new Error(profile.blockedReason);
  if (profile.needsModernization && !modernize) throw new Error('Jekyll static build needs modernization - enable Modernize legacy build dependencies in New website or Setup');
  const file = path.join(ctxDir, 'Dockerfile');
  const wanted = recipeText(profile, templatesDir, modernize);
  const current = ownership === 'missing' ? null : fs.readFileSync(file, 'utf8');
  if (current !== wanted) fs.writeFileSync(file, wanted);
  return { profile, prepared: true };
}

module.exports = { isJekyll, buildProfile, readBuildProfile, localBuildProfile, safeOutput, recipeText, prepareStaticBuild, normalizeRecipe, staticRecipeOwnership };
