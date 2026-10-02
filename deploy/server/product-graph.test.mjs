import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { AbiCoder, Interface, getAddress, keccak256, toUtf8Bytes } from 'ethers';
import { productGraphConfiguration, verifyProductGraph, verifyFreshAuthority } from './product-graph.mjs';
import { createPinnedSigningGraphVerifier } from './journal-api.mjs';
import { buildDigest, settleReads } from '../shared/firsto-upgrade-proof.mjs';
import { FACTORY_IMPLEMENTATION_SLOT, factoryReuseSalt, freshFactoryReuseOperation,
  validateFreshFactoryReuseCatalog, verifyFreshFactoryReuse, factoryReuseRuntimeMatches } from '../shared/fresh-factory-reuse-proof.mjs';
const freshBundle=JSON.parse(readFileSync(new URL('../public/deployment-artifacts.json',import.meta.url),'utf8'));
const bundle=structuredClone(freshBundle);
delete bundle.artifacts.FreshPoolFactory;
const libraries=['FlexiblePurchase','MiningOperations','PoolFunds','PurchaseValidation','RewardAccounting','SaleGovernance','SaleSettlement','ShareCheckpoints','FirstoSale'];
const names=[...libraries,'AtomicDeployment','PoolVault','PoolFactory','ShareMarket','BudgetPortfolioFactory','BudgetPortfolioVault','factory','shareMarket','lens','beacon','timelock','portfolioFactory','portfolioShareMarket','portfolioBeacon'];
const artifacts={factory:'ERC1967Proxy',shareMarket:'ERC1967Proxy',lens:'PoolLens',beacon:'PoolBeacon',timelock:'PoolTimelock',portfolioFactory:'ERC1967Proxy',portfolioShareMarket:'ERC1967Proxy',portfolioBeacon:'PoolBeacon'};
const addr=n=>getAddress(`0x${n.toString(16).padStart(40,'0')}`),hash=n=>`0x${n.toString(16).padStart(64,'0')}`;
const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
function fixture(){
  const {sourceCommit:_source,...content}=bundle, addresses=Object.fromEntries(names.map((name,i)=>[name,addr(i+1)]));
  addresses.portfolioVaultImplementation=addresses.BudgetPortfolioVault;addresses.portfolioFactoryImplementation=addresses.BudgetPortfolioFactory;
  const runtimes={};
  for(const name of names){
    const artifact=bundle.artifacts[artifacts[name]??name];let bytes=artifact.deployedBytecode.slice(2);
    for(const links of Object.values(artifact.deployedLinkReferences??{}))for(const [library,locations]of Object.entries(links))for(const {start,length}of locations)
      bytes=bytes.slice(0,start*2)+addresses[library].slice(2).toLowerCase()+bytes.slice((start+length)*2);
    if(libraries.includes(name)&&bytes.startsWith(`73${'0'.repeat(40)}`))bytes=`73${addresses[name].slice(2).toLowerCase()}${bytes.slice(42)}`;
    runtimes[name]='0x'+bytes;
  }
  const account=addr(90), input={governanceMode:'single',ownerMultisig:account,operator:account,treasury:account};
  const record={schemaVersion:1,kind:'integrated-v2',chainId:56,status:'complete',account,input,addresses,
    artifactDigest:keccak256(toUtf8Bytes(JSON.stringify(canonical(content)))),
    steps:[...libraries,'AtomicDeployment','PoolVault','PoolFactory','ShareMarket','BudgetPortfolioFactory','BudgetPortfolioVault','initialize'].map(id=>({id,status:'confirmed',receipt:{status:1},txHash:hash(8)})),
    verification:{checks:[{passed:true}],code:Object.fromEntries(names.map(name=>[name,{address:addresses[name],codehash:keccak256(runtimes[name])}]))}};
  const state={codeChanged:null,binding:null,slot:false,reorg:false,codeReads:0,callReads:0};
  const values={AtomicDeployment:{deployed:true,deployer:account,predictedFactory:addresses.factory,predictedPortfolioFactory:addresses.portfolioFactory},
    factory:{owner:account,operator:account,treasury:account,lens:addresses.lens,shareMarket:addresses.shareMarket,beacon:addresses.beacon,timelock:addresses.timelock},
    lens:{factory:addresses.factory,VERSION:1n},shareMarket:{factory:addresses.factory,timelock:addresses.timelock,feeBps:100n,buyerFeeBps:100n},
    portfolioFactory:{owner:account,operator:account,treasury:account,timelock:addresses.timelock,legacyFactory:addresses.factory,beacon:addresses.portfolioBeacon,shareMarket:addresses.portfolioShareMarket},
    portfolioShareMarket:{factory:addresses.portfolioFactory,timelock:addresses.timelock,feeBps:100n,buyerFeeBps:100n},
    portfolioBeacon:{owner:addresses.timelock,implementation:addresses.BudgetPortfolioVault,OFFICIAL_FACTORY:addresses.portfolioFactory},
    BudgetPortfolioVault:{OFFICIAL_FACTORY:addresses.portfolioFactory},
    beacon:{owner:addresses.timelock,implementation:addresses.PoolVault,OFFICIAL_FACTORY:addresses.factory},PoolVault:{OFFICIAL_FACTORY:addresses.factory},
    timelock:{getMinDelay:172800n,MINIMUM_DELAY:172800n,PROPOSER_ROLE:hash(1),CANCELLER_ROLE:hash(2),EXECUTOR_ROLE:hash(3),DEFAULT_ADMIN_ROLE:hash(4)}};
  const provider={
    getCode:async(address,block)=>{assert.equal(block,100);state.codeReads++;const name=names.find(n=>addresses[n].toLowerCase()===address.toLowerCase());return state.codeChanged===name?runtimes[name]+'00':runtimes[name];},
    getStorage:async(address,slot,block)=>{assert.equal(block,100);return '0x'+(state.slot?addr(99):address===addresses.factory?addresses.PoolFactory:address===addresses.portfolioFactory?addresses.BudgetPortfolioFactory:addresses.ShareMarket).slice(2).padStart(64,'0');},
    getBlock:async()=>({number:100,hash:state.reorg?hash(101):hash(100)}),
    async send(method,[tx,tag]){
      assert.equal(method,'eth_call');assert.equal(tag,'0x64');state.callReads++;
      const name=names.find(n=>addresses[n].toLowerCase()===tx.to.toLowerCase()),iface=new Interface(bundle.artifacts[({factory:'PoolFactory',shareMarket:'ShareMarket',portfolioFactory:'BudgetPortfolioFactory',portfolioShareMarket:'ShareMarket'})[name] ?? artifacts[name] ?? name].abi);
      const parsed=iface.parseTransaction(tx);let value=values[name][parsed.name];
      if(parsed.name==='hasRole')value=(parsed.args[0]===hash(1)||parsed.args[0]===hash(2))&&parsed.args[1]===account
        ||parsed.args[0]===hash(3)&&parsed.args[1]===addr(0)||parsed.args[0]===hash(4)&&parsed.args[1]===addresses.timelock;
      if(state.binding===`${name}.${parsed.name}`)value=typeof value==='boolean'?!value:typeof value==='bigint'?value+1n:addr(99);
      return iface.encodeFunctionResult(parsed.name,[value]);
    }
  };
  return {provider,state,record,values,addresses,trusted:productGraphConfiguration({record,bundle}),block:{number:100,hash:hash(100)}};
}
test('trusted complete record is bound to the served artifact digest and all code evidence',()=>{
  const f=fixture();
  for(const mutate of [r=>r.status='ready',r=>r.steps[0].status='waiting',r=>r.artifactDigest=hash(99),
    r=>delete r.verification.code.PoolVault,r=>r.addresses.factory=addr(99)]){
    const record=structuredClone(f.record);mutate(record);assert.throws(()=>productGraphConfiguration({record,bundle}));
  }
  const original=f.trusted.record.addresses.factory;f.record.addresses.factory=addr(99);assert.equal(f.trusted.record.addresses.factory,original);
});
test('fresh genesis aliases only the reviewed FreshPoolFactory and requires exact Gas address evidence',()=>{
  const f=fixture();
  const record=structuredClone(f.record);
  record.id='fresh-graph-test';
  record.steps=record.steps.map(step=>step.id==='PoolFactory'?{...step,id:'FreshPoolFactory'}:step);
  record.addresses.FreshPoolFactory=record.addresses.PoolFactory;
  record.verification.code.FreshPoolFactory=record.verification.code.PoolFactory;
  delete record.addresses.PoolFactory;
  delete record.verification.code.PoolFactory;
  const {sourceCommit:_source,...content}=freshBundle;
  record.artifactDigest=keccak256(toUtf8Bytes(JSON.stringify(canonical(content))));
  const gasWallet=addr(91),authority=addr(92);
  const activation={schemaVersion:1,kind:'fresh-authority',chainId:56,
    deploymentId:record.id,genesisArtifactDigest:record.artifactDigest,
    verifiedAt:new Date().toISOString(),authority:{address:authority,deploymentTxHash:hash(201),
      administratorOne:'0x7674fa446D42b1f7f150DC5e678cc525d275Ea53',
      administratorTwo:'0xed2fcbe59ebe1754a3676aeb9ccfba20f193fcbb',gasWallet},
    steps:['deployAuthority','coreOperator','coreTreasury','budgetOperator','budgetTreasury',
      'coreOwner','budgetOwner'].map((id,index)=>({id,txHash:hash(201+index),
        blockNumber:200+index,blockHash:hash(301+index)}))};
  const trusted=productGraphConfiguration({record,bundle:freshBundle,
    productActivation:activation,expectedGasWallet:gasWallet});
  assert.equal(trusted.record.addresses.PoolFactory,record.addresses.FreshPoolFactory);
  assert.equal(trusted.freshAuthority.authority.address,authority);
  assert.throws(()=>productGraphConfiguration({record,bundle:freshBundle,productActivation:activation}),/Gas wallet/);
  assert.throws(()=>productGraphConfiguration({record,bundle:freshBundle,productActivation:activation,
    expectedGasWallet:addr(93)}),/seven ordered transactions/);
  assert.throws(()=>productGraphConfiguration({record:{...record,steps:f.record.steps},bundle:freshBundle}),/Fresh deployment/);
});
test('seven hardware-wallet Authority actions must match exact calldata, order, canonical receipts and state',async()=>{
  const account=addr(90), gasWallet=addr(91), authority=addr(92);
  const addresses={factory:addr(50),portfolioFactory:addr(51),timelock:addr(52)};
  const core=new Interface(freshBundle.artifacts.PoolFactory.abi);
  const budget=new Interface(freshBundle.artifacts.BudgetPortfolioFactory.abi);
  const authorityAbi=new Interface(freshBundle.artifacts.PlatformAuthority.abi);
  const admins=['0x7674fa446D42b1f7f150DC5e678cc525d275Ea53',
    '0xed2fcbe59ebe1754a3676aeb9ccfba20f193fcbb'];
  const data=[freshBundle.artifacts.PlatformAuthority.bytecode
    +AbiCoder.defaultAbiCoder().encode(['address','address','address','address','address'],
      [addresses.factory,addresses.portfolioFactory,...admins,gasWallet]).slice(2),
  core.encodeFunctionData('setOperator',[authority]),core.encodeFunctionData('setTreasury',[authority]),
  budget.encodeFunctionData('setOperator',[authority]),budget.encodeFunctionData('setTreasury',[authority]),
  core.encodeFunctionData('transferOwnership',[addresses.timelock]),
  budget.encodeFunctionData('transferOwnership',[addresses.timelock])];
  const tos=[null,addresses.factory,addresses.factory,addresses.portfolioFactory,
    addresses.portfolioFactory,addresses.factory,addresses.portfolioFactory];
  const steps=['deployAuthority','coreOperator','coreTreasury','budgetOperator','budgetTreasury',
    'coreOwner','budgetOwner'].map((id,index)=>({id,txHash:hash(200+index),
      blockNumber:100+index,blockHash:hash(300+index)}));
  const evidence={authority:{address:authority,deploymentTxHash:steps[0].txHash,
    administratorOne:admins[0],administratorTwo:admins[1],gasWallet},steps};
  const state={badData:false,badReceipt:false,badOwner:false,
    currentFirst:admins[0],currentSecond:admins[1]};
  const txs=steps.map((step,index)=>({hash:step.txHash,from:account,to:tos[index],
    data:data[index],value:0n,nonce:index,index:0}));
  const receipts=steps.map((step,index)=>({status:1,blockNumber:step.blockNumber,
    blockHash:step.blockHash,contractAddress:index===0?authority:null}));
  const values={owner:()=>state.badOwner?addr(99):addresses.timelock,
    coreFactory:()=>addresses.factory,budgetFactory:()=>addresses.portfolioFactory,
    administratorOne:()=>state.currentFirst,administratorTwo:()=>state.currentSecond,
    gasWallet:()=>gasWallet};
  const provider={
    getTransaction:async txHash=>{
      const index=steps.findIndex(step=>step.txHash===txHash);
      return index<0?null:{...txs[index],data:state.badData&&index===3?'0x12345678':txs[index].data};
    },
    getTransactionReceipt:async txHash=>{
      const index=steps.findIndex(step=>step.txHash===txHash);
      return index<0?null:{...receipts[index],status:state.badReceipt&&index===4?0:1};
    },
    getBlock:async number=>({number,hash:steps.find(step=>step.blockNumber===number)?.blockHash}),
    getCode:async()=>freshBundle.artifacts.PlatformAuthority.deployedBytecode,
    send:async(method,[tx,tag])=>{
      assert.equal(method,'eth_call');assert.equal(tag,'0x78');
      const parsed=authorityAbi.parseTransaction(tx),name=parsed.name;
      if(name==='eip712Domain') return authorityAbi.encodeFunctionResult(name,[
        '0x0f','BEMine Platform Authority','1',56n,authority,hash(0),[]]);
      return authorityAbi.encodeFunctionResult(name,[values[name]()]);
    },
  };
  const record={account,addresses};
  const verified=await verifyFreshAuthority(provider,record,freshBundle,evidence,{number:120});
  assert.equal(verified.current.coreOperator,authority);
  assert.equal(verified.current.budgetOwner,addresses.timelock);
  state.currentFirst=addr(93);
  assert.equal((await verifyFreshAuthority(provider,record,freshBundle,evidence,{number:120})).address,
    authority,'a timelock-approved admin rotation preserves the historical deployment proof');
  for(const [first,second] of [[addr(0),admins[1]],[admins[1],admins[1]],
    [gasWallet,admins[1]]]){
    state.currentFirst=first;state.currentSecond=second;
    await assert.rejects(verifyFreshAuthority(provider,record,freshBundle,evidence,{number:120}),
      /constructor state/);
  }
  state.currentFirst=admins[0];state.currentSecond=admins[1];
  for(const key of ['badData','badReceipt','badOwner']){
    state[key]=true;
    await assert.rejects(verifyFreshAuthority(provider,record,freshBundle,evidence,{number:120}));
    state[key]=false;
  }
});
test('fresh pinned graph accepts all compiled runtime, roles and slots then detects each changed binding',async()=>{
  const f=fixture();await verifyProductGraph(f.provider,f.addresses.factory,f.trusted,f.block);
  assert.equal(f.state.codeReads,names.length);assert(f.state.callReads>=25);
  for(const binding of ['AtomicDeployment.deployer','factory.operator','factory.treasury','factory.lens','lens.factory','lens.VERSION',
    'shareMarket.feeBps','shareMarket.timelock','beacon.implementation','beacon.OFFICIAL_FACTORY','PoolVault.OFFICIAL_FACTORY','timelock.getMinDelay','timelock.hasRole',
    'portfolioFactory.legacyFactory','portfolioFactory.shareMarket','portfolioShareMarket.buyerFeeBps','portfolioBeacon.implementation','BudgetPortfolioVault.OFFICIAL_FACTORY']){
    f.state.binding=binding;await assert.rejects(verifyProductGraph(f.provider,f.addresses.factory,f.trusted,f.block),/changed/);
  }
  f.state.binding=null;const graph=await verifyProductGraph(f.provider,f.addresses.portfolioFactory,f.trusted,f.block);
  assert.equal(graph.productKind,'budget');assert.equal(graph.legacyFactory,f.addresses.factory);
});
test('runtime drift, implementation upgrade, reorg, missing evidence and unconfigured factory fail closed',async()=>{
  for(const change of [{codeChanged:'FlexiblePurchase'},{codeChanged:'PoolVault'},{codeChanged:'factory'},{slot:true},{reorg:true}]){
    const f=fixture();Object.assign(f.state,change);await assert.rejects(verifyProductGraph(f.provider,f.addresses.factory,f.trusted,f.block),/changed/);
  }
  const f=fixture();await assert.rejects(verifyProductGraph(f.provider,f.addresses.factory,null,f.block),/unavailable/);
  await assert.rejects(verifyProductGraph(f.provider,addr(99),f.trusted,f.block),/differs/);
});

test('signing graph reuses the actual pinned proof only while its block remains canonical and the cache is fresh',async()=>{
  const f=fixture();let now=1_000;
  const verified=createPinnedSigningGraphVerifier(
    (provider,factory,block)=>verifyProductGraph(provider,factory,f.trusted,block),f.trusted,()=>now);
  const [first,second]=await Promise.all([
    verified(f.provider,f.addresses.factory,f.block),verified(f.provider,f.addresses.factory,f.block)]);
  assert.strictEqual(first,second,'simultaneous signing requests share one complete graph proof');
  assert.equal(first.factory,f.addresses.factory);
  assert.equal(first.blockNumber,f.block.number);
  assert.equal(first.artifactDigest,f.trusted.record.artifactDigest);
  assert.equal(f.state.codeReads,names.length);
  assert.strictEqual(await verified(f.provider,f.addresses.factory,f.block),first);
  assert.equal(f.state.codeReads,names.length,'cached signing proof skips repeated full code reads');
  f.state.reorg=true;
  await assert.rejects(verified(f.provider,f.addresses.factory,f.block),/Chain changed/);
  f.state.reorg=false;
  now+=5_001;
  await verified(f.provider,f.addresses.factory,f.block);
  assert.equal(f.state.codeReads,names.length*2,'expired proof is verified again');
});

test('signing graph never caches a verifier result with another block or artifact digest',async()=>{
  const f=fixture();let checks=0;
  const badResults=[
    {factory:f.addresses.factory,blockNumber:f.block.number+1,artifactDigest:f.trusted.record.artifactDigest},
    {factory:f.addresses.factory,blockNumber:f.block.number,artifactDigest:hash(999)},
  ];
  const verified=createPinnedSigningGraphVerifier(async()=>{
    checks++;
    return badResults.shift()??{factory:f.addresses.factory,blockNumber:f.block.number,
      artifactDigest:f.trusted.record.artifactDigest};
  },f.trusted);
  await assert.rejects(verified(f.provider,f.addresses.factory,f.block),/graph identity changed/);
  await assert.rejects(verified(f.provider,f.addresses.factory,f.block),/graph identity changed/);
  await verified(f.provider,f.addresses.factory,f.block);
  await verified(f.provider,f.addresses.factory,f.block);
  assert.equal(checks,3,'invalid graph results are never cached');
});

test('actual graph routing selects the new Factory artifact for both runtime and proxy ABI without changing other nodes', async()=>{
  const f=fixture(),implementation=addr(190),proposer=f.record.input.ownerMultisig;
  f.trusted.record.addresses.FreshPoolFactory=f.addresses.PoolFactory;
  f.trusted.bundle.artifacts.FreshPoolFactory=freshBundle.artifacts.FreshPoolFactory;
  f.trusted.freshAuthority={authority:{address:addr(191)}};
  f.values.factory.owner=f.addresses.timelock;
  f.trusted.freshSalePolicy={catalog:{profile:'formal',bindings:{proposer}}};
  const extra=new Interface(['function soldMachineReuseVersion() view returns(uint8)',
    'function proxiableUUID() view returns(bytes32)',
    'function hashOperationBatch(address[],uint256[],bytes[],bytes32,bytes32) view returns(bytes32)',
    'function isOperationDone(bytes32) view returns(bool)']);
  const artifact={contractName:'FreshPoolFactory',abi:[...freshBundle.artifacts.FreshPoolFactory.abi,
    ...extra.fragments.filter(fragment=>fragment.name==='soldMachineReuseVersion').map(fragment=>JSON.parse(fragment.format('json')))],
    bytecode:'0x6000',deployedBytecode:'0x60'+'0'.repeat(64)+'6000',immutableReferences:{17:[{start:1,length:32}]},
    linkReferences:{},deployedLinkReferences:{}};
  const candidate={sourceCommit:'a'.repeat(40),artifacts:{FreshPoolFactory:artifact}};
  const catalog={schemaVersion:1,kind:'fresh-sold-machine-reuse-upgrade-v1',chainId:56,profile:'formal',
    genesisArtifactDigest:f.trusted.record.artifactDigest,candidateArtifactDigest:buildDigest(candidate),
    bindings:{factory:f.addresses.factory,timelock:f.addresses.timelock,proposer},
    expectedImplementations:{FreshPoolFactory:f.addresses.PoolFactory},artifacts:candidate.artifacts,minimumDelaySeconds:'172800'};
  catalog.salt=factoryReuseSalt(f.addresses.factory,catalog.candidateArtifactDigest);
  f.trusted.freshFactoryReuse=validateFreshFactoryReuseCatalog(catalog,candidate,f.trusted);
  const operation=freshFactoryReuseOperation(catalog,implementation);
  const runtime='0x60'+implementation.slice(2).padStart(64,'0')+'6000';
  const original={...f.provider},abiReads=[];
  f.provider.getCode=async(to,at)=>to===implementation?runtime:original.getCode(to,at);
  f.provider.getStorage=async(to,slot,at)=>to===f.addresses.factory
    ? '0x'+implementation.slice(2).padStart(64,'0'):original.getStorage(to,slot,at);
  f.provider.send=async(method,params)=>{
    const parsed=extra.parseTransaction(params[0]);
    if(parsed){const values={soldMachineReuseVersion:1n,proxiableUUID:FACTORY_IMPLEMENTATION_SLOT,
      hashOperationBatch:operation.operationId,isOperationDone:true};
      return extra.encodeFunctionResult(parsed.name,[values[parsed.name]]);}
    abiReads.push(params[0].to);return original.send(method,params);
  };
  // Other upgrade proofs have their own real regressions. Isolate this new source
  // selection using the actual graph body and runtime helpers, with unchanged roles.
  const source=readFileSync(new URL('./product-graph.mjs',import.meta.url),'utf8');
  const prefix=source.slice(source.indexOf('const HASH ='),source.indexOf('/** Match the reviewed Authority'));
  const verifier=source.slice(source.indexOf('export async function verifyProductGraph')).replace('export async function','async function');
  const verify=new Function('Interface','getAddress','keccak256','toUtf8Bytes','AbiCoder','settleReads',
    'verifyFreshAuthority','verifyFreshNativeSale','verifyFreshSalePolicy','verifyFreshFactoryReuse',
    'factoryReuseRuntimeMatches','SHARE_FEE_UPGRADE_KIND',prefix+verifier+'\nreturn verifyProductGraph;')(
      Interface,getAddress,keccak256,toUtf8Bytes,AbiCoder,settleReads,async()=>({current:{coreOwner:f.addresses.timelock}}),async()=>null,async()=>null,
      verifyFreshFactoryReuse,factoryReuseRuntimeMatches,'unused');
  const graph=await verify(f.provider,f.addresses.factory,f.trusted,f.block);
  assert.equal(graph.addresses.PoolFactory,implementation);assert.equal(graph.addresses.FreshPoolFactory,implementation);
  assert.equal(graph.codehash.PoolFactory,keccak256(runtime));assert.equal(graph.codehash.FreshPoolFactory,keccak256(runtime));
  assert.equal(graph.factoryReuseUpgrade.version,1);assert.equal(graph.artifactDigest,f.record.artifactDigest);
  assert.equal(graph.addresses.PoolVault,f.addresses.PoolVault);assert.equal(graph.addresses.shareMarket,f.addresses.shareMarket);
  assert(abiReads.includes(f.addresses.factory),'Proxy getter ABI must also resolve through FreshPoolFactory candidate source.');
  f.state.codeChanged='RewardAccounting';
  await assert.rejects(verify(f.provider,f.addresses.factory,f.trusted,f.block),/Reviewed runtime changed/);
});
