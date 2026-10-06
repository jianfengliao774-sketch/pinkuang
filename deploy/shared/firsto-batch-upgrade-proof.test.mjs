import assert from 'node:assert/strict';
import test from 'node:test';
import { ZeroAddress, keccak256, toUtf8Bytes } from 'ethers';
import { evidenceDigest } from './firsto-upgrade-proof.mjs';
import { validateFirstoBatchUpgradePreflight, validateFirstoBatchUpgradeCatalog, verifyFirstoBatchUpgrade,
  firstoBatchVerifiedUpgrade } from './firsto-batch-upgrade-proof.mjs';
import { reviewedFirstoBatchProtocol } from './firsto-batch-upgrade-plan.mjs';
import { createFirstoBatchFixture } from './firsto-batch-upgrade-test-fixture.mjs';
const hash = value => keccak256(toUtf8Bytes(value));
const approved = f => validateFirstoBatchUpgradeCatalog(f.finalCatalog, f.input.upgradeBundle, f.input,
  { trustedCatalogDigest: evidenceDigest(f.finalCatalog) });

test('prepared empty and actual single prefix stay unsigned and do not admit planned replacements', async () => {
  const f = createFirstoBatchFixture({ phase: 'unscheduled' });
  const empty = await validateFirstoBatchUpgradePreflight(f.provider, f.input, { phase: 'prepared' });
  assert.deepEqual(empty.verifiedDeploymentNames, []); assert.equal(empty.replacementDeploymentVerified, false);
  const one = await validateFirstoBatchUpgradePreflight(f.provider, f.input, { phase: 'prepared', deployments: { FlexiblePurchase: f.deployments.FlexiblePurchase } });
  assert.deepEqual(one.verifiedDeploymentNames, ['FlexiblePurchase']); assert.equal(one.replacementDeploymentVerified, false);
  await assert.rejects(validateFirstoBatchUpgradePreflight(f.provider, f.input, { phase: 'prepared', deployments: { FlexiblePurchase: { address: f.replacements.FlexiblePurchase } } }), /confirmed deployment/);
  await assert.rejects(validateFirstoBatchUpgradePreflight(f.provider, f.input, { phase: 'prepared', deployments: { PoolFunds: f.core.deployments.PoolFunds } }), /prefix/);
});
test('all four finalized phases verify the completed core predecessor and exact current successor', async () => {
  for (const phase of ['unscheduled', 'scheduled', 'done']) {
    const f = createFirstoBatchFixture({ phase, splitMarkets: true });
    const proof = await validateFirstoBatchUpgradePreflight(f.provider, f.input, f.options);
    assert.equal(proof.baselineVerified, true); assert.equal(proof.replacementDeploymentVerified, true);
    assert.equal(proof.codeUpgradeComplete, phase === 'done'); assert.equal(proof.blockNumber, 800);
    if (phase === 'done') assert.equal(firstoBatchVerifiedUpgrade(proof), proof);
    else assert.throws(() => firstoBatchVerifiedUpgrade(proof), /Unverified/);
  }
  const f = createFirstoBatchFixture({ phase: 'scheduled', waiting: true });
  assert.equal((await validateFirstoBatchUpgradePreflight(f.provider, f.input, f.options)).ready, false);
});
for (const [name, mutate] of [
  ['old FirstoSale contamination', f => { const node = f.input.reviewCatalog.nodes.FirstoSale; f.codes.set(node.address.toLowerCase(), '0x6000'); }],
  ['current core Funds contamination', f => f.codes.set(f.core.replacements.PoolFunds.toLowerCase(), '0x6000')],
  ['batch exchange runtime mismatch', f => f.codes.set(reviewedFirstoBatchProtocol.exchange.toLowerCase(), '0x6000')],
  ['new Flexible link/runtime mismatch', f => f.codes.set(f.replacements.FlexiblePurchase.toLowerCase(), '0x6000')],
  ['new Vault factory/runtime mismatch', f => f.codes.set(f.replacements.PoolVault.toLowerCase(), '0x6000')],
  ['batch version absent or wrong', f => { f.state.batchVersion = 0n; }],
  ['core predecessor receipt reverted', f => { f.receipts.get(f.core.options.executeTxHash).status = 0; }],
]) test(`successor rejects ${name}`, async () => {
  const f = createFirstoBatchFixture(); mutate(f);
  await assert.rejects(validateFirstoBatchUpgradePreflight(f.provider, f.input, f.options));
});
for (const [name, mutate] of [
  ['deployment CREATE address', f => { f.transactions.get(f.deployments.PoolVault.txHash).nonce++; }],
  ['deployment sender', f => { f.transactions.get(f.deployments.FlexiblePurchase.txHash).from = ZeroAddress; }],
  ['deployment calldata', f => { f.transactions.get(f.deployments.PoolVault.txHash).data += '00'; }],
  ['deployment value', f => { f.transactions.get(f.deployments.PoolVault.txHash).value = 1n; }],
  ['missing schedule salt', f => { f.receipts.get(f.scheduleTxHash).logs.pop(); }],
  ['wrong exact execute payload', f => { f.transactions.get(f.executeTxHash).data += '00'; }],
  ['wrong beacon result', f => { f.receipts.get(f.executeTxHash).logs[1].data = '0x' + '0'.repeat(64); }],
  ['duplicate event', f => { f.receipts.get(f.executeTxHash).logs.push(structuredClone(f.receipts.get(f.executeTxHash).logs[0])); }],
  ['noncanonical receipt inclusion', f => { f.blocks.get(611).transactions = [hash('wrong inclusion')]; }],
  ['full delay one second early', f => { f.blocks.get(780).timestamp = 572799; }],
]) test(`exact receipt proof rejects ${name}`, async () => {
  const f = createFirstoBatchFixture(); mutate(f);
  await assert.rejects(validateFirstoBatchUpgradePreflight(f.provider, f.input, f.options));
});
test('canonical recheck rejects a changing finalized hash after runtime reads', async () => {
  const f = createFirstoBatchFixture(), original = f.provider.getCode;
  f.provider.getCode = async (...args) => { const value = await original(...args); f.blocks.get(800).hash = hash('reorg after read'); return value; };
  await assert.rejects(validateFirstoBatchUpgradePreflight(f.provider, f.input, f.options), /canonical|changed/);
});
test('catalog copies/freeze and completion brands reject public JSON capabilities or changed pins', async () => {
  const f = createFirstoBatchFixture(), trusted = approved(f);
  assert(Object.isFrozen(trusted.input));
  assert.throws(() => { trusted.catalog.deployments.PoolVault.address = ZeroAddress; }, TypeError);
  assert.throws(() => validateFirstoBatchUpgradeCatalog(f.finalCatalog, f.input.upgradeBundle, f.input, { trustedCatalogDigest: hash('wrong pin') }), /independent operator pin/);
  await assert.rejects(verifyFirstoBatchUpgrade(f.provider, { firstoBatchUpgrade: structuredClone(trusted) }), /Unvalidated/);
  const proof = await verifyFirstoBatchUpgrade(f.provider, { firstoBatchUpgrade: trusted });
  assert.equal(firstoBatchVerifiedUpgrade(proof), proof);
  assert.throws(() => firstoBatchVerifiedUpgrade(structuredClone(proof)), /Unverified/);
});
test('completion cache checks new runtimes and the fixed protocol pin again at the current block', async () => {
  const f = createFirstoBatchFixture(), trusted = { firstoBatchUpgrade: approved(f) };
  const proof = await verifyFirstoBatchUpgrade(f.provider, trusted); assert.equal(proof.codeUpgradeComplete, true);
  assert.equal(await verifyFirstoBatchUpgrade(f.provider, trusted), proof);
  const previous = f.codes.get(f.replacements.FlexiblePurchase.toLowerCase());
  f.codes.set(f.replacements.FlexiblePurchase.toLowerCase(), '0x6000');
  await assert.rejects(verifyFirstoBatchUpgrade(f.provider, trusted), /candidate codehash/);
  f.codes.set(f.replacements.FlexiblePurchase.toLowerCase(), previous);
  f.codes.set(reviewedFirstoBatchProtocol.exchange.toLowerCase(), '0x6000');
  await assert.rejects(verifyFirstoBatchUpgrade(f.provider, trusted), /protocol|batch runtime/i);
});
