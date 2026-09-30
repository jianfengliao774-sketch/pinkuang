import { POOL_STATES } from './live-view.mjs';

const fields = ['claimableBem', 'bnbOwed', 'shares', 'projectsHeld', 'minersHeld'];
const exact = value => typeof value === 'bigint' && value >= 0n ? value
  : typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value) ? BigInt(value) : null;
const addressKey = value => typeof value === 'string' && /^0x[\da-f]{40}$/i.test(value)
  ? value.toLowerCase() : null;
const sum = (rows, field) => rows.some(row => row[field] == null) ? null
  : rows.reduce((total, row) => total + row[field], 0n);
const emptyTotals = () => Object.fromEntries(fields.map(field => [field, null]));

function position(row, kind) {
  const trusted = row.trusted !== false;
  const shares = trusted ? exact(row.shares) : null;
  const claimableBEM = trusted ? exact(kind === 'portfolio' ? row.claimableBem : row.claimableBEM) : null;
  // A parent read already includes unsettled refunds and accrued sale proceeds.
  // Adding bnbOwed separately would count its settled historical credit twice.
  const bnbOwed = trusted ? exact(kind === 'portfolio' ? row.withdrawableBnb : row.bnbOwed) : null;
  const state = exact(row.state);
  const status = state != null ? POOL_STATES[Number(state)] || 'Unknown'
    : kind === 'single' && POOL_STATES.includes(row.status) ? row.status : 'Unknown';
  const projectsHeld = shares == null ? null : shares > 0n ? 1n : 0n;
  const minersHeld = shares == null ? null : shares === 0n ? 0n
    : kind === 'portfolio' ? exact(row.activeChildCount)
    : ['Active', 'Listed'].includes(status) ? 1n
    : ['Funding', 'Funded', 'Closed', 'Refunding'].includes(status) ? 0n : null;
  return { ...row, kind, status, shares, claimableBEM, bnbOwed,
    ...(kind === 'portfolio' ? { name: '多矿机项目', tokenId: null, color: 'violet' } : {}),
    claimableBem: claimableBEM, projectsHeld, minersHeld };
}

function uniquePositions(rows) {
  const result = [], seen = new Map();
  for (const row of rows) {
    const key = addressKey(row.pool), previous = key && seen.get(key);
    if (!previous) { result.push(row); if (key) seen.set(key, row); continue; }
    // Pagination may overlap. Conflicting snapshots must not produce a
    // seemingly exact total, and may not silently choose the largest balance.
    for (const field of fields) if (previous[field] !== row[field]) previous[field] = null;
    previous.claimableBEM = previous.claimableBem;
  }
  return result;
}

/** Read-only projection, never an action/ownership proof. Callers supply rows
 * for the currently selected account and retain each source's action gates.
 * `totals` means the complete loaded account scope; all fields are null until
 * both sources are loaded without an error or a remaining cursor.
 * `loadedTotals` is only the explicitly labelled loaded subset, not the account
 * total. Unknown fields stay null. Shares belong to each parent once, and BEM
 * only includes rewards booked into the parent, never its children's balances.
 */
export function assetOverview({ singlePositions = [], portfolioRows = [],
  singleLoaded = false, portfolioLoaded = false,
  singleCursor = null, portfolioCursor = null, singleError = false, portfolioError = false } = {}) {
  const parents = portfolioLoaded ? portfolioRows.map(row => position(row, 'portfolio')) : [];
  const parentAddresses = new Set(parents.map(row => addressKey(row.pool)).filter(Boolean));
  const childAddresses = new Set(parents.flatMap(row => row.children || [])
    .map(row => addressKey(row.pool)).filter(Boolean));
  const singles = singleLoaded ? singlePositions.filter(row => {
    const key = addressKey(row.pool);
    return row.kind !== 'portfolio' && !parentAddresses.has(key) && !childAddresses.has(key);
  }).map(row => position(row, 'single')) : [];
  // Keep funding shares and zero-share historic claims. A failed/unknown value
  // remains visible rather than being interpreted as an empty position.
  const rows = uniquePositions([...singles, ...parents]).filter(row =>
    ['shares', 'claimableBem', 'bnbOwed'].some(field => row[field] == null || row[field] > 0n));
  const loaded = singleLoaded || portfolioLoaded;
  const complete = singleLoaded && portfolioLoaded && !singleError && !portfolioError
    && singleCursor == null && portfolioCursor == null;
  const loadedTotals = loaded ? Object.fromEntries(fields.map(field => [field, sum(rows, field)])) : emptyTotals();
  return { rows, complete, partial: !complete, loaded,
    totals: complete ? { ...loadedTotals } : emptyTotals(), loadedTotals };
}
