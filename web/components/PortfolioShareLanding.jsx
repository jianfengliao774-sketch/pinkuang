'use client';
import {useEffect,useState} from 'react';
import {resolvePortfolioShareTarget} from '../lib/portfolio-share.mjs';
import styles from './ShareLanding.module.css';
export default function PortfolioShareLanding(){
  const [target,setTarget]=useState(null),[en,setEn]=useState(false),base=process.env.NEXT_PUBLIC_BASE_PATH||'';
  useEffect(()=>{setEn(navigator.language?.startsWith('en')===true);const destination=resolvePortfolioShareTarget(location.search,base);setTarget(destination);if(destination)location.replace(destination);},[base]);
  return <main className={styles.page}><section className={styles.card}><div className={styles.brand}>BEMine <span>拼矿</span></div>
    <h1>{en?'Multiple miners. One shared project.':'多台矿机，一个共同项目。'}</h1>
    <p>{en?'100 shares across the portfolio. Explore its current progress.':'整个项目共100份，了解最新项目进展。'}</p><a href={target||`${base}/`}>{en?'View portfolio':'查看预算项目'} ↗</a>
    <noscript>请开启 JavaScript 查看项目。Enable JavaScript to open the portfolio.</noscript></section></main>;
}
