import { AbiCoder, Interface, ZeroAddress, ZeroHash, getAddress, keccak256, toUtf8Bytes } from 'ethers';
import { buildDigest, evidenceDigest } from './firsto-upgrade-proof.mjs';
import { reviewedUpgradeBytecode } from './integrated-upgrade-plan.mjs';

const HASH = /^0x[\da-f]{64}$/i;
const MIN_DELAY = 172800;
const SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
const same = (a,b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const insist = (ok,reason) => { if (!ok) throw new Error(reason); };
const addr = (value,label) => {
  try { const result=getAddress(value); insist(result!==ZeroAddress,`${label} is zero.`); return result; }
  catch { throw new Error(`Invalid ${label} address.`); }
};
const codeHelpers=reviewedUpgradeBytecode;

export const FRESH_ACTIVE_UPGRADE_KIND = 'fresh-v5-active-security-upgrade-v1';
// Every newly linked library precedes its users. In particular FirstoSale must
// link the NEW SaleGovernance, not the old library at the genesis address.
export const freshUpgradeDeploymentOrder=Object.freeze([
  'PoolFunds','FlexiblePurchase','SaleSettlement','SaleGovernance','FirstoSale','PoolVault',
  'FreshPoolFactory','ShareMarket','BudgetPortfolioVault','BudgetPortfolioFactory',
]);
const links={
  PoolFunds:[],FlexiblePurchase:['PoolFunds','PurchaseValidation'],SaleSettlement:[],SaleGovernance:[],
  FirstoSale:['MiningOperations','PoolFunds','RewardAccounting','SaleGovernance','SaleSettlement'],
  PoolVault:['FirstoSale','FlexiblePurchase','MiningOperations','PoolFunds','RewardAccounting',
    'SaleGovernance','SaleSettlement','ShareCheckpoints'],
  FreshPoolFactory:['PurchaseValidation'],ShareMarket:[],BudgetPortfolioVault:['SaleGovernance'],BudgetPortfolioFactory:[],
};
const oldRuntimeNames=['FlexiblePurchase','MiningOperations','PoolFunds','PurchaseValidation','RewardAccounting',
  'SaleGovernance','SaleSettlement','ShareCheckpoints','FirstoSale','AtomicDeployment','PoolVault','FreshPoolFactory',
  'ShareMarket','BudgetPortfolioFactory','BudgetPortfolioVault','factory','shareMarket','lens','beacon','timelock',
  'portfolioFactory','portfolioShareMarket','portfolioBeacon'];
const factory=new Interface(['function owner() view returns(address)','function timelock() view returns(address)',
  'function operator() view returns(address)','function treasury() view returns(address)','function creationPaused() view returns(bool)',
  'function pauseCreation(bool)','function lens() view returns(address)','function poolCount() view returns(uint256)',
  'function portfolioCount() view returns(uint256)','function machineRegistryStatus() view returns(bool,bool,uint256,uint256)',
  'function upgradeToAndCall(address,bytes)']);
const beacon=new Interface(['function owner() view returns(address)','function implementation() view returns(address)',
  'function upgradeTo(address)']);
const lens=new Interface(['function factory() view returns(address)']);
const authority=new Interface(['function owner() view returns(address)','function coreFactory() view returns(address)',
  'function budgetFactory() view returns(address)','function administratorOne() view returns(address)',
  'function administratorTwo() view returns(address)','function gasWallet() view returns(address)']);
const timelock=new Interface(['function getMinDelay() view returns(uint256)','function hasRole(bytes32,address) view returns(bool)',
  'function hashOperationBatch(address[],uint256[],bytes[],bytes32,bytes32) view returns(bytes32)',
  'function isOperation(bytes32) view returns(bool)','function isOperationReady(bytes32) view returns(bool)',
  'function isOperationDone(bytes32) view returns(bool)','function getTimestamp(bytes32) view returns(uint256)',
  'function scheduleBatch(address[],uint256[],bytes[],bytes32,bytes32,uint256)',
  'function executeBatch(address[],uint256[],bytes[],bytes32,bytes32) payable']);
const roles=Object.fromEntries(['PROPOSER_ROLE','CANCELLER_ROLE','EXECUTOR_ROLE'].map(name=>[name,keccak256(toUtf8Bytes(name))]));
async function call(p,to,abi,name,args=[],tag) {
  return abi.decodeFunctionResult(name,await p.send('eth_call',[{to,data:abi.encodeFunctionData(name,args)},tag]))[0];
}
function trustedActive(input) {
  const {genesisRecord,genesisBundle,trustedGenesisManifest:manifest}=input;
  const old=codeHelpers.trustedGenesisAddresses(genesisRecord,genesisBundle,manifest);
  const active=manifest.freshAuthority;
  insist(active && HASH.test(active.codehash) && HASH.test(active.deploymentTxHash)
    && Number.isSafeInteger(manifest.verifiedBlockNumber) && HASH.test(manifest.verifiedBlockHash),
  'The independently pinned fresh-v5 activation proof is required.');
  const normalized={address:addr(active.address,'active Authority'),administratorOne:addr(active.administratorOne,'administrator one'),
    administratorTwo:addr(active.administratorTwo,'administrator two'),gasWallet:addr(active.gasWallet,'Gas wallet'),codehash:active.codehash};
  insist(same(manifest.authority,normalized.address) && same(manifest.gasWallet,normalized.gasWallet)
    && new Set([normalized.address,normalized.administratorOne,normalized.administratorTwo,normalized.gasWallet,
      old.timelock,old.factory,old.portfolioFactory].map(x=>x.toLowerCase())).size===7,
  'Pinned Authority, administrators and Gas wallet are inconsistent.');
  return {old,active:normalized,proposer:addr(genesisRecord.input.ownerMultisig,'current Timelock proposer')};
}
function assertCandidate(input) {
  insist(HASH.test(input.trustedUpgradeArtifactDigest)
    && same(buildDigest(input.upgradeBundle),input.trustedUpgradeArtifactDigest)
    && !same(input.trustedUpgradeArtifactDigest,input.genesisRecord.artifactDigest),
  'Candidate code does not match the independently pinned upgrade digest.');
  for(const name of freshUpgradeDeploymentOrder) {
    const artifact=input.upgradeBundle.artifacts?.[name];
    insist(artifact?.contractName===name && artifact.bytecode?.startsWith('0x')
      && artifact.deployedBytecode?.startsWith('0x') && (artifact.deployedBytecode.length-2)/2<=24576,
    `Missing or oversized reviewed candidate ${name}.`);
    for(const field of ['linkReferences','deployedLinkReferences']) {
      const found=[];
      for(const [source,libs] of Object.entries(artifact[field]??{})) for(const [dep,locations] of Object.entries(libs)) {
        insist(source===`src/libraries/${dep}.sol` && Array.isArray(locations) && locations.length>0,
          `Unexpected ${name} ${field} graph.`); found.push(dep);
      }
      insist([...new Set(found)].sort().join(',')===[...links[name]].sort().join(','),`Unexpected ${name} ${field} dependencies.`);
    }
  }
}
function normalizeReplacements(input,partial=false) {
  const {old}=trustedActive(input);assertCandidate(input);
  const values=input.replacements??input.deployments;
  insist(values && typeof values==='object' && !Array.isArray(values),'Candidate replacement addresses are required.');
  const keys=Object.keys(values);
  insist(keys.every(key=>freshUpgradeDeploymentOrder.includes(key)),'Unknown candidate replacement.');
  if(!partial) insist(keys.length===freshUpgradeDeploymentOrder.length,'All ten candidate implementations are required.');
  const used=new Set(Object.values(old).filter(x=>typeof x==='string').map(x=>x.toLowerCase()));
  const out={};let ended=false;
  for(const name of freshUpgradeDeploymentOrder) {
    if(!values[name]) { ended=true;continue; }
    insist(!ended,'Candidate deployments must form the exact dependency prefix.');
    const a=addr(values[name],name);insist(!used.has(a.toLowerCase()),`Replacement ${name} reuses a graph address.`);
    used.add(a.toLowerCase());out[name]=a;
  }
  return out;
}
export function freshUpgradeDeploymentData(name,bundle,addresses) {
  insist(freshUpgradeDeploymentOrder.includes(name),'Unknown fresh-v5 candidate deployment.');
  const artifact=bundle?.artifacts?.[name];insist(artifact?.contractName===name,`Missing ${name} artifact.`);
  const args=name==='PoolVault'?[addr(addresses.factory,'factory')]
    :name==='BudgetPortfolioVault'?[addr(addresses.portfolioFactory,'portfolio Factory')]:[];
  return codeHelpers.spliceLinks(artifact.bytecode,artifact.linkReferences,addresses)
    +new Interface(artifact.abi).encodeDeploy(args).slice(2);
}
export function buildFreshActiveUpgradePlan(input) {
  const {old,active,proposer}=trustedActive(input), replacements=normalizeReplacements(input);
  insist(HASH.test(input.salt) && BigInt(input.salt)!==0n,'A unique nonzero salt is required.');
  insist(Number.isSafeInteger(input.delaySeconds) && input.delaySeconds>=MIN_DELAY,'Upgrade delay must be at least 48 hours.');
  const targets=[old.factory,old.portfolioFactory,old.shareMarket,old.portfolioShareMarket,old.factory,
    old.beacon,old.portfolioFactory,old.portfolioBeacon].map(x=>addr(x,'batch target'));
  const names=['Pause single-machine creation','Pause budget creation','Single-machine share market',
    'Budget share market','FreshPoolFactory','Single-machine beacon','BudgetPortfolioFactory','Budget beacon'];
  const implementations=[null,null,replacements.ShareMarket,replacements.ShareMarket,replacements.FreshPoolFactory,
    replacements.PoolVault,replacements.BudgetPortfolioFactory,replacements.BudgetPortfolioVault];
  const payloads=implementations.map((a,index)=>index<2?factory.encodeFunctionData('pauseCreation',[true])
    :[5,7].includes(index)?beacon.encodeFunctionData('upgradeTo',[a]):factory.encodeFunctionData('upgradeToAndCall',[a,'0x']));
  const values=targets.map(()=>'0'), encoded=[targets,values.map(BigInt),payloads,ZeroHash,input.salt];
  const operationId=keccak256(AbiCoder.defaultAbiCoder().encode(['address[]','uint256[]','bytes[]','bytes32','bytes32'],encoded));
  return {kind:FRESH_ACTIVE_UPGRADE_KIND,genesisRecordDigest:evidenceDigest(input.genesisRecord),
    genesisArtifactDigest:buildDigest(input.genesisBundle),upgradeArtifactDigest:input.trustedUpgradeArtifactDigest,
    authority:active,proposer,replacements,predecessor:ZeroHash,salt:input.salt,delaySeconds:input.delaySeconds,
    steps:targets.map((target,index)=>({name:names[index],target,implementation:implementations[index],data:payloads[index],value:'0'})),
    targets,values,payloads,operationId,scheduleData:timelock.encodeFunctionData('scheduleBatch',[...encoded,input.delaySeconds]),
    executeData:timelock.encodeFunctionData('executeBatch',encoded),creationRemainsPaused:true};
}
async function finalized(p) {
  const [chain,block]=await Promise.all([p.send('eth_chainId',[]),p.getBlock('finalized')]);
  insist(BigInt(chain)===56n && Number.isSafeInteger(block?.number) && HASH.test(block?.hash),'A finalized BSC block is required.');
  return block;
}
async function canonical(p,block) {
  const [again,chain]=await Promise.all([p.getBlock(block.number),p.send('eth_chainId',[])]);
  insist(BigInt(chain)===56n && again?.number===block.number && same(again.hash,block.hash),'Finalized BSC block changed during verification.');
}
async function replacementsAt(p,input,block,replacements) {
  const {old}=trustedActive(input), all={...old,...replacements};
  for(const name of Object.keys(replacements)) {
    const immutable=name==='PoolVault'?old.factory:name==='BudgetPortfolioVault'?old.portfolioFactory
      :['FreshPoolFactory','ShareMarket','BudgetPortfolioFactory'].includes(name)?replacements[name]:null;
    const observed=await p.getCode(replacements[name],block.number);
    insist(observed!=='0x' && same(observed,codeHelpers.expectedRuntime(input.upgradeBundle.artifacts[name],all,
      replacements[name],immutable)),`Candidate runtime or linked dependency differs: ${name}.`);
  }
}
async function graphAt(p,input,block,upgraded=null) {
  const {old,active,proposer}=trustedActive(input),tag=`0x${block.number.toString(16)}`,checks=[];
  const checked=(condition,label)=>{insist(condition,label);checks.push({label,passed:true});};
  checked(block.number>=input.trustedGenesisManifest.verifiedBlockNumber,
    'Finalized chain has reached the pinned fresh-v5 activation block.');
  for(const [number,hash] of [[input.trustedGenesisManifest.deployment.blockNumber,input.trustedGenesisManifest.deployment.blockHash],
    [input.trustedGenesisManifest.verifiedBlockNumber,input.trustedGenesisManifest.verifiedBlockHash]]) {
    const anchored=await p.getBlock(number);checked(anchored?.number===number && same(anchored.hash,hash),'Pinned deployment/activation block remains canonical.');
  }
  for(const name of oldRuntimeNames) {
    const code=await p.getCode(old[name],block.number);
    checked(code!=='0x' && same(code,codeHelpers.genesisRuntime(name,input.genesisRecord,input.genesisBundle)),`Pinned genesis runtime unchanged: ${name}.`);
  }
  for(const [proxy,name] of [['factory','FreshPoolFactory'],['shareMarket','ShareMarket'],['portfolioFactory','BudgetPortfolioFactory'],['portfolioShareMarket','ShareMarket']]) {
    const raw=await p.getStorage(old[proxy],SLOT,block.number);
    checked(/^0x0{24}[\da-f]{40}$/i.test(raw) && same(`0x${raw.slice(-40)}`,(upgraded??old)[name]),`Current ${proxy} implementation matches the reviewed graph.`);
  }
  for(const [name,implementation] of [['beacon','PoolVault'],['portfolioBeacon','BudgetPortfolioVault']]) {
    const [owner,current]=await Promise.all([call(p,old[name],beacon,'owner',[],tag),call(p,old[name],beacon,'implementation',[],tag)]);
    checked(same(owner,old.timelock) && same(current,(upgraded??old)[implementation]),`${name} ownership and implementation match.`);
  }
  checked(same(await call(p,old.factory,factory,'lens',[],tag),old.lens)
    && same(await call(p,old.lens,lens,'factory',[],tag),old.factory),'Pinned Lens binding remains unchanged.');
  const paused=[];
  for(const name of ['factory','portfolioFactory']) {
    const [owner,lock,operator,treasury,isPaused]=await Promise.all(['owner','timelock','operator','treasury','creationPaused']
      .map(method=>call(p,old[name],factory,method,[],tag)));
    checked(same(owner,old.timelock) && same(lock,old.timelock) && same(operator,active.address)
      && same(treasury,active.address),`Active ${name} Authority and Timelock wiring remain unchanged.`);paused.push(isPaused);
  }
  const authorityCode=await p.getCode(active.address,block.number);
  checked(authorityCode!=='0x' && same(keccak256(authorityCode),active.codehash),'Pinned active Authority runtime remains unchanged.');
  const authorityGetters={owner:old.timelock,coreFactory:old.factory,budgetFactory:old.portfolioFactory,
    administratorOne:active.administratorOne,administratorTwo:active.administratorTwo,gasWallet:active.gasWallet};
  for(const [name,expected] of Object.entries(authorityGetters)) checked(same(await call(p,active.address,authority,name,[],tag),expected),`Existing Authority ${name} remains unchanged.`);
  const [proposerRole,cancellerRole,openExecutor,minDelay]=await Promise.all([
    call(p,old.timelock,timelock,'hasRole',[roles.PROPOSER_ROLE,proposer],tag),
    call(p,old.timelock,timelock,'hasRole',[roles.CANCELLER_ROLE,proposer],tag),
    call(p,old.timelock,timelock,'hasRole',[roles.EXECUTOR_ROLE,ZeroAddress],tag),
    call(p,old.timelock,timelock,'getMinDelay',[],tag),
  ]);
  checked(proposerRole===true && cancellerRole===true && openExecutor===true && minDelay>=BigInt(MIN_DELAY),
    'Pinned current proposer, canceller, executor and 48-hour Timelock remain valid.');
  const rawRegistry=await p.send('eth_call',[{to:old.factory,data:factory.encodeFunctionData('machineRegistryStatus')},tag]);
  const [initialized,ready,cursor,cutoff]=factory.decodeFunctionResult('machineRegistryStatus',rawRegistry);
  checked(initialized===true && ready===true && cursor===cutoff,'Fresh-v5 machine registry remains ready.');
  const [poolCount,portfolioCount]=await Promise.all([call(p,old.factory,factory,'poolCount',[],tag),
    call(p,old.portfolioFactory,factory,'portfolioCount',[],tag)]);
  const historical=await codeHelpers.historicalTreasuries(p,old,poolCount,portfolioCount,tag);
  checked(historical.every(row=>same(row.treasury,active.address)),'Every existing vault retains the active Authority treasury.');
  if(upgraded) checked(paused.every(x=>x===true),'Both factories remain paused after the code-upgrade batch.');
  if(input.signer) checked(same(input.signer,proposer),'Connect the existing Timelock proposer wallet.');
  return {blockNumber:block.number,blockHash:block.hash,checkedAt:new Date().toISOString(),checks,
    authority:active,proposer,creationPaused:{core:paused[0],budget:paused[1]},minDelay:minDelay.toString(),
    registry:{initialized,ready,cursor:cursor.toString(),cutoff:cutoff.toString()},
    poolCount:poolCount.toString(),portfolioCount:portfolioCount.toString(),historical};
}
export async function validateFreshActiveGraphAgainstChain(p,input) {
  const block=await finalized(p),proof=await graphAt(p,input,block);await canonical(p,block);return proof;
}
export async function validateFreshActiveReplacementsAgainstChain(p,input) {
  const replacements=normalizeReplacements(input,true),block=await finalized(p);
  const proof=await graphAt(p,input,block);await replacementsAt(p,input,block,replacements);await canonical(p,block);
  return {...proof,replacements};
}
export async function validateFreshActiveUpgradeAgainstChain(p,plan,input) {
  insist(['unscheduled','scheduled','done'].includes(input.phase),'Unknown fresh-v5 upgrade phase.');
  const rebuilt=buildFreshActiveUpgradePlan({...input,replacements:plan?.replacements,salt:plan?.salt,delaySeconds:plan?.delaySeconds});
  insist(same(evidenceDigest(rebuilt),evidenceDigest(plan)),'Upgrade plan differs from fixed fresh-v5 calldata.');
  const {old,proposer}=trustedActive(input);
  insist(same(input.proposer,proposer),'Connect the existing Timelock proposer wallet.');
  const block=await finalized(p),tag=`0x${block.number.toString(16)}`;
  const proof=await graphAt(p,input,block,input.phase==='done'?plan.replacements:null);
  await replacementsAt(p,input,block,plan.replacements);
  const [id,exists,ready,done,timestamp]=await Promise.all([
    call(p,old.timelock,timelock,'hashOperationBatch',[plan.targets,plan.values.map(BigInt),plan.payloads,plan.predecessor,plan.salt],tag),
    call(p,old.timelock,timelock,'isOperation',[plan.operationId],tag),call(p,old.timelock,timelock,'isOperationReady',[plan.operationId],tag),
    call(p,old.timelock,timelock,'isOperationDone',[plan.operationId],tag),call(p,old.timelock,timelock,'getTimestamp',[plan.operationId],tag),
  ]);
  insist(same(id,plan.operationId) && BigInt(plan.delaySeconds)>=BigInt(proof.minDelay),'Timelock operation ID or delay differs from the reviewed plan.');
  if(input.phase==='unscheduled') insist(!exists && !ready && !done && timestamp===0n,'This upgrade salt has already been scheduled.');
  if(input.phase==='scheduled') insist(exists && ready && !done && timestamp>1n && timestamp<=BigInt(block.timestamp),'Upgrade is not ready; wait for the 48-hour Timelock.');
  if(input.phase==='done') {
    insist(exists && done && !ready && timestamp===1n,'The reviewed upgrade has not completed on-chain.');
    if(input.preExecutionPreflight) insist(proof.poolCount===input.preExecutionPreflight.poolCount
      && proof.portfolioCount===input.preExecutionPreflight.portfolioCount
      && evidenceDigest(proof.historical)===evidenceDigest(input.preExecutionPreflight.historical)
      && evidenceDigest(proof.registry)===evidenceDigest(input.preExecutionPreflight.registry),
    'Existing registry or treasury snapshot changed across the atomic code upgrade.');
  }
  await canonical(p,block);
  return {...proof,phase:input.phase,operationId:plan.operationId,readyAt:timestamp.toString(),
    codeUpgradeComplete:input.phase==='done',creationRemainsPaused:input.phase==='done'};
}
