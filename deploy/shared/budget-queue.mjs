import { ZeroAddress, getAddress, keccak256, toUtf8Bytes } from 'ethers';

const need=(value,message)=>{if(!value)throw new Error(message);};
const same=(a,b)=>typeof a==='string'&&typeof b==='string'&&a.toLowerCase()===b.toLowerCase();
const addr=value=>{const a=getAddress(value);need(a!==ZeroAddress,'Invalid zero address / 地址无效');return a;};
const exact=value=>{
  need(typeof value==='bigint'||typeof value==='string'&&/^(?:0|[1-9]\d*)$/.test(value),'Invalid queue integer');
  const amount=BigInt(value);need(amount>=0n&&amount<2n**256n,'Invalid queue integer');return amount;
};
const key=row=>`${row.collection.toLowerCase()}:${row.tokenId}`;
const roundShares=value=>(exact(value)+99n)/100n*100n;
const failText='项目、钱包或网络已变化，请重新读取 / Project, account or network changed. Reload.';
export const BUDGET_QUEUE_VERSION=1;

export function budgetApprovalDigest(plan){return keccak256(toUtf8Bytes(JSON.stringify({version:plan.version,chainId:plan.chainId,account:plan.account,parent:plan.parent,factory:plan.factory,
  portfolioFactory:plan.portfolioFactory,artifactDigest:plan.artifactDigest,budgetWei:plan.budgetWei,startSpentWei:plan.startSpentWei,
  limitWei:plan.limitWei,absoluteCapWei:plan.absoluteCapWei,unitCapWei:plan.unitCapWei,purchaseDeadline:plan.purchaseDeadline,
  items:plan.items.map(({collection,tokenId,maxCostWei,targetRaiseWei,verifiedWeight,venue,listingId,encodedOrder})=>
    ({collection,tokenId,maxCostWei,targetRaiseWei,verifiedWeight,venue,listingId,encodedOrder}))})));}

export function validateBudgetQueue(plan,{config,account,parent}={}){
  need(plan?.version===BUDGET_QUEUE_VERSION&&plan.chainId===56&&/^0x[\da-f]{64}$/i.test(plan.artifactDigest??''),failText);
  [plan.account,plan.parent,plan.factory,plan.portfolioFactory].forEach(addr);
  if(config)need(config.kind==='integrated-v2'&&same(plan.factory,config.factory)&&same(plan.portfolioFactory,config.portfolioFactory)
    &&same(plan.artifactDigest,config.artifactDigest??config.manifest?.artifactDigest),failText);
  if(account)need(same(plan.account,account),failText);if(parent)need(same(plan.parent,parent),failText);
  need(Array.isArray(plan.items)&&plan.items.length>0&&plan.items.length<=20&&Number.isSafeInteger(plan.revision)&&plan.revision>=0,'Invalid purchase queue');
  need(exact(plan.limitWei)>0n&&exact(plan.startSpentWei)+exact(plan.limitWei)<=exact(plan.budgetWei),'Queue exceeds project budget');
  const seen=new Set();let total=0n;
  for(const item of plan.items){
    addr(item.collection);need(!seen.has(key(item)),'Duplicate NFT in purchase queue');seen.add(key(item));
    const cost=exact(item.maxCostWei),weight=exact(item.verifiedWeight),cap=exact(plan.absoluteCapWei)<exact(plan.unitCapWei)*weight?exact(plan.absoluteCapWei):exact(plan.unitCapWei)*weight;
    need(weight>0n&&cost>0n&&cost<=cap&&exact(item.targetRaiseWei)===roundShares(cost),'Candidate exceeds approved cap');
    need(['official','firsto'].includes(item.venue)&&['ready','creating','created','buying','pending','completed','failed','skipped'].includes(item.status),'Invalid queue state');
    if(item.child)addr(item.child);
    if(item.hash)need(/^0x[\da-f]{64}$/i.test(item.hash),'Invalid queue transaction hash');
    total+=cost;
  }
  need(total<=exact(plan.limitWei),'Queue candidates exceed approved budget');
  need(plan.approvalDigest===budgetApprovalDigest(plan),'Purchase approval changed; preview again');
  return plan;
}
