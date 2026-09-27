'use client';
import {useEffect,useState} from 'react';
import PlatformReview from '../../../components/PlatformReview';
import {ReviewI18nProvider} from '../../../lib/i18n';
import {reviewScenarios} from '../../../lib/review-scenarios';
import './frame.css';
export default function ReviewFrame(){
 const [config,setConfig]=useState(null);
 useEffect(()=>{const q=new URLSearchParams(location.search);const item=reviewScenarios.find(x=>x.id===q.get('id'))||reviewScenarios[0];setConfig({item,locale:q.get('locale')==='en'?'en':'zh',appearance:q.get('appearance')==='dark'?'dark':'light'});},[]);
 useEffect(()=>{
  if(!config)return;
  let timer;
  const report=()=>{clearTimeout(timer);timer=setTimeout(()=>{
   const footer=document.querySelector('.page-footer');
   const dialog=document.querySelector('.modal');
   const height=dialog?Math.max(960,(dialog?.scrollHeight||0)+80):Math.max(960,Math.ceil((footer?.getBoundingClientRect().bottom||document.body.scrollHeight)+scrollY+30));
   parent.postMessage({type:'bemine-review-size',id:config.item.id,height},location.origin);
  },100)};
  const observer=new ResizeObserver(report);observer.observe(document.body);document.fonts.ready.then(report);
  window.addEventListener('load',report);report();
  return()=>{clearTimeout(timer);observer.disconnect();window.removeEventListener('load',report)};
 },[config]);
 if(!config)return <p style={{padding:24}}>正在加载页面…</p>;
 return <ReviewI18nProvider initialLocale={config.locale}><PlatformReview scenario={{...config.item.state,appearance:config.appearance}}/></ReviewI18nProvider>;
}
