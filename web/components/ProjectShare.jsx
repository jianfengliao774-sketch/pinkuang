'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { CheckCircle2, Copy, Link2, Send, Share2, X } from 'lucide-react';
import { createProjectShare } from '../lib/project-share.mjs';
import { commonSharePreview } from '../lib/share-preview.mjs';
import ShareArtwork from './ShareArtwork';
import ShareCopyControls from './ShareCopyControls';
import useShareVariation from './useShareVariation';
import styles from './ProjectShare.module.css';

const COPY = {
  zh: {
    confirmed: '认购已确认', invite: '邀请朋友了解项目', heading: '一份参与，一起分享',
    intro: '把这台矿机的故事和项目进展分享给朋友。',
    link: '复制项目链接', text: '复制分享文案', close: '收起分享',
    privacy: '分享内容不包含你的钱包地址或个人投入金额。',
    copied: '已复制', copyFailed: '未能复制，请长按或选中文案手动复制。',
    opened: '请在打开的分享窗口中确认发送。', label: '分享文案',
  },
  en: {
    confirmed: 'Subscription confirmed', invite: 'Invite friends to explore', heading: 'One share. A shared journey.',
    intro: 'Share this miner and its project journey with friends.',
    link: 'Copy project link', text: 'Copy share text', close: 'Dismiss sharing',
    privacy: 'Your wallet address and personal contribution are not included.',
    copied: 'Copied', copyFailed: 'Copy failed. Select or long-press the text to copy it manually.',
    opened: 'Confirm sending in the sharing window.', label: 'Share text',
  },
};

/** Only pass a receipt finalised and verified by the transaction layer. No third-party SDKs or automatic sends. */
export default function ProjectShare({ locale = 'zh', publicBaseUrl, project, confirmation, onDismiss }) {
  const copy = COPY[locale === 'en' ? 'en' : 'zh'];
  const { posterId, mottoIndex, ready, changeVariation } = useShareVariation();
  const model = createProjectShare({ locale, publicBaseUrl, project, confirmation, mottoIndex, posterId });
  const headingId = useId();
  const previewRef = useRef(null);
  const [notice, setNotice] = useState('');
  useEffect(() => { setNotice(''); }, [locale, project?.poolAddress, confirmation?.transactionHash]);
  if (!model) return <section className={styles.card}>
    <h2 className={styles.heading}>{locale === 'en' ? 'Sharing is temporarily unavailable' : '暂时无法分享此项目'}</h2>
    <p className={styles.intro}>{locale === 'en' ? 'Refresh the project details and try again.' : '请刷新项目资料后重试。'}</p>
    {onDismiss && <div className={styles.actions}><button type="button" onClick={onDismiss}>{copy.close}</button></div>}
  </section>;

  async function copyValue(value) {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(value);
      setNotice(copy.copied);
    } catch {
      previewRef.current?.focus();
      previewRef.current?.select();
      setNotice(copy.copyFailed);
    }
  }

  const preview = commonSharePreview(model);
  const selectedCopy = preview.copyText;

  return <section className={styles.card} aria-labelledby={headingId}>
    <div className={styles.top}>
      <span className={styles.badge}>{model.confirmed ? <CheckCircle2 size={17} aria-hidden="true" /> : <Share2 size={17} aria-hidden="true" />}{model.confirmed ? copy.confirmed : copy.invite}</span>
      {onDismiss && <button type="button" className={styles.dismiss} onClick={onDismiss} aria-label={copy.close}><X size={20} aria-hidden="true" /></button>}
    </div>
    <h2 id={headingId} className={styles.heading}>{copy.heading}</h2>
    <p className={styles.intro}>{copy.intro}</p>
    <ShareArtwork locale={locale} posterId={posterId} ready={ready} />
    <div className={styles.preview}>
      <div className={styles.brand}>拼矿 <span>BEMine</span></div>
      <strong className={styles.project}>{model.title}</strong>
      <ShareCopyControls locale={locale} ready={ready} onNextVariation={() => { changeVariation(); setNotice(''); }} />
      <textarea ref={previewRef} aria-label={copy.label} readOnly value={selectedCopy} rows={6} />
    </div>
    <div className={styles.actions}>
      <a href={preview.telegramUrl} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer" onClick={() => setNotice(copy.opened)}><Send size={17} aria-hidden="true" />Telegram</a>
      <a href={model.xUrl} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer" onClick={() => setNotice(copy.opened)}><span className={styles.xMark} aria-hidden="true">𝕏</span>X</a>
      <button type="button" onClick={() => copyValue(model.url)}><Link2 size={17} aria-hidden="true" />{copy.link}</button>
      <button type="button" onClick={() => copyValue(selectedCopy)}><Copy size={17} aria-hidden="true" />{copy.text}</button>
    </div>
    <p className={styles.privacy}>{copy.privacy}</p>
    <p className={styles.notice} role="status" aria-live="polite">{notice}</p>
  </section>;
}
