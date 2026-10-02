import { FRESH_RUNTIME } from '../../shared/fresh-runtime-identity.mjs';
import { createHash } from 'node:crypto';

const officialCollections = new Set([
  '0xb1024b89886b9a34aa4ff5f31c411d708b20a14c',
  '0x1f5cb4aeae1807bf60c3b9c0d8adbcc14e91f12c',
]);
const uint = value => (typeof value !== 'number' || Number.isSafeInteger(value))
  && /^(0|[1-9]\d*)$/.test(String(value ?? '')) && BigInt(value) < 2n ** 256n
  ? BigInt(value) : null;
const sourceUint = value => typeof value === 'string' ? uint(value) : null;
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** The product proxy already shares and caches exact display-only Firsto details. */
export function overviewQuoteLoader({ fetcher = fetch, baseUrl = `http://127.0.0.1:${FRESH_RUNTIME.apiPort}/firsto-api` } = {}) {
  const base = new URL(baseUrl);
  if (base.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(base.hostname)
    || base.pathname !== '/firsto-api' || base.search || base.hash || base.username || base.password)
    throw new Error('Overview quotes require the local product display proxy.');
  return async (collection, tokenId, signal) => {
    if (!officialCollections.has(collection) || uint(tokenId) === null) throw new Error('Unsupported mining quote.');
    const response = await fetcher(`${base.href}/v1/circuit/${collection}/${tokenId}?display=1`, {
      method: 'GET', headers: { Accept: 'application/json' }, redirect: 'error',
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(12_000)]) : AbortSignal.timeout(12_000),
    });
    if (!response.ok || !response.headers.get('content-type')?.includes('application/json'))
      throw new Error('Mining display quote unavailable.');
    const reader = response.body.getReader(), chunks = []; let size = 0;
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.length; if (size > 2_000_000) { await reader.cancel(); throw new Error('Mining display quote too large.'); }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  };
}

/** Current owned miners come from the existing public Lens rows, including portfolio children. */
export class MiningOverviewStats {
  constructor({ quoteLoader = null, now = Date.now, quoteTtlMs = 120_000, staleQuoteMs = 10 * 60_000, captureTimeoutMs = 12_000 } = {}) {
    this.quoteLoader = quoteLoader; this.now = now; this.quoteTtlMs = quoteTtlMs; this.staleQuoteMs = staleQuoteMs;
    this.captureTimeoutMs=captureTimeoutMs;
    this.quotes = new Map(); this.controller = new AbortController(); this.stopped = false;
  }
  restore(entries) {
    if (!Array.isArray(entries) || entries.length > 500) return;
    for (const entry of entries) {
      if (!Array.isArray(entry) || entry.length !== 2) continue;
      const [key,value]=entry,parts=typeof key==='string'?key.split(':'):[];
      if (parts.length!==2 || !officialCollections.has(parts[0]) || sourceUint(parts[1])===null
        || !value || (value.atomic!==null && typeof value.atomic!=='bigint') || value.atomic<0n || value.atomic>=2n**256n
        || !Number.isSafeInteger(value.observedAt) || value.observedAt<0 || value.observedAt>this.now() || this.now()-value.observedAt>this.staleQuoteMs
        || !Number.isSafeInteger(value.nextReadAt) || value.nextReadAt>this.now()+this.quoteTtlMs) continue;
      const lastReadAt=Number.isSafeInteger(value.lastReadAt)&&value.lastReadAt>=0&&value.lastReadAt<=this.now()?value.lastReadAt:value.observedAt;
      this.quotes.set(key,{atomic:value.atomic,observedAt:value.observedAt,nextReadAt:value.nextReadAt,lastReadAt,failed:value.failed===true});
    }
  }
  persistedQuotes() { return [...this.quotes.entries()]; }
  async quote(collection, tokenId, signal = this.controller.signal) {
    const key = `${collection}:${tokenId}`, before = this.quotes.get(key), time = this.now();
    if (before?.nextReadAt > time) return before;
    if (!this.quoteLoader || !officialCollections.has(collection)) return null;
    try {
      const detail = await this.quoteLoader(collection, tokenId, signal), asset = detail?.asset, mining = asset?.mining;
      const atomic = sourceUint(mining?.estimated24hAtomic), sourceTokenId = sourceUint(asset?.tokenId);
      // Validate the returned identity and units without any additional RPC or proof requests.
      const valid = asset?.collection?.toLowerCase() === collection && sourceTokenId?.toString() === tokenId
        && mining?.status === 'verified' && mining.tokenSymbol === 'BEM' && mining.tokenDecimals === 8 && atomic !== null;
      const observedAt = this.now();
      const entry = { atomic: valid ? atomic : null, observedAt, lastReadAt:observedAt, nextReadAt: observedAt + this.quoteTtlMs };
      this.quotes.set(key, entry); return entry;
    } catch {
      if (this.stopped) return null;
      const entry = { atomic: before?.atomic ?? null, observedAt: before?.observedAt ?? time,lastReadAt:this.now(),
        nextReadAt: time + 15_000, failed: true };
      this.quotes.set(key, entry); return entry;
    }
  }
  describe(rows) {
    let complete = true;
    const miners = new Map();
    for (const row of rows) {
      const state = uint(row.state);
      if (!row.trusted || state === null || state > 5n) { complete = false; continue; }
      if (state !== 2n && state !== 3n) continue;
      const collection = row.params?.circuits?.toLowerCase(), tokenId = uint(row.params?.circuitId);
      if (!/^0x[\da-f]{40}$/.test(collection ?? '') || /^0x0{40}$/.test(collection) || tokenId === null) {
        complete = false; continue;
      }
      miners.set(`${collection}:${tokenId}`, { collection, tokenId: tokenId.toString() });
    }
    return {complete,miners};
  }
  async capture(rows) {
    const {miners}=this.describe(rows);
    // Do not keep removed/sold miner estimates or accumulate quote entries indefinitely.
    for (const key of this.quotes.keys()) if (!miners.has(key)) this.quotes.delete(key);
    // Rotate slow or failing miners behind untouched ones so a bounded pass cannot starve healthy quotes.
    const list=[...miners.values()].filter(miner=>(this.quotes.get(`${miner.collection}:${miner.tokenId}`)?.nextReadAt??0)<=this.now())
      .sort((a,b)=>(this.quotes.get(`${a.collection}:${a.tokenId}`)?.lastReadAt??-1)
        -(this.quotes.get(`${b.collection}:${b.tokenId}`)?.lastReadAt??-1));
    let next = 0;
    const signal=AbortSignal.any([this.controller.signal,AbortSignal.timeout(this.captureTimeoutMs)]);
    await Promise.all(Array.from({ length: Math.min(4, list.length) }, async () => {
      while (!signal.aborted && next < list.length) {
        const miner = list[next++]; await this.quote(miner.collection, miner.tokenId, signal);
      }
    }));
    return this.snapshot(rows);
  }
  snapshot(rows) {
    const {complete,miners}=this.describe(rows),list=[...miners.values()];
    let total = 0n, covered = 0, stale = 0, oldest = null;
    for (const miner of list) {
      const quote=this.quotes.get(`${miner.collection}:${miner.tokenId}`);
      if (!quote || quote.atomic === null || this.now() - quote.observedAt > this.staleQuoteMs) continue;
      total += quote.atomic; covered++; if (quote.failed) stale++;
      oldest = oldest === null ? quote.observedAt : Math.min(oldest, quote.observedAt);
    }
    const dailyComplete = complete && covered === list.length;
    return {
      currentlyActivePoolCount: complete ? String(list.length) : null,
      estimatedDailyBemAtomic: dailyComplete ? total.toString() : null,
      miningOverview: { basis: 'gross_estimated_output', minerCountComplete: complete,
        dailyOutputComplete: dailyComplete, minerIdentityDigest: complete ? digest([...miners.keys()].sort()) : null,
        quotedMinerCount: String(covered), missingMinerCount: String(list.length - covered), staleQuoteMinerCount: String(stale),
        observedAt: oldest === null ? null : new Date(oldest).toISOString() },
    };
  }
  close() { this.stopped = true; this.controller.abort(); }
}
