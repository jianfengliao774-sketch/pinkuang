'use client';

import { useRef, useState } from 'react';
import { Copy, Link2, Send, Share2, X } from 'lucide-react';
import { createDemoShare } from '../lib/demo-share.mjs';
import ShareArtwork from './ShareArtwork';
import ShareCopyControls from './ShareCopyControls';
import useShareVariation from './useShareVariation';
import styles from './DemoProjectShare.module.css';

const copy = {
  zh: {
    badge: '分享效果 · 演示预览', complete: '演示认购完成，一起分享', heading: '一份参与，一起分享',
    intro: '邀请朋友一起了解这台矿机，感受共同参与的乐趣。',
    sample: '本次为样例数据，未发生真实付款。',
    label: 'Telegram / X 分享文案', project: '项目链接', link: '复制链接', text: '复制文案',
    close: '关闭分享', copied: '已复制',
    copyFailed: '未能复制，请长按文案或链接手动复制。',
    opened: '请在打开的 Telegram 或 X 窗口中确认发送。',
    privacy: '分享文案不包含钱包地址、投入金额或交易记录。',
    unavailable: '暂时无法分享此演示项目',
  },
  en: {
    badge: 'Sharing · Demo preview', complete: 'Demo subscription complete', heading: 'One share. A shared journey.',
    intro: 'Invite friends to explore this miner and participate together.',
    sample: 'Sample data. No real payment was made.',
    label: 'Telegram / X share text', project: 'Project link', link: 'Copy link', text: 'Copy text',
    close: 'Close sharing', copied: 'Copied',
    copyFailed: 'Copy failed. Long-press the text or link to copy it manually.',
    opened: 'Confirm sending in the Telegram or X window.',
    privacy: 'No wallet address, investment amount or transaction record is shared.',
    unavailable: 'This demo project is unavailable for sharing',
  },
};

export default function DemoProjectShare({ project, locale = 'zh', simulationComplete = false, onDismiss }) {
  const labels = copy[locale === 'en' ? 'en' : 'zh'];
  const { posterId, mottoIndex, ready, changeVariation } = useShareVariation();
  const [channel, setChannel] = useState('telegram');
  const model = createDemoShare({ project, locale, mottoIndex, posterId });
  const textRef = useRef(null);
  const linkRef = useRef(null);
  const [notice, setNotice] = useState('');

  async function copyValue(value, ref) {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(value);
      setNotice(labels.copied);
    } catch {
      ref.current?.focus();
      ref.current?.select();
      setNotice(labels.copyFailed);
    }
  }

  const selectedText = model ? channel === 'x' ? model.xText : model.text : '';

  return <section className={styles.card}>
    <div className={styles.top}>
      <span className={styles.badge}><Share2 size={17} aria-hidden="true" />{labels.badge}</span>
      <button type="button" className={styles.close} onClick={onDismiss} aria-label={labels.close}><X size={20} aria-hidden="true" /></button>
    </div>
    <h2 id="dialog-title" className={styles.heading}>{model ? simulationComplete ? labels.complete : labels.heading : labels.unavailable}</h2>
    {model && <>
      <p className={styles.intro}>{labels.intro}</p>
      <ShareArtwork locale={locale} posterId={posterId} ready={ready} />
      <div className={styles.preview}>
        <div className={styles.brand}>拼矿 <span>BEMine</span></div>
        <strong className={styles.project}>{model.title}</strong>
        <label className={styles.label} htmlFor="demo-share-text">{labels.label}</label>
        <ShareCopyControls locale={locale} channel={channel} onChannelChange={setChannel} ready={ready} onNextVariation={() => { changeVariation(); setNotice(''); }} />
        <textarea id="demo-share-text" ref={textRef} readOnly value={selectedText} rows={4} />
        <label className={styles.label} htmlFor="demo-share-link">{labels.project}</label>
        <input id="demo-share-link" ref={linkRef} readOnly value={model.url} />
      </div>
      <div className={styles.actions}>
        <a href={model.telegramUrl} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer" onClick={() => setNotice(labels.opened)}><Send size={17} aria-hidden="true" />Telegram</a>
        <a href={model.xUrl} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer" onClick={() => setNotice(labels.opened)}><span className={styles.xMark} aria-hidden="true">𝕏</span>X</a>
        <button type="button" onClick={() => copyValue(model.url, linkRef)}><Link2 size={17} aria-hidden="true" />{labels.link}</button>
        <button type="button" onClick={() => copyValue(`${selectedText}\n${model.url}`, textRef)}><Copy size={17} aria-hidden="true" />{labels.text}</button>
      </div>
      <p className={styles.sample}>{labels.sample}</p>
      <p className={styles.privacy}>{labels.privacy}</p>
      <p className={styles.notice} role="status" aria-live="polite">{notice}</p>
    </>}
  </section>;
}
