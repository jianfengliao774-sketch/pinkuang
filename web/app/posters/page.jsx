import { SHARE_ARTWORKS } from '../../lib/share-artwork.mjs';
import { shareMotto, SHARE_MOTTO_COUNT } from '../../lib/share-copy.mjs';
import styles from './posters.module.css';

export const metadata = { title: '拼矿 BEMine · 分享海报', robots: { index: false, follow: false } };
export default function PostersPage() {
  const base = process.env.NEXT_PUBLIC_BASE_PATH || '';
  return <main className={styles.page}>
    <header className={styles.heading}>
      <a className={styles.brand} href={`${base}/`}>BEMine <span>拼矿</span></a>
      <p className={styles.eyebrow}>THE MINING CREW COLLECTION</p>
      <h1>每一份参与，都有自己的色彩。</h1>
      <p>Every share has a story. Find a poster for yours.</p>
      <a className={styles.preview} href={`${base}/preview${process.env.NODE_ENV === 'production' ? '.html' : ''}#share/16928`}>体验分享 · Try sharing ↗</a>
    </header>
    <div className={styles.grid}>
      {SHARE_ARTWORKS.map((art, index) => <article className={styles.card} key={art.id}>
        <picture>
          <source media="(max-width:600px)" srcSet={`${base}/images/${art.base}-mobile.webp`} />
          <img src={`${base}/images/${art.base}.webp`} alt={`BEMine · ${art.zh} / ${art.en}`} width="1200" height="630" loading={index > 1 ? 'lazy' : 'eager'} decoding="async" />
        </picture>
        <div><h2>{art.zh}<span>{art.en}</span></h2><a href={`${base}/images/${art.base}.jpg`} download={`BEMine-${art.id}.jpg`}>保存 / Save ↓</a></div>
      </article>)}
    </div>
    <section className={styles.mottos}>
      <p className={styles.eyebrow}>WORDS TO SHARE</p><h2>把这一份热爱，分享给矿友。</h2>
      <ol>{Array.from({ length: SHARE_MOTTO_COUNT }, (_, index) => <li key={index}><strong>{shareMotto('zh', index, true)}</strong><span>{shareMotto('en', index, true)}</span></li>)}</ol>
    </section>
  </main>;
}
