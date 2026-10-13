const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { analyzeRepository, analyzeService } = require('./repo-analysis');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'minipass-repo-analysis-'));
const write = (p, text) => {
  const file = path.join(tmp, p);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof text === 'string' ? text : JSON.stringify(text));
};
try {
  write('package.json', { scripts: { start: 'node index.js' }, dependencies: { pg: '^8', express: '^4' } });
  write('index.js', 'console.log("hello")');
  assert.deepEqual(analyzeService(tmp, 'node', ''), { subdir: '', type: 'node', databaseNeeds: ['postgres'] });
  assert.equal(analyzeRepository(tmp).services[0].type, 'node');

  write('orm/prisma/schema.prisma', 'datasource db { provider = "postgresql" }');
  write('orm/package.json', { scripts: { start: 'node dist/server.js' }, dependencies: { '@prisma/client': '^5' } });
  assert.deepEqual(analyzeService(path.join(tmp, 'orm'), 'node', 'orm').databaseNeeds, ['postgres']);

  write('ui/package.json', { scripts: { build: 'vite build' }, dependencies: { react: '^19' } });
  write('ui/vite.config.js', 'export default {}');
  const multi = analyzeRepository(tmp).services;
  assert(multi.some(s => s.subdir === '' && s.type === 'node'), 'runnable root retained beside child services');
  assert(multi.some(s => s.subdir === 'ui' && s.type === 'react'));
  assert(multi.some(s => s.subdir === 'orm' && s.type === 'node'));

  write('workspace/package.json', { private: true, workspaces: ['client', 'server'], scripts: { build: 'npm run build --prefix client' } });
  write('workspace/client/package.json', { scripts: { build: 'vite build' }, dependencies: { react: '^19' } });
  write('workspace/client/vite.config.js', 'export default {}');
  write('workspace/server/package.json', { scripts: { start: 'node server.js' }, dependencies: { mysql2: '^3' } });
  write('workspace/server/server.js', 'process.env.PORT;');
  const ws = path.join(tmp, 'workspace');
  fs.copyFileSync(path.resolve(__dirname, '../../templates/react/Dockerfile'), path.join(ws, 'Dockerfile'));
  assert.deepEqual(analyzeRepository(ws).services.map(s => s.subdir).sort(), ['client', 'server'], 'panel seed never makes workspace root a runtime');

  write('schema/package.json', { scripts: { start: 'node index.js' } });
  write('schema/drizzle.config.ts', 'export default { dialect: "mysql" };');
  write('schema/db/export.sql', '-- MariaDB dump\nCREATE TABLE x (id int);');
  assert.deepEqual(analyzeService(path.join(tmp, 'schema'), 'node', 'schema').databaseNeeds.sort(), ['mariadb', 'mysql']);

  for (const [folder, file, type] of [['html', 'index.html', 'static'], ['php', 'index.php', 'php']]) {
    write(`${folder}/${file}`, 'starter');
    assert.equal(analyzeRepository(path.join(tmp, folder)).services[0].type, type);
  }
  write('next/package.json', { scripts: { start: 'next start' }, dependencies: { next: '^16', react: '^19' } });
  const custom = 'FROM node:24\nWORKDIR /app\nCOPY . .\nRUN next build\nCMD ["node","server.js"]\n';
  write('next/Dockerfile', custom);
  assert.equal(analyzeRepository(path.join(tmp, 'next')).services[0].type, 'node');
  assert.equal(fs.readFileSync(path.join(tmp, 'next/Dockerfile'), 'utf8'), custom, 'analysis never rewrites repository files');

  write('skip/node_modules/dep/package.json', { scripts: { start: 'node x.js' }, dependencies: { pg: '^8' } });
  assert.deepEqual(analyzeRepository(path.join(tmp, 'skip')).services, [], 'dependencies are not sites');
  write('symlink/package.json', { scripts: { start: 'node index.js' } });
  write('symlink/drizzle.config.ts', 'x'.repeat(257 * 1024) + 'export default { dialect: "mysql" };');
  assert.deepEqual(analyzeService(path.join(tmp, 'symlink'), 'node', 'symlink').databaseNeeds, [], 'oversized inputs skipped');
  console.log('Repository analysis: used service/database inference retained; no report engine or file mutations: OK');
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
