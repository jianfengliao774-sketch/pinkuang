const ADDRESS = /^0x[0-9a-f]{40}$/i;
const HASH = /^0x[0-9a-f]{64}$/i;
export const CAPACITY_FAILURE_COOLDOWN_MS = 5 * 60_000;
export const CAPACITY_MANUAL_MIN_INTERVAL_MS = 10_000;

/** Quotes are optional display data, scoped to the deployment, exact price
 * and supplied NFT identity. A page/read generation is deliberately absent. */
export function capacityRequestKey({ manifest, factory = manifest?.factory, pool, pricePerUnitWei,
  displayOnly = false, params, allowUnownedTarget = false, includeOfficialAsk = false } = {}) {
  if (typeof includeOfficialAsk !== 'boolean' || typeof allowUnownedTarget !== 'boolean'
    || !HASH.test(manifest?.artifactDigest) || !ADDRESS.test(manifest?.factory)
    || !ADDRESS.test(factory) || factory.toLowerCase() !== manifest.factory.toLowerCase()
    || !ADDRESS.test(pool) || typeof pricePerUnitWei !== 'bigint' || pricePerUnitWei < 0n) return null;
  const market = manifest.shareMarket;
  if (market != null && !ADDRESS.test(market)) return null;
  const collection = params?.circuits, tokenId = params?.circuitId?.toString();
  if (params && (!ADDRESS.test(collection) || !/^(0|[1-9]\d*)$/.test(tokenId ?? ''))) return null;
  return JSON.stringify([manifest.artifactDigest.toLowerCase(), factory.toLowerCase(),
    manifest.chainId ?? 56, market?.toLowerCase() ?? '', pool.toLowerCase(), pricePerUnitWei.toString(),
    displayOnly === true, displayOnly === true ? false : allowUnownedTarget === true,
    collection?.toLowerCase() ?? '', tokenId ?? '', includeOfficialAsk]);
}

/** Persisted estimates must prove which optional ask/ownership reads were performed. */
export function capacityAskPolicyMatches(quote, input = {}) {
  if (typeof quote?.includeOfficialAsk !== 'boolean'
    || quote.includeOfficialAsk !== (input.includeOfficialAsk === true)
    || typeof quote.allowUnownedTarget !== 'boolean'
    || (input.displayOnly !== true && quote.allowUnownedTarget !== (input.allowUnownedTarget === true))) return false;
  const pricePresent = typeof quote.minerAskPriceWei === 'bigint' && quote.minerAskPriceWei > 0n;
  if (!['official', 'firsto', null].includes(quote.minerAskSource)
    || (quote.minerAskSource !== null) !== pricePresent) return false;
  if (!quote.includeOfficialAsk) return quote.officialAskStatus === 'not_requested' && quote.minerAskSource !== 'official';
  return ['ready', 'absent', 'unavailable'].includes(quote.officialAskStatus)
    && (quote.officialAskStatus === 'ready') === (quote.minerAskSource === 'official');
}

function reusableSavedQuote(quote, input, now) {
  return quote?.available === true && quote.pool?.toLowerCase() === input.pool.toLowerCase()
    && quote.pricePerUnitWei === input.pricePerUnitWei && quote.forPriceWei === input.pricePerUnitWei.toString()
    && (quote.displayOnly === true) === (input.displayOnly === true)
    && capacityAskPolicyMatches(quote, input)
    && Number.isSafeInteger(quote.validUntil) && quote.validUntil > now
    && (!input.params || quote.collection?.toLowerCase() === input.params.circuits.toLowerCase()
      && quote.tokenId === input.params.circuitId.toString());
}

/** Coalesce in-flight display requests and retain failures across rerenders.
 * Explicit retries can bypass failure cooldown, with a minimum attempt spacing.
 * This cache is never transaction evidence and never invokes a wallet. */
export function createCapacityRequestCache({ now = Date.now, maxEntries = 128 } = {}) {
  const entries = new Map();
  const prune = () => {
    for (const [key, entry] of entries) {
      if (entries.size <= maxEntries) break;
      if (!entry.promise) entries.delete(key);
    }
  };
  const decorate = (result, input, requestKey, completedAt) => {
    const usable = result?.available === true && Number.isSafeInteger(result.validUntil)
      && result.validUntil > completedAt;
    return { ...(result ?? {}), available: usable,
      ...(!usable ? { reason: result?.reason ?? 'unavailable', retryAt: completedAt + CAPACITY_FAILURE_COOLDOWN_MS } : {}),
      forPriceWei: input.pricePerUnitWei.toString(), requestKey, loading: false };
  };
  return {
    peek(input) {
      const entry = entries.get(capacityRequestKey(input));
      return entry && entry.expiresAt > now() ? entry.result ?? null : null;
    },
    read(input, loader, { force = false, savedQuote } = {}) {
      const requestKey = capacityRequestKey(input), attemptedAt = now();
      if (!requestKey || typeof loader !== 'function')
        return Promise.resolve({ available: false, reason: 'invalid_input', loading: false });
      const existing = entries.get(requestKey);
      if (existing?.promise) return existing.promise;
      if (existing?.result && (force ? attemptedAt - existing.attemptedAt < CAPACITY_MANUAL_MIN_INTERVAL_MS
        : existing.expiresAt > attemptedAt)) return Promise.resolve(existing.result);
      if (!force && reusableSavedQuote(savedQuote, input, attemptedAt)) {
        const result = decorate(savedQuote, input, requestKey, attemptedAt);
        entries.set(requestKey, { result, expiresAt: result.validUntil, attemptedAt });
        prune(); return Promise.resolve(result);
      }
      const entry = { attemptedAt };
      entry.promise = Promise.resolve().then(loader).catch(() => ({ available: false, reason: 'unavailable' }))
        .then(reply => {
          const result = decorate(reply, input, requestKey, now());
          entry.result = result; entry.expiresAt = result.available ? result.validUntil : result.retryAt;
          delete entry.promise; prune(); return result;
        });
      entries.set(requestKey, entry); prune();
      return entry.promise;
    },
  };
}
