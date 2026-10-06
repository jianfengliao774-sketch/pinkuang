import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { Interface, ZeroAddress, getAddress, keccak256, toUtf8Bytes } from 'ethers';
import { buildDigest } from './firsto-upgrade-proof.mjs';
import { reviewedUpgradeBytecode } from './integrated-upgrade-plan.mjs';
import { freshUpgradeDeploymentOrder, freshUpgradeDeploymentData, buildFreshActiveUpgradePlan,
  validateFreshActiveGraphAgainstChain,validateFreshActiveReplacementsAgainstChain,
  validateFreshActiveUpgradeAgainstChain } from './fresh-active-upgrade-plan.mjs';

const json=name=>JSON.parse(readFileSync(new URL(name,import.meta.url),'utf8'));
const record=json('../public/upgrade-genesis/genesis-record.json');
const bundle=json('../public/upgrade-genesis/genesis-artifacts.json');
const manifest=json('../../web/public/data/frontend-manifest.json');
const candidate=json('../public/deployment-artifacts.json');
const replacement=Object.fromEntries(freshUpgradeDeploymentOrder.map((name,index)=>[name,getAddress(`0x${(0x123400+index).toString(16).padStart(40,'0')}`)]));
const salt=keccak256(toUtf8Bytes('strict fresh-v5 active upgrade regression'));
const common={genesisRecord:record,genesisBundle:bundle,trustedGenesisManifest:manifest,
  upgradeBundle:candidate,trustedUpgradeArtifactDigest:buildDigest(candidate)};
const abi=new Interface(['function owner() view returns(address)','function timelock() view returns(address)',
  'function operator() view returns(address)','function treasury() view returns(address)','function creationPaused() view returns(bool)',
  'function pauseCreation(bool)','function lens() view returns(address)','function factory() view returns(address)',
  'function poolCount() view returns(uint256)','function allPools(uint256) view returns(address)',
  'function portfolioCount() view returns(uint256)','function portfolioAt(uint256) view returns(address)',
  'function machineRegistryStatus() view returns(bool,bool,uint256,uint256)',
  'function implementation() view returns(address)','function coreFactory() view returns(address)','function budgetFactory() view returns(address)',
  'function administratorOne() view returns(address)','function administratorTwo() view returns(address)','function gasWallet() view returns(address)',
  'function getMinDelay() view returns(uint256)','function hasRole(bytes32,address) view returns(bool)',
  'function hashOperationBatch(address[],uint256[],bytes[],bytes32,bytes32) view returns(bytes32)',
  'function isOperation(bytes32) view returns(bool)','function isOperationReady(bytes32) view returns(bool)',
  'function isOperationDone(bytes32) view returns(bool)','function getTimestamp(bytes32) view returns(uint256)',
  'function upgradeToAndCall(address,bytes)','function upgradeTo(address)',
  'function scheduleBatch(address[],uint256[],bytes[],bytes32,bytes32,uint256)']);
function fixture({phase='unscheduled',upgraded=false,change={}}={}) {
  const trusted=structuredClone(manifest),authorityCode='0x60006001';
  trusted.freshAuthority.codehash=keccak256(authorityCode);
  const input={...common,trustedGenesisManifest:trusted};
  const plan=buildFreshActiveUpgradePlan({...input,replacements:replacement,salt,delaySeconds:172800});
  const old=record.addresses,block={number:125490000,hash:keccak256(toUtf8Bytes('fixed finalized block')),timestamp:2000000};
  const code=new Map(Object.keys(record.verification.code).filter(name=>old[name] && bundle.artifacts[name] || ['factory','shareMarket','lens','beacon','timelock','portfolioFactory','portfolioShareMarket','portfolioBeacon'].includes(name))
    .map(name=>[old[name].toLowerCase(),reviewedUpgradeBytecode.genesisRuntime(name,record,bundle)]));
  code.set(trusted.authority.toLowerCase(),authorityCode);
  const links={...old,...replacement};
  for(const name of freshUpgradeDeploymentOrder) {
    const immutable=name==='PoolVault'?old.factory:name==='BudgetPortfolioVault'?old.portfolioFactory
      :['FreshPoolFactory','ShareMarket','BudgetPortfolioFactory'].includes(name)?replacement[name]:null;
    code.set(replacement[name].toLowerCase(),reviewedUpgradeBytecode.expectedRuntime(candidate.artifacts[name],links,replacement[name],immutable));
  }
  const methods=[];
  const p={
    async getBlock(tag){if(tag==='finalized'||tag===block.number)return {...block};
      if(tag===trusted.deployment.blockNumber)return {number:tag,hash:trusted.deployment.blockHash};
      if(tag===trusted.verifiedBlockNumber)return {number:tag,hash:trusted.verifiedBlockHash};throw new Error('Unknown block');},
    async getCode(address){return code.get(address.toLowerCase())??'0x';},
    async getStorage(address){const pairs={factory:'FreshPoolFactory',shareMarket:'ShareMarket',portfolioFactory:'BudgetPortfolioFactory',portfolioShareMarket:'ShareMarket'};
      const key=Object.keys(pairs).find(k=>old[k].toLowerCase()===address.toLowerCase());
      return '0x'+(upgraded?replacement:old)[pairs[key]].slice(2).toLowerCase().padStart(64,'0');},
    async send(method,args){methods.push(method);if(method==='eth_chainId')return '0x38';assert.equal(method,'eth_call','validator never sends any transaction');
      const tx=abi.parseTransaction({data:args[0].data}),name=tx.name,to=args[0].to.toLowerCase();
      let values;
      if(Object.hasOwn(change,`${to}:${name}`)) values=change[`${to}:${name}`];
      else if(name==='owner') values=[old.timelock];
      else if(name==='timelock') values=[old.timelock];
      else if(name==='operator'||name==='treasury') values=[trusted.authority];
      else if(name==='creationPaused') values=[upgraded];
      else if(name==='lens') values=[old.lens];
      else if(name==='factory'||name==='coreFactory') values=[old.factory];
      else if(name==='budgetFactory') values=[old.portfolioFactory];
      else if(name==='administratorOne') values=[trusted.freshAuthority.administratorOne];
      else if(name==='administratorTwo') values=[trusted.freshAuthority.administratorTwo];
      else if(name==='gasWallet') values=[trusted.freshAuthority.gasWallet];
      else if(name==='getMinDelay') values=[172800n];
      else if(name==='hasRole') values=[tx.args[1].toLowerCase()===record.input.ownerMultisig.toLowerCase() || tx.args[1]===ZeroAddress];
      else if(name==='implementation') values=[to===old.beacon.toLowerCase()?(upgraded?replacement.PoolVault:old.PoolVault):(upgraded?replacement.BudgetPortfolioVault:old.BudgetPortfolioVault)];
      else if(name==='machineRegistryStatus') values=[true,true,0n,0n];
      else if(name==='poolCount') values=[1n];
      else if(name==='portfolioCount') values=[0n];
      else if(name==='allPools') values=['0x9999000000000000000000000000000000000000'];
      else if(name==='hashOperationBatch') values=[plan.operationId];
      else if(name==='isOperation') values=[phase!=='unscheduled'];
      else if(name==='isOperationReady') values=[phase==='scheduled'];
      else if(name==='isOperationDone') values=[phase==='done'];
      else if(name==='getTimestamp') values=[phase==='unscheduled'?0n:phase==='done'?1n:phase==='waiting'?2100000n:1900000n];
      else throw new Error(`Unexpected getter ${name}`);
      return abi.encodeFunctionResult(name,values);
    },
  };
  return {p,input,plan,code,methods,block};
}

test('fresh-v5 plan preserves existing Authority and atomically pauses before six code upgrades',()=>{
  const f=fixture(),plan=f.plan;
  assert.equal(plan.steps.length,8);
  assert.deepEqual(plan.targets.slice(0,2),[record.addresses.factory,record.addresses.portfolioFactory]);
  assert(plan.payloads.slice(0,2).every(data=>abi.decodeFunctionData('pauseCreation',data)[0]===true));
  assert(plan.payloads.slice(2).every(data=>['upgradeTo','upgradeToAndCall'].includes(abi.parseTransaction({data}).name)));
  assert.equal(plan.steps[4].implementation,replacement.FreshPoolFactory);
  assert.equal(plan.creationRemainsPaused,true);assert.deepEqual(plan.authority.address,manifest.authority);
  assert.equal(abi.parseTransaction({data:plan.scheduleData}).args[5],172800n);
  assert(freshUpgradeDeploymentOrder.indexOf('SaleGovernance')<freshUpgradeDeploymentOrder.indexOf('FirstoSale'));
  assert.throws(()=>buildFreshActiveUpgradePlan({...f.input,replacements:replacement,salt,delaySeconds:1}),/48 hours/);
  assert.throws(()=>buildFreshActiveUpgradePlan({...f.input,replacements:replacement,salt,trustedUpgradeArtifactDigest:record.artifactDigest,delaySeconds:172800}),/pinned upgrade digest/);
});
test('live activated Factory ownership is Timelock, not the genesis deployer',async()=>{
  const f=fixture();const result=await validateFreshActiveGraphAgainstChain(f.p,f.input);
  assert.equal(result.proposer,record.input.ownerMultisig);assert.deepEqual(result.creationPaused,{core:false,budget:false});
  const broken=fixture({change:{[`${record.addresses.factory.toLowerCase()}:owner`]:[record.input.ownerMultisig]}});
  await assert.rejects(validateFreshActiveGraphAgainstChain(broken.p,broken.input),/Authority and Timelock wiring/);
});
test('altered existing Gas wallet, administrator, treasury or roles blocks every new signature preflight',async()=>{
  for(const [target,name,value] of [[manifest.authority,'gasWallet',ZeroAddress],[manifest.authority,'administratorOne',record.account],
    [record.addresses.factory,'treasury',record.account],[record.addresses.timelock,'hasRole',false]]) {
    const f=fixture({change:{[`${target.toLowerCase()}:${name}`]:[value]}});
    await assert.rejects(validateFreshActiveGraphAgainstChain(f.p,f.input),/unchanged|remain valid/);
  }
  const f=fixture();f.code.set(manifest.authority.toLowerCase(),'0x6002');
  await assert.rejects(validateFreshActiveGraphAgainstChain(f.p,f.input),/Authority runtime/);
});
test('new SaleGovernance must be linked into FirstoSale and deployment prefixes cannot skip it',async()=>{
  const f=fixture(),prefix=Object.fromEntries(freshUpgradeDeploymentOrder.slice(0,5).map(n=>[n,replacement[n]]));
  await validateFreshActiveReplacementsAgainstChain(f.p,{...f.input,deployments:prefix});
  assert.throws(()=>freshUpgradeDeploymentData('FreshPoolFactory',candidate,{...record.addresses,PurchaseValidation:ZeroAddress}),/zero|address/);
  await assert.rejects(validateFreshActiveReplacementsAgainstChain(f.p,{...f.input,deployments:{FirstoSale:replacement.FirstoSale}}),/dependency prefix/);
  f.code.set(replacement.FirstoSale.toLowerCase(),reviewedUpgradeBytecode.expectedRuntime(candidate.artifacts.FirstoSale,
    {...record.addresses,...prefix,SaleGovernance:record.addresses.SaleGovernance},replacement.FirstoSale,null));
  await assert.rejects(validateFreshActiveReplacementsAgainstChain(f.p,{...f.input,deployments:prefix}),/linked dependency differs: FirstoSale/);
});
test('ready execution requires current proposer and exact eight-call plan after the full Timelock delay',async()=>{
  const f=fixture();const input={...f.input,proposer:record.input.ownerMultisig,phase:'unscheduled'};
  assert.equal((await validateFreshActiveUpgradeAgainstChain(f.p,f.plan,input)).codeUpgradeComplete,false);
  await assert.rejects(validateFreshActiveUpgradeAgainstChain(f.p,{...f.plan,targets:f.plan.targets.slice(2)},input),/fixed fresh-v5 calldata/);
  await assert.rejects(validateFreshActiveUpgradeAgainstChain(f.p,f.plan,{...input,proposer:manifest.freshAuthority.administratorOne}),/existing Timelock proposer/);
  const waiting=fixture({phase:'waiting'});
  await assert.rejects(validateFreshActiveUpgradeAgainstChain(waiting.p,waiting.plan,{...waiting.input,proposer:record.account,phase:'scheduled'}),/not ready/);
  const ready=fixture({phase:'scheduled'});
  assert.equal((await validateFreshActiveUpgradeAgainstChain(ready.p,ready.plan,{...ready.input,proposer:record.account,phase:'scheduled'})).readyAt,'1900000');
});
test('completed upgrade verifies FreshPoolFactory replacement and keeps both creation gates paused',async()=>{
  const before=fixture({phase:'scheduled'}),prior=await validateFreshActiveGraphAgainstChain(before.p,before.input);
  const f=fixture({phase:'done',upgraded:true});
  const input={...f.input,proposer:record.account,phase:'done',preExecutionPreflight:prior};
  const proof=await validateFreshActiveUpgradeAgainstChain(f.p,f.plan,input);
  assert.equal(proof.codeUpgradeComplete,true);assert.deepEqual(proof.creationPaused,{core:true,budget:true});
  await assert.rejects(validateFreshActiveUpgradeAgainstChain(f.p,f.plan,{...input,preExecutionPreflight:{...prior,poolCount:'2'}}),/snapshot changed/);
  const unpaused=fixture({phase:'done',upgraded:true,change:{[`${record.addresses.factory.toLowerCase()}:creationPaused`]:[false]}});
  await assert.rejects(validateFreshActiveUpgradeAgainstChain(unpaused.p,unpaused.plan,{...unpaused.input,proposer:record.account,phase:'done'}),/remain paused/);
  assert(f.methods.every(m=>['eth_chainId','eth_call'].includes(m)));
});
