import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { inspectTargetOwnerStatic } from './package-target-owner-static.mjs';
const sha = value => createHash('sha256').update(value).digest('hex');
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'target-owner-static-test-'));
  await mkdir(join(directory, 'assets')); await mkdir(join(directory, 'data'));
  const release = { pins: { first: `0x${'12'.repeat(32)}`, second: `0x${'34'.repeat(32)}` }, files: {} };
  await writeFile(join(directory, 'index.html'), '<html><body><div id="root"></div></body></html>');
  for (const name of ['genesisRecord', 'genesisBundle', 'trustedGenesisManifest', 'upgradeBundle', 'reviewCatalog']) {
    const body = JSON.stringify({ name }); release.files[name] = { path: `data/${name}.json`, sha256: sha(body) };
    await writeFile(join(directory, release.files[name].path), body);
  }
  await writeFile(join(directory, 'assets/app.js'), JSON.stringify({ ...release.pins, kind: 'target-owner-upgrade-journal-v1' }));
  return { directory, release };
}
test('static package contains only standalone public inputs and independently pinned compiled roots', async () => {
  const f = await fixture(); try {
    const files = await inspectTargetOwnerStatic(f.directory, f.release); assert.equal(Object.keys(files).length, 7);
    await writeFile(join(f.directory, 'data/upgradeBundle.json'), '{}');
    await assert.rejects(inspectTargetOwnerStatic(f.directory, f.release), /digest differs/);
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});
test('package rejects private files, symlinks, missing compile roots and an unreviewed migration sender', async () => {
  for (const mutate of [
    async f => writeFile(join(f.directory, '.env'), 'PRIVATE_TEST_VALUE'),
    async f => symlink(join(f.directory, 'data/genesisRecord.json'), join(f.directory, 'data/secret.json')),
    async f => writeFile(join(f.directory, 'assets/app.js'), 'target-owner-upgrade-journal-v1'),
    async f => writeFile(join(f.directory, 'assets/app.js'), `${JSON.stringify(f.release.pins)} target-owner-upgrade-journal-v1 configureTargetOwner`),
  ]) { const f = await fixture(); try { await mutate(f); await assert.rejects(inspectTargetOwnerStatic(f.directory, f.release)); }
    finally { await rm(f.directory, { recursive: true, force: true }); } }
});
