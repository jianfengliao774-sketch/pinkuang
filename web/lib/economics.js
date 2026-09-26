// Shared demo accounting: external marketplace purchases include the 1% buyer fee.
export const purchaseTotal = pool => pool.price * 1.01;
export const subscriptionPrice = pool => purchaseTotal(pool) / 100;
export const investorYield = (pool, shares) => pool.daily * shares / 100 * .99;
