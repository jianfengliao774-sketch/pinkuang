import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Interface, getAddress, keccak256, toUtf8Bytes } from 'ethers';
import { productGraphConfiguration, verifyProductGraph } from './product-graph.mjs';
const bundle=JSON.parse(readFileSync(new URL('../public/deployment-artifacts.json',import.meta.url),'utf8'));
const libraries=['FlexiblePurchase','MiningOperations','PoolFunds','PurchaseValidation','RewardAccounting','SaleGovernance','SaleSettlement','ShareCheckpoints'];
const names=[...libraries,'AtomicDeployment','PoolVault','PoolFactory','ShareMarket','factory','shareMarket','lens','beacon','timelock'];
const artifacts={factory:'ERC1967Proxy',shareMarket:'ERC1967Proxy',lens:'PoolLens',beacon:'PoolBeacon',timelock:'PoolTimelock'};
const addr=n=>getAddress(`0x${n.toString(16).padStart(40,'0')}`),hash=n=>`0x${n.toString(16).padStart(64,'0')}`;
const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
function fixture(){
  const {sourceCommit:_source,...content}=bundle, addresses=Object.fromEntries(names.map((name,i)=>[name,addr(i+1)]));
  const runtimes={};
  for(const name of names){
    const artifact=bundle.artifacts[artifacts[name]??name];let bytes=artifact.deployedBytecode.slice(2);
    for(const links of Object.values(artifact.deployedLinkReferences??{}))for(const [library,locations]of Object.entries(links))for(const {start,length}of locations)
      bytes=bytes.slice(0,start*2)+addresses[library].slice(2).toLowerCase()+bytes.slice((start+length)*2);
    if(libraries.includes(name)&&bytes.startsWith(`73${'0'.repeat(40)}`))bytes=`73${addresses[name].slice(2).toLowerCase()}${bytes.slice(42)}`;
    runtimes[name]='0x'+bytes;
  }
  const account=addr(90), input={ownerMultisig:account,operator:account,treasury:account};
  const record={schemaVersion:1,chainId:56,status:'complete',account,input,addresses,
    artifactDigest:keccak256(toUtf8Bytes(JSON.stringify(canonical(content)))),
    steps:[...libraries,'AtomicDeployment','PoolVault','PoolFactory','ShareMarket','initialize'].map(id=>({id,status:'confirmed',receipt:{status:1},txHash:hash(8)})),
    verification:{checks:[{passed:true}],code:Object.fromEntries(names.map(name=>[name,{address:addresses[name],codehash:keccak256(runtimes[name])}]))}};
  const state={codeChanged:null,binding:null,slot:false,reorg:false,codeReads:0,callReads:0};
  const values={AtomicDeployment:{deployed:true,deployer:account,predictedFactory:addresses.factory},
    factory:{owner:account,operator:account,treasury:account,lens:addresses.lens,shareMarket:addresses.shareMarket,beacon:addresses.beacon,timelock:addresses.timelock},
    lens:{factory:addresses.factory,VERSION:1n},shareMarket:{factory:addresses.factory,timelock:addresses.timelock,feeBps:100n},
    beacon:{owner:addresses.timelock,implementation:addresses.PoolVault,OFFICIAL_FACTORY:addresses.factory},PoolVault:{OFFICIAL_FACTORY:addresses.factory},
    timelock:{getMinDelay:172800n,MINIMUM_DELAY:172800n,PROPOSER_ROLE:hash(1),CANCELLER_ROLE:hash(2),EXECUTOR_ROLE:hash(3),DEFAULT_ADMIN_ROLE:hash(4)}};
  const provider={
    getCode:async(address,block)=>{assert.equal(block,100);state.codeReads++;const name=names.find(n=>addresses[n].toLowerCase()===address.toLowerCase());return state.codeChanged===name?runtimes[name]+'00':runtimes[name];},
    getStorage:async(address,slot,block)=>{assert.equal(block,100);return '0x'+(state.slot?addr(99):address===addresses.factory?addresses.PoolFactory:addresses.ShareMarket).slice(2).padStart(64,'0');},
    getBlock:async()=>({number:100,hash:state.reorg?hash(101):hash(100)}),
    async send(method,[tx,tag]){
      assert.equal(method,'eth_call');assert.equal(tag,'0x64');state.callReads++;
      const name=names.find(n=>addresses[n].toLowerCase()===tx.to.toLowerCase()),iface=new Interface(bundle.artifacts[({factory:'PoolFactory',shareMarket:'ShareMarket'})[name] ?? artifacts[name] ?? name].abi);
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
test('fresh pinned graph accepts all compiled runtime, roles and slots then detects each changed binding',async()=>{
  const f=fixture();await verifyProductGraph(f.provider,f.addresses.factory,f.trusted,f.block);
  assert.equal(f.state.codeReads,names.length);assert(f.state.callReads>=25);
  for(const binding of ['AtomicDeployment.deployer','factory.operator','factory.treasury','factory.lens','lens.factory','lens.VERSION',
    'shareMarket.feeBps','shareMarket.timelock','beacon.implementation','beacon.OFFICIAL_FACTORY','PoolVault.OFFICIAL_FACTORY','timelock.getMinDelay','timelock.hasRole']){
    f.state.binding=binding;await assert.rejects(verifyProductGraph(f.provider,f.addresses.factory,f.trusted,f.block),/changed/);
  }
});
test('runtime drift, implementation upgrade, reorg, missing evidence and unconfigured factory fail closed',async()=>{
  for(const change of [{codeChanged:'FlexiblePurchase'},{codeChanged:'PoolVault'},{codeChanged:'factory'},{slot:true},{reorg:true}]){
    const f=fixture();Object.assign(f.state,change);await assert.rejects(verifyProductGraph(f.provider,f.addresses.factory,f.trusted,f.block),/changed/);
  }
  const f=fixture();await assert.rejects(verifyProductGraph(f.provider,f.addresses.factory,null,f.block),/unavailable/);
  await assert.rejects(verifyProductGraph(f.provider,addr(99),f.trusted,f.block),/differs/);
});
