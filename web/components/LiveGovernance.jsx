'use client';
import { fixedPrice, inputPriceWei, linkedPrice, validCapacityQuote } from '../lib/capacity-input.mjs';
import { displayAmount } from '../lib/amount-display.mjs';
import { useEffect, useRef, useState } from 'react';
import { getAddress, parseEther, ZeroAddress } from 'ethers';
import { ArrowRight, CircleAlert, RefreshCw } from 'lucide-react';
import { proposalReferenceRecord, prepareGovernanceAction, readGovernanceSnapshot } from '../lib/live-governance.mjs';
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
  selectedPool, capacityQuote, readProvider, refreshToken = 0, onAction, onConnect, onError }) {
  const [poolInput, setPoolInput] = useState(selectedPool || '');
  const [snapshotData, setSnapshot] = useState(null);
  const [salePrice, setSalePrice] = useState('');
  const [capacityPrice, setCapacityPrice] = useState('');
  const [editedField, setEditedField] = useState('sale');
  const [quoteNow, setQuoteNow] = useState(() => Date.now());
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const requests = useRef(createUiContext());
  const context = useRef(null);
  const poolValue = selectedPool || poolInput;
  const snapshot = snapshotData?.pool.toLowerCase() === poolValue.trim().toLowerCase()
    && snapshotData?.account.toLowerCase() === (account || ZeroAddress).toLowerCase()
    && snapshotData?.factory.toLowerCase() === config?.factory?.toLowerCase()
    && (!config?.shareMarket || snapshotData?.shareMarket?.toLowerCase() === config.shareMarket.toLowerCase())
    && snapshotData?.stage === config?.stage && snapshotData?.displayOnly === (config?.displayOnly === true)
    ? snapshotData : null;
  const identity = `${config?.factory || ''}:${config?.shareMarket || ''}:${config?.stage || ''}:${config?.displayOnly === true}:${poolValue}:${account || ''}`;
  if (context.current?.identity !== identity || context.current?.wallet !== wallet || context.current?.readProvider !== readProvider) {
    requests.current.invalidate();
    context.current = { identity, wallet, readProvider };
  }

  useEffect(() => {
    setSalePrice(''); setCapacityPrice(''); setEditedField('sale');
    setSnapshot(null); setPreview(null); setError(''); setBusy(false);
  }, [account, wallet, config?.factory, config?.shareMarket, config?.stage, config?.displayOnly, poolValue]);
  useEffect(() => () => requests.current.invalidate(), []);
  useEffect(() => {
    if (!poolInput && pools.length) setPoolInput(pools[0]);
  }, [pools.join(','), poolInput]);
  useEffect(() => {
    if (selectedPool && config?.factory && (readProvider || wallet)) void refresh();
  }, [selectedPool, config?.factory, config?.shareMarket, config?.stage, config?.displayOnly, account, wallet, readProvider, refreshToken]);

  const currentCapacity = validCapacityQuote(capacityQuote, poolValue, quoteNow);
  const dailyAtomic = currentCapacity?.estimated24hAtomic;
  useEffect(() => {
    setQuoteNow(Date.now());
    const timer = setInterval(() => setQuoteNow(Date.now()), 15000);
    return () => clearInterval(timer);
  }, [capacityQuote]);
  useEffect(() => {
    if (!dailyAtomic || busy) return;
    setPreview(null);
    try {
      if (editedField === 'sale') setCapacityPrice(linkedPrice(salePrice, 'sale', dailyAtomic));
      else setSalePrice(linkedPrice(capacityPrice, 'capacity', dailyAtomic));
    } catch {}
  }, [dailyAtomic]);

  function editPrice(field, value, normalize = false) {
    if (busy || disabled) return;
    if (!/^\d*(?:\.\d{0,5})?$/.test(value) || value.length > 85) return;
    let next = value;
    if (normalize && value !== '' && value !== '.') {
      try { next = fixedPrice(inputPriceWei(value.startsWith('.') ? `0${value}` : value)); }
      catch (problem) { report(problem); return; }
    }
    requests.current.invalidate(); setPreview(null); setEditedField(field);
    if (field === 'sale') setSalePrice(next); else setCapacityPrice(next);
    let linked = '';
    if (dailyAtomic && next !== '.') {
      try { linked = linkedPrice(next.startsWith('.') ? `0${next}` : next, field, dailyAtomic); } catch {}
    }
    if (field === 'sale') setCapacityPrice(linked); else setSalePrice(linked);
  }

  function report(problem) { setError(errorText(problem)); onError?.(problem); }
  async function refresh({ force = false } = {}) {
    const ticket = requests.current.begin();
    setBusy(true); setError(''); setPreview(null);
    try {
      const provider = readProvider || wallet;
      if (!provider) throw new Error('链上读取服务暂不可用。');
      const pool = getAddress(poolValue.trim());
      const next = await readGovernanceSnapshot(provider, { factory: config.factory, pool,
        account: account || ZeroAddress, stage: config.stage, displayOnly: config.displayOnly === true,
        shareMarket: config.shareMarket, cacheMs: config.displayOnly ? 120000 : 0, refreshToken, force });
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
      const prepared = await prepareGovernanceAction(config.displayOnly ? readProvider || wallet : wallet,
        { factory: config.factory, pool, account, action, stage: config.stage,
          displayOnly: config.displayOnly === true, shareMarket: config.shareMarket, snapshot });
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
        ...(preview.action.kind === 'completeFirstoSale' ? { expectedPriceWei: preview.quote.priceWei.toString(),
          expectedProposalId: preview.quote.proposalId.toString(), expectedFeeBps: preview.quote.feeBps.toString(),
          expectedFeeEpoch: preview.quote.feeEpoch.toString() } : {}) });
      if (!requests.current.current(ticket)) return;
      setPreview(null);
      await refresh({ force: true });
    } catch (problem) { if (requests.current.current(ticket)) { setPreview(null); report(problem); } }
    finally { if (requests.current.current(ticket)) setBusy(false); }
  }

  const frozen = busy || disabled || !account || !wallet || !snapshot;
  const proposalOpensAt = snapshot ? snapshot.activatedAt + 7n * 86400n : null;
  const proposalWaiting = snapshot?.state === 2n && snapshot.timestamp < proposalOpensAt;
  const opener = snapshot?.candidates.find(item => item.id === snapshot.activeProposalId);
  const roundOpen = snapshot?.state === 2n && opener && !opener.executed && snapshot.timestamp < opener.endsAt;
  const listed = snapshot?.state === 3n && snapshot.listedProposalId > 0n;
  return <section className="live-section live-governance" aria-label="真实整机出售治理">
    <div className="live-section-head"><div><h2>整机出售治理</h2><p>{config?.stage === 'genesis'
      ? '创世矿池按链上购机成本判定折价：地址过半，折价至少 60 份赞成；其他价格份额过半。'
      : '同轮报价共用投票快照。赞成人数与份额均须严格过半；执行挂牌还须有新鲜的 Firsto 市场参考价，低于该价须经平台审核。'}</p></div><button className="live-gov-refresh" disabled={busy || !config || !poolValue} onClick={() => void refresh({ force: true })}><RefreshCw size={15}/>刷新治理</button></div>
    {error && <div className="live-gov-error" role="alert"><CircleAlert size={16}/>{error}</div>}
    <div className="live-gov-selector"><label>矿池地址<input value={poolValue} readOnly={!!selectedPool} list="live-governance-pools" onChange={event => { requests.current.invalidate(); setPoolInput(event.target.value); }} placeholder="0x…"/></label><datalist id="live-governance-pools">{pools.map(pool => <option value={pool} key={pool}/>)}</datalist><span>{config?.displayOnly ? '选择矿池，查看提案并参与投票。' : '只有经过链上 Factory 注册核对的池可操作。'}</span></div>
    {!snapshot && <p className="live-gov-muted">{config?.displayOnly ? '选择矿池，读取提案与余额。' : '选择矿池并读取。页面不从浏览器缓存恢复提案或余额。'}</p>}
    {snapshot && <><div className="live-gov-metrics"><div><span>我当前的份额</span><strong>{snapshot.shares.toString()} / 100</strong></div><div><span>投票快照份额</span><strong>{snapshot.candidates.length ? snapshot.snapshotShares.toString() : '尚未开启'}</strong></div><div><span>历史实际购机价</span><strong>{displayAmount(snapshot.purchaseCost)} BNB</strong></div><div><span>Firsto 市场参考价</span><strong>{snapshot.stage === 'genesis' ? '旧矿池不适用' : snapshot.saleReference?.available ? `${displayAmount(snapshot.saleReference.priceWei)} BNB` : '暂不可用'}</strong></div><div><span>当前24H日产</span><strong>{dailyAtomic ? displayAmount(dailyAtomic, 8) : '—'} BEM</strong></div><div><span>交易状态</span><strong>{snapshot.state === 2n ? roundOpen ? '投票中 · 份额冻结' : '运行中' : listed ? '整机挂牌中' : `状态 ${snapshot.state}`}</strong></div></div>
      {snapshot.stage !== 'genesis' && !snapshot.saleReference?.available && snapshot.state === 2n && <p className="live-gov-muted" role="status">{snapshot.saleReference?.reason || 'Firsto 市场参考价暂不可用。'} 投票仍可进行，挂牌须待参考价更新。</p>}
      {snapshot.candidates.length > 0 && <div className="live-gov-candidates">
        <h3>本轮报价候选 <small>{snapshot.candidates.length} 个 · 截止 {when(opener.endsAt)}</small></h3>
        <div className="live-gov-grid">{snapshot.candidates.map(item => <article key={item.id.toString()}>
          <div className="live-gov-candidate-head"><strong>提案 #{item.id.toString()}</strong><span>{item.executed ? '已执行' : item.passed ? item.canExecute ? '可执行挂牌' : '投票已达门槛' : '投票中'}</span></div>
          <p className="live-gov-price">{displayAmount(item.priceWei)} <small>BNB</small></p>
          <p className="live-gov-muted">提案人 {short(item.proposer)}</p>
          <div className="live-gov-votes"><div><span>赞成份额</span><strong>{item.yesShares.toString()} / {item.requiredYesShares.toString()}</strong></div><div><span>赞成人数</span><strong>{item.yesCount.toString()} / {item.requiredYesCount.toString()}</strong></div></div>
          <p className="live-gov-muted">{snapshot.stage === 'genesis'
            ? `创世矿池需地址过半；${item.discounted ? '低于购机成本，至少 60 份赞成。' : '不低于购机成本，份额过半。'}`
            : `人数与份额均须严格过半。${item.discounted === null ? '当前缺少新鲜 Firsto 市场参考价，暂不能挂牌。' : item.discounted ? item.reviewApproved ? '低于 Firsto 市场参考价，平台已审核通过。' : item.saleReview?.status === 2n ? '低于 Firsto 市场参考价，平台已拒绝。' : '低于 Firsto 市场参考价，等待平台审核。' : '不低于当前 Firsto 市场参考价，无需额外审核。'}`}{item.hasVoted ? ' · 你已投票' : ''}</p>
          <div className="live-gov-actions"><button disabled={frozen || !roundOpen || item.hasVoted || snapshot.snapshotShares === 0n} onClick={() => void showPreview({ kind: 'vote', proposalId: item.id.toString(), support: true })}>赞成</button><button disabled={frozen || !roundOpen || item.hasVoted || snapshot.snapshotShares === 0n} onClick={() => void showPreview({ kind: 'vote', proposalId: item.id.toString(), support: false })}>反对</button><button disabled={frozen || !roundOpen || !item.canExecute} onClick={() => void showPreview({ kind: 'executeSale', proposalId: item.id.toString() })}>执行挂牌</button></div>
        </article>)}</div>
      </div>}
      {snapshot.state === 2n && <div className="live-gov-propose"><h3>{roundOpen ? '提出同轮竞价' : '发起新一轮出售提案'}</h3><p>{snapshot.stage === 'genesis'
        ? '整机价与日产能价按当前 24H 日产换算。创世矿池按链上实际购机成本判断折价。'
        : '整机价与日产能价按当前 24H 日产换算。执行挂牌时以运营方届时上链的新鲜 Firsto 市场参考价判断是否需要平台审核。'}</p>{proposalWaiting && <p role="status">矿机激活满 7 天后才能发起提案；链上开放时间：{when(proposalOpensAt)}。当前持仓和价格输入已读取，暂不能送交钱包。</p>}<div><label>拟出售整机价（BNB）<input inputMode="decimal" aria-label="拟出售整机价（BNB）" disabled={busy || disabled} value={salePrice} onChange={event => editPrice('sale', event.target.value)} onBlur={event => editPrice('sale', event.target.value, true)} placeholder="0.00000"/></label><label>日产能价<input inputMode="decimal" aria-label="日产能价" value={dailyAtomic ? capacityPrice : ''} disabled={!dailyAtomic || busy || disabled} onChange={event => editPrice('capacity', event.target.value)} onBlur={event => editPrice('capacity', event.target.value, true)} placeholder={dailyAtomic ? '0.00000' : '日产暂不可用'}/></label><button disabled={frozen || proposalWaiting || snapshot.shares === 0n} onClick={() => {
        try {
          const normalized = fixedPrice(inputPriceWei(salePrice));
          const price = priceWei(normalized);
          if (BigInt(price) <= 0n) throw new Error('拟出售整机价需大于 0.00000 BNB。');
          setSalePrice(normalized);
          if (dailyAtomic) setCapacityPrice(linkedPrice(normalized, 'sale', dailyAtomic));
          void showPreview({ kind: 'propose', priceWei: price, ...proposalReferenceRecord(snapshot) });
        } catch (problem) { report(problem); }
      }}>预览提案<ArrowRight size={15}/></button></div>{!dailyAtomic && <p role="status">当前24H日产暂不可用，可直接填写整机价格。</p>}</div>}
      {listed && <div className="live-gov-listing"><h3>链上整机挂牌</h3><p>提案 #{snapshot.listedProposalId.toString()} · 价格 {displayAmount(snapshot.salePrice)} BNB · 到期 {when(snapshot.expiresAt)}。本站通过 Firsto 合约成交，买方另付 Firsto 手续费，矿池收取挂牌价后扣除平台 1%。成交时同笔结清挖矿收益，失败则整笔回退；暂不向 Firsto 外部页面发布挂单。</p>{!snapshot.firstoSale?.available && <p role="status">{config?.displayOnly ? 'Firsto 当前暂停成交或费率暂不可用。' : '当前成交路由尚未核验，请刷新或等待合约升级。'}</p>}<div><button disabled={frozen || snapshot.timestamp >= snapshot.expiresAt || !snapshot.firstoSale?.available} onClick={() => void showPreview({ kind: 'completeFirstoSale' })}>通过 Firsto 购买整机</button></div></div>}
    </>}
    {preview && preview.identity === identity && <div className="live-gov-preview" role="dialog" aria-label="确认整机出售操作">
      <h3>确认 {({ propose: '提交报价', vote: '投票', executeSale: '执行挂牌', completeFirstoSale: '通过 Firsto 购买整机', cancelExpired: '撤销过期挂牌' })[preview.action.kind]}</h3>
      <p>矿池 {short(preview.pool)}{preview.quote.blockNumber != null ? ` · 读取区块 #${preview.quote.blockNumber.toString()}` : ''}。{config?.displayOnly ? '按以下内容发送到钱包确认，并记录交易意图。' : '发送前将再次核对链上数据，并把交易意图记录到服务器。'}</p>
      <dl><div><dt>报价 / 挂牌价</dt><dd>{displayAmount(preview.quote.priceWei)} BNB</dd></div>
        {preview.action.kind === 'executeSale' && (snapshot.stage === 'genesis'
          ? <><div><dt>链上实际购机价</dt><dd>{displayAmount(snapshot.purchaseCost)} BNB</dd></div><div><dt>份额门槛</dt><dd>{preview.quote.priceWei < snapshot.purchaseCost ? '至少 60 份赞成' : '份额过半'}</dd></div></>
          : <><div><dt>Firsto 市场参考价</dt><dd>{displayAmount(preview.quote.marketReferenceWei)} BNB</dd></div><div><dt>参考价时间</dt><dd>{when(preview.quote.marketReferenceObservedAt)}</dd></div><div><dt>平台审核</dt><dd>{preview.quote.priceWei < preview.quote.marketReferenceWei ? preview.quote.saleReviewStatus === 1n && preview.quote.saleReviewPriceWei === preview.quote.priceWei ? '已批准此价格' : '尚未批准' : '无需额外审核'}</dd></div></>)}
        <div><dt>本次钱包支付</dt><dd>{displayAmount(preview.quote.paymentWei)} BNB + Gas</dd></div>
        {preview.action.kind === 'completeFirstoSale' && <><div><dt>Firsto 买方手续费</dt><dd>{displayAmount(preview.quote.sourceFeeWei)} BNB</dd></div><div><dt>平台费 1%</dt><dd>{displayAmount(preview.quote.feeWei)} BNB</dd></div><div><dt>持有人分配</dt><dd>{displayAmount(preview.quote.holderNetWei)} BNB</dd></div></>}
        {preview.action.kind === 'vote' && <div><dt>投票选择</dt><dd>{preview.action.support ? '赞成' : '反对'}</dd></div>}</dl>
      <div><button disabled={busy} onClick={() => setPreview(null)}>返回</button><button disabled={busy || disabled} onClick={() => void submit()}>发送到钱包确认</button></div>
    </div>}
  </section>;
}
