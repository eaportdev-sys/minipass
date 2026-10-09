const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const repair = require('./import-repair');
const dirs = [];
function fixture(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minipass-import-repair-'));
  dirs.push(root);
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  }
  return root;
}
const original = {
  'src/common/i18n.ts': 'import { isProduction } from "./utils";\r\nconst untouched = "./utils";\r\nexport const debug = !isProduction;\r\n',
  'src/components/tools/Forms.tsx': "import React from 'react';\nimport { isProduction as prod } from '../../common/utils';\nexport const Tool = prod ? () => null : React.lazy(() => import('tools'));\n",
  'src/components/tools/Router.tsx': 'import { isProduction } from "../../common/utils";\nexport const enabled = !isProduction;\n',
  'src/components/tools/Table.tsx': 'import {\n  isProduction\n} from "../../common/utils";\n// import { fake } from "../../common/utils";\nexport const enabled = !isProduction;\n',
  'src/common/utilities.ts': 'export const isProduction = import.meta.env.MODE === "production";\n',
  Dockerfile: 'FROM nginx\n', 'package.json': '{"scripts":{"build":"tsc && vite build"}}', 'pnpm-lock.yaml': 'lockfileVersion: 9.0\n'
};
function actionable(root) { return repair.suggest(root).filter(s => s.key); }
function read(root, file) { return fs.readFileSync(path.join(root, file), 'utf8'); }
try {
  let root = fixture(original);
  let suggestions = actionable(root);
  assert.equal(suggestions.length, 1);
  const suggestion = suggestions[0];
  assert.equal(suggestion.kind, 'import-repair');
  assert.equal(suggestion.files.length, 4, 'all four imports share one previewed repair');
  assert(suggestion.detail.includes('isProduction') && suggestion.detail.includes('only eligible scanned module'));
  assert(suggestion.preview.includes('+++ b/src/common/i18n.ts') && suggestion.preview.includes('common/utilities'));
  assert.equal(suggestion.revision.length, 64);
  assert.equal(read(root, 'src/common/i18n.ts'), original['src/common/i18n.ts'], 'suggestion is read-only');
  const result = repair.apply(root, suggestion);
  assert.deepEqual(result.applied, suggestion.files);
  assert.equal(result.nextDeploy, 'local');
  assert.equal(read(root, 'src/common/i18n.ts'), original['src/common/i18n.ts'].replace('from "./utils"', 'from "./utilities"'), 'only the import literal changes; CRLF and runtime strings survive');
  assert(read(root, 'src/components/tools/Forms.tsx').includes("isProduction as prod } from '../../common/utilities'"), 'matching uses imported names, not local aliases');
  assert(read(root, 'src/components/tools/Table.tsx').includes('// import { fake } from "../../common/utils";'), 'commented imports stay untouched');
  for (const file of result.applied) assert.equal(read(result.backup, file), original[file], 'original source preserved: ' + file);
  for (const file of ['src/common/utilities.ts', 'Dockerfile', 'package.json', 'pnpm-lock.yaml']) assert.equal(read(root, file), original[file]);
  assert.equal(actionable(root).length, 0, 'repair disappears once imports resolve');
  assert.throws(() => repair.apply(root, suggestion), /changed/);

  for (const file of ['src/common/i18n.ts', 'src/common/utilities.ts']) {
    root = fixture(original);
    const stale = actionable(root)[0];
    fs.appendFileSync(path.join(root, file), '// changed after preview\n');
    assert.throws(() => repair.apply(root, stale), /changed/);
    assert(read(root, 'src/components/tools/Forms.tsx').includes('common/utils'), 'stale approval cannot edit any file');
  }
  root = fixture(original);
  const onceUnique = actionable(root)[0];
  fs.writeFileSync(path.join(root, 'src/common/other.ts'), 'export const isProduction = true;\n');
  assert.equal(actionable(root).length, 0);
  assert(repair.suggest(root)[0].detail.includes('Multiple modules'));
  assert.throws(() => repair.apply(root, onceUnique), /changed/);

  for (const candidate of [
    '// export const isProduction = true;\nconst x = "export const isProduction = true";\n',
    'export type isProduction = boolean;\n',
    'export { isProduction } from "./somewhere";\n',
    'declare const isProduction: boolean;\nexport { isProduction };\n'
  ]) {
    root = fixture({ ...original, 'src/common/utilities.ts': candidate });
    assert.equal(actionable(root).length, 0, 'comments, strings, types, ambient declarations and re-exports cannot establish a value implementation');
  }
  root = fixture({ ...original, 'src/common/utilities.ts': 'const actual = true;\nexport { actual as isProduction };\n' });
  assert.equal(actionable(root).length, 1, 'a verified local export alias is supported');
  root = fixture({ ...original, 'src/common/utilities.ts': 'import { debug } from "./i18n";\nexport const isProduction = !debug;\n' });
  assert.equal(actionable(root).length, 0, 'repair cannot introduce a direct import cycle');
  root = fixture({ ...original, 'src/common/utilities.ts': 'export const isProduction = true;\nexport const another = 1;\n',
    'src/common/i18n.ts': 'import { isProduction, missingOther } from "./utils";\n' });
  assert.equal(actionable(root).length, 0, 'one candidate must declare every required symbol');
  for (const extra of ['import * as utils from "./utils";', 'import utils from "./utils";', 'export { isProduction } from "./utils";']) {
    root = fixture({ ...original, 'src/common/i18n.ts': original['src/common/i18n.ts'] + extra });
    assert.equal(actionable(root).length, 0, 'a group with an unsupported import form cannot be partially repaired');
  }
  root = fixture({ 'use.ts': 'import type { Settings as Config } from "./missing";\n', 'actual.ts': 'export interface Settings { port: number }\n' });
  assert.equal(actionable(root).length, 1, 'type-only imports match declared types');
  root = fixture({ 'use.ts': 'import { ready } from "./missing.js";\n', 'actual.ts': 'export const ready = true;\n' });
  assert(actionable(root)[0].preview.includes('from "./actual.js"'), 'NodeNext-style .js import suffix stays .js');
  root = fixture({ 'use.ts': 'import { ready } from "@/missing";\n', 'actual.ts': 'export const ready = true;\n' });
  assert.equal(actionable(root).length, 0, 'non-relative aliases require configuration-aware analysis, not a guessed rewrite');
  root = fixture({ ...original, 'src/common/utils.ts': 'export const isProduction = false;\n' });
  assert.equal(actionable(root).length, 0, 'existing source modules are never replaced');
  root = fixture({
    'package.json': '{"scripts":{"postinstall":"prisma generate"}}',
    'prisma/schema.prisma': 'generator client {\n  provider = "prisma-client"\n  output = "../src/generated/prisma"\n}\n',
    'src/config/prisma.config.ts': 'import { PrismaClient } from "../generated/prisma/client";\nexport const prisma = new PrismaClient();\n'
  });
  assert.equal(repair.suggest(root).length, 0, 'declared Prisma generator output is not misreported as a missing source module');
  root = fixture(original);
  assert(!repair.suggest(root, { ...repair.LIMITS, files: 1 }).some(s => s.key), 'incomplete source scans refuse edits');
  root = fixture({ ...original, 'broken.ts': 'export const broken = (\n' });
  assert.equal(actionable(root).length, 0, 'unparseable source can hide competing exports, so no confident match is claimed');

  root = fixture(original);
  const rollbackPlan = actionable(root)[0];
  const rename = fs.renameSync;
  let writes = 0;
  fs.renameSync = (from, to) => {
    if (String(from).includes('.minipass-import-') && !String(from).includes('rollback') && ++writes === 2) throw new Error('simulated rename failure');
    return rename(from, to);
  };
  try { assert.throws(() => repair.apply(root, rollbackPlan), /simulated rename failure/); }
  finally { fs.renameSync = rename; }
  for (const file of rollbackPlan.files) assert.equal(read(root, file), original[file], 'multi-file failure restores earlier edits');
  assert.equal(actionable(root).length, 1, 'failed repair remains available after rollback');
  assert.equal(repair.apply(root, rollbackPlan).applied.length, 4, 'retry reuses only byte-identical backups');

  root = fixture(original);
  const outside = fixture({ 'export.ts': 'export const isProduction = true;\n' });
  fs.symlinkSync(outside, path.join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(actionable(root).length, 0, 'source symlinks make the scan incomplete instead of following external files');
  fs.unlinkSync(path.join(root, 'linked'));
  const safe = actionable(root)[0];
  const sink = fixture({});
  const backupRoot = path.join(outside, 'backup-link');
  fs.symlinkSync(sink, backupRoot, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => repair.apply(root, safe, { backupRoot }), /real directories/);
  assert(!fs.existsSync(path.join(sink, safe.revision)), 'no directories or files are created through a backup symlink');
  fs.unlinkSync(backupRoot);
  console.log('Import repair: four-file exact diffs, actual named exports, alias/type handling, read-only ambiguity guidance, bounded/symlink/stale guards, backup preservation and rollback/retry: OK');
} finally {
  for (const root of dirs) fs.rmSync(root, { recursive: true, force: true });
}
