"use client";
import { useEffect, useRef, useState } from 'react';

/** Each verified cursor is requested once automatically. Failed reads require
 * an explicit retry, so a visible sentinel cannot spin against an unavailable API. */
export default function AutoPageLoader({ pageKey, cursor, disabled, onLoad, locale }) {
  const sentinel = useRef(null), pending = useRef(false), attempted = useRef(new Set());
  const current = useRef(null), request = useRef(null);
  const [failed, setFailed] = useState(false), [loading, setLoading] = useState(false);
  const key = JSON.stringify([pageKey, cursor]);
  current.current = key;
  request.current = async (retry = false) => {
    if (disabled || pending.current || (!retry && attempted.current.has(key))) return;
    attempted.current.add(key); pending.current = true;
    setLoading(true); setFailed(false);
    try {
      const loaded = await onLoad();
      if (current.current === key && loaded === false) setFailed(true);
    } catch {
      if (current.current === key) setFailed(true);
    } finally {
      pending.current = false;
      if (current.current === key) setLoading(false);
    }
  };
  useEffect(() => { attempted.current.clear(); }, [pageKey]);
  useEffect(() => { setFailed(false); setLoading(false); }, [key]);
  useEffect(() => {
    if (!sentinel.current || disabled || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) void request.current();
    }, { rootMargin: '160px 0px' });
    observer.observe(sentinel.current);
    return () => observer.disconnect();
  }, [key, disabled]);
  useEffect(() => () => { current.current = null; }, []);
  if (cursor == null) return null;
  return <div ref={sentinel} className="live-more" data-auto-page={key} aria-live="polite">
    {loading ? <span role="status">{locale === 'en' ? 'Loading more records…' : '正在加载更多记录…'}</span>
      : <button className="btn secondary" disabled={disabled} onClick={() => void request.current(true)}>
        {failed ? locale === 'en' ? 'Read failed · retry' : '读取失败 · 重试'
          : locale === 'en' ? 'Load more records' : '加载更多记录'}
      </button>}
  </div>;
}
