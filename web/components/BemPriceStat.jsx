'use client';
import {useEffect,useState} from 'react';
import {Coins} from 'lucide-react';
import {useI18n} from '../lib/i18n';
import {BEM_POOL,PRICE_REFRESH_MS,validBemQuote} from '../lib/bem-price.mjs';
import styles from './BemPriceStat.module.css';

export default function BemPriceStat(){
 const {t,locale}=useI18n();
 const [quote,setQuote]=useState(null),[loading,setLoading]=useState(true),[now,setNow]=useState(0);
 useEffect(()=>{
  let stopped=false,busy=false;
  const controller=new AbortController();
  async function refresh(){
   if(busy||document.hidden)return;
   busy=true;
   const request=new AbortController();
   const cancel=()=>request.abort();controller.signal.addEventListener('abort',cancel,{once:true});
   const timeout=setTimeout(cancel,8000);
   try{
    const response=await fetch(`${process.env.NEXT_PUBLIC_BASE_PATH||''}/data/bem-price.json`,{cache:'no-store',signal:request.signal});
    if(!response.ok)throw new Error('UNAVAILABLE');
    const data=await response.json();
    if(!stopped){setQuote(validBemQuote(data)?data:null);setNow(Date.now());}
   }catch{if(!stopped){setQuote(null);setNow(Date.now());}}
   finally{clearTimeout(timeout);controller.signal.removeEventListener('abort',cancel);busy=false;if(!stopped)setLoading(false);}
  }
  refresh();
  const timer=setInterval(()=>{setNow(Date.now());refresh();},PRICE_REFRESH_MS);
  const onVisible=()=>{if(!document.hidden){setNow(Date.now());refresh();}};
  document.addEventListener('visibilitychange',onVisible);
  return()=>{stopped=true;controller.abort();clearInterval(timer);document.removeEventListener('visibilitychange',onVisible);};
 },[]);
 const available=validBemQuote(quote,now||Date.now());
 const updated=available?new Date(quote.updatedAt).toLocaleTimeString(locale==='en'?'en-GB':'zh-CN',{hour12:false}):'';
 return <div className={`bemine-stat ${styles.price}`}>
  <div><span>{t('当前币价')}</span><Coins size={18}/></div>
  <strong>{available?`≈ ${quote.priceUsdt.toLocaleString('en-US',{minimumFractionDigits:4,maximumFractionDigits:4})}`:'—'}<small>USDT</small></strong>
  <p className={styles.status}>{available?t('每 15 秒更新 · {time}',{time:updated}):t(loading?'正在获取行情':'行情暂不可用')}</p>
  <p className={styles.sources}><span>{t('来源：')}</span><a href={`https://bscscan.com/address/${BEM_POOL}`} target="_blank" rel="noreferrer">PancakeSwap V3</a></p>
 </div>;
}
