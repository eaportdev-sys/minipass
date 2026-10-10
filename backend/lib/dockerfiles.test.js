const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { refreshStandardDockerfile } = require('./dockerfiles');
const templates = path.resolve(__dirname, '../../templates');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'minipass-native-build-'));
try {
  for (const type of ['node', 'react']) {
    // Scaffolding only: normalize checkout line endings so the derived legacy
    // fixture matches on Windows (CRLF) exactly as on Linux (LF).
    const template = fs.readFileSync(path.join(templates, type, 'Dockerfile'), 'utf8').replace(/\r\n/g, '\n');
    assert(template.startsWith('# minipass template'));
    assert(template.includes('FROM node:22-alpine'), 'standard Node build uses the supported Node 22 line');
    for (const tool of ['python3', 'build-base', 'autoconf', 'automake', 'libtool', 'nasm']) assert(template.includes(tool));
    assert(template.indexOf('RUN apk add') < template.indexOf('RUN npm install'), 'tools precede dependency installation');
    assert(template.indexOf('COPY . .') < template.indexOf('RUN npm install'), 'source and Prisma schemas are available to install lifecycle scripts');
    assert(!/RUN npm (?:i|install).*\|\| true/.test(template), 'install failures must abort the build');
    const old = template.replace('FROM node:22-alpine', 'FROM node:20-alpine')
      .replace(/^# Native npm.*\r?\n/m, '').replace(/^# Build tools.*\r?\n/m, '').replace(/^RUN apk add.*\r?\n/m, '')
      .replace(/^# Copy source before install because repository lifecycle scripts may need\r?\n/m, '').replace(/^# Prisma schemas, generator configs, workspace files, or other project assets\.\r?\n/m, '')
      .replace('COPY . .\nRUN npm install', 'COPY package*.json ./\nRUN npm install\nCOPY . .')
      .replace(type === 'node' ? /^# minipass template\r?\n/ : /$^/, '').replace(type === 'react' ? 'RUN npm install' : /$^/, 'RUN npm i || true');
    const folder = path.join(tmp, type, 'subdir');
    fs.mkdirSync(folder, { recursive: true });
    const file = path.join(folder, 'Dockerfile');
    assert.equal(refreshStandardDockerfile(folder, type, templates), 'missing');
    fs.writeFileSync(file, old.replace(/\r?\n/g, '\r\n'));
    assert.equal(refreshStandardDockerfile(folder, type, templates), 'updated', 'legacy files upgrade regardless of Windows line endings');
    assert.equal(fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n'), template);
    assert.equal(refreshStandardDockerfile(folder, type, templates), 'current', 'upgrade is idempotent');
    const previous = template
      .replace('FROM node:22-alpine', 'FROM node:20-alpine')
      .replace('COPY . .\n# Copy source before install because repository lifecycle scripts may need\n# Prisma schemas, generator configs, workspace files, or other project assets.\nRUN npm install', 'COPY package*.json ./\nRUN npm install\nCOPY . .');
    fs.writeFileSync(file, previous);
    assert.equal(refreshStandardDockerfile(folder, type, templates), 'updated', 'previous panel template upgrades for Node 22 and lifecycle build context');
    assert.equal(fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n'), template);
    const custom = template + '\nRUN echo custom-build\n';
    fs.writeFileSync(file, custom);
    assert.equal(refreshStandardDockerfile(folder, type, templates), 'custom', 'retained marker does not authorize rewriting custom files');
    assert.equal(fs.readFileSync(file, 'utf8'), custom);
    fs.writeFileSync(file, 'FROM node:22\nRUN echo repository-owned\n');
    assert.equal(refreshStandardDockerfile(folder, type, templates), 'custom');
    if (type === 'react') assert(!template.split('FROM nginx:alpine')[1].includes('apk add'), 'React runtime does not contain the toolchain');
  }
  const simple = 'FROM node:20-alpine\nWORKDIR /app\nCOPY package*.json ./\nRUN npm i --omit=dev || true\nCOPY . .\nEXPOSE 3000\nCMD ["node", "index.js"]\n';
  fs.writeFileSync(path.join(tmp, 'node', 'subdir', 'Dockerfile'), simple);
  assert.equal(refreshStandardDockerfile(path.join(tmp, 'node', 'subdir'), 'node', templates), 'updated');
  console.log('native npm toolchain and exact-match standard Dockerfile upgrades: OK');
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
