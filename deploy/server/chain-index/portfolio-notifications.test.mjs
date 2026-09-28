import test from 'node:test';
import assert from 'node:assert/strict';
import {Interface,ZeroAddress} from 'ethers';
import {portfolioNotification} from './portfolio-notifications.mjs';
const addr=n=>`0x${n.toString(16).padStart(40,'0')}`,hash=n=>`0x${n.toString(16).padStart(64,'0')}`;
const parent=addr(1),child=addr(2),alice=addr(3);
const abi=new Interface(['function nextProposalId() view returns(uint256)','function activeProposalId() view returns(uint256)',
  'function memberCount() view returns(uint16)','function balanceOf(address) view returns(uint256)','function hasVoted(uint256,address) view returns(bool)',
  'function childInfo(address) view returns(address collection,uint256 tokenId,uint256 purchaseCost,bool official,bool sold)',
  'function proposals(uint256) view returns(address child,uint256 price,uint256 referencePrice,uint64 referenceAt,uint64 endsAt,uint16 memberCount,uint16 yesMembers,uint16 yesShares,bool executed)']);
function fixture(){
  const state={balance:100n,voted:true,reorg:false,archiveUnavailable:false};
  const make=(name,args,blockNumber)=>({name,args:JSON.stringify(args),blockNumber,logIndex:0,txHash:hash(blockNumber),timestamp:blockNumber});
  const rows=[make('Transfer',{from:ZeroAddress,to:alice,value:'100'},1),make('ChildPurchased',{child,collection:addr(4),tokenId:'7',cost:'500'},2),
    make('ChildSaleProposed',{proposalId:'1',child,price:'600',endsAt:86403},3),make('ChildSaleVoted',{proposalId:'1',member:alice,support:true,shares:'100'},4)];
  const index={db:{prepare:()=>({all:()=>rows})},_header:n=>({hash:hash(n)}),provider:{getBlock:async n=>({hash:hash(state.reorg?99:n)}),
    call:async({to,data,blockTag})=>{
      assert.equal(to,parent);const parsed=abi.parseTransaction({data});
      if(['balanceOf','memberCount'].includes(parsed.name)){assert.equal(blockTag,3);if(state.archiveUnavailable)throw Error('Archive unavailable');}
      else assert.equal(blockTag,6);
      return abi.encodeFunctionResult(parsed.name,parsed.name==='childInfo'?[addr(4),7,500,true,false]:parsed.name==='proposals'?[child,600,600,1,86403,1,1,100,false]
        :[({nextProposalId:2n,activeProposalId:1n,memberCount:1n,balanceOf:state.balance,hasVoted:state.voted})[parsed.name]]);
    }}};
  return {state,index,rows,source:{indexedThrough:6,indexedTimestamp:6}};
}
test('budget notifications address parent holders and independently verify proposal-block balances',async()=>{
  const f=fixture();const result=await portfolioNotification(f.index,{address:parent},f.source,Date.now()+10000);
  assert.equal(result.kind,'portfolio');assert.equal(result.verified,true);assert.equal(result.proposals[0].circuitId,'7');
  assert.deepEqual(result.proposals[0].owners,[{account:alice,shares:'100'}]);assert.equal(result.proposals[0].passed,true);
});
test('an unexecuted round past its deadline may transfer while prior snapshot notification keeps original owners',async()=>{
  const f=fixture();f.source.indexedTimestamp=86405;
  f.rows.push({name:'Transfer',args:JSON.stringify({from:alice,to:addr(8),value:'50'}),blockNumber:5,logIndex:0,txHash:hash(5),timestamp:86404});
  const result=await portfolioNotification(f.index,{address:parent},f.source,Date.now()+10000);
  assert.equal(result.proposals[0].open,false);assert.deepEqual(result.proposals[0].owners,[{account:alice,shares:'100'}]);
});
test('missing archive data, wrong historical balance, missed votes and changed proposal blocks suppress notification',async()=>{
  for(const change of [{balance:99n},{voted:false},{reorg:true},{archiveUnavailable:true}]){
    const f=fixture();Object.assign(f.state,change);await assert.rejects(portfolioNotification(f.index,{address:parent},f.source,Date.now()+10000));
  }
});
