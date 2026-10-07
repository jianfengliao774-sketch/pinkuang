import assert from 'node:assert/strict';
import test from 'node:test';
import { AbiCoder, Interface, ZeroHash, keccak256 } from 'ethers';
import { evidenceDigest } from './firsto-upgrade-proof.mjs';
import { governance24UpgradeDeploymentOrder, buildGovernance24UpgradePlan, prepareGovernance24UpgradeDeployment,
  validateGovernance24UpgradeReview, governance24Coverage, governance24PendingOperationEffects } from './governance24-upgrade-plan.mjs';
import { validateFirstoBatchUpgradeReview } from './firsto-batch-upgrade-plan.mjs';
import { createGovernance24Fixture } from './governance24-upgrade-test-fixture.mjs';
const actions=new Interface(['function upgradeTo(address)','function upgradeToAndCall(address,bytes)',
  'function migrateGovernance24(address,address)','function transferOwnership(address)']);

test('fixed complete inventory routes six business endpoints and Authority through one original 48h batch',()=>{
  const f=createGovernance24Fixture(),plan=f.plan,a=validateFirstoBatchUpgradeReview(f.input.predecessorInput).addresses;
  assert.equal(plan.deployments.length,13);assert.equal(plan.steps.length,7);assert.equal(plan.nextTimelock,f.replacements.PoolTimelock24);
  assert.deepEqual(plan.targets,[a.beacon,a.portfolioBeacon,a.factory,a.portfolioFactory,a.shareMarket,a.portfolioShareMarket,
    f.input.predecessorInput.reviewCatalog.authority.address]);
  assert.deepEqual(plan.values,Array(7).fill('0'));assert.equal(plan.predecessor,ZeroHash);assert.equal(plan.delaySeconds,172800);
  for (const index of [2,3,4,5]) {
    const upgrade=actions.decodeFunctionData('upgradeToAndCall',plan.payloads[index]);
    assert.deepEqual([...actions.decodeFunctionData('migrateGovernance24',upgrade[1])],[plan.timelock,plan.nextTimelock]);
  }
  assert.equal(actions.decodeFunctionData('transferOwnership',plan.payloads[6])[0],plan.nextTimelock);
  assert.equal(plan.currentChainStateVerified,false);assert.equal(plan.replacementDeploymentVerified,false);
});
test('covered beacon conflicts require fixed unsigned cancellation; uncovered governance intent remains blocked',()=>{
  const f=createGovernance24Fixture(),input=structuredClone(f.input),prior=validateFirstoBatchUpgradeReview(input.predecessorInput),op=input.reviewCatalog.pendingOperations[0];
  op.target=prior.addresses.portfolioBeacon;op.data=actions.encodeFunctionData('upgradeTo',[prior.addresses.BudgetPortfolioVault]);
  op.operationId=keccak256(AbiCoder.defaultAbiCoder().encode(['address','uint256','bytes','bytes32','bytes32'],[op.target,op.value,op.data,op.predecessor,op.salt]));
  input.trustedReviewCatalogDigest=evidenceDigest(input.reviewCatalog);
  assert.equal(validateGovernance24UpgradeReview(input).pendingOperationEffects[0].conflict,true);
  const plan=buildGovernance24UpgradePlan({...input,replacements:f.replacements});assert.equal(plan.cancellations.length,1);
  assert.equal(plan.cancellations[0].operationId,op.operationId);assert.equal(plan.cancellations[0].unsigned,true);
  assert.deepEqual(plan.cancellations[0].originalOperation,op);
  assert.equal(op.timestamp,'900000');
  const self={...op,target:prior.addresses.timelock};assert.equal(governance24PendingOperationEffects(prior,[self])[0].conflict,true);
  const safe=f.input.reviewCatalog.pendingOperations[0];
  const atomic={mode:'batch',operationId:ZeroHash,targets:[op.target,safe.target],values:['0','0'],payloads:[op.data,safe.data]};
  assert.equal(governance24PendingOperationEffects(prior,[atomic])[0].classification,'entire-batch-inert-after-migration');
});
test('exact CREATE dependency prefix rejects omitted, additional, reused and future addresses',()=>{
  const f=createGovernance24Fixture();
  assert.equal(prepareGovernance24UpgradeDeployment('FlexiblePurchase',f.input).to,null);
  assert.throws(()=>prepareGovernance24UpgradeDeployment('PoolVault',f.input),/prefix/);
  assert.equal(prepareGovernance24UpgradeDeployment('PoolVault',f.input,{deploymentsPrefix:{FlexiblePurchase:f.deployments.FlexiblePurchase}}).data,f.plan.deployments[1].data);
  for (const replacements of [{...f.replacements,spurious:f.replacements.PoolVault},Object.fromEntries(Object.entries(f.replacements).slice(0,-1)),
    {...f.replacements,PoolVault:f.replacements.FlexiblePurchase},{...f.replacements,PoolVault:f.input.predecessorInput.reviewCatalog.bindings.factory}]) {
    assert.throws(()=>buildGovernance24UpgradePlan({...f.input,replacements}),/prefix|reuses/);
  }
  assert.equal(governance24UpgradeDeploymentOrder.indexOf('Governance24Validation')<governance24UpgradeDeploymentOrder.indexOf('Governance24FreshPoolFactory'),true);
});
test('candidate constructor links preserve mixed legacy libraries and latest core Firsto batch capability',()=>{
  const f=createGovernance24Fixture(),prior=validateFirstoBatchUpgradeReview(f.input.predecessorInput),row=name=>f.plan.deployments.find(r=>r.name===name);
  assert.equal(row('PoolVault').libraries.FlexiblePurchase,f.replacements.FlexiblePurchase);
  assert.equal(row('PoolVault').libraries.PoolFunds,prior.addresses.PoolFunds);
  assert.equal(row('PoolVault').libraries.FirstoSale,prior.addresses.FirstoSale);
  assert.equal(prior.catalog.nodes.FirstoSale.links.PoolFunds,f.input.predecessorInput.genesisRecord.addresses.PoolFunds);
  const review=validateGovernance24UpgradeReview(f.input),funds=review.linkedAddressClosure.filter(row=>row.name==='PoolFunds');
  assert.equal(funds.length,2);assert.equal(funds.some(row=>row.address===prior.addresses.PoolFunds),true);
  assert.equal(funds.some(row=>row.address===f.input.predecessorInput.genesisRecord.addresses.PoolFunds&&row.source==='trusted-genesis-artifact'),true);
  assert.equal(row('Governance24FreshPoolFactory').libraries.Governance24Validation,f.replacements.Governance24Validation);
  assert.deepEqual(row('CoreGovernance24Dispatcher').constructorArgs,[prior.addresses.factory,f.replacements.CoreGovernance24Beacon]);
});
test('all independent pins, exact coverage, immutable map and full original migration delay fail closed',()=>{
  const f=createGovernance24Fixture();
  for (const key of ['trustedReviewCatalogDigest','trustedUpgradeArtifactDigest','trustedPredecessorInputDigest']) assert.throws(()=>validateGovernance24UpgradeReview({...f.input,[key]:ZeroHash}));
  for (const delaySeconds of [0,86400,172799,'172800',172800.5]) assert.throws(()=>buildGovernance24UpgradePlan({...f.input,replacements:f.replacements,delaySeconds}),/48-hour/);
  assert.throws(()=>buildGovernance24UpgradePlan({...f.input,replacements:f.replacements,salt:ZeroHash}),/nonzero/);
  const input=structuredClone(f.input);input.reviewCatalog.coverage.rows.pop();input.trustedReviewCatalogDigest=evidenceDigest(input.reviewCatalog);
  assert.throws(()=>validateGovernance24UpgradeReview(input),/coverage/);
  const coverage=governance24Coverage(validateFirstoBatchUpgradeReview(f.input.predecessorInput),f.input.predecessorInput);
  for (const name of ['timelock','beacon','portfolioBeacon']) assert.equal(coverage.rows.find(row=>row.name===name).treatment,'legacy-recovery-48h');
  assert.equal(coverage.scope,'current-business-paths-24h-with-48h-legacy-recovery');
});
