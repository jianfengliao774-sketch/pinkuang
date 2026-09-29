import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, rm, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertFreshBuild } from './assert-fresh-build.mjs';

test('fresh package excludes every old upgrade page', async () => {
  const dist = await mkdtemp(join(tmpdir(), 'bemine-fresh-build-'));
  try {
    await mkdir(join(dist, 'assets'));
    await Promise.all([
      writeFile(join(dist, 'index.html'), '<script src="./assets/main.js"></script>'),
      writeFile(join(dist, 'favicon.svg'), '<svg/>'),
      writeFile(join(dist, 'deployment-artifacts.json'), '{}'),
      writeFile(join(dist, 'assets/main.js'), ''),
    ]);
    await assertFreshBuild(dist);
    await writeFile(join(dist, 'upgrade.html'), '<script>old upgrade</script>');
    await assert.rejects(assertFreshBuild(dist), /upgrade\.html/);
    await unlink(join(dist, 'upgrade.html'));
    await writeFile(join(dist, 'assets/main.js'), 'const old="0x2995B10d19056c8C24C57b281C22562a603C571F";');
    await assert.rejects(assertFreshBuild(dist), /previous Factory address/);
    await writeFile(join(dist, 'assets/main.js'), 'const old="/bemine-v2/#market";');
    await assert.rejects(assertFreshBuild(dist), /retired product or market route/);
  } finally {
    await rm(dist, { recursive: true, force: true });
  }
});
