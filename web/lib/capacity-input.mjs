/** Exact, display-facing prices. BNB has 18 decimals; estimated BEM has 8. */
const BNB = 10n ** 18n;
const BEM = 10n ** 8n;
const UINT256 = (1n << 256n) - 1n;

export function inputPriceWei(value) {
  const match = String(value).match(/^(\d+)(?:\.(\d{0,18}))?$/);
  if (!match || match[1].length > 78) throw new Error('请输入有效金额，最多 18 位小数。');
  const atomic = BigInt(match[1]) * BNB + BigInt((match[2] || '').padEnd(18, '0'));
  if (atomic > UINT256) throw new Error('金额超出有效范围。');
  return atomic;
}

export function fixedPrice(atomic, decimals = 18, places = 4) {
  const value = BigInt(atomic);
  if (value < 0n) throw new Error('金额不能为负数。');
  const source = 10n ** BigInt(decimals), scale = 10n ** BigInt(places);
  const rounded = (value * scale + source / 2n) / source;
  return `${rounded / scale}.${(rounded % scale).toString().padStart(places, '0')}`;
}

export function linkedPrice(value, editedField, dailyAtomic) {
  if (value === '') return '';
  const daily = BigInt(dailyAtomic);
  if (daily <= 0n) throw new Error('当前24H日产暂不可用。');
  const amount = inputPriceWei(value);
  if (!['sale', 'capacity'].includes(editedField)) throw new Error('无效的价格字段。');
  // Round directly at the four-decimal display boundary, avoiding Number loss.
  const numerator = editedField === 'sale' ? amount * BEM * 10000n : amount * daily * 10000n;
  const denominator = editedField === 'sale' ? daily * BNB : BEM * BNB;
  const rounded = (numerator + denominator / 2n) / denominator;
  return `${rounded / 10000n}.${(rounded % 10000n).toString().padStart(4, '0')}`;
}

/** A quote may be used only for its bound pool, during its validity window. */
export function validCapacityQuote(quote, pool, now = Date.now()) {
  try {
    if (!quote?.available || !pool || quote.pool?.toLowerCase() !== pool.toLowerCase()
      || !Number.isSafeInteger(quote.observedAt) || quote.observedAt <= 0 || quote.observedAt > now
      || !Number.isSafeInteger(quote.validUntil) || quote.validUntil <= now
      || BigInt(quote.estimated24hAtomic) <= 0n) return null;
    return quote;
  } catch { return null; }
}

/** The verified on-chain acquisition cost is disclosure, never a market quote. */
export function purchaseReference(snapshot) {
  const price = BigInt(snapshot.purchaseCost), observedAt = BigInt(snapshot.timestamp);
  if (price <= 0n || price > UINT256 || observedAt <= 0n || observedAt >= 1n << 64n) {
    throw new Error('购买价格暂不可用，请重新读取链上治理。');
  }
  return { refPriceWei: price.toString(), refAt: observedAt.toString() };
}
