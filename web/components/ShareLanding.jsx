'use client';

import { useEffect, useState } from 'react';
import { resolveArtworkShareTarget } from '../lib/share-landing.mjs';
import styles from './ShareLanding.module.css';

export default function ShareLanding() {
  const [destination, setDestination] = useState(null);
  const [checked, setChecked] = useState(false);
  const [english, setEnglish] = useState(false);
  const base = process.env.NEXT_PUBLIC_BASE_PATH || '';
  useEffect(() => {
    setEnglish(navigator.language?.startsWith('en') === true);
    const target = resolveArtworkShareTarget(window.location.search, base, process.env.NODE_ENV === 'production');
    setDestination(target);
    setChecked(true);
    if (target) window.location.replace(target);
  }, [base]);
  return <main className={styles.page}>
    <section className={styles.card}>
      <div className={styles.brand}>BEMine <span>拼矿</span></div>
      <h1>{english ? 'A shared mining adventure.' : '矿友的邀请，从这里开始。'}</h1>
      <p aria-live="polite">{!checked || destination
        ? english ? 'Opening the mining project…' : '正在打开矿机项目…'
        : english ? 'Explore BEMine and find your mining crew.' : '了解拼矿，遇见一起参与的矿友。'}</p>
      <a href={destination || `${base}/`}>{english ? 'View project' : '查看项目'} <span aria-hidden="true">↗</span></a>
      <noscript>请开启 JavaScript 查看朋友分享的矿机。Enable JavaScript to open the shared miner.</noscript>
    </section>
  </main>;
}
