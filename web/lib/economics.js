// Preview arithmetic only. Never use Number-based amounts to construct a transaction.
// The reserve is refundable funding, not a buyer fee or permission to exceed the purchase cap.
export const purchaseTotal = pool => pool.price * (1 + (pool.extraBps ?? 1000) / 10000);
export const subscriptionPrice = pool => purchaseTotal(pool) / 100;
export const investorYield = (pool, shares) => pool.daily * shares / 100 * .99;
export const demoAvailableShares = pool => Math.max(0, Math.min(pool.shares - (pool.lockedShares ?? 0), pool.availableShares ?? pool.shares));
export const demoShareTradingAllowed = pool => pool.status === 'Active' && pool.shareTradingAllowed === true;
