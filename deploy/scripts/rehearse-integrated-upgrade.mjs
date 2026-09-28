import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Interface, JsonRpcProvider, keccak256, toUtf8Bytes } from 'ethers';
import { buildDigest } from '../shared/firsto-upgrade-proof.mjs';
import {
  integratedUpgradeDeploymentOrder, integratedUpgradeDeploymentData,
  integratedAuthorityDeploymentData, validateIntegratedAuthorityAgainstChain,
  buildIntegratedProposerBootstrapPlan, validateIntegratedProposerBootstrapAgainstChain,
  validateIntegratedUpgradePreparationAgainstChain,
  validateIntegratedUpgradeGenesisAgainstChain,
  validateIntegratedUpgradePartialReplacementsAgainstChain,
  buildIntegratedUpgradePlan, validateIntegratedUpgradePlanAgainstChain,
  validateIntegratedUpgradeScheduledAgainstChain, validateIntegratedUpgradeResultAgainstChain,
  buildIntegratedTreasuryMigrationPlan,
  buildIntegratedRoleMigrationPlan, validateIntegratedRoleMigrationActionAgainstChain,
  validateIntegratedRoleMigrationStateAgainstChain,
  validateIntegratedTreasuryMigrationActionAgainstChain,
  validateIntegratedTreasuryMigrationResultAgainstChain,
  validateIntegratedOnChainMigrationCompleteAgainstChain,
  buildIntegratedCreationResumePlan, validateIntegratedCreationResumeActionAgainstChain,
  validateIntegratedCreationResumeResultAgainstChain,
} from '../shared/integrated-upgrade-plan.mjs';

// This script sends transactions only to a local, explicitly identified Anvil
// fork. It has no private key, mainnet RPC write path, or deployment side effect.
const url = 'http://127.0.0.1:8547';
const provider = new JsonRpcProvider(url,56,{staticNetwork:true});
const view = {
  send:(...args)=>provider.send(...args),
  getBlock:tag=>provider.getBlock(tag === 'finalized' ? 'latest' : tag),
  getCode:(...args)=>provider.getCode(...args),
  getStorage:(...args)=>provider.getStorage(...args),
  getTransaction:(...args)=>provider.getTransaction(...args),
  getTransactionReceipt:(...args)=>provider.getTransactionReceipt(...args),
};
const read = path => JSON.parse(readFileSync(path,'utf8'));
const args = process.argv.slice(2);
const option = flag => { const at=args.indexOf(flag); assert(at >= 0 && args[at+1],`Missing ${flag}`); return args[at+1]; };
const genesisRecord = read(option('--genesis-record'));
const genesisBundle = read(option('--genesis-bundle'));
const upgradeBundle = read(option('--upgrade-bundle'));
const trustedGenesisManifest = read(option('--trusted-manifest'));
const trustedUpgradeArtifactDigest = buildDigest(upgradeBundle);
const old = genesisRecord.addresses;
const forkVersion = await provider.send('web3_clientVersion',[]);
assert.match(forkVersion,/anvil/i,'The target is not a local Anvil fork.');
assert.equal(BigInt(await provider.send('eth_chainId',[])),56n);
const signer = await provider.getSigner(0);
const oldOwner = genesisRecord.input.ownerMultisig;
await provider.send('anvil_impersonateAccount',[oldOwner]);
await provider.send('anvil_setBalance',[oldOwner,'0x8ac7230489e80000']);
const owner = await provider.getSigner(oldOwner);
const pause = new Interface(['function pauseCreation(bool)','function creationPaused() view returns(bool)']);
const baseInput={genesisRecord,genesisBundle,trustedGenesisManifest};
for (const [nextPause,factory] of [['core',old.factory],['budget',old.portfolioFactory]]) {
  const checked=await validateIntegratedUpgradePreparationAgainstChain(view,
    {...baseInput,signer:oldOwner,nextPause});
  assert.equal(checked.target.toLowerCase(),factory.toLowerCase());
  assert.equal(checked.data,pause.encodeFunctionData('pauseCreation',[true]));
  const tx=await owner.sendTransaction({to:checked.target,data:checked.data,gasLimit:300000n});
  assert.equal((await tx.wait()).status,1,'Creation pause failed on fork.');
}
const genesis=await validateIntegratedUpgradeGenesisAgainstChain(view,baseInput);
assert(BigInt(genesis.poolCount)>0n,'This rehearsal requires nonzero real historical pools.');
console.log(JSON.stringify({phase:'genesis',forkBlock:genesis.blockNumber,forkBlockHash:genesis.blockHash,
  poolCount:genesis.poolCount,
  portfolioCount:genesis.portfolioCount,historical:genesis.historical}));

const hardwareWallet=await signer.getAddress();
const bootstrap=buildIntegratedProposerBootstrapPlan({...baseInput,hardwareWallet,
  salt:keccak256(toUtf8Bytes('integrated-v2-local-fork-bootstrap')),delaySeconds:172800});
await validateIntegratedProposerBootstrapAgainstChain(view,bootstrap,{...baseInput,
  phase:'unscheduled',signer:oldOwner});
const bootstrapSchedule=await owner.sendTransaction({to:old.timelock,data:bootstrap.scheduleData,gasLimit:1000000n});
assert.equal((await bootstrapSchedule.wait()).status,1,'Hardware bootstrap schedule failed.');
await provider.send('evm_increaseTime',[172801]);await provider.send('evm_mine',[]);
await validateIntegratedProposerBootstrapAgainstChain(view,bootstrap,{...baseInput,
  phase:'ready',signer:hardwareWallet});
const bootstrapExecute=await signer.sendTransaction({to:old.timelock,data:bootstrap.executeData,gasLimit:1000000n});
assert.equal((await bootstrapExecute.wait()).status,1,'Hardware bootstrap execution failed.');
await validateIntegratedProposerBootstrapAgainstChain(view,bootstrap,{...baseInput,phase:'done'});
console.log(JSON.stringify({phase:'hardware-bootstrap',operationId:bootstrap.operationId}));

const marketIface=new Interface(genesisBundle.artifacts.ShareMarket.abi);
const vaultIface=new Interface(genesisBundle.artifacts.PoolVault.abi);
const factoryIface=new Interface(genesisBundle.artifacts.PoolFactory.abi);
async function raw(to,iface,method,args=[]) {
  return provider.send('eth_call',[{to,data:iface.encodeFunctionData(method,args)},'latest']);
}
const before={poolCount:await raw(old.factory,factoryIface,'poolCount'),
  portfolioCount:await raw(old.portfolioFactory,new Interface(genesisBundle.artifacts.BudgetPortfolioFactory.abi),'portfolioCount'),
  marketNextOrderId:await raw(old.shareMarket,marketIface,'nextOrderId'),
  marketTotalOwed:await raw(old.shareMarket,marketIface,'totalBnbOwed'),
  poolStates:[],orders:[]};
const orderNext=Number(marketIface.decodeFunctionResult('nextOrderId',before.marketNextOrderId)[0]);
assert(orderNext<=1000,'Historical order set exceeds bounded rehearsal.');
for(let id=0;id<orderNext;id++)before.orders.push(await raw(old.shareMarket,marketIface,'orders',[id]));
for(const item of genesis.historical.filter(v=>v.kind==='pool')) {
  const p={address:item.address,treasury:item.treasury,
    state:await raw(item.address,vaultIface,'state'),params:await raw(item.address,vaultIface,'params'),
    supply:await raw(item.address,vaultIface,'totalSupply'),
    totalRaised:await raw(item.address,vaultIface,'totalRaised'),
    ownerBalance:await raw(item.address,vaultIface,'balanceOf',[oldOwner]),
    oldBnbOwed:await raw(item.address,vaultIface,'bnbOwed',[item.treasury])};
  before.poolStates.push(p);
}

const addresses={...old};
const deployments={};
for(const name of integratedUpgradeDeploymentOrder) {
  const data=integratedUpgradeDeploymentData(name,upgradeBundle,addresses);
  const tx=await signer.sendTransaction({data,gasLimit:12000000n});
  const receipt=await tx.wait();assert.equal(receipt.status,1,`${name} deployment failed.`);
  assert(receipt.contractAddress,`${name} missing contract address.`);
  deployments[name]=receipt.contractAddress;
  addresses[name]=receipt.contractAddress;
  await validateIntegratedUpgradePartialReplacementsAgainstChain(view,{...baseInput,upgradeBundle,
    trustedUpgradeArtifactDigest,deployments});
}
console.log(JSON.stringify({phase:'replacements',count:Object.keys(deployments).length}));
const plan=buildIntegratedUpgradePlan({...baseInput,upgradeBundle,trustedUpgradeArtifactDigest,
  replacements:deployments,salt:keccak256(toUtf8Bytes('integrated-v2-local-fork-stage1')),
  delaySeconds:172800});
await validateIntegratedUpgradePlanAgainstChain(view,plan,{...baseInput,upgradeBundle,
  trustedUpgradeArtifactDigest,proposer:hardwareWallet,bootstrapPlan:bootstrap});
const schedule=await signer.sendTransaction({to:old.timelock,data:plan.scheduleData,gasLimit:2500000n});
assert.equal((await schedule.wait()).status,1,'Stage1 schedule failed.');
await provider.send('evm_increaseTime',[172801]);await provider.send('evm_mine',[]);
const ready=await validateIntegratedUpgradeScheduledAgainstChain(view,plan,{...baseInput,
  upgradeBundle,trustedUpgradeArtifactDigest,proposer:hardwareWallet,bootstrapPlan:bootstrap});
const execute=await signer.sendTransaction({to:old.timelock,data:plan.executeData,gasLimit:15000000n});
assert.equal((await execute.wait()).status,1,'Stage1 execution failed.');
const result=await validateIntegratedUpgradeResultAgainstChain(view,plan,{...baseInput,
  upgradeBundle,trustedUpgradeArtifactDigest,preExecutionPreflight:ready,
  scheduleTxHash:schedule.hash,executeTxHash:execute.hash});
assert.equal(result.codeUpgradeComplete,true);
assert.equal(result.roleMigrationComplete,false);
assert.equal(await raw(old.factory,factoryIface,'poolCount'),before.poolCount);
assert.equal(await raw(old.shareMarket,marketIface,'nextOrderId'),before.marketNextOrderId);
assert.equal(await raw(old.shareMarket,marketIface,'totalBnbOwed'),before.marketTotalOwed);
for(let id=0;id<orderNext;id++)assert.equal(await raw(old.shareMarket,marketIface,'orders',[id]),before.orders[id]);
for(const p of before.poolStates)for(const [method,key,arg] of [
  ['state','state'],['params','params'],['totalSupply','supply'],['totalRaised','totalRaised'],
  ['balanceOf','ownerBalance',oldOwner],['bnbOwed','oldBnbOwed',p.treasury],
]) assert.equal(await raw(p.address,vaultIface,method,arg===undefined?[]:[arg]),p[key],`${p.address} ${method} changed`);
console.log(JSON.stringify({phase:'code-upgrade',operationId:result.operationId,
  historicalTreasuryResidual:result.legacyTreasuryResidual.length,oldOrderCount:orderNext}));

const adminOne='0x7674fa446D42b1f7f150DC5e678cc525d275Ea53';
const adminTwo='0xed2fcbe59ebe1754a3676aeb9ccfba20f193fcbb';
// The real Gas address is supplied only at live deployment. A local dummy
// address keeps this rehearsal from depending on or exposing any credential.
const gasWallet='0x8888888888888888888888888888888888888888';
const authorityInput={...baseInput,codePlan:plan,upgradeBundle,trustedUpgradeArtifactDigest,
  administratorOne:adminOne,administratorTwo:adminTwo,gasWallet};
const authorityData=integratedAuthorityDeploymentData(authorityInput);
const authorityTx=await signer.sendTransaction({data:authorityData,gasLimit:12000000n});
const authorityReceipt=await authorityTx.wait();
assert.equal(authorityReceipt.status,1,'PlatformAuthority fork deployment failed.');
const authority=authorityReceipt.contractAddress;
const proofInput={...authorityInput,authorityAddress:authority,deploymentTxHash:authorityTx.hash,
  bootstrapPlan:bootstrap};
await validateIntegratedAuthorityAgainstChain(view,proofInput);
const rolePlan=buildIntegratedRoleMigrationPlan({genesisRecord,codePlan:plan,bootstrapPlan:bootstrap,
  authorityAddress:authority,hardwareWallet,
  salt:keccak256(toUtf8Bytes('integrated-v2-local-fork-roles')),delaySeconds:172800});
for(let index=0;index<4;index++){
  const check=await validateIntegratedRoleMigrationActionAgainstChain(view,rolePlan,
    {...proofInput,action:{type:'direct',index},signer:oldOwner});
  const tx=await owner.sendTransaction({to:check.target,data:check.calldata,gasLimit:400000n});
  assert.equal((await tx.wait()).status,1,`${rolePlan.directSteps[index].name} failed.`);
}
await validateIntegratedRoleMigrationActionAgainstChain(view,rolePlan,
  {...proofInput,action:{type:'schedule'},signer:hardwareWallet});
const roleSchedule=await signer.sendTransaction({to:old.timelock,
  data:rolePlan.roleBatch.scheduleData,gasLimit:1000000n});
assert.equal((await roleSchedule.wait()).status,1,'Role revocation schedule failed.');
await provider.send('evm_increaseTime',[172801]);await provider.send('evm_mine',[]);
await validateIntegratedRoleMigrationActionAgainstChain(view,rolePlan,
  {...proofInput,action:{type:'execute'},signer:hardwareWallet});
const roleExecute=await signer.sendTransaction({to:old.timelock,
  data:rolePlan.roleBatch.executeData,gasLimit:1000000n});
assert.equal((await roleExecute.wait()).status,1,'Role revocation execution failed.');
for(let index=4;index<6;index++){
  const check=await validateIntegratedRoleMigrationActionAgainstChain(view,rolePlan,
    {...proofInput,action:{type:'direct',index},signer:oldOwner});
  const tx=await owner.sendTransaction({to:check.target,data:check.calldata,gasLimit:400000n});
  assert.equal((await tx.wait()).status,1,`${rolePlan.directSteps[index].name} failed.`);
}
const roleState=await validateIntegratedRoleMigrationStateAgainstChain(view,rolePlan,proofInput);
assert.equal(roleState.roleWiringComplete,true);
assert.equal(roleState.current.coreOwner.toLowerCase(),old.timelock.toLowerCase(),
  'Core Factory must be owned by the 48-hour Timelock.');
assert.equal(roleState.current.budgetOwner.toLowerCase(),old.timelock.toLowerCase(),
  'Budget Factory must be owned by the 48-hour Timelock.');
console.log(JSON.stringify({phase:'authority-and-roles',authority,roleOperationId:rolePlan.roleBatch.operationId}));
const migration=buildIntegratedTreasuryMigrationPlan({genesisRecord,codeResult:result,
  authorityAddress:authority,saltSeed:keccak256(toUtf8Bytes('integrated-v2-local-fork-treasury')),
  delaySeconds:172800});
for(const [operationIndex,operation] of migration.operations.entries()) {
  const migrationInput={...proofInput,rolePlan,codeResult:result,operationIndex};
  await validateIntegratedTreasuryMigrationActionAgainstChain(view,migration,
    {...migrationInput,phase:'unscheduled',signer:hardwareWallet});
  const tx=await signer.sendTransaction({to:old.timelock,data:operation.scheduleData,gasLimit:600000n});
  assert.equal((await tx.wait()).status,1,'Treasury migration schedule failed.');
  await provider.send('evm_increaseTime',[172801]);await provider.send('evm_mine',[]);
  const readyMigration=await validateIntegratedTreasuryMigrationActionAgainstChain(view,migration,
    {...migrationInput,phase:'ready',signer:hardwareWallet});
  const executeTx=await signer.sendTransaction({to:old.timelock,data:operation.executeData,gasLimit:8000000n});
  assert.equal((await executeTx.wait()).status,1,'Treasury migration execution failed.');
  await validateIntegratedTreasuryMigrationResultAgainstChain(view,migration,
    {...migrationInput,preExecutionPreflight:readyMigration,
      scheduleTxHash:tx.hash,executeTxHash:executeTx.hash});
  const migrated=await raw(operation.target,vaultIface,'treasury');
  assert.equal(vaultIface.decodeFunctionResult('treasury',migrated)[0].toLowerCase(),authority.toLowerCase());
  const original=before.poolStates.find(p=>p.address.toLowerCase()===operation.target.toLowerCase());
  assert.equal(await raw(operation.target,vaultIface,'bnbOwed',[operation.expectedOld]),original.oldBnbOwed,
    'Previously owed BNB must stay with the old treasury.');
  for(const [method,key,arg] of [
    ['state','state'],['params','params'],['totalSupply','supply'],['totalRaised','totalRaised'],
    ['balanceOf','ownerBalance',oldOwner],
  ]) assert.equal(await raw(operation.target,vaultIface,method,arg===undefined?[]:[arg]),original[key],
    `${operation.target} ${method} changed during treasury migration`);
}
const complete=await validateIntegratedOnChainMigrationCompleteAgainstChain(view,migration,
  {...proofInput,rolePlan,codeResult:result});
assert.equal(complete.roleMigrationComplete,true);
assert.equal(complete.deploymentComplete,false);
assert.equal(await raw(old.shareMarket,marketIface,'nextOrderId'),before.marketNextOrderId);
assert.equal(await raw(old.shareMarket,marketIface,'totalBnbOwed'),before.marketTotalOwed);
for(let id=0;id<orderNext;id++)assert.equal(await raw(old.shareMarket,marketIface,'orders',[id]),before.orders[id]);
const historicalPoolEvidence=before.poolStates.map(p=>({address:p.address,
  shares:vaultIface.decodeFunctionResult('totalSupply',p.supply)[0].toString(),
  oldOwnerShares:vaultIface.decodeFunctionResult('balanceOf',p.ownerBalance)[0].toString(),
  oldBnbOwedWei:vaultIface.decodeFunctionResult('bnbOwed',p.oldBnbOwed)[0].toString(),
  newTreasury:authority}));
console.log(JSON.stringify({phase:'historical-treasury-migration',authority,
  migratedPools:migration.operations.length,allHistoricalOrdersPreserved:true,
  oldAccruedFeesRemainClaimableByOldTreasury:true,historicalPoolEvidence,
  codeUpgradeComplete:result.codeUpgradeComplete,
  roleMigrationComplete:complete.roleMigrationComplete,
  keeperCutoverVerified:complete.keeperCutoverVerified,
  deploymentComplete:complete.deploymentComplete}));
const resumePlan=buildIntegratedCreationResumePlan({genesisRecord,rolePlan,migrationPlan:migration,
  salt:keccak256(toUtf8Bytes('integrated-v2-local-fork-resume')),delaySeconds:172800});
const resumeInput={...proofInput,rolePlan,migrationPlan:migration,codeResult:result};
const resumeSchedule=await validateIntegratedCreationResumeActionAgainstChain(view,resumePlan,
  {...resumeInput,phase:'unscheduled',signer:hardwareWallet});
assert.equal(resumeSchedule.roleMigrationComplete,true);
assert.equal(resumeSchedule.keeperCutoverVerified,false);
const resumeScheduleTx=await signer.sendTransaction({to:resumeSchedule.transactionTarget,
  data:resumeSchedule.calldata,gasLimit:1000000n});
assert.equal((await resumeScheduleTx.wait()).status,1,'Creation resume schedule failed.');
await provider.send('evm_increaseTime',[172801]);await provider.send('evm_mine',[]);
const resumeExecute=await validateIntegratedCreationResumeActionAgainstChain(view,resumePlan,
  {...resumeInput,phase:'ready',signer:hardwareWallet});
const resumeExecuteTx=await signer.sendTransaction({to:resumeExecute.transactionTarget,
  data:resumeExecute.calldata,gasLimit:1000000n});
assert.equal((await resumeExecuteTx.wait()).status,1,'Creation resume execution failed.');
assert.equal(await raw(old.factory,pause,'creationPaused'),pause.encodeFunctionResult('creationPaused',[false]));
assert.equal(await raw(old.portfolioFactory,pause,'creationPaused'),
  pause.encodeFunctionResult('creationPaused',[false]));
const resumed=await validateIntegratedCreationResumeResultAgainstChain(view,resumePlan,
  {...resumeInput,scheduleTxHash:resumeScheduleTx.hash,executeTxHash:resumeExecuteTx.hash});
assert.equal(resumed.bothFactoriesUnpaused,true);
assert.equal(resumed.roleMigrationComplete,true);
console.log(JSON.stringify({phase:'creation-resume',operationId:resumePlan.operationId,
  timelockOwner:old.timelock,bothFactoriesUnpausedOnLocalFork:true,
  keeperCutoverVerified:false,deploymentComplete:false}));
