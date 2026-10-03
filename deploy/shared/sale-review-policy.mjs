export const DEFAULT_SALE_REVIEW_THRESHOLD_BPS = 10000n;
export const SALE_REVIEW_THRESHOLD_VIEW = 'function saleReviewThresholdBps() view returns(uint16)';

/** Only a deployed business getter can opt this project into the 80% rule. */
export function normalizeSaleReviewThresholdBps(value) {
  return value === 8000n ? 8000n : DEFAULT_SALE_REVIEW_THRESHOLD_BPS;
}

/** A portfolio execution also runs the child's sale rule; both must allow it. */
export function effectiveSaleReviewThresholdBps(...values) {
  return values.reduce((highest, value) => {
    const threshold = normalizeSaleReviewThresholdBps(value);
    return threshold > highest ? threshold : highest;
  }, 8000n);
}

/** An old implementation or an unavailable optional getter keeps the old rule. */
export async function readSaleReviewThresholdBps(readValue) {
  try { return normalizeSaleReviewThresholdBps(await readValue()); }
  catch { return DEFAULT_SALE_REVIEW_THRESHOLD_BPS; }
}

/** Strict integer comparison preserves the boundary without rounding wei. */
export function requiresSaleReview(priceWei, referencePriceWei, thresholdBps = DEFAULT_SALE_REVIEW_THRESHOLD_BPS) {
  if (typeof priceWei !== 'bigint' || priceWei < 0n
    || typeof referencePriceWei !== 'bigint' || referencePriceWei <= 0n)
    throw new TypeError('Sale and reference prices must be exact atomic integers.');
  return priceWei * 10000n < referencePriceWei * normalizeSaleReviewThresholdBps(thresholdBps);
}
