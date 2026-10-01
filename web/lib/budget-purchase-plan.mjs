import { ZeroAddress, getAddress } from 'ethers';
import { BUDGET_QUEUE_VERSION, budgetApprovalDigest, validateBudgetQueue } from '../../deploy/shared/budget-queue.mjs';
export { BUDGET_QUEUE_VERSION, validateBudgetQueue } from '../../deploy/shared/budget-queue.mjs';
import { abi, uint } from './chain-client.mjs';
import { readPortfolioContext, readPortfolio, readPortfolioDisplayContext, readPortfolioDisplayRow, preparePortfolioAction } from './live-portfolios.mjs';
import { prepareAdminAction } from './live-admin.mjs';
import { readOfficialMinerOnchain, checkMinerOnchain, listOperatorQuotes } from './operator-quotes.mjs';
import { readPending, recoverPending, requireWallet } from './live-transactions.mjs';
import { sameUnsignedIntent } from './ui-context.mjs';
import { pollMarketDiscovery } from './discovery-poll.mjs';
import { decodeFirstoOrder, verifyFirstoSignedAsk } from '../../deploy/src/firsto-purchase.mjs';
import { approvedOperatorCall, approvedPortfolioPurchase, authorityActionStatus } from './authority-client.mjs';
import { recoverAuthorityQueueStep } from './authority-queue-recovery.mjs';

const need=(value,message)=>{if(!value)throw new Error(message);};
const same=(a,b)=>typeof a==='string'&&typeof b==='string'&&a.toLowerCase()===b.toLowerCase();
const addr=value=>{const a=getAddress(value);need(a!==ZeroAddress,'Invalid zero address / 地址无效');return a;};
const exact=value=>uint(value);
const clone=value=>JSON.parse(JSON.stringify(value));
const roundShares=value=>(exact(value)+99n)/100n*100n;
const key=row=>`${row.collection.toLowerCase()}:${row.tokenId}`;
export const BUDGET_FIRSTO_PAGE_LIMIT=5;

// The genesis factory has neither createBudgetChildPool nor
// designatedSubscriber. Fresh deployments use two separately signed Authority
// actions and may advance only after the previous step's finalized receipt.
export function budgetPurchaseQueueSupported(config){
  const enabled=config?.displayOnly===true ? config.status==='ready'
    : config?.operationalReady===true && config.transactionReady!==false;
  return config?.kind==='integrated-v2' && enabled
    && (['code-upgraded','role-migrating','role-wired'].includes(config.stage)
      || config.stage==='fresh-active' && !!config.authority && !!config.gasWallet);
}

/** No display rounding enters approval or calldata. The temporary deposit needs 100 equal integer shares. */
export function selectBudgetCandidates(rows,{remainingWei,limitWei,maxMachines=5}={}){
  need(Number.isInteger(maxMachines)&&maxMachines>0&&maxMachines<=20,'Select 1–20 machines per reviewed batch');
  let remaining=exact(remainingWei),allowance=exact(limitWei);const seen=new Set(),selected=[];
  const sorted=[...rows].sort((a,b)=>exact(a.costWei)<exact(b.costWei)?-1:exact(a.costWei)>exact(b.costWei)?1:key(a).localeCompare(key(b)));
  for(const row of sorted){
    const cost=exact(row.costWei);if(seen.has(key(row))||cost===0n||cost>allowance||roundShares(cost)>remaining)continue;
    seen.add(key(row));selected.push({...row,maxCostWei:cost.toString(),targetRaiseWei:roundShares(cost).toString()});remaining-=cost;allowance-=cost;
    if(selected.length===maxMachines)break;
  }
  return selected;
}

async function officialSnapshot(config,context,parent,fetcher){
  const base=config.journalBase??'/api/journal';need(/^\/(?!\/)[a-zA-Z0-9_/-]+$/.test(base)&&!base.includes('..'),'Journal must be same-origin');
  const query=new URLSearchParams({parent,block:BigInt(context.block.number).toString(),hash:context.block.hash});
  const result=await pollMarketDiscovery(`${base.replace(/\/$/,'')}/budget-candidates?${query}`,{fetcher});
  need(result?.complete===true,'官网扫描尚未完成，暂不回退 Firsto / Official scan incomplete; Firsto is paused');
  need(result.chainId===56&&same(result.parent,parent)&&same(result.factory,context.manifest.portfolioFactory)
    &&same(result.legacyFactory,context.manifest.factory)&&same(result.artifactDigest,context.manifest.artifactDigest)
    &&result.snapshot?.complete===true&&result.snapshot.blockNumber===Number(BigInt(context.block.number))
    &&same(result.snapshot.blockHash,context.block.hash)&&Array.isArray(result.candidates),'Official snapshot identity mismatch');
  return result;
}

async function freshParent(input){
  if(input.config?.displayOnly===true){
    const {item:row,source}=await readPortfolioDisplayRow(input.config,input.provider,input.parent,input.account,
      {fetcher:input.fetcher,includeChildren:false});
    const context=await readPortfolioDisplayContext(input.config,input.provider,BigInt(source.indexedThrough),source);
    need(row.state===1n&&row.timestamp<row.purchaseDeadline&&row.spentWei<row.budgetWei,'项目不在购机期 / Acquisition window is closed');
    return {context,row};
  }
  const context=await readPortfolioContext(input.config,input.provider),row=await readPortfolio(context,input.parent,input.account,{includeChildren:false});
  const coreOperator=(await context.read(context.manifest.factory,abi.PoolFactory,'operator'))[0];
  if(input.config.stage==='fresh-active'){
    const authority=addr(input.config.authority);
    const [first,second,core,budget]=await Promise.all(['administratorOne','administratorTwo','coreFactory','budgetFactory']
      .map(name=>context.read(authority,abi.PlatformAuthority,name)));
    need(same(context.operator,authority)&&same(coreOperator,authority)
      &&(same(first[0],input.account)||same(second[0],input.account))
      &&same(core[0],context.manifest.factory)&&same(budget[0],context.manifest.portfolioFactory),
    'Only a verified current Authority administrator may purchase');
  }else need(same(context.operator,input.account)&&same(coreOperator,input.account),'Only the current operator of both factories may purchase');
  need(row.state===1n&&row.timestamp<row.purchaseDeadline&&row.spentWei<row.budgetWei,'项目不在购机期 / Acquisition window is closed');
  return {context,row};
}

/** Full official coverage is required before considering a bounded set of verified Firsto orders. */
export async function discoverBudgetPurchasePlan({config,provider,account,parent,limitWei,maxMachines=5,fetcher=globalThis.fetch,onProgress,
  readParent=freshParent,readOfficial=officialSnapshot,quotePage=listOperatorQuotes,checkQuote=checkMinerOnchain}={}){
  need(budgetPurchaseQueueSupported(config),'当前合约阶段不支持连续采购队列 / The current contract stage does not support this purchase queue');
  account=addr(account);parent=addr(parent);
  const {context,row}=await readParent({config,provider,account,parent,fetcher}),remaining=row.budgetWei-row.spentWei;
  const limit=limitWei===undefined?remaining:exact(limitWei);need(limit>0n&&limit<=remaining,'Approved amount exceeds remaining budget');
  onProgress?.('official');const official=await readOfficial(config,context,parent,fetcher);
  need(official.snapshot?.complete===true&&official.snapshot.blockNumber===Number(BigInt(context.block.number))
    &&same(official.snapshot.blockHash,context.block.hash),'Official discovery is incomplete or moved');
  need(exact(official.budgetWei)===row.budgetWei&&exact(official.spentWei)===row.spentWei&&exact(official.absoluteCapWei)===row.absoluteCapWei
    &&exact(official.unitCapWei)===row.unitCapWei,'Budget changed during discovery');
  let selected=selectBudgetCandidates(official.candidates,{remainingWei:remaining,limitWei:limit,maxMachines}),firstoView=null;
  if(!selected.length){
    onProgress?.('firsto');const rows=[];let page=1,viewId,totalPages,sourceBlock,total,excluded=0;
    do{
      const result=await quotePage({page,pageSize:50,sort:'price_low',...(viewId?{viewId}:{})},{fetcher});
      need(result.page===page&&Number.isSafeInteger(result.totalPages)&&result.totalPages>=0&&Number.isSafeInteger(result.excluded)&&result.excluded>=0
        &&Number.isSafeInteger(result.total)&&result.total>=0&&Array.isArray(result.rows)&&result.rows.length+result.excluded<=50
        &&typeof result.viewId==='string'&&result.viewId.length>0&&/^(0|[1-9]\d*)$/.test(result.sourceBlock),'Firsto分页无效，暂不能采购 / Invalid Firsto view');
      if(page===1){viewId=result.viewId;totalPages=result.totalPages;sourceBlock=result.sourceBlock;total=result.total;}
      need(result.viewId===viewId&&result.totalPages===totalPages&&result.sourceBlock===sourceBlock&&result.total===total,'Firsto view changed during pagination');
      rows.push(...result.rows);excluded+=result.excluded;page++;
    }while(page<=Math.min(totalPages,BUDGET_FIRSTO_PAGE_LIMIT));
    need(rows.length+excluded<=total,'Firsto pagination count is inconsistent');
    const candidates=[],seen=new Set();
    for(let offset=0;offset<rows.length;offset+=4){
      const batch=await Promise.all(rows.slice(offset,offset+4).map(async quote=>{
        if(!quote.ask || quote.ask.venue!=='firsto'||quote.status!=='verified'||quote.unverifiedWeight!=='0'
          ||quote.verifiedWeight==null||seen.has(key(quote)))return null;seen.add(key(quote));
        const weight=exact(quote.verifiedWeight),cap=row.unitCapWei*weight<row.absoluteCapWei?row.unitCapWei*weight:row.absoluteCapWei;
        if(weight===0n||exact(quote.ask.buyerCostWei)>cap||exact(quote.ask.buyerCostWei)>limit)return null;
        const checked=await checkQuote(provider,quote,{config,blockTag:context.tag,officialPriceCapWei:cap.toString()});
        if(config.displayOnly!==true){
          need(same(checked.blockHash,context.block.hash),'Firsto verification block changed');
          if(!checked.registry?.ready||!same(checked.registry.pool,ZeroAddress))return null;
        }
        // A current official listing discovered here means our full official view cannot authorize fallback.
        need(!checked.official || exact(checked.official.priceWei)>cap || roundShares(checked.official.priceWei)>remaining
          ||exact(checked.official.priceWei)>limit,'官网出现可采购挂单，请重新读取 / An official listing became available');
        if(!checked.firsto)return null;
        return {collection:addr(quote.collection),tokenId:exact(quote.tokenId).toString(),verifiedWeight:weight.toString(),venue:'firsto',
          costWei:exact(checked.firsto.grossWei).toString(),encodedOrder:checked.firsto.encodedOrder};
      }));candidates.push(...batch.filter(Boolean));
    }
    selected=selectBudgetCandidates(candidates,{remainingWei:remaining,limitWei:limit,maxMachines});firstoView={viewId,totalPages,sourceBlock,
      pagesRead:page-1,rowsRead:rows.length,excluded,total,truncated:page-1<totalPages};
  }
  if(config.displayOnly!==true)await context.canonical();
  need(selected.length,'当前没有符合预算的矿机 / No miner fits this budget');
  const plan={version:BUDGET_QUEUE_VERSION,chainId:56,id:globalThis.crypto.randomUUID(),revision:0,approved:false,account,parent,
    factory:addr(context.manifest.factory),portfolioFactory:addr(context.manifest.portfolioFactory),artifactDigest:context.manifest.artifactDigest,
    budgetWei:row.budgetWei.toString(),startSpentWei:row.spentWei.toString(),limitWei:limit.toString(),absoluteCapWei:row.absoluteCapWei.toString(),
    unitCapWei:row.unitCapWei.toString(),purchaseDeadline:row.purchaseDeadline.toString(),snapshot:official.snapshot,firstoView,
    items:selected.map(candidate=>({collection:addr(candidate.collection),tokenId:exact(candidate.tokenId).toString(),maxCostWei:candidate.maxCostWei,
      targetRaiseWei:candidate.targetRaiseWei,verifiedWeight:exact(candidate.verifiedWeight).toString(),venue:candidate.venue,
      ...(candidate.listingId?{listingId:String(candidate.listingId)}:{}),...(candidate.encodedOrder?{encodedOrder:candidate.encodedOrder}:{}),status:'ready'}))};
  plan.approvalDigest=budgetApprovalDigest(plan);return validateBudgetQueue(plan,{config,account,parent});
}

export function nextBudgetQueueItem(plan){validateBudgetQueue(plan);return plan.items.findIndex(item=>!['completed','failed','skipped'].includes(item.status));}

/** Prepare one explicit step; display mode relies on contract execution for permissions. */
export async function prepareBudgetQueueStep({config,provider,account,parent,plan,index,readParent=freshParent,
  readMiner=readOfficialMinerOnchain,prepareCreate=prepareAdminAction,preparePurchase=preparePortfolioAction,readOfficial=officialSnapshot,
  verifyOrder=verifyFirstoSignedAsk,fetcher=globalThis.fetch}={}){
  need(budgetPurchaseQueueSupported(config),'当前合约阶段不支持连续采购队列 / The current contract stage does not support this purchase queue');
  validateBudgetQueue(plan,{config,account,parent});need(plan.approved===true,'Preview and approve the purchase limits first');
  need(index===nextBudgetQueueItem(plan),'Only the next reviewed queue item may run');const item=plan.items[index];
  need(['ready','created'].includes(item.status),'未知交易必须先核对 / Reconcile the unresolved transaction first');
  if(config.displayOnly===true)return prepareBudgetQueueDirectStep({config,provider,account,parent,plan,index,item,readMiner});
  const {context,row}=await readParent({config,provider,account,parent});
  need(row.budgetWei===exact(plan.budgetWei)&&row.absoluteCapWei===exact(plan.absoluteCapWei)&&row.unitCapWei===exact(plan.unitCapWei)
    &&row.purchaseDeadline===exact(plan.purchaseDeadline),'Parent budget settings changed');
  need(row.spentWei>=exact(plan.startSpentWei)&&row.spentWei+exact(item.maxCostWei)<=exact(plan.startSpentWei)+exact(plan.limitWei)
    &&roundShares(item.maxCostWei)<=row.budgetWei-row.spentWei,'Approved remaining budget is exhausted');
  const miner=await readMiner(provider,item.collection,item.tokenId,{config,blockTag:context.tag});
  need(same(miner.blockHash,context.block.hash)&&miner.registry?.ready&&exact(miner.verifiedWeight)===exact(item.verifiedWeight),'Miner eligibility/weight changed; preview again');
  const official=miner.official&&exact(miner.official.priceWei)<=exact(item.maxCostWei)?miner.official:null;
  if(official)need(item.venue==='official'&&item.listingId!==undefined&&exact(official.id)===exact(item.listingId),
    '官网挂单或采购来源与已批准清单不同，请重新预览 / Official listing or purchase source changed');
  if(!official){
    need(item.venue==='firsto','官网挂单已变化，请跳过或重新预览 / Official listing changed');
    const full=await readOfficial(config,context,parent,fetcher);
    need(full.snapshot?.complete===true&&full.snapshot.blockNumber===Number(BigInt(context.block.number))
      &&same(full.snapshot.blockHash,context.block.hash),'Official discovery is incomplete or moved');
    need(!selectBudgetCandidates(full.candidates,{remainingWei:row.budgetWei-row.spentWei,
      limitWei:exact(plan.startSpentWei)+exact(plan.limitWei)-row.spentWei,maxMachines:1}).length,'有官网候选，暂停 Firsto / Official candidates take priority');
    const order=await verifyOrder(provider,decodeFirstoOrder(item.encodedOrder),{blockTag:context.tag});
    need(same(order.ask.collection,item.collection)&&exact(order.ask.tokenId)===exact(item.tokenId)
      &&exact(order.grossWei)<=exact(item.maxCostWei),'Firsto order changed or exceeds approved cap');
  }
  let prepared,phase;
  if(item.status==='ready'){
    need(same(miner.registry.pool,ZeroAddress),'此矿机已永久登记其他项目 / NFT is already reserved');
    const params={circuits:item.collection,circuitId:item.tokenId,targetRaiseWei:item.targetRaiseWei,priceCapWei:item.maxCostWei,
      fundingDeadline:(row.purchaseDeadline-1n).toString(),purchaseDeadline:row.purchaseDeadline.toString()};
    need(row.timestamp<row.purchaseDeadline-1n,'Purchase deadline is too close');
    prepared=await prepareCreate({config,provider,account,kind:'createBudgetChildPool',params,subscriber:parent});phase='create';
    prepared={...prepared,action:{kind:'createBudgetChildPool',targetType:'factory'}};
  }else{
    need(item.child&&same(miner.registry.pool,item.child),'Child reservation differs from the confirmed creation');
    const params=(await context.read(item.child,abi.PoolVault,'params'))[0];
    const [supply,state,binding,subscriber]=await Promise.all([context.read(item.child,abi.PoolVault,'totalSupply'),context.read(item.child,abi.PoolVault,'state'),context.read(item.child,abi.PoolVault,'factory'),context.read(plan.factory,abi.PoolFactory,'designatedSubscriber',[item.child])]);
    need(supply[0]===0n&&state[0]===0n&&same(binding[0],plan.factory)&&same(subscriber[0],parent),'子池未锁定给预算项目或状态改变，暂停采购 / Child is not reserved for this portfolio');
    need(same(params.circuits,item.collection)&&params.circuitId===exact(item.tokenId)&&params.targetRaise===exact(item.targetRaiseWei)
      &&params.priceCap===exact(item.maxCostWei)&&params.directSeller===ZeroAddress&&params.directPrice===0n
      &&params.fundingDeadline===exact(plan.purchaseDeadline)-1n&&params.purchaseDeadline===exact(plan.purchaseDeadline),'Child parameters differ from approved plan');
    prepared=await preparePurchase({config,provider,account,pool:parent,action:{kind:'autoPurchase',child:item.child,
      expectedPool:parent,...(!official?{frozenOrder:item.encodedOrder}:{})}});phase='purchase';
    need(prepared.procurement&&exact(prepared.procurement.priceWei)<=exact(item.maxCostWei),'Purchase exceeds approved machine price');
    need(official?prepared.procurement.route==='official':prepared.procurement.route==='firsto','Purchase source changed');
  }
  await context.canonical();
  const authority=config.stage==='fresh-active'?(phase==='create'
    ?{kind:'executeApprovedOperation',args:approvedOperatorCall(config,prepared.transaction)}
    :approvedPortfolioPurchase(config,prepared)):undefined;
  return {...prepared,...(authority?{authority}:{}),queue:{id:plan.id,approvalDigest:plan.approvalDigest,parent,account,index,phase},
    input:{plan:clone(plan),index,parent,account},phase};
}

async function prepareBudgetQueueDirectStep({config,provider,account,parent,plan,index,item,readMiner}){
  account=addr(account);parent=addr(parent);
  let prepared,phase;
  if(item.status==='ready'){
    const deadline=exact(plan.purchaseDeadline);
    need(deadline>1n,'Purchase deadline is invalid');
    const params={circuits:addr(item.collection),circuitId:exact(item.tokenId),targetRaise:exact(item.targetRaiseWei),
      priceCap:exact(item.maxCostWei),directSeller:ZeroAddress,directPrice:0n,fundingDeadline:deadline-1n,purchaseDeadline:deadline};
    prepared={transaction:{chainId:'0x38',from:account,to:addr(plan.factory),value:'0x0',
      data:abi.PoolFactory.encodeFunctionData('createBudgetChildPool',[params,parent])},
      action:{kind:'createBudgetChildPool',targetType:'factory'},blockNumber:null,displayOnly:true};
    phase='create';
  }else{
    const child=addr(item.child);let method,args,procurement;
    if(item.venue==='official'){
      const miner=await readMiner(provider,item.collection,item.tokenId,{config,blockTag:'latest'}),official=miner.official;
      need(official&&exact(official.id)===exact(item.listingId),'官网挂单已变化，请重新预览 / Official listing changed');
      const priceWei=exact(official.priceWei);need(priceWei>0n&&priceWei<=exact(item.maxCostWei),'Purchase exceeds approved machine price');
      method='buyOfficial';args=[child,exact(official.id)];
      procurement={route:'official',child,priceWei,capWei:exact(item.maxCostWei)};
    }else{
      const order=decodeFirstoOrder(item.encodedOrder);
      need(same(order.ask.collection,item.collection)&&exact(order.ask.tokenId)===exact(item.tokenId)
        &&exact(order.grossWei)<=exact(item.maxCostWei),'Firsto order differs from approved machine or amount');
      method='buyFirsto';args=[child,order.encodedOrder];
      procurement={route:'firsto',child,priceWei:exact(order.grossWei),capWei:exact(item.maxCostWei),frozenOrder:order.encodedOrder};
    }
    prepared={transaction:{chainId:'0x38',from:account,to:parent,value:'0x0',data:abi.BudgetPortfolioVault.encodeFunctionData(method,args)},
      action:{kind:method,targetType:'portfolio'},row:{pool:parent,account,displayOnly:true},args,procurement,blockNumber:null,displayOnly:true};
    phase='purchase';
  }
  const authority=config.stage==='fresh-active'?(phase==='create'
    ?{kind:'executeApprovedOperation',args:approvedOperatorCall(config,prepared.transaction)}
    :approvedPortfolioPurchase(config,prepared)):undefined;
  return {...prepared,...(authority?{authority}:{}),queue:{id:plan.id,approvalDigest:plan.approvalDigest,parent,account,index,phase},
    input:{plan:clone(plan),index,parent,account},phase};
}

export function beginBudgetQueueStep(plan,prepared){
  validateBudgetQueue(plan);const {index,phase}=prepared.queue;
  need(prepared.queue.id===plan.id&&prepared.queue.approvalDigest===plan.approvalDigest&&index===nextBudgetQueueItem(plan),'Queue preview changed');
  const next=clone(plan),item=next.items[index];need(item.status===(phase==='create'?'ready':'created'),'Queue step changed');
  item.status=phase==='create'?'creating':'buying';item.pendingPhase=phase;item.intent={transaction:prepared.transaction,action:prepared.action,
    ...(prepared.authority?{authority:prepared.authority}:{})};delete item.hash;delete item.nonce;
  next.revision++;return next;
}

/** Only the caller's proven pre-send failure may undo a write-ahead step; idle recovery never calls this. */
export function restoreBudgetQueueBeforeSubmission(plan,index){
  const next=clone(validateBudgetQueue(plan)),item=next.items[index];
  need(item&&['creating','buying'].includes(item.status)&&['create','purchase'].includes(item.pendingPhase)
    &&!item.hash&&item.nonce===undefined,'Cannot undo an attempted or unresolved wallet submission');
  item.status=item.pendingPhase==='create'?'ready':'created';delete item.pendingPhase;delete item.intent;
  next.revision++;return validateBudgetQueue(next);
}

export function applyBudgetQueueResult(plan,index,result){
  const next=clone(validateBudgetQueue(plan)),item=next.items[index];need(item&&['creating','buying','pending'].includes(item.status),'Queue has no pending step');
  if(result?.status==='pending'){
    if(result.record){need(same(result.record.account,plan.account)&&same(result.record.target,item.intent.transaction.to)
      &&same(result.record.data,item.intent.transaction.data)&&BigInt(result.record.value)===BigInt(item.intent.transaction.value)
      &&Number.isSafeInteger(result.record.nonce)&&result.record.nonce>=0,'Pending journal intent differs from this queue');item.nonce=result.record.nonce;}
    item.status='pending';if(result.hash)item.hash=result.hash;item.message=result.message||'';next.revision++;return validateBudgetQueue(next);
  }
  need(result?.finalized===true&&same(result.account,plan.account)&&/^0x[\da-f]{64}$/i.test(result.hash??result.transactionHash??''),'Finalized journal receipt is required');
  need(same(result.target,item.intent.transaction.to)&&result.action===item.intent.action.kind,'Receipt does not match reviewed step');
  need(same(result.factory,item.pendingPhase==='create'?plan.factory:plan.portfolioFactory)
    &&Number.isSafeInteger(result.nonce)&&result.nonce>=0&&result.receipt
    &&same(result.receipt.transactionHash,result.hash??result.transactionHash)
    &&[0,1].includes(result.receipt.status)&&(result.status==='replaced'||result.receipt.status===(result.status==='reverted'?0:1)),
    'Receipt identity or status differs from the approved step');
  const finalizedHash=result.hash??result.transactionHash;
  if(item.hash&&!same(item.hash,finalizedHash))item.previousHashes=[...(item.previousHashes??[]),item.hash];
  item.hash=finalizedHash;item.lastResult={status:result.status,hash:item.hash,nonce:result.nonce};
  if(result.status==='confirmed'){
    if(item.pendingPhase==='create'){item.child=addr(result.poolAddress);item.creationHash=item.hash;item.status='created';}
    else{item.purchaseHash=item.hash;item.status='completed';}
  }else{need(['reverted','cancelled','replaced'].includes(result.status),'Unresolved transaction result');item.status='failed';}
  delete item.pendingPhase;delete item.intent;next.revision++;return validateBudgetQueue(next);
}

/** Never rebroadcasts. A missing receipt/empty journal is not proof that no transaction was sent. */
export async function reconcileBudgetQueue({config,provider,wallet=provider,account,parent,plan,index,hash:recoveryHash,fetcher=globalThis.fetch}){
  validateBudgetQueue(plan,{config,account,parent});await requireWallet(wallet,account);
  const item=plan.items[index];need(item&&['creating','buying','pending'].includes(item.status),'Queue has no pending step');
  if(config.stage==='fresh-active'){
    const status=recoveryHash||item.hash?null:await authorityActionStatus(config,account);
    const result=await recoverAuthorityQueueStep({config,provider,plan,index,hash:recoveryHash||item.hash||status?.hash});
    return applyBudgetQueueResult(plan,index,result);
  }
  const view=await readPending({account,config,fetcher});
  if(view.record)need(same(view.record.account,account)&&same(view.record.target,item.intent.transaction.to)
    &&same(view.record.data,item.intent.transaction.data)&&BigInt(view.record.value)===BigInt(item.intent.transaction.value),'Another wallet operation is pending; reconcile it first');
  const result=await recoverPending({provider,config,account,hash:recoveryHash||item.hash||view.record?.hash,fetcher});
  need(result.status!=='idle','缺少可核对哈希，保留原意图 / Supply the original or replacement transaction hash');
  if(result.finalized===true){
    // An archived result has no live journal record. Bind its chain transaction to this exact queue step as well.
    const tx=await provider.request({method:'eth_getTransactionByHash',params:[result.hash]});
    need(tx&&same(tx.hash,result.hash)&&same(tx.from,account)&&BigInt(tx.nonce)===BigInt(result.nonce)
      &&BigInt(tx.chainId)===56n,'Recovered transaction identity mismatch');
    if(['confirmed','reverted'].includes(result.status))need(same(tx.to,item.intent.transaction.to)
      &&same(tx.input??tx.data,item.intent.transaction.data)&&BigInt(tx.value)===BigInt(item.intent.transaction.value),'Recovered transaction differs from the reviewed queue step');
    else need((view.record?.nonce??item.nonce)===result.nonce,'Original queue nonce is required to accept a replacement');
  }
  return applyBudgetQueueResult(plan,index,result);
}

export function budgetQueuePreviewMatches(left,right){return left?.queue?.approvalDigest===right?.queue?.approvalDigest
  &&left?.queue?.index===right?.queue?.index&&left?.queue?.phase===right?.queue?.phase&&sameUnsignedIntent(left.transaction,right.transaction)
  &&String(left.procurement?.priceWei??'')===String(right.procurement?.priceWei??'')
  &&String(left.procurement?.route??'')===String(right.procurement?.route??'')
  &&JSON.stringify(left.authority??null)===JSON.stringify(right.authority??null);}
