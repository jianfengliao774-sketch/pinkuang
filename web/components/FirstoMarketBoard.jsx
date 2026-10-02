'use client';

import { useEffect, useRef, useState } from 'react';
import { ExternalLink, RefreshCw } from 'lucide-react';
import { useI18n } from '../lib/i18n';
import { MAX_QUOTE_AGE_MS } from '../../deploy/src/pricing.ts';
import {
  FIRSTO_MARKET_SOURCE,
  formatMarketAmount,
  readFirstoMarketBoard,
} from './firsto-market-board.mjs';
import './FirstoMarketBoard.css';

const text = (locale, zh, en) => locale === 'en' ? en : zh;
const venue = (value, locale) => locale === 'en'
  ? ({ 'Firsto 挂单': 'Firsto listing', 'TapeOut 官网挂单': 'TapeOut listing' }[value] ?? value)
  : value;
const time = (stamp, locale) => Number.isFinite(stamp) && stamp > 0
  ? new Date(stamp).toLocaleString(locale === 'en' ? 'en-US' : 'zh-CN', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }) : '—';
let recentBoard = null;

/** Public Firsto quotes only. No wallet provider, account read, signature or transaction path. */
export default function FirstoMarketBoard({ refreshKey = 0 }) {
  const { locale } = useI18n();
  const [data, setData] = useState(() => recentBoard && Date.now() - recentBoard.savedAt < 600_000
    ? recentBoard.data : null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [now, setNow] = useState(() => Date.now());
  const request = useRef({ sequence: 0, abort: null, timer: null });

  function invalidate() {
    request.current.abort?.abort();
    if (request.current.timer) clearTimeout(request.current.timer);
    request.current.sequence += 1;
  }
  async function load(page = 1, viewId) {
    invalidate();
    const sequence = request.current.sequence, abort = new AbortController();
    request.current.abort = abort;
    request.current.timer = setTimeout(() => abort.abort(), 15_000);
    setBusy(true); setError('');
    try {
      const result = await readFirstoMarketBoard({ page, viewId, signal: abort.signal });
      if (sequence === request.current.sequence) {
        recentBoard = { savedAt: Date.now(), refreshKey, data: result };
        setData(result); setNow(Date.now());
      }
    } catch (problem) {
      if (sequence === request.current.sequence) setError(problem?.name === 'AbortError'
        ? text(locale, '读取市场超时，请刷新重试。', 'Market request timed out. Refresh to retry.')
        : problem?.message || text(locale, '市场报价暂不可用。', 'Market quotes are unavailable.'));
    } finally {
      if (sequence === request.current.sequence) { clearTimeout(request.current.timer); setBusy(false); }
    }
  }

  useEffect(() => {
    const stamp = Date.now();
    const cached = recentBoard && recentBoard.refreshKey === refreshKey && stamp - recentBoard.savedAt < 120_000
      && recentBoard.data.rows.every(row => row.validUntil == null || row.validUntil > stamp)
      && (!recentBoard.data.reference || stamp <= recentBoard.data.reference.observedAt + MAX_QUOTE_AGE_MS);
    if (cached) { setData(recentBoard.data); setNow(Date.now()); }
    else void load(data?.page || 1);
    const tick = setInterval(() => setNow(Date.now()), 15_000);
    return () => { clearInterval(tick); invalidate(); };
  }, [refreshKey]);

  const referenceFresh = data?.reference && now <= data.reference.observedAt + MAX_QUOTE_AGE_MS;
  const reference = referenceFresh ? data.reference : null;
  return <section className="firsto-board" aria-label={text(locale, 'Firsto 实时矿机行情', 'Firsto live miner quotes')}>
    <header className="firsto-board-head">
      <div><span className="firsto-board-eyebrow">FIRSTO · BSC MAINNET</span>
        <h2>{text(locale, '真实矿机市场 · 日产能价', 'Live miner market · price per daily output')}</h2>
        <p>{text(locale, '查看 Firsto 当前矿机报价与预计日产 BEM。',
          'Compare current miner quotes and expected daily BEM from Firsto.')}</p>
      </div>
      <div className="firsto-board-head-actions">
        <a href={FIRSTO_MARKET_SOURCE} target="_blank" rel="noopener noreferrer">{text(locale, 'Firsto 网站', 'Firsto website')} <ExternalLink size={16}/></a>
        <button type="button" disabled={busy} onClick={() => void load()}><RefreshCw size={15}/>{text(locale, '刷新', 'Refresh')}</button>
      </div>
    </header>
    <div className="firsto-board-reference">
      <div><span>{text(locale, '市场参考日产能价', 'Market reference price per daily BEM')}</span>
        <strong>{reference ? formatMarketAmount(reference.dailyCapacityPriceWei) : text(locale, '暂不可用', 'Unavailable')}</strong>
        <small>BNB / (BEM / {text(locale, '天', 'day')})</small></div>
      <p>{reference
        ? `${text(locale, 'Firsto 更新', 'Firsto updated')} ${time(reference.observedAt, locale)} · ${text(locale, '来源区块', 'Source block')} #${reference.sourceBlock}`
        : data?.referenceError || text(locale, '参考价已过期或市场覆盖不完整，请刷新。', 'Reference is stale or market coverage is incomplete. Refresh.')}</p>
    </div>
    {busy && <p className="firsto-board-status" role="status">{text(locale, '正在读取市场报价…', 'Loading market quotes…')}</p>}
    {error && <p className="firsto-board-error" role="alert">{error}</p>}
    {data && <>
      <div className="firsto-board-table-wrap"><table><thead><tr>
        <th>{text(locale, '矿机 / 来源', 'Miner / venue')}</th>
        <th>{text(locale, '卖家挂单价', 'Seller ask')}<small>BNB</small></th>
        <th>{text(locale, '预计日产BEM', 'Expected daily BEM')}<small>BEM / {text(locale, '天', 'day')}</small></th>
        <th>{text(locale, '日产能价', 'Price per daily BEM')}<small>BNB / (BEM / {text(locale, '天', 'day')})</small></th>
        <th>{text(locale, '报价时间 / 来源', 'Quote time / source')}</th>
      </tr></thead><tbody>{data.rows.map(row => {
        const unavailable = row.unavailable || now >= row.validUntil && text(locale, '报价已过期，请刷新', 'Quote expired. Refresh.');
        return <tr key={row.key}>
          <td><strong>{row.series} #{row.tokenId}</strong><small>T{row.taskId ?? '—'} · {venue(row.venue, locale)}</small></td>
          <td>{unavailable ? '—' : formatMarketAmount(row.sellerPriceWei)}</td>
          <td>{unavailable ? '—' : formatMarketAmount(row.estimated24hAtomic, 8, 5)}</td>
          <td className="firsto-board-unit">{unavailable ? text(locale, '暂不可用', 'Unavailable') :
            <strong>{formatMarketAmount(row.dailyCapacityPriceWei)}</strong>}</td>
          <td><time>{time(row.observedAt, locale)}</time><small>#{row.sourceBlock} · <a href={FIRSTO_MARKET_SOURCE} target="_blank" rel="noopener noreferrer">{text(locale, '查看网站', 'Open website')} ↗</a></small>
            {unavailable && <em>{unavailable}</em>}</td>
        </tr>;
      })}</tbody></table></div>
      {!data.rows.length && <p className="firsto-board-status">{text(locale, '当前没有通过官方身份检查的矿机报价。', 'No official miner quote passed identity checks.')}</p>}
      <footer className="firsto-board-foot">
        <p>{text(locale,
          '日产能价按卖家挂单价除以预计日产 BEM 计算。市场参考价来自 Firsto 统计，预计日产随全网状态变化。',
          'Price per daily BEM is the seller ask divided by expected daily BEM. The market reference comes from Firsto statistics; expected output varies with network conditions.')}</p>
        <div><button type="button" disabled={busy || data.page <= 1} onClick={() => void load(data.page - 1, data.viewId)}>{text(locale, '上一页', 'Previous')}</button>
          <span>{data.page} / {Math.max(1, data.totalPages)}</span>
          <button type="button" disabled={busy || data.page >= data.totalPages} onClick={() => void load(data.page + 1, data.viewId)}>{text(locale, '下一页', 'Next')}</button></div>
      </footer>
    </>}
  </section>;
}
