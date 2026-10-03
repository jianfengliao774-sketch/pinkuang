'use client';
import { useEffect, useRef, useState } from 'react';
import { getAddress } from 'ethers';
import { readFeeCollection } from '../lib/fee-collection.mjs';
import { collectFeeBatches } from '../lib/fee-collection-flow.mjs';
import { authorityActionStatus } from '../lib/authority-client.mjs';
import { amount } from '../lib/live-view.mjs';
import FeeCollectionHistory from './FeeCollectionHistory.jsx';

const errorText = value => value?.shortMessage || value?.message || String(value);
const settled = status => !status?.status || ['idle', 'confirmed', 'failed'].includes(status.status);
const deploymentIdentity = config => JSON.stringify([config?.stage, config?.artifactDigest,
  ...['authority', 'gasWallet', 'factory', 'shareMarket', 'portfolioFactory', 'portfolioMarket']
    .map(key => config?.[key]?.toLowerCase()), config?.manifest?.freshAuthority?.codehash,
  config?.manifest?.codehash]);

/** Only this pane reads fees. No source selector, member claim or manual address. */
export default function FeeCollection({ config, provider, account, wallet, disabled, status,
  refreshKey, onAction, onStatus }) {
  const [plan, setPlan] = useState(null), [reading, setReading] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [readError, setReadError] = useState('');
  const [progress, setProgress] = useState(null), [notice, setNotice] = useState('');
  const [historyRefresh, setHistoryRefresh] = useState(0);
  const lifecycle = useRef(null), readTicket = useRef(null), actionTicket = useRef(null);
  const latest = useRef(null);
  const identity = deploymentIdentity(config);
  const refreshSeen = useRef({ identity, key: refreshKey });
  latest.current = { config, identity, provider, account, wallet, disabled, onAction, onStatus, refreshKey };

  async function refresh({ force = false } = {}) {
    if (actionTicket.current || !lifecycle.current || readTicket.current && !force) return null;
    if (readTicket.current) { readTicket.current.abort(); readTicket.current = null; }
    const ticket = new AbortController(), life = lifecycle.current;
    readTicket.current = ticket; setReading(true);
    try {
      const result = await readFeeCollection({ config: latest.current.config, provider,
        balanceProvider: wallet, account, signal: ticket.signal, force, refreshToken: latest.current.refreshKey });
      if (lifecycle.current === life && !ticket.signal.aborted) { setPlan(result); setReadError(''); }
      return result;
    } catch (problem) {
      if (lifecycle.current === life && !ticket.signal.aborted) setReadError(errorText(problem));
      return null;
    } finally {
      if (readTicket.current === ticket) { readTicket.current = null; setReading(false); }
    }
  }

  useEffect(() => {
    const life = {}; lifecycle.current = life; setPlan(null); setReading(false); setBusy(false);
    refreshSeen.current = { identity, key: refreshKey };
    setError(''); setReadError(''); setNotice(''); setProgress(null);
    void refresh();
    const timer = setInterval(() => { if (document.visibilityState === 'visible') void refresh(); }, 30_000);
    return () => { lifecycle.current = null; clearInterval(timer);
      readTicket.current?.abort(); readTicket.current = null;
      actionTicket.current?.abort(); actionTicket.current = null; };
  }, [identity, provider, account, wallet]);
  useEffect(() => {
    if (refreshSeen.current.identity === identity && refreshSeen.current.key === refreshKey) return;
    refreshSeen.current = { identity, key: refreshKey };
    void refresh({ force: true });
  }, [identity, refreshKey]);

  async function collect() {
    if (actionTicket.current || disabled || !wallet || !account || !settled(status)) return;
    const ticket = new AbortController(), life = lifecycle.current;
    actionTicket.current = ticket; readTicket.current?.abort(); readTicket.current = null;
    setBusy(true); setReading(false); setError(''); setReadError(''); setNotice(''); setProgress(null);
    const current = () => lifecycle.current === life && !ticket.signal.aborted
      && latest.current.account === account && latest.current.wallet === wallet
      && latest.current.provider === provider && latest.current.identity === identity;
    try {
      const fresh = latest.current.config.displayOnly === true && plan ? plan
        : await readFeeCollection({ config: latest.current.config, provider,
          balanceProvider: wallet, account, signal: ticket.signal, refreshToken: latest.current.refreshKey });
      if (!current()) return;
      if (latest.current.disabled) throw new Error('管理员权限或交易状态已变化，请刷新后再归集。');
      setPlan(fresh);
      if (!fresh.batches.length) { setNotice('暂无可归集的手续费。'); return; }
      const completed = await collectFeeBatches({ plan: fresh, recipient: getAddress(account), signal: ticket.signal,
        current, onAction: (kind, args) => {
          if (!current() || latest.current.disabled) throw new Error('管理员权限或交易状态已变化；后续归集已暂停。');
          return latest.current.onAction(kind, args);
        }, readStatus: () => authorityActionStatus(config, account),
        onStatus: value => { if (current()) latest.current.onStatus?.(value); },
        onProgress: value => { if (current()) setProgress(value); } });
      if (current()) { setNotice(`已完成 ${completed.length} 批归集，手续费已转到当前管理员钱包。`);
        setHistoryRefresh(value => value + 1); }
    } catch (problem) { if (current()) setError(errorText(problem)); }
    finally {
      if (actionTicket.current === ticket) { actionTicket.current = null; setBusy(false); }
      if (current()) void refresh({ force: true });
    }
  }

  const blocked = disabled || busy || !wallet || !account || !settled(status);
  return <div className="fee-collection">
    <h3>一键归集手续费</h3>
    <p className="subtle-note">自动归集市场、矿池和预算项目的平台手续费。任意一位管理员可领取当前全部可归集金额，Gas 由专用钱包支付。</p>
    <div className="fee-collection-balances">
      <div><span>可归集 BNB</span><strong>{plan ? amount(plan.totalBnbWei) : '—'} BNB</strong></div>
      <div><span>可归集 BEM</span><strong>{plan ? amount(plan.totalBemWei) : '—'} BEM</strong></div>
    </div>
    <p className="subtle-note">接收钱包：{account || '请连接管理员钱包'}</p>
    {reading && <p className="subtle-note" role="status">正在更新手续费余额…</p>}
    {plan && <p className="subtle-note">{plan.blockNumber == null ? '已读取手续费余额' : `已读取区块 #${String(plan.blockNumber)}`} · {plan.sourceCount} 个有余额来源
      {plan.batches.length > 1 && ` · 自动分 ${plan.batches.length} 批，每批在钱包签名`}</p>}
    {progress && <p className="live-notice" role="status">已完成 {progress.completed.length} / {progress.total} 批
      {progress.phase === 'signing' ? ' · 请在钱包签名' : progress.phase === 'confirming' ? ' · 等待链上确认' : ''}
      {progress.completed.map((hash, index) => <span key={hash}> · <a href={`https://bscscan.com/tx/${hash}`} target="_blank" rel="noreferrer">第 {index + 1} 批回执</a></span>)}</p>}
    {notice && <p className="live-notice" role="status">{notice}</p>}
    {readError && <p className="live-notice error" role="alert">{readError}</p>}
    {error && <p className="live-notice error" role="alert">{error}</p>}
    <div className="live-actions">
      <button className="btn" disabled={blocked} onClick={() => void collect()}>{busy ? '正在归集…' : '一键归集手续费'}</button>
      <button className="btn secondary" disabled={busy || reading} onClick={() => void refresh({ force: true })}>刷新手续费余额</button>
    </div>
    <FeeCollectionHistory config={config} provider={provider} wallet={wallet} account={account}
      refreshKey={`${refreshKey ?? ''}:${historyRefresh}`} />
  </div>;
}
