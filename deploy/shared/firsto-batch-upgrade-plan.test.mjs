import assert from 'node:assert/strict';
import test from 'node:test';
import { Interface, ZeroAddress, ZeroHash } from 'ethers';
import { buildDigest, evidenceDigest } from './firsto-upgrade-proof.mjs';
import { buildFirstoBatchUpgradePlan, prepareFirstoBatchUpgradeDeployment, firstoBatchPredecessor,
  validateFirstoBatchUpgradeReview } from './firsto-batch-upgrade-plan.mjs';
import { createFirstoBatchFixture } from './firsto-batch-upgrade-test-fixture.mjs';
const lock = new Interface(['function schedule(address,uint256,bytes,bytes32,bytes32,uint256)',
  'function execute(address,uint256,bytes,bytes32,bytes32) payable']);
const planInput = f => ({ ...f.input, replacements: f.replacements });
const repinReview = input => { input.trustedReviewCatalogDigest = evidenceDigest(input.reviewCatalog); return input; };

test('batch successor deploys only new FlexiblePurchase and Vault, preserving actual mixed graph links', () => {
  const f = createFirstoBatchFixture(), prior = firstoBatchPredecessor(f.input), plan = buildFirstoBatchUpgradePlan(planInput(f));
  assert.deepEqual(plan.deployments.map(row => row.name), ['FlexiblePurchase', 'PoolVault']);
  assert.deepEqual(Object.keys(plan.replacements), ['FlexiblePurchase', 'PoolVault']);
  assert.equal(plan.deployments[0].libraries.PoolFunds, f.core.replacements.PoolFunds);
  assert.equal(plan.deployments[1].libraries.PoolFunds, f.core.replacements.PoolFunds);
  assert.equal(plan.deployments[1].libraries.FlexiblePurchase, f.replacements.FlexiblePurchase);
  assert.equal(plan.deployments[1].libraries.FirstoSale, prior.nodes.FirstoSale.address);
  assert.equal(prior.nodes.FirstoSale.links.PoolFunds, f.input.genesisRecord.addresses.PoolFunds);
  assert.deepEqual(plan.deployments[1].constructorArgs, [f.input.genesisRecord.addresses.factory]);
  assert.equal(prior.nodes.BudgetPortfolioVault.address, f.core.input.reviewCatalog.nodes.BudgetPortfolioVault.address);
  assert.equal(plan.steps.length, 1); assert.equal(plan.target, f.input.genesisRecord.addresses.beacon);
  assert.equal(plan.currentChainStateVerified, false); assert.equal(plan.replacementDeploymentVerified, false);
});
test('canonical one-beacon schedule/execute carries zero funds and the full 48-hour delay', () => {
  const f = createFirstoBatchFixture(), plan = buildFirstoBatchUpgradePlan(planInput(f));
  const schedule = lock.parseTransaction({ data: plan.scheduleData }), execute = lock.parseTransaction({ data: plan.executeData });
  assert.deepEqual([...schedule.args].slice(0, 5), [...execute.args]);
  assert.equal(schedule.args[0], f.input.genesisRecord.addresses.beacon); assert.equal(schedule.args[1], 0n);
  assert.equal(schedule.args[3], ZeroHash); assert.equal(schedule.args[5], 172800n);
  assert.equal(plan.schedule.to, f.input.genesisRecord.addresses.timelock); assert.equal(plan.execute.value, '0');
  for (const delaySeconds of [0, 172799, 172800.5, '172800']) assert.throws(() => buildFirstoBatchUpgradePlan({ ...planInput(f), delaySeconds }), /48-hour/);
  for (const salt of [undefined, ZeroHash, '0x01']) assert.throws(() => buildFirstoBatchUpgradePlan({ ...planInput(f), salt }), /salt/);
});
test('exact two-deployment prefix rejects old three-component recipe and supplied future addresses', () => {
  const f = createFirstoBatchFixture();
  assert.equal(prepareFirstoBatchUpgradeDeployment('FlexiblePurchase', f.input).to, null);
  assert.throws(() => prepareFirstoBatchUpgradeDeployment('PoolVault', f.input), /prefix/);
  assert.equal(prepareFirstoBatchUpgradeDeployment('PoolVault', f.input, { deploymentsPrefix: { FlexiblePurchase: f.deployments.FlexiblePurchase } }).data,
    f.plan.deployments[1].data);
  assert.throws(() => prepareFirstoBatchUpgradeDeployment('PoolFunds', f.input), /prefix/);
  for (const replacements of [{ ...f.replacements, PoolFunds: f.core.replacements.PoolFunds }, { FlexiblePurchase: f.replacements.FlexiblePurchase },
    { ...f.replacements, FlexiblePurchase: ZeroAddress }, { ...f.replacements, PoolVault: f.core.replacements.PoolVault },
    { ...f.replacements, PoolVault: f.replacements.FlexiblePurchase }]) {
    assert.throws(() => buildFirstoBatchUpgradePlan({ ...f.input, replacements }), /two|reuses|Zero address/);
  }
});
test('predecessor, genesis, candidate, review and source evidence all retain independent pins', () => {
  const f = createFirstoBatchFixture();
  for (const pin of ['trustedPriorCoreCatalogDigest', 'trustedGenesisRecordDigest', 'trustedGenesisManifestDigest',
    'trustedUpgradeArtifactDigest', 'trustedReviewCatalogDigest', 'trustedProtocolReviewDigest']) {
    assert.throws(() => validateFirstoBatchUpgradeReview({ ...f.input, [pin]: ZeroHash }));
  }
  const candidate = structuredClone(f.input.upgradeBundle); candidate.artifacts.FlexiblePurchase.bytecode += '00';
  assert.throws(() => validateFirstoBatchUpgradeReview({ ...f.input, upgradeBundle: candidate }), /artifact pin/);
});
test('repinning a caller-edited mixed graph cannot move existing Funds or old FirstoSale links', () => {
  for (const mutate of [input => { input.reviewCatalog.nodes.PoolFunds.address = input.genesisRecord.addresses.PoolFunds; },
    input => { input.reviewCatalog.nodes.FirstoSale.links.PoolFunds = input.priorCoreCatalog.deployments.PoolFunds.address; },
    input => { input.reviewCatalog.bindings.portfolioBeacon = input.reviewCatalog.bindings.beacon; },
    input => { input.reviewCatalog.authority.gasWallet = input.reviewCatalog.deployer; }]) {
    const f = createFirstoBatchFixture(), input = structuredClone(f.input); mutate(input);
    assert.throws(() => validateFirstoBatchUpgradeReview(repinReview(input)), /mixed graph/);
  }
});
test('source/runtime and real-fill evidence cannot be replaced by ABI, API claims or a different pin', () => {
  for (const mutate of [review => { review.exactRuntimeMatch = false; }, review => { review.localFillVerified = false; },
    review => { review.exchange = ZeroAddress; }, review => { review.runtimeCodehash = ZeroHash; }, review => { delete review.kind; }]) {
    const f = createFirstoBatchFixture(), input = structuredClone(f.input); mutate(input.protocolReview);
    input.trustedProtocolReviewDigest = evidenceDigest(input.protocolReview); input.reviewCatalog.protocolReviewDigest = input.trustedProtocolReviewDigest;
    assert.throws(() => validateFirstoBatchUpgradeReview(repinReview(input)), /Exact protocol source/);
  }
});
test('candidate linker and factory immutable checks remain strict for a repinned source review', () => {
  const f = createFirstoBatchFixture(), input = structuredClone(f.input);
  delete input.upgradeBundle.artifacts.PoolVault.immutableReferences.factory;
  input.trustedUpgradeArtifactDigest = buildDigest(input.upgradeBundle); input.reviewCatalog.candidateArtifactDigest = input.trustedUpgradeArtifactDigest;
  assert.throws(() => validateFirstoBatchUpgradeReview(repinReview(input)), /immutable/);
});
test('predecessor cache is immutable and changing any genesis pin or bytes invalidates its identity', () => {
  const f = createFirstoBatchFixture(), first = firstoBatchPredecessor(f.input);
  assert.equal(firstoBatchPredecessor(f.input), first); assert(Object.isFrozen(first.nodes.PoolFunds));
  assert.throws(() => { first.nodes.PoolFunds.address = ZeroAddress; }, TypeError);
  assert.throws(() => firstoBatchPredecessor({ ...f.input, trustedGenesisManifestDigest: ZeroHash }));
  const manifest = structuredClone(f.input.trustedGenesisManifest); manifest.beacon = ZeroAddress;
  assert.throws(() => firstoBatchPredecessor({ ...f.input, trustedGenesisManifest: manifest }));
});
