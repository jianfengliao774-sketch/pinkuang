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

export function fixedPrice(atomic, decimals = 18, places = 5) {
  const value = BigInt(atomic);
  if (value < 0n) throw new Error('金额不能为负数。');
  const source = 10n ** BigInt(decimals), scale = 10n ** BigInt(places);
  const rounded = (value * scale + source / 2n) / source;
  return `${rounded / scale}.${(rounded % scale).toString().padStart(places, '0')}`;
}

export function linkedPrice(value, editedField, dailyAtomic) {
  if (value === '') return '';
  return fixedPrice(linkedPriceWei(value, editedField, dailyAtomic));
}

/** Firsto: ask / gross daily output floors wei; an ask derived from capacity rounds up wei. */
export function linkedPriceWei(value, editedField, dailyAtomic) {
  const daily = BigInt(dailyAtomic);
  if (daily <= 0n) throw new Error('当前24H日产暂不可用。');
  const amount = inputPriceWei(value);
  if (!['sale', 'capacity'].includes(editedField)) throw new Error('无效的价格字段。');
  const atomic = editedField === 'sale' ? amount * BEM / daily : (amount * daily + BEM - 1n) / BEM;
  if (atomic > UINT256) throw new Error('金额超出有效范围。');
  return atomic;
}

/** Exact decimal source for editable inputs; never round a transaction value for display. */
export function exactPrice(atomic) {
  const value = BigInt(atomic);
  if (value < 0n || value > UINT256) throw new Error('金额超出有效范围。');
  const fraction = (value % BNB).toString().padStart(18, '0').replace(/0+$/, '');
  return `${value / BNB}${fraction ? `.${fraction}` : ''}`;
}

/** The last user-edited field determines the exact transaction price, not its linked display. */
export function proposedSalePriceWei({ salePrice, capacityPrice, editedField, dailyAtomic }) {
  if (editedField === 'sale') return inputPriceWei(salePrice);
  if (editedField === 'capacity') {
    if (dailyAtomic === undefined || dailyAtomic === null) throw new Error('当前24H日产暂不可用，请刷新日产或直接修改整机价。');
    return linkedPriceWei(capacityPrice, 'capacity', dailyAtomic);
  }
  throw new Error('无效的价格字段。');
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
