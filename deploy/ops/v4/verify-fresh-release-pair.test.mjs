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
import { verifyFreshReleasePair, verifyGitProvenance } from './verify-fresh-release-pair.mjs';

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
  input.manifest = { ...input.manifest, sourceCommit: input.record.sourceCommit,
    verifiedAt: new Date().toISOString() };
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
  return { root, backendDir, frontendDir, input, sourceCommit, sourceHead,
    frontendContentSha256: contentSha256,
    backendReleaseSha256: sha256(readFileSync(join(backendDir, 'public/fresh-release-manifest.json'))) };
}

const verify = f => verifyFreshReleasePair({ frontendDir: f.frontendDir, backendDir: f.backendDir,
  cutoverInput: f.input, expectedSourceCommit: f.sourceCommit, expectedSourceHead: f.sourceHead,
  expectedFrontendContentSha256: f.frontendContentSha256,
  expectedBackendReleaseSha256: f.backendReleaseSha256, verifyGit: false });

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
    assert.equal(plan.releasePair.backendArtifactSourceCommit, f.sourceCommit);
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

test('allows later runtime releases with the same deployed artifact digest', async () => {
  const f = await pairFixture();
  try {
    const laterCommit = 'b'.repeat(40);
    const artifactPath = join(f.backendDir, 'public/deployment-artifacts.json');
    const artifact = JSON.parse(readFileSync(artifactPath));
    artifact.sourceCommit = laterCommit;
    const bytes = Buffer.from(JSON.stringify(artifact));
    writeFileSync(artifactPath, bytes);
    writeFileSync(join(f.backendDir, 'dist/deployment-artifacts.json'), bytes);
    const releasePath = join(f.backendDir, 'public/fresh-release-manifest.json');
    const release = JSON.parse(readFileSync(releasePath));
    release.sourceCommit = laterCommit;
    release.artifactSha256 = sha256(bytes);
    release.files['public/deployment-artifacts.json'] = { sha256: sha256(bytes), bytes: bytes.length };
    release.files['dist/deployment-artifacts.json'] = { sha256: sha256(bytes), bytes: bytes.length };
    writeFileSync(releasePath, JSON.stringify(release));
    f.backendReleaseSha256 = sha256(readFileSync(releasePath));
    const plan = verify(f);
    assert.equal(plan.releasePair.sourceCommit, f.sourceCommit);
    assert.equal(plan.releasePair.backendArtifactSourceCommit, laterCommit);
    assert.equal(plan.releasePair.artifactDigest, f.input.record.artifactDigest);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('independent content pins reject self-consistent package substitution', async () => {
  const f = await pairFixture();
  try {
    const asset = join(f.frontendDir, '_next/static/fresh.js');
    writeFileSync(asset, 'console.log("substituted")');
    const frontendReleasePath = join(f.frontendDir, 'fresh-product-release.json');
    const frontendRelease = JSON.parse(readFileSync(frontendReleasePath));
    frontendRelease.contentSha256 = sha256([
      '_next/static/fresh.js', 'data/frontend-manifest.v4.json', 'index.html',
    ].map(name => `${name}\0${sha256(readFileSync(join(f.frontendDir, name)))}\n`).join(''));
    writeFileSync(frontendReleasePath, JSON.stringify(frontendRelease));
    assert.throws(() => verify(f), /independently reviewed digest/);
    f.frontendContentSha256 = frontendRelease.contentSha256;
    const moduleName = 'server/index.mjs';
    const modulePath = join(f.backendDir, moduleName);
    const moduleBytes = Buffer.from('console.log("substituted")');
    writeFileSync(modulePath, moduleBytes);
    const backendReleasePath = join(f.backendDir, 'public/fresh-release-manifest.json');
    const backendRelease = JSON.parse(readFileSync(backendReleasePath));
    backendRelease.files[moduleName] = { sha256: sha256(moduleBytes), bytes: moduleBytes.length };
    writeFileSync(backendReleasePath, JSON.stringify(backendRelease));
    assert.throws(() => verify(f), /independently reviewed manifest digest/);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('backend code must match every reviewed Git blob', async () => {
  const f = await pairFixture();
  try {
    const repository = join(f.root, 'reviewed');
    mkdirSync(repository);
    const git = (...args) => spawnSync('git', args, { cwd: repository, encoding: 'utf8' });
    assert.equal(git('init', '-q').status, 0);
    assert.equal(git('config', 'user.name', 'Reviewed Release Test').status, 0);
    assert.equal(git('config', 'user.email', 'review@example.invalid').status, 0);
    const names = [...PRODUCT_BACKEND_MODULES, 'package.json', 'package-lock.json',
      'public/deployment-artifacts.json'];
    const files = new Map();
    for (const name of names) {
      const bytes = readFileSync(join(f.backendDir, name));
      write(join(repository, 'deploy'), name, bytes);
      files.set(name, bytes);
    }
    assert.equal(git('add', '.').status, 0);
    assert.equal(git('commit', '-qm', 'reviewed release').status, 0);
    const sourceHead = git('rev-parse', 'HEAD').stdout.trim();
    assert.doesNotThrow(() => verifyGitProvenance(files, sourceHead, repository));
    const changed = new Map(files);
    changed.set('server/index.mjs', Buffer.from('console.log("substituted")'));
    assert.throws(() => verifyGitProvenance(changed, sourceHead, repository),
      /differs from reviewed Git source: server\/index.mjs/);
    writeFileSync(join(repository, 'deploy/server/index.mjs'), 'dirty');
    assert.throws(() => verifyGitProvenance(files, sourceHead, repository), /checkout must be clean/);
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
    f.backendReleaseSha256 = sha256(readFileSync(releasePath));
    assert.throws(() => verify(f), /contract graph, backend index and cutover draft differ/);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('CLI rejects an unverified release commit before writing a plan', async () => {
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
      '--source-commit', f.sourceCommit, '--source-head', f.sourceHead,
      '--frontend-content-sha256', f.frontendContentSha256,
      '--backend-release-sha256', f.backendReleaseSha256, '--out', output];
    const first = spawnSync(process.execPath, args, { cwd: deploy, encoding: 'utf8' });
    assert.equal(first.status, 1);
    assert.match(first.stderr, /source HEAD differs|checkout must be clean/);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});
