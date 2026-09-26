const API_ORIGIN = 'https://api-tapeout.firsto.ai';
const OFFICIAL = new Set(['0xb1024b89886b9a34aa4ff5f31c411d708b20a14c', '0x1f5cb4aeaE1807bf60c3b9c0d8adbcc14e91f12c'.toLowerCase()]);
const HEADERS = ['x-tapeout-as-of', 'x-tapeout-generation-id', 'x-tapeout-source-block', 'x-tapeout-source-blocks', 'x-tapeout-source-age-ms', 'x-tapeout-market-refreshed-at', 'x-tapeout-market-delivery-age-ms', 'x-tapeout-market-delivery-status'];

export function upstreamUrl(requestPath) {
  const path = requestPath.replace(/^\/firsto-api/, '');
  const url = new URL(path, API_ORIGIN);
  if (url.origin !== API_ORIGIN || url.username || url.password) throw new Error('Unsupported quote origin');
  const detail = url.pathname.match(/^\/v1\/circuit\/(0x[0-9a-fA-F]{40})\/(0|[1-9][0-9]{0,77})$/);
  if (detail) {
    if (!OFFICIAL.has(detail[1].toLowerCase()) || BigInt(detail[2]) >= 2n ** 256n || url.search) throw new Error('Unsupported circuit');
    return url;
  }
  if (!['/v1/circuits', '/v1/circuit-holders'].includes(url.pathname)) throw new Error('Unsupported quote endpoint');
  const allowed = url.pathname === '/v1/circuits' ? ['category', 'sort', 'page', 'pageSize', 'query', 'processorName', 'miningStatus'] : ['page'];
  for (const [key, value] of url.searchParams) {
    if (!allowed.includes(key) || value.length > 120) throw new Error('Unsupported quote parameter');
    if (['page', 'pageSize'].includes(key) && (!/^[1-9][0-9]*$/.test(value) || Number(value) > (key === 'pageSize' ? 50 : 10000))) throw new Error('Invalid pagination');
    if (key === 'category' && value !== 'official_mining') throw new Error('Only official circuit quotes are supported');
  }
  if (url.pathname === '/v1/circuits') url.searchParams.set('category', 'official_mining');
  return url;
}

/** Bounded fixed-window per-peer limiter; only the TCP peer is authoritative. */
export function createQuoteRateLimiter({ limit = 30, windowMs = 60_000, maxClients = 512, now = Date.now } = {}) {
  const clients = new Map();
  return {
    consume(request) {
      const timestamp = now();
      for (const [key, client] of clients) if (client.expiresAt <= timestamp) clients.delete(key);
      // X-Forwarded-For is deliberately ignored; a reverse proxy shares its own quota.
      const peer = String(request.socket?.remoteAddress ?? 'unknown').toLowerCase().replace(/^::ffff:/, '');
      let client = clients.get(peer);
      if (!client) {
        if (clients.size >= maxClients) return { allowed: false, retryAfter: Math.ceil(windowMs / 1000) };
        client = { count: 0, expiresAt: timestamp + windowMs }; clients.set(peer, client);
      }
      client.count += 1;
      return { allowed: client.count <= limit, retryAfter: Math.max(1, Math.ceil((client.expiresAt - timestamp) / 1000)) };
    },
    get size() { return clients.size; },
  };
}
const defaultLimiter = createQuoteRateLimiter();
let activeRequests = 0;
const MAX_ACTIVE_REQUESTS = 8;

/** Read-only, fixed-origin proxy. Never forwards cookies, credentials, signatures or client headers. */
export async function proxyFirsto(req, res, { limiter = defaultLimiter, fetcher = fetch } = {}) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (req.method !== 'GET') { res.statusCode = 405; res.setHeader('Allow', 'GET'); res.end(JSON.stringify({error: '报价接口仅允许只读查询。'})); return; }
  let url;
  try { url = upstreamUrl(req.url); }
  catch { res.statusCode = 400; res.end(JSON.stringify({error: '不支持的报价查询。'})); return; }
  const quota = limiter.consume(req);
  if (!quota.allowed || activeRequests >= MAX_ACTIVE_REQUESTS) {
    res.statusCode = 429; res.setHeader('Retry-After', String(quota.allowed ? 2 : quota.retryAfter));
    res.end(JSON.stringify({ error: '报价查询过于频繁，请稍后重试。' })); return;
  }
  activeRequests += 1;
  try {
    const upstream = await fetcher(url, { method: 'GET', headers: {Accept: 'application/json'}, redirect: 'error', signal: AbortSignal.timeout(12_000) });
    if (!upstream.ok) { res.statusCode = 502; res.end(JSON.stringify({error: `Firsto 报价暂不可用（${upstream.status}）。`})); return; }
    if (!upstream.headers.get('content-type')?.includes('application/json')) throw new Error('Invalid content type');
    const reader = upstream.body.getReader();
    let size = 0; const chunks = [];
    while (true) { const {done, value} = await reader.read(); if (done) break; size += value.length; if (size > 2_000_000) { await reader.cancel(); throw new Error('Quote response too large'); } chunks.push(value); }
    const body = Buffer.concat(chunks); JSON.parse(body.toString('utf8'));
    for (const header of HEADERS) { const value = upstream.headers.get(header); if (value) res.setHeader(header, value); }
    res.setHeader('X-Firsto-Fetched-At', new Date().toISOString());
    if (upstream.headers.get('date')) res.setHeader('X-Firsto-Response-Date', upstream.headers.get('date'));
    res.statusCode = 200; res.end(body);
  } catch { res.statusCode = 502; res.end(JSON.stringify({error: '无法获取 Firsto 实时报价，请稍后重试或打开来源页面。'})); }
  finally { activeRequests -= 1; }
}
