const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const preflight = require('./preflight');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'minipass-preflight-'));
try {
  // Minimal Node service
  fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({
    name: 'test-api',
    scripts: { start: 'node index.js', build: 'tsc' },
    dependencies: { express: '^4.18.0', pg: '^8.11.0' }
  }));
  fs.writeFileSync(path.join(tmp, 'index.js'), 'console.log("hello")\n');
  fs.writeFileSync(path.join(tmp, '.env.example'), 'DATABASE_URL=postgresql://user:pass@localhost:5432/db\nJWT_SECRET=changeme\n');

  // Prisma service
  const prismaDir = path.join(tmp, 'prisma-service');
  fs.mkdirSync(prismaDir);
  fs.writeFileSync(path.join(prismaDir, 'package.json'), JSON.stringify({
    name: 'prisma-api',
    scripts: { postinstall: 'prisma generate', start: 'node dist/server.js', build: 'tsc' },
    dependencies: { '@prisma/client': '^5.0.0', express: '^4.18.0' },
    devDependencies: { prisma: '^5.0.0', typescript: '^5.0.0' }
  }));
  fs.mkdirSync(path.join(prismaDir, 'prisma'));
  fs.writeFileSync(path.join(prismaDir, 'prisma/schema.prisma'), 'datasource db {\n  provider = "postgresql"\n  url = env("DATABASE_URL")\n}\n');
  fs.writeFileSync(path.join(prismaDir, '.dockerignore'), 'node_modules\n.git\n');

  // React service
  const reactDir = path.join(tmp, 'frontend');
  fs.mkdirSync(reactDir);
  fs.writeFileSync(path.join(reactDir, 'package.json'), JSON.stringify({
    name: 'react-app',
    scripts: { build: 'vite build', start: 'vite preview' },
    dependencies: { react: '^18.0.0', 'react-dom': '^18.0.0' },
    devDependencies: { vite: '^5.0.0', '@vitejs/plugin-react': '^4.0.0' }
  }));
  fs.writeFileSync(path.join(reactDir, 'vite.config.js'), 'export default { plugins: [react()] }\n');

  // Test 1: Single Node service
  let analysis = preflight.analyzeRepository(tmp, 'node', '');
  assert(analysis.services.length === 1, 'single service');
  const nodeSvc = analysis.services[0];
  assert.equal(nodeSvc.type, 'node');
  assert(nodeSvc.requiredEnv.includes('DATABASE_URL'), 'detects DATABASE_URL');
  assert(nodeSvc.requiredEnv.includes('JWT_SECRET'), 'detects JWT_SECRET');
  assert.equal(nodeSvc.dockerfileStatus, 'missing', 'no dockerfile');
  assert.equal(nodeSvc.port, 3000, 'default node port');
  assert.equal(nodeSvc.startCmd, 'node index.js', 'start command');

  // Test 2: Prisma service
  analysis = preflight.analyzeRepository(prismaDir, 'node', '');
  const prismaSvc = analysis.services[0];
  assert(prismaSvc.buildTimeNeeds.includes('DATABASE_URL (Prisma generate)'), 'prisma build-time need');
  assert(prismaSvc.gitIgnored, 'detects .dockerignore excluding .git');
  assert.equal(prismaSvc.prismaHints[0], 'postgres', 'prisma provider detected');

  // Test 3: React service
  analysis = preflight.analyzeRepository(reactDir, 'react', '');
  const reactSvc = analysis.services[0];
  assert.equal(reactSvc.type, 'react');
  assert.equal(reactSvc.port, 80, 'react served on port 80');
  assert(reactSvc.buildCmd === 'vite build', 'vite build script');

  // Test 4: Multi-service detection (monorepo)
  analysis = preflight.analyzeRepository(tmp, null, null);
  assert(analysis.monorepo === true, 'monorepo detected');
  assert(analysis.services.length >= 2, 'multiple services found');
  const types = new Set(analysis.services.map(s => s.type));
  assert(types.has('node'), 'node service present');
  assert(types.has('react'), 'react service present');

  // Test 5: Readiness report for Node service
  const report = preflight.readinessReport(analysis);
  assert(report.blockers.some(b => b.code === 'NO_DOCKERFILE'), 'blocker for missing Dockerfile');
  assert(report.blockers.some(b => b.fix === 'use-standard-dockerfile'), 'fixable via standard template');

  // Test 6: Readiness report for Prisma service
  const prismaReport = preflight.readinessReport(preflight.analyzeRepository(prismaDir, 'node', ''));
  assert(prismaReport.blockers.some(b => b.code === 'BUILD_TIME_ENV' && b.message.includes('DATABASE_URL')), 'prisma build-time env blocker');
  assert(prismaReport.blockers.some(b => b.fix === 'build-arg-placeholder'), 'build arg placeholder fix available');

  // Test 7: Migrations detection
  fs.writeFileSync(path.join(tmp, 'knexfile.js'), 'module.exports = { development: { client: "pg", connection: { database: "db" } } }\n');
  const migAnalysis = preflight.analyzeService(tmp, 'node', '');
  assert(migAnalysis.migrationInfo.some(m => m.framework === 'Knex' && m.runnable), 'knex migration detected');

  console.log('Preflight analysis and readiness report: OK');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}