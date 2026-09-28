'use client';
import { displayAmount, displayBnb } from '../lib/amount-display.mjs';
import { useEffect, useRef, useState } from 'react';
import { ZeroAddress } from 'ethers';
import { Search, RefreshCw, ArrowRight, CheckCircle2 } from 'lucide-react';
import { listOperatorQuotes, loadOperatorQuote, loadVerifiedCapacityHint, listingDailyCapacityPrice, operatorQuoteDraft, operatorQuoteError, QUOTE_SOURCE } from '../lib/operator-quotes.mjs';
import { OFFICIAL_COLLECTIONS, fetchCapacityReference, referenceIssue } from '../../deploy/src/pricing.ts';

const amount = (value, decimals = 18) => value == null ? '—' : decimals === 18 ? displayBnb(value) : displayAmount(value, decimals);
const firstoStatus = { verified: '纯验证', unverified: '未验证', optimal: '最优', not_started: '未启动', failed: '已失败', checking: '检查中' };

export default function OperatorQuotePicker({ config, mode, disabled, onApply }) {
  const [page, setPage] = useState(null), [query, setQuery] = useState(''), [series, setSeries] = useState('');
  const [sort, setSort] = useState('daily_capacity_price_low');
  const [selected, setSelected] = useState(null), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [capacityHint, setCapacityHint] = useState(null);
  const [capacityError, setCapacityError] = useState('');
  const [marketReference, setMarketReference] = useState(null);
  const [marketReferenceError, setMarketReferenceError] = useState('');
  const [extra, setExtra] = useState('10');
  const request = useRef({ sequence: 0, abort: null });
  const invalidate = () => { request.current.abort?.abort(); request.current.sequence += 1; };
  useEffect(() => { setPage(null); setSelected(null); setCapacityHint(null); setCapacityError(''); setMarketReference(null); setMarketReferenceError(''); void load(1); return invalidate; }, [config.factory]);
  useEffect(() => { setSelected(null); setCapacityHint(null); setCapacityError(''); setMarketReference(null); setMarketReferenceError(''); setError(''); }, [mode]);
  async function load(number = 1) {
    invalidate(); const sequence = request.current.sequence, abort = new AbortController(); request.current.abort = abort;
    setBusy(true); setError(''); setSelected(null); setCapacityHint(null); setCapacityError(''); setMarketReference(null); setMarketReferenceError('');
    try {
      const result = await listOperatorQuotes({ query, series: series || undefined, sort, page: number,
        ...(number > 1 && page ? { viewId: page.viewId } : {}) }, { signal: abort.signal });
      if (sequence === request.current.sequence) {
        const exactId = /^\d+$/.test(query.trim()) ? query.trim() : null;
        setPage(exactId ? { ...result, rows: result.rows.filter(row => row.tokenId === exactId && (!series || row.series === series)), totalPages: 1 } : result);
      }
    } catch (problem) { if (sequence === request.current.sequence) { setError(operatorQuoteError(problem)); setPage(null); } }
    finally { if (sequence === request.current.sequence) setBusy(false); }
  }
  async function choose(row) {
    invalidate(); const sequence = request.current.sequence, abort = new AbortController(); request.current.abort = abort;
    setBusy(true); setError(''); setSelected(null); setCapacityHint(null); setCapacityError(''); setMarketReference(null); setMarketReferenceError('');
    try {
      const result = await loadOperatorQuote({ collection: row.collection, tokenId: row.tokenId, config, mode, signal: abort.signal });
      if (sequence === request.current.sequence) {
        setSelected(result);
        if (!result.quote) void loadVerifiedCapacityHint(result.chain, { signal: abort.signal })
          .then(hint => { if (sequence === request.current.sequence) setCapacityHint(hint); })
          .catch(problem => { if (sequence === request.current.sequence) setCapacityError(operatorQuoteError(problem)); });
        if (result.reference) setMarketReference(result.reference);
        else void fetchCapacityReference({ signal: abort.signal })
          .then(reference => { if (sequence === request.current.sequence) setMarketReference(reference); })
          .catch(problem => { if (sequence === request.current.sequence) setMarketReferenceError(operatorQuoteError(problem)); });
      }
    } catch (problem) { if (sequence === request.current.sequence) setError(`${row.series} #${row.tokenId}：${operatorQuoteError(problem)}`); }
    finally { if (sequence === request.current.sequence) setBusy(false); }
  }
  function search() {
    const exactId = query.trim();
    if (/^\d+$/.test(exactId) && !series) { setError('按矿机编号查询时，请先选择 TapeOut 或 Behemoth 系列。'); return; }
    void load(1);
  }
  function apply() {
    try {
      if (!/^\d{1,3}(?:\.\d{1,2})?$/.test(extra)) throw new Error('额外预算请输入 0–100 的百分比，最多两位小数。');
      const extraBps = Math.round(Number(extra) * 100);
      const draft = operatorQuoteDraft(selected, { mode, extraBps });
      onApply({ draft, checked: selected, extraBps });
    } catch (problem) { setError(operatorQuoteError(problem)); }
  }
  const blocked = disabled || busy;
  const registeredPool = selected?.chain.registry?.pool;
  const duplicate = registeredPool && registeredPool !== ZeroAddress;
  const selectedDailyYield = selected?.quote?.estimated24hAtomic ?? capacityHint?.estimated24hAtomic;
  const selectedYieldObservedAt = selected?.quote?.source?.observedAt ?? capacityHint?.observedAt;
  const selectedAskPrice = selected?.chain.official?.priceWei ?? selected?.chain.firsto?.priceWei;
  const selectedDailyPrice = listingDailyCapacityPrice(selectedAskPrice, selectedDailyYield, 5);
  const freshMarketReference = marketReference && !referenceIssue(marketReference) ? marketReference : null;
  return <section className="operator-quotes" aria-label="自动获取矿机报价">
    <div className="section-head"><div><h3>先查官网挂单，再看 Firsto</h3><p>选择系列并输入准确编号，先按链上矿机身份查询官网市场；官网无可用挂单时再核验 Firsto 订单。</p></div><a href={QUOTE_SOURCE} target="_blank" rel="noreferrer">Firsto 来源 ↗</a></div>
    <form className="operator-quote-search" onSubmit={event => { event.preventDefault(); search(); }}>
      <input aria-label="搜索报价矿机编号" placeholder="输入准确矿机编号；非编号可搜 Firsto" value={query} maxLength={120} disabled={blocked} onChange={event => setQuery(event.target.value)}/>
      <select aria-label="报价矿机系列" value={series} disabled={blocked} onChange={event => setSeries(event.target.value)}><option value="">全部系列</option><option>TapeOut</option><option>Behemoth</option></select>
      <select aria-label="候选排序" value={sort} disabled={blocked} onChange={event => setSort(event.target.value)}><option value="daily_capacity_price_low">挂单日产能价从低到高</option><option value="price_low">挂单总价从低到高</option></select>
      <button className="btn secondary" disabled={blocked}><Search size={16}/>查询矿机</button>
      <button type="button" className="btn secondary" disabled={blocked} onClick={() => void load(1)}><RefreshCw size={16}/>刷新日产能价候选</button>
    </form>
    {!page && !selected && !busy && !error && <p className="subtle-note">已知编号可直接查询官网，无需等待 Firsto；浏览列表仅用于发现候选，实际购机路线以链上核验结果为准。</p>}
    {error && <p className="live-notice error" role="alert">{error}</p>}
    {busy && <p role="status">正在读取并核对矿机数据…</p>}
    {!busy && page && <><div className="operator-quote-table"><table><thead><tr><th>矿机</th><th>市场挂单价</th><th>预计日产出</th><th>挂单日产能价<small>BNB / (BEM / 天)</small></th><th>Firsto 同类参考价<small>BNB / (BEM / 天)</small></th><th>报价来源</th><th/></tr></thead><tbody>
      {page.rows.map(row => <tr key={`${row.collection}:${row.tokenId}`}><td>{row.series} #{row.tokenId}<small>Firsto 状态：{firstoStatus[row.status] || row.status || '未知'} · 以链上复核为准</small></td><td>{amount(row.ask?.priceWei)} BNB</td><td>{amount(row.estimated24hAtomic, 8)} BEM</td><td>{listingDailyCapacityPrice(row.ask?.priceWei, row.estimated24hAtomic, 5) ?? '—'}</td><td>{row.listingReference ? amount(row.listingReference.dailyCapacityPriceWei) : '—'}</td><td>{row.ask?.venue === 'official' ? 'Firsto 索引 · 官网待链上核验' : row.ask ? row.ask.kind === 'signed_ask' ? 'Firsto · 待链上核验' : 'Firsto 批量 · 仅供参考' : '未挂单'}</td><td><button className="btn secondary" disabled={blocked} onClick={() => void choose(row)}>链上核对并选择</button></td></tr>)}
    </tbody></table></div><p className="subtle-note">挂单日产能价＝当前列表挂单价 ÷ 预计日产出；同类参考价来自 Firsto 的 listingReference，不能当成这台矿机的可成交价格。选中后仍以官网链上挂单或已核验 Firsto 订单为准。</p>{!page.rows.length && <><p>Firsto 列表未找到这个编号的可用挂单；官网链上挂单仍可直接核对。</p>{/^\d+$/.test(query.trim()) && series && <button type="button" className="btn secondary" disabled={blocked} onClick={() => void choose({ collection: OFFICIAL_COLLECTIONS[series], tokenId: query.trim(), series })}>直查官网链上矿机</button>}</>}
      <div className="operator-tabs"><button className="btn secondary" disabled={blocked || page.page <= 1} onClick={() => void load(page.page - 1)}>上一页</button><span>第 {page.page} / {Math.max(page.totalPages, 1)} 页</span><button className="btn secondary" disabled={blocked || page.page >= page.totalPages} onClick={() => void load(page.page + 1)}>下一页</button></div></>}
    {selected && <div className="operator-quote-selected"><h4><CheckCircle2 size={18}/>{Object.entries(OFFICIAL_COLLECTIONS).find(([, address]) => address.toLowerCase() === selected.chain.collection.toLowerCase())?.[0]} #{selected.chain.tokenId} · 矿机链上核对通过</h4>
      <p>预计日产出：<strong>{selectedDailyYield ? `${amount(selectedDailyYield, 8)} BEM / 天` : '—'}</strong>{!selectedDailyYield ? capacityError ? `（${capacityError}）` : '（读取 Firsto 产能中）' : `（Firsto 估算，更新于 ${new Date(selectedYieldObservedAt).toLocaleString('zh-CN')}）`}；链上核对区块 {selected.chain.blockNumber}。{!selected.quote && '官网挂单已核验，无需等待 Firsto 报价。'}</p>
      <p>该矿机当前{selected.chain.official ? '官网' : 'Firsto'}挂单日产能价：<strong>{selectedDailyPrice == null ? '—' : `${selectedDailyPrice} BNB / (BEM / 天)`}</strong></p>
      <p>Firsto 全市场参考日产能价：<strong>{freshMarketReference ? `${amount(freshMarketReference.dailyCapacityPriceWei, 18)} BNB / (BEM / 天)` : '—'}</strong>{freshMarketReference ? `（更新于 ${new Date(freshMarketReference.observedAt).toLocaleString('zh-CN')}）` : marketReferenceError ? `（${marketReferenceError}）` : marketReference ? '（报价已过期，请重新选择）' : '（读取中）'}</p>
      <p className="subtle-note">两项价格口径不同：上方按这台矿机的可执行挂单价除以其预计日产出；Firsto 顶部展示的是全市场参考价。额外 10% 是募集预留，不计入这两个日产能价。</p>
      {duplicate && <p className="live-notice error">此矿机已有拼矿项目：<a href={`https://bscscan.com/address/${registeredPool}`} target="_blank" rel="noreferrer">{registeredPool}</a>，不能重复创建。</p>}
      {selected.chain.official ? <p>官网优先：可采购官网挂单 #{selected.chain.official.id}，链上价格 {displayBnb(selected.chain.official.priceWei)} BNB。此价格用于指定矿机方案的购机上限。</p>
        : selected.chain.firsto ? <><p>官网暂无可用挂单；已核验 Firsto 单笔签名订单：卖价 {displayBnb(selected.chain.firsto.priceWei)} BNB + 来源手续费 {displayBnb(selected.chain.firsto.feeWei)} BNB。</p><p><strong>矿池总支出 {displayBnb(selected.chain.firsto.grossWei)} BNB</strong>；指定矿机方案的购机上限已包含该手续费。</p></>
        : <p className="operator-quote-warning">当前没有本项目可采购的官网挂单。可作为灵活购机的型号与产能参考；募集后仍须找到符合条件的官网挂单，未购成按合约退款。</p>}
      {selected.chain.firstoError && <p className="operator-quote-warning">{selected.chain.firstoError}</p>}
      {mode === 'createFlexiblePoolChecked' && <p className="subtle-note">灵活购机仍按日产能参考计算购机上限；实际成交含费总价必须低于该上限。</p>}
      <label>额外募集预算（%）<input aria-label="额外募集预算百分比" inputMode="decimal" value={extra} disabled={blocked} onChange={event => setExtra(event.target.value)}/></label>
      <p className="subtle-note">预算默认 10%，可以调整；募集和购机时长在下方确认。只有点击预览、核对方案后才会请求钱包交易。</p>
      <button className="btn" disabled={blocked || duplicate || !selected.chain.registry?.supported || !selected.chain.registry.ready || (mode === 'createPool' && !selected.chain.official && !selected.chain.firsto)} onClick={apply}>填入建池表单<ArrowRight size={16}/></button>
    </div>}
  </section>;
}
