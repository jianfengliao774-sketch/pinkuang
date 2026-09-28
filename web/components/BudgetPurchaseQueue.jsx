'use client';
import { useEffect, useRef, useState } from 'react';
import { formatEther, parseEther } from 'ethers';
import { ListChecks, RefreshCw, ArrowRight, CheckCircle2, AlertCircle, Download } from 'lucide-react';
import { discoverBudgetPurchasePlan, prepareBudgetQueueStep, beginBudgetQueueStep, applyBudgetQueueResult,
  reconcileBudgetQueue, nextBudgetQueueItem, validateBudgetQueue,
  restoreBudgetQueueBeforeSubmission } from '../lib/budget-purchase-plan.mjs';
import { readBudgetQueue, writeBudgetQueue } from '../lib/budget-queue-journal.mjs';
import { shortAddress, explorerAddress, explorerTransaction } from '../lib/live-view.mjs';
import { displayBnb } from '../lib/amount-display.mjs';
import './BudgetPurchaseQueue.css';

const brief=error=>error?.shortMessage||error?.message||'Purchase queue unavailable';
const bnb=displayBnb;
const statuses={ready:['待建子池','Ready to create'],creating:['建池结果待核对','Creation needs reconciliation'],created:['子池已建成','Child created'],
  buying:['采购结果待核对','Purchase needs reconciliation'],pending:['等待核对交易','Awaiting reconciliation'],completed:['已购入','Purchased'],failed:['本台已停止','Stopped'],skipped:['已跳过','Skipped']};

/** Each explicit confirmation delegates one transaction to the parent's authenticated, locked journal lane. */
export default function BudgetPurchaseQueue({config,provider,wallet,account,portfolio,disabled,onSend,onComplete,locale='zh-CN'}){
  const en=locale==='en',L=(zh,english)=>en?english:zh;
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
    try{const next=await reconcileBudgetQueue({config,provider:wallet,account,parent,plan:previous,index,hash:recoveryHash.trim()||undefined});
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
    <p>{L('系统先核对全部官网候选；没有符合限额的官网矿机时，才核验 Firsto。每台先创建子矿池，再由本项目合约购买，共两笔钱包确认。','The system checks complete official-market coverage first, then verified Firsto asks when no official miner fits. Each miner requires two wallet confirmations: create a child pool, then purchase through this project.')}</p>
    <p className="budget-queue-note">{L('购机款来自项目预算，当前钱包只支付 Gas。两笔之间若有人认购子池，系统会暂停该台采购；已登记矿机不会释放或重复建池。','The project pays for miners; your wallet pays Gas. If someone funds a child between the two transactions, that purchase pauses. NFT reservations are permanent.')}</p>
    {error&&<p className="budget-queue-error" role="alert"><AlertCircle size={16}/>{error}</p>}
    {busy&&<p role="status">{stage==='official'?L('正在核对官网候选…','Checking official listings…'):stage==='firsto'?L('官网无合适候选，正在逐页核验 Firsto…','No official candidate fits; verifying Firsto pages…'):L('正在核对交易，请稍候…','Checking the transaction…')}</p>}
    {(!plan||index<0)&&!draft&&<div className="budget-queue-controls"><label>{L('本批购机预算上限（BNB）','Batch spending limit (BNB)')}<input inputMode="decimal" value={limit} disabled={frozen} onChange={e=>setLimit(e.target.value)}/></label>
      <label>{L('最多采购台数','Maximum miners')}<input type="number" min="1" max="20" step="1" value={count} disabled={frozen} onChange={e=>setCount(e.target.value)}/></label>
      <button className="btn" disabled={frozen||!account||!wallet||remaining<=0n||!queueReady} onClick={()=>void discover()}><RefreshCw size={16}/>{L('自动寻找并预览','Find miners and preview')}</button></div>}
    {(draft||plan)&&<><div className="budget-queue-summary"><strong>{L('已选','Selected')} {(draft||plan).items.length} {L('台','miners')}</strong><span title={`${formatEther(BigInt((draft||plan).limitWei))} BNB`}>{L('本批最高支出','Batch limit')}: {bnb((draft||plan).limitWei)} BNB</span><button className="btn secondary" onClick={download}><Download size={15}/>{L('导出队列','Export queue')}</button></div>
      <ol className="budget-queue-list">{(draft||plan).items.map(row=><li key={`${row.collection}:${row.tokenId}`} className={row.status==='completed'?'done':''}><div><strong>#{row.tokenId}</strong><span>{row.venue==='official'?L('官网','Official'):'Firsto'}</span><span title={`${formatEther(BigInt(row.maxCostWei))} BNB`}>{L('最高','Maximum')} {bnb(row.maxCostWei)} BNB</span><span>{statuses[row.status][en?1:0]}</span></div>
        {row.child&&<a href={explorerAddress(row.child)} target="_blank" rel="noopener noreferrer">{L('子矿池','Child pool')}: {shortAddress(row.child)} ↗</a>}
        {row.hash&&<a href={explorerTransaction(row.hash)} target="_blank" rel="noopener noreferrer">{L('核对交易','View transaction')} ↗</a>}
      </li>)}</ol></>}
    {draft&&<div className="budget-queue-controls"><button className="btn secondary" disabled={frozen} onClick={()=>setDraft(null)}>{L('返回调整','Back')}</button><button className="btn" disabled={frozen} onClick={()=>void approve()}><CheckCircle2 size={16}/>{L('批准本批限额与矿机清单','Approve this batch and limits')}</button></div>}
    {(draft||plan)?.firstoView&&<p className="budget-queue-note">{L('Firsto 候选来自当前报价快照的前 5 页，逐台核验后才可购买，不代表全站最低价。','Firsto candidates come from up to five pages of the current quote snapshot. Each order is verified before purchase; this is not a guarantee of the lowest market price.')}</p>}
    {plan&&index<0&&<p role="status">{L('本批已处理完毕。可以按剩余预算重新查找下一批。','This batch is finished. Review another batch within the remaining budget.')}</p>}
    {item&&!unresolved&&<div className="budget-queue-controls"><button className="btn" disabled={frozen} onClick={()=>void prepare()}><ArrowRight size={16}/>{item.status==='ready'?L('预览创建下一台子矿池','Preview next child creation'):L('预览由项目购买这台矿机','Preview project purchase')}</button><button className="btn secondary" disabled={frozen} onClick={()=>void skip()}>{L('跳过本台','Skip this miner')}</button></div>}
    {unresolved&&<div className="budget-queue-recovery"><p>{L('先核对原交易，不会自动重发。可填写原交易、同 nonce 加速或取消交易哈希。','Reconcile the original transaction first. No automatic resend. Enter the original, speed-up or cancellation hash if needed.')}</p><input aria-label={L('交易哈希','Transaction hash')} value={recoveryHash} onChange={e=>setRecoveryHash(e.target.value)} placeholder="0x…"/><button className="btn secondary" disabled={busy||!wallet} onClick={()=>void reconcile()}>{L('只读核对并恢复','Reconcile and recover')}</button></div>}
    {preview&&current(preview.ticket)&&<div className="budget-queue-confirm" role="dialog" aria-modal="true" aria-label={L('确认本笔采购步骤','Confirm purchase step')}><h4>{preview.result.phase==='create'?L('第 1 笔：创建子矿池','Step 1: create child pool'):L('第 2 笔：项目合约采购','Step 2: project contract purchase')}</h4>
      <p>{L('项目','Project')}: {shortAddress(parent)} · #{item?.tokenId}</p><p>{L('本钱包支付','Your wallet pays')}: 0.00000 BNB + Gas</p>
      {preview.result.procurement&&<p title={`${formatEther(BigInt(preview.result.procurement.priceWei))} BNB`}>{L('项目本次含来源费支付','Project cost including source fee')}: {bnb(preview.result.procurement.priceWei)} BNB</p>}
      <p>{L('官网购机服务费为实际官网购机价的 1%，仅从购机期结束后的余款扣除；Firsto 没有额外本项目采购费。','Official purchases charge a 1% service fee, capped by the project’s remaining funds at acquisition settlement. Firsto purchases have no additional project purchase fee.')}</p>
      <div className="budget-queue-controls"><button className="btn secondary" disabled={busy} onClick={()=>setPreview(null)}>{L('返回','Back')}</button><button className="btn" disabled={frozen} onClick={()=>void submit()}>{L('发送这一笔到钱包','Send this step to wallet')}</button></div>
    </div>}
  </section>;
}
