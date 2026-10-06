import assert from 'node:assert/strict';
import test from 'node:test';
import { nativeSaleCompatibilityFixture } from './native-sale-compatibility-test-fixture.mjs';
import { verifyNativeSaleCompatibility, hasVerifiedNativeSaleCapability } from './native-sale-compatibility.mjs';

test('successor proves inherited native sale and keeps old FirstoSale linked to original Funds', async () => {
  const f = await nativeSaleCompatibilityFixture(), graph = await f.makeGraph(), proof = graph.nativeSaleCompatibility;
  assert.equal(hasVerifiedNativeSaleCapability(graph), true);
  assert.equal(proof.originalPoolFunds, f.input.genesisRecord.addresses.PoolFunds);
  assert.notEqual(proof.originalPoolFunds, graph.addresses.PoolFunds);
  assert.equal(f.input.reviewCatalog.nodes.FirstoSale.links.PoolFunds, proof.originalPoolFunds);
  assert.equal(proof.targetOwnerOperationId, f.upgrade.operationId);
  assert.equal(graph.nativeSaleUpgrade, undefined, 'compatibility must not pretend to be the original native upgrade');
  assert(Object.isFrozen(proof)); assert(Object.isFrozen(proof.codehash));
  assert(!JSON.stringify(proof).includes('salt')); assert(!JSON.stringify(proof).includes('reviewCatalog'));
});

test('old capability stays accepted; missing, caller JSON, stale and mismatched successor proofs stay closed', async () => {
  assert.equal(hasVerifiedNativeSaleCapability({ nativeSaleUpgrade: { version: 1 } }), true);
  assert.equal(hasVerifiedNativeSaleCapability({}), false);
  assert.equal(hasVerifiedNativeSaleCapability({ targetOwnerUpgrade: { version: 1 } }), false);
  const f = await nativeSaleCompatibilityFixture(), graph = await f.makeGraph();
  for (const changed of [structuredClone(graph), { ...graph, transactionReady: false }, { ...graph, productKind: 'budget' },
    { ...graph, blockNumber: graph.blockNumber + 1 }, { ...graph, factory: graph.addresses.portfolioFactory },
    { ...graph, addresses: { ...graph.addresses, PoolVault: f.input.reviewCatalog.nodes.PoolVault.address } },
    { ...graph, codehash: { ...graph.codehash, FirstoSale: '0x' + '11'.repeat(32) } },
    { ...graph, targetOwnerUpgrade: { ...graph.targetOwnerUpgrade, operationId: '0x' + '22'.repeat(32) } }])
    assert.equal(hasVerifiedNativeSaleCapability(changed), false);
});

test('compatibility rejects incomplete ABI, unsupported or unavailable native views and unbranded upgrade claims', async () => {
  const missing = await nativeSaleCompatibilityFixture({ missingAbi: true });
  await assert.rejects(missing.makeGraph(), /ABI.*nativeFirstoSaleVersion/);
  const f = await nativeSaleCompatibilityFixture(); f.state.nativeVersion = 0n;
  await assert.rejects(f.makeGraph(), /version/);
  f.state.nativeVersion = 1n; f.state.nativeReadError = true;
  await assert.rejects(f.makeGraph(), /native view unavailable/);
  await assert.rejects(verifyNativeSaleCompatibility(f.provider, { ...f.compatibilityInput, upgrade: structuredClone(f.upgrade) }), /Unverified/);
});

test('full current runtimes reject Vault, original FirstoSale, old Funds drift and forged baseline links', async () => {
  for (const name of ['PoolVault', 'FirstoSale', 'PoolFunds']) {
    const f = await nativeSaleCompatibilityFixture();
    const address = name === 'PoolVault' ? f.upgrade.replacements.PoolVault : f.input.reviewCatalog.nodes[name].address;
    f.codes.set(address.toLowerCase(), '0x60006002'); await assert.rejects(f.makeGraph(), /exact runtime/);
  }
  const f = await nativeSaleCompatibilityFixture(), review = structuredClone(f.review);
  review.catalog.reviewCatalog.nodes.FirstoSale.links.PoolFunds = f.upgrade.replacements.PoolFunds;
  await assert.rejects(verifyNativeSaleCompatibility(f.provider, { ...f.compatibilityInput, review }), /evidence differs/);
});

test('new capability fails if the verified canonical block changes', async () => {
  const f = await nativeSaleCompatibilityFixture();
  f.blocks.get(400).hash = '0x' + 'aa'.repeat(32);
  await assert.rejects(f.makeGraph(), /block changed/);
});
