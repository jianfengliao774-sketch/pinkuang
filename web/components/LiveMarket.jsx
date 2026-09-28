'use client';
import { displayAmount } from '../lib/amount-display.mjs';
import { useCallback, useEffect, useRef, useState } from 'react';
import { parseEther, getAddress, ZeroAddress } from 'ethers';
import { ArrowRight, CircleAlert, RefreshCw, ShoppingBag } from 'lucide-react';
import { indexPage } from '../lib/live-client.mjs';
import { prepareMarketAction, readMarketSnapshot } from '../lib/live-market.mjs';
import '../app/live-market.css';

const short = value => value ? `${value.slice(0, 8)}…${value.slice(-6)}` : '—';
const err = problem => problem?.shortMessage || problem?.message || '市场请求未完成。';
const amount = value => {
  if (!/^(?:[1-9]|[1-9]\d|100)$/.test(value)) throw new Error('请输入 1–100 的整数份额。');
  return value;
};
const price = value => {
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,18})?$/.test(value)) throw new Error('请输入非负 BNB 金额，最多 18 位小数。');
  return parseEther(value).toString();
};
const expires = value => value === 0n ? '旧订单' : value > BigInt(Math.floor(Number.MAX_SAFE_INTEGER / 1000))
  ? '时间未知' : new Date(Number(value) * 1000).toLocaleString('zh-CN');

/** Public index is discovery only; every displayed order and action is re-read on-chain. */
export default function LiveMarket({ config, account, wallet, disabled = false, onAction, onConnect, onError }) {
  const [rows, setRows] = useState([]);
  const [source, setSource] = useState(null);
  const [snapshot, setSnapshot] = useState(null);
  const [cursor, setCursor] = useState(null);
  const [pageCursor, setPageCursor] = useState(null);
  const [history, setHistory] = useState([]);
  const [showExpired, setShowExpired] = useState(false);
  const [poolInput, setPoolInput] = useState('');
  const [position, setPosition] = useState(null);
  const [listAmount, setListAmount] = useState('1');
  const [listPrice, setListPrice] = useState('');
  const [allowFree, setAllowFree] = useState(false);
  const [buyAmounts, setBuyAmounts] = useState({});
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const readVersion = useRef(0);

  const report = useCallback(problem => {
    setError(err(problem));
    onError?.(problem);
  }, [onError]);

  const refresh = useCallback(async (nextCursor = null, nextHistory = history) => {
    if (!config) return;
    const current = ++readVersion.current;
    setBusy(true); setError(''); setPreview(null);
    try {
      const query = `/v1/orders?active=${showExpired ? 'false' : 'true'}&limit=20${nextCursor === null ? '' : `&cursor=${nextCursor}`}`;
      let indexed;
      try { indexed = await indexPage(config, query); }
      catch (indexProblem) {
        // A lagging index must not hide an independently verified Market BNB
        // balance. Orders remain unavailable until the index is complete.
        const creditOnly = wallet ? await readMarketSnapshot(wallet, { factory: config.factory,
          market: config.market, account: account || ZeroAddress }) : null;
        if (current === readVersion.current) {
          setRows([]); setSource(null); setSnapshot(creditOnly); setCursor(null);
          setPageCursor(null); setHistory([]);
          report(new Error(`订单索引暂不可用：${err(indexProblem)}。市场 BNB 仍以链上读取为准。`));
        }
        return;
      }
      if (!Array.isArray(indexed.data?.items)) throw new Error('服务器订单索引不完整。');
      const discovered = indexed.data.items;
      const ids = discovered.map(item => {
        if (!/^[1-9]\d*$/.test(item.orderId)) throw new Error('服务器订单编号无效。');
        return item.orderId;
      });
      let verified = null;
      if (wallet) {
        verified = await readMarketSnapshot(wallet, { factory: config.factory, market: config.market,
          account: account || ZeroAddress, orderIds: ids });
        for (const item of discovered) {
          const chainOrder = verified.orders.find(order => order.id.toString() === item.orderId);
          if (!chainOrder || getAddress(item.pool) !== chainOrder.pool || getAddress(item.seller) !== chainOrder.seller) {
            throw new Error('服务器订单归属与链上不一致，已停止市场操作。');
          }
        }
      }
      if (current !== readVersion.current) return;
      setRows(discovered); setSource(indexed.source); setSnapshot(verified);
      setCursor(indexed.data.nextCursor); setPageCursor(nextCursor); setHistory(nextHistory);
    } catch (problem) { if (current === readVersion.current) { setRows([]); setSnapshot(null); setCursor(null); report(problem); } }
    finally { if (current === readVersion.current) setBusy(false); }
  }, [config, account, wallet, showExpired, history, report]);

  useEffect(() => { setPreview(null); setPosition(null); void refresh(null, []); }, [config?.factory, config?.market, account, wallet, showExpired]);

  async function inspect() {
    const current = ++readVersion.current;
    setBusy(true); setError(''); setPosition(null); setPreview(null);
    try {
      if (!wallet) throw new Error('请在钱包浏览器中打开并连接钱包。');
      const pool = getAddress(poolInput.trim());
      const fresh = await readMarketSnapshot(wallet, { factory: config.factory, market: config.market,
        account: account || ZeroAddress, pools: [pool] });
      if (current === readVersion.current) setPosition(fresh.pools[0]);
    } catch (problem) { if (current === readVersion.current) report(problem); }
    finally { if (current === readVersion.current) setBusy(false); }
  }

  async function showPreview(action) {
    if (!account) { onConnect?.(); return; }
    const current = ++readVersion.current;
    setBusy(true); setError(''); setPreview(null);
    try {
      if (!wallet) throw new Error('钱包不可用。');
      const prepared = await prepareMarketAction(wallet, { factory: config.factory, market: config.market, account, action });
      if (current === readVersion.current) setPreview({ action, quote: prepared.quote });
    } catch (problem) { if (current === readVersion.current) report(problem); }
    finally { if (current === readVersion.current) setBusy(false); }
  }

  async function submit() {
    if (!preview || !onAction) return;
    setBusy(true); setError('');
    try {
      // The send layer must re-read the action, simulate and persist its exact
      // calldata in the shared server journal before asking for a signature.
      await onAction(preview.action);
      setPreview(null);
      await refresh(null, []);
    } catch (problem) { setPreview(null); report(problem); }
    finally { setBusy(false); }
  }

  function next() {
    if (cursor === null || !/^[1-9]\d*$/.test(String(cursor))) return report(new Error('订单游标无效，请刷新。'));
    void refresh(cursor, [...history, pageCursor]);
  }

  const byId = new Map((snapshot?.orders ?? []).map(order => [order.id.toString(), order]));
  const byPool = new Map((snapshot?.pools ?? []).map(item => [item.pool, item]));
  const locked = busy || disabled || !account || !wallet || !snapshot;
  const bilateralFeeReady = snapshot?.buyerFeeBps === 100n;
  const marketCredit = snapshot?.bnbOwed ?? null;
  return <section className="live-section live-market" aria-label="真实份额市场">
    <div className="live-section-head"><div><h2>真实份额市场</h2><p>服务器发现订单，签名前按链上当前价格和剩余份额重新核对。份额成交款保存在 ShareMarket，须单独领取。</p></div><button className="live-market-refresh" disabled={busy || !config} onClick={() => void refresh(null, [])}><RefreshCw size={15}/>刷新订单</button></div>
    {error && <div className="live-market-error" role="alert"><CircleAlert size={16}/>{error}</div>}
    {snapshot && !bilateralFeeReady && <div className="live-market-error" role="status"><CircleAlert size={16}/>当前市场尚未通过买卖双方各 1% 手续费版本核验，暂停新挂单与买入。旧订单仍可撤销，市场 BNB 仍可领取。</div>}
    <div className="live-market-summary"><div><span>已验收市场</span><strong title={config?.market}>{short(config?.market)}</strong></div><div><span>索引状态</span><strong>{source?.complete ? `已核至 #${source.indexedThrough}` : '等待完整索引'}</strong></div><div><span>链上快照</span><strong>{snapshot ? `#${snapshot.blockNumber}` : '等待钱包读取'}</strong></div><div><span>市场待领 BNB</span><strong>{marketCredit === null ? '未知' : `${displayAmount(marketCredit)} BNB`}</strong></div><button disabled={locked || !(marketCredit > 0n)} onClick={() => void showPreview({ kind: 'withdrawBnb' })}>领取市场 BNB</button></div>
    <p className="live-market-note">市场 BNB 是卖出份额所得，与矿池内的购机余款及整机出售款分开记账。</p>

    <div className="live-market-grid"><div className="live-market-orders"><div className="live-market-subhead"><h3>{showExpired ? '已结束或过期订单' : '在售订单'}</h3><span>{rows.length} 笔 · 本页最多 20 笔</span></div><div className="live-market-tabs"><button aria-pressed={!showExpired} className={!showExpired ? 'selected' : ''} disabled={busy} onClick={() => setShowExpired(false)}>在售候选</button><button aria-pressed={showExpired} className={showExpired ? 'selected' : ''} disabled={busy} onClick={() => setShowExpired(true)}>已过期 / 已结束</button></div>
      {!rows.length && <p className="live-market-empty">{busy ? '正在读取…' : '当前页没有可发现的在售订单。'}</p>}
      {rows.map(item => {
        const order = byId.get(item.orderId), poolState = order && byPool.get(order.pool);
        const live = !!order?.active && order.remaining > 0n && order.expiresAt > (snapshot?.timestamp ?? 0n) && poolState?.state === 2n && poolState.tradingAllowed;
        const expired = !!order?.active && (order.expiresAt === 0n || order.expiresAt <= (snapshot?.timestamp ?? 0n));
        const mine = !!account && !!order && getAddress(account) === order.seller;
        const count = buyAmounts[item.orderId] ?? '1';
        return <article className="live-market-order" key={item.orderId}><div className="live-market-order-top"><strong>订单 #{item.orderId}</strong><span>{!order ? '待链上核对' : expired ? '已过期可解锁' : live ? '可交易' : order.active ? '暂停成交' : '已结束'}</span></div><p>资金池 <a href={`https://bscscan.com/address/${item.pool}`} target="_blank" rel="noreferrer">{short(item.pool)}</a> · 卖方 {short(item.seller)}</p><div className="live-market-order-values"><div><span>链上剩余</span><strong>{order ? `${order.remaining} 份` : '未知'}</strong></div><div><span>每份价格</span><strong>{order ? `${displayAmount(order.pricePerUnitWei)} BNB` : '未知'}</strong></div><div><span>到期</span><strong>{order ? expires(order.expiresAt) : '未知'}</strong></div></div>
          <div className="live-market-order-actions">{mine ? <button disabled={locked || !order?.active} onClick={() => void showPreview({ kind: 'cancel', orderId: item.orderId })}>撤销挂单</button> : <><label>买入份额<input inputMode="numeric" value={count} onChange={event => setBuyAmounts(previous => ({ ...previous, [item.orderId]: event.target.value }))}/></label><button disabled={locked || !live || !bilateralFeeReady} onClick={() => {
            try { amount(count); void showPreview({ kind: 'fill', orderId: item.orderId, amount: count,
              expectedPool: order.pool, expectedSeller: order.seller, expectedPricePerUnitWei: order.pricePerUnitWei.toString() }); }
            catch (problem) { report(problem); }
          }}>预览买入</button></>}
            {order?.active && (order.expiresAt === 0n || order.expiresAt <= (snapshot?.timestamp ?? 0n)) &&
              <button disabled={locked} onClick={() => void showPreview({ kind: 'expire', orderId: item.orderId })}>解锁过期单</button>}</div>
        </article>;
      })}
      <div className="live-market-pages"><button disabled={busy || !history.length} onClick={() => {
        const previous = history.at(-1);
        void refresh(previous, history.slice(0, -1));
      }}>上一页</button><button disabled={busy || cursor === null} onClick={next}>下一页</button></div>
    </div>

    <div className="live-market-list"><h3>挂出售出份额</h3><p>仅运行中的矿池可挂牌。挂单锁定份额，收益仍归卖方；有效期 7 天。成交时买方在挂牌基价外支付 1%，卖方从挂牌基价中扣除 1%。</p><label>资金池地址<input value={poolInput} onChange={event => { setPoolInput(event.target.value); setPosition(null); setPreview(null); }} placeholder="0x…"/></label><button className="live-market-inspect" disabled={busy || !poolInput.trim()} onClick={() => void inspect()}>核对我的份额</button>
      {position && <div className="live-market-position"><span>持有 {position.balance} 份</span><span>已锁定 {position.locked} 份</span><strong>可挂单 {position.available} 份</strong>{!position.tradingAllowed && <em>当前暂停份额交易</em>}</div>}
      <div className="live-market-form"><label>出售份额<input inputMode="numeric" value={listAmount} onChange={event => setListAmount(event.target.value)}/></label><label>每份单价（BNB）<input inputMode="decimal" value={listPrice} onChange={event => { setListPrice(event.target.value); setAllowFree(false); }} placeholder="0.01"/></label></div>
      {listPrice && /^0(?:\.0{1,18})?$/.test(listPrice) && <label className="live-market-free"><input type="checkbox" checked={allowFree} onChange={event => setAllowFree(event.target.checked)}/>确认以 0 BNB 免费转让这些份额</label>}
      <button className="live-market-list-button" disabled={locked || !bilateralFeeReady || !position || position.state !== 2n || !position.tradingAllowed} onClick={() => {
        try { void showPreview({ kind: 'list', pool: position.pool, amount: amount(listAmount), pricePerUnitWei: price(listPrice), allowFree }); }
        catch (problem) { report(problem); }
      }}>预览挂单<ArrowRight size={15}/></button>
    </div></div>

    {preview && <div className="live-market-preview" role="dialog" aria-label="确认市场交易"><div><ShoppingBag size={20}/><h3>确认 {({ list: '挂单', fill: '买入份额', cancel: '撤单', expire: '解锁过期单', withdrawBnb: '领取市场 BNB' })[preview.quote.action]}</h3></div><p>目标 Market {short(config.market)} · 读取区块 #{preview.quote.blockNumber}。确认发送前会再次核验行情和订单，钱包另付 Gas。</p><dl><div><dt>资金池</dt><dd>{short(preview.quote.pool)}</dd></div><div><dt>份额</dt><dd>{preview.quote.amount?.toString() ?? '—'}</dd></div>{preview.quote.unitPriceWei !== null && <div><dt>每份挂牌价</dt><dd>{displayAmount(preview.quote.unitPriceWei)} BNB</dd></div>}{preview.quote.action === 'fill' && <><div><dt>成交基价</dt><dd>{displayAmount(preview.quote.grossWei)} BNB</dd></div><div><dt>买方 1% 手续费</dt><dd>{displayAmount(preview.quote.buyerFeeWei)} BNB</dd></div><div><dt>本次钱包支付</dt><dd>{displayAmount(preview.quote.buyerPaymentWei)} BNB + Gas</dd></div><div><dt>卖方 1% 手续费</dt><dd>{displayAmount(preview.quote.sellerFeeWei)} BNB</dd></div><div><dt>卖方到账</dt><dd>{displayAmount(preview.quote.sellerNetWei)} BNB</dd></div></>}{preview.quote.action === 'withdrawBnb' && <div><dt>市场可提金额</dt><dd>{displayAmount(preview.quote.marketCreditWei)} BNB</dd></div>}</dl><div className="live-market-preview-actions"><button onClick={() => setPreview(null)} disabled={busy}>返回</button><button disabled={busy || disabled} onClick={() => void submit()}>发送到钱包确认</button></div></div>}
  </section>;
}
