/** A user's own verified holdings supply the listing target; no operator role. */
export function shareListingView(pool) {
  const valid = [pool?.shares, pool?.lockedShares, pool?.availableShares].every(value =>
    typeof value === 'bigint' && value >= 0n && value <= 100n)
    && pool.lockedShares <= pool.shares && pool.availableShares === pool.shares - pool.lockedShares;
  const allowed = !!(valid && pool.status === 'Active' && pool.shareTradingAllowed === true && pool.availableShares > 0n);
  return { allowed, shares: valid ? pool.shares : null, locked: valid ? pool.lockedShares : null,
    available: valid ? pool.availableShares : null, defaultQuantity: allowed ? pool.availableShares.toString() : '1' };
}
