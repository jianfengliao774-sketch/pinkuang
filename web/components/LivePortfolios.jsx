'use client';
import { useEffect, useRef, useState } from 'react';
import { formatEther, ZeroAddress } from 'ethers';
import { abi, uint } from '../lib/chain-client.mjs';
import { applyMarketOrderFeedback, marketOrderFeedback } from '../lib/market-order-feedback.mjs';
import { Layers3, RefreshCw, ArrowRight, ChevronDown } from 'lucide-react';
import { genesisPortfolioProposalGate, portfolioCreateActionReady, portfolioPageActionReady, portfolioSelectedActionReady, portfolioOrderActionReady, readPortfolioPage, readPortfolioDisplayRow, readPortfolioDisplayChildren, readPortfolioOrders, preparePortfolioAction } from '../lib/live-portfolios.mjs';
import { amount, shortAddress, explorerAddress, explorerTransaction, exportActivityCsv } from '../lib/live-view.mjs';
import { displayDecimal } from '../lib/amount-display.mjs';
import { READ_CANCELLED, retryReadRound } from '../lib/read-retry.mjs';
import { displayOnlySnapshot, invalidateDisplaySnapshots, readDisplaySnapshot, writeDisplaySnapshot } from '../lib/display-snapshot.mjs';
import { rememberPortfolioDisplay, readPortfolioDisplay, clearPortfolioDisplays } from '../lib/portfolio-display-cache.mjs';
import { fundingAmount } from '../lib/funding-amount.mjs';
import LiveYieldChart from './LiveYieldChart';
import ActivityOperation from './ActivityOperation';
import './LivePortfolios.css';
import { portfolioText } from '../lib/portfolio-copy.mjs';
import { portfolioCreateForm } from '../lib/portfolio-create-form.mjs';
import { fetchCapacityReference, fetchQuotePage, quoteIssue, referenceIssue } from '../../deploy/src/pricing.ts';
import { QUOTE_BASE } from '../lib/operator-quotes.mjs';
import { portfolioDailyCapSample } from '../lib/portfolio-daily-cap.mjs';
import PortfolioCapacity from './PortfolioCapacity';
import BudgetPurchaseQueue from './BudgetPurchaseQueue';

const names = { deposit:'认购预算份额',withdrawDeposit:'撤回我的认购',finalizeFundingFailure:'结束募集并开启退款',claimFailedFunding:'结算我的募集退款',
  finalizeAcquisition:'结束购机并结算余款',collectChildBem:'归集该台 BEM',claimBem:'领取项目 BEM',withdrawBnb:'领取项目 BNB',transfer:'转移项目份额',
  proposeChildSale:'提出子矿机出售',voteChildSale:'提交子矿机表决',executeChildSale:'执行子矿机挂牌',settleChildSale:'归集该台卖款',expireChildSale:'解除过期子机提案',
  createPortfolio:'创建预算项目',autoPurchase:'自动核价采购',marketList:'挂卖项目份额',marketFill:'买入项目份额',marketCancel:'撤回份额挂单',marketExpire:'解锁到期份额挂单',marketWithdraw:'领取预算市场 BNB' };
const states = ['募集中','购机期','运行中','出售中','已结束','可退款'];
const same = (a,b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const brief = error => error?.shortMessage || error?.message || '预算项目读取未完成。';
const officialPriceWithFeeCeiling = value => { const price=BigInt(value); return price+(price+99n)/100n; };
const recentPages = new Map();
const recentCapacityReferences = new Map();
const recentMarketCredits = new Map(), recentMarketOrders = new Map();
let recentHistories = new WeakMap();
export const clearRecentPortfolioDisplays = () => { recentPages.clear(); clearPortfolioDisplays(); recentMarketCredits.clear(); recentMarketOrders.clear(); recentHistories = new WeakMap(); };
const displayStorage = () => { try { return window.sessionStorage; } catch { return null; } };

function PortfolioSaleStatus({candidate,stage,locale}){
  const T=text=>portfolioText(locale,text);
  const reference=candidate.saleReference;
  const review=candidate.saleReview;
  const status=stage==='genesis'
    ? candidate.threshold===60n ? '低于购机成本，需至少 60 份赞成；此阶段不使用平台折价审核。'
      : '不低于购机成本，需人数与份额过半；此阶段不使用平台折价审核。'
    : !reference?.available ? '市场参考价不可用，挂牌暂不可执行。'
      : candidate.reviewRequired ? !review?.available ? '平台审核状态不可用，挂牌暂不可执行。'
        : review.status===2n ? '平台已驳回该提案，禁止折价挂牌。'
        : candidate.reviewApproved ? '报价需人工审核，平台已批准。'
        : '报价需人工审核，等待管理员处理。'
      : '报价符合免审核范围，无需额外审核。';
  return <p role="status">{stage!=='genesis'&&<>{T('Firsto 市场参考价：')}{reference?.available?`${amount(reference.priceWei)} BNB · ${new Date(Number(reference.observedAt)*1000).toLocaleString(locale==='en'?'en-GB':'zh-CN')}`:T('暂不可用')}{T('。')}</>}{T(status)}</p>;
}

/** A parent project owns its miners. Its 100 shares are never counted once per child. */
export default function LivePortfolios({ config, provider, client, locale, account, wallet, mode = 'pools', initialPool, disabled, onConnect, onSend, onSendQueue, onAuthenticateQueue, onShare, onBuyChild, onReadStateChange, onSourceReorg, renderDirectory, operatorVerified = false, refreshKey = 0, displayRefreshKey = refreshKey, marketTransactions = [] }) {
  const T=text=>portfolioText(locale,text);
  const [rows,setRows]=useState([]),[cursor,setCursor]=useState(null),[selected,setSelected]=useState(null),[operator,setOperator]=useState(null),[listingSource,setListingSource]=useState(null);
  const [loading,setLoading]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(''),[preview,setPreview]=useState(null);
  const [readRetry,setReadRetry]=useState(null),[readFailed,setReadFailed]=useState(false);
  const [freshRead,setFreshRead]=useState(false);
  const [selectedProof,setSelectedProof]=useState(null);
  const [loadedIdentity,setLoadedIdentity]=useState(''),[orders,setOrders]=useState([]),[orderCursor,setOrderCursor]=useState(null),[orderPool,setOrderPool]=useState(null),[orderSource,setOrderSource]=useState(null);
  const [listingQuantity,setListingQuantity]=useState('1');
  const [marketCredit,setMarketCredit]=useState(null),[marketCreditError,setMarketCreditError]=useState(''),[marketCreditLoading,setMarketCreditLoading]=useState(false);
  const marketReadSequence=useRef(0);
  const [quantity,setQuantity]=useState('1'),[recipient,setRecipient]=useState(''),[child,setChild]=useState(''),[price,setPrice]=useState(''),[reference,setReference]=useState('');
  const [budget,setBudget]=useState(''),[cap,setCap]=useState(''),[dailyCap,setDailyCap]=useState(''),[fundHours,setFundHours]=useState('24'),[buyHours,setBuyHours]=useState('48');
  const [editingAmount,setEditingAmount]=useState(null);
  const inputAmount=(name,value)=>{if(editingAmount===name||!value)return value;try{return fundingAmount(value).display;}catch{return value;}};
  const [dailyReference,setDailyReference]=useState(null),[dailyReferenceError,setDailyReferenceError]=useState(''),[capacitySample,setCapacitySample]=useState(null),[capacityBusy,setCapacityBusy]=useState(false);
  const context=useRef({}), sequence=useRef(0), refreshSeen=useRef(null);
  const identity=`${config?.artifactDigest || ''}:${config?.stage || ''}:${config?.portfolioFactory || ''}:${account || ''}:${mode}:${initialPool || ''}`;
  const cacheKey=JSON.stringify([config?.artifactDigest,config?.stage,config?.portfolioFactory,account?.toLowerCase() || '',['overview','rewards'].includes(mode)?'mine':mode,initialPool?.toLowerCase() || '',config?.displayOnly?displayRefreshKey:null]);
  const marketCreditKey=JSON.stringify([config?.artifactDigest,config?.portfolioMarket,account?.toLowerCase() || '',config?.displayOnly?refreshKey:null]);
  const marketOrderKey=pool=>JSON.stringify([config?.artifactDigest,config?.portfolioMarket,account?.toLowerCase() || '',pool?.toLowerCase(),config?.displayOnly?refreshKey:null]);
  if(context.current.identity!==identity || context.current.provider!==provider || context.current.wallet!==wallet){
    sequence.current++;context.current={identity,provider,wallet};
  }
  const enabled=config?.kind==='integrated-v2' && provider;
  const mine=['overview','rewards'].includes(mode);
  const current=ticket=>ticket===sequence.current;
  const invalidateDisplayOnReorg=problem=>{
    if(problem?.code!=='source_reorg')return;
    invalidateDisplaySnapshots(displayStorage(),config?.manifest||config);
    clearRecentPortfolioDisplays();
    onSourceReorg?.(problem);
  };
  const isOperator=operatorVerified || same(operator,account);
  const visibleRows=loadedIdentity===identity?rows:[];
  const selectedCurrent=loadedIdentity===identity && selected && same(selected.account,account || ZeroAddress) ? selected:null;
  const fundingDeadlineReached=selectedCurrent?.state===0n
    && typeof selectedCurrent.timestamp==='bigint' && selectedCurrent.timestamp>0n
    && typeof selectedCurrent.fundingDeadline==='bigint' && selectedCurrent.fundingDeadline>0n
    && selectedCurrent.timestamp>=selectedCurrent.fundingDeadline;
  const selectedProofCurrent=!!selectedCurrent && selectedProof?.identity===identity
    && selectedProof.provider===provider && selectedProof.wallet===wallet
    && same(selectedProof.pool,selectedCurrent.pool);
  const browseFrozen=busy || loading || disabled || readFailed;
  const pageActionReady=portfolioPageActionReady({config,freshRead,listingSource,initialPool});
  const createFrozen=busy || disabled || !portfolioCreateActionReady({config,operatorVerified,
    operator,currentOperatorRead:pageActionReady,wallet,account});
  const frozen=browseFrozen || !portfolioSelectedActionReady({config,selectedProofCurrent});
  const orderActionsFrozen=browseFrozen || !portfolioOrderActionReady({config,selectedProofCurrent,
    source:orderSource,orderPool,selectedPool:selectedCurrent?.pool});
  const actionFrozen=kind=>{
    if(kind==='createPortfolio')return createFrozen;
    const market={marketFill:'fill',marketCancel:'cancel',marketExpire:'expire',marketWithdraw:'withdrawBnb'};
    if(['marketFill','marketCancel','marketExpire'].includes(kind))return browseFrozen || !portfolioOrderActionReady({config,selectedProofCurrent,
      source:orderSource,orderPool,selectedPool:selectedCurrent?.pool,action:market[kind]});
    return browseFrozen || !portfolioSelectedActionReady({config,selectedProofCurrent,action:market[kind]||kind,
      targetType:kind==='marketWithdraw'?'portfolioMarket':'portfolio'});
  };
  useEffect(() => {
    onReadStateChange?.({ busy: busy || loading || !!preview, failed: readFailed, current: freshRead,
      source: loadedIdentity === identity ? listingSource : null });
    return () => onReadStateChange?.({ busy: false, failed: false, current: false, source: null });
  }, [busy, loading, readFailed, preview, freshRead, loadedIdentity, identity, listingSource]);
  useEffect(()=>{setListingQuantity(selectedCurrent?.availableShares>0n?selectedCurrent.availableShares.toString():'1');setPrice('');},[selectedCurrent?.pool]);
  useEffect(()=>{
    setMarketCredit(null);setMarketCreditError('');setMarketCreditLoading(false);
    if(selectedCurrent&&account&&provider)void loadMarketCredit();
    return()=>{marketReadSequence.current++;};
  },[identity,provider,selectedCurrent?.pool,refreshKey]);
  useEffect(()=>{const saved=recentPages.get(cacheKey),cached=saved && Date.now()-saved.savedAt<120_000
      ?displayOnlySnapshot(saved.result,config?.manifest || config,saved.savedAt)
      :readDisplaySnapshot(displayStorage(),config?.manifest || config,`portfolios:${cacheKey}`,
        config?.productFamily==='fresh-v4'?{maxAgeMs:30*60_000}:{});
    const cachedDetail=initialPool?readPortfolioDisplay(config,initialPool,account,Date.now(),config?.displayOnly?refreshKey:0):null;
    setLoadedIdentity(cached || cachedDetail ? identity : '');setOrders([]);setOrderPool(null);setOrderCursor(null);setOrderSource(null);
    setRows(initialPool && cachedDetail ? [cachedDetail] : cached?.items || []);
    setListingSource(initialPool && cachedDetail ? cachedDetail.displaySource || cached?.source || null : cached?.source || null);
    const reusable=config?.displayOnly===true && (!!cachedDetail || !!saved && Date.now()-saved.savedAt<120_000 && !!cached);
    const restoredDetail=initialPool ? cachedDetail || cached?.items[0] || null : null;
    if(cachedDetail)setLoadedIdentity(identity);
    setSelected(initialPool?cachedDetail || cached?.items[0] || null:null);setChild(initialPool?(cachedDetail || cached?.items[0])?.children.find(item=>!item.sold)?.pool || '':'');
    setPreview(null);setError('');setReadRetry(null);setReadFailed(false);setFreshRead(reusable);setSelectedProof(reusable&&restoredDetail
      ?{identity,provider,wallet,pool:restoredDetail.pool}:null);
    setOperator(cached?.operator || null);setCursor(cached?.nextCursor ?? null);setBusy(false);setLoading(false);
    if(enabled && (!mine || account) && !reusable)void load();},[identity,provider,wallet]);
  useEffect(()=>()=>{sequence.current++;},[]);
  useEffect(()=>{
    if(refreshSeen.current?.identity!==identity){refreshSeen.current={identity,key:displayRefreshKey};return;}
    if(refreshSeen.current.key===displayRefreshKey||preview||busy||loading)return;
    refreshSeen.current={identity,key:displayRefreshKey};
    if(enabled&&(!mine||account))void load();
  },[identity,displayRefreshKey,preview,busy,loading]);
  async function refreshCapacity(active=()=>true,force=false){
    setCapacityBusy(true);
    try{
      const key=JSON.stringify([QUOTE_BASE,config?.artifactDigest,config?.portfolioFactory,refreshKey]);
      let saved=config?.displayOnly&&!force?recentCapacityReferences.get(key):null;
      if(!saved || Date.now()-saved.savedAt>=120000){
        saved={savedAt:Date.now()};const entry=saved;
        saved.promise=Promise.all([fetchCapacityReference({baseUrl:QUOTE_BASE}),fetchQuotePage({page:1,pageSize:50,sort:'daily_capacity_price_low'},{baseUrl:QUOTE_BASE})])
          .catch(error=>{if(recentCapacityReferences.get(key)===entry)recentCapacityReferences.delete(key);throw error;});
        if(config?.displayOnly){recentCapacityReferences.set(key,saved);if(recentCapacityReferences.size>32)recentCapacityReferences.delete(recentCapacityReferences.keys().next().value);}
      }
      const [value,page]=await saved.promise;
      if(active()){setDailyReference(value);setCapacitySample(portfolioDailyCapSample(page.rows,Date.now(),quoteIssue));setDailyReferenceError('');}}
    catch(problem){if(active()){setDailyReference(null);setCapacitySample(null);setDailyReferenceError(brief(problem));}}
    finally{if(active())setCapacityBusy(false);}
  }
  useEffect(()=>{
    if(mode!=='operator'||!enabled)return;
    let active=true;
    void refreshCapacity(()=>active);
    return ()=>{active=false;};
  },[mode,enabled,config?.portfolioFactory,refreshKey]);

  function retryRead(read,ticket){return retryReadRound(read,{isCurrent:()=>current(ticket),
    onAttempt:progress=>{if(current(ticket)){setReadFailed(false);setReadRetry(progress.attempt>1?progress:null);}},
    onRetry:progress=>{if(current(ticket))setReadRetry(progress);}});}

  async function load(nextCursor=0){
    const ticket=++sequence.current,selectedPool=!nextCursor?selectedCurrent?.pool:null;
    if(!nextCursor)setSelectedProof(null);
    setLoading(true);setError('');
    try{
      const result=await retryRead(async()=>{
        if(initialPool){const result=await readPortfolioDisplayRow(config,provider,initialPool,account || ZeroAddress);
          return {items:[result.item],nextCursor:null,operator:result.operator,source:result.source};}
        const [page,detail]=await Promise.all([
          readPortfolioPage(config,provider,{account:account || undefined,mine,cursor:nextCursor}),
          selectedPool?readPortfolioDisplayRow(config,provider,selectedPool,account || ZeroAddress).then(result=>result.item):Promise.resolve(null),
        ]);
        return {...page,selectedDetail:detail};
      },ticket);
      if(result===READ_CANCELLED||!current(ticket))return;
      const {selectedDetail,...page}=result;
      if(initialPool&&page.items[0])rememberPortfolioDisplay(config,page.items[0],account,Date.now(),config.displayOnly?refreshKey:0);
      if(selectedDetail)rememberPortfolioDisplay(config,selectedDetail,account,Date.now(),config.displayOnly?refreshKey:0);
      setFreshRead(initialPool ? !!page.items[0] : !!page.source && (page.source.displayOnly === true || page.source.stale !== true));
      if(!nextCursor && (initialPool ? page.items[0] : selectedDetail))
        setSelectedProof({identity,provider,wallet,pool:(initialPool ? page.items[0] : selectedDetail).pool});
      if(!nextCursor){recentPages.delete(cacheKey);recentPages.set(cacheKey,{savedAt:Date.now(),result:page});
        if(recentPages.size>8)recentPages.delete(recentPages.keys().next().value);
        writeDisplaySnapshot(displayStorage(),config?.manifest || config,`portfolios:${cacheKey}`,page);}
      setRows(previous=>nextCursor? [...previous,...result.items.filter(item=>!previous.some(p=>same(p.pool,item.pool)))]:result.items);
      setLoadedIdentity(identity);setCursor(result.nextCursor);setOperator(result.operator);if(!nextCursor){setListingSource(result.source || null);
        setSelected(initialPool?result.items[0]:selectedDetail);
        const children=initialPool?result.items[0]?.children:selectedDetail?.children;
        if(children)setChild(previous=>children.some(c=>same(c.pool,previous))?previous:children.find(c=>!c.sold)?.pool || '');}
    }catch(problem){if(current(ticket)){invalidateDisplayOnReorg(problem);setError(brief(problem));setReadFailed(true);}}
    finally{if(current(ticket)){setLoading(false);setReadRetry(null);}}
  }
  async function select(row){
    const ticket=++sequence.current;setLoading(true);setError('');setPreview(null);setSelectedProof(null);setOrders([]);setOrderPool(null);setOrderCursor(null);setOrderSource(null);
    if(!readPortfolioDisplay(config,row.pool,account,Date.now(),config.displayOnly?refreshKey:0))rememberPortfolioDisplay(config,row,account,Date.now(),config.displayOnly?refreshKey:0);
    const cached=readPortfolioDisplay(config,row.pool,account,Date.now(),config.displayOnly?refreshKey:0);
    if(cached){setSelected(cached);setChild(cached.children.find(c=>!c.sold)?.pool || '');}
    if(config?.displayOnly===true && cached && BigInt(cached.children.length)>=cached.childCount){
      setSelectedProof({identity,provider,wallet,pool:cached.pool});setFreshRead(true);setLoading(false);return;
    }
    try{const details=await retryRead(()=>readPortfolioDisplayRow(config,provider,row.pool,account || ZeroAddress).then(result=>result.item),ticket);
      if(details!==READ_CANCELLED&&current(ticket)){rememberPortfolioDisplay(config,details,account,Date.now(),config.displayOnly?refreshKey:0);setSelected(details);setSelectedProof({identity,provider,wallet,pool:details.pool});setChild(details.children.find(c=>!c.sold)?.pool || '');}
    }catch(problem){if(current(ticket)){invalidateDisplayOnReorg(problem);if(problem?.code==='source_reorg')setSelected(null);setError(brief(problem));setReadFailed(true);}}
    finally{if(current(ticket)){setLoading(false);setReadRetry(null);}}
  }
  async function moreChildren(){
    if(!selectedCurrent)return;const ticket=++sequence.current;setLoading(true);setError('');
    try{const more=await retryRead(()=>readPortfolioDisplayChildren(config,provider,selectedCurrent,BigInt(selectedCurrent.children.length)),ticket);
      if(more!==READ_CANCELLED&&current(ticket))setSelected({...selectedCurrent,children:[...selectedCurrent.children,...more]});
    }catch(problem){if(current(ticket)){invalidateDisplayOnReorg(problem);setError(brief(problem));setReadFailed(true);}}finally{if(current(ticket)){setLoading(false);setReadRetry(null);}}
  }
  async function loadMarketCredit(force=false){
    if(!account||!provider||!config?.portfolioMarket)return;
    const ticket=++marketReadSequence.current,key=marketCreditKey,saved=recentMarketCredits.get(key);
    if(!force&&saved&&Date.now()>=saved.savedAt&&Date.now()-saved.savedAt<120000){setMarketCredit(saved.value);setMarketCreditLoading(false);return;}
    setMarketCreditLoading(true);setMarketCreditError('');
    try{
      const data=await provider.request({method:'eth_call',params:[{to:config.portfolioMarket,data:abi.ShareMarket.encodeFunctionData('bnbOwed',[account])},'latest']});
      const value=uint(abi.ShareMarket.decodeFunctionResult('bnbOwed',data)[0]);
      if(ticket!==marketReadSequence.current)return;
      recentMarketCredits.set(key,{value,savedAt:Date.now()});if(recentMarketCredits.size>12)recentMarketCredits.delete(recentMarketCredits.keys().next().value);
      setMarketCredit(value);
    }catch(problem){if(ticket===marketReadSequence.current)setMarketCreditError(brief(problem));}
    finally{if(ticket===marketReadSequence.current)setMarketCreditLoading(false);}
  }
  async function loadOrders(nextCursor,force=false){
    if(!selectedCurrent)return;const target=selectedCurrent.pool,ticket=++sequence.current;setLoading(true);setError('');setPreview(null);
    const key=marketOrderKey(target),cached=recentMarketOrders.get(key);
    if(nextCursor==null&&!force&&cached&&Date.now()>=cached.savedAt&&Date.now()-cached.savedAt<120000){
      setOrderPool(target);setOrderSource(cached.source);setOrders(cached.items);setOrderCursor(cached.nextCursor);setLoading(false);return;
    }
    try{const result=await retryRead(()=>readPortfolioOrders(config,provider,target,{cursor:nextCursor}),ticket);
      if(result!==READ_CANCELLED&&current(ticket)){
        if(nextCursor&&(!orderSource || result.source.indexedThrough!==orderSource.indexedThrough
          || result.source.indexedBlockHash!==orderSource.indexedBlockHash))throw new Error('订单分页来源已变化，请重新读取。');
        setOrderPool(target);setOrderSource(result.source);
        const items=nextCursor?[...orders,...result.items]:result.items;
        setOrders(items);setOrderCursor(result.nextCursor);
        recentMarketOrders.set(key,{...result,items,savedAt:Date.now()});if(recentMarketOrders.size>12)recentMarketOrders.delete(recentMarketOrders.keys().next().value);}
    }catch(problem){if(current(ticket)){invalidateDisplayOnReorg(problem);if(nextCursor == null){setOrders([]);setOrderPool(null);setOrderSource(null);setReadFailed(true);}
      else {setOrderCursor(null);setReadFailed(false);}setError(brief(problem));}}finally{if(current(ticket)){setLoading(false);setReadRetry(null);}}
  }
  async function prepare(action,pool=selectedCurrent?.pool){
    if(actionFrozen(action.kind))return;
    if(!account || !wallet){onConnect?.();return;}const ticket=++sequence.current;setBusy(true);setError('');setReadFailed(false);setPreview(null);
    try{const input={config,provider:wallet,account,pool,action};const result=await preparePortfolioAction(input);
      if(current(ticket))setPreview({input:{...input, action: {...action, ...(result.procurement ? { expectedPurchaseWei: result.procurement.priceWei.toString(), frozenOrder: result.procurement.frozenOrder } : {}), ...(result.marketTrade?.seller ? {expectedSeller:result.marketTrade.seller,expectedPricePerUnitWei:result.marketTrade.pricePerUnitWei.toString()}: {})}},result,identity,ticket});
    }catch(problem){if(current(ticket))setError(brief(problem));}finally{if(current(ticket))setBusy(false);}
  }
  async function submit(){
    if(!preview || preview.identity!==identity || !current(preview.ticket)
      || actionFrozen(preview.input.action.kind))return;
    const ticket=preview.ticket;setBusy(true);setError('');
    try{const result=await onSend(preview.result,preview.input);
      if(!current(ticket))return;setPreview(null);if(result?.status==='confirmed'){
        recentMarketCredits.delete(marketCreditKey);recentMarketOrders.delete(marketOrderKey(selectedCurrent?.pool));
        setOrderPool(null);setOrders([]);setMarketCredit(null);void loadMarketCredit(true);await load();}
    }catch(problem){if(current(ticket))setError(brief(problem));}finally{if(current(ticket))setBusy(false);}
  }
  const act=(kind,extra={})=>void prepare({kind,...extra});
  const p=selectedCurrent?.proposal;
  const nextRound=selectedCurrent?.nextRoundAt ?? 0n;
  const pChild=selectedCurrent?.children.find(c=>same(c.pool,p?.child));
  const genesisSale=config?.stage==='genesis';
  const genesisSaleGate=genesisSale&&selectedCurrent?genesisPortfolioProposalGate(selectedCurrent):null;
  const displayedOrders=applyMarketOrderFeedback(orders,marketOrderFeedback(marketTransactions,config?.portfolioMarket,account));
  const showShareMarket=!!selectedCurrent&&(selectedCurrent.state!==0n||selectedCurrent.lockedShares>0n||marketCredit>0n);
  const hasBuyableOrder=same(orderPool,selectedCurrent?.pool)&&selectedCurrent?.shareTradingAllowed
    && displayedOrders.some(order=>order.active&&order.remaining>0n&&!order.expired&&!order.cancellationPending&&!same(order.seller,account));
  // The shared directory owns presentation; retain this reader's identity,
  // retries, snapshot provenance and cancellation instead of adding a second reader.
  if(['pools','overview'].includes(mode)&&renderDirectory)return renderDirectory({ rows:visibleRows, enabled, loading,
    error:loadedIdentity===identity||readFailed?error:'', failed:readFailed,
    loaded:loadedIdentity===identity, source:loadedIdentity===identity?listingSource:null,
    current:loadedIdentity===identity&&freshRead, cursor:loadedIdentity===identity?cursor:null,
    load, busy, retry:readRetry });
  return <section id="multi-miner-projects" className="panel portfolio-panel" aria-label={T('多矿机预算项目')}>
    <div className="portfolio-heading"><div><h2><Layers3 size={21}/>{T("多矿机预算项目")}</h2><p>{T("整个项目共 100 份，共同持有项目内多台矿机。每台矿机的出售单独表决，余款与收益归项目份额持有人。")}</p></div>
      <button className="btn secondary" disabled={!enabled || busy || loading || !!preview || disabled || mine&&!account} onClick={()=>void load()}><RefreshCw size={15}/>{T("刷新项目")}</button></div>
    {!enabled ? <p role="status">{locale==='en'?(config?'Project data is temporarily unavailable.':'Loading project data…'):(config?'项目数据暂不可用。':'正在读取项目…')}</p> : mine&&!account ? <button className="btn" onClick={onConnect}>{T("连接钱包查看项目权益")}</button> : <>
      {error&&<div className="portfolio-error" role="alert"><p>{T(error)}</p>{readFailed&&<button className="btn secondary" disabled={busy || loading || disabled} onClick={()=>void load()}>{locale==='en'?'Retry portfolio data':'重新读取预算项目'}</button>}</div>}
      {loading&&<p role="status">{readRetry?(locale==='en'?`Portfolio data is temporarily unavailable. Retrying automatically (${readRetry.attempt}/${readRetry.maxAttempts})…`:`预算数据暂时未就绪，正在自动重试（${readRetry.attempt}/${readRetry.maxAttempts}）…`):locale==='en'?'Loading portfolios…':'正在读取预算项目…'}</p>}
      {mode==='operator'&&isOperator&&<section id="multi-miner-create" className="portfolio-create"><h3>{T("创建多矿机预算项目")}</h3><p>{T("预算项目固定 100 份；总预算、单机绝对上限及换算后的每 H 限价写入合约，采购不能突破这些链上限额。")}</p><p>{T("先创建共享 100 份的预算项目；募满后在项目中设置本批最多采购台数（1–20 台），从当前合格挂单逐台核验并买入。矿机可能在募集期间售出，因此创建时不锁定具体编号；同一项目可用剩余预算继续采购下一批。")}</p>
        <p>{T('Firsto 市场参考日产能价')}: <strong>{dailyReference&&!referenceIssue(dailyReference)?`${amount(dailyReference.dailyCapacityPriceWei,18,5)} BNB / (BEM / 天)`:'—'}</strong>{dailyReference&&!referenceIssue(dailyReference)?` · ${new Date(dailyReference.observedAt).toLocaleString(locale==='en'?'en-GB':'zh-CN')}`:dailyReferenceError?` · ${dailyReferenceError}`:''} <button className="btn secondary" disabled={capacityBusy} onClick={()=>void refreshCapacity(()=>true,true)}>{T('刷新市场产能')}</button></p>
        <p>{T('输入日产能价上限后，系统按当前 Firsto 样本的最低日产出 / H 比率向下折算为链上每 H 上限；合约不会随未来产能变化自动更新。')}</p>
        <div className="portfolio-actions"><label>{T("募集预算（BNB）")}<input inputMode="decimal" placeholder="0.00500" value={inputAmount('budget',budget)} onFocus={()=>setEditingAmount('budget')} onBlur={()=>setEditingAmount(null)} onChange={e=>setBudget(e.target.value)}/></label><label>{T("单机价格上限（BNB）")}<input inputMode="decimal" value={inputAmount('cap',cap)} onFocus={()=>setEditingAmount('cap')} onBlur={()=>setEditingAmount(null)} onChange={e=>setCap(e.target.value)}/></label><label>{T("日产能价上限（BNB / (BEM / 天)）")}<input inputMode="decimal" placeholder="9.00000" value={inputAmount('dailyCap',dailyCap)} onFocus={()=>setEditingAmount('dailyCap')} onBlur={()=>setEditingAmount(null)} onChange={e=>setDailyCap(e.target.value)}/></label><label>{T("募集期（小时）")}<input inputMode="numeric" value={fundHours} onChange={e=>setFundHours(e.target.value)}/></label><label>{T("募集结束后购机期（小时）")}<input inputMode="numeric" value={buyHours} onChange={e=>setBuyHours(e.target.value)}/></label><button className="btn" disabled={createFrozen} onClick={()=>{
          let fields;try{fields=portfolioCreateForm({budget,absoluteCap:cap,dailyCap,capacitySample, fundHours,buyHours});setBudget(fields.budget);}
          catch(problem){setError(brief(problem));return;}
          const now=BigInt(Math.floor(Date.now()/1000)),fundingDeadline=now+BigInt(fundHours)*3600n;
          void prepare({kind:'createPortfolio',budget:fields.budget,absoluteCap:fields.absoluteCap,dailyCap:fields.dailyCap,unitCap:fields.unitCap,fundingDeadline:fundingDeadline.toString(),purchaseDeadline:(fundingDeadline+BigInt(buyHours)*3600n).toString()},null);
        }}>{T("预览创建预算项目")} <ArrowRight size={15}/></button></div></section>}
      {!loading&&!error&&!visibleRows.length&&<p>{locale==='en'?(mine?'No portfolios related to this wallet.':'No portfolios currently available.'):(mine?'当前没有与你相关的预算项目。':'当前没有预算项目。')}</p>}
      <div className="portfolio-cards">{visibleRows.map(row=><button key={row.pool} className={`portfolio-card${same(selectedCurrent?.pool,row.pool)?' selected':''}`} disabled={browseFrozen} onClick={()=>void select(row)}>
        <strong>{T("预算项目")} {shortAddress(row.pool)}</strong><span>{T(states[Number(row.state)])} · {row.activeChildCount.toString()} {T("台运行 /")} {row.childCount.toString()} {T("台购入")}</span>
        <dl><div><dt>{T("预算")}</dt><dd>{fundingAmount(formatEther(row.budgetWei)).display} BNB</dd></div><div><dt>{T("已认购")}</dt><dd>{row.totalSupply.toString()} {T("/ 100 份")}</dd></div><div><dt>{T("我的份额")}</dt><dd>{account?row.shares.toString():'—'}</dd></div><div><dt>{T("可领 BNB")}</dt><dd>{account?amount(row.withdrawableBnb):'—'}</dd></div><div><dt>{T("已入账 BEM")}</dt><dd>{account?amount(row.claimableBem,8):'—'}</dd></div></dl><span>{T("查看矿机与项目操作")} <ChevronDown size={15}/></span>
      </button>)}</div>
      {cursor!==null&&<button className="btn secondary" disabled={browseFrozen} onClick={()=>void load(cursor)}>{T("加载更多预算项目")}</button>}
      {selectedCurrent&&<div className="portfolio-detail"><div className="portfolio-heading"><h3>{T("项目详情")}</h3><a href={explorerAddress(selectedCurrent.pool)} target="_blank" rel="noopener noreferrer">{shortAddress(selectedCurrent.pool)} ↗</a></div>
        <p>{T("每份")} {amount(selectedCurrent.unitPriceWei)} {T("BNB · 已购机")} {amount(selectedCurrent.spentWei)} {T("BNB · 我的可转份额")} {selectedCurrent.availableShares.toString()}{T("。未领取 BEM 随转出份额按比例移动；历史 BNB 余款和卖款留给原持有人。")}</p>
        <p className="subtle-note">{locale==='en'?'Claims, refunds and order cancellations are sent by your wallet; you pay the network Gas.':'领取、退款和撤单由你的钱包发送，并由你的钱包支付网络 Gas。'}</p><div className="portfolio-actions">
          {selectedCurrent.state===0n&&<><label>{T("认购份数")}<input type="number" min="1" max="100" step="1" value={quantity} onChange={e=>setQuantity(e.target.value)}/></label><button className="btn" disabled={frozen} onClick={()=>act('deposit',{quantity})}>{T("预览认购")}</button>{selectedCurrent.shares>0n&&<button className="btn secondary" disabled={actionFrozen('withdrawDeposit')} onClick={()=>act('withdrawDeposit')}>{T("撤回我的认购")}</button>}{fundingDeadlineReached&&<button className="btn secondary" disabled={actionFrozen('finalizeFundingFailure')} onClick={()=>act('finalizeFundingFailure')}>{T("结束募集并开启退款")}</button>}</>}
          {selectedCurrent.state===1n&&selectedCurrent.timestamp>=selectedCurrent.purchaseDeadline&&<button className="btn" disabled={actionFrozen('finalizeAcquisition')} onClick={()=>act('finalizeAcquisition')}>{T("结束购机并结算余款")}</button>}
          {selectedCurrent.fundingFailed&&selectedCurrent.state===5n&&selectedCurrent.shares>0n&&<button className="btn" disabled={actionFrozen('claimFailedFunding')} onClick={()=>act('claimFailedFunding')}>{T("结算我的募集退款")}</button>}
          {selectedCurrent.withdrawableBnb>0n&&<button className="btn" disabled={actionFrozen('withdrawBnb')} onClick={()=>act('withdrawBnb')}>{T("领取")} {amount(selectedCurrent.withdrawableBnb)} BNB</button>}
          {selectedCurrent.claimableBem>0n&&<button className="btn" disabled={actionFrozen('claimBem') || selectedCurrent.lockedShares>0n} onClick={()=>act('claimBem')}>{T("领取")} {amount(selectedCurrent.claimableBem,8)} BEM</button>}
          {!showShareMarket&&marketCreditError&&<button className="btn secondary" disabled={marketCreditLoading} onClick={()=>void loadMarketCredit(true)}>{T("重新读取转让卖款")}</button>}
        </div>
        {selectedCurrent.claimableBem>0n&&selectedCurrent.lockedShares>0n&&<p>{T("即使只挂单 1 份，该钱包在此预算项目的全部 BEM 领取也会暂停，包含未挂单份额。请先撤单，或等待挂单成交、到期解锁后再领取。")}</p>}
        <p>{T("卖款结算后仍可归集已售子矿池的 BEM；未归集的 BEM 随项目份额转移。")}</p>
        <div className="portfolio-child-table"><table><thead><tr><th>{T("项目内矿机")}</th><th>{T("采购来源 / 成本")}</th><th>{T("状态")}</th><th>{T("操作")}</th></tr></thead><tbody>{selectedCurrent.children.map(item=><tr key={item.pool}><td><a href={explorerAddress(item.pool)} target="_blank" rel="noopener noreferrer">#{item.tokenId.toString()} · {shortAddress(item.pool)}</a></td><td>{T(item.official?'官网':'Firsto')} · {amount(item.costWei)} BNB</td><td>{T(item.sold?'已归集卖款':states[Number(item.state)])}</td><td><button className="btn secondary" disabled={actionFrozen('collectChildBem')} onClick={()=>act('collectChildBem',{child:item.pool})}>{T("归集该台 BEM")}</button>{item.state===3n&&<button className="btn" disabled={frozen} onClick={()=>onBuyChild?.(item.pool)}>{T("预览 Firsto 购买")}</button>}</td></tr>)}</tbody></table></div>
        {selectedCurrent.children.length<Number(selectedCurrent.childCount)&&<button className="btn secondary" disabled={browseFrozen} onClick={()=>void moreChildren()}>{T("加载更多子矿机")}</button>}
        {!selectedCurrent.children.length&&<p>{T("该项目尚未购入矿机。")}</p>}
        {onShare&&<button className="btn secondary" disabled={frozen} onClick={()=>onShare(selectedCurrent)}>{locale==='en'?'Share this portfolio':'分享预算项目'}</button>}
        <PortfolioCapacity key={`${selectedCurrent.pool}:${selectedCurrent.blockHash}`} config={config} provider={provider} portfolio={selectedCurrent} locale={locale}/>
        {client&&<PortfolioHistory key={`${selectedCurrent.pool}:${account || ''}`} client={client} config={config} pool={selectedCurrent.pool} account={account} locale={locale} refreshKey={refreshKey}/>}
        {mode==='operator'&&isOperator&&selectedCurrent.state===1n&&onSendQueue&&<BudgetPurchaseQueue config={config} provider={provider} wallet={wallet} account={account} portfolio={selectedCurrent} disabled={frozen} onSend={onSendQueue} onAuthenticate={onAuthenticateQueue} onComplete={()=>void select(selectedCurrent)} locale={locale}/>}

        {selectedCurrent.shareTradingAllowed&&selectedCurrent.availableShares>0n&&<details><summary>{T("转移项目份额")}</summary><p>{T("接收人取得对应未领取 BEM 及未来权益；已结算的历史 BNB 余款和卖款保留在你的地址。此操作是赠予转移，不会收取对价。")}</p><div className="portfolio-actions"><label>{T("接收钱包")}<input placeholder="0x…" value={recipient} onChange={e=>setRecipient(e.target.value)}/></label><label>{T("份数")}<input inputMode="numeric" value={quantity} onChange={e=>setQuantity(e.target.value)}/></label><button className="btn" disabled={frozen} onClick={()=>act('transfer',{recipient,quantity})}>{T("预览份额转移")}</button></div></details>}
        {selectedCurrent.shareTradingAllowed&&selectedCurrent.availableShares>0n&&<section aria-label={T("出售我的项目份额")}>
          <h3>{T("出售我的项目份额")}</h3><p>{T("已自动选择当前持仓项目，可售份额：")} {selectedCurrent.availableShares.toString()} / {selectedCurrent.shares.toString()} {T("份")}</p>
          <p>{T("挂单即使只有 1 份，也会暂停此钱包在本预算项目的全部 BEM 领取，直到挂单成交、撤销或到期解锁。")}</p>
          <div className="portfolio-actions"><label>{T("挂牌份数")}<input type="number" min="1" max={selectedCurrent.availableShares.toString()} step="1" value={listingQuantity} onChange={e=>setListingQuantity(e.target.value)}/></label><label>{T("每份价格（BNB）")}<input inputMode="decimal" placeholder="0.005" value={price} onChange={e=>setPrice(e.target.value)}/></label><button className="btn" disabled={frozen||/^0(?:\.0*)?$/.test(price.trim())} onClick={()=>act('marketList',{quantity:listingQuantity,price})}>{T("预览挂卖份额")}</button></div>
        </section>}
        {showShareMarket&&<details className="portfolio-market" onToggle={event=>{if(event.target===event.currentTarget&&event.currentTarget.open&&!same(orderPool,selectedCurrent.pool))void loadOrders();}}>
          <summary>{T("份额转让")}</summary><p>{T("买卖本项目份额，或领取已成交的卖款。")}</p>
          <div className="portfolio-actions">
            <button className="btn secondary" disabled={browseFrozen} onClick={()=>{void loadOrders(undefined,true);void loadMarketCredit(true);}}>{T("刷新挂单")}</button>
            {typeof marketCredit==='bigint'&&marketCredit>0n&&<button className="btn secondary" disabled={actionFrozen('marketWithdraw')||!account} onClick={()=>act('marketWithdraw')}>{T("领取转让卖款")} {amount(marketCredit)} BNB</button>}
            {marketCreditError&&<button className="btn secondary" disabled={marketCreditLoading} onClick={()=>void loadMarketCredit(true)}>{T("重新读取转让卖款")}</button>}
          </div>
          {same(orderPool,selectedCurrent.pool)&&<>
            {!!displayedOrders.length&&<div className="portfolio-child-table"><table><thead><tr><th>{T("订单")}</th><th>{T("卖方")}</th><th>{T("剩余份额 / 每份价")}</th><th>{T("操作")}</th></tr></thead><tbody>{displayedOrders.map(order=><tr key={order.id.toString()}><td>#{order.id.toString()}</td><td>{shortAddress(order.seller)}</td><td>{order.remaining.toString()} / {amount(order.pricePerUnitWei)} BNB</td><td>{order.active&&order.remaining>0n? <>{same(order.seller,account)?<button className="btn secondary" disabled={actionFrozen('marketCancel')||order.cancellationPending} onClick={()=>act('marketCancel',{orderId:order.id.toString()})}>{T(order.cancellationPending?'撤单处理中…':'撤销挂单')}</button>:!order.expired&&<button className="btn" disabled={orderActionsFrozen||!selectedCurrent.shareTradingAllowed||order.cancellationPending} onClick={()=>act('marketFill',{orderId:order.id.toString(),quantity,expectedSeller:order.seller,expectedPricePerUnitWei:order.pricePerUnitWei.toString()})}>{T("预览买入")} {quantity} {T("份")}</button>}{order.expired&&<button className="btn secondary" disabled={actionFrozen('marketExpire')||order.cancellationPending} onClick={()=>act('marketExpire',{orderId:order.id.toString()})}>{T(order.cancellationPending?'撤单处理中…':'解锁到期挂单')}</button>}</>:T('已结束')}</td></tr>)}</tbody></table></div>}
            {hasBuyableOrder&&<label>{T("买入份数")}<input inputMode="numeric" value={quantity} onChange={e=>setQuantity(e.target.value)}/></label>}
            {!displayedOrders.length&&<p>{T("暂无本项目挂单。")}</p>}
            {orderCursor!==null&&<button className="btn secondary" disabled={frozen} onClick={()=>void loadOrders(orderCursor)}>{T("加载更多挂单")}</button>}
          </>}
          <details><summary>{T("交易规则")}</summary><p>{T("买方另付成交价的 1%，卖方从成交价扣除 1%。成交时尚未领取的 BEM 随份额按比例移动；卖方有份额挂单锁定时不能先领取 BEM。历史 BNB 债权不随份额转移。治理期间暂停新增挂单和成交，原挂单仍可撤销。")}</p></details>
        </details>}
        {p?<div className="portfolio-governance"><h3>{T("本轮子矿机出售候选")}</h3><p>{T(genesisSale
          ? "创世版持有至少 1 份即可发起提案；每轮只有一项，正在投票时不能再发起。"
          : "持有至少 10 份的成员可在同一轮提出候选，大家逐项投票；每轮最多 16 项。提案期间项目份额冻结，其他矿机继续归集收益。")}</p>{!genesisSale&&<p>{T("表决达到门槛后，挂牌仍需通过当前市场参考价与平台审核核验。")}</p>}
          {(selectedCurrent.proposals||[p]).map(candidate=><div key={candidate.id.toString()}><p>#{candidate.id.toString()} · {shortAddress(candidate.child)} · {amount(candidate.price)} {T("BNB · 赞成")} {candidate.yesShares.toString()}/{candidate.threshold.toString()} {T("份，")}{candidate.yesMembers.toString()}/{(candidate.memberCount/2n+1n).toString()} {T("人")}</p><PortfolioSaleStatus candidate={candidate} stage={config.stage} locale={locale}/><div className="portfolio-actions">
          {!p.executed&&!candidate.executed&&selectedCurrent.timestamp<candidate.endsAt&&<><button className="btn" disabled={frozen||candidate.hasVoted||selectedCurrent.shares===0n} onClick={()=>act('voteChildSale',{proposalId:candidate.id.toString(),support:true})}>{T("赞成")}</button><button className="btn secondary" disabled={frozen||candidate.hasVoted||selectedCurrent.shares===0n} onClick={()=>act('voteChildSale',{proposalId:candidate.id.toString(),support:false})}>{T("反对")}</button><button className="btn" disabled={frozen||!candidate.canExecute} onClick={()=>act('executeChildSale',{proposalId:candidate.id.toString()})}>{T("执行该台挂牌")}</button></>}
          </div></div>)}<div className="portfolio-actions">
          {p.executed&&pChild?.state===4n&&<button className="btn" disabled={actionFrozen('settleChildSale')} onClick={()=>act('settleChildSale')}>{T("归集该台卖款")}</button>}
          {(!p.executed&&selectedCurrent.timestamp>=p.endsAt||p.executed&&pChild?.state===3n&&selectedCurrent.timestamp>=pChild.expiresAt)&&<button className="btn secondary" disabled={actionFrozen('expireChildSale')} onClick={()=>act('expireChildSale')}>{T("解除过期子机提案")}</button>}
        </div></div>:null}
        {selectedCurrent.state===2n&&genesisSale&&!genesisSaleGate.allowed&&<p>{T(genesisSaleGate.reason)}</p>}
        {selectedCurrent.state===2n&&!genesisSale&&selectedCurrent.shares>0n&&selectedCurrent.shares<10n&&<p>{T("发起出售候选需持有至少 10 份；你仍可参与投票。")}</p>}
        {selectedCurrent.state===2n&&(genesisSale?genesisSaleGate.allowed:selectedCurrent.shares>=10n&&(!p||!p.executed))&&<details><summary>{T("发起逐台出售候选")}</summary><p>{genesisSale?T("创世版每轮只允许一项出售提案。下一轮最早"):T("正在投票的轮次允许其他持份人提出候选；下一轮最早")} {nextRound===0n?T('现在'):new Date(Number(nextRound)*1000).toLocaleString(locale==='en'?'en-GB':'zh-CN')}{T("。")}</p><div className="portfolio-actions"><label>{T("项目内矿机")}<select value={child} onChange={e=>setChild(e.target.value)}>{selectedCurrent.children.filter(c=>!c.sold&&c.state===2n).map(c=><option key={c.pool} value={c.pool}>#{c.tokenId.toString()} · {shortAddress(c.pool)}</option>)}</select></label><label>{T("拟售价格（BNB）")}<input inputMode="decimal" value={price} onChange={e=>setPrice(e.target.value)}/></label><label>{T("观察到的参考价（BNB）")}<input inputMode="decimal" value={reference} onChange={e=>setReference(e.target.value)}/></label><button className="btn" disabled={frozen||!child||(genesisSale?!genesisSaleGate.allowed:(p&&selectedCurrent.timestamp<p.endsAt?(selectedCurrent.proposals?.length??1)>=16:selectedCurrent.timestamp<nextRound))} onClick={()=>act('proposeChildSale',{child,price,reference,referenceAt:selectedCurrent.timestamp.toString()})}>{T("预览出售候选")}</button></div></details>}
      </div>}

    </>}
    {preview&&preview.identity===identity&&current(preview.ticket)&&<div className="portfolio-confirm" role="dialog" aria-modal="true" aria-label={T('确认预算项目操作')}><div><h3>{T(names[preview.input.action.kind] || preview.input.action.kind)}</h3><p>{T("目标")} {shortAddress(preview.result.transaction.to)} {typeof preview.result.blockNumber === 'bigint' && <>{T("· 区块 #")}{preview.result.blockNumber.toString()}</>}</p><p>{config.stage==='fresh-active'&&['createPortfolio','buyOfficial','buyFirsto'].includes(preview.input.action.kind)?(locale==='en'?'This wallet signs only; the Gas wallet pays network fees.':'本钱包仅签名，网络手续费由 Gas 钱包支付。'):<>{T("本次支付")} {amount(BigInt(preview.result.transaction.value))} BNB + Gas</>}</p><PortfolioConfirmationDetails preview={preview} locale={locale}/>{preview.input.action.kind==='marketList'&&<p>{T("挂单即使只有 1 份，也会暂停此钱包在本预算项目的全部 BEM 领取，直到挂单成交、撤销或到期解锁。")}</p>}{preview.input.action.kind==='marketFill'&&preview.result.marketTrade&&<p>{T("成交基价")} {amount(preview.result.marketTrade.baseWei)} {T("BNB；买方另付")} {amount(preview.result.marketTrade.buyerFeeWei)} {T("BNB；卖方扣除")} {amount(preview.result.marketTrade.sellerFeeWei)} BNB。</p>}{preview.result.procurement&&<p>{T("来源")} {T(preview.result.procurement.route==='official'?'官网':'Firsto')} {T("· 本次含来源费报价")} {amount(preview.result.procurement.priceWei)} {T("BNB · 合约价格上限")} {amount(preview.result.procurement.capWei)} {config.stage==='fresh-active'?(locale==='en'?' BNB. The project funds the purchase; the Gas wallet pays network fees.':' BNB。款项来自项目预算，网络手续费由 Gas 钱包支付。'):T("BNB。款项来自项目预算，本钱包只付 Gas。")}</p>}{preview.result.procurement?.route==='official'&&<p title={`${formatEther(officialPriceWithFeeCeiling(preview.result.procurement.priceWei))} BNB`}>{T("合约价格上限仅约束矿机价格，官网服务费另外在购机期结算时从余款扣除；按本次报价计算，项目含费支出最多")} {amount(officialPriceWithFeeCeiling(preview.result.procurement.priceWei))} BNB。</p>}{preview.result.payoutWei!==null&&<p>{T("当前链上可领取")} {preview.input.action.kind==='claimBem'?amount(preview.result.payoutWei,8):amount(preview.result.payoutWei)} {preview.input.action.kind==='claimBem'?'BEM':'BNB'}</p>}{preview.input.action.kind==='transfer'&&<p>{T("向")} {preview.input.action.recipient} {T("转移")} {preview.input.action.quantity} {T("份，无对价。")}</p>}<p>{T("金额按精确整数发送；请在钱包中确认本次交易。")}</p><div className="portfolio-actions"><button className="btn secondary" disabled={busy} onClick={()=>setPreview(null)}>{T("返回")}</button><button className="btn" disabled={actionFrozen(preview.input.action.kind)} onClick={()=>void submit()}>{T("发送到钱包确认")}</button></div></div></div>}
  </section>;
}

function PortfolioConfirmationDetails({preview,locale}){
  const T=text=>portfolioText(locale,text);
  const a=preview.input.action,row=preview.result.row;
  const saleCandidate=a.proposalId
    ? row?.proposals?.find(item=>item.id.toString()===String(a.proposalId)) : row?.proposal;
  return <>
    {a.kind==='createPortfolio'&&<p>{T("募集预算")} {displayDecimal(a.budget)} {T("BNB / 100 份；单机上限")} {displayDecimal(a.absoluteCap)} BNB；{T("输入的日产能价上限")} {displayDecimal(a.dailyCap)} BNB / (BEM / {T('天')})；{T("换算后的链上每 H 上限")} {displayDecimal(a.unitCap)} {T("BNB / H。募集截至")} {new Date(Number(a.fundingDeadline)*1000).toLocaleString(locale==='en'?'en-GB':'zh-CN')}{T("，购机截至")} {new Date(Number(a.purchaseDeadline)*1000).toLocaleString(locale==='en'?'en-GB':'zh-CN')}。</p>}
    {a.kind==='deposit'&&<p>{T("认购")} {a.quantity} {T("/ 100 份。")}</p>}
    {a.kind==='finalizeFundingFailure'&&<p>{T("募集已到期。此操作结束整个项目的募集，并开启所有成员的退款申请；不会自动向任何人转账。")}</p>}
    {a.kind==='withdrawDeposit'&&<p>{T("仅撤回你的全部认购，其他成员不受影响。退款记入你的待领 BNB，结算后由你领取。")}</p>}
    {a.kind==='claimFailedFunding'&&<p>{T("仅结算你的募集退款，其他成员不受影响。退款记入你的待领 BNB，结算后由你领取。")}</p>}
    {a.kind==='marketList'&&<p>{T("挂卖")} {a.quantity} {T("份，每份")} {displayDecimal(a.price)} {T("BNB；全部成交基价")} {amount(preview.result.marketTrade?.baseWei)} {T("BNB；挂牌时本钱包仅支付 Gas，买卖双方在成交时各承担基价的 1%。")}</p>}
    {a.orderId&&<p>{T("份额订单 #")}{a.orderId}{a.quantity?` · ${a.quantity} ${T('份')}`:''}。</p>}
    {a.child&&<p>{T("子矿池")} <a href={explorerAddress(a.child)} target="_blank" rel="noopener noreferrer">{a.child} ↗</a></p>}
    {a.kind==='proposeChildSale'&&<p>{T("拟售价")} {displayDecimal(a.price)} {T("BNB；参考价")} {displayDecimal(a.reference)} {T("BNB；观察时间")} {new Date(Number(a.referenceAt)*1000).toLocaleString(locale==='en'?'en-GB':'zh-CN')}{T("。提案发起后本轮项目份额暂时冻结。")}</p>}
    {['voteChildSale','executeChildSale','settleChildSale','expireChildSale'].includes(a.kind)&&saleCandidate&&<p>{T("子矿池")} {shortAddress(saleCandidate.child)}{T("；提案 #")}{saleCandidate.id.toString()}{T("；挂牌价")} {amount(saleCandidate.price)} BNB。{a.kind==='voteChildSale'?T(a.support?'本次投赞成票。':'本次投反对票。'):''}</p>}
    {a.kind==='executeChildSale'&&saleCandidate&&<PortfolioSaleStatus candidate={saleCandidate} stage={preview.input.config.stage} locale={locale}/>}
  </>;
}

/** Parent-only history: never add child Harvested events to the parent's BemCollected totals. */
function PortfolioHistory({client,config,pool,account,locale,refreshKey}){
  const T=text=>portfolioText(locale,text);
  const historyKey=window=>`${config.factory}:${config.portfolioFactory}:${pool.toLowerCase()}:${account?.toLowerCase() || 'public'}:${window}`;
  const cachedHistory=window=>{
    const saved=recentHistories.get(client)?.get(historyKey(window));
    return config.displayOnly && saved?.refreshKey===refreshKey && Date.now()-saved.savedAt<120000 ? saved : null;
  };
  const [history,setHistory]=useState(()=>cachedHistory(7)?.data ?? null),[error,setError]=useState(''),[busy,setBusy]=useState(false),[days,setDays]=useState(7);
  const epoch=useRef(0);useEffect(()=>()=>{epoch.current++;},[]);
  useEffect(()=>{
    const saved=cachedHistory(days);
    if(saved?.data)setHistory(saved.data);
    else if(history && config.displayOnly)void load(days);
  },[client,pool,account,refreshKey]);
  async function load(window=days,more=false,force=false){const ticket=++epoch.current;setBusy(true);setError('');
    try{
      const read=async()=>{
      const [yieldResult,parallelEvents]=more ? [{data:history.yield,source:history.source},null]
        : config.displayOnly ? await Promise.all([client.readYield({pool,account:account || undefined,days:window,scope:'portfolio'}),client.readActivity({pool})])
        : [await client.readYield({pool,account:account || undefined,days:window,scope:'portfolio'}),null];
      if(!same(yieldResult.source.portfolioFactory,config.portfolioFactory)||!same(yieldResult.source.portfolioMarket,config.portfolioMarket))throw new Error('预算历史记录来源不一致。');
      const events=parallelEvents ?? await client.readActivity({pool,source:yieldResult.source,...(more?{cursor:history.nextCursor}:{})});
      return {yield:yieldResult.data,source:yieldResult.source,items:more?[...history.items,...events.items]:events.items,nextCursor:events.nextCursor};
      };
      let saved=!more&&!force?cachedHistory(window):null;
      if(!saved && config.displayOnly && !more){
        let cache=recentHistories.get(client);if(!cache){cache=new Map();recentHistories.set(client,cache);}
        const entry={savedAt:Date.now(),refreshKey};
        entry.promise=read().then(data=>{entry.data=data;delete entry.promise;return data;},error=>{if(cache.get(historyKey(window))===entry)cache.delete(historyKey(window));throw error;});
        cache.set(historyKey(window),entry);if(cache.size>64)cache.delete(cache.keys().next().value);saved=entry;
      }
      const data=saved ? saved.data ?? await saved.promise : await read();
      if(ticket===epoch.current){setHistory(data);setDays(window);}
    }catch(problem){if(ticket===epoch.current)setError(brief(problem));}
    finally{if(ticket===epoch.current)setBusy(false);}
  }
  function download(){const url=URL.createObjectURL(new Blob([exportActivityCsv(history.items)],{type:'text/csv;charset=utf-8'}));const a=document.createElement('a');a.href=url;a.download='BEMine-budget-records.csv';a.click();URL.revokeObjectURL(url);}
  return <details><summary>{T("项目收益与公开记录")}</summary><p>{T("这里仅统计进入本预算项目的 BEM，避免与子矿池重复计入；个人未领取权益以项目当前读数为准。")}</p>
    <button className="btn secondary" disabled={busy} onClick={()=>void load(days,false,!!history)}>{T("读取项目收益与记录")}</button>{busy&&<p role="status">{T("正在读取项目记录…")}</p>}{error&&<p role="alert">{T(error)}</p>}
    {history&&<><LiveYieldChart data={history.yield} locale={locale} days={days} onDays={next=>{if(!busy)void load(next);}}/><div className="portfolio-child-table"><table><thead><tr><th>{T("区块")}</th><th>{T("记录")}</th><th>{T("链上凭证")}</th></tr></thead><tbody>{history.items.map(item=><tr key={`${item.blockNumber}:${item.transactionIndex}:${item.logIndex}`}><td>{item.blockNumber}</td><td><ActivityOperation row={item} locale={locale}/></td><td><a href={explorerTransaction(item.transactionHash)} target="_blank" rel="noopener noreferrer">{T("查看交易 ↗")}</a></td></tr>)}</tbody></table></div>{!history.items.length&&<p>{T("暂无该项目已确认记录。")}</p>}<div className="portfolio-actions"><button className="btn secondary" onClick={download}>{T("导出已加载记录")}</button>{history.nextCursor!==null&&<button className="btn secondary" disabled={busy} onClick={()=>void load(days,true)}>{T("加载更多记录")}</button>}</div></>}
  </details>;
}
