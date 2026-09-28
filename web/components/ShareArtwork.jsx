'use client';

import { Download } from 'lucide-react';
import { shareArtwork } from '../lib/share-artwork.mjs';
import styles from './ShareArtwork.module.css';

export default function ShareArtwork({ locale = 'zh', posterId = 'original', ready = true }) {
  const english = locale === 'en';
  const artwork = shareArtwork(posterId);
  const base = `${process.env.NEXT_PUBLIC_BASE_PATH || ''}/images/${artwork.base}`;
  if (!ready) return <figure className={styles.artwork} aria-busy="true"><div className={styles.placeholder} role="status">{english ? 'Preparing your share card…' : '正在准备分享卡…'}</div></figure>;
  return <figure className={styles.artwork} data-share-poster={artwork.id}>
    <picture>
      <source media="(max-width: 600px)" srcSet={`${base}-mobile.webp`} type="image/webp" />
      <img src={`${base}.webp`} width="1200" height="630" decoding="async"
        alt={english ? `BEMine ${artwork.en} share poster: mining and community participation.` : `拼矿 BEMine ${artwork.zh}分享海报：矿机与共同参与。`} />
    </picture>
    <figcaption>
      <span>{english ? artwork.en : artwork.zh}</span>
      <a href={`${base}.jpg`} download={`BEMine-${artwork.id}.jpg`}><Download size={16} aria-hidden="true" />{english ? 'Save image' : '保存分享图片'}</a>
      <p>{english ? 'Want to post with an image? Save the poster, then add it in Telegram or X.' : '想配图发布？保存海报后，在 Telegram 或 X 中添加图片。'}</p>
    </figcaption>
  </figure>;
}
