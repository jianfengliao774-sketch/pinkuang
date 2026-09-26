'use client';
import { useEffect, useMemo, useState } from 'react';
import { useI18n } from '../lib/i18n';
import { purchaseTotal, subscriptionPrice } from '../lib/economics';
import { Search, SlidersHorizontal, X, ArrowRight, Cpu, ChevronDown, Layers, Activity, ArrowUpRight, Info } from 'lucide-react';
import { CATALOG_LABELS, CATALOG_STATUSES, DEFAULT_FILTERS, SOURCES, SORT_OPTIONS, selectProjects, summarizeProjects, projectPrice, dailyUnitPrice, projectSources, projectGroup } from '../lib/catalog';

const amount = (value, digits = 2) => value == null || !Number.isFinite(value) ? '—' : value.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });

function ProjectRows({ pools, onDetails, status }) {
  const { t } = useI18n();
  if (!pools.length) return <div className="catalog-empty"><Search size={28}/><h3>{t("没有符合条件的矿机")}</h3><p>{t("试试调整价格、日产出范围或搜索关键词。")}</p></div>;
  return <div className="catalog-table-scroll" role="region" aria-label={t("矿机信息列表")} tabIndex={0}>
    <table className="catalog-table"><thead><tr>
      <th>{t("矿机 / 来源")}</th><th>{t("全机日产出")}<small>{t("BEM / 天")}</small></th><th>{status === 'Listed' ? t('当前挂牌价') : status === 'Active' ? t('购入整机价') : t('目标募集金额')}<small>BNB</small></th><th>{t("日产能价")}<small>{t("BNB / (BEM / 天)")}</small></th><th>{status === 'Funding' ? t('募集进度') : status === 'Listed' ? t('出售状态') : t('挖矿状态')}</th><th aria-label={t("操作")}/></tr></thead>
      <tbody>{pools.map(pool => <tr key={`${pool.series}-${pool.id}`}>
        <td><button className="catalog-asset" onClick={() => onDetails(pool)}><span className={`catalog-chip ${pool.series === 'BEHEMOTH' ? 'behemoth' : ''}`}><Cpu size={25}/></span><span><strong>{pool.name} <span>#{pool.id}</span></strong><small>{pool.gates} NAND · {t('{count} 位参与者', { count: pool.members })}</small></span></button><div className="catalog-sources">{projectSources(pool).map(source => <span key={source}>{t(SOURCES[source])}</span>)}<em>{t("演示来源")}</em></div></td>
        <td className="catalog-output"><strong>{amount(pool.daily)}</strong><small>{status === 'Funding' ? t('预计日产出') : t('当前估计日产出')}</small></td>
        <td className="catalog-number"><strong>{amount(status === 'Funding' ? purchaseTotal(pool) : projectPrice(pool), status === 'Listed' ? 2 : 3)}</strong><small>{status === 'Funding' ? t('每份 {amount} BNB', { amount: amount(subscriptionPrice(pool), 5) }) : status === 'Listed' ? t('整机挂牌价格') : t('实际购机成本')}</small></td>
        <td className="catalog-number"><strong>{amount(dailyUnitPrice(pool), 3)}</strong><small>{pool.daily > 0 ? t('整机价 ÷ 日产出') : t('日产出暂不可用')}</small></td>
        <td>{projectGroup(pool) === 'Funding' ? <div className="catalog-funding"><strong>{pool.funded}<small>{t(" / 100 份")}</small></strong><span className="catalog-progress"><i style={{ width: `${Math.max(0, Math.min(100, pool.funded))}%` }}/></span><small>{pool.status === 'Funded' ? t('募集完成 · 待购机') : t('剩余 {count} 份', { count: Math.max(0, 100 - pool.funded) })}</small></div> : <div className="catalog-running"><span className={`catalog-state ${pool.status.toLowerCase()}`}><i/>{t(CATALOG_LABELS[pool.status])}</span><small>{t('已运行 {count} 天', { count: pool.age })}</small></div>}</td>
        <td><button className="catalog-detail" onClick={() => onDetails(pool)}>{t("查看矿机")}<ArrowUpRight size={16}/></button></td>
      </tr>)}</tbody>
    </table><p className="catalog-scroll-hint">{t("左右滑动查看完整矿机信息")}</p>
  </div>;
}

const initialStatus = value => CATALOG_STATUSES.includes(value) ? value : ({ '募集中': 'Funding', '挖矿中': 'Active', '整机出售中': 'Listed' }[value] || 'all');
export default function PoolCatalog({ pools, onDetails, initialTab = '项目总览' }) {
  const { t } = useI18n();
  const [status, setStatus] = useState(() => initialStatus(initialTab));
  useEffect(() => { setStatus(initialStatus(initialTab)); }, [initialTab]);
  const [query, setQuery] = useState('');
  const [filters, setFilters] = useState({ ...DEFAULT_FILTERS });
  const [sort, setSort] = useState('funded-desc');
  const [filterOpen, setFilterOpen] = useState(false);
  const selected = useMemo(() => selectProjects(pools, { status, query, filters, sort }), [pools, status, query, filters, sort]);
  const totals = useMemo(() => summarizeProjects(pools), [pools]);
  const overviewTotals = useMemo(() => summarizeProjects(selected), [selected]);
  const activeFilters = Object.keys(DEFAULT_FILTERS).filter(key => filters[key] !== DEFAULT_FILTERS[key]).length;
  const setFilter = (key, value) => setFilters(current => ({ ...current, [key]: value }));
  const invalidRange = (filters.dailyMin !== '' && filters.dailyMax !== '' && Number(filters.dailyMin) > Number(filters.dailyMax)) || (filters.priceMin !== '' && filters.priceMax !== '' && Number(filters.priceMin) > Number(filters.priceMax));
  return <section className="bem-catalog">
    <div className="page-heading"><div><div className="eyebrow">BEMine / MINING TOGETHER</div><h1>{t("参与拼矿")}</h1><p>{t("从矿机产出出发，找到适合你的参与方式。")}</p></div><span className="catalog-data-tag"><i/>{t("演示数据")}</span></div>
    <div className="catalog-tabs" role="tablist" aria-label={t("项目状态")}>
      <button role="tab" aria-selected={status === 'all'} onClick={() => setStatus('all')}>{t("项目总览")}</button>
      {totals.map(item => <button key={item.status} role="tab" aria-selected={status === item.status} onClick={() => setStatus(item.status)}>{t(CATALOG_LABELS[item.status])}<span>{item.count}</span></button>)}
    </div>
    <div className="catalog-toolbar"><label className="catalog-search"><Search size={18}/><input value={query} onChange={event => setQuery(event.target.value)} placeholder={t("搜索矿机编号、TapeOut / Behemoth")} aria-label={t("搜索矿机")}/>{query && <button onClick={() => setQuery('')} aria-label={t("清除搜索")}><X size={16}/></button>}</label>
      <div className="catalog-controls"><button className={`catalog-filter-button ${filterOpen || activeFilters ? 'is-active' : ''}`} aria-expanded={filterOpen} aria-controls="catalog-filters" onClick={() => setFilterOpen(open => !open)}><SlidersHorizontal size={17}/>{t('筛选')}{activeFilters > 0 && <span>{activeFilters}</span>}<ChevronDown size={15}/></button><label className="catalog-sort"><span className="sr-only">{t("矿机排序")}</span><select value={sort} onChange={event => setSort(event.target.value)} aria-label={t("矿机排序")}>{SORT_OPTIONS.map(([value, label]) => <option key={value} value={value}>{t(label)}</option>)}</select><ChevronDown size={15}/></label></div>
    </div>
    {filterOpen && <div className="catalog-filter-panel" id="catalog-filters"><div className="catalog-filter-fields">
      <label>{t("市场来源")}<select value={filters.source} onChange={event => setFilter('source', event.target.value)}><option value="all">{t("全部来源")}</option>{Object.entries(SOURCES).map(([value, label]) => <option key={value} value={value}>{t(label)}</option>)}</select></label>
      <label>{t("矿机系列")}<select value={filters.series} onChange={event => setFilter('series', event.target.value)}><option value="all">{t("全部系列")}</option><option value="TAPEOUT">TapeOut</option><option value="BEHEMOTH">Behemoth</option></select></label>
      <fieldset><legend>{t("全机日产出 · BEM / 天")}</legend><div><input type="number" min="0" step="any" placeholder={t("最低")} aria-label={t("最低日产出")} value={filters.dailyMin} onChange={event => setFilter('dailyMin', event.target.value)}/><span>—</span><input type="number" min="0" step="any" placeholder={t("最高")} aria-label={t("最高日产出")} value={filters.dailyMax} onChange={event => setFilter('dailyMax', event.target.value)}/></div></fieldset>
      <fieldset><legend>{t("整机价格 · BNB")}</legend><div><input type="number" min="0" step="any" placeholder={t("最低")} aria-label={t("最低价格")} value={filters.priceMin} onChange={event => setFilter('priceMin', event.target.value)}/><span>—</span><input type="number" min="0" step="any" placeholder={t("最高")} aria-label={t("最高价格")} value={filters.priceMax} onChange={event => setFilter('priceMax', event.target.value)}/></div></fieldset>
    </div><div className="catalog-filter-foot"><p>{invalidRange ? t('最低值不能大于最高值，请调整筛选范围。') : t('同一矿机可能同时出现在两个市场，列表仅展示一次。')}</p><button onClick={() => { setFilters({ ...DEFAULT_FILTERS }); setQuery(''); setSort('funded-desc'); }}>{t("重置筛选")}</button></div></div>}
    <div className="catalog-result-info"><span>{status === 'all' ? t('项目概况') : t(CATALOG_LABELS[status])}<b>{selected.length}</b>{t('个项目')}{(activeFilters > 0 || query) && t(' · 已筛选')}</span><span><Info size={14}/>{t("日产出为估计值，随矿机运行情况变化")}</span></div>
    {status === 'all' ? <><div className="catalog-summaries">{overviewTotals.map(item => <button key={item.status} className={`catalog-summary ${item.status.toLowerCase()}`} onClick={() => setStatus(item.status)}><span className="catalog-summary-label">{item.status === 'Funding' ? <Layers size={18}/> : item.status === 'Active' ? <Activity size={18}/> : <ArrowUpRight size={18}/>} {t(CATALOG_LABELS[item.status])}<ArrowRight size={17}/></span><strong>{item.count}<small>{t("个项目")}</small></strong><div><span>{item.status === 'Funding' ? t('目标总日产出') : t('当前总日产出')}</span><b>{amount(item.daily)} <small>{t("BEM / 天")}</small></b></div><div><span>{item.status === 'Funding' ? t('已募集份额') : item.status === 'Listed' ? t('合计挂牌金额') : t('合计购入金额')}</span><b>{item.status === 'Funding' ? t('{funded} / {total} 份', { funded: item.funded, total: item.count * 100 }) : `${amount(item.price, item.status === 'Active' ? 3 : 2)} BNB`}</b></div></button>)}</div>
      {CATALOG_STATUSES.map(groupStatus => <section className="catalog-group" key={groupStatus}><div className="catalog-group-heading"><h2>{t(CATALOG_LABELS[groupStatus])}<span>{selected.filter(pool => projectGroup(pool) === groupStatus).length}</span></h2><button onClick={() => setStatus(groupStatus)}>{t("查看全部")}<ArrowRight size={15}/></button></div><ProjectRows pools={selected.filter(pool => projectGroup(pool) === groupStatus).slice(0, 3)} onDetails={onDetails} status={groupStatus}/></section>)}
    </> : <section className="catalog-group catalog-single"><ProjectRows pools={selected} onDetails={onDetails} status={status}/></section>}
    <div className="catalog-notes"><Info size={17}/><div><p>{t("当前展示演示项目与演示来源标签，尚未接入 TapeOut 官方及 Firsto 实时市场。")}</p><p>{t("目标募集金额为参考价加 10% 预留，购机余款按份额领取。价格筛选与日产能价统一按当前列示金额计算：募集目标、实际购机成本或整机挂牌价。预览小数仅作展示，不用于构造交易。")}</p><p>{t("日产能价 = 对应整机价格 ÷ 全机估计日产出，单位为 BNB / (BEM / 天)，不代表回本时间。")}</p></div></div>
  </section>;
}
