import { saleReferenceMessages as messages } from './sale-reference-status-read.mjs';
export { readSaleReferencePublisherStatus } from './sale-reference-status-read.mjs';
/** Only publish a Firsto price; never execute a sale, approve one or move treasury funds. */
import { writeFileSync, renameSync, chmodSync, lstatSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import { Contract, Interface, getAddress, keccak256, parseEther, parseUnits } from 'ethers';
import { readFirstoSaleReference, fetchFirstoReferenceRaw } from '../shared/firsto-sale-reference.mjs';
import { acquireKeeperLock, acquireWalletLock, readJournal, writeJournal, reconcilePending } from '../scripts/purchase-keeper.mjs';

const marketAbi = new Interface([
  'function automaticSaleReferenceVersion() pure returns(uint256)', 'function saleReferencePublisher() view returns(address)',
  'function saleReference(address) view returns(uint128 marketPriceWei,uint64 observedAt,bytes32 sourceDigest)',
  'function publishSaleReference(address pool,uint128 priceWei,uint64 observedAt,bytes32 digest)',
]);
const poolAbi = ['function state() view returns(uint8)', 'function activeProposalId() view returns(uint256)',
  'function nextProposalId() view returns(uint256)', 'function salePrice() view returns(uint256)', 'function proposalPassed(uint256) view returns(bool)',
  'function getProposal(uint256) view returns(tuple(address proposer,uint48 snapshotTs,uint64 endsAt,uint64 refAt,uint256 price,uint256 refPrice,uint256 snapshotMemberCount,uint256 snapshotTotalShares,uint256 yesCount,uint256 yesShares,bool executed))',
  'function params() view returns(tuple(address circuits,uint256 circuitId,uint256 targetRaise,uint256 priceCap,address directSeller,uint256 directPrice,uint64 fundingDeadline,uint64 purchaseDeadline))'];
const budgetAbi=['function state() view returns(uint8)','function legacyFactory() view returns(address)',
  'function activeProposalId() view returns(uint256)','function nextProposalId() view returns(uint256)',
  'function proposals(uint256) view returns(address child,uint256 price,uint256 referencePrice,uint64 referenceAt,uint64 endsAt,uint16 memberCount,uint16 yesMembers,uint16 yesShares,bool executed)',
  'function childInfo(address) view returns(address collection,uint256 tokenId,uint256 purchaseCost,bool official,bool sold)'];
const same = (a,b) => getAddress(a) === getAddress(b);

const terminal = tx => tx && ['confirmed','reverted','cancelled','cancel-reverted'].includes(tx.phase);
const busyError = error => error.message === 'Wallet has an unresolved transaction in another pool journal. Reconcile that journal first.'
  || /^Keeper lock already exists: .+\. Another process holds it\.$/.test(error.message ?? '');
const json = value => JSON.stringify(value, (_key,item) => typeof item === 'bigint' ? item.toString() : item);

export function saleReferencePublisherConfiguration(env, authorityConfig) {
  if (env.SALE_REFERENCE_PUBLISHER_ENABLED !== '1') return null;
  const journal=env.SALE_REFERENCE_PUBLISHER_JOURNAL,statusPath=env.SALE_REFERENCE_STATUS_PATH;
  if (!isAbsolute(journal ?? '') || dirname(journal)!==dirname(authorityConfig.journal) || journal===authorityConfig.journal
    || !isAbsolute(statusPath ?? '') || statusPath===journal) throw new Error('Reference publisher requires isolated journal and status paths.');
  const baseUrl=env.SALE_REFERENCE_FIRSTO_API || 'https://api-tapeout.firsto.ai',url=new URL(baseUrl);
  if (url.protocol!=='https:' || url.username || url.password || url.search || url.hash)
    throw new Error('Reference publisher requires an exact HTTPS Firsto proxy base.');
  const maxGasWei=parseEther(env.SALE_REFERENCE_MAX_GAS_BNB ?? '0.001'),hourlyGasWei=parseEther(env.SALE_REFERENCE_HOURLY_GAS_BNB ?? '0.01');
  const maxGasPrice=parseUnits(env.SALE_REFERENCE_MAX_GAS_PRICE_GWEI ?? '1','gwei');
  if (maxGasWei<=0n || maxGasWei>parseEther('0.01') || hourlyGasWei<maxGasWei || hourlyGasWei>parseEther('0.1')
    || maxGasPrice<=0n || maxGasPrice>parseUnits('3','gwei')) throw new Error('Reference publisher Gas bounds are invalid.');
  return {journal,statusPath,baseUrl:baseUrl.replace(/\/$/,''),maxGasWei,hourlyGasWei,maxGasPrice,
    gasLimit:200_000n,minIntervalMs:120_000,refreshMarginSeconds:120,intervalMs:30_000,batch:10,maxPools:1000};
}


function publicStatus(path,value) {
  const info=lstatSync(dirname(path));if(!info.isDirectory() || info.isSymbolicLink()) throw new Error('Reference status requires a real public directory.');
  const temporary=`${path}.${process.pid}.tmp`;writeFileSync(temporary,json(value)+'\n',{mode:0o644});chmodSync(temporary,0o644);renameSync(temporary,path);
}
export async function readSaleReferenceDemand(provider,{market,pool,now=Date.now}) {
  const vault=new Contract(pool,poolAbi,provider);
  const [state,opener,next,salePrice]=await Promise.all([vault.state(),vault.activeProposalId(),vault.nextProposalId(),vault.salePrice()]);
  if(state!==2n || opener===0n || salePrice!==0n) return {pool,eligible:false,proposalId:opener};
  if(next<=opener || next-opener>16n) throw new Error('Pool sale candidate bound changed.');
  const round=await vault.getProposal(opener);
  if(round.executed || round.endsAt<=BigInt(Math.floor(now()/1000))) return {pool,eligible:false,proposalId:opener};
  for(let id=opener;id<next;id++) {
    const proposal=id===opener?round:await vault.getProposal(id);
    if(proposal.executed || proposal.endsAt!==round.endsAt || !await vault.proposalPassed(id))continue;
    const reference=await new Contract(market,marketAbi,provider).saleReference(pool);
    return {pool,eligible:true,proposalId:id,proposal,reference,params:()=>vault.params()};
  }
  return {pool,eligible:false,proposalId:opener};
}

export const budgetCandidatePassed=(candidate,round,stamp)=>!candidate.executed && !round.executed
  && candidate.endsAt===round.endsAt && candidate.endsAt>BigInt(stamp)
  && candidate.price>0n && candidate.yesMembers*2n>candidate.memberCount && candidate.yesShares*2n>100n;

/** Parent votes precede the child's own proposal. Discover that demand without creating either transaction. */
export async function readBudgetSaleReferenceDemands(provider,{factory,parent,now=Date.now}) {
  const vault=new Contract(parent,budgetAbi,provider),[state,bound,opener,next]=await Promise.all([
    vault.state(),vault.legacyFactory(),vault.activeProposalId(),vault.nextProposalId()]);
  if(!same(bound,factory)) throw new Error('Budget reference parent belongs to another core Factory.');
  if(state!==2n || opener===0n)return [];
  if(next<=opener || next-opener>16n) throw new Error('Budget sale candidate bound changed.');
  const round=await vault.proposals(opener),demands=[];
  for(let id=opener;id<next;id++) {
    const candidate=id===opener?round:await vault.proposals(id);
    if(!budgetCandidatePassed(candidate,round,Math.floor(now()/1000)))continue;
    const info=await vault.childInfo(candidate.child);
    if(info.collection==='0x0000000000000000000000000000000000000000' || info.sold)continue;
    demands.push({parent,pool:getAddress(candidate.child),proposalId:id,endsAt:candidate.endsAt});
  }
  return demands;
}

async function budgetChildDemand(provider,{factory,market,pool,parent,proposalId,now}) {
  const candidates=await readBudgetSaleReferenceDemands(provider,{factory,parent,now});
  if(!candidates.some(value=>same(value.pool,pool) && value.proposalId===proposalId))return {pool,eligible:false,proposalId};
  const vault=new Contract(pool,poolAbi,provider),[state,salePrice,reference]=await Promise.all([
    vault.state(),vault.salePrice(),new Contract(market,marketAbi,provider).saleReference(pool)]);
  return {pool,parent,eligible:state===2n && salePrice===0n,proposalId,reference,params:()=>vault.params()};
}

/** Uses the same durable wallet lane as purchase, mining and administrator relay. */
export function createSaleReferencePublisher({config,provider,signer,factory,portfolioFactory,market,verifyDeployment,dependencies={}}) {
  const now=dependencies.now ?? Date.now,lockJournal=dependencies.lockJournal ?? acquireKeeperLock,
    lockWallet=dependencies.lockWallet ?? acquireWalletLock,read=dependencies.readJournal ?? readJournal,
    write=dependencies.writeJournal ?? writeJournal,reconcile=dependencies.reconcilePending ?? reconcilePending,
    publishStatus=dependencies.publishStatus ?? publicStatus,demandRead=dependencies.readDemand ?? readSaleReferenceDemand,
    quoteRead=dependencies.readQuote ?? readFirstoSaleReference,holdersRead=dependencies.readReference ?? fetchFirstoReferenceRaw;
  const ledgerOptions={factory,pool:market,transactionTarget:market,journal:config.journal};
  let stopped=false,task=null,cursor=0,parentCursor=0;const pools=[],parents=[],budgetDemands=new Map(),rows={};
  const snapshot={schemaVersion:1,chainId:56,factory,market,updatedAt:new Date(now()).toISOString(),enabled:false,pools:rows};
  const flush=()=>{snapshot.updatedAt=new Date(now()).toISOString();publishStatus(config.statusPath,snapshot);};
  const row=(pool,status,fields={})=>{rows[pool.toLowerCase()]={...rows[pool.toLowerCase()],pool,status,proposalId:null,...fields,message:messages[status]};flush();};
  async function capability() {
    try {const view=new Contract(market,marketAbi,provider),[version,publisher]=await Promise.all([
      view.automaticSaleReferenceVersion(),view.saleReferencePublisher()]);return version===1n && same(publisher,await signer.getAddress());}
    catch{return false;}
  }
  function rememberGas(journal) {
    journal.referenceGasLedger ??= [];const tx=journal.transaction;
    if(terminal(tx) && !journal.referenceGasLedger.some(entry=>entry.hash===tx.hash))
      journal.referenceGasLedger.push({hash:tx.hash,at:Date.parse(tx.confirmedAt),costWei:tx.gasCostWei});
    if(journal.referenceGasLedger.some(entry=>!Number.isSafeInteger(entry.at) || !/^\d+$/.test(entry.costWei))) throw new Error('Reference Gas accounting is malformed.');
    journal.referenceGasLedger=journal.referenceGasLedger.filter(entry=>entry.at>now()-3_600_000);
    return journal.referenceGasLedger.reduce((sum,entry)=>sum+BigInt(entry.costWei),0n);
  }
  async function discover() {
    if(dependencies.discoverPools) {pools.splice(0,pools.length,...(await dependencies.discoverPools()).map(getAddress));return;}
    const registry=new Contract(factory,['function poolCount() view returns(uint256)','function allPools(uint256) view returns(address)'],provider),count=Number(await registry.poolCount());
    if(!Number.isSafeInteger(count) || count>config.maxPools || count<pools.length) throw new Error('Reference Factory index changed.');
    for(let n=pools.length;n<count;n++) pools.push(getAddress(await registry.allPools(n)));
  }
  async function discoverBudget() {
    if(!portfolioFactory)return;
    const registry=new Contract(portfolioFactory,['function portfolioCount() view returns(uint256)','function portfolioAt(uint256) view returns(address)'],provider);
    const count=Number(await registry.portfolioCount());
    if(!Number.isSafeInteger(count) || count>config.maxPools || count<parents.length)throw new Error('Budget reference index changed.');
    for(let n=parents.length;n<count;n++)parents.push(getAddress(await registry.portfolioAt(n)));
    const selected=Array.from({length:Math.min(config.batch,parents.length)},(_v,n)=>parents[(parentCursor+n)%parents.length]);
    parentCursor=parents.length?(parentCursor+selected.length)%parents.length:0;
    for(const parent of selected){for(const [child,value] of budgetDemands)if(same(value.parent,parent))budgetDemands.delete(child);
      for(const demand of await readBudgetSaleReferenceDemands(provider,{factory,parent,now}))budgetDemands.set(demand.pool.toLowerCase(),demand);}
  }
  const demandFor=async(pool)=>{
    const own=await demandRead(provider,{factory,market,pool,now});if(own.eligible)return own;
    const parent=budgetDemands.get(pool.toLowerCase());
    return parent?budgetChildDemand(provider,{factory,market,...parent,now}):own;
  };
  async function tick() {
    if(stopped)return;let release;
    try{release=lockJournal(config.journal);}catch(error){if(busyError(error))return;throw error;}
    try {
      const journal=read(config.journal,ledgerOptions),pending=await reconcile(provider,ledgerOptions,journal),spent=rememberGas(journal);
      write(config.journal,journal);const tx=journal.transaction;
      if(tx && !terminal(tx)){row(tx.reference.pool,pending?.terminal?'review-required':'pending',{proposalId:tx.reference.proposalId,
        hash:tx.hash,priceWei:tx.reference.priceWei,observedAt:Number(tx.reference.observedAt)});return;}
      if(tx && tx.phase!=='confirmed'){row(tx.reference.pool,'review-required',{proposalId:tx.reference.proposalId,hash:tx.hash});return;}
      snapshot.enabled=await capability();if(!snapshot.enabled){for(const pool of pools)row(pool,'disabled');flush();return;}
      await discover();await discoverBudget();if(new Set(pools.map(value=>value.toLowerCase())).size!==pools.length) throw new Error('Duplicate reference pools.');
      let referencePromise;const selected=Array.from({length:Math.min(config.batch,pools.length)},(_v,n)=>pools[(cursor+n)%pools.length]);
      cursor=pools.length?(cursor+selected.length)%pools.length:0;
      for(const pool of selected) {
        if(stopped)return;
        const demand=await demandFor(pool),proposalId=demand.proposalId.toString();
        if(!demand.eligible){row(pool,'idle',{proposalId});continue;}
        const reference=demand.reference,at=Number(reference.observedAt),price=reference.marketPriceWei;
        if(price>0n && at<=Math.floor(now()/1000) && at+300-Math.floor(now()/1000)>=config.refreshMarginSeconds){
          row(pool,'confirmed',{proposalId,priceWei:price.toString(),observedAt:at});continue;}
        if(now()-Number(journal.referenceLastPublished?.[pool.toLowerCase()] ?? 0)<config.minIntervalMs){row(pool,'queued',{proposalId});continue;}
        row(pool,'reading',{proposalId});let quote;
        try {
          referencePromise ??= holdersRead({fetcher:dependencies.fetcher ?? fetch,baseUrl:config.baseUrl});
          quote=await quoteRead({provider:{request:({method,params})=>provider.send(method,params)},pool,market,params:await demand.params(),
            baseUrl:config.baseUrl,now,referenceLoader:()=>referencePromise,fetcher:dependencies.fetcher ?? fetch});
        }catch{row(pool,'source-unavailable',{proposalId});continue;}
        let walletRelease;
        try {
          walletRelease=lockWallet(await signer.getAddress(),config.journal);await verifyDeployment();
          const current=await demandFor(pool);
          if(!current.eligible || current.proposalId!==demand.proposalId || current.parent!==demand.parent){row(pool,'idle',{proposalId});continue;}
          const active=current.reference;
          if(Number(quote.args.observedAt)<Number(active.observedAt) || (active.marketPriceWei===BigInt(quote.args.priceWei)
            && active.observedAt===BigInt(quote.args.observedAt) && active.sourceDigest?.toLowerCase()===quote.args.digest.toLowerCase())) {
            row(pool,'confirmed',{proposalId,priceWei:active.marketPriceWei.toString(),observedAt:Number(active.observedAt)});continue;
          }
          const from=await signer.getAddress(),[fee,balance,latest,pendingNonce,network,block]=await Promise.all([
            provider.getFeeData(),provider.getBalance(from),provider.getTransactionCount(from,'latest'),provider.getTransactionCount(from,'pending'),provider.getNetwork(),provider.getBlock('latest')]);
          if(network.chainId!==56n) throw new Error('Reference RPC chain changed.');
          if(latest!==pendingNonce){row(pool,'queued',{proposalId});return;}
          if(!fee.gasPrice || fee.gasPrice>config.maxGasPrice || !block || config.gasLimit>block.gasLimit || config.gasLimit*fee.gasPrice>config.maxGasWei
            || spent+config.gasLimit*fee.gasPrice>config.hourlyGasWei || balance<config.gasLimit*fee.gasPrice){row(pool,'gas-paused',{proposalId});continue;}
          if(stopped || quote.validUntil<=now()+15_000){row(pool,'source-unavailable',{proposalId});continue;}
          const args=quote.args,data=marketAbi.encodeFunctionData('publishSaleReference',[pool,args.priceWei,args.observedAt,args.digest]);
          const raw=await signer.signTransaction({type:0,chainId:56,to:market,data,value:0n,nonce:pendingNonce,gasLimit:config.gasLimit,gasPrice:fee.gasPrice}),hash=keccak256(raw);
          journal.previousTransactions ??= [];if(journal.transaction)journal.previousTransactions.push(journal.transaction);
          const createdAt=new Date(now()).toISOString();
          journal.transaction={phase:'signed',kind:'automaticSaleReference',from,nonce:pendingNonce,to:market,data,value:'0',createdAt,hash,speedUps:0,
            reference:{...args,proposalId},attempts:[{kind:'purchase',raw,hash,gasLimit:config.gasLimit.toString(),gasPrice:fee.gasPrice.toString(),createdAt,broadcastCount:0}]};
          journal.referenceLastPublished ??= {};journal.referenceLastPublished[pool.toLowerCase()]=now();write(config.journal,journal);
          const [newLatest,newPending,newNetwork]=await Promise.all([provider.getTransactionCount(from,'latest'),provider.getTransactionCount(from,'pending'),provider.getNetwork()]);
          if(stopped || newNetwork.chainId!==56n || newLatest!==pendingNonce || newPending!==pendingNonce){row(pool,'review-required',{proposalId,hash});return;}
          journal.transaction.attempts[0].broadcastCount=1;write(config.journal,journal);
          try{const sent=await provider.broadcastTransaction(raw);if(sent.hash.toLowerCase()!==hash.toLowerCase())throw new Error('Reference broadcast hash differs.');
            journal.transaction.phase='broadcast';write(config.journal,journal);}catch{/* Retain exact bytes; no automatic rebroadcast. */}
          row(pool,'pending',{proposalId,hash,priceWei:args.priceWei,observedAt:Number(args.observedAt)});return;
        }catch(error){if(busyError(error)){row(pool,'queued',{proposalId});return;}throw error;}finally{walletRelease?.();}
      }
      flush();
    }finally{release?.();}
  }
  return {tick(){if(task)return task;task=tick().finally(()=>{task=null;});return task;},snapshot:()=>JSON.parse(json(snapshot)),
    async close(){stopped=true;await task;}};
}
