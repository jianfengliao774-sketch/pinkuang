import {Interface,ZeroAddress} from 'ethers';

const abi=new Interface([
  'function nextProposalId() view returns(uint256)', 'function activeProposalId() view returns(uint256)',
  'function memberCount() view returns(uint16)','function balanceOf(address) view returns(uint256)',
  'function hasVoted(uint256,address) view returns(bool)',
  'function proposals(uint256) view returns(address child,uint256 price,uint256 referencePrice,uint64 referenceAt,uint64 endsAt,uint16 memberCount,uint16 yesMembers,uint16 yesShares,bool executed)',
  'function childInfo(address) view returns(address collection,uint256 tokenId,uint256 purchaseCost,bool official,bool sold)',
  'function expiresAt() view returns(uint64)',
]);
const check=condition=>{if(!condition)throw Error('Budget notification history cannot be independently verified.');};
const lower=value=>String(value).toLowerCase();
const zero=ZeroAddress.toLowerCase();
const identity=event=>`${event.txHash}:${event.logIndex}`;

/** Parent members, never the child pool's sole wrapper holder, receive votes.
 * Proposal-block balances are independently read: unsupported archive RPC or
 * a same-block post-sale transfer suppresses the page instead of guessing. */
export async function portfolioNotification(index,portfolio,source,deadline) {
  const rows=index.db.prepare(`SELECT l.block_number AS blockNumber,l.log_index AS logIndex,l.tx_hash AS txHash,
    l.name,l.args,h.timestamp FROM logs l JOIN headers h ON h.number=l.block_number
    WHERE l.kind='portfolio' AND l.address=? ORDER BY l.block_number,l.tx_index,l.log_index LIMIT 50001`).all(portfolio.address);
  check(rows.length<=50000);
  const balances=new Map(),children=new Map(),proposals=new Map();let active=null;
  for(const row of rows) {
    const event={...row,args:JSON.parse(row.args)},a=event.args;
    if(event.name==='Transfer') {
      const from=lower(a.from),to=lower(a.to),amount=BigInt(a.value);
      if(from!==zero){check((balances.get(from)??0n)>=amount);balances.set(from,(balances.get(from)??0n)-amount);}
      if(to!==zero)balances.set(to,(balances.get(to)??0n)+amount);
      check(!(active && (active.executed || row.timestamp<active.endsAt) && from!==zero && to!==zero && amount>0n));
    } else if(event.name==='ChildPurchased') children.set(lower(a.child),{collection:lower(a.collection),tokenId:String(a.tokenId),cost:BigInt(a.cost)});
    else if(event.name==='ChildSaleProposed') {
      const child=children.get(lower(a.child)),proposalId=String(a.proposalId);
      const sameRound=active!==null,endsAt=Number(a.endsAt);
      check(child && !proposals.has(proposalId) && Number.isSafeInteger(endsAt)
        && (!sameRound || (!active.executed && row.timestamp<active.endsAt && endsAt===active.endsAt
          && [...proposals.values()].filter(proposal=>proposal.roundId===active.roundId).length<16)));
      const owners=[...balances].filter(([,v])=>v>0n).map(([account,shares])=>({account,shares:String(shares)}));
      check(owners.length<=100 && owners.reduce((n,v)=>n+BigInt(v.shares),0n)===100n);
      if(sameRound){
        const opening=proposals.get(active.roundId);
        check(opening && owners.length===opening.owners.length
          && owners.every((owner,i)=>owner.account===opening.owners[i].account && owner.shares===opening.owners[i].shares));
      }
      const proposal={proposalId,roundId:sameRound?active.roundId:proposalId,child:lower(a.child),circuitId:child.tokenId,
        collection:child.collection,priceWei:String(a.price),purchaseCostWei:String(child.cost),endsAt,
        createdAt:row.timestamp,createdBlock:row.blockNumber,
        eventId:identity(event),owners,votes:[],yesCount:0,yesShares:'0',executed:false,listing:null,completed:null,expired:null};
      if(!sameRound)active=proposal;
      proposals.set(proposalId,proposal);
    } else if(event.name==='ChildSaleVoted') {
      const proposal=proposals.get(String(a.proposalId)),member=lower(a.member);
      check(active && proposal?.roundId===active.roundId && !active.executed && !proposal.executed
        && proposal.endsAt>row.timestamp
        && proposal.owners.some(owner=>owner.account===member && owner.shares===String(a.shares))
        && !proposal.votes.some(vote=>vote.account===member));
      proposal.votes.push({account:member,support:Boolean(a.support),shares:String(a.shares)});
      if(a.support){proposal.yesCount++;proposal.yesShares=String(BigInt(proposal.yesShares)+BigInt(a.shares));}
    } else if(event.name==='ChildSaleApproved') {
      const proposal=proposals.get(String(a.proposalId));
      check(active && proposal?.roundId===active.roundId && !active.executed && !proposal.executed
        && proposal.child===lower(a.child) && proposal.endsAt>row.timestamp);
      proposal.executed=true;proposal.listing={eventId:identity(event),timestamp:row.timestamp,blockNumber:row.blockNumber,expiresAt:null};
      active=proposal;
    } else if(event.name==='ChildSaleSettled') {
      check(active?.executed && active.child===lower(a.child));
      active.completed={eventId:identity(event),timestamp:row.timestamp,blockNumber:row.blockNumber,grossWei:active.priceWei,toMembersWei:String(a.netProceeds)};
      active=null;
    } else if(event.name==='ChildSaleExpired') {
      check(active?.proposalId===String(a.proposalId));
      active.expired={eventId:identity(event),timestamp:row.timestamp,blockNumber:row.blockNumber};active=null;
    }
  }
  const call=async(to,name,args=[],block=source.indexedThrough)=>{
    check(Date.now()<deadline);
    const raw=await index.provider.call({to,data:abi.encodeFunctionData(name,args),blockTag:block});
    const result=abi.decodeFunctionResult(name,raw);return result.length===1?result[0]:result;
  };
  check(BigInt(await call(portfolio.address,'nextProposalId'))===BigInt(proposals.size)+1n);
  check(String(await call(portfolio.address,'activeProposalId'))===(active?.proposalId??'0'));
  const recent=[...proposals.values()].filter(p=>p.endsAt>=source.indexedTimestamp-10*86400);check(recent.length<=200);
  for(const proposal of recent) {
    const current=await call(portfolio.address,'proposals',[proposal.proposalId]);
    const miner=await call(portfolio.address,'childInfo',[proposal.child]);
    check(lower(miner.collection)===proposal.collection && String(miner.tokenId)===proposal.circuitId
      && String(miner.purchaseCost)===proposal.purchaseCostWei);
    check(lower(current.child)===proposal.child && String(current.price)===proposal.priceWei && Number(current.endsAt)===proposal.endsAt
      && Number(current.memberCount)===proposal.owners.length && Number(current.yesMembers)===proposal.yesCount
      && String(current.yesShares)===proposal.yesShares && current.executed===proposal.executed);
    check(Number(await call(portfolio.address,'memberCount',[],proposal.createdBlock))===proposal.owners.length);
    const anchor=index._header(proposal.createdBlock);check(anchor && lower((await index.provider.getBlock(proposal.createdBlock))?.hash)===anchor.hash);
    for(let start=0;start<proposal.owners.length;start+=8) {
      const results=await Promise.allSettled(proposal.owners.slice(start,start+8).map(async owner=>{
        check(String(await call(portfolio.address,'balanceOf',[owner.account],proposal.createdBlock))===owner.shares);
        check(await call(portfolio.address,'hasVoted',[proposal.proposalId,owner.account])===proposal.votes.some(v=>v.account===owner.account));
      }));
      check(results.every(result=>result.status==='fulfilled'));
    }
    if(proposal.listing)proposal.listing.expiresAt=Number(await call(proposal.child,'expiresAt',[],proposal.listing.blockNumber));
    proposal.requiredYesCount=Math.floor(proposal.owners.length/2)+1;
    proposal.requiredYesShares=51;
    proposal.passed=proposal.yesCount>=proposal.requiredYesCount && BigInt(proposal.yesShares)>=BigInt(proposal.requiredYesShares);
    check(!proposal.executed || proposal.passed);
    proposal.roundExecuted=[...proposals.values()].some(candidate=>candidate.roundId===proposal.roundId && candidate.executed);
    proposal.open=active?.roundId===proposal.roundId && !proposal.roundExecuted && proposal.endsAt>source.indexedTimestamp;
  }
  return {...portfolio,kind:'portfolio',verified:true,circuitId:null,proposals:recent};
}
