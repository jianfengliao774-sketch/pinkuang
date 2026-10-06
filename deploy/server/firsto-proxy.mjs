import { isIP } from 'node:net';

const API_ORIGIN = 'https://api-tapeout.firsto.ai';
const OFFICIAL = new Set(['0xb1024b89886b9a34aa4ff5f31c411d708b20a14c', '0x1f5cb4aeaE1807bf60c3b9c0d8adbcc14e91f12c'.toLowerCase()]);
const HEADERS = ['x-tapeout-as-of', 'x-tapeout-generation-id', 'x-tapeout-source-block', 'x-tapeout-source-blocks', 'x-tapeout-source-age-ms', 'x-tapeout-market-refreshed-at', 'x-tapeout-market-delivery-age-ms', 'x-tapeout-market-delivery-status'];
const SORTS = new Set(['price_low', 'daily_capacity_price_low', 'recently_listed', 'token_id_low']);
const positiveWeight = value => typeof value === 'string' && /^[1-9][0-9]{0,38}$/.test(value)
  && BigInt(value) < 2n ** 128n;

/** Filter miner eligibility only; an indexed quote is never transaction/order authorization. */
export function verifiedQuotePage(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Array.isArray(value.rows) || value.rows.length > 50)
    throw new Error('Invalid quote page');
  const rows = value.rows.filter(row => row && typeof row === 'object'
    && typeof row.collection === 'string' && OFFICIAL.has(row.collection.toLowerCase())
    // New official NFTs may await netlist enrichment while Mining has already
    // verified their weight. That unknown classification is not a missing ask.
    && row.category === 'official_mining' && ['official_mining', 'unknown'].includes(row.classification)
    && row.mining?.status === 'verified' && row.mining.optimal !== true
    && positiveWeight(row.mining.verifiedWeight) && row.mining.unverifiedWeight === '0'
    && row.mining.tokenSymbol === 'BEM' && row.mining.tokenDecimals === 8);
  // Keep the source's exact integers, ordering, snapshot and pagination. Never
  // replace a whole-market total with the number of survivors on this one page.
  return { ...value, rows, quoteFilter: { miningStatus: 'verified', pureVerifiedOnly: true,
    excludedOnPage: value.rows.length - rows.length } };
}

export function upstreamUrl(requestPath) {
  const path = requestPath.replace(/^\/firsto-api/, '');
  const url = new URL(path, API_ORIGIN);
  if (url.origin !== API_ORIGIN || url.username || url.password || url.hash) throw new Error('Unsupported quote origin');
  const detail = url.pathname.match(/^\/v1\/circuit\/(0x[0-9a-fA-F]{40})\/(0|[1-9][0-9]{0,77})$/);
  if (detail) {
    // Display-only requests may use a short server cache. Strip this local
    // marker: the upstream endpoint and transaction quote path stay unchanged.
    if (!OFFICIAL.has(detail[1].toLowerCase()) || BigInt(detail[2]) >= 2n ** 256n ||
        (url.search && url.search !== '?display=1')) throw new Error('Unsupported circuit');
    url.search = '';
    return url;
  }
  if (!['/v1/circuits', '/v1/circuit-holders'].includes(url.pathname)) throw new Error('Unsupported quote endpoint');
  const allowed = url.pathname === '/v1/circuits' ? ['category', 'sort', 'page', 'pageSize', 'query', 'processorName', 'miningStatus', 'viewId'] : ['page'];
  const seen = new Set();
  for (const [key, value] of url.searchParams) {
    if (!allowed.includes(key) || seen.has(key) || value.length > 120) throw new Error('Unsupported quote parameter');
    seen.add(key);
    // Forward only one bounded opaque snapshot token; it cannot alter the fixed
    // upstream origin/path. The client also verifies the returned page identity.
    if (key === 'viewId' && (!/^[A-Za-z0-9._:-]{1,120}$/.test(value) || url.searchParams.getAll(key).length !== 1)) throw new Error('Invalid quote snapshot');
    if (['page', 'pageSize'].includes(key) && (!/^[1-9][0-9]*$/.test(value) || Number(value) > (key === 'pageSize' ? 50 : 10000))) throw new Error('Invalid pagination');
    if (key === 'category' && value !== 'official_mining') throw new Error('Only official circuit quotes are supported');
    if (key === 'miningStatus' && value !== 'verified') throw new Error('Only verified miner quotes are supported');
    if (key === 'sort' && !SORTS.has(value)) throw new Error('Unsupported quote sort');
  }
  if (url.pathname === '/v1/circuits') {
    url.searchParams.set('category', 'official_mining');
    // Apply eligibility before upstream pagination/sorting rather than merely
    // hiding unverified miners after downloading a mixed market page.
    url.searchParams.set('miningStatus', 'verified');
  }
  return url;
}

/** Bounded fixed-window per-client limiter; only loopback nginx may identify a public IP. */
export function createQuoteRateLimiter({ limit = 30, windowMs = 60_000, maxClients = 512, now = Date.now } = {}) {
  const clients = new Map();
  return {
    consume(request) {
      const timestamp = now();
      for (const [key, client] of clients) if (client.expiresAt <= timestamp) clients.delete(key);
      const peer = String(request.socket?.remoteAddress ?? 'unknown').toLowerCase().replace(/^::ffff:/, '');
      // Trust a single nginx-supplied client IP only when the TCP peer is the
      // loopback listener. Never trust forwarded chains or a public TCP peer.
      const realIp = request.headers?.['x-real-ip'];
      const key = ['127.0.0.1', '::1'].includes(peer) && typeof realIp === 'string' && isIP(realIp)
        ? realIp.toLowerCase() : peer;
      let client = clients.get(key);
      if (!client) {
        if (clients.size >= maxClients) return { allowed: false, retryAfter: Math.ceil(windowMs / 1000) };
        client = { count: 0, expiresAt: timestamp + windowMs }; clients.set(key, client);
      }
      client.count += 1;
      return { allowed: client.count <= limit, retryAfter: Math.max(1, Math.ceil((client.expiresAt - timestamp) / 1000)) };
    },
    get size() { return clients.size; },
  };
}
const defaultLimiter = createQuoteRateLimiter();
export function createQuoteCache({ ttlMs = 3000, maxEntries = 128, now = Date.now } = {}) {
  const entries = new Map();
  return {
    get(key) {
      const entry = entries.get(key);
      if (!entry) return null;
      if (entry.until <= now()) { entries.delete(key); return null; }
      entries.delete(key); entries.set(key, entry);
      return entry.value;
    },
    set(key, value) {
      entries.delete(key); entries.set(key, { until: now() + ttlMs, value });
      while (entries.size > maxEntries) entries.delete(entries.keys().next().value);
    },
  };
}
const defaultQuoteCache = createQuoteCache();
const defaultDetailDisplayCache = createQuoteCache({ ttlMs: 30_000, maxEntries: 512 });
const pendingDisplayByCache = new WeakMap();
let activeRequests = 0;
const MAX_ACTIVE_REQUESTS = 8;

/** Read-only, fixed-origin proxy. Never forwards cookies, credentials, signatures or client headers. */
export async function proxyFirsto(req, res, { limiter = defaultLimiter, fetcher = fetch, cache } = {}) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (req.method !== 'GET') { res.statusCode = 405; res.setHeader('Allow', 'GET'); res.end(JSON.stringify({error: '报价接口仅允许只读查询。'})); return; }
  let url;
  try { url = upstreamUrl(req.url); }
  catch { res.statusCode = 400; res.end(JSON.stringify({error: '不支持的报价查询。'})); return; }
  // Exact detail caching is explicitly display-only. Procurement and signed
  // order checks never send this marker and always fetch the current detail.
  const displayOnly = /^\/firsto-api\/v1\/circuit\//.test(req.url) && req.url.endsWith('?display=1');
  const quoteCache = cache === undefined ? (fetcher === fetch
    ? displayOnly ? defaultDetailDisplayCache : defaultQuoteCache : null) : cache;
  const cacheKey = displayOnly || url.pathname === '/v1/circuits' || url.pathname === '/v1/circuit-holders'
    ? url.href : null;
  const cached = cacheKey && quoteCache?.get(cacheKey);
  if (cached) {
    for (const [name, value] of Object.entries(cached.headers)) res.setHeader(name, value);
    res.setHeader('X-Firsto-Cache', 'HIT');
    res.statusCode = 200; res.end(cached.body); return;
  }
  let pendingDisplay;
  if (displayOnly && quoteCache) {
    pendingDisplay = pendingDisplayByCache.get(quoteCache);
    if (!pendingDisplay) { pendingDisplay = new Map(); pendingDisplayByCache.set(quoteCache, pendingDisplay); }
    const inFlight = pendingDisplay.get(cacheKey);
    if (inFlight) {
      await inFlight;
      const shared = quoteCache.get(cacheKey);
      if (shared) {
        for (const [name, value] of Object.entries(shared.headers)) res.setHeader(name, value);
        res.setHeader('X-Firsto-Cache', 'HIT');
        res.statusCode = 200; res.end(shared.body); return;
      }
      res.statusCode = 502; res.end(JSON.stringify({ error: 'Firsto 报价暂不可用，请稍后重试。' })); return;
    }
  }
  const quota = limiter.consume(req);
  if (!quota.allowed || activeRequests >= MAX_ACTIVE_REQUESTS) {
    res.statusCode = 429; res.setHeader('Retry-After', String(quota.allowed ? 2 : quota.retryAfter));
    res.end(JSON.stringify({ error: '报价查询过于频繁，请稍后重试。' })); return;
  }
  let finishDisplay;
  if (pendingDisplay) pendingDisplay.set(cacheKey, new Promise(resolve => { finishDisplay = resolve; }));
  activeRequests += 1;
  try {
    const upstream = await fetcher(url, { method: 'GET', headers: {Accept: 'application/json'}, redirect: 'error', signal: AbortSignal.timeout(12_000) });
    if (!upstream.ok) { res.statusCode = 502; res.end(JSON.stringify({error: `Firsto 报价暂不可用（${upstream.status}）。`})); return; }
    if (!upstream.headers.get('content-type')?.includes('application/json')) throw new Error('Invalid content type');
    const reader = upstream.body.getReader();
    let size = 0; const chunks = [];
    while (true) { const {done, value} = await reader.read(); if (done) break; size += value.length; if (size > 2_000_000) { await reader.cancel(); throw new Error('Quote response too large'); } chunks.push(value); }
    let body = Buffer.concat(chunks);
    const value = JSON.parse(body.toString('utf8'));
    if (url.pathname === '/v1/circuits') body = Buffer.from(JSON.stringify(verifiedQuotePage(value)));
    const savedHeaders = {};
    for (const header of HEADERS) { const value = upstream.headers.get(header); if (value) savedHeaders[header] = value; }
    savedHeaders['X-Firsto-Fetched-At'] = new Date().toISOString();
    if (upstream.headers.get('date')) savedHeaders['X-Firsto-Response-Date'] = upstream.headers.get('date');
    for (const [name, value] of Object.entries(savedHeaders)) res.setHeader(name, value);
    if (cacheKey) quoteCache?.set(cacheKey, { body, headers: savedHeaders });
    res.statusCode = 200; res.end(body);
  } catch { res.statusCode = 502; res.end(JSON.stringify({error: '无法获取 Firsto 实时报价，请稍后重试或打开来源页面。'})); }
  finally {
    activeRequests -= 1;
    if (finishDisplay) { pendingDisplay.delete(cacheKey); finishDisplay(); }
  }
}
