import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Interface, ZeroHash, getAddress, getCreateAddress, keccak256 } from 'ethers';
import { productGraphConfiguration,verifyProductGraph } from './product-graph.mjs';
import { FIRSTO_UPGRADE_KIND,FIRSTO_UPGRADE_NAMES,SHARE_FEE_UPGRADE_KIND,upgradeNamesForKind,buildDigest,evidenceDigest,firstoUpgradeBatch,firstoUpgradeDeploymentData,verifyFirstoUpgradeProof } from '../shared/firsto-upgrade-proof.mjs';
import { generateFirstoUpgradeEvidence } from '../scripts/verify-firsto-upgrade.mjs';

const compiled=JSON.parse(readFileSync(new URL('../public/deployment-artifacts.json',import.meta.url),'utf8'));
const libraries=['FlexiblePurchase','MiningOperations','PoolFunds','PurchaseValidation','RewardAccounting','SaleGovernance','SaleSettlement','ShareCheckpoints'];
const names=[...libraries,'AtomicDeployment','PoolVault','PoolFactory','ShareMarket','factory','shareMarket','lens','beacon','timelock'];
const aliases={factory:'ERC1967Proxy',shareMarket:'ERC1967Proxy',lens:'PoolLens',beacon:'PoolBeacon',timelock:'PoolTimelock'};
const addr=n=>getAddress(`0x${n.toString(16).padStart(40,'0')}`),hash=n=>`0x${n.toString(16).padStart(64,'0')}`;
const lower=value=>value.toLowerCase();
function runtime(artifact,addresses,address) {
  let data=artifact.deployedBytecode.slice(2);
  for(const links of Object.values(artifact.deployedLinkReferences??{})) for(const [name,locations]of Object.entries(links)) for(const {start,length}of locations)
    data=data.slice(0,start*2)+addresses[name].slice(2).toLowerCase()+data.slice((start+length)*2);
  if(libraries.includes(artifact.contractName)&&data.startsWith(`73${'0'.repeat(40)}`))data=`73${address.slice(2).toLowerCase()}${data.slice(42)}`;
  return '0x'+data;
}
function fixture(kind=FIRSTO_UPGRADE_KIND) {
  const upgradeNames=upgradeNamesForKind(kind);
  const genesisBundle=structuredClone(compiled),bundle=structuredClone(compiled);
  genesisBundle.sourceCommit='a'.repeat(40);bundle.sourceCommit='b'.repeat(40);
  if(kind===SHARE_FEE_UPGRADE_KIND && !bundle.artifacts.ShareMarket.abi.some(item=>item.name==='buyerFeeBps'))
    bundle.artifacts.ShareMarket.abi.push(JSON.parse(new Interface(['function buyerFeeBps() view returns(uint16)']).fragments[0].format('json')));
  // Distinct whole-build metadata proves that unchanged nodes must NOT use the new bundle.
  for(const artifact of Object.values(bundle.artifacts)) { artifact.bytecode+='00';artifact.deployedBytecode+='00'; }
  const old=Object.fromEntries(names.map((name,index)=>[name,addr(index+1)])),account=addr(90),input={ownerMultisig:account,operator:account,treasury:account};
  const oldCode=Object.fromEntries(names.map(name=>[name,runtime(genesisBundle.artifacts[aliases[name]??name],old,old[name])]));
  const genesisRecord={schemaVersion:1,chainId:56,status:'complete',account,input,addresses:old,sourceCommit:genesisBundle.sourceCommit,
    artifactDigest:buildDigest(genesisBundle),steps:[...libraries,'AtomicDeployment','PoolVault','PoolFactory','ShareMarket','initialize']
      .map((id,index)=>({id,status:'confirmed',txHash:hash(1000+index),receipt:{status:1,blockNumber:10,blockHash:hash(10)}})),
    verification:{blockNumber:15,checks:[{passed:true}],code:Object.fromEntries(names.map(name=>[name,{address:old[name],codehash:keccak256(oldCode[name])}]))}};
  const deployments=Object.fromEntries(upgradeNames.map((name,index)=>[name,{address:getCreateAddress({from:account,nonce:100+index}),txHash:hash(200+index)}]));
  const record={schemaVersion:2,kind,chainId:56,status:'complete',genesisRecordDigest:evidenceDigest(genesisRecord),
    genesisArtifactDigest:buildDigest(genesisBundle),artifactDigest:buildDigest(bundle),sourceCommit:bundle.sourceCommit,deployments,
    operation:{scheduleTxHash:hash(300),executeTxHash:hash(301),salt:hash(99),predecessor:ZeroHash},
    verification:{blockNumber:100,blockHash:hash(100),checkedAt:'2026-09-27T00:00:00Z'}};
  const addresses={...old,...Object.fromEntries(upgradeNames.map(name=>[name,deployments[name].address]))};
  const codes=Object.fromEntries(names.map(name=>[name,upgradeNames.includes(name)?runtime(bundle.artifacts[name],addresses,addresses[name]):oldCode[name]]));
  const transactions=new Map(),receipts=new Map(),blocks=new Map();
  const header=number=>({number,hash:hash(number),timestamp:number>=40?174000+number:1000+number,transactions:[]});
  for(const number of [10,20,21,22,23,24,30,39,40,100])blocks.set(number,header(number));
  const addTx=(txHash,number,to,data,nonce=0,contractAddress=null)=>{
    const block=blocks.get(number),index=block.transactions.length;block.transactions.push(txHash);
    transactions.set(txHash,{hash:txHash,chainId:56n,from:account,to,value:0n,data,nonce,blockNumber:number,blockHash:block.hash,index});
    receipts.set(txHash,{hash:txHash,from:account,to,status:1,contractAddress,blockNumber:number,blockHash:block.hash,index,logs:[]});
  };
  upgradeNames.forEach((name,index)=>addTx(deployments[name].txHash,20+index,null,firstoUpgradeDeploymentData(name,bundle,addresses,kind),100+index,addresses[name]));
  const timelock=new Interface(genesisBundle.artifacts.PoolTimelock.abi),factory=new Interface(bundle.artifacts.PoolFactory.abi),beacon=new Interface(genesisBundle.artifacts.PoolBeacon.abi);
  const batch=firstoUpgradeBatch(addresses,record.operation,kind);
  addTx(record.operation.scheduleTxHash,30,old.timelock,timelock.encodeFunctionData('scheduleBatch',[...batch.args,172800n]));
  addTx(record.operation.executeTxHash,40,old.timelock,batch.executeData);
  const event=(txHash,address,iface,name,args)=>{
    const receipt=receipts.get(txHash),encoded=iface.encodeEventLog(iface.getEvent(name),args);
    receipt.logs.push({...encoded,address,transactionHash:txHash,blockHash:receipt.blockHash,index:receipt.logs.length});
  };
  for(let index=0;index<batch.targets.length;index++) {
    event(record.operation.scheduleTxHash,old.timelock,timelock,'CallScheduled',[batch.operationId,index,batch.targets[index],0n,batch.payloads[index],ZeroHash,172800n]);
    event(record.operation.executeTxHash,old.timelock,timelock,'CallExecuted',[batch.operationId,index,batch.targets[index],0n,batch.payloads[index]]);
  }
  event(record.operation.executeTxHash,old.factory,factory,'Upgraded',[addresses.PoolFactory]);
  event(record.operation.executeTxHash,old.beacon,beacon,'Upgraded',[addresses.PoolVault]);
  if(kind===SHARE_FEE_UPGRADE_KIND) event(record.operation.executeTxHash,old.shareMarket,
    new Interface(bundle.artifacts.ShareMarket.abi),'Upgraded',[addresses.ShareMarket]);
  event(record.operation.executeTxHash,old.factory,factory,'MachineRegistryMigrationStarted',[0n]);
  event(record.operation.executeTxHash,old.factory,factory,'MachineRegistryMigrationProgress',[0n,0n,true]);
  const initial=genesisRecord.steps.find(step=>step.id==='initialize');
  addTx(initial.txHash,10,old.AtomicDeployment,'0x1234');
  const state={beforePools:0n,ready:true,cutoff:0n,done:true,chain:56n,slot:null,binding:null,code:null,finalized:100,requests:[]};
  const values={AtomicDeployment:{deployed:true,deployer:account,predictedFactory:old.factory},
    factory:{owner:account,operator:account,treasury:account,lens:old.lens,shareMarket:old.shareMarket,beacon:old.beacon,timelock:old.timelock},
    lens:{factory:old.factory,VERSION:1n},shareMarket:{factory:old.factory,timelock:old.timelock,feeBps:100n,buyerFeeBps:100n},
    beacon:{owner:old.timelock,implementation:addresses.PoolVault,OFFICIAL_FACTORY:old.factory},PoolVault:{OFFICIAL_FACTORY:old.factory},
    timelock:{getMinDelay:172800n,MINIMUM_DELAY:172800n,PROPOSER_ROLE:hash(1),CANCELLER_ROLE:hash(2),EXECUTOR_ROLE:hash(3),DEFAULT_ADMIN_ROLE:hash(4)}};
  const provider={getBlock:async number=>blocks.get(number==='finalized'?state.finalized:number),
    getTransaction:async txHash=>transactions.get(txHash),getTransactionReceipt:async txHash=>receipts.get(txHash),
    getCode:async(address,number)=>{assert.equal(number,100);const name=names.find(name=>lower(addresses[name])===lower(address));return name===state.code?codes[name]+'ff':codes[name];},
    getStorage:async address=>'0x'+(state.slot??(lower(address)===lower(old.factory)?addresses.PoolFactory:addresses.ShareMarket)).slice(2).padStart(64,'0'),
    async send(method,params) {
      state.requests.push(method);if(method==='eth_chainId')return '0x'+state.chain.toString(16);
      assert.equal(method,'eth_call');const [tx,tag]=params;
      const name=names.find(name=>lower(addresses[name])===lower(tx.to));
      const artifactName=({factory:'PoolFactory',shareMarket:'ShareMarket'})[name]??aliases[name]??name;
      const iface=new Interface((upgradeNames.includes(artifactName)?bundle:genesisBundle).artifacts[artifactName].abi);
      const decoded=iface.parseTransaction(tx);let value=values[name]?.[decoded.name];
      if(decoded.name==='poolCount'){assert.equal(tag,'0x27');value=state.beforePools;}
      if(decoded.name==='machineRegistryStatus')return iface.encodeFunctionResult(decoded.name,[true,state.ready,0n,state.cutoff]);
      if(decoded.name==='isOperationDone')value=state.done;
      if(decoded.name==='hasRole')value=(decoded.args[0]===hash(1)||decoded.args[0]===hash(2))&&decoded.args[1]===account
        ||decoded.args[0]===hash(3)&&decoded.args[1]===addr(0)||decoded.args[0]===hash(4)&&decoded.args[1]===old.timelock;
      if(state.binding===`${name}.${decoded.name}`)value=typeof value==='boolean'?!value:typeof value==='bigint'?value+1n:addr(999);
      return iface.encodeFunctionResult(decoded.name,[value]);
    }};
  return {provider,state,record,genesisRecord,genesisBundle,bundle,addresses,codes,transactions,receipts,blocks,batch,
    trusted:()=>productGraphConfiguration({record,bundle,genesisRecord,genesisBundle}),block:blocks.get(100)};
}

test('schema2 retains the independently trusted genesis and rejects swapped bundles, extra replacements or altered base',()=>{
  const f=fixture();assert.equal(f.trusted().record.addresses.lens,f.genesisRecord.addresses.lens);
  for(const change of [r=>r.genesisRecordDigest=hash(999),r=>r.artifactDigest=hash(998),r=>r.deployments.ShareMarket=r.deployments.PoolFactory,
    r=>r.deployments.PoolVault.address=f.genesisRecord.addresses.PoolVault,r=>r.operation.predecessor=hash(9)]) {
    const record=structuredClone(f.record);change(record);
    assert.throws(()=>productGraphConfiguration({record,bundle:f.bundle,genesisRecord:f.genesisRecord,genesisBundle:f.genesisBundle}));
  }
  assert.throws(()=>productGraphConfiguration({record:f.record,bundle:f.bundle}),/independently configured/);
  assert.throws(()=>productGraphConfiguration({record:f.record,bundle:f.bundle,genesisRecord:f.genesisRecord,genesisBundle:f.bundle}));
});
test('mixed graph validates four exact new CREATE initcodes and old code for every unchanged runtime',async()=>{
  const f=fixture();await verifyProductGraph(f.provider,f.addresses.factory,f.trusted(),f.block);
  assert(f.state.requests.every(method=>['eth_call','eth_chainId'].includes(method)));
  for(const name of ['AtomicDeployment','ShareMarket','lens','PoolFunds','FlexiblePurchase','PoolVault']) {
    f.state.code=name;await assert.rejects(verifyProductGraph(f.provider,f.addresses.factory,f.trusted(),f.block),/runtime changed/);
  }
});
test('identical artifacts retain source metadata compatibility while exposing only the configured bundle source',()=>{
  const f=fixture();f.record.sourceCommit='c'.repeat(40);
  const trusted=f.trusted();
  assert.equal(trusted.record.sourceCommit,f.bundle.sourceCommit);
  assert.equal(trusted.upgradeRecord.sourceCommit,'c'.repeat(40));
  assert.equal(trusted.record.artifactDigest,buildDigest(f.bundle));
  f.bundle.sourceCommit='invalid';assert.throws(()=>f.trusted(),/source artifact/);
});
test('changing constructor, link target, deployer, CREATE address, value or initcode fails independently of claimed hashes',async()=>{
  for(const mutate of [
    (f,tx)=>tx.data=firstoUpgradeDeploymentData('PoolVault',f.bundle,{...f.addresses,factory:addr(999)}),
    (f,tx)=>tx.data=firstoUpgradeDeploymentData('PoolVault',f.bundle,{...f.addresses,PoolFunds:addr(999)}),
    (_f,tx)=>tx.from=addr(999),(_f,tx)=>tx.nonce++,(_f,tx)=>tx.value=1n,(_f,tx)=>tx.data+='00',
  ]) {const f=fixture(),tx=f.transactions.get(f.record.deployments.PoolVault.txHash);mutate(f,tx);await assert.rejects(verifyFirstoUpgradeProof(f.provider,f.trusted(),f.block));}
});
test('noncanonical, failed, pending, wrong-chain or unfinalized receipts never create upgrade authority',async()=>{
  for(const mutate of [f=>f.receipts.get(f.record.deployments.PoolFactory.txHash).status=0,
    f=>f.blocks.get(22).hash=hash(99),f=>f.transactions.get(f.record.deployments.PoolVault.txHash).blockNumber=null,
    f=>f.state.chain=97n,f=>f.state.finalized=30,f=>f.blocks.get(100).hash=hash(999)]) {
    const f=fixture();mutate(f);await assert.rejects(verifyFirstoUpgradeProof(f.provider,f.trusted(),f.block));
  }
});
test('schedule and execution require exact ordered atomic batch, full delay, zero value and matching events',async()=>{
  for(const mutate of [f=>f.transactions.get(f.record.operation.executeTxHash).data+='00',
    f=>{const iface=new Interface(f.genesisBundle.artifacts.PoolTimelock.abi);f.transactions.get(f.record.operation.executeTxHash).data=iface.encodeFunctionData('executeBatch',
      [f.batch.targets.slice(0,2),[0n,0n],f.batch.payloads.slice(0,2),ZeroHash,f.record.operation.salt]);},
    f=>{const iface=new Interface(f.genesisBundle.artifacts.PoolTimelock.abi);f.transactions.get(f.record.operation.executeTxHash).data=iface.encodeFunctionData('executeBatch',
      [[f.addresses.shareMarket,...f.batch.targets.slice(1)],f.batch.values,f.batch.payloads,ZeroHash,f.record.operation.salt]);},
    f=>f.transactions.get(f.record.operation.executeTxHash).value=1n,
    f=>f.transactions.get(f.record.operation.scheduleTxHash).from=addr(999),
    f=>f.blocks.get(40).timestamp=2000,
    f=>f.receipts.get(f.record.operation.executeTxHash).logs.shift(),
    f=>f.state.done=false]) {
    const f=fixture();mutate(f);await assert.rejects(verifyFirstoUpgradeProof(f.provider,f.trusted(),f.block));
  }
});
test('each deployment, schedule and execution must occupy its matching canonical transaction index',async()=>{
  for(const target of [...FIRSTO_UPGRADE_NAMES,'schedule','execute']) for(const mutate of [
    ({receipt})=>delete receipt.index,({tx})=>delete tx.index,({receipt})=>receipt.index=-1,
    ({receipt})=>receipt.index=0.5,({tx})=>tx.index++,({block})=>delete block.transactions,
    ({block})=>block.transactions=[],({block})=>block.transactions[0]=hash(999),
    ({block,tx,receipt})=>{block.transactions=[hash(999),tx.hash];tx.index=0;receipt.index=0;},
  ]) {
    const f=fixture(),txHash=target==='schedule'?f.record.operation.scheduleTxHash:target==='execute'?f.record.operation.executeTxHash:f.record.deployments[target].txHash;
    const tx=f.transactions.get(txHash),receipt=f.receipts.get(txHash),block=f.blocks.get(receipt.blockNumber);
    mutate({tx,receipt,block});
    await assert.rejects(verifyFirstoUpgradeProof(f.provider,f.trusted(),f.block),/canonical block transaction inclusion/);
  }
});
test('a changing finalized anchor aborts the otherwise valid upgrade proof',async()=>{
  const f=fixture();f.blocks.set(101,{number:101,hash:hash(101),timestamp:174101,transactions:[]});f.state.finalized=101;
  const original=f.provider.getBlock;
  f.provider.getBlock=async number=>number===101?{...f.blocks.get(101),hash:hash(999)}:original(number);
  await assert.rejects(verifyFirstoUpgradeProof(f.provider,f.trusted(),f.block),/Chain changed/);
});
test('failed upgrade RPC drains outstanding evidence reads before rejecting the whole verification',async()=>{
  const f=fixture(),original=f.provider.getTransaction;let finished=false;
  f.provider.getTransaction=async txHash=>{
    if(txHash===f.record.deployments.PurchaseValidation.txHash)throw new Error('injected RPC error');
    if(txHash===f.record.deployments.PoolFactory.txHash) {await new Promise(resolve=>setTimeout(resolve,20));finished=true;}
    return original(txHash);
  };
  await assert.rejects(verifyFirstoUpgradeProof(f.provider,f.trusted(),f.block),/injected RPC/);
  assert.equal(finished,true);
});
test('automatic evidence refuses every nonzero historical pool cutoff and incomplete migration',async()=>{
  for(const change of [{beforePools:1n},{cutoff:1n},{ready:false}]) {
    const f=fixture();Object.assign(f.state,change);await assert.rejects(verifyFirstoUpgradeProof(f.provider,f.trusted(),f.block),/migration|historical pools/);
  }
});
test('mixed graph still verifies implementation slots, immutable factory and unchanged authority roles',async()=>{
  for(const change of [{slot:addr(999)},{binding:'PoolVault.OFFICIAL_FACTORY'},{binding:'beacon.owner'},{binding:'timelock.hasRole'},{binding:'factory.operator'}]) {
    const f=fixture();Object.assign(f.state,change);await assert.rejects(verifyProductGraph(f.provider,f.addresses.factory,f.trusted(),f.block),/changed/);
  }
});
test('read-only exporter preserves genesis history start while binding frontend ABI digest to the upgrade build',async()=>{
  const f=fixture();const result=await generateFirstoUpgradeEvidence(f.provider,{genesisRecord:f.genesisRecord,genesisBundle:f.genesisBundle,
    upgradeBundle:f.bundle,plan:{deployments:f.record.deployments,operation:f.record.operation}});
  assert.equal(result.record.schemaVersion,2);assert.equal(result.manifest.schemaVersion,1);
  assert.equal(result.manifest.deployment.blockNumber,10);assert.equal(result.manifest.verifiedBlockNumber,100);
  assert.equal(result.manifest.artifactDigest,buildDigest(f.bundle));assert.equal(result.manifest.factory,f.genesisRecord.addresses.factory);
  assert.equal(result.manifest.codehash.lens,f.genesisRecord.verification.code.lens.codehash);
  assert.equal(result.manifest.upgrade.operationId,f.batch.operationId);
  assert(f.state.requests.every(method=>['eth_call','eth_chainId'].includes(method)));
});

test('five-node fee upgrade is a distinct fixed kind; old four-node records stay valid',async()=>{
  const old=fixture(),fee=fixture(SHARE_FEE_UPGRADE_KIND);
  await verifyProductGraph(old.provider,old.addresses.factory,old.trusted(),old.block);
  const result=await verifyProductGraph(fee.provider,fee.addresses.factory,fee.trusted(),fee.block);
  assert.equal(result.upgrade.operationId,fee.batch.operationId);
  assert.deepEqual(fee.batch.targets,[fee.addresses.factory,fee.addresses.beacon,fee.addresses.shareMarket,fee.addresses.factory]);
  assert.equal(fee.record.deployments.ShareMarket.address,fee.addresses.ShareMarket);
  assert(fee.state.requests.every(method=>['eth_call','eth_chainId'].includes(method)));
  for(const change of [r=>{delete r.deployments.ShareMarket;},r=>{r.kind=FIRSTO_UPGRADE_KIND;},
    r=>{r.kind='unreviewed-market-upgrade';},r=>{r.deployments.Unreviewed=r.deployments.ShareMarket;}]) {
    const record=structuredClone(fee.record);change(record);
    assert.throws(()=>productGraphConfiguration({record,bundle:fee.bundle,genesisRecord:fee.genesisRecord,genesisBundle:fee.genesisBundle}));
  }
  const wrongOld=structuredClone(old.record);wrongOld.kind=SHARE_FEE_UPGRADE_KIND;
  assert.throws(()=>productGraphConfiguration({record:wrongOld,bundle:old.bundle,genesisRecord:old.genesisRecord,genesisBundle:old.genesisBundle}));
});

test('five-node proof rejects changed Market creation, missing atomic call or wrong upgrade event',async()=>{
  for(const mutate of [
    f=>f.transactions.get(f.record.deployments.ShareMarket.txHash).data+='00',
    f=>f.transactions.get(f.record.deployments.ShareMarket.txHash).nonce++,
    f=>f.receipts.get(f.record.deployments.ShareMarket.txHash).status=0,
    f=>f.transactions.get(f.record.operation.executeTxHash).data=firstoUpgradeBatch(f.addresses,f.record.operation,FIRSTO_UPGRADE_KIND).executeData,
    f=>f.receipts.get(f.record.operation.executeTxHash).logs.splice(3,1),
    f=>{const logs=f.receipts.get(f.record.operation.executeTxHash).logs;
      const market=logs.find(log=>lower(log.address)===lower(f.addresses.shareMarket));
      market.topics[1]=hash(999);},
  ]) {
    const f=fixture(SHARE_FEE_UPGRADE_KIND);mutate(f);
    await assert.rejects(verifyFirstoUpgradeProof(f.provider,f.trusted(),f.block));
  }
});

test('five-node graph pins Market runtime, UUPS slot and both 1% sides',async()=>{
  for(const change of [f=>f.state.code='ShareMarket',f=>f.state.slot=addr(999),
    f=>f.state.binding='shareMarket.buyerFeeBps',f=>f.state.binding='shareMarket.feeBps']) {
    const f=fixture(SHARE_FEE_UPGRADE_KIND);change(f);
    await assert.rejects(verifyProductGraph(f.provider,f.addresses.factory,f.trusted(),f.block),/changed/);
  }
});

test('five-node exporter records the fee kind and preserves the original proxy identity',async()=>{
  const f=fixture(SHARE_FEE_UPGRADE_KIND);
  const result=await generateFirstoUpgradeEvidence(f.provider,{genesisRecord:f.genesisRecord,genesisBundle:f.genesisBundle,
    upgradeBundle:f.bundle,plan:{kind:SHARE_FEE_UPGRADE_KIND,deployments:f.record.deployments,operation:f.record.operation}});
  assert.equal(result.record.kind,SHARE_FEE_UPGRADE_KIND);
  assert.equal(result.manifest.upgrade.kind,SHARE_FEE_UPGRADE_KIND);
  assert.equal(result.manifest.shareMarket,f.genesisRecord.addresses.shareMarket);
  assert.equal(result.manifest.deployment.blockNumber,10);
  assert.equal(result.manifest.verifiedBlockNumber,100);
});
