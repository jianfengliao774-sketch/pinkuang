const PREFIX = 'bemine:verified-display:v1:';
const BIGINT = '$bemineBigInt';
const HASH = /^0x[0-9a-f]{64}$/i;
const ADDRESS = /^0x[0-9a-f]{40}$/i;

const encode = (_key, value) => typeof value === 'bigint' ? { [BIGINT]: value.toString() } : value;
const decode = (_key, value) => value && typeof value === 'object' && Object.keys(value).length === 1
  && typeof value[BIGINT] === 'string' && /^(0|[1-9]\d*)$/.test(value[BIGINT])
  ? BigInt(value[BIGINT]) : value;

/** Keep the pre-boot and live page cache scoped to the same route and wallet. */
export function pageDisplayKey(route, account, marketTab = 'shares') {
  const name = route?.route ?? '';
  return JSON.stringify([name, route?.pool?.toLowerCase() || '', account?.toLowerCase() || '',
    name === 'market' ? marketTab : '']);
}

function manifestPrefix(manifest) {
  if (!HASH.test(manifest?.artifactDigest) || !ADDRESS.test(manifest?.factory)) return null;
  return `${PREFIX}${manifest.artifactDigest.toLowerCase()}:${manifest.factory.toLowerCase()}:`;
}

function key(manifest, page) {
  const prefix = manifestPrefix(manifest);
  return prefix && typeof page === 'string' ? `${prefix}${page}` : null;
}

/** A canonical-source mismatch retires every display cache under that deployment. */
export function invalidateDisplaySnapshots(storage, manifest) {
  const prefix = manifestPrefix(manifest);
  if (!storage || !prefix) return 0;
  let removed = 0;
  try {
    for (let index = storage.length - 1; index >= 0; index--) {
      const itemKey = storage.key(index);
      if (itemKey?.startsWith(prefix)) { storage.removeItem(itemKey); removed++; }
    }
  } catch { /* Storage may be unavailable or disallow mutation. */ }
  return removed;
}

function verifiedSource(result, manifest) {
  const source = result?.detail?.source ?? result?.catalog?.source ?? result?.source;
  if (source?.displayOnly === true) return source.chainId === 56
    && source.factory?.toLowerCase() === manifest.factory.toLowerCase()
    && source.market?.toLowerCase() === manifest.shareMarket.toLowerCase()
    && Number.isSafeInteger(source.indexedThrough) && Number.isSafeInteger(source.indexedTimestamp);
  return source?.complete === true && source.unknownReason === null && source.chainId === 56
    && (source.readMode === 'verified_snapshot'
      ? source.stale === true && source.transactionReady === false && typeof source.refreshing === 'boolean'
        && Number.isFinite(Date.parse(source.checkedAt))
      : source.stale !== true && (source.transactionReady !== false || source.displayOnly === true))
    && source.factory?.toLowerCase() === manifest.factory.toLowerCase()
    && source.market?.toLowerCase() === manifest.shareMarket.toLowerCase()
    && HASH.test(source.indexedBlockHash)
    && Number.isSafeInteger(source.indexedThrough) && Number.isSafeInteger(source.indexedTimestamp);
}

/** A verified source does not prove that an older build cached the expected list shape. */
export function displayListSnapshot(result) {
  return result && Array.isArray(result.items) ? result : null;
}

/** Cached values are never current transaction evidence, even when their original read was. */
export function displayOnlySnapshot(result, manifest, verifiedAt, now = Date.now()) {
  if (!verifiedSource(result, manifest) || !Number.isSafeInteger(verifiedAt)) return null;
  if (result?.catalog && !Array.isArray(result.catalog.items)) return null;
  if (result && 'items' in result && !Array.isArray(result.items)) return null;
  const original = result?.detail?.source ?? result?.catalog?.source ?? result?.source;
  if (original?.readMode === 'verified_snapshot'
    && (Date.parse(original.checkedAt) > now + 30_000
      || now - Date.parse(original.checkedAt) > 30 * 60_000)) return null;
  const mark = source => source ? { ...source, readMode: 'verified_snapshot', stale: true,
    transactionReady: false, refreshing: true, cacheOrigin: 'local',
    checkedAt: source.readMode === 'verified_snapshot' ? source.checkedAt : new Date(verifiedAt).toISOString() } : source;
  return {
    ...result,
    ...(result.source ? { source: mark(result.source) } : {}),
    ...(result.catalog?.source ? { catalog: { ...result.catalog, source: mark(result.catalog.source) } } : {}),
    ...(result.detail?.source ? { detail: { ...result.detail, source: mark(result.detail.source) } } : {}),
  };
}

/** A display-only copy. Never use it to prepare, simulate or sign a transaction. */
export function readDisplaySnapshot(storage, manifest, page, { now = Date.now(), maxAgeMs = 60 * 60 * 1000 } = {}) {
  const cacheKey = key(manifest, page);
  if (!storage || !cacheKey) return null;
  try {
    const record = JSON.parse(storage.getItem(cacheKey), decode);
    const source = record?.result?.detail?.source ?? record?.result?.catalog?.source ?? record?.result?.source;
    if (!record || !Number.isSafeInteger(record.savedAt) || record.savedAt > now
      || now - record.savedAt > maxAgeMs || !verifiedSource(record.result, manifest)
      || source?.readMode === 'verified_snapshot' && (Date.parse(source.checkedAt) > now + 30_000
        || now - Date.parse(source.checkedAt) > 30 * 60 * 1000)) return null;
  return displayOnlySnapshot(record.result, manifest, source?.readMode === 'verified_snapshot'
      ? Date.parse(source.checkedAt) : record.savedAt, now);
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

const PERSONAL_POOL_FIELDS = ['shares', 'lockedShares', 'availableShares', 'claimableBEM', 'bnbOwed', 'initialContributedWei'];
const POOL_PARAM_FIELDS = ['circuits', 'circuitId', 'targetRaise', 'priceCap', 'directSeller', 'directPrice', 'fundingDeadline', 'purchaseDeadline'];

// RPC tuples have named getters, but JSON serializes them as unnamed arrays.
function poolDisplayItem(row) {
  if (!row?.params) return { ...row };
  return { ...row, params: Object.fromEntries(POOL_PARAM_FIELDS.map((name, index) =>
    [name, row.params[name] ?? row.params[index]])) };
}

/** Save compact pool details independently of a catalog's size and wallet session. */
export function writePoolDisplaySnapshots(storage, manifest, result, account, options = {}) {
  const section = result?.detail ?? result?.catalog;
  const rows = result?.detail ? [result.detail.item] : result?.catalog?.items;
  if (!Array.isArray(rows) || !verifiedSource(result, manifest)) return 0;
  let written = 0;
  for (const row of rows) {
    if (!ADDRESS.test(row?.pool) || row.trusted !== true) continue;
    const route = { route: 'detail', pool: row.pool };
    const item = poolDisplayItem(row);
    if (account && writeDisplaySnapshot(storage, manifest, pageDisplayKey(route, account),
      { detail: { source: section.source, item } }, options)) written++;
    const publicRow = { ...item };
    for (const field of PERSONAL_POOL_FIELDS) publicRow[field] = null;
    if (writeDisplaySnapshot(storage, manifest, pageDisplayKey(route, null),
      { detail: { source: section.source, item: publicRow } }, options)) written++;
  }
  return written;
}

/** Public fallback never carries another wallet's balances or claimable amounts. */
export function readPoolDisplaySnapshot(storage, manifest, route, account, options = {}) {
  if (route?.route !== 'detail' || !ADDRESS.test(route.pool)) return null;
  const own = readDisplaySnapshot(storage, manifest, pageDisplayKey(route, account), options);
  if (own?.detail?.item?.pool?.toLowerCase() === route.pool.toLowerCase())
    return { ...own, detail: { ...own.detail, item: poolDisplayItem(own.detail.item) } };
  if (!account) return null;
  const shared = readDisplaySnapshot(storage, manifest, pageDisplayKey(route, null), options);
  if (shared?.detail?.item?.pool?.toLowerCase() !== route.pool.toLowerCase()) return null;
  const item = poolDisplayItem(shared.detail.item);
  for (const field of PERSONAL_POOL_FIELDS) item[field] = null;
  return { detail: { source: shared.detail.source, item } };
}
