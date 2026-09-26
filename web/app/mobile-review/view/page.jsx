'use client';
import {useEffect,useState} from 'react';
import {reviewScenarios} from '../../../lib/mobile-review-v8-scenarios';
const basePath=process.env.NEXT_PUBLIC_BASE_PATH||'';
export default function PhoneView(){
 const [config,setConfig]=useState(null);
 const [available,setAvailable]=useState(390);
 useEffect(()=>{const resize=()=>setAvailable(window.innerWidth);resize();window.addEventListener('resize',resize);return()=>window.removeEventListener('resize',resize);},[]);
 useEffect(()=>{const q=new URLSearchParams(location.search);const item=reviewScenarios.find(x=>x.id===q.get('id'))||reviewScenarios[0];const width=[360,390,430].includes(Number(q.get('width')))?Number(q.get('width')):390;setConfig({retired:q.get('id')==='A12',item,width,locale:q.get('locale')==='en'?'en':'zh',appearance:q.get('appearance')==='dark'?'dark':'light'});},[]);
 if(!config)return <p>正在加载手机页面…</p>;
 const scale=Math.min(1,available/config.width);
 return <main style={{minHeight:'100vh',background:'#e8ece5',padding:'16px 0',color:'#234536'}}><header style={{maxWidth:720,margin:'0 auto 16px',padding:'0 16px',fontSize:14}}><a href={`${basePath}/mobile-review.html`}>← 手机审查目录</a><h1 style={{fontSize:20,margin:'12px 0'}}>{config.retired?'A12 · 此审查项目已撤下':`${config.item.id} · ${config.item.title}`}</h1><p>{config.width} × 844 · 可在手机框内滑动和操作，均为演示。</p></header><div style={{width:config.width*scale,height:844*scale,margin:'auto',overflow:'hidden',boxShadow:'0 8px 36px #16322322'}}><iframe title={config.item.title} src={`${basePath}/mobile-review/frame.html?id=${config.retired?'A12':config.item.id}&locale=${config.locale}&appearance=${config.appearance}`} style={{display:'block',width:config.width,height:844,border:0,transform:`scale(${scale})`,transformOrigin:'top left'}}/></div></main>;
}
