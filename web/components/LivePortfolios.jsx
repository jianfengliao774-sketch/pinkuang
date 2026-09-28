'use client';
import { useEffect, useRef, useState } from 'react';
import { ZeroAddress } from 'ethers';
import { Layers3, RefreshCw, ArrowRight, ChevronDown } from 'lucide-react';
import { readPortfolioPage, readPortfolioContext, readPortfolio, readPortfolioChildren, readPortfolioOrders, preparePortfolioAction } from '../lib/live-portfolios.mjs';
import { amount, shortAddress, explorerAddress, explorerTransaction, exportActivityCsv } from '../lib/live-view.mjs';
import { displayBnb, displayBnbDecimal } from '../lib/amount-display.mjs';
import { READ_CANCELLED, retryReadRound } from '../lib/read-retry.mjs';
import LiveYieldChart from './LiveYieldChart';
import { sameUnsignedIntent } from '../lib/ui-context.mjs';
import './LivePortfolios.css';
import { portfolioText } from '../lib/portfolio-copy.mjs';
import { portfolioCreateForm } from '../lib/portfolio-create-form.mjs';
import { fetchCapacityReference, fetchQuotePage, quoteIssue, referenceIssue } from '../../deploy/src/pricing.ts';
import { QUOTE_BASE } from '../lib/operator-quotes.mjs';
import { portfolioDailyCapSample } from '../lib/portfolio-daily-cap.mjs';
import PortfolioCapacity from './PortfolioCapacity';
import BudgetPurchaseQueue from './BudgetPurchaseQueue';

const names = { deposit:'认购预算份额',withdrawDeposit:'撤回全部认购',finalizeFundingFailure:'开启募集失败退款',claimFailedFunding:'结算募集退款',
  finalizeAcquisition:'结束购机并结算余款',collectChildBem:'归集该台 BEM',claimBem:'领取项目 BEM',withdrawBnb:'领取项目 BNB',transfer:'转移项目份额',
  proposeChildSale:'提出子矿机出售',voteChildSale:'提交子矿机表决',executeChildSale:'执行子矿机挂牌',settleChildSale:'归集该台卖款',expireChildSale:'解除过期子机提案',
  createPortfolio:'创建预算项目',autoPurchase:'自动核价采购',marketList:'挂卖项目份额',marketFill:'买入项目份额',marketCancel:'撤回份额挂单',marketExpire:'解锁到期份额挂单',marketWithdraw:'领取预算市场 BNB' };
const states = ['募集中','购机期','运行中','出售中','已结束','可退款'];
const same = (a,b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const brief = error => error?.shortMessage || error?.message || '预算项目读取未完成。';
const recentPages = new Map();

/** A parent project owns its miners. Its 100 shares are never counted once per child. */
export default function LivePortfolios({ config, provider, client, locale, account, wallet, mode = 'pools', initialPool, disabled, onConnect, onSend, onSendQueue, onShare, onBuyChild, operatorVerified = false, refreshKey = 0 }) {
  const T=text=>portfolioText(locale,text);
  const [rows,setRows]=useState([]),[cursor,setCursor]=useState(null),[selected,setSelected]=useState(null),[operator,setOperator]=useState(null);
  const [loading,setLoading]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(''),[preview,setPreview]=useState(null);
  const [readRetry,setReadRetry]=useState(null),[readFailed,setReadFailed]=useState(false);
  const [loadedIdentity,setLoadedIdentity]=useState(''),[orders,setOrders]=useState([]),[orderCursor,setOrderCursor]=useState(null),[orderPool,setOrderPool]=useState(null);
  const [listingQuantity,setListingQuantity]=useState('1');
  const [quantity,setQuantity]=useState('1'),[recipient,setRecipient]=useState(''),[child,setChild]=useState(''),[price,setPrice]=useState(''),[reference,setReference]=useState('');
  const [budget,setBudget]=useState(''),[cap,setCap]=useState(''),[dailyCap,setDailyCap]=useState(''),[fundHours,setFundHours]=useState('24'),[buyHours,setBuyHours]=useState('48');
  const [dailyReference,setDailyReference]=useState(null),[dailyReferenceError,setDailyReferenceError]=useState(''),[capacitySample,setCapacitySample]=useState(null),[capacityBusy,setCapacityBusy]=useState(false);
  const context=useRef({}), sequence=useRef(0);
  const identity=`${config?.portfolioFactory || ''}:${account || ''}:${mode}:${initialPool || ''}:${refreshKey}`;
  const cacheKey=JSON.stringify([config?.artifactDigest,config?.portfolioFactory,account?.toLowerCase() || '',mode,initialPool?.toLowerCase() || '']);
  if(context.current.identity!==identity || context.current.provider!==provider || context.current.wallet!==wallet){
    sequence.current++;context.current={identity,provider,wallet};
  }
  const enabled=config?.kind==='integrated-v2' && provider;
  const mine=['overview','rewards'].includes(mode);
  const current=ticket=>ticket===sequence.current;
  const isOperator=operatorVerified || same(operator,account);
  const visibleRows=loadedIdentity===identity?rows:[];
  const selectedCurrent=selected && visibleRows.some(row=>same(row.pool,selected.pool)) && same(selected.account,account || ZeroAddress) ? selected:null;
  const frozen=busy || loading || disabled;
  useEffect(()=>{setListingQuantity(selectedCurrent?.availableShares>0n?selectedCurrent.availableShares.toString():'1');setPrice('');},[selectedCurrent?.pool,selectedCurrent?.availableShares]);
  useEffect(()=>{const saved=recentPages.get(cacheKey),cached=saved && Date.now()-saved.savedAt<120_000?saved.result:null;
    setLoadedIdentity(cached?identity:'');setOrders([]);setOrderPool(null);setOrderCursor(null);setRows(cached?.items || []);
    setSelected(initialPool?cached?.items[0] || null:null);setChild(initialPool?cached?.items[0]?.children.find(item=>!item.sold)?.pool || '':'');
    setPreview(null);setError('');setReadRetry(null);setReadFailed(false);
    setOperator(cached?.operator || null);setCursor(cached?.nextCursor ?? null);setBusy(false);setLoading(false);
    if(enabled && (!mine || account))void load();},[identity,provider,wallet]);
  useEffect(()=>()=>{sequence.current++;},[]);
  async function refreshCapacity(active=()=>true){
    setCapacityBusy(true);
    try{const [value,page]=await Promise.all([fetchCapacityReference({baseUrl:QUOTE_BASE}),fetchQuotePage({page:1,pageSize:50,sort:'daily_capacity_price_low'},{baseUrl:QUOTE_BASE})]);
      if(active()){setDailyReference(value);setCapacitySample(portfolioDailyCapSample(page.rows,Date.now(),quoteIssue));setDailyReferenceError('');}}
    catch(problem){if(active()){setDailyReference(null);setCapacitySample(null);setDailyReferenceError(brief(problem));}}
    finally{if(active())setCapacityBusy(false);}
  }
  useEffect(()=>{
    if(mode!=='operator'||!enabled)return;
    let active=true;
    void refreshCapacity(()=>active);
    return ()=>{active=false;};
  },[mode,enabled,config?.portfolioFactory]);

  function retryRead(read,ticket){return retryReadRound(read,{isCurrent:()=>current(ticket),
    onAttempt:progress=>{if(current(ticket)){setReadFailed(false);setReadRetry(progress.attempt>1?progress:null);}},
    onRetry:progress=>{if(current(ticket))setReadRetry(progress);}});}

  async function load(nextCursor=0){
    const ticket=++sequence.current;setLoading(true);setError('');setPreview(null);
    try{
      const result=await retryRead(async()=>{
        if(initialPool){const ctx=await readPortfolioContext(config,provider);const row=await readPortfolio(ctx,initialPool,account || ZeroAddress);await ctx.canonical();return {items:[row],nextCursor:null,operator:ctx.operator};}
        return readPortfolioPage(config,provider,{account:account || undefined,mine,cursor:nextCursor});
      },ticket);
      if(result===READ_CANCELLED||!current(ticket))return;
      if(!nextCursor){recentPages.delete(cacheKey);recentPages.set(cacheKey,{savedAt:Date.now(),result});
        if(recentPages.size>8)recentPages.delete(recentPages.keys().next().value);}
      setRows(previous=>nextCursor? [...previous,...result.items.filter(item=>!previous.some(p=>same(p.pool,item.pool)))]:result.items);
      setLoadedIdentity(identity);setCursor(result.nextCursor);setOperator(result.operator);if(!nextCursor){setSelected(initialPool?result.items[0]:null);if(initialPool)setChild(result.items[0].children.find(c=>!c.sold)?.pool || '');}
    }catch(problem){if(current(ticket)){setError(brief(problem));setReadFailed(true);if(!nextCursor){setRows([]);setSelected(null);setOperator(null);setLoadedIdentity('');}}}
    finally{if(current(ticket)){setLoading(false);setReadRetry(null);}}
  }
  async function select(row){
    const ticket=++sequence.current;setLoading(true);setError('');setPreview(null);setOrders([]);setOrderPool(null);setOrderCursor(null);
    try{const details=await retryRead(async()=>{const ctx=await readPortfolioContext(config,provider);const result=await readPortfolio(ctx,row.pool,account || ZeroAddress);await ctx.canonical();return result;},ticket);
      if(details!==READ_CANCELLED&&current(ticket)){setSelected(details);setChild(details.children.find(c=>!c.sold)?.pool || '');}
    }catch(problem){if(current(ticket)){setSelected(null);setError(brief(problem));setReadFailed(true);}}
    finally{if(current(ticket)){setLoading(false);setReadRetry(null);}}
  }
  async function moreChildren(){
    if(!selectedCurrent)return;const ticket=++sequence.current;setLoading(true);setError('');
    try{const more=await retryRead(async()=>{const ctx=await readPortfolioContext(config,provider,selectedCurrent.blockNumber);
      if(ctx.block.hash.toLowerCase()!==selectedCurrent.blockHash.toLowerCase())throw new Error('项目区块已变化，请重新展开项目。');
      const result=await readPortfolioChildren(ctx,selectedCurrent.pool,selectedCurrent.childCount,BigInt(selectedCurrent.children.length));await ctx.canonical();return result;},ticket);
      if(more!==READ_CANCELLED&&current(ticket))setSelected({...selectedCurrent,children:[...selectedCurrent.children,...more]});
    }catch(problem){if(current(ticket)){setError(brief(problem));setReadFailed(true);}}finally{if(current(ticket)){setLoading(false);setReadRetry(null);}}
  }
  async function loadOrders(nextCursor){
    if(!selectedCurrent)return;const target=selectedCurrent.pool,ticket=++sequence.current;setLoading(true);setError('');setPreview(null);
    try{const result=await retryRead(()=>readPortfolioOrders(config,provider,target,{cursor:nextCursor}),ticket);
      if(result!==READ_CANCELLED&&current(ticket)){setOrderPool(target);setOrders(previous=>nextCursor?[...previous,...result.items]:result.items);setOrderCursor(result.nextCursor);}
    }catch(problem){if(current(ticket)){setOrders([]);setOrderPool(null);setError(brief(problem));setReadFailed(true);}}finally{if(current(ticket)){setLoading(false);setReadRetry(null);}}
  }
  async function prepare(action,pool=selectedCurrent?.pool){
    if(!account || !wallet){onConnect?.();return;}const ticket=++sequence.current;setBusy(true);setError('');setReadFailed(false);setPreview(null);
    try{const input={config,provider:wallet,account,pool,action};const result=await preparePortfolioAction(input);
      if(current(ticket))setPreview({input:{...input, action: {...action, ...(result.procurement ? { expectedPurchaseWei: result.procurement.priceWei.toString(), frozenOrder: result.procurement.frozenOrder } : {}), ...(result.marketTrade?.seller ? {expectedSeller:result.marketTrade.seller,expectedPricePerUnitWei:result.marketTrade.pricePerUnitWei.toString()}: {})}},result,identity,ticket});
    }catch(problem){if(current(ticket))setError(brief(problem));}finally{if(current(ticket))setBusy(false);}
  }
  async function submit(){
    if(!preview || preview.identity!==identity || !current(preview.ticket) || frozen)return;
    const ticket=preview.ticket;setBusy(true);setError('');
    try{const checked=await preparePortfolioAction(preview.input);
      if(!current(ticket)||!sameUnsignedIntent(checked.transaction,preview.result.transaction))throw new Error('确认内容已变化，请重新预览。');
      const result=await onSend(checked,preview.input);
      if(!current(ticket))return;setPreview(null);if(result?.status==='confirmed')await load();
    }catch(problem){if(current(ticket))setError(brief(problem));}finally{if(current(ticket))setBusy(false);}
  }
  const act=(kind,extra={})=>void prepare({kind,...extra});
  const p=selectedCurrent?.proposal;
  const nextRound=selectedCurrent?.nextRoundAt ?? 0n;
  const pChild=selectedCurrent?.children.find(c=>same(c.pool,p?.child));
  return <section id="multi-miner-projects" className="panel portfolio-panel" aria-label={T('多矿机预算项目')}>
    <div className="portfolio-heading"><div><h2><Layers3 size={21}/>{T("多矿机预算项目")}</h2><p>{T("整个项目共 100 份，共同持有项目内多台矿机。每台矿机的出售单独表决，余款与收益归项目份额持有人。")}</p></div>
      <button className="btn secondary" disabled={!enabled || frozen || mine&&!account} onClick={()=>void load()}><RefreshCw size={15}/>{T("刷新项目")}</button></div>
    {!enabled ? <p role="status">{T("预算项目合约尚未完成部署验收。")}</p> : mine&&!account ? <button className="btn" onClick={onConnect}>{T("连接钱包查看项目权益")}</button> : <>
      {error&&<div className="portfolio-error" role="alert"><p>{T(error)}</p>{readFailed&&<button className="btn secondary" disabled={frozen} onClick={()=>void load()}>{locale==='en'?'Retry portfolio data':'重新读取预算项目'}</button>}</div>}
      {loading&&<p role="status">{readRetry?(locale==='en'?`Portfolio data is temporarily unavailable. Retrying automatically (${readRetry.attempt}/${readRetry.maxAttempts})…`:`预算数据暂时未就绪，正在自动重试（${readRetry.attempt}/${readRetry.maxAttempts}）…`):T("正在核对预算项目…")}</p>}
      {mode==='operator'&&isOperator&&<section id="multi-miner-create" className="portfolio-create"><h3>{T("创建多矿机预算项目")}</h3><p>{T("预算项目固定 100 份；总预算、单机绝对上限及换算后的每 H 限价写入合约，采购不能突破这些链上限额。")}</p><p>{T("先创建共享 100 份的预算项目；募满后在项目中设置本批最多采购台数（1–20 台），从当前合格挂单逐台核验并买入。矿机可能在募集期间售出，因此创建时不锁定具体编号；同一项目可用剩余预算继续采购下一批。")}</p>
        <p>{T('Firsto 市场参考日产能价')}: <strong>{dailyReference&&!referenceIssue(dailyReference)?`${displayBnb(dailyReference.dailyCapacityPriceWei)} BNB / (BEM / 天)`:'—'}</strong>{dailyReference&&!referenceIssue(dailyReference)?` · ${new Date(dailyReference.observedAt).toLocaleString(locale==='en'?'en-GB':'zh-CN')}`:dailyReferenceError?` · ${dailyReferenceError}`:''} <button className="btn secondary" disabled={capacityBusy} onClick={()=>void refreshCapacity()}>{T('刷新市场产能')}</button></p>
        <p>{T('输入日产能价上限后，系统按当前 Firsto 样本的最低日产出 / H 比率向下折算为链上每 H 上限；合约不会随未来产能变化自动更新。')}</p>
        <div className="portfolio-actions"><label>{T("募集预算（BNB）")}<input inputMode="decimal" placeholder="0.005" value={budget} onChange={e=>setBudget(e.target.value)}/></label><label>{T("单机价格上限（BNB）")}<input inputMode="decimal" value={cap} onChange={e=>setCap(e.target.value)}/></label><label>{T("日产能价上限（BNB / (BEM / 天)）")}<input inputMode="decimal" placeholder="9" value={dailyCap} onChange={e=>setDailyCap(e.target.value)}/></label><label>{T("募集期（小时）")}<input inputMode="numeric" value={fundHours} onChange={e=>setFundHours(e.target.value)}/></label><label>{T("募集结束后购机期（小时）")}<input inputMode="numeric" value={buyHours} onChange={e=>setBuyHours(e.target.value)}/></label><button className="btn" disabled={frozen} onClick={()=>{
          let fields;try{fields=portfolioCreateForm({budget,absoluteCap:cap,dailyCap,capacitySample, fundHours,buyHours});setBudget(fields.budget);}
          catch(problem){setError(brief(problem));return;}
          const now=BigInt(Math.floor(Date.now()/1000)),fundingDeadline=now+BigInt(fundHours)*3600n;
          void prepare({kind:'createPortfolio',budget:fields.budget,absoluteCap:fields.absoluteCap,dailyCap:fields.dailyCap,unitCap:fields.unitCap,fundingDeadline:fundingDeadline.toString(),purchaseDeadline:(fundingDeadline+BigInt(buyHours)*3600n).toString()},null);
        }}>{T("预览创建预算项目")} <ArrowRight size={15}/></button></div></section>}
      {!loading&&!error&&!visibleRows.length&&<p>{locale==='en'?(mine?'No portfolios related to this wallet.':'No portfolios currently available.'):(mine?'当前没有与你相关的预算项目。':'当前没有预算项目。')}</p>}
      <div className="portfolio-cards">{visibleRows.map(row=><button key={row.pool} className={`portfolio-card${same(selectedCurrent?.pool,row.pool)?' selected':''}`} disabled={frozen} onClick={()=>void select(row)}>
        <strong>{T("预算项目")} {shortAddress(row.pool)}</strong><span>{T(states[Number(row.state)])} · {row.activeChildCount.toString()} {T("台运行 /")} {row.childCount.toString()} {T("台购入")}</span>
        <dl><div><dt>{T("预算")}</dt><dd>{displayBnb(row.budgetWei)} BNB</dd></div><div><dt>{T("已认购")}</dt><dd>{row.totalSupply.toString()} {T("/ 100 份")}</dd></div><div><dt>{T("我的份额")}</dt><dd>{account?row.shares.toString():'—'}</dd></div><div><dt>{T("可领 BNB")}</dt><dd>{account?displayBnb(row.withdrawableBnb):'—'}</dd></div><div><dt>{T("已入账 BEM")}</dt><dd>{account?amount(row.claimableBem,8,3):'—'}</dd></div></dl><span>{T("查看矿机与项目操作")} <ChevronDown size={15}/></span>
      </button>)}</div>
      {cursor!==null&&<button className="btn secondary" disabled={frozen} onClick={()=>void load(cursor)}>{T("加载更多预算项目")}</button>}
      {selectedCurrent&&<div className="portfolio-detail"><div className="portfolio-heading"><h3>{T("项目详情")}</h3><a href={explorerAddress(selectedCurrent.pool)} target="_blank" rel="noopener noreferrer">{shortAddress(selectedCurrent.pool)} ↗</a></div>
        <p>{T("每份")} {displayBnb(selectedCurrent.unitPriceWei)} {T("BNB · 已购机")} {displayBnb(selectedCurrent.spentWei)} {T("BNB · 我的可转份额")} {selectedCurrent.availableShares.toString()}{T("。未领取 BEM 随转出份额按比例移动；历史 BNB 余款和卖款留给原持有人。")}</p>
        <div className="portfolio-actions">
          {selectedCurrent.state===0n&&<><label>{T("认购份数")}<input type="number" min="1" max="100" step="1" value={quantity} onChange={e=>setQuantity(e.target.value)}/></label><button className="btn" disabled={frozen} onClick={()=>act('deposit',{quantity})}>{T("预览认购")}</button>{selectedCurrent.shares>0n&&<button className="btn secondary" disabled={frozen} onClick={()=>act('withdrawDeposit')}>{T("撤回全部认购")}</button>}{selectedCurrent.timestamp>=selectedCurrent.fundingDeadline&&<button className="btn secondary" disabled={frozen} onClick={()=>act('finalizeFundingFailure')}>{T("开启募集失败退款")}</button>}</>}
          {selectedCurrent.state===1n&&selectedCurrent.timestamp>=selectedCurrent.purchaseDeadline&&<button className="btn" disabled={frozen} onClick={()=>act('finalizeAcquisition')}>{T("结束购机并结算余款")}</button>}
          {selectedCurrent.fundingFailed&&selectedCurrent.state===5n&&selectedCurrent.shares>0n&&<button className="btn" disabled={frozen} onClick={()=>act('claimFailedFunding')}>{T("结算募集退款")}</button>}
          {selectedCurrent.withdrawableBnb>0n&&<button className="btn" disabled={frozen} onClick={()=>act('withdrawBnb')}>{T("领取")} {displayBnb(selectedCurrent.withdrawableBnb)} BNB</button>}
          {selectedCurrent.claimableBem>0n&&<button className="btn" disabled={frozen} onClick={()=>act('claimBem')}>{T("领取")} {amount(selectedCurrent.claimableBem,8,3)} BEM</button>}
        </div>
        <div className="portfolio-child-table"><table><thead><tr><th>{T("项目内矿机")}</th><th>{T("采购来源 / 成本")}</th><th>{T("状态")}</th><th>{T("操作")}</th></tr></thead><tbody>{selectedCurrent.children.map(item=><tr key={item.pool}><td><a href={explorerAddress(item.pool)} target="_blank" rel="noopener noreferrer">#{item.tokenId.toString()} · {shortAddress(item.pool)}</a></td><td>{T(item.official?'官网':'Firsto')} · {displayBnb(item.costWei)} BNB</td><td>{T(item.sold?'已归集卖款':states[Number(item.state)])}</td><td><button className="btn secondary" disabled={frozen||item.sold} onClick={()=>act('collectChildBem',{child:item.pool})}>{T("归集该台 BEM")}</button>{item.state===3n&&<button className="btn" disabled={frozen} onClick={()=>onBuyChild?.(item.pool)}>{T("预览 Firsto 购买")}</button>}</td></tr>)}</tbody></table></div>
        {selectedCurrent.children.length<Number(selectedCurrent.childCount)&&<button className="btn secondary" disabled={frozen} onClick={()=>void moreChildren()}>{T("加载更多子矿机")}</button>}
        {!selectedCurrent.children.length&&<p>{T("该项目尚未购入矿机。")}</p>}
        {onShare&&<button className="btn secondary" disabled={frozen} onClick={()=>onShare(selectedCurrent)}>{locale==='en'?'Share this portfolio':'分享预算项目'}</button>}
        <PortfolioCapacity key={`${selectedCurrent.pool}:${selectedCurrent.blockHash}`} config={config} provider={provider} portfolio={selectedCurrent} locale={locale}/>
        {client&&<PortfolioHistory key={`${selectedCurrent.pool}:${account || ''}`} client={client} config={config} pool={selectedCurrent.pool} account={account} locale={locale}/>}
        {mode==='operator'&&isOperator&&selectedCurrent.state===1n&&onSendQueue&&<BudgetPurchaseQueue config={config} provider={provider} wallet={wallet} account={account} portfolio={selectedCurrent} disabled={frozen} onSend={onSendQueue} onComplete={()=>void select(selectedCurrent)} locale={locale}/>}

        {selectedCurrent.shareTradingAllowed&&selectedCurrent.availableShares>0n&&<details><summary>{T("转移项目份额")}</summary><p>{T("接收人取得对应未领取 BEM 及未来权益；已结算的历史 BNB 余款和卖款保留在你的地址。此操作是赠予转移，不会收取对价。")}</p><div className="portfolio-actions"><label>{T("接收钱包")}<input placeholder="0x…" value={recipient} onChange={e=>setRecipient(e.target.value)}/></label><label>{T("份数")}<input inputMode="numeric" value={quantity} onChange={e=>setQuantity(e.target.value)}/></label><button className="btn" disabled={frozen} onClick={()=>act('transfer',{recipient,quantity})}>{T("预览份额转移")}</button></div></details>}
        {selectedCurrent.shareTradingAllowed&&selectedCurrent.availableShares>0n&&<section aria-label={T("出售我的项目份额")}>
          <h3>{T("出售我的项目份额")}</h3><p>{T("已自动选择当前持仓项目，可售份额：")} {selectedCurrent.availableShares.toString()} / {selectedCurrent.shares.toString()} {T("份")}</p>
          <div className="portfolio-actions"><label>{T("挂牌份数")}<input type="number" min="1" max={selectedCurrent.availableShares.toString()} step="1" value={listingQuantity} onChange={e=>setListingQuantity(e.target.value)}/></label><label>{T("每份价格（BNB）")}<input inputMode="decimal" placeholder="0.005" value={price} onChange={e=>setPrice(e.target.value)}/></label><button className="btn" disabled={frozen} onClick={()=>act('marketList',{quantity:listingQuantity,price})}>{T("预览挂卖份额")}</button></div>
        </section>}
        <details className="portfolio-market"><summary>{T("预算项目份额市场")}</summary><p>{T("买方另付成交价的 1%，卖方从成交价扣除 1%。未领取 BEM 随份额按比例移动，历史 BNB 债权不随份额转移。治理期间暂停新增挂单和成交，原挂单仍可撤销。")}</p>
          <div className="portfolio-actions"><button className="btn secondary" disabled={frozen} onClick={()=>void loadOrders()}>{T("读取本项目挂单")}</button><button className="btn secondary" disabled={frozen||!account} onClick={()=>act('marketWithdraw')}>{T("预览领取预算市场 BNB")}</button></div>
          {same(orderPool,selectedCurrent.pool)&&<><div className="portfolio-child-table"><table><thead><tr><th>{T("订单")}</th><th>{T("卖方")}</th><th>{T("剩余份额 / 每份价")}</th><th>{T("操作")}</th></tr></thead><tbody>{orders.map(order=><tr key={order.id.toString()}><td>#{order.id.toString()}</td><td>{shortAddress(order.seller)}</td><td>{order.remaining.toString()} / {displayBnb(order.pricePerUnitWei)} BNB</td><td>{order.active&&order.remaining>0n? <>{same(order.seller,account)?<button className="btn secondary" disabled={frozen} onClick={()=>act('marketCancel',{orderId:order.id.toString()})}>{T("撤销挂单")}</button>:!order.expired&&<button className="btn" disabled={frozen||!selectedCurrent.shareTradingAllowed} onClick={()=>act('marketFill',{orderId:order.id.toString(),quantity,expectedSeller:order.seller,expectedPricePerUnitWei:order.pricePerUnitWei.toString()})}>{T("预览买入")} {quantity} {T("份")}</button>}{order.expired&&<button className="btn secondary" disabled={frozen} onClick={()=>act('marketExpire',{orderId:order.id.toString()})}>{T("解锁到期挂单")}</button>}</>:T('已结束')}</td></tr>)}</tbody></table></div><label>{T("买入份数")}<input inputMode="numeric" value={quantity} onChange={e=>setQuantity(e.target.value)}/></label>{!orders.length&&<p>{T("暂无本项目挂单。")}</p>}{orderCursor!==null&&<button className="btn secondary" disabled={frozen} onClick={()=>void loadOrders(orderCursor)}>{T("加载更多挂单")}</button>}</>}
        </details>
        {p?<div className="portfolio-governance"><h3>{T("子矿机出售提案 #")}{p.id.toString()}</h3><p>{shortAddress(p.child)} · {displayBnb(p.price)} {T("BNB · 赞成")} {p.yesShares.toString()}/{p.threshold.toString()} {T("份，")}{p.yesMembers.toString()}/{(p.memberCount/2n+1n).toString()} {T("人。提案期间项目份额冻结，其他矿机继续归集收益。")}</p><div className="portfolio-actions">
          {!p.executed&&selectedCurrent.timestamp<p.endsAt&&<><button className="btn" disabled={frozen||p.hasVoted||selectedCurrent.shares===0n} onClick={()=>act('voteChildSale',{proposalId:p.id.toString(),support:true})}>{T("赞成")}</button><button className="btn secondary" disabled={frozen||p.hasVoted||selectedCurrent.shares===0n} onClick={()=>act('voteChildSale',{proposalId:p.id.toString(),support:false})}>{T("反对")}</button><button className="btn" disabled={frozen||p.yesShares<p.threshold||p.yesMembers*2n<=p.memberCount} onClick={()=>act('executeChildSale',{proposalId:p.id.toString()})}>{T("执行该台挂牌")}</button></>}
          {p.executed&&pChild?.state===4n&&<button className="btn" disabled={frozen} onClick={()=>act('settleChildSale')}>{T("归集该台卖款")}</button>}
          {(!p.executed&&selectedCurrent.timestamp>=p.endsAt||p.executed&&pChild?.state===3n&&selectedCurrent.timestamp>=pChild.expiresAt)&&<button className="btn secondary" disabled={frozen} onClick={()=>act('expireChildSale')}>{T("解除过期子机提案")}</button>}
        </div></div>:null}
        {selectedCurrent.state===2n&&selectedCurrent.shares>0n&&(!p || !p.executed&&selectedCurrent.timestamp>=p.endsAt)&&<details><summary>{T("发起逐台出售提案")}</summary><p>{T("预算项目每轮只审议一台矿机，下一轮最早")} {nextRound===0n?T('现在'):new Date(Number(nextRound)*1000).toLocaleString(locale==='en'?'en-GB':'zh-CN')}{T("；未通过提案到期后自动恢复份额转让。")}</p><div className="portfolio-actions"><label>{T("项目内矿机")}<select value={child} onChange={e=>setChild(e.target.value)}>{selectedCurrent.children.filter(c=>!c.sold&&c.state===2n).map(c=><option key={c.pool} value={c.pool}>#{c.tokenId.toString()} · {shortAddress(c.pool)}</option>)}</select></label><label>{T("拟售价格（BNB）")}<input inputMode="decimal" value={price} onChange={e=>setPrice(e.target.value)}/></label><label>{T("观察到的参考价（BNB）")}<input inputMode="decimal" value={reference} onChange={e=>setReference(e.target.value)}/></label><button className="btn" disabled={frozen||!child||selectedCurrent.timestamp<nextRound} onClick={()=>act('proposeChildSale',{child,price,reference,referenceAt:selectedCurrent.timestamp.toString()})}>{T("预览出售提案")}</button></div></details>}
      </div>}

    </>}
    {preview&&preview.identity===identity&&current(preview.ticket)&&<div className="portfolio-confirm" role="dialog" aria-modal="true" aria-label={T('确认预算项目操作')}><div><h3>{T(names[preview.input.action.kind] || preview.input.action.kind)}</h3><p>{T("目标")} {shortAddress(preview.result.transaction.to)} {T("· 区块 #")}{preview.result.blockNumber.toString()}</p><p>{T("本次支付")} {displayBnb(BigInt(preview.result.transaction.value))} BNB + Gas</p><PortfolioConfirmationDetails preview={preview} locale={locale}/>{preview.result.marketTrade&&<p>{T("成交基价")} {displayBnb(preview.result.marketTrade.baseWei)} {T("BNB；买方另付")} {displayBnb(preview.result.marketTrade.buyerFeeWei)} {T("BNB；卖方扣除")} {displayBnb(preview.result.marketTrade.sellerFeeWei)} BNB。</p>}{preview.result.procurement&&<p>{T("来源")} {T(preview.result.procurement.route==='official'?'官网':'Firsto')} {T("· 本次含来源费报价")} {displayBnb(preview.result.procurement.priceWei)} {T("BNB · 合约价格上限")} {displayBnb(preview.result.procurement.capWei)} {T("BNB。款项来自项目预算，本钱包只付 Gas。")}</p>}{preview.result.payoutWei!==null&&<p>{T("已模拟可领取")} {preview.input.action.kind==='claimBem'?amount(preview.result.payoutWei,8,8):displayBnb(preview.result.payoutWei)} {preview.input.action.kind==='claimBem'?'BEM':'BNB'}</p>}{preview.input.action.kind==='transfer'&&<p>{T("向")} {preview.input.action.recipient} {T("转移")} {preview.input.action.quantity} {T("份，无对价。")}</p>}<p>{T("金额按精确链上整数发送；发送前重新核对内容，并先保存交易意图。")}</p><div className="portfolio-actions"><button className="btn secondary" disabled={busy} onClick={()=>setPreview(null)}>{T("返回")}</button><button className="btn" disabled={frozen} onClick={()=>void submit()}>{T("发送到钱包确认")}</button></div></div></div>}
  </section>;
}

function PortfolioConfirmationDetails({preview,locale}){
  const T=text=>portfolioText(locale,text);
  const a=preview.input.action,row=preview.result.row;
  return <>
    {a.kind==='createPortfolio'&&<p>{T("募集预算")} {displayBnbDecimal(a.budget)} {T("BNB / 100 份；单机上限")} {displayBnbDecimal(a.absoluteCap)} BNB；{T("输入的日产能价上限")} {displayBnbDecimal(a.dailyCap)} BNB / (BEM / {T('天')})；{T("换算后的链上每 H 上限")} {displayBnbDecimal(a.unitCap)} {T("BNB / H。募集截至")} {new Date(Number(a.fundingDeadline)*1000).toLocaleString(locale==='en'?'en-GB':'zh-CN')}{T("，购机截至")} {new Date(Number(a.purchaseDeadline)*1000).toLocaleString(locale==='en'?'en-GB':'zh-CN')}。</p>}
    {a.kind==='deposit'&&<p>{T("认购")} {a.quantity} {T("/ 100 份。")}</p>}
    {a.kind==='marketList'&&<p>{T("挂卖")} {a.quantity} {T("份，每份")} {displayBnbDecimal(a.price)} {T("BNB；买卖双方各收成交价的 1%。")}</p>}
    {a.orderId&&<p>{T("份额订单 #")}{a.orderId}{a.quantity?` · ${a.quantity} ${T('份')}`:''}。</p>}
    {a.child&&<p>{T("子矿池")} <a href={explorerAddress(a.child)} target="_blank" rel="noopener noreferrer">{a.child} ↗</a></p>}
    {a.kind==='proposeChildSale'&&<p>{T("拟售价")} {displayBnbDecimal(a.price)} {T("BNB；参考价")} {displayBnbDecimal(a.reference)} {T("BNB；观察时间")} {new Date(Number(a.referenceAt)*1000).toLocaleString(locale==='en'?'en-GB':'zh-CN')}{T("。提案发起后本轮项目份额暂时冻结。")}</p>}
    {['voteChildSale','executeChildSale','settleChildSale','expireChildSale'].includes(a.kind)&&row?.proposal&&<p>{T("子矿池")} {shortAddress(row.proposal.child)}{T("；提案 #")}{row.proposal.id.toString()}{T("；挂牌价")} {displayBnb(row.proposal.price)} BNB。{a.kind==='voteChildSale'?T(a.support?'本次投赞成票。':'本次投反对票。'):''}</p>}
  </>;
}

/** Parent-only history: never add child Harvested events to the parent's BemCollected totals. */
function PortfolioHistory({client,config,pool,account,locale}){
  const T=text=>portfolioText(locale,text);
  const [history,setHistory]=useState(null),[error,setError]=useState(''),[busy,setBusy]=useState(false),[days,setDays]=useState(7);
  const epoch=useRef(0);useEffect(()=>()=>{epoch.current++;},[]);
  async function load(window=days,more=false){const ticket=++epoch.current;setBusy(true);setError('');
    try{
      const yieldResult=more?{data:history.yield,source:history.source}:await client.readYield({pool,account:account || undefined,days:window});
      if(!same(yieldResult.source.portfolioFactory,config.portfolioFactory)||!same(yieldResult.source.portfolioMarket,config.portfolioMarket))throw new Error('预算历史记录来源不一致。');
      const events=await client.readActivity({pool,source:yieldResult.source,...(more?{cursor:history.nextCursor}:{})});
      if(ticket===epoch.current)setHistory({yield:yieldResult.data,source:yieldResult.source,items:more?[...history.items,...events.items]:events.items,nextCursor:events.nextCursor});
    }catch(problem){if(ticket===epoch.current){setHistory(null);setError(brief(problem));}}
    finally{if(ticket===epoch.current)setBusy(false);}
  }
  function download(){const url=URL.createObjectURL(new Blob([exportActivityCsv(history.items)],{type:'text/csv;charset=utf-8'}));const a=document.createElement('a');a.href=url;a.download='BEMine-budget-records.csv';a.click();URL.revokeObjectURL(url);}
  return <details><summary>{T("项目收益与公开记录")}</summary><p>{T("这里仅统计进入本预算项目的 BEM，避免与子矿池重复计入；个人未领取权益以项目当前读数为准。")}</p>
    <button className="btn secondary" disabled={busy} onClick={()=>void load()}>{T("读取项目收益与记录")}</button>{busy&&<p role="status">{T("正在读取项目记录…")}</p>}{error&&<p role="alert">{T(error)}</p>}
    {history&&<><LiveYieldChart data={history.yield} locale={locale} days={days} onDays={next=>{if(!busy){setDays(next);void load(next);}}}/><div className="portfolio-child-table"><table><thead><tr><th>{T("区块")}</th><th>{T("记录")}</th><th>{T("链上凭证")}</th></tr></thead><tbody>{history.items.map(item=><tr key={`${item.blockNumber}:${item.transactionIndex}:${item.logIndex}`}><td>{item.blockNumber}</td><td>{item.event}</td><td><a href={explorerTransaction(item.transactionHash)} target="_blank" rel="noopener noreferrer">{T("查看交易 ↗")}</a></td></tr>)}</tbody></table></div>{!history.items.length&&<p>{T("暂无该项目已确认记录。")}</p>}<div className="portfolio-actions"><button className="btn secondary" onClick={download}>{T("导出已加载记录")}</button>{history.nextCursor!==null&&<button className="btn secondary" disabled={busy} onClick={()=>void load(days,true)}>{T("加载更多记录")}</button>}</div></>}
  </details>;
}
