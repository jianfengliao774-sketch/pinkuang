const PREFIX = 'bemine:verified-display:v1:';
const BIGINT = '$bemineBigInt';
const HASH = /^0x[0-9a-f]{64}$/i;
const ADDRESS = /^0x[0-9a-f]{40}$/i;

const encode = (_key, value) => typeof value === 'bigint' ? { [BIGINT]: value.toString() } : value;
const decode = (_key, value) => value && typeof value === 'object' && Object.keys(value).length === 1
  && typeof value[BIGINT] === 'string' && /^(0|[1-9]\d*)$/.test(value[BIGINT])
  ? BigInt(value[BIGINT]) : value;

function key(manifest, page) {
  if (!HASH.test(manifest?.artifactDigest) || !ADDRESS.test(manifest?.factory) || typeof page !== 'string') return null;
  return `${PREFIX}${manifest.artifactDigest.toLowerCase()}:${manifest.factory.toLowerCase()}:${page}`;
}

function verifiedSource(result, manifest) {
  const source = result?.detail?.source ?? result?.catalog?.source ?? result?.source;
  return source?.complete === true && source.unknownReason === null && source.chainId === 56
    && source.factory?.toLowerCase() === manifest.factory.toLowerCase()
    && source.market?.toLowerCase() === manifest.shareMarket.toLowerCase()
    && HASH.test(source.indexedBlockHash)
    && Number.isSafeInteger(source.indexedThrough) && Number.isSafeInteger(source.indexedTimestamp);
}

/** A display-only copy. Never use it to prepare, simulate or sign a transaction. */
export function readDisplaySnapshot(storage, manifest, page, { now = Date.now(), maxAgeMs = 60 * 60 * 1000 } = {}) {
  const cacheKey = key(manifest, page);
  if (!storage || !cacheKey) return null;
  try {
    const record = JSON.parse(storage.getItem(cacheKey), decode);
    if (!record || !Number.isSafeInteger(record.savedAt) || record.savedAt > now
      || now - record.savedAt > maxAgeMs || !verifiedSource(record.result, manifest)) return null;
    return record.result;
  } catch { return null; }
}

export function writeDisplaySnapshot(storage, manifest, page, result, { now = Date.now() } = {}) {
  const cacheKey = key(manifest, page);
  if (!storage || !cacheKey || !verifiedSource(result, manifest)) return false;
  try {
    const value = JSON.stringify({ savedAt: now, result }, encode);
    if (value.length > 400_000) return false;
    storage.setItem(cacheKey, value);
    return true;
  } catch { return false; }
}
