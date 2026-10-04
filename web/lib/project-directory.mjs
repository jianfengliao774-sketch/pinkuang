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

const sortDefaults = Object.freeze({ funded: 'desc', price: 'asc', capacity: 'asc', id: 'asc',
  total: 'asc', hash: 'asc', daily: 'asc', members: 'asc' });

/** Sort only atomic integers/counts, never their rounded presentation strings. */
function exactInteger(value) {
  if (typeof value === 'bigint') return value >= 0n ? value : null;
  if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : null;
  if (typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value)) return BigInt(value);
  return null;
}

/** A miner's funding target and a portfolio's budget are the original total amounts. */
export function projectTargetRaiseWei(row) {
  return exactInteger(row.kind === 'portfolio' ? row.budgetWei : row.params?.targetRaise ?? row.targetRaiseWei);
}

export function projectSortState(value = 'funded') {
  const match = typeof value === 'string' ? /^([a-z]+)(?:-(asc|desc))?$/.exec(value) : null;
  const field = match && Object.hasOwn(sortDefaults, match[1]) ? match[1] : 'funded';
  return Object.freeze({ field, direction: match && field === match[1] && match[2] || sortDefaults[field] });
}

export function projectSortValue(field, direction) {
  if (!Object.hasOwn(sortDefaults, field) || !['asc', 'desc'].includes(direction)) return 'funded';
  return sortDefaults[field] === direction ? field : `${field}-${direction}`;
}

export function toggleProjectSort(value, field) {
  const current = projectSortState(value);
  return projectSortValue(field, current.field === field && current.direction === 'asc' ? 'desc' : 'asc');
}

function compareKnown(a, b, direction) {
  if (a == null) return b == null ? 0 : 1;
  if (b == null) return -1;
  const order = a < b ? -1 : a > b ? 1 : 0;
  return direction === 'desc' ? -order : order;
}

/** Public catalog only; personal positions and exit routes keep the original rows. */
export function projectDirectory(singlePools, portfolios, { filter = 'all', query = '', sort = 'funded',
  minerType = 'all', capacityFor = () => null, hashPowerFor = () => null, dailyFor = () => null } = {}) {
  const all = [...singlePools, ...portfolios.map(portfolioDirectoryRow)]
    .filter(row => projectDirectoryCategory(row) !== 'unavailable');
  const search = query.trim().toLowerCase();
  const rows = all.filter(row => projectMatchesStatus(row, filter)
    && (minerType === 'all' || row.kind !== 'portfolio' && row.name?.toLowerCase() === minerType.toLowerCase())
    && `${row.name} ${row.tokenId ?? ''} ${row.pool} ${row.kind === 'portfolio' ? '多矿机 预算 项目 multi-miner portfolio budget project' : ''}`.toLowerCase().includes(search));
  const { field, direction } = projectSortState(sort);
  const values = new Map(rows.map(row => [row, field === 'total' ? projectTargetRaiseWei(row)
    : exactInteger(field === 'price' ? row.unitPriceWei : field === 'capacity' ? capacityFor(row)
      : field === 'id' ? row.tokenId : field === 'hash' ? hashPowerFor(row)
        : field === 'daily' ? dailyFor(row) : field === 'members' ? row.memberCount ?? row.members
          : row.totalSupply ?? row.funded)]));
  rows.sort((a, b) => compareKnown(values.get(a), values.get(b), direction));
  return { all, rows, counts: Object.fromEntries(['Funding', 'Active', 'Listed'].map(status =>
    [status, all.filter(row => projectMatchesStatus(row, status)).length])) };
}
