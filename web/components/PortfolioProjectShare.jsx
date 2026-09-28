'use client';
import { useEffect, useId, useRef, useState } from 'react';
import { CheckCircle2, Copy, Download, Link2, Send, Share2, X } from 'lucide-react';
import { createPortfolioShare } from '../lib/portfolio-share.mjs';
import styles from './ProjectShare.module.css';

export default function PortfolioProjectShare({locale='zh',publicBaseUrl,project,confirmation,onDismiss}){
  const en=locale==='en',L=(zh,english)=>en?english:zh,id=useId(),textRef=useRef(null),[notice,setNotice]=useState('');
  const model=createPortfolioShare({locale,publicBaseUrl,project,confirmation});
  useEffect(()=>setNotice(''),[locale,project?.pool,confirmation?.transactionHash]);
  async function copy(text){try{await navigator.clipboard.writeText(text);setNotice(L('已复制','Copied'));}
    catch{textRef.current?.focus();textRef.current?.select();setNotice(L('请选中文案手动复制。','Please select and copy the text manually.'));}}
  const image=`${process.env.NEXT_PUBLIC_BASE_PATH||''}/images/bemine-budget-share.png`;
  return <section className={styles.card} aria-labelledby={id}>
    <div className={styles.top}><span className={styles.badge}>{model?.confirmed?<CheckCircle2 size={17}/>:<Share2 size={17}/>}{model?.confirmed?L('预算认购已确认','Portfolio subscription confirmed'):L('分享多矿机项目','Share a multi-miner portfolio')}</span>
      {onDismiss&&<button className={styles.dismiss} onClick={onDismiss} aria-label={L('收起分享','Dismiss sharing')}><X size={20}/></button>}</div>
    <h2 id={id} className={styles.heading}>{L('多台矿机，一个共同项目','Multiple miners. One shared project.')}</h2>
    {!model?<p>{L('项目资料尚未核验，请刷新后重试。','Project details have not been verified. Refresh and try again.')}</p>:<>
      <img src={image} width="1200" height="630" style={{width:'100%',height:'auto',borderRadius:10,marginTop:16}} alt={L('拼矿 BEMine 多矿机项目海报：整个项目共100份，逐台共同决策','BEMine multi-miner portfolio poster: 100 project shares and shared decisions for each miner')}/>
      <div className={styles.preview}><strong className={styles.project}>{model.title}</strong><textarea ref={textRef} readOnly aria-label={L('预算项目分享文案','Portfolio share text')} value={`${model.text}\n${model.url}`} rows={6}/></div>
      <div className={styles.actions}>
        <a href={model.telegramUrl} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer"><Send size={17}/>Telegram</a>
        <a href={model.xUrl} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">𝕏 X</a>
        <button onClick={()=>void copy(model.projectUrl)}><Link2 size={17}/>{L('复制项目链接','Copy project link')}</button>
        <button onClick={()=>void copy(`${model.text}\n${model.url}`)}><Copy size={17}/>{L('复制分享文案','Copy share text')}</button>
        <a href={image} download="BEMine-portfolio.png"><Download size={17}/>{L('保存预算项目海报','Save portfolio poster')}</a>
      </div><p className={styles.privacy}>{L('分享内容不包含钱包、个人投入金额或交易哈希。请在 Telegram 或 X 中自行确认发布。','Sharing excludes wallet addresses, personal contributions and transaction hashes. Confirm publishing yourself in Telegram or X.')}</p>
      <p className={styles.notice} role="status">{notice}</p>
    </>}
  </section>;
}
