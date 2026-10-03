import test from 'node:test';
import assert from 'node:assert/strict';
import {Interface,ZeroAddress} from 'ethers';
import {verifyPortfolioIntent,PRODUCT_PORTFOLIO_ABI} from './portfolio-intent.mjs';
const address=n=>`0x${n.toString(16).padStart(40,'0')}`;
const factory=address(1),legacy=address(2),portfolio=address(3),child=address(4),account=address(5);
const abi=new Interface(['function operator() view returns(address)','function legacyFactory() view returns(address)',
  'function isPool(address) view returns(bool)','function OFFICIAL_FACTORY() view returns(address)',
  'function factory() view returns(address)','function budgetWei() view returns(uint256)',
  'function childInfo(address) view returns(address collection,uint256 tokenId,uint256 purchaseCost,bool official,bool sold)']);
function fixture(name='deposit',args=[2]) {
  const state={registered:true,operator:account,childOwned:false,budget:1000n};
  const provider={getCode:async()=> '0x6000',send:async(method,[tx,tag])=>{
    assert.equal(method,'eth_call');assert.equal(tag,'0x64');const call=abi.parseTransaction(tx);
    const value={operator:state.operator,legacyFactory:legacy,isPool:state.registered,OFFICIAL_FACTORY:tx.to===child?legacy:factory,factory:legacy,budgetWei:state.budget}[call.name];
    return abi.encodeFunctionResult(call.name,call.name==='childInfo'?[state.childOwned?address(6):ZeroAddress,1n,100n,true,false]:[value]);
  }};
  const decoded=PRODUCT_PORTFOLIO_ABI.parseTransaction({data:PRODUCT_PORTFOLIO_ABI.encodeFunctionData(name,args)});
  return {state,provider,record:{factory,target:portfolio,account,targetType:'portfolio',value:name==='deposit'?'20':'0'},decoded,
    block:{number:100},graph:{productKind:'budget',factory,legacyFactory:legacy}};
}
const run=f=>verifyPortfolioIntent(f.provider,f.record,f.decoded,f.block,f.graph,(_code,message)=>{throw Error(message);});
test('portfolio deposit and child operations require reviewed parent and child graph',async()=>{
  const f=fixture();await run(f);f.record.value='21';await assert.rejects(run(f),/share price/);
  f.record.value='20';f.graph.productKind='pool';await assert.rejects(run(f),/integrated/);
  const p=fixture('buyOfficial',[child,1]);await run(p);p.state.childOwned=true;await assert.rejects(run(p),/already held/);
  p.state.childOwned=false;p.state.operator=address(9);await assert.rejects(run(p),/Only the portfolio operator/);
  const c=fixture('collectChildBem',[child]);await assert.rejects(run(c),/not held/);c.state.childOwned=true;await run(c);
  c.state.registered=false;await assert.rejects(run(c),/registered/);
});
test('portfolio transfer refuses burns and fractional/out-of-bound amounts before simulation',async()=>{
  await run(fixture('transfer',[address(9),1]));
  for(const args of [[ZeroAddress,1],[address(9),0],[address(9),101]])await assert.rejects(run(fixture('transfer',args)),/recipient/);
});
