import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDownToLine, ArrowUpRight, Check, ChevronLeft, ChevronRight, CircleHelp, LoaderCircle, RefreshCw, Search, ShieldCheck } from 'lucide-react';
import { createQuotePlan, fetchCapacityReference, fetchMineQuote, fetchQuotePage, FIRSTO_SOURCE, formatExact, OFFICIAL_COLLECTIONS, quoteIssue, referenceIssue, type CapacityReference, type MineQuote, type MineQuotePage, type PriceSort, type QuotePlan } from './pricing';
import './pricing.css';

type PricingPanelProps = { onPlan?: (plan: QuotePlan) => void };
const stamp = (value: number) => value > 0 ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '未知';
const short = (value: string) => `${value.slice(0, 8)}…${value.slice(-6)}`;
const statusLabels: Record<string, string> = { verified: '纯验证池', unverified: '未验证', optimal: '最优', not_started: '未启动', failed: '失败', checking: '检查中' };
const msg = (error: unknown) => error instanceof Error ? error.message : String(error);
function exportJson(filename: string, data: unknown) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a'); link.href = url; link.download = filename; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function bps(value: string) { if (!/^\d+(?:\.\d{1,2})?$/.test(value)) throw new Error('额外预算需填写百分比，最多两位小数'); const [whole, decimal = ''] = value.split('.'); return Number(whole) * 100 + Number(decimal.padEnd(2, '0')); }

export default function PricingPanel({ onPlan }: PricingPanelProps = {}) {
  const [page, setPage] = useState<MineQuotePage | null>(null);
  const [reference, setReference] = useState<CapacityReference | null>(null);
  const [query, setQuery] = useState(''); const [series, setSeries] = useState<'' | 'TapeOut' | 'Behemoth'>('');
  const [sort, setSort] = useState<PriceSort>('price_low'); const [busy, setBusy] = useState(false);
  const [error, setError] = useState(''); const [referenceError, setReferenceError] = useState('');
  const [collection, setCollection] = useState<string>(OFFICIAL_COLLECTIONS.TapeOut); const [tokenId, setTokenId] = useState('');
  const [selected, setSelected] = useState<MineQuote | null>(null); const [detailBusy, setDetailBusy] = useState(false); const [detailError, setDetailError] = useState('');
  const [extra, setExtra] = useState('10'); const [minimum, setMinimum] = useState(''); const [acknowledged, setAcknowledged] = useState(false); const [saved, setSaved] = useState('');
  const [now, setNow] = useState(Date.now()); const listAbort = useRef<AbortController | null>(null); const detailAbort = useRef<AbortController | null>(null);

  async function load(pageNumber = 1) {
    listAbort.current?.abort(); const abort = new AbortController(); listAbort.current = abort;
    setBusy(true); setError(''); setReferenceError(''); setPage(null); setReference(null); setAcknowledged(false); setSaved('');
    const results = await Promise.allSettled([fetchQuotePage({ query, series: series || undefined, sort, page: pageNumber }, { signal: abort.signal }), fetchCapacityReference({ signal: abort.signal })]);
    if (abort.signal.aborted) return;
    if (results[0].status === 'fulfilled') setPage(results[0].value); else setError(msg(results[0].reason));
    if (results[1].status === 'fulfilled') setReference(results[1].value); else setReferenceError(msg(results[1].reason));
    setBusy(false); setNow(Date.now());
  }
  useEffect(() => { void load(); return () => { listAbort.current?.abort(); detailAbort.current?.abort(); }; }, []);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  useEffect(() => { setAcknowledged(false); setSaved(''); }, [extra, minimum, selected, reference]);

  async function select(address: string, id: string) {
    detailAbort.current?.abort(); const abort = new AbortController(); detailAbort.current = abort;
    setCollection(address); setTokenId(id); setSelected(null); setDetailBusy(true); setDetailError(''); setSaved(''); setAcknowledged(false);
    try { const quote = await fetchMineQuote(address, id, { signal: abort.signal }); if (!abort.signal.aborted) { setSelected(quote); setMinimum(quote.verifiedWeight ?? ''); } }
    catch (cause) { if (!abort.signal.aborted) setDetailError(msg(cause)); }
    finally { if (!abort.signal.aborted) { setDetailBusy(false); setNow(Date.now()); } }
  }
  const planResult = useMemo(() => {
    if (!selected || !reference) return { plan: null, error: '核对目标矿机和新鲜日产能参考价后，可生成筹款计划。' };
    try { return { plan: createQuotePlan(selected, reference, bps(extra), minimum, now), error: '' }; }
    catch (cause) { return { plan: null, error: msg(cause) }; }
  }, [selected, reference, extra, minimum, now]);

  function savePlan() {
    try {
      if (!acknowledged || !selected || !reference) throw new Error('请核对并确认引用的报价与筹款配置');
      const plan = createQuotePlan(selected, reference, bps(extra), minimum, Date.now());
      const record = { plan, quote: selected, confirmedAt: new Date().toISOString(), confirmation: 'User confirmed public quote reference locally. No blockchain signature or order.' };
      localStorage.setItem('pinkuang.quote-plan.v1', JSON.stringify(record));
      exportJson(`pinkuang-quote-${selected.series}-${selected.tokenId}.json`, record);
      setSaved('已保存并导出本次报价与筹款计划。'); onPlan?.(plan);
    } catch (cause) { setDetailError(msg(cause)); }
  }

  return <div className="pricing-page">
    <div className="pricing-source"><span><ShieldCheck size={18}/>报价来源固定为 Firsto TapeOut</span><a href={FIRSTO_SOURCE} target="_blank" rel="noreferrer">打开原始市场<ArrowUpRight size={15}/></a></div>
    <div className="pricing-reference-grid"><section className="card pricing-reference"><div className="pricing-kicker">日产能价参考价</div><strong>{reference && !referenceIssue(reference, now) ? formatExact(reference.dailyCapacityPriceWei) : '暂不可用'}<small>BNB /（BEM / 日）</small></strong><p>官方 TapeOut / Behemoth 纯验证池、非最优矿机中，最低 5 个不同卖家有效挂单的日产能价中位数。排除未验证、混合权重、最优矿机和历史成交。</p>{reference && <div className="pricing-meta">来源更新 {stamp(reference.observedAt)} · 区块 {reference.sourceBlock}</div>}{(referenceError || (reference && referenceIssue(reference, now))) && <p className="pricing-error">{referenceError || referenceIssue(reference!, now)}</p>}</section><section className="pricing-explanation"><CircleHelp size={20}/><h3>参考产能价与卖价分别核对</h3><p>筹款按「参考产能价 × 目标日产能」再加额外预算计算。列表同时保留卖家挂单价、Firsto 买入总额，二者差额不能直接当成协议净手续费。</p><p>官网挂单价为 P 时，官网直购买方支付 P，协议费从卖方款项内扣；Firsto 买入总额是该站采购路径的总额，不能直接作为官网成交价。</p><p>费率须按具体订单与执行时规则核验。本报价模块尚未实施我们的平台采购费。金额以精确 wei 保存，仅用于报价与配置。</p></section></div>

    <section className="card pricing-list"><div className="card-heading"><div><Search size={20}/><h2>官方矿机报价</h2></div><button className="small-button" onClick={() => void load(1)} disabled={busy}><RefreshCw size={15} className={busy ? 'spin' : ''}/>刷新来源</button></div>
      <form className="pricing-filters" onSubmit={event => { event.preventDefault(); void load(1); }}><input aria-label="搜索矿机编号或名称" placeholder="搜索矿机编号或任务" value={query} onChange={event => setQuery(event.target.value)} maxLength={128}/><select aria-label="矿机系列" value={series} onChange={event => setSeries(event.target.value as typeof series)}><option value="">两种官方系列</option><option>TapeOut</option><option>Behemoth</option></select><select aria-label="报价排序" value={sort} onChange={event => setSort(event.target.value as PriceSort)}><option value="price_low">挂单价从低到高</option><option value="daily_capacity_price_low">日产能价从低到高</option><option value="recently_listed">最新挂单</option><option value="token_id_low">编号从小到大</option></select><button className="small-button" disabled={busy}><Search size={15}/>查询</button></form>
      {error && <div className="pricing-error-box" role="alert">{error}</div>}
      {busy && <div className="pricing-empty"><LoaderCircle className="spin" size={22}/>正在读取 Firsto 的当前报价…</div>}
      {!busy && page && <><div className="pricing-table-wrap"><table className="pricing-table"><thead><tr><th>官方矿机</th><th>状态 / 预计日产能</th><th>卖家挂单价</th><th>Firsto 买方总额</th><th>来源市场</th><th/></tr></thead><tbody>{page.rows.map(row => <tr key={`${row.collection}:${row.tokenId}`}><td><b>{row.series} #{row.tokenId}</b><small>任务 {row.taskId ?? '未知'}</small></td><td><span>{statusLabels[row.status] || row.status}</span><small>{formatExact(row.estimated24hAtomic, 8)} BEM / 日</small></td><td><b>{formatExact(row.ask?.priceWei)} <small>BNB</small></b></td><td><b>{formatExact(row.ask?.buyerCostWei)} <small>BNB</small></b>{row.ask && <small>较挂单价多 {formatExact((BigInt(row.ask.buyerCostWei) - BigInt(row.ask.priceWei)).toString())}</small>}</td><td>{row.ask?.venue === 'official' ? '官网市场报价' : row.ask?.kind === 'circuit_batch_ask' ? 'Firsto 批量挂单' : row.ask ? 'Firsto 签名挂单' : '未挂单'}{quoteIssue(row, now) && <small className="pricing-warning">{quoteIssue(row, now)}</small>}</td><td><button className="small-button" disabled={detailBusy} onClick={() => void select(row.collection, row.tokenId)}>核对详情<ChevronRight size={15}/></button></td></tr>)}</tbody></table></div>{!page.rows.length && <p className="pricing-empty">本页没有通过官方身份及字段检查的矿机报价。</p>}<div className="pricing-pagination"><span>源区块 {page.sourceBlock} · 第 {page.page} / {Math.max(1, page.totalPages)} 页{page.excluded > 0 && ` · 已排除 ${page.excluded} 条不符合官方挖矿准入或字段检查的数据`}</span><div><button className="small-button" disabled={busy || page.page <= 1} onClick={() => void load(page.page - 1)}><ChevronLeft size={15}/>上一页</button><button className="small-button" disabled={busy || page.page >= page.totalPages} onClick={() => void load(page.page + 1)}>下一页<ChevronRight size={15}/></button></div></div></>}
    </section>

    <section className="card pricing-detail"><div className="card-heading"><div><ShieldCheck size={20}/><h2>按合约与编号确认目标</h2></div><span className="subtle-tag">只读核对</span></div><form className="pricing-identity" onSubmit={event => { event.preventDefault(); void select(collection, tokenId); }}><label>官方系列合约<select value={collection} onChange={event => { detailAbort.current?.abort(); setDetailBusy(false); setCollection(event.target.value); setSelected(null); }}>{Object.entries(OFFICIAL_COLLECTIONS).map(([name, value]) => <option value={value} key={value}>{name} · {short(value)}</option>)}</select></label><label>矿机 NFT 编号<input value={tokenId} inputMode="numeric" placeholder="例如 16480" onChange={event => { detailAbort.current?.abort(); setDetailBusy(false); setTokenId(event.target.value); setSelected(null); }}/></label><button className="small-button" disabled={detailBusy || !tokenId}>{detailBusy ? <LoaderCircle className="spin" size={15}/> : <Search size={15}/>}读取并交叉核对</button></form>
      {detailError && <div className="pricing-error-box" role="alert">{detailError}</div>}
      {selected && <div className="pricing-selection"><div className="pricing-selected-title"><h3>{selected.series} #{selected.tokenId}</h3><span><Check size={15}/>合约、编号、报价和详情一致</span></div><dl><div><dt>合约地址</dt><dd className="pricing-address">{selected.collection}</dd></div><div><dt>持有人 / 卖家</dt><dd className="pricing-address">{selected.owner} / {selected.ask?.seller ?? '无'}</dd></div><div><dt>卖家挂单价</dt><dd>{formatExact(selected.ask?.priceWei)} BNB</dd></div><div><dt>Firsto 买入总额</dt><dd>{formatExact(selected.ask?.buyerCostWei)} BNB</dd></div><div><dt>报价源更新</dt><dd>{stamp(selected.source.observedAt)} · 区块 {selected.source.sourceBlock}</dd></div><div><dt>任务型号（报价来源）</dt><dd>T{selected.taskId ?? '未知'} · 建池时由链上数据锁定</dd></div><div><dt>详情状态 / 预计日产能</dt><dd>{statusLabels[selected.status] || selected.status} · {formatExact(selected.estimated24hAtomic, 8)} BEM / 日</dd></div><div><dt>同类矿机参考价</dt><dd>{formatExact(selected.listingReference?.priceWei)} BNB <small>仅作同类参考，非本机可成交价</small></dd></div></dl><p className="pricing-route-note">{selected.ask?.legacyListingId ? `官网旧市场挂单 ID ${selected.ask.legacyListingId}。实际购机仍须复核链上价格、持有人与状态。` : '这是 Firsto 签名/批量挂单或未识别市场报价。现有 PoolVault.buyFromMarket 不支持直接执行这些订单。'} 列表报价可能随时撤销、成交或变化。</p></div>}
    </section>

    <section className="card pricing-plan"><div className="card-heading"><div><ArrowDownToLine size={20}/><h2>按参考产能价筹款</h2></div><span className="subtle-tag">100 份 · 整数 wei</span></div><div className="pricing-plan-body"><div className="pricing-plan-inputs"><label>额外预算（%）<input inputMode="decimal" value={extra} onChange={event => setExtra(event.target.value)} placeholder="10"/><small>默认 10%，可在 0%–100% 内调整。</small></label><label>替代矿机最低验证权重 H<input inputMode="numeric" value={minimum} onChange={event => setMinimum(event.target.value)} placeholder="先核对目标矿机"/><small>默认使用目标矿机的当前验证权重。</small></label></div>{planResult.plan ? <><div className="pricing-formula"><span>参考产能价 × 目标日产能</span><b>{formatExact(planResult.plan.flexiblePurchase.referencePriceWei)} BNB</b><span>增加 {extra}% 预算，并向上取整为 100 份</span><strong>{formatExact(planResult.plan.funding.targetRaiseWei)} BNB</strong><small>每份 {formatExact(planResult.plan.funding.pricePerShareWei)} BNB · 精确值 {planResult.plan.funding.targetRaiseWei} wei</small></div><p className="pricing-plan-rule">合格替代品限定为同一官方合约、同任务型号 T{planResult.plan.eligibility.expectedTaskId}、纯验证池且非最优，验证权重至少 {minimum} H。建池时由链上锁定型号；原目标仍有合格官网挂单时，禁止购买替代品。购机支出不得超过总价上限，余款按购机时的份额比例计入可领取余额。此计划仅导出配置，尚不创建资金池。</p><div className="pricing-digest">参考快照 Keccak-256 摘要 <code>{planResult.plan.sourceDigest}</code></div><label className="acknowledgment"><input type="checkbox" checked={acknowledged} onChange={event => setAcknowledged(event.target.checked)}/><span>我已核对 Firsto 来源、目标矿机、参考价与额外预算，确认将其作为本次筹款配置依据。</span></label><button className="primary-button" disabled={!acknowledged || detailBusy || busy} onClick={savePlan}><ArrowDownToLine size={17}/>确认参考并导出筹款计划</button></> : <p className="pricing-plan-unavailable">{planResult.error}</p>}{saved && <div className="success-inline"><Check size={18}/>{saved}</div>}</div></section>
  </div>;
}
