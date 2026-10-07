import assert from 'node:assert/strict';
import test from 'node:test';
import { AbiCoder, Interface, ZeroAddress, ZeroHash, keccak256, toUtf8Bytes } from 'ethers';
import { evidenceDigest } from './firsto-upgrade-proof.mjs';
import { buildGovernance24UpgradePlan } from './governance24-upgrade-plan.mjs';
import {readFileSync} from 'node:fs';
import { validateGovernance24UpgradePreflight, governance24VerifiedUpgrade, verifyGovernance24OperationReceipt } from './governance24-upgrade-proof.mjs';
import { createGovernance24Fixture } from './governance24-upgrade-test-fixture.mjs';
import { createTargetOwnerFixture } from './target-owner-upgrade-test-fixture.mjs';
import { targetOwnerTestSigner } from './target-owner-upgrade-wrapper-test-fixture.mjs';
import { FRESH_DELEGATION_MANAGER, FRESH_DELEGATOR, FRESH_BALANCE_ENFORCER } from './fresh-activation-execution.mjs';
const hash=x=>keccak256(toUtf8Bytes(x));
test('prepared prefix and complete done proof remain read-only and only actual proof is branded',async()=>{
  const f=createGovernance24Fixture({phase:'unscheduled'});
  const prefix=await validateGovernance24UpgradePreflight(f.provider,f.input,{phase:'prepared',deployments:{FlexiblePurchase:f.deployments.FlexiblePurchase}});
  assert.deepEqual(prefix.verifiedDeploymentNames,['FlexiblePurchase']);assert.equal(prefix.replacementDeploymentVerified,false);
  assert.throws(()=>governance24VerifiedUpgrade({...prefix,governanceMigrationComplete:true,codeUpgradeComplete:true}),/Unverified/);
  f.state.phase='done';const done=await validateGovernance24UpgradePreflight(f.provider,f.input,{...f.options,phase:'done'});
  assert.equal(governance24VerifiedUpgrade(done),done);assert.equal(done.governanceMigrationComplete,true);assert.equal(done.coverageVerified,true);
  assert.equal(done.businessDelaySeconds,86400);assert.equal(done.legacyRecoveryDelaySeconds,172800);
  assert.throws(()=>governance24VerifiedUpgrade(structuredClone(done)),/Unverified/);
  assert.equal(f.base.calls.every(call=>!['eth_sendTransaction','eth_sendRawTransaction'].includes(call[0])),true);
});
test('both waiting and ready states retain original 48-hour timestamps and independent pending operation',async()=>{
  const f=createGovernance24Fixture({phase:'scheduled',waiting:true});
  assert.equal((await validateGovernance24UpgradePreflight(f.provider,f.input,f.options)).ready,false);
  f.state.waiting=false;f.blocks.get(1100).timestamp=1180000;
  assert.equal((await validateGovernance24UpgradePreflight(f.provider,f.input,f.options)).ready,true);
  f.state.pendingTimestamp=1n;await assert.rejects(validateGovernance24UpgradePreflight(f.provider,f.input,f.options),/pending/);
});
for(const [name,mutate] of [
  ['CREATE nonce',f=>f.transactions.get(f.deployments.CoreGovernance24Dispatcher.txHash).nonce++],
  ['initcode trailing bytes',f=>f.transactions.get(f.deployments.Governance24FreshPoolFactory.txHash).data+='00'],
  ['receipt index inclusion',f=>{f.blocks.get(900).transactions=[hash('wrong')];}],
  ['new library runtime',f=>f.codes.set(f.replacements.Governance24Validation.toLowerCase(),'0x6000')],
  ['new 24h floor',f=>{f.state.newDelay=86399n;}],
  ['secondary beacon owner',f=>{f.state.secondaryOwner=ZeroAddress;}],
  ['incomplete atomic execution events',f=>{f.receipts.get(f.executeTxHash).logs.splice(4,1);}],
  ['original schedule salt',f=>{f.receipts.get(f.scheduleTxHash).logs.pop();}],
  ['48h execution one second early',f=>{f.blocks.get(1090).timestamp=1172799;}],
])test(`complete proof rejects ${name}`,async()=>{
  const f=createGovernance24Fixture();mutate(f);await assert.rejects(validateGovernance24UpgradePreflight(f.provider,f.input,f.options));
});
test('every newly appended pool is enumerated under the preserved old beacon and receives current 24h business dispatch',async()=>{
  const f=createGovernance24Fixture(),address='0x0000000000000000000000000000000000009988';
  f.state.corePools.push({address});f.codes.set(address.toLowerCase(),'0x60006000');
  const proof=await validateGovernance24UpgradePreflight(f.provider,f.input,f.options);
  assert.equal(proof.inventory.corePools.length,1);assert.equal(proof.inventory.corePools[0].beacon,f.input.predecessorInput.reviewCatalog.bindings.beacon);
  const original=f.provider.getStorage;f.provider.getStorage=async(to,...args)=>to.toLowerCase()===address.toLowerCase()?`0x${'00'.repeat(32)}`:original(to,...args);
  await assert.rejects(validateGovernance24UpgradePreflight(f.provider,f.input,f.options),/storage word|binding|Zero address/);
});
test('exact operation receipt requires pinned inventory; public calldata alone is not a migration proof',async()=>{
  const f=createGovernance24Fixture(),tx=f.transactions.get(f.scheduleTxHash),receipt=f.receipts.get(f.scheduleTxHash);
  const expected={input:f.input,plan:f.plan,operation:'schedule',to:f.plan.timelock,from:tx.from,data:f.plan.scheduleData,dataHash:keccak256(f.plan.scheduleData)};
  assert.equal((await verifyGovernance24OperationReceipt(f.provider,{tx,receipt,expected})).operationId,f.plan.operationId);
  await assert.rejects(verifyGovernance24OperationReceipt(f.provider,{tx,receipt,expected:{...expected,input:undefined}}),/Pinned input/);
  await assert.rejects(verifyGovernance24OperationReceipt(f.provider,{tx,receipt,expected:{...expected,nonce:tx.nonce+1}}),/nonce/);
  const plan=structuredClone(f.plan);plan.payloads.pop();await assert.rejects(verifyGovernance24OperationReceipt(f.provider,{tx,receipt,expected:{...expected,plan}}),/inventory/);
});
test('canonical recheck rejects main chain hash change after successful graph reads',async()=>{
  const f=createGovernance24Fixture(),original=f.provider.getCode;
  f.provider.getCode=async(...args)=>{const code=await original(...args);f.blocks.get(1100).hash=hash('reorg');return code;};
  await assert.rejects(validateGovernance24UpgradePreflight(f.provider,f.input,f.options),/canonical|changed/);
});
test('complete seven-call migration supports only the original canonical signed single-call wallet wrapper',async()=>{
  const f=createGovernance24Fixture({predecessorFixture:createTargetOwnerFixture({phase:'done',proposer:targetOwnerTestSigner.address})});
  const tx=f.transactions.get(f.scheduleTxHash),receipt=f.receipts.get(f.scheduleTxHash),runtime=JSON.parse(readFileSync(new URL('../src/fixtures/fresh-delegation-runtime.json',import.meta.url),'utf8'));
  for(const [fixed,key]of[[FRESH_DELEGATION_MANAGER,'manager'],[FRESH_DELEGATOR,'delegator'],[FRESH_BALANCE_ENFORCER,'enforcer']])f.codes.set(fixed.address.toLowerCase(),runtime.codes[key].code);
  const types={Delegation:[{name:'delegate',type:'address'},{name:'delegator',type:'address'},{name:'authority',type:'bytes32'},{name:'caveats',type:'Caveat[]'},{name:'salt',type:'uint256'}],Caveat:[{name:'enforcer',type:'address'},{name:'terms',type:'bytes'}]};
  const delegation={delegate:tx.from,delegator:tx.from,authority:`0x${'ff'.repeat(32)}`,caveats:[{enforcer:FRESH_BALANCE_ENFORCER.address,terms:`0x01${tx.from.slice(2)}${'00'.repeat(32)}`,args:'0x'}],salt:987n};
  delegation.signature=await targetOwnerTestSigner.signTypedData({name:'DelegationManager',version:'1',chainId:56,verifyingContract:FRESH_DELEGATION_MANAGER.address},types,delegation);
  const context=AbiCoder.defaultAbiCoder().encode(['tuple(address delegate,address delegator,bytes32 authority,tuple(address enforcer,bytes terms,bytes args)[] caveats,uint256 salt,bytes signature)[]'],[[delegation]]);
  const manager=new Interface(['function redeemDelegations(bytes[],bytes32[],bytes[])']);
  const execution=`0x${f.plan.timelock.slice(2)}${'00'.repeat(32)}${f.plan.scheduleData.slice(2)}`;
  tx.to=receipt.to=FRESH_DELEGATION_MANAGER.address;tx.type=2;tx.authorizationList=[];tx.data=manager.encodeFunctionData('redeemDelegations',[[context],[ZeroHash],[execution]]);
  const expected={input:f.input,plan:f.plan,operation:'schedule',to:f.plan.timelock,from:tx.from,data:f.plan.scheduleData,dataHash:keccak256(f.plan.scheduleData),nonce:tx.nonce};
  const request={tx,receipt,expected,finalized:f.blocks.get(1100)};
  assert.equal((await verifyGovernance24OperationReceipt(f.provider,request)).kind,'wrapped');
  tx.data=manager.encodeFunctionData('redeemDelegations',[[context],[ZeroHash],[execution,execution]]);
  await assert.rejects(verifyGovernance24OperationReceipt(f.provider,request),/execution_count/);
  tx.data=manager.encodeFunctionData('redeemDelegations',[[context],[ZeroHash],[execution]]);receipt.status=0;receipt.logs=[];
  assert.equal((await verifyGovernance24OperationReceipt(f.provider,request)).status,0);
});
test('covered pending beacon cancellation requires original proposer, canonical receipt and historical pending-to-zero transition',async()=>{
  const f=createGovernance24Fixture({conflictingPending:true,cancelled:true});
  const proof=await validateGovernance24UpgradePreflight(f.provider,f.input,f.options);
  assert.deepEqual(proof.confirmedCancellationIds,[f.plan.cancellations[0].operationId.toLowerCase()]);
  await assert.rejects(validateGovernance24UpgradePreflight(f.provider,f.input,{...f.options,cancellationTxHashes:{}}),/user-signed canonical cancellation/);
  const receipt=f.receipts.get(f.cancellationTxHash);receipt.logs=[];
  await assert.rejects(validateGovernance24UpgradePreflight(f.provider,f.input,f.options),/Cancelled/);
});
test('state-zero without an accepted original cancel receipt never authorizes schedule, and no cancellation is sent by proof',async()=>{
  const f=createGovernance24Fixture({phase:'unscheduled',conflictingPending:true});
  const prepared=await validateGovernance24UpgradePreflight(f.provider,f.input,{phase:'prepared'});assert.equal(prepared.codeUpgradeComplete,false);
  f.state.cancelled=true;
  await assert.rejects(validateGovernance24UpgradePreflight(f.provider,f.input,f.options),/user-signed canonical cancellation/);
  const tx=f.transactions.get(f.cancellationTxHash),receipt=f.receipts.get(f.cancellationTxHash);tx.from=receipt.from=ZeroAddress;
  await assert.rejects(validateGovernance24UpgradePreflight(f.provider,f.input,{...f.options,cancellationTxHashes:{[f.plan.cancellations[0].operationId]:f.cancellationTxHash}}));
});
test('prepared cancelled receipts require exact prerequisite prefix independent of journal parser',async()=>{
  const f=createGovernance24Fixture({conflictingPending:true,cancelled:true}),first=f.input.reviewCatalog.pendingOperations[0],second={...first,
    target:f.input.predecessorInput.reviewCatalog.bindings.beacon,salt:hash('second-covered-cancel')};
  second.operationId=keccak256(AbiCoder.defaultAbiCoder().encode(['address','uint256','bytes','bytes32','bytes32'],[second.target,second.value,second.data,second.predecessor,second.salt]));
  f.input.reviewCatalog.pendingOperations.push(second);f.input.trustedReviewCatalogDigest=evidenceDigest(f.input.reviewCatalog);
  const plan=buildGovernance24UpgradePlan({...f.input,replacements:f.replacements});
  await assert.rejects(validateGovernance24UpgradePreflight(f.provider,f.input,{phase:'prepared',deployments:f.deployments,plan,
    cancellationTxHashes:{[plan.cancellations[1].id]:f.cancellationTxHash}}),/prerequisite prefix/);
});
