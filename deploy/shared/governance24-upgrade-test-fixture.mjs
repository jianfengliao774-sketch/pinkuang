import { AbiCoder, Interface, ZeroHash, getCreateAddress, keccak256, toUtf8Bytes } from 'ethers';
import { buildDigest, evidenceDigest } from './firsto-upgrade-proof.mjs';
import { createFirstoBatchFixture } from './firsto-batch-upgrade-test-fixture.mjs';
import { validateFirstoBatchUpgradeReview } from './firsto-batch-upgrade-plan.mjs';
import { GOVERNANCE24_REVIEW_KIND, governance24UpgradeDeploymentOrder, governance24Coverage, buildGovernance24UpgradePlan } from './governance24-upgrade-plan.mjs';
const hash=x=>keccak256(toUtf8Bytes(x)),same=(a,b)=>a?.toLowerCase()===b?.toLowerCase();
const abi=new Interface([
  'function upgradeTo(address)', 'function owner() view returns(address)', 'function timelock() view returns(address)',
  'function upgradeToAndCall(address,bytes)', 'function cancel(bytes32)', 'event Cancelled(bytes32 indexed id)',
  'function beacon() view returns(address)', 'function shareMarket() view returns(address)', 'function legacyFactory() view returns(address)',
  'function factory() view returns(address)', 'function OFFICIAL_FACTORY() view returns(address)', 'function SECONDARY_BEACON() view returns(address)',
  'function implementation() view returns(address)', 'function INITIAL_PROPOSER() view returns(address)', 'function MINIMUM_DELAY() view returns(uint256)',
  'function getMinDelay() view returns(uint256)', 'function hasRole(bytes32,address) view returns(bool)',
  'function poolCount() view returns(uint256)', 'function allPools(uint256) view returns(address)',
  'function portfolioCount() view returns(uint256)', 'function portfolioAt(uint256) view returns(address)',
  'function hashOperationBatch(address[],uint256[],bytes[],bytes32,bytes32) view returns(bytes32)',
  'function hashOperation(address,uint256,bytes,bytes32,bytes32) view returns(bytes32)',
  'function isOperation(bytes32) view returns(bool)', 'function isOperationReady(bytes32) view returns(bool)',
  'function isOperationDone(bytes32) view returns(bool)', 'function getTimestamp(bytes32) view returns(uint256)',
  'event CallScheduled(bytes32 indexed id,uint256 indexed index,address target,uint256 value,bytes data,bytes32 predecessor,uint256 delay)',
  'event CallSalt(bytes32 indexed id,bytes32 salt)', 'event CallExecuted(bytes32 indexed id,uint256 indexed index,address target,uint256 value,bytes data)',
  'event Upgraded(address indexed implementation)', 'event OwnershipTransferred(address indexed previousOwner,address indexed newOwner)',
]);
function synthetic(name,args=[],immutable=[],libraries=[],isLibrary=false) {
  let runtime=isLibrary ? `73${'0'.repeat(40)}6000` : '60006000';
  const immutableReferences={},immutableBindings={},refs={};
  for (const [index,name] of immutable.entries()) { const id=String(100+index);immutableReferences[id]=[{start:runtime.length/2,length:32}];immutableBindings[id]=name;runtime+='0'.repeat(64); }
  for (const name of libraries) {
    refs[`src/libraries/${name}.sol`]={[name]:[{start:runtime.length/2,length:20}]};runtime+='__$'+'1'.repeat(34)+'$__';
  }
  const abi=args.length ? [{type:'constructor',stateMutability:'nonpayable',inputs:args.map((type,index)=>({name:`arg${index}`,type}))}] : [];
  return {contractName:name,abi,bytecode:`0x${runtime}`,deployedBytecode:`0x${runtime}`,immutableReferences,immutableBindings,
    linkReferences:structuredClone(refs),deployedLinkReferences:structuredClone(refs)};
}
export function createGovernance24Fixture({phase='done',waiting=false,pending=true,predecessorFixture,conflictingPending=false,cancelled=false}={}) {
  const base=createFirstoBatchFixture({phase:'unscheduled',predecessorFixture}),prior=validateFirstoBatchUpgradeReview(base.input),a=prior.addresses;
  const input={predecessorInput:structuredClone(base.input),trustedPredecessorInputDigest:evidenceDigest(base.input),
    upgradeBundle:structuredClone(base.input.upgradeBundle),salt:hash('gov24-synthetic'),delaySeconds:172800};
  input.upgradeBundle.artifacts.BudgetPortfolioVault=synthetic('BudgetPortfolioVault',['address'],['OFFICIAL_FACTORY'],['SaleGovernance']);
  for (const name of ['FlexiblePurchase','PoolVault','BudgetPortfolioVault']) {
    const artifact=input.upgradeBundle.artifacts[name];artifact.immutableBindings=Object.fromEntries(Object.keys(artifact.immutableReferences).map(id=>[id,'OFFICIAL_FACTORY']));
  }
  Object.assign(input.upgradeBundle.artifacts,{
    PoolTimelock24:synthetic('PoolTimelock24',['address'],['INITIAL_PROPOSER']),
    Governance24Beacon:synthetic('Governance24Beacon',['address','address'],['OFFICIAL_FACTORY']),
    Governance24Dispatcher:synthetic('Governance24Dispatcher',['address','address'],['OFFICIAL_FACTORY','SECONDARY_BEACON','SELF']),
    Governance24Validation:synthetic('Governance24Validation',[],[],[],true),
    Governance24FreshPoolFactory:synthetic('Governance24FreshPoolFactory',[],['__self'],['Governance24Validation','PurchaseValidation']),
    Governance24BudgetPortfolioFactory:synthetic('Governance24BudgetPortfolioFactory',[],['__self'],['Governance24Validation']),
    Governance24ShareMarket:synthetic('Governance24ShareMarket',[],['__self'],['Governance24Validation']),
  });
  input.trustedUpgradeArtifactDigest=buildDigest(input.upgradeBundle);
  const pendingOp={mode:'single',timelock:a.timelock,target:a.portfolioFactory,value:'0',data:abi.encodeFunctionData('upgradeToAndCall',[a.BudgetPortfolioFactory,'0x']),predecessor:ZeroHash,salt:hash('portfolio-still-pending'),timestamp:'900000'};
  if(conflictingPending){pendingOp.target=a.portfolioBeacon;pendingOp.data=abi.encodeFunctionData('upgradeTo',[a.BudgetPortfolioVault]);}
  pendingOp.operationId=keccak256(AbiCoder.defaultAbiCoder().encode(['address','uint256','bytes','bytes32','bytes32'],[pendingOp.target,pendingOp.value,pendingOp.data,pendingOp.predecessor,pendingOp.salt]));
  input.reviewCatalog={schemaVersion:1,kind:GOVERNANCE24_REVIEW_KIND,chainId:56,profile:'full-test',
    predecessorInputDigest:input.trustedPredecessorInputDigest,candidateArtifactDigest:input.trustedUpgradeArtifactDigest,
    anchor:{blockNumber:500,blockHash:base.blocks.get(500).hash},bindings:structuredClone(prior.catalog.bindings),coverage:governance24Coverage(prior,input.predecessorInput),
    pendingOperations:pending ? [pendingOp] : [],preservation:{corePools:[],portfolioPools:[],storage:{}}};
  input.trustedReviewCatalogDigest=evidenceDigest(input.reviewCatalog);
  const replacements=Object.fromEntries(governance24UpgradeDeploymentOrder.map((name,index)=>[name,getCreateAddress({from:prior.catalog.deployer,nonce:50+index})]));
  const plan=buildGovernance24UpgradePlan({...input,replacements}),deployments={},blocks=base.blocks,transactions=base.transactions,receipts=base.receipts,codes=base.codes;
  for (const number of [...Array.from({length:13},(_,i)=>900+i),913,914,920,1089,1090,1100]) blocks.set(number,{number,hash:hash(`gov24-block-${number}`),
    timestamp:number===920 ? 1000000 : number===1090 ? 1172800 : number===1100 ? waiting ? 1100000 : 1180000 : number<920 ? 990000 : 1170000,transactions:[]});
  const add=(name,block,from,to,data,contractAddress=null,nonce=0)=>{
    const txHash=hash(`gov24-tx-${name}`),header=blocks.get(block),tx={hash:txHash,chainId:56n,from,to,value:0n,data,nonce,blockNumber:block,blockHash:header.hash,index:0};
    transactions.set(txHash,tx);receipts.set(txHash,{hash:txHash,from,to,status:1,contractAddress,blockNumber:block,blockHash:header.hash,index:0,logs:[]});header.transactions=[txHash];return txHash;
  };
  for (const [index,row] of plan.deployments.entries()) {codes.set(row.address.toLowerCase(),row.expectedRuntime);deployments[row.name]={address:row.address,txHash:add(row.name,900+index,prior.catalog.deployer,null,row.data,row.address,50+index)};}
  const scheduleTxHash=add('schedule',920,prior.catalog.bindings.proposer,plan.timelock,plan.scheduleData),executeTxHash=add('execute',1090,'0x0000000000000000000000000000000000004444',plan.timelock,plan.executeData);
  const event=(txHash,to,name,args)=>{const receipt=receipts.get(txHash),encoded=abi.encodeEventLog(abi.getEvent(name),args);receipt.logs.push({...encoded,address:to,transactionHash:txHash,blockHash:receipt.blockHash,
    blockNumber:receipt.blockNumber,index:receipt.logs.length,transactionIndex:receipt.index,removed:false});};
  plan.targets.forEach((to,index)=>{
    event(scheduleTxHash,plan.timelock,'CallScheduled',[plan.operationId,BigInt(index),to,0n,plan.payloads[index],ZeroHash,172800n]);
    event(executeTxHash,plan.timelock,'CallExecuted',[plan.operationId,BigInt(index),to,0n,plan.payloads[index]]);
  });
  event(scheduleTxHash,plan.timelock,'CallSalt',[plan.operationId,plan.salt]);
  plan.steps.slice(0,6).forEach(step=>event(executeTxHash,step.target,'Upgraded',[step.implementation]));
  [2,3,6].forEach(index=>event(executeTxHash,plan.targets[index],'OwnershipTransferred',[plan.timelock,plan.nextTimelock]));
  const cancellationTxHash=conflictingPending?add('cancel',914,prior.catalog.bindings.proposer,plan.timelock,plan.cancellations[0].data):null;
  if(cancellationTxHash)event(cancellationTxHash,plan.timelock,'Cancelled',[pendingOp.operationId]);
  const state={phase,waiting,cancelled,pendingTimestamp:900000n,newDelay:86400n,secondaryOwner:plan.nextTimelock,corePools:[],portfolioPools:[]};
  const current=(block)=>state.phase==='done' && block>=1090;
  const proxyNames={factory:'Governance24FreshPoolFactory',portfolioFactory:'Governance24BudgetPortfolioFactory',shareMarket:'CoreGovernance24ShareMarket',portfolioShareMarket:'PortfolioGovernance24ShareMarket'};
  const provider={...base.provider,
    async getLogs(filter){
      const scheduled=receipts.get(scheduleTxHash).logs.filter(log=>same(log.topics[0],abi.getEvent('CallScheduled').topicHash));
      return structuredClone((state.phase==='scheduled'||state.phase==='done'?scheduled:[]).filter(log=>log.blockNumber>=filter.fromBlock&&log.blockNumber<=filter.toBlock));
    },
    async getBlock(tag){return tag==='finalized' ? structuredClone(blocks.get(1100)) : blocks.has(tag) ? structuredClone(blocks.get(tag)) : base.provider.getBlock(tag);},
    async getStorage(to,slot,block){
      for (const [name,replacement] of Object.entries(proxyNames)) if (same(to,a[name]) && current(block)) return `0x${replacements[replacement].slice(2).toLowerCase().padStart(64,'0')}`;
      for (const kind of ['corePools','portfolioPools']) if (state[kind].some(pool=>same(pool.address,to))) return `0x${(kind==='corePools'?a.beacon:a.portfolioBeacon).slice(2).toLowerCase().padStart(64,'0')}`;
      return base.provider.getStorage(to,slot,block);
    },
    async send(method,args){
      if(method!=='eth_call')return base.provider.send(method,args);
      let parsed;try{parsed=abi.parseTransaction({data:args[0].data});}catch{}if(!parsed)return base.provider.send(method,args);
      const name=parsed.name,to=args[0].to,block=Number(BigInt(args[1])),isNewLock=same(to,replacements.PoolTimelock24),isSecondary=same(to,replacements.CoreGovernance24Beacon)||same(to,replacements.PortfolioGovernance24Beacon);
      let value;
      if (same(to,a.timelock) && ['isOperation','isOperationReady','isOperationDone','getTimestamp'].includes(name) && same(parsed.args[0],pendingOp.operationId)) value=name==='getTimestamp'?state.cancelled&&block>=914?0n:state.pendingTimestamp:name==='isOperation'?!(state.cancelled&&block>=914):false;
      else if(same(to,a.timelock)&&name==='hashOperation'&&same(parsed.args[4],pendingOp.salt))value=pendingOp.operationId;
      else if(same(to,a.timelock)&&name==='hashOperationBatch')value=plan.operationId;
      else if(same(to,a.timelock)&&['isOperation','isOperationReady','isOperationDone','getTimestamp'].includes(name)&&same(parsed.args[0],plan.operationId)) value=name==='getTimestamp'?state.phase==='done'?1n:state.phase==='unscheduled'?0n:1172800n:name==='isOperation'?state.phase!=='unscheduled':name==='isOperationDone'?state.phase==='done':state.phase==='scheduled'&&!state.waiting;
      else if(isNewLock && (name==='getMinDelay'||name==='MINIMUM_DELAY'))value=state.newDelay;
      else if(isNewLock && name==='INITIAL_PROPOSER')value=prior.catalog.bindings.proposer;
      else if(isNewLock && name==='hasRole')value=same(parsed.args[0],ZeroHash)?same(parsed.args[1],to):true;
      else if(isSecondary&&name==='owner')value=state.secondaryOwner;
      else if(isSecondary&&name==='implementation')value=same(to,replacements.CoreGovernance24Beacon)?replacements.PoolVault:replacements.BudgetPortfolioVault;
      else if(name==='OFFICIAL_FACTORY'&&(isSecondary||same(to,replacements.CoreGovernance24Dispatcher)||same(to,replacements.PortfolioGovernance24Dispatcher)||same(to,replacements.PoolVault)||same(to,replacements.BudgetPortfolioVault)))value=same(to,replacements.CoreGovernance24Beacon)||same(to,replacements.CoreGovernance24Dispatcher)||same(to,replacements.PoolVault)?a.factory:a.portfolioFactory;
      else if(name==='SECONDARY_BEACON')value=same(to,replacements.CoreGovernance24Dispatcher)?replacements.CoreGovernance24Beacon:replacements.PortfolioGovernance24Beacon;
      else if(name==='owner'&&current(block)&&(same(to,a.factory)||same(to,a.portfolioFactory)||same(to,prior.catalog.authority.address)))value=plan.nextTimelock;
      else if(name==='timelock'&&current(block)&&Object.keys(proxyNames).some(key=>same(to,a[key])))value=plan.nextTimelock;
      else if(name==='implementation'&&current(block)&&(same(to,a.beacon)||same(to,a.portfolioBeacon)))value=same(to,a.beacon)?replacements.CoreGovernance24Dispatcher:replacements.PortfolioGovernance24Dispatcher;
      else if(name==='beacon')value=same(to,a.factory)?a.beacon:a.portfolioBeacon;
      else if(name==='shareMarket')value=same(to,a.factory)?a.shareMarket:a.portfolioShareMarket;
      else if(name==='legacyFactory')value=a.factory;
      else if(name==='factory'&&same(to,a.portfolioShareMarket))value=a.portfolioFactory;
      else if(name==='poolCount'||name==='portfolioCount')value=BigInt(state[name==='poolCount'?'corePools':'portfolioPools'].length);
      else if(name==='allPools'||name==='portfolioAt')value=state[name==='allPools'?'corePools':'portfolioPools'][Number(parsed.args[0])].address;
      else if(name==='OFFICIAL_FACTORY'&&state.corePools.some(pool=>same(pool.address,to)))value=a.factory;
      else if(name==='OFFICIAL_FACTORY'&&state.portfolioPools.some(pool=>same(pool.address,to)))value=a.portfolioFactory;
      else if(name==='factory'&&state.corePools.some(pool=>same(pool.address,to)))value=a.factory;
      else return base.provider.send(method,args);
      return abi.encodeFunctionResult(name,[value]);
    },
  };
  return {input,plan,provider,state,deployments,replacements,blocks,codes,transactions,receipts,scheduleTxHash,executeTxHash,cancellationTxHash,base,
    options:{phase,deployments,plan,scheduleTxHash,executeTxHash,cancellationTxHashes:cancelled&&cancellationTxHash?{[pendingOp.operationId]:cancellationTxHash}:{}}};
}
