'use client';

import { RefreshCw } from 'lucide-react';
import styles from './ShareCopyControls.module.css';

export default function ShareCopyControls({ locale = 'zh', onNextVariation, ready = true }) {
  const english = locale === 'en';
  return <div className={styles.controls}>
    <button type="button" className={styles.rotate} onClick={onNextVariation} disabled={!ready}><RefreshCw size={15} aria-hidden="true" />{english ? 'Try another pair' : '换一组'}</button>
  </div>;
}
