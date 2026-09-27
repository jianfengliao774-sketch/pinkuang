'use client';
import { useEffect, useRef, useState } from 'react';
import { formatEther, formatUnits, ZeroAddress } from 'ethers';
import { Search, RefreshCw, ArrowRight, CheckCircle2 } from 'lucide-react';
import { listOperatorQuotes, loadOperatorQuote, operatorQuoteDraft, operatorQuoteError, QUOTE_SOURCE } from '../lib/operator-quotes.mjs';

const amount = (value, decimals = 18) => value == null ? '—' : formatUnits(value, decimals);

export default function OperatorQuotePicker({ config, mode, disabled, onApply }) {
  const [page, setPage] = useState(null), [query, setQuery] = useState(''), [series, setSeries] = useState('');
  const [selected, setSelected] = useState(null), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [extra, setExtra] = useState('10');
  const request = useRef({ sequence: 0, abort: null });
  const invalidate = () => { request.current.abort?.abort(); request.current.sequence += 1; };
  useEffect(() => { void load(1); return invalidate; }, [config.factory]);
  useEffect(() => { setError(''); }, [mode]);
  async function load(number = 1) {
    invalidate(); const sequence = request.current.sequence, abort = new AbortController(); request.current.abort = abort;
    setBusy(true); setError(''); setSelected(null);
    try {
      const result = await listOperatorQuotes({ query, series: series || undefined, page: number,
        ...(number > 1 && page ? { viewId: page.viewId } : {}) }, { signal: abort.signal });
      if (sequence === request.current.sequence) setPage(result);
    } catch (problem) { if (sequence === request.current.sequence) { setError(operatorQuoteError(problem)); setPage(null); } }
    finally { if (sequence === request.current.sequence) setBusy(false); }
  }
  async function choose(row) {
    invalidate(); const sequence = request.current.sequence, abort = new AbortController(); request.current.abort = abort;
    setBusy(true); setError(''); setSelected(null);
    try {
      const result = await loadOperatorQuote({ collection: row.collection, tokenId: row.tokenId, config, signal: abort.signal });
      if (sequence === request.current.sequence) setSelected(result);
    } catch (problem) { if (sequence === request.current.sequence) setError(operatorQuoteError(problem)); }
    finally { if (sequence === request.current.sequence) setBusy(false); }
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
  return <section className="operator-quotes" aria-label="自动获取矿机报价">
    <div className="section-head"><div><h3>选择矿机，自动生成方案</h3><p>自动读取市场报价、预计日产出，并核对矿机归属、项目登记和可执行订单。</p></div><a href={QUOTE_SOURCE} target="_blank" rel="noreferrer">查看来源 ↗</a></div>
    <form className="operator-quote-search" onSubmit={event => { event.preventDefault(); void load(1); }}>
      <input aria-label="搜索报价矿机编号" placeholder="矿机编号或任务" value={query} maxLength={120} disabled={blocked} onChange={event => setQuery(event.target.value)}/>
      <select aria-label="报价矿机系列" value={series} disabled={blocked} onChange={event => setSeries(event.target.value)}><option value="">全部系列</option><option>TapeOut</option><option>Behemoth</option></select>
      <button className="btn secondary" disabled={blocked}><Search size={16}/>查询</button>
      <button type="button" className="btn secondary" disabled={blocked} onClick={() => void load(1)}><RefreshCw size={16}/>刷新报价</button>
    </form>
    {error && <p className="live-notice error" role="alert">{error}</p>}
    {busy && <p role="status">正在读取并核对矿机数据…</p>}
    {!busy && page && <><div className="operator-quote-table"><table><thead><tr><th>矿机</th><th>市场挂单价</th><th>预计日产出</th><th>报价来源</th><th/></tr></thead><tbody>
      {page.rows.map(row => <tr key={`${row.collection}:${row.tokenId}`}><td>{row.series} #{row.tokenId}<small>{row.status === 'verified' ? '已验证矿机' : '不符合纯验证矿机条件'}</small></td><td>{amount(row.ask?.priceWei)} BNB</td><td>{amount(row.estimated24hAtomic, 8)} BEM</td><td>{row.ask?.venue === 'official' ? '官网市场' : row.ask ? row.ask.kind === 'signed_ask' ? 'Firsto · 待链上核验' : 'Firsto 批量 · 仅供参考' : '未挂单'}</td><td><button className="btn secondary" disabled={blocked || row.status !== 'verified' || !row.ask} onClick={() => void choose(row)}>核对并选择</button></td></tr>)}
    </tbody></table></div>{!page.rows.length && <p>未找到符合身份检查的报价，请调整搜索条件。</p>}
      <div className="operator-tabs"><button className="btn secondary" disabled={blocked || page.page <= 1} onClick={() => void load(page.page - 1)}>上一页</button><span>第 {page.page} / {Math.max(page.totalPages, 1)} 页</span><button className="btn secondary" disabled={blocked || page.page >= page.totalPages} onClick={() => void load(page.page + 1)}>下一页</button></div></>}
    {selected && <div className="operator-quote-selected"><h4><CheckCircle2 size={18}/>{selected.quote.series} #{selected.quote.tokenId} · 矿机链上核对通过</h4>
      <p>预计日产出 {amount(selected.quote.estimated24hAtomic, 8)} BEM（估算）；核对区块 {selected.chain.blockNumber}。</p>
      {duplicate && <p className="live-notice error">此矿机已有拼矿项目：<a href={`https://bscscan.com/address/${registeredPool}`} target="_blank" rel="noreferrer">{registeredPool}</a>，不能重复创建。</p>}
      {selected.chain.firsto ? <><p>可采购 Firsto 单笔签名订单：卖价 {formatEther(selected.chain.firsto.priceWei)} BNB + 来源手续费 {formatEther(selected.chain.firsto.feeWei)} BNB。</p><p><strong>矿池总支出 {formatEther(selected.chain.firsto.grossWei)} BNB</strong>；指定矿机方案的购机上限已包含该手续费。</p></>
        : selected.chain.official ? <p>可采购官网挂单 #{selected.chain.official.id}：{formatEther(selected.chain.official.priceWei)} BNB。</p>
        : <p className="operator-quote-warning">当前没有本项目可采购的官网挂单。可作为灵活购机的型号与产能参考；募集后仍须找到符合条件的官网挂单，未购成按合约退款。</p>}
      {selected.chain.firstoError && <p className="operator-quote-warning">{selected.chain.firstoError}</p>}
      {mode === 'createFlexiblePoolChecked' && <p className="subtle-note">灵活购机仍按日产能参考计算购机上限；实际成交含费总价必须低于该上限。</p>}
      <label>额外募集预算（%）<input aria-label="额外募集预算百分比" inputMode="decimal" value={extra} disabled={blocked} onChange={event => setExtra(event.target.value)}/></label>
      <p className="subtle-note">预算默认 10%，可以调整；募集和购机时长在下方确认。只有点击预览、核对方案后才会请求钱包交易。</p>
      <button className="btn" disabled={blocked || duplicate || !selected.chain.registry?.supported || !selected.chain.registry.ready || (mode === 'createPool' && !selected.chain.official && !selected.chain.firsto)} onClick={apply}>填入建池表单<ArrowRight size={16}/></button>
    </div>}
  </section>;
}
