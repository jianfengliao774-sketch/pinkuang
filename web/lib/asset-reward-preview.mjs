const amount = value => typeof value === 'bigint' && value >= 0n ? value : null;
const poolKey = value => typeof value === 'string' && /^0x[\da-f]{40}$/i.test(value)
  && !/^0x0{40}$/i.test(value) ? value.toLowerCase() : null;
const fields = ['bookedBEM', 'uncollectedBEM', 'totalEstimatedBEM'];
const samePreview = (a, b) => a.kind === b.kind && a.status === b.status
  && fields.every(field => a[field] === b[field]);
const sameReward = (a, b) => a?.status === b?.status
  && fields.every(field => a?.[field] === b?.[field]);
const block = value => typeof value === 'bigint' && value >= 0n ? value
  : Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : null;
const hash = value => typeof value === 'string' && /^0x[\da-f]{64}$/i.test(value) ? value.toLowerCase() : null;

/** A canonical reward read is scoped to one account, deployment and block.
 * A later indexed balance wins. Keep a historical pending estimate only when
 * its booked balance, shares and pool state still agree with that later row. */
export function rewardPreviewForPosition(row, rewardsView, context = {}) {
  if (rewardsView?.canonical !== true || !Array.isArray(rewardsView.items)) return null;
  const key = poolKey(row?.pool), matches = rewardsView.items.filter(item => poolKey(item?.pool) === key);
  if (!key || !matches.length || matches.some(item => !sameReward(item, matches[0]))) return null;
  const reward = matches[0];
  if (reward?.status !== 'ready' || !fields.every(field => amount(reward[field]) !== null)
    || reward.bookedBEM + reward.uncollectedBEM !== reward.totalEstimatedBEM) return null;
  if (!context.source && !context.account && !context.factory) return reward;
  const at = block(context.source?.indexedThrough), rewardAt = block(rewardsView.blockNumber);
  const indexedHash = hash(context.source?.indexedBlockHash), rewardHash = hash(rewardsView.blockHash);
  if (!poolKey(context.account) || poolKey(rewardsView.account) !== poolKey(context.account)
    || !poolKey(context.factory) || poolKey(rewardsView.factory) !== poolKey(context.factory)
    || rewardsView.chainId !== 56n && rewardsView.chainId !== 56
    || at === null || rewardAt === null || !rewardHash
    || matches.some(item => block(item.blockNumber) !== rewardAt || hash(item.blockHash) !== rewardHash
      || amount(item.shares) === null || amount(item.shares) > 100n || block(item.state) === null || block(item.state) > 5n
      || amount(item.shares) !== amount(reward.shares) || block(item.state) !== block(reward.state))
    || at === rewardAt && (indexedHash !== rewardHash
      || amount(row.claimableBEM) !== null && amount(row.claimableBEM) !== reward.bookedBEM)) return null;
  if (at > rewardAt) {
    const booked = amount(row.claimableBEM);
    if (booked === null || booked !== reward.bookedBEM || amount(row.shares) !== amount(reward.shares)
      || block(row.state) !== block(reward.state)) return null;
    return { ...reward, bookedBEM: booked, balanceBlock: at };
  }
  return { ...reward, balanceBlock: rewardAt };
}

function unknown(row) {
  return { pool: row?.pool ?? null, kind: row?.kind, bookedBEM: amount(row?.claimableBEM),
    uncollectedBEM: null, totalEstimatedBEM: null, status: 'unknown' };
}

/** Loaded asset display only. It cannot authorize a claim or a transaction.
 * Canonical single-pool previews replace both old booked and pending values,
 * so a newly harvested balance cannot be counted alongside an older pending
 * snapshot. Portfolio pending is outside this reader's single-pool scope.
 */
export function assetRewardPreview(rows, rewardsView, context = {}) {
  const input = Array.isArray(rows) ? rows : [];
  const rewards = new Map();
  if (rewardsView?.canonical === true && Array.isArray(rewardsView.items)) {
    for (const reward of rewardsView.items) {
      const key = poolKey(reward?.pool);
      if (!key) continue;
      if (!rewards.has(key)) rewards.set(key, reward);
      else if (!sameReward(rewards.get(key), reward)) rewards.set(key, null);
    }
  }
  const items = [], seen = new Map();
  for (const row of input) {
    const key = poolKey(row?.pool);
    let item = unknown(row);
    if (key && row.kind === 'portfolio' && item.bookedBEM !== null) {
      item = { ...item, totalEstimatedBEM: item.bookedBEM, status: 'booked' };
    } else if (key && row.kind === 'single') {
      const reward = rewards.has(key) && rewardPreviewForPosition(row, rewardsView, context);
      if (reward) {
        item = { pool: row.pool, kind: row.kind, status: 'ready',
          ...Object.fromEntries(fields.map(field => [field, reward[field]])) };
      }
    }
    if (key && seen.has(key)) {
      const existing = items[seen.get(key)];
      if (!samePreview(existing, item)) {
        existing.bookedBEM = existing.kind === item.kind && existing.bookedBEM === item.bookedBEM
          ? existing.bookedBEM : null;
        existing.uncollectedBEM = null; existing.totalEstimatedBEM = null; existing.status = 'unknown';
      }
      continue;
    }
    if (key) seen.set(key, items.length);
    items.push(item);
  }
  const total = field => {
    const values = items.map(item => field === 'uncollectedBEM' && item.kind === 'portfolio' ? 0n : item[field]);
    return values.some(value => value === null) ? null : values.reduce((sum, value) => sum + value, 0n);
  };
  return { items, totals: Object.fromEntries(fields.map(field => [field, total(field)])),
    includesPortfolio: input.some(row => row?.kind === 'portfolio') };
}

/** Refresh only the displayed single-pool booked balance before assetOverview
 * filters empty positions. Ownership, action gates and raw inputs stay intact.
 */
export function assetPositionsWithBookedRewards(rows, rewardsView, context = {}) {
  const input = Array.isArray(rows) ? rows : [];
  const preview = assetRewardPreview(input.map(row => ({ ...row, kind: row?.kind ?? 'single' })), rewardsView, context);
  const ready = new Map(preview.items.filter(item => item.status === 'ready')
    .map(item => [poolKey(item.pool), item.bookedBEM]));
  return input.map(row => {
    const key = poolKey(row?.pool);
    return key && ready.has(key) ? { ...row, claimableBEM: ready.get(key) } : row;
  });
}
