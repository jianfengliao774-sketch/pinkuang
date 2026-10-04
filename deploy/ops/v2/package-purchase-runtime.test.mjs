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
  assert.equal(files.size, 25);
  assert.ok(assertPurchaseImportClosure(files) >= 14);
  for (const missing of ['scripts/keeper-credential.mjs', 'scripts/fresh-purchase-guard.mjs',
    'server/product-graph.mjs', 'shared/integrated-upgrade-plan.mjs',
    'server/fresh-machine-readiness.mjs','shared/fresh-runtime-identity.mjs','scripts/fresh-worker-readiness.mjs',
    'shared/fresh-activation-chain-proof.mjs', 'shared/fresh-activation-execution.mjs',
    'shared/runtime-rpc-selection.mjs', 'shared/read-only-rpc-fallback.mjs',
    'shared/fresh-factory-reuse-proof.mjs', 'shared/fresh-native-sale-proof.mjs', 'shared/fresh-sale-policy-proof.mjs',
    'shared/target-owner-upgrade-plan.mjs', 'shared/target-owner-upgrade-proof.mjs']) {
    const broken = new Map(files);
    broken.delete(missing);
    assert.throws(() => assertPurchaseImportClosure(broken), /Missing packaged import/);
  }
});

test('purchase closure rejects computed imports, escaping paths and files beyond its explicit runtime inventory', () => {
  for (const statement of ["import('../shared/' + name);", "import '../../unreviewed.mjs';"]) {
    const files = contents();
    files.set('scripts/purchase-supervisor.mjs', Buffer.concat([
      files.get('scripts/purchase-supervisor.mjs'), Buffer.from(`\n${statement}\n`),
    ]));
    assert.throws(() => assertPurchaseImportClosure(files), /Computed dynamic import|Unsafe purchase import/);
  }
  const extra = contents();
  extra.set('shared/target-owner-upgrade-test-fixture.mjs', Buffer.from('export const fixture = {};'));
  assert.throws(() => assertPurchaseImportClosure(extra), /Unreviewed purchase file/);
});

test('immutable package imports both purchase entrypoints and the dynamic fresh guard', async () => {
  const parent = realpathSync(await mkdtemp(join(tmpdir(), 'purchase-runtime-closure-')));
  try {
    const output = join(parent, 'release');
    const packed = packagePurchaseRuntime({ output, sourceHead: '1'.repeat(40), verifyGit: false });
    assert.equal(packed.files, 25);
    assert.ok(packed.checkedImports >= 14);
    const manifest = JSON.parse(readFileSync(join(output, 'purchase-manifest.json')));
    assert.deepEqual(Object.keys(manifest.files).sort(), Object.keys(PURCHASE_RUNTIME_FILES).sort());
    assert(!Object.keys(manifest.files).some(name => /\.test\.|fixture|\.env$|\.key$|\.sqlite$/.test(name)));
    symlinkSync(new URL('../../node_modules', import.meta.url), join(output, 'node_modules'), 'dir');
    for (const [entry, name] of [
      ['scripts/purchase-supervisor.mjs', 'parseSupervisorArguments'],
      ['scripts/purchase-keeper.mjs', 'parseArguments'],
      ['scripts/fresh-purchase-guard.mjs', 'configureFreshPurchase'],
      ['shared/fresh-activation-chain-proof.mjs', 'verifyWrappedFreshActivation'],
      ['shared/fresh-activation-execution.mjs', 'verifyFreshActivationExecution'],
      ['shared/runtime-rpc-selection.mjs', 'createDeferredRuntimeRpcProvider'],
      ['shared/target-owner-upgrade-plan.mjs', 'buildTargetOwnerUpgradePlan'],
      ['shared/target-owner-upgrade-proof.mjs', 'verifyTargetOwnerUpgrade'],
    ]) {
      const module = await import(pathToFileURL(join(output, entry)).href);
      assert.equal(typeof module[name], 'function');
    }
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
