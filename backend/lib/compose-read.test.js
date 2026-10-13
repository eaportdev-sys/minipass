const assert = require('assert');
const { readComposeTopo, envRefs, parsePort } = require('./compose-read');

const yaml = `# Dokploy Compose entrypoint.
services:
  db:
    image: postgres:17-alpine
    restart: unless-stopped
    environment:
      POSTGRES_DB: clinic
      POSTGRES_USER: clinic
      POSTGRES_PASSWORD: \${POSTGRES_PASSWORD:?Set POSTGRES_PASSWORD}
    volumes:
      - postgres_data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U clinic -d clinic"]
    networks: [internal]
  migrate:
    build: ./services/api
    command: ["node", "src/migrate.mjs"]
    restart: "no"
    environment:
      DATABASE_URL: \${DATABASE_URL:?Set DATABASE_URL}
    depends_on:
      db: {condition: service_healthy}
    networks: [internal]
  api:
    build: ./services/api
    restart: unless-stopped
    environment:
      DATABASE_URL: \${DATABASE_URL:?Set DATABASE_URL}
      APP_ORIGIN: https://\${CLINIC_DOMAIN:?Set CLINIC_DOMAIN}
      PORT: "4000"
      DATA_ENC_KEY: \${DATA_ENC_KEY:-}
      SKIP_EMAIL_VERIFICATION: \${SKIP_EMAIL_VERIFICATION:-}
    expose: ["4000"]
    depends_on:
      migrate: {condition: service_completed_successfully}
  web:
    build:
      context: .
      dockerfile: Dockerfile.web
    ports:
      - "8000:3000"
    depends_on: [api]
`;
const fs = require('fs');
const os = require('os');
const path = require('path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'minipass-compose-'));
try {
  fs.writeFileSync(path.join(tmp, 'compose.yaml'), yaml);
  const topo = readComposeTopo(tmp);
  assert.equal(topo.file, 'compose.yaml');
  assert.deepEqual(topo.services.map(s => s.name), ['db', 'migrate', 'api', 'web']);
  const byName = Object.fromEntries(topo.services.map(s => [s.name, s]));
  assert.equal(byName.migrate.oneShot, true, 'completion dependency identifies a required one-shot task');
  assert.equal(byName.api.oneShot, false);
  assert.deepEqual(byName.migrate.command, ['node', 'src/migrate.mjs']);
  assert.deepEqual(byName.web.build, { context: '.', dockerfile: 'Dockerfile.web', target: null, args: [], inline: false });
  assert.deepEqual(byName.migrate.build, { context: './services/api', dockerfile: null });
  assert.deepEqual(byName.web.ports, [{ host: 8000, container: 3000 }]);
  assert.deepEqual(byName.api.dependsOn, ['migrate']);
  const needs = Object.fromEntries(topo.envNeeds.map(e => [e.key, e]));
  assert.equal(needs.DATABASE_URL.required, true);
  assert.equal(needs.DATABASE_URL.message, 'Set DATABASE_URL');
  assert(needs.DATABASE_URL.services.includes('migrate') && needs.DATABASE_URL.services.includes('api'));
  assert.equal(needs.CLINIC_DOMAIN.required, true, 'nested ref inside a value counts');
  assert.equal(needs.DATA_ENC_KEY.required, false, ':- default is optional');
  assert(!needs.POSTGRES_DB, 'plain values are not needs');
  // Malformed input is explicitly incomplete, never a pretend-success subset.
  fs.writeFileSync(path.join(tmp, 'compose.yaml'), 'services:\n  a:\n   :::bad indent\n  b: [unclosed\n');
  const partial = readComposeTopo(tmp);
  assert(partial && Array.isArray(partial.services));
  assert.equal(partial.complete, false);
  assert(partial.errors.length);
  fs.writeFileSync(path.join(tmp, 'compose.yaml'), 'services:\n  api:\n    image: node\n    image: nginx\n');
  assert.equal(readComposeTopo(tmp).complete, false, 'duplicate keys are not silently accepted');
  fs.writeFileSync(path.join(tmp, 'compose.yaml'), 'x-base: &base\n  image: node\nservices:\n  api:\n    <<: *base\n    restart: "no"\n    environment:\n      OPT: ${X:-default}\n      REQUIRED: ${X:?must set}\n');
  const merged = readComposeTopo(tmp);
  assert.equal(merged.complete, true);
  assert.equal(merged.services[0].image, 'node');
  assert.equal(merged.services[0].oneShot, false, 'restart=no alone is not evidence of a migration task');
  assert.equal(merged.envNeeds.find(e => e.key === 'X').required, true, 'required occurrence wins over earlier optional occurrence');
  assert.equal(readComposeTopo(path.join(tmp, 'nope')), null);
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }

assert.deepEqual(parsePort('"8000:3000"'), { host: 8000, container: 3000 });
assert.deepEqual(parsePort('4000'), { host: null, container: 4000 });
assert.deepEqual(parsePort('"8000:4000/tcp"'), { host: 8000, container: 4000 });
assert.equal(parsePort('bogus'), null);
const refs = envRefs('a=${X:?need it} b=$${ESCAPED} c=$Y d=${Z:-dflt}');
assert.deepEqual(refs.map(r => r.key).sort(), ['X', 'Y', 'Z']);
assert(refs.find(r => r.key === 'X').required && refs.find(r => r.key === 'X').message === 'need it');
assert(!refs.find(r => r.key === 'Z').required && refs.find(r => r.key === 'Z').def === 'dflt');
assert.deepEqual(parsePort('127.0.0.1:8000:3000'), { host: 8000, container: 3000 });
assert(envRefs('${INPUT?set it}').find(e => e.key === 'INPUT').allowEmpty);
assert(!envRefs('${INPUT:?set it}').find(e => e.key === 'INPUT').allowEmpty);
console.log('Compose topology: real YAML, aliases, duplicate-key failures, task dependencies, ports and required env: OK');
