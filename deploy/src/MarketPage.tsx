import { useEffect, useRef, useState } from 'react';
import { ArrowDownToLine, ArrowRight, ArrowUpRight, CheckCircle2, CircleAlert, Clock3, Coins, LoaderCircle, LockKeyhole, RefreshCw, Search, ShoppingBag, SlidersHorizontal, Wallet, X } from 'lucide-react';
import type { WalletProvider } from './wallet';
import {
  BSC_EXPLORER, POOL_STATES, bnb, marketError, marketProvider,
  prepareMarketAction, readBuyerBalance, readMarketCredit, readMarketIdentity, readOrderPage, readPoolPosition,
  loadMarketPending, migrateLegacyMarketPending, reconcileMarketPending, requireFill, sameAddress, sendMarketAction, shareAmount, tradeAmounts, unitPrice, withObservedMarketHash,
  type MarketAction, type MarketIdentity, type MarketJournalStorage, type MarketOrder, type MarketQuote, type PendingMarketTransaction, type PoolPosition,
} from './market';
import './market.css';

type Props = { wallet: WalletProvider | null; account: string | null; factoryAddress?: string; journal: MarketJournalStorage | null; onConnect: () => void };
const short = (value: string) => `${value.slice(0, 6)}…${value.slice(-4)}`;
function Addr({ value }: { value: string }) { return <a className="mk-address" href={`${BSC_EXPLORER}/address/${value}`} target="_blank" rel="noreferrer" title={value}>{short(value)}<ArrowUpRight size={12}/></a>; }
function Tx({ hash }: { hash: string }) { return <a className="mk-address" href={`${BSC_EXPLORER}/tx/${hash}`} target="_blank" rel="noreferrer">查看交易 <ArrowUpRight size={13}/></a>; }

export default function MarketPage({ wallet, account, factoryAddress, journal, onConnect }: Props) {
  const [factory, setFactory] = useState(factoryAddress || '');
  const [identity, setIdentity] = useState<MarketIdentity | null>(null);
  const [orders, setOrders] = useState<MarketOrder[]>([]);
  const [cursor, setCursor] = useState<bigint | null>(null);
  const [scanned, setScanned] = useState(0);
  const [totalOrders, setTotalOrders] = useState(0n);
  const [credit, setCredit] = useState<bigint | null>(null);
  const [filterPool, setFilterPool] = useState('');
  const [mine, setMine] = useState(false);
  const [poolInput, setPoolInput] = useState('');
  const [position, setPosition] = useState<PoolPosition | null>(null);
  const [amount, setAmount] = useState('1');
  const [price, setPrice] = useState('');
  const [freeConfirmed, setFreeConfirmed] = useState(false);
  const [buyOrder, setBuyOrder] = useState<MarketOrder | null>(null);
  const [buyBalance, setBuyBalance] = useState<bigint | null>(null);
  const [buyAmount, setBuyAmount] = useState('1');
  const [quote, setQuote] = useState<MarketQuote | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [storageError, setStorageError] = useState('');
  const [journalLoad, setJournalLoad] = useState(0);
  const [journalState, setJournalState] = useState<{ journal: MarketJournalStorage | null; account: string | null; status: 'unavailable' | 'loading' | 'ready' | 'error' }>({ journal: null, account: null, status: 'unavailable' });
  const [notice, setNotice] = useState('');
  const [pending, setPending] = useState<PendingMarketTransaction | null>(null);
  const [recoveryHash, setRecoveryHash] = useState('');
  const [receipt, setReceipt] = useState<{ hash: string; label: string; success: boolean; block: number; fee: bigint } | null>(null);
  const running = useRef(false), version = useRef(0);

  useEffect(() => {
    let cancelled = false;
    setPending(null); setQuote(null); setStorageError('');
    if (!journal || !account) {
      setJournalState({ journal, account, status: 'unavailable' });
      return;
    }
    setJournalState({ journal, account, status: 'loading' });
    // Browser storage is read only for one-time migration of older real intents.
    let browserStorage: Pick<Storage, 'getItem' | 'removeItem'>;
    try { browserStorage = window.localStorage; }
    catch { browserStorage = { getItem: () => null, removeItem: () => {} }; }
    void migrateLegacyMarketPending(journal, account, browserStorage).then(value => {
      if (cancelled) return;
      setPending(value); setJournalState({ journal, account, status: 'ready' });
    }).catch(err => {
      if (cancelled) return;
      setStorageError(marketError(err)); setJournalState({ journal, account, status: 'error' });
    });
    return () => { cancelled = true; };
  }, [journal, account, journalLoad]);
  useEffect(() => {
    version.current += 1;
    setFactory(factoryAddress || '');
    setIdentity(null); setOrders([]); setCredit(null); setCursor(null); setScanned(0); setTotalOrders(0n);
    setQuote(null); setBuyOrder(null); setBuyBalance(null); setPosition(null);
  }, [factoryAddress, account]);
  useEffect(() => {
    version.current += 1; setQuote(null); setPosition(null); setBuyOrder(null); setBuyBalance(null); setCredit(null); setIdentity(null); setOrders([]);
    if (!wallet) return;
    const invalidate = () => {
      version.current += 1; setQuote(null); setPosition(null); setBuyOrder(null); setBuyBalance(null); setIdentity(null); setOrders([]); setCredit(null);
      setNotice('钱包账户或网络已变化，请重新验证市场。');
    };
    wallet.on?.('accountsChanged', invalidate); wallet.on?.('chainChanged', invalidate); wallet.on?.('disconnect', invalidate);
    return () => { wallet.removeListener?.('accountsChanged', invalidate); wallet.removeListener?.('chainChanged', invalidate); wallet.removeListener?.('disconnect', invalidate); };
  }, [wallet, account]);
  useEffect(() => {
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape' && !running.current) { setQuote(null); setBuyOrder(null); } };
    if (quote || buyOrder) window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [quote, buyOrder]);

  async function run(label: string, fn: () => Promise<void>) {
    if (running.current) return;
    running.current = true; setBusy(label); setError(''); setNotice('');
    try { await fn(); } catch (err) { setError(marketError(err)); } finally { running.current = false; setBusy(''); }
  }
  async function refresh(append = false) {
    await run(append ? '读取更早订单' : '验证并读取市场', async () => {
      const current = version.current, provider = marketProvider(wallet);
      const verified = await readMarketIdentity(provider, factory);
      const [page, owed] = await Promise.all([readOrderPage(provider, verified, append ? cursor : null), readMarketCredit(provider, verified, account)]);
      if (current !== version.current) return;
      setIdentity(verified); setOrders(previous => append ? [...previous, ...page.orders] : page.orders);
      setCursor(page.nextCursor); setScanned(previous => append ? previous + page.scanned : page.scanned); setTotalOrders(page.lastOrderId); setCredit(account ? owed : null);
    });
  }
  async function inspectPool() {
    if (!identity) return;
    await run('读取资金池持仓', async () => {
      const current = version.current, provider = marketProvider(wallet);
      const fresh = { ...identity, blockNumber: await provider.getBlockNumber() };
      const result = await readPoolPosition(provider, fresh, poolInput, account);
      if (current === version.current) setPosition(result);
    });
  }
  async function preview(action: MarketAction) {
    if (!wallet || !account) return onConnect();
    if (!identity || pending || !journalReady || !journal) return;
    await run('模拟交易并检查余额', async () => {
      let existing: PendingMarketTransaction | null;
      try { existing = await loadMarketPending(journal); }
      catch (cause) { setStorageError(marketError(cause)); setJournalState({ journal, account, status: 'error' }); throw cause; }
      if (existing) { setPending(existing); throw new Error('服务器已有待确认交易，请先核对回执。'); }
      const current = version.current;
      if (action.kind === 'list' && unitPrice(action.price) === 0n && !freeConfirmed) throw new Error('零价挂单会免费转出份额，请先勾选确认。');
      const result = await prepareMarketAction(wallet, account, identity.factory, action);
      if (current === version.current) { setQuote(result); setBuyOrder(null); }
    });
  }
  async function chooseBuy(order: MarketOrder) {
    if (!wallet || !account) return onConnect();
    if (!identity || !journalReady) return;
    await run('读取可购买份额', async () => {
      const current = version.current, provider = marketProvider(wallet);
      const balance = await readBuyerBalance(provider, order.pool, account);
      requireFill(order, { state: order.state ?? -1, tradingAllowed: !!order.tradingAllowed }, account, 1n);
      if (current === version.current) { setBuyAmount('1'); setBuyBalance(balance); setBuyOrder(order); }
    });
  }
  async function submit() {
    if (!wallet || !quote || !journal || !journalReady) return;
    await run('等待钱包确认', async () => {
      const current = quote; setQuote(null);
      const observed: { current: PendingMarketTransaction | null } = { current: null };
      let transaction: PendingMarketTransaction;
      try { transaction = await sendMarketAction(wallet, current, journal, value => { observed.current = value; setPending(value); }); }
      catch (cause) {
        try {
          const saved = await loadMarketPending(journal);
          setPending(withObservedMarketHash(saved, observed.current));
        }
        catch (readCause) { setStorageError(marketError(readCause)); setJournalState({ journal, account, status: 'error' }); }
        throw cause;
      }
      setNotice('交易已提交。请核对链上回执后继续，勿重复发送。');
      await checkPending(transaction);
    });
  }
  async function checkPending(item = pending, hash?: string) {
    if (!item || !journal || !journalReady) return;
    let recovered;
    try { recovered = await reconcileMarketPending(marketProvider(null), item, journal, hash || item.hash); }
    catch (cause) {
      try { setPending(withObservedMarketHash(await loadMarketPending(journal), item)); }
      catch (readCause) { setStorageError(marketError(readCause)); setJournalState({ journal, account, status: 'error' }); }
      throw cause;
    }
    setNotice(recovered.message);
    if (!recovered.resolution || !recovered.receipt) { setPending(recovered.pending); return; }
    const result = recovered.receipt;
    const labels = { confirmed: '市场交易成功', reverted: '市场交易回滚', cancelled: '钱包取消已生效', replaced: '原交易已被替换' };
    setReceipt({ hash: result.hash, label: labels[recovered.resolution], success: result.status === 1, block: result.blockNumber, fee: result.fee });
    setPending(null); setRecoveryHash(''); setPosition(null); setQuote(null); setOrders([]); setIdentity(null); setCredit(null);
  }

  const journalReady = !!journal && !!account && journalState.journal === journal && journalState.account === account && journalState.status === 'ready' && !storageError;
  const frozen = !!busy || !!pending || !journalReady;
  const displayed = orders.filter(order => (!mine || (!!account && sameAddress(order.seller, account)))
    && (!filterPool.trim() || sameAddress(order.pool, filterPool.trim())));
  let freePrice = false;
  try { freePrice = price !== '' && unitPrice(price) === 0n; } catch { /* Input errors are shown at preview. */ }
  let buySummary: ReturnType<typeof tradeAmounts> | null = null, buyError = '';
  if (buyOrder && buyBalance !== null && account) {
    try { const quantity = shareAmount(buyAmount); requireFill(buyOrder, { state: buyOrder.state ?? -1, tradingAllowed: !!buyOrder.tradingAllowed }, account, quantity); buySummary = tradeAmounts(quantity, buyOrder.pricePerUnit); }
    catch (err) { buyError = marketError(err); }
  }

  return <div className="market-page">
    <div className="mk-heading"><div><div className="mk-eyebrow">SHARE MARKET <span>BSC MAINNET</span></div><h1>让份额自由流转<span>。</span></h1><p>按份挂单，按需买入。持仓与成交以链上记录为准。</p></div><div className="mk-heading-symbol"><ShoppingBag size={31}/></div></div>
    <div className="mk-top-grid">
      <section className="mk-card mk-connect"><div className="mk-section-title"><h2>连接你的份额市场</h2><span className="mk-tag">BNB · Chain 56</span></div><label htmlFor="mk-factory">Factory 合约地址</label><div className="mk-input-action"><input id="mk-factory" value={factory} placeholder="0x… 输入本次部署的 Factory 地址" disabled={!!busy} onChange={event => { version.current += 1; setFactory(event.target.value); setIdentity(null); setOrders([]); setCursor(null); setScanned(0); setTotalOrders(0n); setPosition(null); setCredit(null); setQuote(null); setBuyOrder(null); setBuyBalance(null); }}/><button className="mk-button mk-dark" disabled={!!busy || !factory.trim()} onClick={() => void refresh()}>{busy === '验证并读取市场' ? <LoaderCircle className="mk-spin" size={16}/> : <ArrowRight size={16}/>}验证市场</button></div><p className="mk-hint">{factoryAddress && sameAddress(factory, factoryAddress) ? '已填入本页面部署的 Factory。' : '手动地址请与项目部署记录核对。'}双向校验确认配置一致，不代表对任意合约的安全认证。</p>{identity && <div className="mk-identity"><span><CheckCircle2 size={14}/>绑定一致</span><span>市场 <Addr value={identity.market}/></span><span>时间锁 <Addr value={identity.timelock}/></span><span>区块 {identity.blockNumber.toLocaleString()}</span></div>}</section>
      <section className="mk-card mk-credit"><div className="mk-section-title"><span>可领取的市场收入</span><Coins size={18}/></div><div className="mk-credit-number">{credit === null ? '—' : bnb(credit)} <small>BNB</small></div><p>成交款与手续费收入单独记账，领取后进入你的钱包。</p><button className="mk-button mk-gold" disabled={!identity || (!!account && (frozen || credit === null || credit === 0n))} onClick={() => account ? void preview({ kind: 'withdraw' }) : onConnect()}><ArrowDownToLine size={16}/>{account ? '领取 BNB' : '连接钱包查看'}</button></section>
    </div>

    {error && <div className="mk-banner mk-error" role="alert"><CircleAlert size={18}/><span>{error}</span><button aria-label="关闭错误" onClick={() => setError('')}><X size={16}/></button></div>}
    {account && (!journalReady || storageError) && <div className="mk-banner mk-error" role="alert"><LockKeyhole size={18}/><span>{storageError || (journalState.status === 'loading' ? '正在读取服务器待确认交易记录，写操作暂不可用。' : '服务器交易日志不可用，市场写操作已暂停。')}</span><button className="mk-button mk-outline" onClick={() => setJournalLoad(value => value + 1)}>重试读取</button></div>}
    {notice && <div className="mk-banner" role="status"><CheckCircle2 size={17}/><span>{notice}</span></div>}
    {receipt && <div className={`mk-banner ${receipt.success ? '' : 'mk-error'}`}><CheckCircle2 size={17}/><span>{receipt.label} · 已最终确认 · 区块 {receipt.block.toLocaleString()} · 实际 Gas {bnb(receipt.fee)} BNB</span><Tx hash={receipt.hash}/></div>}
    {pending && <section className="mk-card mk-pending"><div className="mk-section-title"><h2><Clock3 size={18}/> 交易待核对</h2>{pending.hash && <Tx hash={pending.hash}/>}</div><p>账户 <Addr value={pending.account}/> 已有一笔市场交易记录。达到至少 2 次确认且链上 finalized 后才解除暂停，刷新或更换页面也会保留记录。</p><p className="mk-hint">如在钱包中加速、取消或替换了交易，请补录对应哈希；钱包未返回原哈希时也可在此补录。这里只核对同一账户与 nonce 的最终结果，不会重新发送。</p>{!pending.hash && !pending.recoveryHashes?.length && <p className="mk-hint">尚无交易哈希。若钱包拒绝签名或响应丢失，请在钱包中用 nonce {pending.nonce} 发送一笔 0 BNB 到自己地址的取消交易，随后在下方补录该交易哈希；最终确认前不能重试市场操作。</p>}<input aria-label="原交易或钱包替换交易哈希" value={recoveryHash} onChange={event => setRecoveryHash(event.target.value)} placeholder="0x… 可选：原交易、加速或取消哈希"/><button className="mk-button mk-dark" disabled={!!busy || !journalReady || (!pending.hash && !pending.recoveryHashes?.length && !recoveryHash.trim())} onClick={() => void run('核对交易回执', () => checkPending(pending, recoveryHash.trim() || undefined))}><RefreshCw size={15}/>核对回执并解除已结束记录</button></section>}

    <div className="mk-content-grid">
      <section className="mk-card mk-orders"><div className="mk-section-title"><div><h2>在售份额 <span className="mk-count">{displayed.length}</span></h2><p>最新挂单优先 · 每次读取 20 条链上订单</p></div><button className="mk-icon-button" aria-label="刷新市场订单" disabled={!!busy || !factory} onClick={() => void refresh()}><RefreshCw size={18} className={busy ? 'mk-spin' : ''}/></button></div><div className="mk-filters"><label className="mk-search"><Search size={16}/><input aria-label="按资金池地址筛选" value={filterPool} onChange={event => setFilterPool(event.target.value)} placeholder="输入完整资金池地址筛选"/></label><button className={`mk-filter-button ${mine ? 'selected' : ''}`} aria-pressed={mine} disabled={!account} onClick={() => setMine(!mine)}><SlidersHorizontal size={14}/>我的挂单</button></div>
        {!identity ? <div className="mk-empty"><ShoppingBag size={36}/><h3>从连接一个市场开始</h3><p>填入 Factory 地址并验证，即可读取真实挂单。</p></div> : displayed.length === 0 ? <div className="mk-empty"><ShoppingBag size={36}/><h3>{totalOrders === 0n ? '这个市场还没有挂单' : mine || filterPool ? '已加载订单中没有匹配结果' : '当前页没有活跃挂单'}</h3><p>{totalOrders === 0n ? '资金池运行后，持有人可以在右侧发布第一笔挂单。' : cursor !== null ? '可以加载更早的订单继续查看。' : '订单成交或撤销后会从在售列表移除。'}</p></div> : <div className="mk-order-list">{displayed.map(order => {
          const own = !!account && sameAddress(account, order.seller);
          const expired = order.expiresAt <= BigInt(Math.floor(Date.now() / 1000));
          const tradable = order.state === 2 && order.tradingAllowed && !expired && !order.verificationError;
          return <article className="mk-order" key={order.id.toString()}><div className="mk-order-main"><div className="mk-order-icon"><ShoppingBag size={19}/></div><div><div className="mk-order-id">订单 #{order.id.toString()} {own && <span className="mk-tag">我的</span>}{!tradable && <span className="mk-tag mk-paused">{order.verificationError ? '未验证' : expired ? '已到期' : '暂停成交'}</span>}</div><div className="mk-order-meta">资金池 <Addr value={order.pool}/><span>·</span>卖家 <Addr value={order.seller}/></div></div></div><div className="mk-order-values"><div><small>剩余份额</small><strong>{order.remaining.toString()} <em>份</em></strong></div><div><small>每份单价</small><strong>{order.pricePerUnit === 0n ? '免费' : bnb(order.pricePerUnit)} <em>{order.pricePerUnit === 0n ? '' : 'BNB'}</em></strong></div><button className={`mk-button ${own ? 'mk-outline' : 'mk-gold'}`} disabled={(!!account && frozen) || (!own && !tradable)} onClick={() => own ? void preview({ kind: 'cancel', orderId: order.id.toString() }) : void chooseBuy(order)}>{own ? '撤销挂单' : '购买份额'}{!own && <ArrowRight size={14}/>}</button></div>{!tradable && <p className="mk-order-note">{order.verificationError || (expired ? '挂单已到期，请撤单后重新定价挂出。' : order.state === 2 ? '整机出售表决期间暂停成交；卖家仍可撤单。' : `资金池${POOL_STATES[order.state ?? -1] || '状态未知'}，目前不可成交；卖家仍可撤单。`)}</p>}</article>;
        })}</div>}
        {identity && <div className="mk-pagination"><span>已扫描 {scanned} 条 / 历史 {totalOrders.toString()} 条{(mine || filterPool) && ' · 筛选仅作用于已加载订单'}</span>{cursor !== null && <button className="mk-button mk-outline" disabled={!!busy} onClick={() => void refresh(true)}>加载更早订单</button>}</div>}
      </section>

      <div className="mk-side"><section className="mk-card mk-list-form"><div className="mk-section-title"><h2>发布挂单</h2><span className="mk-tag">无需授权</span></div><label htmlFor="mk-pool">资金池地址</label><div className="mk-input-action"><input id="mk-pool" value={poolInput} onChange={event => { setPoolInput(event.target.value); setPosition(null); }} placeholder="0x…" disabled={!!busy}/><button className="mk-button mk-outline" disabled={!!busy || !identity || !poolInput.trim()} onClick={() => void inspectPool()}>读取</button></div>
        {position && <div className="mk-position"><div><strong>{position.name}</strong><span className={`mk-tag ${position.tradingAllowed ? '' : 'mk-paused'}`}>{position.state === 2 && !position.tradingAllowed ? '出售表决中' : POOL_STATES[position.state]}</span></div><div className="mk-position-grid"><div><small>持有</small><strong>{account ? position.balance.toString() : '—'}</strong></div><div><small>锁定</small><strong>{account ? position.locked.toString() : '—'}</strong></div><div><small>可出售</small><strong>{account ? position.available.toString() : '—'}</strong></div></div></div>}
        <div className="mk-form-row"><div><label htmlFor="mk-amount">出售份额</label><div className="mk-unit-input"><input id="mk-amount" inputMode="numeric" value={amount} onChange={event => setAmount(event.target.value)} placeholder="1–100"/><span>份</span></div></div><div><label htmlFor="mk-price">每份单价</label><div className="mk-unit-input"><input id="mk-price" inputMode="decimal" value={price} onChange={event => { setPrice(event.target.value); setFreeConfirmed(false); }} placeholder="0.00"/><span>BNB</span></div></div></div>
        {freePrice && <label className="mk-free-confirm"><input type="checkbox" checked={freeConfirmed} onChange={event => setFreeConfirmed(event.target.checked)}/><span>我确认以 0 BNB 免费转出挂单份额。</span></label>}
        <div className="mk-list-info"><div><span>成交手续费</span><strong>1% · 从卖家收入扣除</strong></div><div><span>挂单时扣款</span><strong>仅网络 Gas</strong></div></div><button className="mk-button mk-dark mk-wide" disabled={(!!account && frozen) || !identity || (!!account && (!position || position.state !== 2 || !position.tradingAllowed || position.available === 0n)) || (freePrice && !freeConfirmed)} onClick={() => account ? void preview({ kind: 'list', pool: poolInput, amount, price }) : onConnect()}>{account ? <ShoppingBag size={16}/> : <Wallet size={16}/>} {account ? '预览挂单' : '连接钱包挂单'}</button><p className="mk-hint"><LockKeyhole size={13}/> 挂单有效期 7 天，份额仍在你的钱包中并锁定。到期可撤单解锁，无需 approve。</p>
      </section><section className="mk-market-notes"><h3>成交前，你需要知道</h3><p>仅运行中的资金池支持交易。每个资金池共 100 份，单个钱包可以持有全部份额；订单支持部分成交。</p><p>历史已获得收益归原持有人；成交前合约会结算双方收益。外部收益结算失败时，整笔成交回滚。</p><p>整机出售表决及挂牌期间无法买卖份额，卖家仍可撤单。成交款需点击「领取 BNB」提取到钱包。</p></section></div>
    </div>
    {busy && <div className="mk-progress" role="status"><LoaderCircle size={17} className="mk-spin"/>{busy}…</div>}

    {buyOrder && buyBalance !== null && <div className="mk-modal-backdrop" onClick={() => { if (!busy) setBuyOrder(null); }}><section className="mk-modal" role="dialog" aria-modal="true" aria-labelledby="mk-buy-title" onClick={event => event.stopPropagation()}><button className="mk-modal-close" aria-label="关闭购买窗口" disabled={!!busy} onClick={() => setBuyOrder(null)}><X size={20}/></button><div className="mk-modal-icon"><ShoppingBag size={24}/></div><h2 id="mk-buy-title">购买份额</h2><p>订单 #{buyOrder.id.toString()} · <Addr value={buyOrder.pool}/></p><div className="mk-summary"><div><span>当前持有</span><strong>{buyBalance.toString()} / 100 份</strong></div><div><span>订单剩余</span><strong>{buyOrder.remaining.toString()} 份</strong></div><div><span>每份单价</span><strong>{bnb(buyOrder.pricePerUnit)} BNB</strong></div></div><label htmlFor="mk-buy-amount">本次购买份额</label><input id="mk-buy-amount" autoFocus inputMode="numeric" value={buyAmount} onChange={event => setBuyAmount(event.target.value)}/>{buyError && <p className="mk-inline-error">{buyError}</p>}{buySummary && <div className="mk-summary"><div><span>支付给合约</span><strong>{bnb(buySummary.gross)} BNB</strong></div><div><span>卖家实收</span><strong>{bnb(buySummary.sellerProceeds)} BNB</strong></div><div><span>含 1% 手续费</span><strong>{bnb(buySummary.fee)} BNB</strong></div></div>}<p className="mk-hint">手续费由卖家承担；你的支付金额之外仅另付网络 Gas。下一步将检查最新链上状态。</p><button className="mk-button mk-gold mk-wide" disabled={frozen || !!buyError} onClick={() => void preview({ kind: 'fill', orderId: buyOrder.id.toString(), amount: buyAmount, expectedPrice: buyOrder.pricePerUnit.toString() })}>模拟并预览交易<ArrowRight size={16}/></button></section></div>}

    {quote && <div className="mk-modal-backdrop" onClick={() => { if (!busy) setQuote(null); }}><section className="mk-modal" role="dialog" aria-modal="true" aria-labelledby="mk-confirm-title" onClick={event => event.stopPropagation()}><button className="mk-modal-close" aria-label="关闭确认窗口" disabled={!!busy} onClick={() => setQuote(null)}><X size={20}/></button><div className="mk-modal-icon"><Wallet size={24}/></div><h2 id="mk-confirm-title">{quote.title}</h2><p>模拟通过 · BSC 主网真实交易</p><div className="mk-summary"><div><span>发送账户</span><Addr value={quote.account}/></div><div><span>市场合约</span><Addr value={quote.identity.market}/></div>{quote.pool && <div><span>资金池</span><Addr value={quote.pool}/></div>}{quote.amount !== undefined && <div><span>{quote.action.kind === 'cancel' ? '解锁份额' : '交易份额'}</span><strong>{quote.amount.toString()} 份</strong></div>}{quote.action.kind === 'list' && <div><span>每份单价</span><strong>{quote.action.price} BNB{unitPrice(quote.action.price) === 0n ? ' · 免费转出' : ''}</strong></div>}{quote.action.kind === 'fill' && <><div><span>成交金额（含手续费）</span><strong>{bnb(quote.gross)} BNB</strong></div><div><span>卖家实收 / 手续费</span><strong>{bnb(quote.sellerProceeds)} / {bnb(quote.fee)} BNB</strong></div></>}{quote.action.kind === 'withdraw' && <div><span>领取金额</span><strong>{bnb(quote.withdrawal)} BNB</strong></div>}<div><span>网络 Gas 上限</span><strong>{bnb(quote.gasCost)} BNB</strong></div><div className="mk-total"><span>最多从钱包支出</span><strong>{bnb(quote.total)} BNB</strong></div></div><p className="mk-hint">包含 20% Gas 用量余量，实际费用以回执为准。钱包确认前会快速核对账户、网络、市场地址、手续费和交易是否仍可执行。</p><button className="mk-button mk-gold mk-wide" autoFocus disabled={frozen} onClick={() => void submit()}><Wallet size={16}/>在钱包中确认</button><button className="mk-cancel" disabled={!!busy} onClick={() => setQuote(null)}>返回检查</button></section></div>}
  </div>;
}
