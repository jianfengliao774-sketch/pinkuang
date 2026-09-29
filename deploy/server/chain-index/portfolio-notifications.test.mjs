import test from 'node:test';
import assert from 'node:assert/strict';
import {Interface,ZeroAddress} from 'ethers';
import {portfolioNotification} from './portfolio-notifications.mjs';
const addr=n=>`0x${n.toString(16).padStart(40,'0')}`,hash=n=>`0x${n.toString(16).padStart(64,'0')}`;
const parent=addr(1),child=addr(2),alice=addr(3),bob=addr(5),carol=addr(6);
const abi=new Interface(['function nextProposalId() view returns(uint256)','function activeProposalId() view returns(uint256)',
  'function memberCount() view returns(uint16)','function balanceOf(address) view returns(uint256)','function hasVoted(uint256,address) view returns(bool)',
  'function childInfo(address) view returns(address collection,uint256 tokenId,uint256 purchaseCost,bool official,bool sold)',
  'function proposals(uint256) view returns(address child,uint256 price,uint256 referencePrice,uint64 referenceAt,uint64 endsAt,uint16 memberCount,uint16 yesMembers,uint16 yesShares,bool executed)',
  'function expiresAt() view returns(uint64)']);
function fixture({discounted=false}={}){
  const state={balance:100n,voted:true,reorg:false,archiveUnavailable:false};
  const make=(name,args,blockNumber)=>({name,args:JSON.stringify(args),blockNumber,logIndex:0,txHash:hash(blockNumber),timestamp:blockNumber});
  const price=discounted?'400':'600';
  const rows=discounted
    ?[make('Transfer',{from:ZeroAddress,to:alice,value:'49'},1),make('Transfer',{from:ZeroAddress,to:bob,value:'49'},1),
      make('Transfer',{from:ZeroAddress,to:carol,value:'2'},1),make('ChildPurchased',{child,collection:addr(4),tokenId:'7',cost:'500'},2),
      make('ChildSaleProposed',{proposalId:'1',child,price,endsAt:86403},3),
      make('ChildSaleVoted',{proposalId:'1',member:alice,support:true,shares:'49'},4),
      make('ChildSaleVoted',{proposalId:'1',member:carol,support:true,shares:'2'},5)]
    :[make('Transfer',{from:ZeroAddress,to:alice,value:'100'},1),make('ChildPurchased',{child,collection:addr(4),tokenId:'7',cost:'500'},2),
      make('ChildSaleProposed',{proposalId:'1',child,price,endsAt:86403},3),make('ChildSaleVoted',{proposalId:'1',member:alice,support:true,shares:'100'},4)];
  const index={db:{prepare:()=>({all:()=>rows})},_header:n=>({hash:hash(n)}),provider:{getBlock:async n=>({hash:hash(state.reorg?99:n)}),
    call:async({to,data,blockTag})=>{
      assert.equal(to,parent);const parsed=abi.parseTransaction({data});
      if(['balanceOf','memberCount'].includes(parsed.name)){assert.equal(blockTag,3);if(state.archiveUnavailable)throw Error('Archive unavailable');}
      else assert.equal(blockTag,6);
      const owner=['hasVoted','balanceOf'].includes(parsed.name)
        ?String(parsed.args[parsed.name==='hasVoted'?1:0]).toLowerCase():null;
      const historicalBalance=discounted?({[alice]:49n,[bob]:49n,[carol]:2n})[owner]:state.balance;
      const voted=discounted?owner!==bob:state.voted;
      return abi.encodeFunctionResult(parsed.name,parsed.name==='childInfo'?[addr(4),7,500,true,false]
        :parsed.name==='proposals'?[child,price,600,1,86403,discounted?3:1,discounted?2:1,discounted?51:100,false]
        :[({nextProposalId:2n,activeProposalId:1n,memberCount:discounted?3n:1n,balanceOf:historicalBalance,hasVoted:voted})[parsed.name]]);
    }}};
  return {state,index,rows,source:{indexedThrough:6,indexedTimestamp:6}};
}
function competingFixture({expireWithoutExecution=false}={}){
  const otherChild=addr(9);
  const state={nextRound:false,activeReads:[]};
  const make=(name,args,blockNumber,timestamp=blockNumber)=>({name,args:JSON.stringify(args),blockNumber,logIndex:0,txHash:hash(blockNumber),timestamp});
  const rows=[make('Transfer',{from:ZeroAddress,to:alice,value:'100'},1),
    make('ChildPurchased',{child,collection:addr(4),tokenId:'7',cost:'500'},2),
    make('ChildPurchased',{child:otherChild,collection:addr(4),tokenId:'8',cost:'500'},2),
    make('ChildSaleProposed',{proposalId:'1',child,price:'600',endsAt:86403},3),
    make('ChildSaleProposed',{proposalId:'2',child:otherChild,price:'700',endsAt:86403},4)];
  if(expireWithoutExecution)rows.push(make('ChildSaleExpired',{proposalId:'1'},5,604804));
  else rows.push(make('ChildSaleVoted',{proposalId:'2',member:alice,support:true,shares:'100'},5),
    make('ChildSaleApproved',{proposalId:'2',child:otherChild},6));
  const nextEvent=make('ChildSaleProposed',{proposalId:'3',child,price:'650',endsAt:691205},6,604805);
  const source={indexedThrough:expireWithoutExecution?5:7,indexedTimestamp:expireWithoutExecution?604804:7};
  const index={db:{prepare:()=>({all:()=>rows})},_header:n=>({hash:hash(n)}),provider:{
    getBlock:async n=>({hash:hash(n)}),
    call:async({to,data,blockTag})=>{
      const parsed=abi.parseTransaction({data});
      const proposalId=['proposals','hasVoted'].includes(parsed.name)?String(parsed.args[0]):null;
      if(parsed.name==='expiresAt'){
        assert.equal(expireWithoutExecution,false);
        assert.equal(to,otherChild);assert.equal(blockTag,6);
        return abi.encodeFunctionResult('expiresAt',[604806]);
      }
      assert.equal(to,parent);
      if(['memberCount','balanceOf'].includes(parsed.name))assert([3,4,6].includes(blockTag));
      else assert.equal(blockTag,source.indexedThrough);
      if(parsed.name==='activeProposalId')state.activeReads.push(blockTag);
      const value=parsed.name==='childInfo'
        ?[addr(4),String(parsed.args[0]).toLowerCase()===otherChild?8:7,500,true,false]
        :parsed.name==='proposals'
          ?[proposalId==='2'?otherChild:child,proposalId==='3'?650:proposalId==='2'?700:600,600,1,
            proposalId==='3'?691205:86403,1,
            !expireWithoutExecution && proposalId==='2'?1:0,!expireWithoutExecution && proposalId==='2'?100:0,
            !expireWithoutExecution && proposalId==='2']
          :[({nextProposalId:expireWithoutExecution?(state.nextRound?4n:3n):3n,
            activeProposalId:expireWithoutExecution?(state.nextRound?3n:0n):2n,memberCount:1n,balanceOf:100n,
            hasVoted:!expireWithoutExecution && proposalId==='2'})[parsed.name]];
      return abi.encodeFunctionResult(parsed.name,value);
    },
  }};
  return {rows,index,source,otherChild,state,nextEvent};
}
test('budget notifications address parent holders and independently verify proposal-block balances',async()=>{
  const f=fixture();const result=await portfolioNotification(f.index,{address:parent},f.source,Date.now()+10000);
  assert.equal(result.kind,'portfolio');assert.equal(result.verified,true);assert.equal(result.proposals[0].circuitId,'7');
  assert.deepEqual(result.proposals[0].owners,[{account:alice,shares:'100'}]);assert.equal(result.proposals[0].passed,true);
});
test('discounted budget sale follows dual majority of members and shares',async()=>{
  const f=fixture({discounted:true});const result=await portfolioNotification(f.index,{address:parent},f.source,Date.now()+10000);
  const proposal=result.proposals[0];
  assert.equal(proposal.requiredYesCount,2);assert.equal(proposal.requiredYesShares,51);
  assert.equal(proposal.yesCount,2);assert.equal(proposal.yesShares,'51');assert.equal(proposal.passed,true);
  assert.equal(proposal.executed,false);
});
test('same-round candidates vote independently and a non-opening candidate can execute',async()=>{
  const f=competingFixture();const result=await portfolioNotification(f.index,{address:parent},f.source,Date.now()+10000);
  assert.equal(result.verified,true);assert.equal(result.proposals.length,2);
  const [opening,selected]=result.proposals;
  assert.equal(opening.roundId,'1');assert.equal(selected.roundId,'1');
  assert.equal(opening.yesShares,'0');assert.equal(opening.executed,false);
  assert.equal(selected.yesShares,'100');assert.equal(selected.executed,true);
  assert.equal(selected.listing.expiresAt,604806);
  assert.equal(opening.roundExecuted,true);assert.equal(selected.roundExecuted,true);
  assert.equal(opening.open,false);assert.equal(selected.open,false);
});
test('same-round candidate deadline mismatch or omitted vote suppresses notifications',async()=>{
  const wrongDeadline=competingFixture();
  wrongDeadline.rows[4].args=JSON.stringify({...JSON.parse(wrongDeadline.rows[4].args),endsAt:86404});
  await assert.rejects(portfolioNotification(wrongDeadline.index,{address:parent},wrongDeadline.source,Date.now()+10000));
  const missingVote=competingFixture();missingVote.rows.splice(5,1);
  await assert.rejects(portfolioNotification(missingVote.index,{address:parent},missingVote.source,Date.now()+10000));
});
test('expired unexecuted round closes both candidates before a new opener can be notified',async()=>{
  const f=competingFixture({expireWithoutExecution:true});
  const expired=await portfolioNotification(f.index,{address:parent},f.source,Date.now()+10000);
  assert.equal(expired.proposals.length,2);
  assert.equal(expired.proposals[0].expired?.blockNumber,5);
  assert(expired.proposals.every(proposal=>proposal.open===false && proposal.roundExecuted===false));
  assert.deepEqual(f.state.activeReads,[5]);

  f.rows.push(f.nextEvent);f.state.nextRound=true;f.source.indexedThrough=7;f.source.indexedTimestamp=604806;
  const renewed=await portfolioNotification(f.index,{address:parent},f.source,Date.now()+10000);
  assert.equal(renewed.proposals.length,3);
  assert(renewed.proposals.slice(0,2).every(proposal=>proposal.open===false && proposal.roundExecuted===false));
  assert.equal(renewed.proposals[2].roundId,'3');assert.equal(renewed.proposals[2].open,true);
  assert.equal(renewed.proposals[2].roundExecuted,false);
  assert.deepEqual(f.state.activeReads,[5,7]);
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
