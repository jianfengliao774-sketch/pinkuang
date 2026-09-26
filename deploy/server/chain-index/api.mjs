import { createServer } from 'node:http';

const pageInt = (value, label, fallback, max = 50) => {
  if (value === null) return fallback;
  if (!/^(0|[1-9]\d*)$/.test(value)) throw new Error(`Invalid ${label}.`);
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number > max) throw new Error(`Invalid ${label}.`);
  return number;
};

/** Separate read-only HTTP surface. Never accepts a transaction, private key or arbitrary RPC address. */
export function createChainIndexServer(index) {
  return createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    const send = (code, body) => {
      res.statusCode = code;
      const bytes = JSON.stringify(body);
      res.end(req.method === 'HEAD' ? undefined : bytes);
    };
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(405, { error: 'Read-only GET API.' });
    if (!req.url || req.url.length > 2048) return send(400, { error: 'Invalid URL.' });
    let url;
    try { url = new URL(req.url, 'http://localhost'); }
    catch { return send(400, { error: 'Invalid URL.' }); }
    const source = index.status();
    if (url.pathname === '/health') return send(200, { source });
    if (!source.complete) return send(503, { source, data: null, error: 'Index is not verified through the observed safe head.' });
    try {
      let data;
      if (url.pathname === '/v1/pools') {
        data = index.pools({ cursor: pageInt(url.searchParams.get('cursor'), 'cursor', 0, Number.MAX_SAFE_INTEGER),
          limit: pageInt(url.searchParams.get('limit'), 'limit', 20) });
      } else if (url.pathname === '/v1/stats') {
        data = index.stats();
      } else if (/^\/v1\/accounts\/0x[0-9a-fA-F]{40}\/pools$/.test(url.pathname)) {
        const account = url.pathname.split('/')[3];
        data = index.accountPools(account, { cursor: pageInt(url.searchParams.get('cursor'), 'cursor', 0, Number.MAX_SAFE_INTEGER),
          limit: pageInt(url.searchParams.get('limit'), 'limit', 20) });
      } else if (url.pathname === '/v1/orders') {
        const active = url.searchParams.get('active');
        if (active !== null && active !== 'true' && active !== 'false') throw new Error('Invalid active filter.');
        data = index.orders({ pool: url.searchParams.get('pool') ?? undefined,
          seller: url.searchParams.get('seller') ?? undefined, active: active === null ? undefined : active === 'true',
          cursor: url.searchParams.get('cursor') ?? undefined, limit: pageInt(url.searchParams.get('limit'), 'limit', 20) });
      } else if (url.pathname === '/v1/activity') {
        data = index.activity({ pool: url.searchParams.get('pool') ?? undefined,
          account: url.searchParams.get('account') ?? undefined, cursor: url.searchParams.get('cursor') ?? undefined,
          limit: pageInt(url.searchParams.get('limit'), 'limit', 20) });
      } else if (url.pathname === '/v1/yield') {
        const pool = url.searchParams.get('pool');
        if (!pool) throw new Error('pool is required.');
        data = index.yieldCurve({ pool, account: url.searchParams.get('account') ?? undefined,
          days: pageInt(url.searchParams.get('days'), 'days', 30, 90) });
      } else return send(404, { error: 'Unknown route.' });
      return send(200, { source, data });
    } catch { return send(400, { source, error: 'Invalid query.' }); }
  });
}
