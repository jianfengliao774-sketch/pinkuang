import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { packageFreshProductBackend, PRODUCT_BACKEND_MODULES } from '../../scripts/package-fresh-console.mjs';
import { servedArtifactDigest } from '../../server/artifact-digest.mjs';
import { freshIndexManifestBytes } from '../../server/chain-index/fresh-manifest.mjs';
import { prepareFreshProductBuild } from '../../../web/scripts/build-fresh-product.mjs';
import { fixture, addr } from './fresh-cutover-fixture.mjs';
import { verifyFreshReleasePair } from './verify-fresh-release-pair.mjs';

const deploy = fileURLToPath(new URL('../../', import.meta.url));
const sourceHead = 'a'.repeat(40);
const sha256 = value => createHash('sha256').update(value).digest('hex');
const write = (root, name, body) => {
  const path = join(root, name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
};

async function pairFixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pinkuang-v4-pair-test-')));
  const backendDir = join(root, 'backend'), frontendDir = join(root, 'frontend');
  const source = join(root, 'source/deploy');
  const input = fixture();
  const artifact = readFileSync(join(deploy, 'public/deployment-artifacts.json'));
  const sourceCommit = JSON.parse(artifact).sourceCommit;
  input.manifest = { ...input.manifest, sourceCommit, verifiedAt: new Date().toISOString() };
  for (const name of PRODUCT_BACKEND_MODULES)
    write(source, name, readFileSync(join(deploy, name)));
  write(source, 'public/deployment-artifacts.json', artifact);
  write(source, 'dist/deployment-artifacts.json', artifact);
  write(source, 'dist/assets/app.js', `const digest=${JSON.stringify(servedArtifactDigest(
    join(source, 'public/deployment-artifacts.json')))};`);
  write(source, 'dist/index.html', '<script src="./assets/app.js"></script>');
  write(source, 'dist/favicon.svg', '<svg xmlns="http://www.w3.org/2000/svg"/>');
  write(source, 'package.json', '{"type":"module"}');
  write(source, 'package-lock.json', '{}');
  await packageFreshProductBackend({ deployDir: source, outDir: backendDir,
    sourceHead, verifyGit: false, cutoverInput: input });

  const staticFiles = new Map([
    ['index.html', Buffer.from('<!doctype html><title>Fresh BEMine</title>')],
    ['data/frontend-manifest.v4.json', Buffer.from(`${JSON.stringify(input.manifest)}\n`)],
    ['_next/static/fresh.js', Buffer.from('console.log("fresh-v4")')],
  ]);
  for (const [name, bytes] of staticFiles) write(frontendDir, name, bytes);
  const names = [...staticFiles.keys()].sort();
  const contentSha256 = sha256(names.map(name =>
    `${name}\0${sha256(staticFiles.get(name))}\n`).join(''));
  const frontendRelease = { schemaVersion: 1, kind: 'fresh-v4-product-static-candidate', chainId: 56,
    ...prepareFreshProductBuild(input.manifest), frontendSourceHead: sourceHead,
    contentSha256, fileCount: names.length, legacyManifestIncluded: false,
    activationAllowed: false };
  write(frontendDir, 'fresh-product-release.json', `${JSON.stringify(frontendRelease)}\n`);
  return { root, backendDir, frontendDir, input, sourceCommit, sourceHead };
}

const verify = f => verifyFreshReleasePair({ frontendDir: f.frontendDir, backendDir: f.backendDir,
  cutoverInput: f.input, expectedSourceCommit: f.sourceCommit, expectedSourceHead: f.sourceHead });

test('binds actual fresh frontend and backend files to one disabled cutover plan', async () => {
  const f = await pairFixture();
  try {
    const plan = verify(f);
    assert.equal(plan.kind, 'fresh-v4-bound-cutover-draft');
    assert.equal(plan.activationAllowed, false);
    assert.equal(plan.releasePair.frontendFileCount, 3);
    assert.equal(plan.releasePair.factory, f.input.manifest.factory);
    assert.equal(plan.releasePair.gasWallet, f.input.expectedGasWallet);
    assert.equal(plan.releasePair.sourceHead, f.sourceHead);
    assert.equal(plan.releasePair.indexManifestSha256, plan.indexManifestSha256);
    assert.equal(plan.runtimeEnvironment.AUTHORITY_RELAY_ENABLED, '0');
    assert.equal(plan.purchaseEnvironment.FRESH_PURCHASE_ENABLED, '0');
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('rejects changed frontend, backend, symlink and source commits', async () => {
  const f = await pairFixture();
  try {
    assert.throws(() => verify({ ...f, sourceHead: 'b'.repeat(40) }), /Frontend build source HEAD/);
    const frontAsset = join(f.frontendDir, '_next/static/fresh.js');
    writeFileSync(frontAsset, 'tampered');
    assert.throws(() => verify(f), /frontend file inventory/);
    writeFileSync(frontAsset, 'console.log("fresh-v4")');
    const backendModule = join(f.backendDir, 'server/index.mjs');
    const original = readFileSync(backendModule);
    writeFileSync(backendModule, 'tampered');
    assert.throws(() => verify(f), /Backend file SHA256/);
    writeFileSync(backendModule, original);
    rmSync(frontAsset);
    symlinkSync(join(f.frontendDir, 'index.html'), frontAsset);
    assert.throws(() => verify(f), /symlink/);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('rejects self-consistent backend index substitution and frontend metadata substitution', async () => {
  const f = await pairFixture();
  try {
    const metaPath = join(f.frontendDir, 'fresh-product-release.json');
    const originalMeta = readFileSync(metaPath);
    const metadata = JSON.parse(originalMeta);
    writeFileSync(metaPath, JSON.stringify({ ...metadata, gasWallet: addr(98) }));
    assert.throws(() => verify(f), /Frontend release gasWallet/);
    writeFileSync(metaPath, originalMeta);

    const indexName = 'public/fresh-product-manifest.json';
    const indexPath = join(f.backendDir, indexName);
    const index = JSON.parse(readFileSync(indexPath));
    const substitute = { ...index, factory: addr(99) };
    const bytes = freshIndexManifestBytes(substitute);
    writeFileSync(indexPath, bytes);
    const releasePath = join(f.backendDir, 'public/fresh-release-manifest.json');
    const release = JSON.parse(readFileSync(releasePath));
    release.indexManifestSha256 = sha256(bytes);
    release.files[indexName] = { sha256: sha256(bytes), bytes: bytes.length };
    writeFileSync(releasePath, JSON.stringify(release));
    assert.throws(() => verify(f), /contract graph, backend index and cutover draft differ/);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('CLI writes one private disabled plan and refuses to overwrite it', async () => {
  const f = await pairFixture();
  try {
    const config = { ...f.input };
    for (const key of ['record', 'bundle', 'activation', 'manifest']) {
      config[`${key}Path`] = join(f.root, `${key}.json`);
      writeFileSync(config[`${key}Path`], JSON.stringify(config[key]));
      delete config[key];
    }
    const inputPath = join(f.root, 'reviewed-input.json'), output = join(f.root, 'bound-plan.json');
    writeFileSync(inputPath, JSON.stringify(config));
    const args = ['ops/v4/verify-fresh-release-pair.mjs', '--frontend', f.frontendDir,
      '--backend', f.backendDir, '--input', inputPath,
      '--source-commit', f.sourceCommit, '--source-head', f.sourceHead, '--out', output];
    const first = spawnSync(process.execPath, args, { cwd: deploy, encoding: 'utf8' });
    assert.equal(first.status, 0, first.stderr);
    assert.equal(JSON.parse(readFileSync(output)).activationAllowed, false);
    const again = spawnSync(process.execPath, args, { cwd: deploy, encoding: 'utf8' });
    assert.equal(again.status, 1);
    assert.match(again.stderr, /EEXIST/);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});
