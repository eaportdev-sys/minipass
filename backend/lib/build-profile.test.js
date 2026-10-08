const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { buildProfile, readBuildProfile, localBuildProfile, prepareStaticBuild, safeOutput, recipeText } = require('./build-profile');
const { decideType, findFrontends, findBackends } = require('./detect');
const { ensureDockerfile, needsDockerfileOptIn } = require('./generator');
const svc = require('./services');
const templates = path.resolve(__dirname, '../../templates');
const paths = ['package.json', 'Gemfile', 'Gemfile.lock', '_config.yml', '_layouts/default.html', '.nvmrc'];
const pkg = { scripts: { start: 'webpack && bundle exec jekyll serve', build: 'webpack && bundle exec jekyll build' }, devDependencies: { 'node-sass': '^6.0.1', 'sass-loader': '^12.1.0', webpack: '^5.55.1' } };
const files = { Gemfile: 'gem "jekyll", "4.2.1"', 'Gemfile.lock': 'BUNDLED WITH\n   1.17.2\n', '.nvmrc': 'v14.18.0\n', '_config.yml': 'title: Site\n' };
const profile = buildProfile(paths, pkg, files);
assert.equal(decideType(paths, pkg).type, 'static');
assert.equal(profile.kind, 'jekyll');
assert.equal(profile.output, '_site');
assert.equal(profile.declaredNode, 'v14.18.0');
assert(profile.legacySass && profile.legacyWebpack && profile.legacyRubyLock && profile.needsModernization);
assert.equal(buildProfile(['Gemfile', '_config.yml'], null, { Gemfile: 'gem "jekyll"' }).kind, 'jekyll');
assert.equal(buildProfile(['Gemfile', '_config.yml'], null, { Gemfile: 'gem "rails"' }).kind, null);
assert.equal(buildProfile([...paths, 'composer.json', 'artisan'], pkg, files).kind, null);
assert.equal(decideType([...paths, 'composer.json', 'artisan'], pkg).type, 'php');
assert.equal(buildProfile([...paths, 'config.ru'], pkg, files).kind, null);
assert.equal(buildProfile(paths, { ...pkg, scripts: { start: 'node server.js' } }, files).kind, null);
assert.equal(buildProfile(['package.json', 'docs/Gemfile', 'docs/_config.yml'], pkg, files).kind, null, 'nested docs never retype an API');
assert.equal(buildProfile(paths, { ...pkg, engines: { node: '>=22' } }, { Gemfile: files.Gemfile }).declaredNode, '>=22');
assert.equal(buildProfile(paths, pkg, { ...files, '_config.yml': 'destination: "public/site" # build folder' }).output, 'public/site');
assert.equal(buildProfile(paths, { ...pkg, scripts: { build: 'jekyll build --destination output' } }, files).output, 'output');
for (const bad of ['../site', '/site', '.', 'foo/../site', 'foo//bar', 'x;touch', 'node_modules/site', '.git']) assert.throws(() => safeOutput(bad));
assert(buildProfile(paths, { ...pkg, scripts: { build: 'node-sass src -o assets && jekyll build' } }, files).blockedReason);
assert.equal(buildProfile(paths, { ...pkg, devDependencies: { webpack: '^5.99.9', sass: '^1.93.2' } }, { Gemfile: files.Gemfile }).needsModernization, false);
const nested = paths.map(p => 'docs/' + p);
assert.deepEqual(findBackends(nested, { docs: pkg }), []);
assert(findFrontends(nested, { docs: pkg }).includes('docs'));

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'minipass-jekyll-test-'));
try {
  const ctx = path.join(temp, 'code');
  fs.mkdirSync(ctx);
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(ctx, name), text);
  const manifest = JSON.stringify(pkg, null, 2);
  fs.writeFileSync(path.join(ctx, 'package.json'), manifest);
  assert.equal(readBuildProfile(ctx).kind, 'jekyll');
  assert.equal(svc.detectServiceType(ctx).type, 'static');
  assert.equal(needsDockerfileOptIn(ctx, 'static'), false);
  assert.throws(() => ensureDockerfile(ctx, 'static', templates), /needs modernization/);
  assert(!fs.readdirSync(ctx).includes('Dockerfile'));
  ensureDockerfile(ctx, 'static', templates, { modernize: true });
  const recipe = fs.readFileSync(path.join(ctx, 'Dockerfile'), 'utf8');
  assert(recipe.includes('node:24-bookworm-slim'));
  assert(recipe.includes('ruby:3.3-bookworm'));
  assert(recipe.includes('ARG MINIPASS_MODERNIZE=1'));
  assert(recipe.includes('COPY --from=build /site-output /usr/share/nginx/html'));
  assert(recipe.includes('bundle update --all --bundler=2.6.9'));
  assert.equal(fs.readFileSync(path.join(ctx, 'package.json'), 'utf8'), manifest);
  assert.equal(fs.readFileSync(path.join(ctx, 'Gemfile.lock'), 'utf8'), files['Gemfile.lock']);
  assert(fs.existsSync(path.join(ctx, 'nginx.conf')));
  prepareStaticBuild(ctx, templates, { modernize: true });
  assert.equal(fs.readFileSync(path.join(ctx, 'Dockerfile'), 'utf8'), recipe, 'idempotent rebuild');
  fs.writeFileSync(path.join(ctx, '_config.yml'), 'destination: public/site\n');
  prepareStaticBuild(ctx, templates, { modernize: true });
  assert(fs.readFileSync(path.join(ctx, 'Dockerfile'), 'utf8').includes('ARG MINIPASS_STATIC_OUTPUT=public/site'));
  for (const type of ['node', 'react', 'static']) {
    fs.copyFileSync(path.join(templates, type, 'Dockerfile'), path.join(ctx, 'Dockerfile'));
    assert(prepareStaticBuild(ctx, templates, { modernize: true }).prepared, 'convert unchanged ' + type + ' recipe');
  }
  const custom = recipe + '\n# customer edit\nRUN echo custom\n';
  fs.writeFileSync(path.join(ctx, 'Dockerfile'), custom);
  assert(prepareStaticBuild(ctx, templates).custom);
  assert.equal(fs.readFileSync(path.join(ctx, 'Dockerfile'), 'utf8'), custom);
  assert(localBuildProfile(ctx, templates).customDockerfile);
  assert.equal(localBuildProfile(ctx, templates).needsModernization, false, 'custom recipes need no panel compatibility opt-in');
  fs.unlinkSync(path.join(ctx, 'Dockerfile'));
  fs.writeFileSync(path.join(ctx, 'dockerfile'), recipe);
  assert(prepareStaticBuild(ctx, templates).custom);
  assert(!fs.readdirSync(ctx).includes('Dockerfile'));
  fs.unlinkSync(path.join(ctx, 'dockerfile'));
  const outside = path.join(temp, 'outside-Dockerfile');
  fs.writeFileSync(outside, recipe);
  let linked = false;
  try { fs.symlinkSync(outside, path.join(ctx, 'Dockerfile')); linked = true; }
  catch (e) { if (!['EPERM', 'EACCES'].includes(e.code)) throw e; }
  if (linked) {
    assert(prepareStaticBuild(ctx, templates).custom, 'never write through repository Dockerfile symlinks');
    assert.equal(fs.readFileSync(outside, 'utf8'), recipe);
    fs.unlinkSync(path.join(ctx, 'Dockerfile'));
  }
  fs.writeFileSync(path.join(ctx, 'Dockerfile'), recipe);
  fs.writeFileSync(path.join(temp, 'docker-compose.yml'), 'services:\n  app:\n    build:\n      context: ./code\n    ports:\n      - "8010:3000"\n  db:\n    image: postgres:16\n    volumes:\n      - dbdata:/var/lib/postgresql/data\n\nvolumes:\n  dbdata:\n');
  fs.writeFileSync(path.join(temp, '.env'), 'PORT=80\nHOST_PORT=8010\nDB_PASSWORD=retained\n');
  const meta = { type: 'static', buildOptions: { modernize: true }, services: [{ name: 'app', type: 'static', port: 80, hostPort: 8010, enabled: true }] };
  svc.renderProject({ dir: temp, templatesDir: templates, meta });
  const compose = fs.readFileSync(path.join(temp, 'docker-compose.yml'), 'utf8');
  assert(compose.includes('8010:80') && compose.includes('image: postgres:16') && compose.includes('dbdata:/var/lib/postgresql/data'));
  assert(fs.readFileSync(path.join(temp, '.env'), 'utf8').includes('DB_PASSWORD=retained'));

  // Execute the exact build-stage adapter, not a duplicate implementation.
  const adapter = recipeText(profile, templates, true).split('\n').find(l => l.includes('p=require(\'./package.json\')')).match(/node -e "(.*)"; fi$/)[1];
  let saved;
  const copy = JSON.parse(manifest);
  vm.runInNewContext(adapter, { require: name => name === 'fs' ? { writeFileSync: (_, value) => { saved = JSON.parse(value); } } : copy });
  assert.equal(saved.devDependencies['node-sass'], undefined);
  assert.equal(saved.devDependencies.sass, '^1.93.2');
  assert.equal(saved.devDependencies.webpack, '^5.99.9');
  assert.equal(saved.devDependencies['sass-loader'], '^12.1.0');
  const modern = { devDependencies: { sass: '^1.100.0', webpack: '^5.110.0', 'node-sass': '^6' } };
  vm.runInNewContext(adapter, { require: name => name === 'fs' ? { writeFileSync: (_, value) => { saved = JSON.parse(value); } } : modern });
  assert.equal(saved.devDependencies.sass, '^1.100.0');
  assert.equal(saved.devDependencies.webpack, '^5.110.0', 'no downgrade of newer Webpack');
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
console.log('Jekyll static detection, modern build-only adapters and source/custom recipe preservation: OK');
