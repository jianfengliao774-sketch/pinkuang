import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { Log, ZeroAddress, keccak256, toUtf8Bytes } from 'ethers';
import { evidenceDigest } from './firsto-upgrade-proof.mjs';
import { prepareTargetOwnerUpgradeDeployment } from './target-owner-upgrade-plan.mjs';
import { validateTargetOwnerUpgradePreflight, validateTargetOwnerUpgradeCatalog, verifyTargetOwnerUpgrade, targetOwnerVerifiedUpgrade } from './target-owner-upgrade-proof.mjs';
import { createTargetOwnerFixture } from './target-owner-upgrade-test-fixture.mjs';
const original = JSON.parse(readFileSync(new URL('../public/upgrade-genesis/genesis-record.json', import.meta.url), 'utf8'));
const hash = value => keccak256(toUtf8Bytes(value));

test('next-deployment preparation requires only the exact actual prior prefix', () => {
  const f = createTargetOwnerFixture({ phase: 'unscheduled' });
  assert.equal(prepareTargetOwnerUpgradeDeployment('PoolFunds', f.input).to, null);
  assert.throws(() => prepareTargetOwnerUpgradeDeployment('FlexiblePurchase', f.input), /prefix/);
  const prepared = prepareTargetOwnerUpgradeDeployment('PoolVault', f.input, { deploymentsPrefix: { PoolFunds: f.deployments.PoolFunds, FlexiblePurchase: f.deployments.FlexiblePurchase } });
  assert.equal(prepared.data, f.plan.deployments[2].data); assert.equal(prepared.replacementDeploymentVerified, false);
});
test('empty and confirmed partial prefixes cannot promote planned addresses into deployments', async () => {
  const f = createTargetOwnerFixture({ phase: 'unscheduled' });
  const empty = await validateTargetOwnerUpgradePreflight(f.provider, f.input, { phase: 'prepared' });
  assert.deepEqual(empty.verifiedDeploymentNames, []); assert.equal(empty.replacementDeploymentVerified, false);
  const one = await validateTargetOwnerUpgradePreflight(f.provider, f.input, { phase: 'prepared', deployments: { PoolFunds: f.deployments.PoolFunds } });
  assert.deepEqual(one.verifiedDeploymentNames, ['PoolFunds']); assert.equal(one.replacementDeploymentVerified, false);
  await assert.rejects(validateTargetOwnerUpgradePreflight(f.provider, f.input, { phase: 'prepared', deployments: { PoolFunds: { address: f.replacements.PoolFunds } } }), /confirmed deployment/);
});
test('unscheduled, waiting, ready and done verify finalized state and all direct receipt evidence', async () => {
  for (const phase of ['unscheduled', 'scheduled', 'done']) {
    const f = createTargetOwnerFixture({ phase }); const proof = await validateTargetOwnerUpgradePreflight(f.provider, f.input, f.options);
    assert.equal(proof.baselineVerified, true); assert.equal(proof.replacementDeploymentVerified, true); assert.equal(proof.codeUpgradeComplete, phase === 'done');
    assert.equal(proof.blockNumber, 400); if (phase === 'done') assert.equal(targetOwnerVerifiedUpgrade(proof), proof);
  }
  const f = createTargetOwnerFixture({ phase: 'scheduled', waiting: true });
  assert.equal((await validateTargetOwnerUpgradePreflight(f.provider, f.input, f.options)).ready, false);
});
test('old FirstoSale keeps old Funds while new Vault uses new Funds and current native aliases', async () => {
  const f = createTargetOwnerFixture(); const oldFunds = f.input.genesisRecord.addresses.PoolFunds;
  assert.equal(f.input.reviewCatalog.nodes.FirstoSale.links.PoolFunds, oldFunds);
  assert.equal(f.plan.deployments[2].libraries.FirstoSale, f.input.reviewCatalog.nodes.FirstoSale.address);
  assert.equal(f.plan.deployments[2].libraries.PoolFunds, f.replacements.PoolFunds);
  await validateTargetOwnerUpgradePreflight(f.provider, f.input, f.options);
  const node = f.input.reviewCatalog.nodes.FirstoSale; node.links.PoolFunds = f.replacements.PoolFunds;
  f.input.trustedReviewCatalogDigest = evidenceDigest(f.input.reviewCatalog);
  await assert.rejects(validateTargetOwnerUpgradePreflight(f.provider, f.input, f.options), /retain old PoolFunds/);
});
test('CREATE sender, nonce/address, initcode, canonical inclusion and exact runtime cannot be substituted', async () => {
  const changes = [f => { f.transactions.get(f.deployments.PoolFunds.txHash).from = ZeroAddress; },
    f => { f.transactions.get(f.deployments.PoolFunds.txHash).nonce++; },
    f => { f.transactions.get(f.deployments.FlexiblePurchase.txHash).data += '00'; },
    f => { f.receipts.get(f.deployments.PoolVault.txHash).status = 0; },
    f => { f.blocks.get(310).transactions = [hash('unrelated')]; },
    f => { f.codes.set(f.replacements.PoolVault.toLowerCase(), '0x6000'); },
    f => { f.codes.set(f.replacements.PoolFunds.toLowerCase(), f.plan.deployments[0].expectedRuntime.replace(f.replacements.PoolFunds.slice(2).toLowerCase(), '1'.repeat(40))); }];
  for (const change of changes) { const f = createTargetOwnerFixture(); change(f); await assert.rejects(validateTargetOwnerUpgradePreflight(f.provider, f.input, f.options)); }
});
test('roles, Authority owner, chain, event metadata and full schedule delay are mandatory', async () => {
  const changes = [f => { f.state.chain = '0x1'; }, f => { f.state.delay = 1n; }, f => { f.state.authorityOwner = ZeroAddress; },
    f => { f.receipts.get(f.options.scheduleTxHash).logs[0].removed = true; },
    f => { f.receipts.get(f.options.executeTxHash).logs[0].transactionHash = hash('wrong'); },
    f => { f.blocks.get(380).timestamp = 272799; }, f => { f.transactions.get(f.options.executeTxHash).data += '00'; }];
  for (const change of changes) { const f = createTargetOwnerFixture(); change(f); await assert.rejects(validateTargetOwnerUpgradePreflight(f.provider, f.input, f.options)); }
});
test('reorg or anchor change during the final recheck rejects the whole proof', async () => {
  const f = createTargetOwnerFixture(), original = f.provider.getBlock; let calls = 0;
  f.provider.getBlock = async tag => { const block = await original(tag); if (tag === 400 && ++calls > 1) block.hash = hash('reorg'); return block; };
  await assert.rejects(validateTargetOwnerUpgradePreflight(f.provider, f.input, f.options), /changed/);
});
test('persistent catalog pin is mandatory, frozen, and graph adapter verifies all five receipts', async () => {
  const f = createTargetOwnerFixture();
  assert.throws(() => validateTargetOwnerUpgradeCatalog(f.finalCatalog, f.input.upgradeBundle, f.input), /operator pin/);
  const approved = validateTargetOwnerUpgradeCatalog(f.finalCatalog, f.input.upgradeBundle, f.input, { trustedCatalogDigest: evidenceDigest(f.finalCatalog) });
  assert(Object.isFrozen(approved)); assert.equal(approved.catalog.nodes.FirstoSale.links.PoolFunds, original.addresses.PoolFunds);
  const proof = await verifyTargetOwnerUpgrade(f.provider, { targetOwnerUpgrade: approved }, f.blocks.get(400));
  assert.equal(proof.catalogDigest, evidenceDigest(f.finalCatalog)); assert.equal(proof.codeUpgradeComplete, true);
  await assert.rejects(verifyTargetOwnerUpgrade(f.provider, { targetOwnerUpgrade: structuredClone(approved) }, f.blocks.get(400)), /Unvalidated/);
  assert.throws(() => targetOwnerVerifiedUpgrade({ codeUpgradeComplete: true }), /Unverified/);
  f.state.phase = 'unscheduled'; assert.equal(await verifyTargetOwnerUpgrade(f.provider, { targetOwnerUpgrade: approved }, f.blocks.get(400)), null);
});

test('completed history cache saves receipt reads and rejects reorg, version drift and provider substitution', async () => {
  const f = createTargetOwnerFixture(), approved = validateTargetOwnerUpgradeCatalog(f.finalCatalog, f.input.upgradeBundle, f.input,
    { trustedCatalogDigest: evidenceDigest(f.finalCatalog) }), trusted = { targetOwnerUpgrade: approved };
  const first = await verifyTargetOwnerUpgrade(f.provider, trusted, f.blocks.get(400));
  const historical = f.calls.filter(call => ['getTransaction', 'getTransactionReceipt'].includes(call[0])).length;
  assert.equal(await verifyTargetOwnerUpgrade(f.provider, trusted, f.blocks.get(400)), first);
  assert.equal(f.calls.filter(call => ['getTransaction', 'getTransactionReceipt'].includes(call[0])).length, historical);
  f.state.version = 2n; await assert.rejects(verifyTargetOwnerUpgrade(f.provider, trusted), /version/); f.state.version = 1n;
  f.blocks.get(400).hash = hash('changed cached completion');
  await assert.rejects(verifyTargetOwnerUpgrade(f.provider, trusted), /Cached completion/);
  const other = createTargetOwnerFixture(); other.transactions.clear();
  await assert.rejects(verifyTargetOwnerUpgrade(other.provider, trusted), /inclusion/);
});

test('real ethers Log objects serialize protocol evidence without traversing their provider', async () => {
  const f = createTargetOwnerFixture(); f.provider.cycle = f.provider;
  for (const receipt of f.receipts.values()) receipt.logs = receipt.logs.map(log => new Log(log, f.provider));
  f.provider.getTransactionReceipt = async txHash => f.receipts.get(txHash);
  assert.equal((await validateTargetOwnerUpgradePreflight(f.provider, f.input, f.options)).codeUpgradeComplete, true);
});

test('core policy market and preserved portfolio market have independent implementation rows', async () => {
  const f = createTargetOwnerFixture({ splitMarkets: true });
  assert.notEqual(f.input.reviewCatalog.nodes.ShareMarket.address, f.input.reviewCatalog.nodes.PortfolioShareMarketImplementation.address);
  assert.equal((await validateTargetOwnerUpgradePreflight(f.provider, f.input, f.options)).codeUpgradeComplete, true);
  f.input.reviewCatalog.implementations.portfolioShareMarket = 'ShareMarket';
  f.input.trustedReviewCatalogDigest = evidenceDigest(f.input.reviewCatalog);
  // The provider retains the independently pinned portfolio pointer despite the altered catalog claim.
  const originalStorage = f.provider.getStorage;
  f.provider.getStorage = async (to, slot, block) => to.toLowerCase() === f.input.genesisRecord.addresses.portfolioShareMarket.toLowerCase()
    ? `0x${f.input.genesisRecord.addresses.ShareMarket.slice(2).toLowerCase().padStart(64, '0')}` : originalStorage(to, slot, block);
  await assert.rejects(validateTargetOwnerUpgradePreflight(f.provider, f.input, f.options), /portfolioShareMarket implementation/);
});
