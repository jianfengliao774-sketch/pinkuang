'use client';
import { useEffect, useRef, useState } from 'react';
import { formatEther, getAddress, parseEther, ZeroAddress } from 'ethers';
import { ArrowRight, CircleAlert, RefreshCw } from 'lucide-react';
import { prepareGovernanceAction, readGovernanceSnapshot } from '../lib/live-governance.mjs';
import { createUiContext } from '../lib/ui-context.mjs';
import '../app/live-governance.css';

const short = value => value ? `${value.slice(0, 8)}…${value.slice(-6)}` : '—';
const errorText = problem => problem?.shortMessage || problem?.message || '出售治理请求未完成。';
const priceWei = value => {
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,18})?$/.test(value)) throw new Error('请输入有效的 BNB 金额，最多 18 位小数。');
  return parseEther(value).toString();
};
const when = seconds => new Date(Number(seconds) * 1000).toLocaleString('zh-CN');

export default function LiveGovernance({ config, account, wallet, pools = [], disabled = false,
  selectedPool, readProvider, onAction, onConnect, onError }) {
  const [poolInput, setPoolInput] = useState(selectedPool || '');
  const [snapshotData, setSnapshot] = useState(null);
  const [salePrice, setSalePrice] = useState('');
  const [referencePrice, setReferencePrice] = useState('');
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const requests = useRef(createUiContext());
  const context = useRef(null);
  const poolValue = selectedPool || poolInput;
  const snapshot = snapshotData?.pool.toLowerCase() === poolValue.trim().toLowerCase()
    && snapshotData?.account.toLowerCase() === (account || ZeroAddress).toLowerCase()
    && snapshotData?.factory.toLowerCase() === config?.factory?.toLowerCase() ? snapshotData : null;
  const identity = `${config?.factory || ''}:${poolValue}:${account || ''}`;
  if (context.current?.identity !== identity || context.current?.wallet !== wallet || context.current?.readProvider !== readProvider) {
    requests.current.invalidate();
    context.current = { identity, wallet, readProvider };
  }

  useEffect(() => {
    setSnapshot(null); setPreview(null); setError(''); setBusy(false);
  }, [account, wallet, config?.factory, poolValue]);
  useEffect(() => () => requests.current.invalidate(), []);
  useEffect(() => {
    if (!poolInput && pools.length) setPoolInput(pools[0]);
  }, [pools.join(','), poolInput]);
  useEffect(() => {
    if (selectedPool && config?.factory && (readProvider || wallet)) void refresh();
  }, [selectedPool, config?.factory, account, wallet, readProvider]);

  function report(problem) { setError(errorText(problem)); onError?.(problem); }
  async function refresh() {
    const ticket = requests.current.begin();
    setBusy(true); setError(''); setPreview(null);
    try {
      const provider = readProvider || wallet;
      if (!provider) throw new Error('链上读取服务暂不可用。');
      const pool = getAddress(poolValue.trim());
      const next = await readGovernanceSnapshot(provider, { factory: config.factory, pool,
        account: account || ZeroAddress });
      if (requests.current.current(ticket)) setSnapshot(next);
    } catch (problem) { if (requests.current.current(ticket)) { setSnapshot(null); report(problem); } }
    finally { if (requests.current.current(ticket)) setBusy(false); }
  }

  async function showPreview(action) {
    if (!account) { onConnect?.(); return; }
    const ticket = requests.current.begin();
    setBusy(true); setError(''); setPreview(null);
    try {
      if (!wallet) throw new Error('钱包不可用。');
      const pool = getAddress(poolValue.trim());
      const prepared = await prepareGovernanceAction(wallet, { factory: config.factory, pool, account, action });
      if (!requests.current.current(ticket)) return;
      setSnapshot(prepared.snapshot);
      setPreview({ action, quote: prepared.quote, pool, account, identity, ticket });
    } catch (problem) { if (requests.current.current(ticket)) report(problem); }
    finally { if (requests.current.current(ticket)) setBusy(false); }
  }

  async function submit() {
    if (!preview || !onAction || preview.identity !== identity || !requests.current.current(preview.ticket)) return;
    const ticket = preview.ticket;
    setBusy(true); setError('');
    try {
      await onAction(preview.pool, { ...preview.action, expectedPool: preview.pool,
        expectedAccount: preview.account,
        ...(preview.action.kind === 'completeSale' ? { expectedPriceWei: preview.quote.priceWei.toString(),
          expectedProposalId: preview.quote.proposalId.toString() } : {}) });
      if (!requests.current.current(ticket)) return;
      setPreview(null);
      await refresh();
    } catch (problem) { if (requests.current.current(ticket)) { setPreview(null); report(problem); } }
    finally { if (requests.current.current(ticket)) setBusy(false); }
  }

  const frozen = busy || disabled || !account || !wallet || !snapshot;
  const opener = snapshot?.candidates.find(item => item.id === snapshot.activeProposalId);
  const roundOpen = snapshot?.state === 2n && opener && !opener.executed && snapshot.timestamp < opener.endsAt;
  const listed = snapshot?.state === 3n && snapshot.listedProposalId > 0n;
  return <section className="live-section live-governance" aria-label="真实整机出售治理">
    <div className="live-section-head"><div><h2>整机出售治理</h2><p>一个七天周期内，每位持有人可以提出自己的价格候选；同轮候选共用固定份额快照与投票截止时间。先达到门槛并执行的候选生效。</p></div><button className="live-gov-refresh" disabled={busy || !config || !poolValue} onClick={() => void refresh()}><RefreshCw size={15}/>读取链上治理</button></div>
    {error && <div className="live-gov-error" role="alert"><CircleAlert size={16}/>{error}</div>}
    <div className="live-gov-selector"><label>矿池地址<input value={poolValue} readOnly={!!selectedPool} list="live-governance-pools" onChange={event => { requests.current.invalidate(); setPoolInput(event.target.value); }} placeholder="0x…"/></label><datalist id="live-governance-pools">{pools.map(pool => <option value={pool} key={pool}/>)}</datalist><span>只有经过链上 Factory 注册核对的池可操作。</span></div>
    {!snapshot && <p className="live-gov-muted">选择矿池并读取。页面不从浏览器缓存恢复提案或余额。</p>}
    {snapshot && <><div className="live-gov-metrics"><div><span>链上快照</span><strong>#{snapshot.blockNumber.toString()}</strong></div><div><span>我的当前份额</span><strong>{snapshot.shares.toString()} / 100</strong></div><div><span>投票快照份额</span><strong>{snapshot.candidates.length ? snapshot.snapshotShares.toString() : '尚未开启'}</strong></div><div><span>实际购机价</span><strong>{formatEther(snapshot.purchaseCost)} BNB</strong></div><div><span>交易状态</span><strong>{snapshot.state === 2n ? roundOpen ? '投票中 · 份额冻结' : '运行中' : listed ? '整机挂牌中' : `状态 ${snapshot.state}`}</strong></div></div>
      {snapshot.candidates.length > 0 && <div className="live-gov-candidates"><h3>本轮报价候选 <small>{snapshot.candidates.length} 个 · 截止 {when(opener.endsAt)}</small></h3><div className="live-gov-grid">{snapshot.candidates.map(item => <article key={item.id.toString()}><div className="live-gov-candidate-head"><strong>提案 #{item.id.toString()}</strong><span>{item.executed ? '已执行' : item.passed ? '已达门槛' : '投票中'}</span></div><p className="live-gov-price">{formatEther(item.priceWei)} <small>BNB</small></p><p className="live-gov-muted">提案人 {short(item.proposer)} · 参考价 {formatEther(item.refPriceWei)} BNB</p><div className="live-gov-votes"><div><span>赞成份额</span><strong>{item.yesShares.toString()} / {item.requiredYesShares.toString()}</strong></div><div><span>赞成人数</span><strong>{item.yesCount.toString()} / {item.requiredYesCount.toString()}</strong></div></div><p className="live-gov-muted">{item.discounted ? '低于实际购机价：至少 60 份且人数过半' : '不低于实际购机价：份额与人数均过半'}{item.hasVoted ? ' · 你已投票' : ''}</p><div className="live-gov-actions"><button disabled={frozen || !roundOpen || item.hasVoted || snapshot.snapshotShares === 0n} onClick={() => void showPreview({ kind: 'vote', proposalId: item.id.toString(), support: true })}>赞成</button><button disabled={frozen || !roundOpen || item.hasVoted || snapshot.snapshotShares === 0n} onClick={() => void showPreview({ kind: 'vote', proposalId: item.id.toString(), support: false })}>反对</button><button disabled={frozen || !roundOpen || !item.passed} onClick={() => void showPreview({ kind: 'executeSale', proposalId: item.id.toString() })}>执行挂牌</button></div></article>)}</div></div>}
      {snapshot.state === 2n && <div className="live-gov-propose"><h3>{roundOpen ? '提出同轮竞价' : '发起新一轮出售提案'}</h3><p>参考价仅作为记录，投票门槛以链上实际购机价判定；页面不会把参考价当作可自动成交的报价。</p><div><label>拟出售整机价（BNB）<input inputMode="decimal" value={salePrice} onChange={event => setSalePrice(event.target.value)} placeholder="例如 1.25"/></label><label>参考价（BNB）<input inputMode="decimal" value={referencePrice} onChange={event => setReferencePrice(event.target.value)} placeholder="来源需自行核对"/></label><button disabled={frozen || snapshot.shares === 0n} onClick={() => {
        try {
          const price = priceWei(salePrice), refPrice = priceWei(referencePrice);
          void showPreview({ kind: 'propose', priceWei: price, refPriceWei: refPrice,
            refAt: snapshot.timestamp.toString() });
        } catch (problem) { report(problem); }
      }}>预览提案<ArrowRight size={15}/></button></div></div>}
      {listed && <div className="live-gov-listing"><h3>链上整机挂牌</h3><p>提案 #{snapshot.listedProposalId.toString()} · 价格 {formatEther(snapshot.salePrice)} BNB · 到期 {when(snapshot.expiresAt)}。成交时必须原子结清挖矿收益；若外部协议未能结清，交易会回退。</p><div><button disabled={frozen || snapshot.timestamp >= snapshot.expiresAt} onClick={() => void showPreview({ kind: 'completeSale' })}>按链上价格购买整机</button><button disabled={frozen || snapshot.timestamp < snapshot.expiresAt} onClick={() => void showPreview({ kind: 'cancelExpired' })}>撤销过期挂牌</button></div></div>}
    </>}
    {preview && preview.identity === identity && <div className="live-gov-preview" role="dialog" aria-label="确认整机出售操作"><h3>确认 {({ propose: '提交报价', vote: '投票', executeSale: '执行挂牌', completeSale: '购买整机', cancelExpired: '撤销过期挂牌' })[preview.action.kind]}</h3><p>矿池 {short(preview.pool)} · 读取区块 #{preview.quote.blockNumber.toString()}。发送前将再次读取链上数据、模拟交易，并把交易意图记录到服务器。</p><dl><div><dt>报价 / 挂牌价</dt><dd>{formatEther(preview.quote.priceWei)} BNB</dd></div><div><dt>本次钱包支付</dt><dd>{formatEther(preview.quote.paymentWei)} BNB + Gas</dd></div>{preview.action.kind === 'completeSale' && <><div><dt>平台费 1%</dt><dd>{formatEther(preview.quote.feeWei)} BNB</dd></div><div><dt>持有人分配</dt><dd>{formatEther(preview.quote.holderNetWei)} BNB</dd></div></>}{preview.action.kind === 'vote' && <div><dt>投票选择</dt><dd>{preview.action.support ? '赞成' : '反对'}</dd></div>}</dl><div><button disabled={busy} onClick={() => setPreview(null)}>返回</button><button disabled={busy || disabled} onClick={() => void submit()}>发送到钱包确认</button></div></div>}
  </section>;
}
