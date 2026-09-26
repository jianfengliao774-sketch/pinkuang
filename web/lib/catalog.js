import { purchaseTotal } from './economics.js';
// Presentation metadata only: these are demo source labels, not imported marketplace listings.
const demoSources = {
  '16210': ['official', 'firsto'], '8204': ['firsto'], '15832': ['official', 'firsto'],
  '16928': ['official', 'firsto'], '8316': ['firsto'], '17006': ['official'],
};
export const SOURCES = { official: 'TapeOut 官方', firsto: 'Firsto' };
export const CATALOG_STATUSES = ['Funding', 'Active', 'Listed'];
export const CATALOG_LABELS = { Funding: '募集中', Funded: '待购机', Active: '挖矿中', Listed: '整机出售中' };
export const projectGroup = pool => pool.status === 'Funded' ? 'Funding' : pool.status;
export const DEFAULT_FILTERS = { source: 'all', series: 'all', dailyMin: '', dailyMax: '', priceMin: '', priceMax: '' };
export const SORT_OPTIONS = [
  ['funded-desc', '目前募集份额最多'], ['unit-asc', '日产能价从低到高'],
  ['id-asc', '编号从低到高'], ['price-asc', '整机价格从低到高'], ['price-desc', '整机价格从高到低'], ['daily-desc', '全机日产出从高到低'],
];
export function marketplaceAssetKey({ chainId, contract, tokenId }) {
  if (!chainId || !/^0x[a-fA-F0-9]{40}$/.test(contract || '') || !/^\d+$/.test(String(tokenId))) return null;
  return `${String(chainId)}:${contract.toLowerCase()}:${BigInt(tokenId).toString()}`;
}
export function projectPrice(pool) {
  const raw = pool.status === 'Listed' ? (pool.askingPrice ?? (pool.id === '15832' ? 5.8 : pool.price)) : pool.price;
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0) return null;
  if (pool.status === 'Active') return pool.purchaseCost ?? raw;
  return projectGroup(pool) === 'Funding' ? purchaseTotal(pool) : raw;
}
export function dailyUnitPrice(pool) {
  const price = projectPrice(pool);
  return price !== null && Number.isFinite(pool.daily) && pool.daily > 0 ? price / pool.daily : null;
}
export function projectSources(pool) {
  return demoSources[pool.id] || [];
}
const bound = v => v === '' || v == null || !Number.isFinite(Number(v)) ? null : Number(v);
function inRange(value, min, max) {
  const lo = bound(min), hi = bound(max);
  if (lo === null && hi === null) return true;
  return value !== null && Number.isFinite(value) && (lo === null || value >= lo) && (hi === null || value <= hi);
}
export function selectProjects(pools, { status = 'all', query = '', filters = DEFAULT_FILTERS, sort = 'funded-desc' } = {}) {
  const search = query.trim().toLowerCase().replace(/^#/, '');
  const selected = pools.filter(pool => CATALOG_STATUSES.includes(projectGroup(pool))
    && (status === 'all' || projectGroup(pool) === status)
    && (!search || `${pool.id} ${pool.name} ${pool.series}`.toLowerCase().includes(search))
    && (filters.source === 'all' || projectSources(pool).includes(filters.source))
    && (filters.series === 'all' || pool.series === filters.series)
    && inRange(pool.daily, filters.dailyMin, filters.dailyMax)
    && inRange(projectPrice(pool), filters.priceMin, filters.priceMax));
  const [field, direction] = sort.split('-');
  const metric = pool => field === 'price' ? projectPrice(pool) : field === 'unit' ? dailyUnitPrice(pool)
    : field === 'daily' ? (Number.isFinite(pool.daily) && pool.daily > 0 ? pool.daily : null)
    : field === 'funded' ? pool.funded : Number(pool.id);
  return [...selected].sort((a, b) => {
    const av = metric(a), bv = metric(b);
    if (av == null && bv != null) return 1;
    if (av != null && bv == null) return -1;
    if (av == null && bv == null) return Number(a.id) - Number(b.id);
    return (av - bv) * (direction === 'desc' ? -1 : 1) || Number(a.id) - Number(b.id);
  });
}
export function summarizeProjects(pools) {
  return CATALOG_STATUSES.map(status => {
    const group = pools.filter(pool => projectGroup(pool) === status);
    return { status, count: group.length, daily: group.reduce((sum, pool) => sum + (Number.isFinite(pool.daily) && pool.daily > 0 ? pool.daily : 0), 0),
      price: group.reduce((sum, pool) => sum + (projectPrice(pool) || 0), 0),
      funded: group.reduce((sum, pool) => sum + pool.funded, 0) };
  });
}
