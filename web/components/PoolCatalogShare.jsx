'use client';

import { useRef, useState } from 'react';
import { Copy, Link2, Send, Share2, X } from 'lucide-react';
import { createCatalogShare } from '../lib/catalog-share.mjs';
import styles from './ProjectShare.module.css';

export default function PoolCatalogShare({ publicBaseUrl, locale = 'zh', onDismiss }) {
  const L = (zh, en) => locale === 'en' ? en : zh;
  const model = createCatalogShare({ publicBaseUrl, locale });
  const preview = useRef(null);
  const [notice, setNotice] = useState('');
  async function copy(value) {
    try {
      await navigator.clipboard.writeText(value);
      setNotice(L('已复制，可以发送给朋友。', 'Copied. Share it with your friends.'));
    } catch {
      preview.current?.focus(); preview.current?.select();
      setNotice(L('请选择并复制下方链接。', 'Select and copy the link below.'));
    }
  }
  if (!model) return <section className={styles.card}><h2>{L('分享暂不可用', 'Sharing is unavailable')}</h2></section>;
  return <section className={styles.card}>
    <div className={styles.top}>
      <span className={styles.badge}><Share2 size={17}/>{L('邀请朋友一起拼矿', 'Invite friends to BEMine')}</span>
      <button type="button" className={styles.dismiss} onClick={onDismiss} aria-label={L('关闭分享', 'Close sharing')}><X size={20}/></button>
    </div>
    <h2 className={styles.heading}>{model.title}</h2>
    <p className={styles.intro}>{model.text}</p>
    <div className={styles.preview}><textarea ref={preview} aria-label={L('页面分享文案', 'Page share text')}
      readOnly value={model.copyText} rows={4}/></div>
    <div className={styles.actions}>
      <a href={model.telegramUrl} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer"><Send size={17}/>Telegram</a>
      <a href={model.xUrl} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">𝕏</a>
      <button type="button" onClick={() => copy(model.url)}><Link2 size={17}/>{L('复制页面链接', 'Copy page link')}</button>
      <button type="button" onClick={() => copy(model.copyText)}><Copy size={17}/>{L('复制分享文案', 'Copy share text')}</button>
    </div>
    <p className={styles.privacy}>{L('分享内容不包含你的钱包地址或个人投入金额。', 'Your wallet address and contribution are not included.')}</p>
    <p className={styles.notice} role="status" aria-live="polite">{notice}</p>
  </section>;
}
