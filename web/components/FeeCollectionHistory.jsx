'use client';
import { useEffect, useRef, useState } from 'react';
import { readFeeCollectionHistory } from '../lib/fee-collection-history.mjs';
import { amount, explorerAddress, explorerTransaction } from '../lib/live-view.mjs';

const identityOf = config => JSON.stringify([config?.stage, config?.artifactDigest,
  ...['authority', 'gasWallet', 'factory', 'shareMarket', 'portfolioFactory', 'portfolioMarket']
    .map(key => config?.[key]?.toLowerCase()), config?.manifest?.freshAuthority?.codehash,
  Object.entries(config?.manifest?.codehash || {}).sort(([a], [b]) => a.localeCompare(b)),
  String(config?.manifest?.verifiedBlockNumber ?? '')]);
const errorText = error => error?.shortMessage || error?.message || String(error);
const when = timestamp => {
  if (timestamp == null) return '—';
  const value = new Date(Number(timestamp) * 1000);
  return Number.isFinite(value.getTime()) ? value.toLocaleString('zh-CN', { hour12: false }) : '—';
};
const initialView = () => ({ result: null, pageIndex: 0, cursors: [null] });

/** Read-only receipt history, mounted only inside the fees workspace. */
export default function FeeCollectionHistory({ config, provider, wallet, account, refreshKey }) {
  const [view, setView] = useState(initialView), [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const lifecycle = useRef(null), request = useRef(null), failedPage = useRef(null);
  const lastRefresh = useRef(refreshKey), latest = useRef(null);
  const identity = identityOf(config), owner = account?.toLowerCase() || '';
  latest.current = { config, identity, provider, wallet, owner, view };

  async function load(page = latest.current.view.pageIndex, cursors = latest.current.view.cursors, refresh = false) {
    const life = lifecycle.current, context = latest.current;
    if (!life || !latest.current.provider) return;
    request.current?.abort();
    const ticket = new AbortController(); request.current = ticket;
    setLoading(true); setError('');
    const target = { page, cursors };
    const current = () => lifecycle.current === life && request.current === ticket && !ticket.signal.aborted
      && latest.current.identity === context.identity && latest.current.owner === context.owner
      && latest.current.provider === context.provider && latest.current.wallet === context.wallet;
    try {
      const result = await readFeeCollectionHistory({ config: latest.current.config,
        provider: latest.current.provider,
        signal: ticket.signal, cursor: cursors[page], limit: 20, refresh });
      if (!current()) return;
      if (!Array.isArray(result?.rows)) throw new Error('领取记录格式无效，请重试。');
      setView({ result, pageIndex: page, cursors }); failedPage.current = null;
    } catch (problem) {
      if (current()) { setError(errorText(problem)); failedPage.current = target; }
    } finally {
      if (current()) { request.current = null; setLoading(false); }
    }
  }

  useEffect(() => {
    lifecycle.current = {}; lastRefresh.current = refreshKey;
    setView(initialView()); setError(''); setLoading(false); failedPage.current = null;
    void load(0, [null]);
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible' && latest.current.view.pageIndex === 0 && !request.current)
        void load(0, [null]);
    }, 30_000);
    return () => { lifecycle.current = null; clearInterval(timer); request.current?.abort(); request.current = null; };
  }, [identity, provider, wallet, owner]);

  useEffect(() => {
    if (lastRefresh.current === refreshKey) return;
    lastRefresh.current = refreshKey;
    // A newly confirmed collection belongs on the newest page; it supersedes
    // any older-page read that was still in flight.
    void load(0, [null], true);
  }, [refreshKey]);

  const { result, pageIndex, cursors } = view;
  const rows = result?.rows || [], hasNext = result?.nextCursor != null;
  const retry = () => {
    const target = failedPage.current;
    if (target) void load(target.page, target.cursors, true); else void load(undefined, undefined, true);
  };
  return <section className="fee-collection-history" aria-label="手续费领取记录">
    <div className="fee-history-heading">
      <div><h3>手续费领取记录</h3><p className="subtle-note">查看领取管理员、实收金额及链上回执，按最近领取时间排列。</p></div>
      <button className="btn secondary" disabled={loading || !provider} onClick={() => void load(undefined, undefined, true)}>刷新领取记录</button>
    </div>
    {error && <div className="live-notice error" role="alert">
      领取记录读取失败：{error}。{result ? '已显示的记录仍保留。' : '请重试。'}
      <button className="btn secondary" disabled={loading || !provider} onClick={retry}>重试读取</button>
    </div>}
    <div className="fee-history-table" aria-busy={loading}>
      <table><thead><tr><th>领取时间</th><th>领取管理员</th><th>领取 BNB</th><th>领取 BEM</th><th>交易回执</th></tr></thead>
        <tbody>{rows.map(row => <tr key={`${row.transactionHash}:${row.logIndex}`}>
          <td>{when(row.timestamp)}</td>
          <td><a className="fee-history-address" href={explorerAddress(row.administrator)}
            title={row.administrator} target="_blank" rel="noreferrer">{row.administrator}</a></td>
          <td className="fee-history-amount">{amount(BigInt(row.bnbAmountWei))}</td>
          <td className="fee-history-amount">{amount(BigInt(row.bemAmountWei))}</td>
          <td><a href={explorerTransaction(row.transactionHash)} title={row.transactionHash} target="_blank" rel="noreferrer">
            {row.transactionHash.slice(0, 8)}…{row.transactionHash.slice(-6)} ↗</a></td>
        </tr>)}</tbody>
      </table>
      {!rows.length && <p className="fee-history-empty">{!result
        ? loading ? '正在读取领取记录…' : '领取记录尚未读取成功。'
        : hasNext ? '本次扫描范围内暂无领取记录，可继续查看更早记录。'
          : result.complete === false ? '当前历史记录尚未完整读取，请刷新重试。'
            : pageIndex === 0 ? '当前正式部署暂无已确认的手续费领取记录。' : '已到最早记录，本页没有更多领取记录。'}</p>}
    </div>
    <div className="fee-history-pagination">
      <span className="subtle-note">第 {pageIndex + 1} 页 · 每页最多 20 条
        {result && ` · 数据截止区块 #${String(result.safeBlockNumber ?? result.toBlock)}`}
        {loading ? ' · 正在更新…' : pageIndex === 0 ? ' · 本页每 30 秒更新' : ' · 历史页保持当前记录'}</span>
      <div className="live-actions">
        {pageIndex > 0 && <button className="btn secondary" disabled={loading} onClick={() => void load(0, [null])}>返回最新</button>}
        <button className="btn secondary" disabled={loading || pageIndex === 0} onClick={() => void load(pageIndex - 1, cursors)}>上一页</button>
        <button className="btn secondary" disabled={loading || !hasNext} onClick={() => void load(pageIndex + 1,
          [...cursors.slice(0, pageIndex + 1), result.nextCursor])}>更早记录</button>
      </div>
    </div>
  </section>;
}
