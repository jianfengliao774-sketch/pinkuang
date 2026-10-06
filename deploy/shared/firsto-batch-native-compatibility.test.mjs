import assert from 'node:assert/strict';
import test from 'node:test';
import { evidenceDigest } from './firsto-upgrade-proof.mjs';
import { createFirstoBatchFixture } from './firsto-batch-upgrade-test-fixture.mjs';
import { nativeSaleCompatibilityFixture } from './native-sale-compatibility-test-fixture.mjs';
import { validateFirstoBatchUpgradeCatalog, verifyFirstoBatchUpgrade } from './firsto-batch-upgrade-proof.mjs';
import { verifyNativeSaleCompatibility, hasVerifiedNativeSaleCapability } from './native-sale-compatibility.mjs';

async function fixture() {
  const f = createFirstoBatchFixture({ predecessorFixture: await nativeSaleCompatibilityFixture() });
  const review = validateFirstoBatchUpgradeCatalog(f.finalCatalog, f.input.upgradeBundle, f.input,
    { trustedCatalogDigest: evidenceDigest(f.finalCatalog) });
  const block = structuredClone(f.blocks.get(800)), upgrade = await verifyFirstoBatchUpgrade(f.provider, { firstoBatchUpgrade: review }, block);
  const compatibilityInput = { review, upgrade, block };
  const makeGraph = async () => ({ factory: f.input.reviewCatalog.bindings.factory, productKind: 'pool', blockNumber: block.number,
    addresses: { ...Object.fromEntries(Object.entries(f.input.reviewCatalog.nodes).map(([name, node]) => [name, node.address])), ...upgrade.replacements },
    codehash: { PoolVault: upgrade.codehash.PoolVault, FirstoSale: f.input.reviewCatalog.nodes.FirstoSale.codehash },
    targetOwnerUpgrade: { version: 1, replacements: upgrade.replacements, codehash: upgrade.codehash,
      candidateArtifactDigest: upgrade.candidateArtifactDigest, catalogDigest: review.catalogDigest, operationId: upgrade.operationId },
    nativeSaleCompatibility: await verifyNativeSaleCompatibility(f.provider, compatibilityInput) });
  return { ...f, review, upgrade, compatibilityInput, makeGraph };
}

test('completed two-component batch successor retains native sale with genesis Funds and preserved FirstoSale', async () => {
  const f = await fixture(), graph = await f.makeGraph(), cap = graph.nativeSaleCompatibility;
  assert.equal(hasVerifiedNativeSaleCapability(graph), true);
  assert.equal(cap.originalPoolFunds, f.input.genesisRecord.addresses.PoolFunds);
  assert.notEqual(cap.originalPoolFunds, graph.addresses.PoolFunds);
  assert.equal(graph.addresses.PoolFunds, f.core.replacements.PoolFunds);
  assert.equal(cap.firstoSale, f.input.reviewCatalog.nodes.FirstoSale.address);
  assert.equal(f.input.reviewCatalog.nodes.FirstoSale.links.PoolFunds, cap.originalPoolFunds);
  assert.equal(cap.targetOwnerOperationId, f.plan.operationId);
  assert.equal(graph.nativeSaleUpgrade, undefined);
  assert.equal(hasVerifiedNativeSaleCapability(structuredClone(graph)), false);
  assert.equal(hasVerifiedNativeSaleCapability({ ...graph, transactionReady: false }), false);
  assert(!JSON.stringify(cap).includes('salt'));
});

test('batch native compatibility rejects JSON completion and missing or changed native ABI', async () => {
  const f = await fixture();
  await assert.rejects(verifyNativeSaleCompatibility(f.provider, {
    ...f.compatibilityInput, upgrade: structuredClone(f.upgrade),
  }), /Unverified Firsto batch/);
  const missing = createFirstoBatchFixture();
  const review = validateFirstoBatchUpgradeCatalog(missing.finalCatalog, missing.input.upgradeBundle, missing.input,
    { trustedCatalogDigest: evidenceDigest(missing.finalCatalog) });
  const block = missing.blocks.get(800), upgrade = await verifyFirstoBatchUpgrade(missing.provider, { firstoBatchUpgrade: review }, block);
  await assert.rejects(verifyNativeSaleCompatibility(missing.provider, { review, upgrade, block }), /ABI.*nativeFirstoSaleVersion/);
});

test('batch native compatibility separately binds original Funds and old FirstoSale runtime after completion', async () => {
  for (const name of ['PoolFunds', 'FirstoSale']) {
    const f = await fixture(), address = name === 'PoolFunds' ? f.input.genesisRecord.addresses.PoolFunds
      : f.input.reviewCatalog.nodes.FirstoSale.address;
    f.codes.set(address.toLowerCase(), '0x60006002');
    await assert.rejects(f.makeGraph(), /Native compatibility exact runtime changed/);
  }
});
