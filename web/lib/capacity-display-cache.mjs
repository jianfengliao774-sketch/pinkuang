const PREFIX = 'bemine:capacity-display:v2:';
const ADDRESS = /^0x[0-9a-f]{40}$/i;
const HASH = /^0x[0-9a-f]{64}$/i;
const BIGINT = '$bemineBigInt';
const encode = (_key, value) => typeof value === 'bigint' ? { [BIGINT]: value.toString() } : value;
const decode = (_key, value) => value && typeof value === 'object' && Object.keys(value).length === 1
  && typeof value[BIGINT] === 'string' && /^(0|[1-9]\d*)$/.test(value[BIGINT])
  ? BigInt(value[BIGINT]) : value;

function key(manifest, pool) {
  if (!HASH.test(manifest?.artifactDigest) || !ADDRESS.test(manifest?.factory) || !ADDRESS.test(pool)) return null;
  return `${PREFIX}${manifest.artifactDigest.toLowerCase()}:${manifest.factory.toLowerCase()}:${pool.toLowerCase()}`;
}

function usable(quote, pool, priceWei, now) {
  return quote?.available === true && ADDRESS.test(quote.pool) && quote.pool.toLowerCase() === pool.toLowerCase()
    && ADDRESS.test(quote.collection) && typeof quote.tokenId === 'string' && /^(0|[1-9]\d*)$/.test(quote.tokenId)
    && typeof quote.pricePerUnitWei === 'bigint' && quote.pricePerUnitWei === priceWei
    && quote.forPriceWei === priceWei.toString()
    && typeof quote.estimated24hAtomic === 'bigint' && quote.estimated24hAtomic > 0n
    && (quote.minerAskPriceWei === null || typeof quote.minerAskPriceWei === 'bigint'
      && quote.minerAskPriceWei > 0n)
    && (quote.marketReferencePriceWei === null || typeof quote.marketReferencePriceWei === 'bigint'
      && quote.marketReferencePriceWei > 0n)
    && (quote.displayOnly === true || typeof quote.sourceBlock === 'bigint' && typeof quote.miningSourceBlock === 'bigint'
      && quote.sourceBlock >= quote.miningSourceBlock)
    && Number.isSafeInteger(quote.observedAt) && quote.observedAt <= now + 30_000
    && Number.isSafeInteger(quote.validUntil) && quote.validUntil > now
    && quote.validUntil - quote.observedAt === 300_000;
}

/** Previously verified display only; all transaction paths re-read live data. */
export function readCapacityDisplay(storage, manifest, pool, priceWei, { now = Date.now() } = {}) {
  const cacheKey = key(manifest, pool);
  if (!storage || !cacheKey || typeof priceWei !== 'bigint') return null;
  try {
    const saved = JSON.parse(storage.getItem(cacheKey), decode);
    if (!Number.isSafeInteger(saved?.savedAt) || saved.savedAt > now || now - saved.savedAt > 300_000
      || !usable(saved.quote, pool, priceWei, now)) return null;
    return { ...saved.quote, cached: true };
  } catch { return null; }
}

export function writeCapacityDisplay(storage, manifest, quote, { now = Date.now() } = {}) {
  const cacheKey = key(manifest, quote?.pool);
  if (!storage || !cacheKey || !usable(quote, quote.pool, quote.pricePerUnitWei, now)) return false;
  try {
    const value = JSON.stringify({ savedAt: now, quote: { ...quote, cached: undefined } }, encode);
    if (value.length > 4000) return false;
    storage.setItem(cacheKey, value);
    return true;
  } catch { return false; }
}
