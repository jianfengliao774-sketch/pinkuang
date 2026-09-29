import test from 'node:test';
import assert from 'node:assert/strict';
import { Interface, ZeroAddress, getAddress } from 'ethers';
import { readBudgetCandidates } from './budget-candidates.mjs';
const address=n=>getAddress(`0x${n.toString(16).padStart(40,'0')}`),H=`0x${'a'.repeat(64)}`,D=`0x${'d'.repeat(64)}`;
const parent=address(1),factory=address(2),legacy=address(3),collection=address(4),reserved=address(5);
const views=new Interface(['function isPool(address) view returns(bool)','function OFFICIAL_FACTORY() view returns(address)',
  'function legacyFactory() view returns(address)','function state() view returns(uint8)','function budgetWei() view returns(uint256)',
  'function spentWei() view returns(uint256)','function absoluteCapWei() view returns(uint256)','function unitCapWei() view returns(uint256)',
  'function purchaseDeadline() view returns(uint64)','function machinePool(address,uint256) view returns(address)']);
function fixture(){
  const state={isPool:true,OFFICIAL_FACTORY:factory,legacyFactory:legacy,state:1n,budgetWei:250n,spentWei:0n,absoluteCapWei:220n,
    unitCapWei:10n,purchaseDeadline:2000n,hash:H,scans:0};
  const block={number:10,hash:H,timestamp:1000};
  const graph={productKind:'budget',factory,legacyFactory:legacy,artifactDigest:D};
  const provider={getBlock:async number=>{assert.equal(number,10);return {...block,hash:state.hash};},send:async(method,[tx,tag])=>{
    assert.equal(method,'eth_call');assert.equal(tag,'0xa');const parsed=views.parseTransaction(tx);
    if(parsed.name==='machinePool'){assert.equal(tx.to,legacy);return views.encodeFunctionResult(parsed.name,[parsed.args[1]===2n?reserved:ZeroAddress]);}
    assert.equal(tx.to,parsed.name==='isPool'?factory:parent);return views.encodeFunctionResult(parsed.name,[state[parsed.name]]);
  }};
  const discover=async options=>{
    state.scans++;assert.equal(options.blockNumber,10);assert.equal(options.absoluteCapWei,220n);assert.equal(options.unitCapWei,10n);
    return {snapshot:{complete:true,blockNumber:10,blockHash:H},candidates:[1,2,3].map(n=>({collection,tokenId:String(n),costWei:n===3?'201':'101',verifiedWeight:'100'}))};
  };
  const reservationReader={call:async(to,iface,name,args)=>iface.decodeFunctionResult(name,await provider.send('eth_call',[{to,data:iface.encodeFunctionData(name,args)},'0xa']))};
  return {state,options:{provider,parent,factory,graph,block,discover,reservationReader}};
}
test('budget official discovery verifies one pinned parent and excludes permanent reservations and rounded-deposit overflow',async()=>{
  const f=fixture(),result=await readBudgetCandidates(f.options);
  assert.equal(result.complete,true);assert.equal(result.remainingWei,'250');assert.equal(result.factory,factory);assert.equal(result.legacyFactory,legacy);
  assert.deepEqual(result.candidates.map(row=>row.tokenId),['1']);assert.equal(f.state.scans,1);
});
test('unknown graph, parent binding, inactive state and deadline reject before external market discovery',async()=>{
  for(const changed of [{isPool:false},{OFFICIAL_FACTORY:legacy},{legacyFactory:factory},{state:2n},{spentWei:250n},{purchaseDeadline:1000n}]){
    const f=fixture();Object.assign(f.state,changed);await assert.rejects(readBudgetCandidates(f.options));assert.equal(f.state.scans,0);
  }
  const f=fixture();f.options.graph.productKind='core';await assert.rejects(readBudgetCandidates(f.options),/graph/);assert.equal(f.state.scans,0);
});
test('incomplete official coverage, cancellation and reorg never authorize Firsto fallback',async()=>{
  const f=fixture();await assert.rejects(readBudgetCandidates({...f.options,discover:async()=>({snapshot:{complete:false}})}),/incomplete/);
  const abort=new AbortController();abort.abort();await assert.rejects(readBudgetCandidates({...f.options,signal:abort.signal}),/aborted/);
  f.state.hash=D;await assert.rejects(readBudgetCandidates(f.options),/block changed/);
});
