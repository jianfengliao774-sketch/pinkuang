'use client';
import {useEffect,useRef,useState} from 'react';
import {readPortfolioDailyCapacity} from '../lib/portfolio-capacity.mjs';
import {amount} from '../lib/live-view.mjs';

/** Optional complete estimate: an unavailable source cannot lock any otherwise valid transaction. */
export default function PortfolioCapacity({config,provider,portfolio,locale}){
  const en=locale==='en',L=(zh,english)=>en?english:zh;
  const [quote,setQuote]=useState(null),[busy,setBusy]=useState(false),[progress,setProgress]=useState(null),[now,setNow]=useState(Date.now());
  const request=useRef(null);
  useEffect(()=>()=>request.current?.abort(),[]);
  useEffect(()=>{if(!quote?.available)return;const remaining=quote.validUntil-Date.now();if(remaining<=0){setNow(Date.now());return;}const timer=setTimeout(()=>setNow(Date.now()),remaining+1);return()=>clearTimeout(timer);},[quote]);
  async function load(){request.current?.abort();const abort=new AbortController();request.current=abort;setBusy(true);setQuote(null);setProgress(null);
    const result=await readPortfolioDailyCapacity(config,provider,{pool:portfolio.pool,portfolio:config?.displayOnly?portfolio:undefined,signal:abort.signal,onProgress:value=>{if(request.current===abort&&!abort.signal.aborted)setProgress(value);}});
    if(request.current!==abort||abort.signal.aborted)return;setQuote(result);setNow(Date.now());setBusy(false);
  }
  const valid=quote?.available&&quote.validUntil>now;
  return <details className="portfolio-capacity"><summary>{L('项目综合日产能参考','Combined daily-output reference')}</summary>
    <p>{L('只合计仍持有矿机的参考日产 BEM。已售矿机不计入；任一矿机数据未知时不显示不完整合计。','Only retained miners contribute to estimated daily BEM. Sold miners are excluded; unknown output prevents an incomplete total.')}</p>
    <button className="btn secondary" disabled={busy} onClick={()=>void load()}>{busy?L('正在读取矿机产能…','Loading miner output…'):L('读取综合日产能','Load combined daily output')}</button>
    {busy&&progress&&<p role="status">{L('已读取','Loaded')} {progress.inspected.toString()} / {progress.total.toString()}</p>}
    {quote&&!valid&&<p role="status">{L('日产能参考暂不可用，请稍后刷新。','Daily-output estimates are unavailable. Refresh later.')}</p>}
    {valid&&<div className="portfolio-capacity-result">
      <p>{L('项目参考日产','Portfolio estimated daily output')}: <strong>{amount(quote.estimated24hAtomic,8)} BEM</strong> · {L('仍持有','Retained')}: {quote.retainedChildren.toString()} · {L('已售剔除','Sold excluded')}: {(quote.soldChildren+quote.pendingSaleChildren).toString()}</p>
      {quote.priceWeiPerDailyBem===null?<p>{L('当前没有仍持有的矿机，不计算日产能价格。','No miners are currently retained, so no daily-output price is calculated.')}</p>:<>
        <p>{L('每份参考日产','Estimated daily output per share')}: {amount(quote.estimated24hPerShareNumerator,10)} BEM</p>
        <p>{L('募集预算 / 参考日产 1 BEM 的价格','Original funding budget per 1 BEM of estimated daily output')}: <strong>{amount(quote.priceWeiPerDailyBem)} BNB</strong></p>
      </>}
      <p>{L('按项目原募集预算折算，非当前份额挂牌价，未加份额交易手续费；为税前产能估计，不等于实时收益或收益承诺。','Based on the original funding budget, not a current share ask; share-trading fees are excluded. This is a gross output estimate, not current earnings or a return promise.')}</p>
      <small>{quote.displayOnly?L('数据更新于','Updated at'):typeof quote.sourceBlock==='bigint'?`${L('数据区块','Data block')} #${quote.sourceBlock.toString()} · ${L('数据更新于','Updated at')}`:L('数据更新于','Updated at')} {new Date(quote.observedAt).toLocaleString(en?'en-GB':'zh-CN')} · {L('有效至','Valid until')} {new Date(quote.validUntil).toLocaleString(en?'en-GB':'zh-CN')}</small>
    </div>}
  </details>;
}
