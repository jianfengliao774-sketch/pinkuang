import { POOL_STATES, fundingTargetStatus } from './live-view.mjs';

/** Display projection only. Detail routes must obtain their own current action proof. */
export function portfolioDirectoryRow(row) {
  return { ...row, kind: 'portfolio', status: POOL_STATES[Number(row.state)] || 'Unknown',
    name: '多矿机项目', tokenId: null, color: 'violet',
    funded: row.totalSupply == null ? null : Number(row.totalSupply),
    remaining: row.totalSupply == null ? null : 100 - Number(row.totalSupply),
    members: row.memberCount == null ? null : Number(row.memberCount),
    purchaseCost: row.spentWei };
}

export function projectDirectoryCategory(row) {
  return fundingTargetStatus(row) === 'unavailable' ? 'unavailable' : row.status;
}

export function projectMatchesStatus(row, filter) {
  if (filter === 'all') return true;
  const category = projectDirectoryCategory(row);
  return category === filter || filter === 'Funding' && category === 'Funded';
}

function compareKnown(a, b) {
  if (a == null) return b == null ? 0 : 1;
  if (b == null) return -1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Public catalog only; personal positions and exit routes keep the original rows. */
export function projectDirectory(singlePools, portfolios, { filter = 'all', query = '', sort = 'funded', capacityFor = () => null } = {}) {
  const all = [...singlePools, ...portfolios.map(portfolioDirectoryRow)]
    .filter(row => projectDirectoryCategory(row) !== 'unavailable');
  const search = query.trim().toLowerCase();
  const rows = all.filter(row => projectMatchesStatus(row, filter)
    && `${row.name} ${row.tokenId ?? ''} ${row.pool} ${row.kind === 'portfolio' ? '多矿机 预算 项目 multi-miner portfolio budget project' : ''}`.toLowerCase().includes(search));
  rows.sort((a, b) => {
    if (sort === 'price') return compareKnown(a.unitPriceWei, b.unitPriceWei);
    if (sort === 'capacity') return compareKnown(capacityFor(a), capacityFor(b));
    if (sort === 'id') return compareKnown(a.tokenId != null && /^\d+$/.test(a.tokenId) ? BigInt(a.tokenId) : null,
      b.tokenId != null && /^\d+$/.test(b.tokenId) ? BigInt(b.tokenId) : null);
    return compareKnown(a.funded == null ? null : -a.funded, b.funded == null ? null : -b.funded);
  });
  return { all, rows, counts: Object.fromEntries(['Funding', 'Active', 'Listed'].map(status =>
    [status, all.filter(row => projectMatchesStatus(row, status)).length])) };
}
