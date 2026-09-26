import assert from 'node:assert/strict';
import { test } from 'node:test';
import { artifactDigest, type ArtifactBundle, type DeploymentSnapshot } from './deployment';
import { deploymentManifest } from './manifest';

const bundle = { schemaVersion: 1, compilerVersion: '0.8.24', sourceCommit: 'a'.repeat(40), settings: {}, sourceHashes: {}, artifacts: {} } as ArtifactBundle;
const addresses = {
  factory: '0x1111111111111111111111111111111111111111',
  shareMarket: '0x2222222222222222222222222222222222222222',
  lens: '0x3333333333333333333333333333333333333333',
  beacon: '0x4444444444444444444444444444444444444444',
  timelock: '0x5555555555555555555555555555555555555555',
};
const labels = ['Factory.lens', 'Lens.factory', 'Market.factory', 'Market.timelock', 'Beacon.owner',
  ...Object.keys(addresses).map(name => `${name} 运行代码匹配`)];
function completeSnapshot(): DeploymentSnapshot {
  return {
    schemaVersion: 1, id: 'test', account: addresses.factory, createdAt: '2026-09-26T00:00:00.000Z', updatedAt: '2026-09-26T00:00:00.000Z',
    chainId: 56, status: 'complete', artifactDigest: artifactDigest(bundle), sourceCommit: bundle.sourceCommit,
    input: { governanceMode: 'single', ownerMultisig: addresses.factory, operator: addresses.factory, treasury: addresses.factory,
      maxGasBudgetBnb: '0.05', gasPriceCapGwei: '1', governanceReviewed: true, protocolReviewed: true },
    spentWei: '100', preflight: { chainId: 56, account: addresses.factory, balanceWei: '1000000', gasPriceWei: '1',
      artifactDigest: artifactDigest(bundle), owner: { address: addresses.factory, codehash: `0x${'0'.repeat(64)}`, codeBytes: 0 },
      treasury: { address: addresses.factory, codehash: `0x${'0'.repeat(64)}`, codeBytes: 0 }, protocols: {},
      libraryOrder: [], transactionCount: 1, warnings: [], checkedAt: '2026-09-26T00:00:00.000Z' },
    addresses, steps: [{ id: 'initialize', label: '原子初始化', status: 'confirmed', txHash: `0x${'a'.repeat(64)}`,
      receipt: { blockNumber: 123, blockHash: `0x${'b'.repeat(64)}`, status: 1, gasUsed: '100', gasPrice: '1', feeWei: '100' } }],
    verification: { checkedAt: '2026-09-26T00:00:00.000Z', blockNumber: 125,
      checks: labels.map(label => ({ label, passed: true, actual: 'true', expected: 'true' })),
      code: Object.fromEntries(Object.entries(addresses).map(([name, address]) => [name,
        { address, codehash: `0x${'c'.repeat(64)}`, codeBytes: 100 }])) },
  };
}

test('exports only the public, source-bound deployment addresses and receipt', () => {
  const manifest = deploymentManifest(completeSnapshot(), bundle);
  assert.equal(manifest.chainId, 56);
  assert.equal(manifest.factory, addresses.factory);
  assert.equal(manifest.shareMarket, addresses.shareMarket);
  assert.equal(manifest.deployment.blockNumber, 123);
  assert.equal(manifest.verifiedBlockNumber, 125);
  assert.equal(manifest.artifactDigest, artifactDigest(bundle));
  assert.equal(JSON.stringify(manifest).includes('ownerMultisig'), false);
});

test('refuses incomplete, failed or source-mismatched records', () => {
  const partial = completeSnapshot(); partial.status = 'paused';
  assert.throws(() => deploymentManifest(partial, bundle), /完成链上核验/);
  const failed = completeSnapshot(); failed.verification!.checks[0].passed = false;
  assert.throws(() => deploymentManifest(failed, bundle), /完整核验/);
  const missing = completeSnapshot(); delete missing.steps[0].receipt;
  assert.throws(() => deploymentManifest(missing, bundle), /初始化回执/);
  const drift = completeSnapshot(); drift.artifactDigest = `0x${'f'.repeat(64)}`;
  assert.throws(() => deploymentManifest(drift, bundle), /源码构建/);
  const wrongCode = completeSnapshot(); wrongCode.verification!.code.lens.address = addresses.factory;
  assert.throws(() => deploymentManifest(wrongCode, bundle), /lens 地址/);
});
