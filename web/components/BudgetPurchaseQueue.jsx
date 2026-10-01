'use client';
import { useEffect, useRef, useState } from 'react';
import { formatEther, parseEther } from 'ethers';
import { ListChecks, RefreshCw, ArrowRight, CheckCircle2, AlertCircle, Download } from 'lucide-react';
import { discoverBudgetPurchasePlan, prepareBudgetQueueStep, beginBudgetQueueStep, applyBudgetQueueResult,
  reconcileBudgetQueue, nextBudgetQueueItem, validateBudgetQueue,
  restoreBudgetQueueBeforeSubmission } from '../lib/budget-purchase-plan.mjs';
import { readBudgetQueue, writeBudgetQueue } from '../lib/budget-queue-journal.mjs';
import { shortAddress, explorerAddress, explorerTransaction } from '../lib/live-view.mjs';
import { fundingAmount } from '../lib/funding-amount.mjs';
import './BudgetPurchaseQueue.css';

const brief=error=>error?.shortMessage||error?.message||'Purchase queue unavailable';
const bnb=value=>fundingAmount(formatEther(BigInt(value))).display;
// The on-chain fee is floor(all official spend / 100), so one purchase can
// increase it by at most ceil(this purchase / 100). It is charged at settlement.
const officialPriceWithFeeCeiling=value=>{const price=BigInt(value);return price+(price+99n)/100n;};
const statuses={ready:['待建子池','Ready to create'],creating:['建池结果待核对','Creation needs reconciliation'],created:['子池已建成','Child created'],
  buying:['采购结果待核对','Purchase needs reconciliation'],pending:['等待核对交易','Awaiting reconciliation'],completed:['已购入','Purchased'],failed:['本台已停止','Stopped'],skipped:['已跳过','Skipped']};

/** Each explicit confirmation delegates one transaction to the parent's authenticated, locked journal lane. */
export default function BudgetPurchaseQueue({config,provider,wallet,account,portfolio,disabled,onSend,onAuthenticate,onComplete,locale='zh-CN'}){
  const en=locale==='en',L=(zh,english)=>en?english:zh;
  const relayed=config?.stage==='fresh-active';
  const [plan,setPlan]=useState(null),[draft,setDraft]=useState(null),[preview,setPreview]=useState(null),[busy,setBusy]=useState(false);
  const [error,setError]=useState(''),[stage,setStage]=useState(''),[limit,setLimit]=useState(''),[count,setCount]=useState('5'),[recoveryHash,setRecoveryHash]=useState('');
  const [queueReady,setQueueReady]=useState(false);
  const context=useRef({}),epoch=useRef(0),serverRevision=useRef(0),planRef=useRef(null);
  const parent=portfolio?.pool,identity=`${config?.artifactDigest??config?.manifest?.artifactDigest}:${account}:${parent}`;
  if(context.current.identity!==identity||context.current.wallet!==wallet||context.current.provider!==provider){epoch.current++;context.current={identity,wallet,provider};}
  const current=ticket=>ticket===epoch.current;
  const frozen=busy||disabled;
  const remaining=portfolio ? portfolio.budgetWei-portfolio.spentWei : 0n;
  useEffect(()=>{
    const ticket=++epoch.current;setPlan(null);planRef.current=null;serverRevision.current=0;setQueueReady(false);
    setDraft(null);setPreview(null);setError('');setBusy(false);setStage('');setRecoveryHash('');
    setLimit(remaining>0n?formatEther(remaining):'');
    if(!config||!account||!parent)return;
    void readBudgetQueue({config,account,parent}).then(view=>{if(current(ticket)){
      serverRevision.current=view.revision;planRef.current=view.record;setPlan(view.record);setQueueReady(true);
    }}).catch(problem=>{if(current(ticket))setError(brief(problem));});
  },[identity,provider,wallet]);
  useEffect(()=>()=>{epoch.current++;},[]);
  const index=plan?nextBudgetQueueItem(plan):-1,item=index<0?null:plan.items[index];
  const unresolved=item&&['creating','buying','pending'].includes(item.status);
  async function persist(next,previous,ticket){
    if(!queueReady)throw new Error(L('服务端采购队列尚未加载。','The server purchase queue is not ready.'));
    if(previous?.id!==planRef.current?.id||previous?.revision!==planRef.current?.revision)
      throw new Error(L('队列已改变，请重新读取。','Purchase queue changed; reload it.'));
    const revision=await writeBudgetQueue({config,account,parent,record:next,expectedRevision:serverRevision.current});
    serverRevision.current=revision;
    if(current(ticket)){setPlan(next);planRef.current=next;}return next;
  }
  async function connectQueue(){
    if(frozen||!onAuthenticate)return;const ticket=++epoch.current;setBusy(true);setError('');
    try{
      await onAuthenticate();if(!current(ticket))return;
      const view=await readBudgetQueue({config,account,parent});
      if(current(ticket)){serverRevision.current=view.revision;planRef.current=view.record;setPlan(view.record);setQueueReady(true);}
    }catch(problem){if(current(ticket))setError(brief(problem));}finally{if(current(ticket))setBusy(false);}
  }
  async function discover(){
    if(frozen)return;const ticket=++epoch.current;setBusy(true);setError('');setPreview(null);setDraft(null);
    try{
      if(plan&&nextBudgetQueueItem(plan)>=0)throw new Error(L('先处理当前队列；结果不明的交易不能覆盖。','Finish the current queue before creating another.'));
      const amount=parseEther(limit);const machines=Number(count);
      const result=await discoverBudgetPurchasePlan({config,provider,account,parent,limitWei:amount,maxMachines:machines,onProgress:value=>{if(current(ticket))setStage(value);}});
      if(current(ticket))setDraft(result);
    }catch(problem){if(current(ticket))setError(brief(problem));}finally{if(current(ticket)){setBusy(false);setStage('');}}
  }
  async function approve(){
    if(!draft||frozen)return;const ticket=++epoch.current;
    setBusy(true);
    try{const approved={...draft,approved:true};validateBudgetQueue(approved,{config,account,parent});await persist(approved,planRef.current,ticket);setDraft(null);setError('');}
    catch(problem){setError(brief(problem));}
    finally{if(current(ticket))setBusy(false);}
  }
  async function prepare(){
    if(frozen||!item||unresolved)return;const ticket=++epoch.current;setBusy(true);setError('');setPreview(null);
    try{const result=await prepareBudgetQueueStep({config,provider:wallet,account,parent,plan,index});if(current(ticket))setPreview({result,ticket});}
    catch(problem){if(current(ticket))setError(brief(problem));}finally{if(current(ticket))setBusy(false);}
  }
  async function submit(){
    if(frozen||!preview||!current(preview.ticket))return;const ticket=preview.ticket,previous=planRef.current;setBusy(true);setError('');
    let begun;
    try{
      // The parent repeats the fresh preflight exactly once under its authenticated submission lock.
      const checked=preview.result;
      if(!current(ticket))throw new Error(L('确认内容已变化，请重新预览。','The transaction changed. Preview again.'));
      begun=await persist(beginBudgetQueueStep(previous,checked),previous,ticket);setPreview(null);
      const result=await onSend(checked,checked.input);
      const next=applyBudgetQueueResult(begun,index,result);await persist(next,begun,ticket);
      if(current(ticket)&&result.status==='confirmed')onComplete?.();
    }catch(problem){
      // Even a rejected or lost wallet response is not a licence to resend. The server journal is authoritative.
      if(begun){try{const next=problem?.beforeWalletSubmission===true?restoreBudgetQueueBeforeSubmission(begun,index)
        :applyBudgetQueueResult(begun,index,{status:'pending',message:brief(problem)});await persist(next,begun,ticket);
      }catch{/* Server recovery and the persisted pre-send step remain intact. */}}
      if(current(ticket))setError(brief(problem));
    }finally{if(current(ticket))setBusy(false);}
  }
  async function reconcile(){
    if(busy||!unresolved||!wallet)return;const ticket=++epoch.current,previous=plan;setBusy(true);setError('');setPreview(null);
    try{const next=await reconcileBudgetQueue({config,provider:relayed?provider:wallet,wallet,account,parent,plan:previous,index,hash:recoveryHash.trim()||undefined});
      await persist(next,previous,ticket);if(current(ticket)){setRecoveryHash('');onComplete?.();}}
    catch(problem){if(current(ticket))setError(brief(problem));}finally{if(current(ticket))setBusy(false);}
  }
  async function skip(){
    if(frozen||!item||unresolved)return;const ticket=++epoch.current;
    setBusy(true);
    try{const next=structuredClone(plan);next.items[index].status='skipped';next.revision++;await persist(next,plan,ticket);setPreview(null);setError('');}
    catch(problem){setError(brief(problem));}
    finally{if(current(ticket))setBusy(false);}
  }
  function download(){const data=plan??draft;if(!data)return;const url=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json'}));
    const a=document.createElement('a');a.href=url;a.download=`bemine-purchase-queue-${data.id}.json`;a.click();URL.revokeObjectURL(url);}
  return <section className="budget-queue" aria-label={L('连续采购队列','Purchase queue')}>
    <div className="budget-queue-title"><ListChecks size={20}/><h3>{L('按预算连续采购','Purchase within the project budget')}</h3></div>
    <p>{L('先读取官网候选；没有符合限额的官网矿机时，再读取 Firsto 报价。每台先创建子矿池，再由本项目合约购买，共两笔钱包确认。','Read official listings first, then Firsto asks when no official miner fits. Each miner requires two wallet confirmations: create a child pool, then purchase through this project.')}</p>
    <p className="budget-queue-note">{relayed?L('每台的建池与购机分别确认；任意一位已授权管理员可以依次签名两步。先建子池，核验最终回执后再签本台订单与最高支出。购机款来自项目预算，Gas 钱包代付手续费。签名不授予任意采购权限。','Creation and purchase need separate confirmations; either authorized administrator may sign both steps. Create the child, verify its finalized receipt, then sign its exact order and spending cap. The project funds the miner; the Gas wallet pays fees. This never grants arbitrary purchasing authority.'):L('购机款来自项目预算，当前钱包只支付 Gas。两笔之间若有人认购子池，系统会暂停该台采购；已登记矿机不会释放或重复建池。','The project pays for miners; your wallet pays Gas. If someone funds a child between the two transactions, that purchase pauses. NFT reservations are permanent.')}</p>
    {error&&<p className="budget-queue-error" role="alert"><AlertCircle size={16}/>{error}</p>}
    {!queueReady&&onAuthenticate&&<button className="btn secondary" disabled={frozen||!wallet||!account} onClick={()=>void connectQueue()}>{L('连接并读取采购记录','Connect and load purchase records')}</button>}
    {busy&&<p role="status">{stage==='official'?L('正在读取官网候选…','Reading official listings…'):stage==='firsto'?L('官网无合适候选，正在读取 Firsto 报价…','No official candidate fits; reading Firsto asks…'):L('正在准备交易，请稍候…','Preparing the transaction…')}</p>}
    {(!plan||index<0)&&!draft&&<div className="budget-queue-controls"><label>{L('本批购机预算上限（BNB）','Batch spending limit (BNB)')}<input inputMode="decimal" value={limit} disabled={frozen} onChange={e=>setLimit(e.target.value)}/></label>
      <label>{L('最多采购台数','Maximum miners')}<input type="number" min="1" max="20" step="1" value={count} disabled={frozen} onChange={e=>setCount(e.target.value)}/></label>
      <button className="btn" disabled={frozen||!account||!wallet||remaining<=0n||!queueReady} onClick={()=>void discover()}><RefreshCw size={16}/>{L('自动寻找并预览','Find miners and preview')}</button></div>}
    {(draft||plan)&&<><div className="budget-queue-summary"><strong>{L('已选','Selected')} {(draft||plan).items.length} {L('台','miners')}</strong><span title={`${formatEther(BigInt((draft||plan).limitWei))} BNB`}>{L('本批矿机价格限额（不含官网服务费）','Batch miner-price limit (excludes official fee)')}: {bnb((draft||plan).limitWei)} BNB</span><button className="btn secondary" onClick={download}><Download size={15}/>{L('导出队列','Export queue')}</button></div>
      <ol className="budget-queue-list">{(draft||plan).items.map(row=><li key={`${row.collection}:${row.tokenId}`} className={row.status==='completed'?'done':''}><div><strong>#{row.tokenId}</strong><span>{row.venue==='official'?L('官网','Official'):'Firsto'}</span><span title={`${formatEther(BigInt(row.maxCostWei))} BNB`}>{L('矿机价格上限','Miner price cap')} {bnb(row.maxCostWei)} BNB</span>{row.venue==='official'&&<span title={`${formatEther(officialPriceWithFeeCeiling(row.maxCostWei))} BNB`}>{L('含 1% 费的最高项目支出','Maximum project spend incl. 1% fee')} {bnb(officialPriceWithFeeCeiling(row.maxCostWei))} BNB</span>}<span>{statuses[row.status][en?1:0]}</span></div>
        {row.child&&<a href={explorerAddress(row.child)} target="_blank" rel="noopener noreferrer">{L('子矿池','Child pool')}: {shortAddress(row.child)} ↗</a>}
        {row.hash&&<a href={explorerTransaction(row.hash)} target="_blank" rel="noopener noreferrer">{L('核对交易','View transaction')} ↗</a>}
      </li>)}</ol></>}
    {draft&&<div className="budget-queue-controls"><button className="btn secondary" disabled={frozen} onClick={()=>setDraft(null)}>{L('返回调整','Back')}</button><button className="btn" disabled={frozen} onClick={()=>void approve()}><CheckCircle2 size={16}/>{L('批准本批限额与矿机清单','Approve this batch and limits')}</button></div>}
    {(draft||plan)?.firstoView&&<p className="budget-queue-note">{L('Firsto 候选来自当前报价的前 5 页，按批准的订单逐台购买；报价可能变化，不代表全站最低价。','Firsto candidates come from up to five pages of current asks and are purchased using approved orders. Prices can change; this is not a guarantee of the lowest market price.')}</p>}
    {plan&&index<0&&<p role="status">{L('本批已处理完毕。可以按剩余预算重新查找下一批。','This batch is finished. Review another batch within the remaining budget.')}</p>}
    {item&&!unresolved&&<div className="budget-queue-controls"><button className="btn" disabled={frozen} onClick={()=>void prepare()}><ArrowRight size={16}/>{item.status==='ready'?L('预览创建下一台子矿池','Preview next child creation'):L('预览由项目购买这台矿机','Preview project purchase')}</button><button className="btn secondary" disabled={frozen} onClick={()=>void skip()}>{L('跳过本台','Skip this miner')}</button></div>}
    {unresolved&&<div className="budget-queue-recovery"><p>{relayed?L('先核对 Gas 钱包的原交易或相同内容加速交易。取消或不同内容的交易须由运营核对，不会自动解锁重发。','Reconcile the Gas wallet transaction or a speed-up with identical content. Cancellations or changed content require operator review; they never unlock an automatic resend.'):L('先核对原交易，不会自动重发。可填写原交易、同 nonce 加速或取消交易哈希。','Reconcile the original transaction first. No automatic resend. Enter the original, speed-up or cancellation hash if needed.')}</p><input aria-label={L('交易哈希','Transaction hash')} value={recoveryHash} onChange={e=>setRecoveryHash(e.target.value)} placeholder="0x…"/><button className="btn secondary" disabled={busy||!wallet} onClick={()=>void reconcile()}>{L('只读核对并恢复','Reconcile and recover')}</button></div>}
    {preview&&current(preview.ticket)&&<div className="budget-queue-confirm" role="dialog" aria-modal="true" aria-label={L('确认本笔采购步骤','Confirm purchase step')}><h4>{preview.result.phase==='create'?L('第 1 笔：创建子矿池','Step 1: create child pool'):L('第 2 笔：项目合约采购','Step 2: project contract purchase')}</h4>
      <p>{L('项目','Project')}: {shortAddress(parent)} · #{item?.tokenId}</p><p>{relayed?L('本钱包仅签名，手续费由 Gas 钱包代付。','This wallet signs only; the Gas wallet pays transaction fees.'):L('本钱包支付：0 BNB + Gas','Your wallet pays: 0 BNB + Gas')}</p>
      {preview.result.procurement&&<><p title={`${formatEther(BigInt(preview.result.procurement.priceWei))} BNB`}>{L('项目本次矿机价格','Project miner price')}: {bnb(preview.result.procurement.priceWei)} BNB</p>{preview.result.procurement.route==='official'&&<p title={`${formatEther(officialPriceWithFeeCeiling(preview.result.procurement.priceWei))} BNB`}>{L('含官网服务费的项目支出上限','Project spend ceiling incl. official fee')}: {bnb(officialPriceWithFeeCeiling(preview.result.procurement.priceWei))} BNB</p>}</>}
      <p>{L('合约价格上限只约束矿机成交价，不包含官网 1% 服务费。官网费用在购机期结算时从余款扣除，且不超过剩余预算；多笔官网采购合并计费，实际尾数可能更低。Firsto 没有额外本项目采购费。','The contract price cap applies to the miner price, not the 1% official-market fee. The fee is deducted from the remaining project funds at acquisition settlement and capped by those funds. Multiple official purchases are charged together, so the final rounding may be lower. Firsto has no additional project purchase fee.')}</p>
      <div className="budget-queue-controls"><button className="btn secondary" disabled={busy} onClick={()=>setPreview(null)}>{L('返回','Back')}</button><button className="btn" disabled={frozen} onClick={()=>void submit()}>{L('发送这一笔到钱包','Send this step to wallet')}</button></div>
    </div>}
  </section>;
}
