import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { packageStaticOutput } from './package-product-static.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const sourceHead = 'a'.repeat(40);
const frontend = Buffer.from(JSON.stringify({ kind: 'integrated-v2', chainId: 56,
  artifactDigest: `0x${'b'.repeat(64)}` }));

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'bemine-static-package-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const outDir = path.join(root, 'out');
  const releaseDir = path.join(root, 'v2-product-new-release');
  await mkdir(path.join(outDir, '_next/static/chunks'), { recursive: true });
  await mkdir(path.join(outDir, 'data'), { recursive: true });
  await writeFile(path.join(outDir, 'index.html'), '<script src="/bemine-v2/_next/static/chunks/app.js"></script>');
  await writeFile(path.join(outDir, '_next/static/chunks/app.js'), 'console.log("product");');
  await writeFile(path.join(outDir, 'data/frontend-manifest.json'), frontend);
  return { outDir, releaseDir, sourceHead, previousFrontendBytes: frontend,
    expectedFrontendSha256: sha(frontend) };
}

test('packages a complete v2 export with source, exact prior manifest and file digests', async t => {
  const options = await fixture(t);
  const result = await packageStaticOutput(options);
  assert.equal(result.sourceHead, sourceHead);
  assert.equal(result.frontendManifestSha256, sha(frontend));
  assert.equal(result.fileCount, 3);
  const body = await readFile(path.join(options.releaseDir, 'product-release-manifest.json'));
  assert.equal(sha(body), result.manifestSha256);
  const manifest = JSON.parse(body);
  assert.equal(manifest.basePath, '/bemine-v2');
  assert.equal(manifest.artifactDigest, `0x${'b'.repeat(64)}`);
  assert.deepEqual(Object.keys(manifest.files), [
    'public/bemine-v2/_next/static/chunks/app.js',
    'public/bemine-v2/data/frontend-manifest.json',
    'public/bemine-v2/index.html',
  ]);
  for (const [name, spec] of Object.entries(manifest.files)) {
    const bytes = await readFile(path.join(options.releaseDir, name));
    assert.equal(bytes.length, spec.bytes);
    assert.equal(sha(bytes), spec.sha256);
  }
  await assert.rejects(packageStaticOutput(options), /already exists/);
});

test('rejects a manifest change and unprefixed Next assets before creating a release', async t => {
  const options = await fixture(t);
  const changedPrevious = Buffer.from(frontend.toString().replace('integrated-v2', 'integrated-v3'));
  await assert.rejects(packageStaticOutput({ ...options,
    previousFrontendBytes: changedPrevious, expectedFrontendSha256: sha(changedPrevious) }),
  /previous contract manifest byte for byte/);
  await writeFile(path.join(options.outDir, 'index.html'), '<script src="/_next/static/chunks/app.js"></script>');
  await assert.rejects(packageStaticOutput(options), /NEXT_PUBLIC_BASE_PATH/);
});

test('rejects symlinks and private files from the static export', async t => {
  const options = await fixture(t);
  await symlink(path.join(options.outDir, 'index.html'), path.join(options.outDir, 'alias.html'));
  await assert.rejects(packageStaticOutput(options), /Symlink/);
  await rm(path.join(options.outDir, 'alias.html'));
  await writeFile(path.join(options.outDir, 'wallet.key'), 'private');
  await assert.rejects(packageStaticOutput(options), /Private product path/);
});
