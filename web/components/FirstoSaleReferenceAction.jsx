'use client';
import { useEffect, useRef, useState } from 'react';
import { displayAmount } from '../lib/amount-display.mjs';
import { fetchSaleReferenceStatus } from '../lib/sale-reference-status.mjs';

const labels = {disabled:'后台自动参考价需完成一次合约升级后启用。', idle:'等待后台更新挂牌参考价。',
  reading:'后台正在读取 Firsto 官方参考价…', queued:'参考价正在等待代付队列…', pending:'参考价更新交易正在确认…',
  confirmed:'Firsto 市场参考价已更新。', 'source-unavailable':'Firsto 来源暂不可用，后台会自动重试。',
  'gas-paused':'代付预算暂不可用，后台稍后自动恢复。', 'review-required':'参考价交易需要运营处理，已保留交易记录。'};

/** Public status reads never sign, request a Gas transaction or execute the NFT sale. */
export default function FirstoSaleReferenceAction({ config, pool, disabled = false, onUpdated }) {
  const identity = [config?.artifactDigest, config?.factory, config?.shareMarket, pool].join(':').toLowerCase();
  const [view,setView] = useState({identity,data:null,loading:false,error:''});
  const callbacks=useRef(null);callbacks.current={onUpdated};
  const refresh=useRef(null),confirmed=useRef(null);
  useEffect(()=>{
    const controller=new AbortController();let timer,working=false;
    const visible=()=>typeof document==='undefined' || !document.hidden;
    if(confirmed.current?.identity!==identity)confirmed.current={identity,key:null};
    setView({identity,data:null,loading:false,error:''});
    const read=async()=>{
      if(working || controller.signal.aborted || disabled || !visible())return;
      working=true;setView(value=>({...value,loading:true,error:''}));
      let nextDelay=30_000;
      try {
        const data=await fetchSaleReferenceStatus(config,pool,{signal:controller.signal});
        if(controller.signal.aborted)return;
        setView({identity,data,loading:false,error:''});
        const item=data.item,key=`${item?.hash ?? ''}:${item?.observedAt ?? ''}:${item?.priceWei ?? ''}`;
        if(!data.stale && ['pending','queued','reading'].includes(item?.status))nextDelay=10_000;
        if(!data.stale && item?.status==='confirmed' && confirmed.current.key!==key){
          confirmed.current.key=key;callbacks.current.onUpdated?.(data);
        }
      }catch{if(!controller.signal.aborted)setView(value=>({...value,loading:false,error:'后台状态暂不可用，保留最近参考价。'}));}
      finally {working=false;if(!controller.signal.aborted && visible())timer=setTimeout(()=>void read(),nextDelay);}
    };
    refresh.current=()=>{clearTimeout(timer);void read();};void read();
    const visibility=()=>{clearTimeout(timer);if(visible())void read();};
    if(typeof document!=='undefined')document.addEventListener('visibilitychange',visibility);
    return()=>{controller.abort();clearTimeout(timer);refresh.current=null;
      if(typeof document!=='undefined')document.removeEventListener('visibilitychange',visibility);};
  },[identity,disabled]);
  const current=view.identity===identity?view:{data:null,loading:false,error:''},data=current.data,item=data?.item;
  return <div className="operator-reference-tools" aria-label="Firsto 自动市场参考价">
    <p>{current.error || (data?.stale ? '后台状态暂不可用，保留最近参考价。' : labels[item?.status])
      || (current.loading ? '正在读取后台参考价状态…' : '等待后台参考价状态。')}</p>
    {item?.priceWei && <p>整机市场参考价：<strong title={`${item.priceWei} wei`}>{displayAmount(item.priceWei)} BNB</strong>。
      挂牌仍需按页面提示确认。</p>}
    {item?.hash && <p>参考价更新交易：<a href={`https://bscscan.com/tx/${item.hash}`} target="_blank" rel="noreferrer">
      {item.hash.slice(0,10)}… ↗</a></p>}
    {item?.status==='disabled' && <p>平台完成一次启用后，参考价由后台自动更新，无需逐笔管理员签名。
      <a href={`${config?.basePath ?? ''}/sale-upgrade.html`}>查看升级入口</a>（由原部署钱包启用）。</p>}
    <button className="btn secondary" disabled={disabled || current.loading} onClick={()=>refresh.current?.()}>刷新参考价状态</button>
  </div>;
}
