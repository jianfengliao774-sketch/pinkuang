'use client';
import {useEffect,useState} from 'react';
import PlatformMobileReviewV8 from '../../../components/PlatformMobileReviewV8';
import {ReviewI18nProvider} from '../../../lib/i18n';
import {reviewScenarios} from '../../../lib/mobile-review-v8-scenarios';
import '../../review/frame/frame.css';
export default function ReviewFrame(){
 const [config,setConfig]=useState(null);
 useEffect(()=>{const q=new URLSearchParams(location.search);const item=reviewScenarios.find(x=>x.id===q.get('id'))||reviewScenarios[0];setConfig({retired:q.get('id')==='A12',item,locale:q.get('locale')==='en'?'en':'zh',appearance:q.get('appearance')==='dark'?'dark':'light'});},[]);
 useEffect(()=>{
  if(!config)return;
  let timer;
  const report=()=>{clearTimeout(timer);timer=setTimeout(()=>{
   const footer=document.querySelector('.page-footer');
   const dialog=document.querySelector('.modal');
   const height=dialog||config.item.state.menu?844:Math.max(844,Math.ceil((footer?.getBoundingClientRect().bottom||document.body.scrollHeight)+scrollY+30));
   parent.postMessage({type:'bemine-review-size',id:config.item.id,height},location.origin);
  },100)};
  const observer=new ResizeObserver(report);observer.observe(document.body);document.fonts.ready.then(report);
  window.addEventListener('load',report);report();
  return()=>{clearTimeout(timer);observer.disconnect();window.removeEventListener('load',report)};
 },[config]);
 if(!config)return <p style={{padding:24}}>正在加载页面…</p>;
 if(config.retired)return <main style={{padding:24}}><h1>此审查项目已撤下</h1><p>请返回最新版审查目录，原编号保留，不再分配给其他页面。</p><a href={`${process.env.NEXT_PUBLIC_BASE_PATH||''}/mobile-review.html`}>返回审查目录</a></main>;
 return <ReviewI18nProvider initialLocale={config.locale}><PlatformMobileReviewV8 scenario={{...config.item.state,appearance:config.appearance}}/></ReviewI18nProvider>;
}
