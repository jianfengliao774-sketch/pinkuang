'use client';
import { useEffect, useRef, useState } from 'react';
import { getAddress } from 'ethers';
import { readSaleReviewRequests, refreshSaleReviewRequest } from '../lib/sale-review-requests.mjs';
import { readDisplaySnapshot, writeDisplaySnapshot } from '../lib/display-snapshot.mjs';
import { amount, shortAddress, explorerAddress } from '../lib/live-view.mjs';

const labels = { pending: '待审核', approved: '已批准', rejected: '已驳回', 'no-review': '无需审核',
  expired: '已过期', executed: '已执行', 'reference-missing': '待更新参考价', 'review-unavailable': '审核状态暂不可用' };
const time = value => value == null ? '—' : new Date(Number(value) * 1000).toLocaleString('zh-CN', { hour12: false });
const storage = () => { try { return window.sessionStorage; } catch { return null; } };
const message = error => error?.message || String(error);
const link = address => address ? <a href={explorerAddress(address)} target="_blank" rel="noreferrer" title={address}>{shortAddress(address)} ↗</a> : '暂不可确认';

export default function SaleReviewRequests(props) {
  const [scope, setScope] = useState('pool');
  const identity = [props.config?.artifactDigest, props.config?.factory, props.config?.portfolioFactory,
    props.config?.authority, props.account, scope].join(':').toLowerCase();
  return <div className="sale-review-inbox">
    <div className="operator-tabs" role="group" aria-label="申请类型">
      <button className={`btn${scope === 'pool' ? '' : ' secondary'}`} disabled={props.disabled}
        aria-pressed={scope === 'pool'} onClick={() => setScope('pool')}>单机出售申请</button>
      <button className={`btn${scope === 'portfolio' ? '' : ' secondary'}`} disabled={props.disabled}
        aria-pressed={scope === 'portfolio'} onClick={() => setScope('portfolio')}>预算项目出售申请</button>
    </div>
    <RequestsPage key={identity} {...props} scope={scope} identity={identity}/>
  </div>;
}

function RequestsPage({ config, provider, account, disabled, onReview, onSelect, refreshKey, scope, identity }) {
  const direct = config?.displayOnly === true;
  const cacheKey = `sale-review-requests:${identity}`;
  const manifest = config.manifest || config;
  const [result, setResult] = useState(() => readDisplaySnapshot(storage(), manifest, cacheKey, { maxAgeMs: 120_000 }));
  const [cached, setCached] = useState(!!result);
  const [loading, setLoading] = useState(false), [acting, setActing] = useState(false);
  const [error, setError] = useState(''), [filter, setFilter] = useState('all'), [selectedKey, setSelectedKey] = useState(null);
  const sequence = useRef(0), working = useRef(false), actionLock = useRef(null);
  const readTicket = useRef(null);
  const current = useRef({});
  current.current = { config, provider, disabled, result, onReview, onSelect, selectedKey };
  const selected = result?.items?.find(item => item.key === selectedKey);

  async function load(cursor = current.current.result?.cursor ?? 0, { force = false } = {}) {
    if (working.current || actionLock.current || !current.current.provider) return;
    const ticket = ++sequence.current;
    const abort = new AbortController(); readTicket.current = abort;
    working.current = true; setLoading(true); setError('');
    try {
      const next = await readSaleReviewRequests({ config: current.current.config, provider: current.current.provider,
        account, scope, cursor, limit: 10, force, refreshToken: refreshKey, signal: abort.signal });
      if (ticket !== sequence.current) return;
      setResult(next); setCached(false); setSelectedKey(null);
      // Only the first directory page is restored on return; pagination stays explicit.
      if (cursor === 0 && !next.errors?.length) writeDisplaySnapshot(storage(), manifest, cacheKey, next);
    } catch (problem) {
      if (ticket === sequence.current) { setError(message(problem)); setCached(true); }
    } finally {
      if (ticket === sequence.current) { readTicket.current = null; working.current = false; setLoading(false); }
    }
  }

  useEffect(() => {
    setActing(false);
    void load();
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible' && !current.current.disabled && !current.current.selectedKey) void load();
    }, 30_000);
    return () => {
      clearInterval(timer); ++sequence.current; working.current = false;
      readTicket.current?.abort(); readTicket.current = null;
      // Retire the previous read/action context before the next refresh starts.
      // Its eventual completion must not keep or release a newer action's lock.
      actionLock.current = null;
    };
  }, [provider, refreshKey]);

  async function review(approved) {
    if (!selected || disabled || actionLock.current || !direct && (loading || cached)) return;
    const original = selected, ticket = sequence.current, action = {};
    let submitted = false;
    actionLock.current = action; setActing(true); setError('');
    try {
      const fresh = direct ? original : await refreshSaleReviewRequest({ config: current.current.config, provider: current.current.provider, item: original });
      if (ticket !== sequence.current) return;
      const latest = { ...fresh, proposer: fresh.proposer || original.proposer,
        proposerUnavailable: fresh.proposer || original.proposer ? null : fresh.proposerUnavailable };
      if (current.current.disabled) throw new Error('管理员或交易状态已变化，请重新读取。');
      setResult(previous => ({ ...previous, items: previous.items.map(item => item.key === latest.key ? latest : item) }));
      if (!latest.canReview || latest.priceWei !== original.priceWei || latest.pool.toLowerCase() !== original.pool.toLowerCase()
        || latest.referencePriceWei !== original.referencePriceWei || (approved && latest.status === 'approved'))
        throw new Error('申请价格、参考价或审核状态已变化，已更新详情，请重新核对。');
      const args = latest.kind === 'pool'
        ? { market: getAddress(config.shareMarket), pool: latest.project, proposalId: latest.proposalId.toString(),
          priceWei: latest.priceWei.toString(), approved }
        : { portfolio: latest.project, proposalId: latest.proposalId.toString(), approved };
      const response = await current.current.onReview(latest.kind === 'pool' ? 'reviewSale' : 'reviewChildSale', args);
      if (ticket === sequence.current && response) { submitted = true; setSelectedKey(null); setCached(true); }
    } catch (problem) { if (ticket === sequence.current) setError(message(problem)); }
    finally {
      if (actionLock.current === action) {
        actionLock.current = null; setActing(false);
        if (ticket === sequence.current && submitted) void load(undefined, { force: true });
      }
    }
  }

  const items = result?.items || [];
  const visible = filter === 'all' ? items : items.filter(item => ['pending', 'reference-missing', 'review-unavailable'].includes(item.status));
  const frozen = disabled || acting || !direct && (loading || cached);
  return <>
    <div className="sale-review-toolbar">
      <label>申请状态<select value={filter} onChange={event => setFilter(event.target.value)}>
        <option value="all">全部本轮申请</option><option value="pending">待处理</option>
      </select></label>
      <button className="btn secondary" disabled={loading || acting || disabled || !provider} onClick={() => void load(undefined, { force: true })}>刷新申请</button>
    </div>
    <p className="subtle-note">显示已提交的本轮出售申请。投票须双过半，仅需要人工审核的报价可在此批准或驳回。</p>
    {!direct && cached && result && <p className="live-notice" role="status">正在显示上次读取的申请，更新后可审核。</p>}
    {error && <p className="live-notice error" role="alert">申请读取或处理失败：{error}。已有记录已保留，请重试。</p>}
    {!!result?.errors?.length && <div className="live-notice error" role="alert">部分项目尚未读取成功，列表可能不完整。
      {result.errors.map(item => <div key={item.project}>{link(item.project)}：{item.message}</div>)}
    </div>}
    <div className="sale-review-table" aria-busy={loading}>
      <table><thead><tr><th>矿机 / 提案</th><th>申请人</th><th>申请价 / 市场参考价</th><th>投票进度</th><th>审核状态</th><th>操作</th></tr></thead>
        <tbody>{visible.map(item => <tr key={item.key} data-selected={item.key === selectedKey}>
          <td>{item.tokenId == null ? (scope === 'portfolio' ? '预算项目子矿机' : '单机项目') : `#${item.tokenId}`}<small>{link(item.pool)} · 提案 #{item.proposalId.toString()}</small></td>
          <td>{link(item.proposer)}</td>
          <td>{amount(item.priceWei)} BNB<small>参考 {amount(item.referencePriceWei)} BNB</small></td>
          <td>{item.yesShares.toString()} / {item.requiredYesShares.toString()} 份<small>{item.yesCount.toString()} / {item.requiredYesCount.toString()} 人 · {item.passed ? '已达双过半' : '未达门槛'}</small></td>
          <td>{labels[item.status] || '待核对'}<small>截止 {time(item.endsAt)}</small></td>
          <td><button className="btn secondary" disabled={acting} onClick={() => { setSelectedKey(item.key); onSelect?.(item); }}>查看申请</button></td>
        </tr>)}</tbody>
      </table>
      {!visible.length && <p className="sale-review-empty">{loading && !result ? '正在读取用户申请…'
        : !result ? '申请尚未读取成功，请刷新重试。'
          : result.errors?.length ? '已成功读取的项目中暂无匹配申请，其余项目请重试。'
            : filter === 'pending' ? '本页没有待处理的申请，可切换「全部本轮申请」。' : '本页项目暂无本轮出售申请。'}</p>}
    </div>
    <div className="sale-review-toolbar">
      <span className="subtle-note">{result ? `本页检查 ${result.projectsRead} 个项目` : ''}{loading ? ' · 正在更新…' : ' · 停留本页时每 30 秒更新'}</span>
      {result?.cursor > 0 && <button className="btn secondary" disabled={loading || acting} onClick={() => void load(0)}>返回首批项目</button>}
      {result?.nextCursor != null && <button className="btn secondary" disabled={loading || acting || disabled} onClick={() => void load(result.nextCursor)}>查看后续项目申请</button>}
    </div>
    {selected && <section className="operator-confirm sale-review-detail" aria-label="申请详情">
      <div className="section-head"><h3>出售申请 #{selected.proposalId.toString()}</h3><button className="btn secondary" disabled={acting} onClick={() => setSelectedKey(null)}>关闭详情</button></div>
      <dl>
        <div><dt>申请人</dt><dd>{link(selected.proposer)}</dd></div>
        <div><dt>所属项目</dt><dd>{link(selected.project)}</dd></div>
        {selected.kind === 'portfolio' && <div><dt>出售的子矿机</dt><dd>{link(selected.pool)}</dd></div>}
        <div><dt>申请出售总价</dt><dd>{amount(selected.priceWei)} BNB</dd></div>
        <div><dt>当前市场参考价</dt><dd>{amount(selected.referencePriceWei)} BNB</dd></div>
        <div><dt>人工审核门槛</dt><dd>售价低于参考价的 {Number(selected.saleReviewThresholdBps ?? 10000n) / 100}%</dd></div>
        <div><dt>申请时记录的参考价</dt><dd>{amount(selected.recordedReferencePriceWei)} BNB</dd></div>
        <div><dt>截止时间</dt><dd>{time(selected.endsAt)}</dd></div>
        <div><dt>当前状态</dt><dd>{labels[selected.status] || '待核对'}</dd></div>
      </dl>
      {selected.proposerUnavailable && <p className="subtle-note">{typeof selected.proposerUnavailable === 'string' ? selected.proposerUnavailable : '该提案未能核实申请人地址。'}</p>}
      {selected.status === 'reference-missing' && <p className="live-notice">市场参考价缺失或已过期。该矿机地址已填入下方参考价工具，更新后刷新申请。</p>}
      <div className="operator-tabs">
        <button className="btn" disabled={frozen || !selected.canReview || selected.status === 'approved'} onClick={() => void review(true)}>{acting ? '正在处理…' : '签名批准'}</button>
        <button className="btn secondary" disabled={frozen || !selected.canReview} onClick={() => void review(false)}>签名驳回</button>
      </div>
    </section>}
  </>;
}
