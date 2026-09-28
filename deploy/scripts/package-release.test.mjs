import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { packageRelease } from './package-release.mjs';
import { servedArtifactDigest } from '../server/artifact-digest.mjs';

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pinkuang-package-')));
  const deployDir = join(root, 'source', 'deploy'), outDir = join(root, 'release'), sourceHead = 'a'.repeat(40);
  const write = (name, body) => { const path = join(deployDir, name); mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, body); };
  const bundle = JSON.stringify({ sourceCommit: sourceHead, artifacts: { FirstoSale: {}, AtomicDeployment: {}, BudgetPortfolioFactory: {}, BudgetPortfolioVault: {} } });
  write('public/deployment-artifacts.json', bundle); write('dist/deployment-artifacts.json', bundle);
  const digest = servedArtifactDigest(join(deployDir, 'public/deployment-artifacts.json'));
  write('dist/assets/app.js', `const digest=${JSON.stringify(digest)};`); write('dist/index.html', '<script src="./assets/app.js"></script>');
  write('server/index.mjs', "import '../scripts/official-market-discovery.mjs';\nimport '../src/firsto-purchase.mjs';\nexport const ready=true;\n");
  write('shared/proof.mjs', 'export const proof=true;');
  write('scripts/official-market-discovery.mjs', 'export const readOnly=true;');
  write('scripts/budget-official-discovery.mjs', "import './official-market-discovery.mjs'; import './budget-multicall-read.mjs'; export const budgetReadOnly=true;");
  write('scripts/budget-multicall-read.mjs', 'export const batchReadOnly=true;');
  write('src/firsto-purchase.mjs', 'export const exchange=true;');
  write('package.json', '{"type":"module"}'); write('package-lock.json', '{}');
  return { deployDir, outDir, sourceHead, write, digest };
}

test('release directory includes runtime discovery and index artifact, with verifiable file hashes', () => {
  const f = fixture();
  f.write('scripts/purchase-keeper.mjs', 'throw new Error("must not package keeper");');
  const result = packageRelease(f), manifest = JSON.parse(readFileSync(join(f.outDir, 'release-manifest.json')));
  assert.equal(result.artifactDigest, f.digest); assert.equal(manifest.transactionCount, 16);
  assert.deepEqual(manifest.runtimeScripts, ['scripts/official-market-discovery.mjs','scripts/budget-official-discovery.mjs','scripts/budget-multicall-read.mjs']);
  assert.deepEqual(manifest.runtimeSources, ['src/firsto-purchase.mjs']);
  assert(!existsSync(join(f.outDir, 'scripts/purchase-keeper.mjs')));
  assert(existsSync(join(f.outDir, 'public/deployment-artifacts.json')));
  for (const [name, info] of Object.entries(manifest.files)) {
    const bytes = readFileSync(join(f.outDir, name));
    assert.equal(info.bytes, bytes.length); assert.equal(info.sha256, createHash('sha256').update(bytes).digest('hex'));
  }
  assert.throws(() => packageRelease(f), /already exists/);
});

test('packager refuses secret files and key contents before creating output', () => {
  for (const [name, content] of [['server/.env', 'TOKEN=private'], ['server/journal.sqlite', 'private'],
    ['dist/wallet.json', '{}'], ['dist/info.txt', '-----BEGIN PRIVATE KEY-----\nprivate']]) {
    const f = fixture(); f.write(name, content);
    assert.throws(() => packageRelease(f), /Private|Unsupported/);
    assert(!existsSync(f.outDir));
  }
});

test('packager refuses missing runtime imports, changed artifact and stale compiled digest', () => {
  for (const [name, body, expected] of [
    ['server/index.mjs', "import './missing-runtime.mjs';", /Missing packaged runtime/],
    ['dist/deployment-artifacts.json', '{}', /match public artifact/],
    ['dist/assets/app.js', 'const oldBuild=true;', /current artifact digest/],
  ]) { const f=fixture(); f.write(name, body); assert.throws(() => packageRelease(f), expected); assert(!existsSync(f.outDir)); }
});

test('packager requires a new absolute output outside the source checkout', () => {
  const f=fixture();
  assert.throws(() => packageRelease({ ...f, outDir:'relative-release' }), /absolute/);
  assert.throws(() => packageRelease({ ...f, outDir:join(f.deployDir, 'release') }), /outside/);
});
