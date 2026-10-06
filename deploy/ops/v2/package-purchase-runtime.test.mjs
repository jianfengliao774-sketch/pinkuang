import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, realpathSync, symlinkSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PURCHASE_RUNTIME_FILES, assertPurchaseImportClosure, packagePurchaseRuntime } from './package-purchase-runtime.mjs';

const source = new URL('../../', import.meta.url);
const contents = () => new Map(Object.entries(PURCHASE_RUNTIME_FILES)
  .map(([name, path]) => [name, readFileSync(new URL(path, source))]));

test('purchase runtime allowlist closes both legacy and opt-in fresh module imports', () => {
  const files = contents();
  assert.equal(files.size, 18);
  assert.ok(assertPurchaseImportClosure(files) >= 14);
  for (const missing of ['scripts/keeper-credential.mjs', 'scripts/fresh-purchase-guard.mjs',
    'server/product-graph.mjs', 'shared/integrated-upgrade-plan.mjs',
    'server/fresh-machine-readiness.mjs','shared/fresh-runtime-identity.mjs','scripts/fresh-worker-readiness.mjs',
    'shared/fresh-activation-chain-proof.mjs', 'shared/fresh-activation-execution.mjs']) {
    const broken = new Map(files);
    broken.delete(missing);
    assert.throws(() => assertPurchaseImportClosure(broken), /Missing packaged import/);
  }
});

test('immutable package imports both purchase entrypoints and the dynamic fresh guard', async () => {
  const parent = realpathSync(await mkdtemp(join(tmpdir(), 'purchase-runtime-closure-')));
  try {
    const output = join(parent, 'release');
    const packed = packagePurchaseRuntime({ output, sourceHead: '1'.repeat(40), verifyGit: false });
    assert.equal(packed.files, 18);
    assert.ok(packed.checkedImports >= 14);
    const manifest = JSON.parse(readFileSync(join(output, 'purchase-manifest.json')));
    assert.deepEqual(Object.keys(manifest.files).sort(), Object.keys(PURCHASE_RUNTIME_FILES).sort());
    symlinkSync(new URL('../../node_modules', import.meta.url), join(output, 'node_modules'), 'dir');
    for (const [entry, name] of [
      ['scripts/purchase-supervisor.mjs', 'parseSupervisorArguments'],
      ['scripts/purchase-keeper.mjs', 'parseArguments'],
      ['scripts/fresh-purchase-guard.mjs', 'configureFreshPurchase'],
      ['shared/fresh-activation-chain-proof.mjs', 'verifyWrappedFreshActivation'],
      ['shared/fresh-activation-execution.mjs', 'verifyFreshActivationExecution'],
    ]) {
      const module = await import(pathToFileURL(join(output, entry)).href);
      assert.equal(typeof module[name], 'function');
    }
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
