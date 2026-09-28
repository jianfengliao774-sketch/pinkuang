import { createServer } from 'node:http';

const pageInt = (value, label, fallback, max = 50) => {
  if (value === null) return fallback;
  if (!/^(0|[1-9]\d*)$/.test(value)) throw new Error(`Invalid ${label}.`);
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number > max) throw new Error(`Invalid ${label}.`);
  return number;
};

/** Separate read-only HTTP surface. Never accepts a transaction, private key or arbitrary RPC address. */
export function createChainIndexServer(index, { syncWaitMs = 9000 } = {}) {
  return createServer(async (req, res) => {
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
    let source = index.status();
    if (url.pathname === '/health') return send(200, { source });
    if (['/v1/snapshot/pools', '/v1/snapshot/portfolios', '/v1/snapshot/stats', '/v1/snapshot/orders'].includes(url.pathname)) {
      const snapshot = index.verifiedDisplaySnapshot();
      if (!snapshot) return send(503, { source, data: null, error: 'No recent canonical verified display snapshot.' });
      try {
        if (url.pathname.endsWith('/stats')) {
          if (!snapshot.stats) return send(503, { source, data: null, error: 'Verified statistics snapshot is unavailable.' });
          return send(200, { source: snapshot.source, data: snapshot.stats });
        }
        if (url.pathname.endsWith('/orders')) {
          if (!snapshot.orders) return send(503, { source: snapshot.source, data: null, error: 'Verified order snapshot is unavailable.' });
          const pool = url.searchParams.get('pool'), seller = url.searchParams.get('seller');
          if ([pool, seller].some(value => value !== null && !/^0x[0-9a-fA-F]{40}$/.test(value))) throw new Error('Invalid address filter.');
          const active = url.searchParams.get('active'), cursor = url.searchParams.get('cursor');
          if (active !== null && active !== 'true' && active !== 'false') throw new Error('Invalid active filter.');
          if (cursor !== null && !/^[1-9]\d*$/.test(cursor)) throw new Error('Invalid order cursor.');
          const limit = pageInt(url.searchParams.get('limit'), 'limit', 20);
          const filtered = snapshot.orders.filter(order => (!pool || order.pool.toLowerCase() === pool.toLowerCase())
            && (!seller || order.seller.toLowerCase() === seller.toLowerCase())
            && (active === null || order.openAtSourceBlock === (active === 'true'))
            && (cursor === null || BigInt(order.orderId) < BigInt(cursor)));
          const items = filtered.slice(0, limit);
          return send(200, { source: snapshot.source, data: { items,
            nextCursor: filtered.length > limit ? items.at(-1).orderId : null } });
        }
        const cursor = pageInt(url.searchParams.get('cursor'), 'cursor', 0, Number.MAX_SAFE_INTEGER);
        const limit = pageInt(url.searchParams.get('limit'), 'limit', 20);
        const portfolio = url.pathname.endsWith('/portfolios');
        const directory = portfolio ? snapshot.portfolios : snapshot.pools;
        if (!directory) return send(503, { source: snapshot.source, data: null, error: 'Verified directory snapshot is unavailable.' });
        const items = directory.slice(cursor, cursor + limit);
        return send(200, { source: snapshot.source,
          data: { items, nextCursor: cursor + limit < directory.length ? cursor + limit : null,
            registeredPoolCount: snapshot.source.registeredPoolCount,
            childPoolCount: snapshot.source.childPoolCount,
            standalonePoolCount: snapshot.source.standalonePoolCount } });
      } catch { return send(400, { source: snapshot.source, error: 'Invalid snapshot query.' }); }
    }
    // A normal sync makes the snapshot temporarily incomplete. Let that cycle
    // finish briefly. Once a saved verified snapshot exists, return promptly
    // so the browser can use it instead of waiting for a slow RPC sync.
    if (!source.complete && index.syncing) {
      await index.waitForSync(index.verifiedDisplaySnapshot() ? Math.min(syncWaitMs, 250) : syncWaitMs);
      source = index.status();
    }
    if (!source.complete) return send(503, { source, data: null, error: 'Index is not verified through the observed safe head.' });
    try {
      let data;
      if (url.pathname === '/v1/notifications') {
        const optionalInt = name => url.searchParams.has(name)
          ? pageInt(url.searchParams.get(name), name, 0, Number.MAX_SAFE_INTEGER) : undefined;
        data = await index.notifications({ cursor: pageInt(url.searchParams.get('cursor'), 'cursor', 0, Number.MAX_SAFE_INTEGER),
          limit: pageInt(url.searchParams.get('limit'), 'limit', 5, 10), atBlock: optionalInt('atBlock'),
          atHash: url.searchParams.get('atHash') ?? undefined, anchorBlock: optionalInt('anchorBlock'),
          anchorHash: url.searchParams.get('anchorHash') ?? undefined });
      } else if (url.pathname === '/v1/pools') {
        data = index.pools({ cursor: pageInt(url.searchParams.get('cursor'), 'cursor', 0, Number.MAX_SAFE_INTEGER),
          limit: pageInt(url.searchParams.get('limit'), 'limit', 20) });
      } else if (url.pathname === '/v1/portfolios' || /^\/v1\/accounts\/0x[0-9a-fA-F]{40}\/portfolios$/.test(url.pathname)) {
        data=index.portfolios({cursor:pageInt(url.searchParams.get('cursor'),'cursor',0,Number.MAX_SAFE_INTEGER),
          limit:pageInt(url.searchParams.get('limit'),'limit',20),account:url.pathname.startsWith('/v1/accounts/')?url.pathname.split('/')[3]:undefined});
      } else if (/^\/v1\/portfolios\/0x[0-9a-fA-F]{40}\/children$/.test(url.pathname)) {
        data=index.portfolioChildren(url.pathname.split('/')[3],{cursor:pageInt(url.searchParams.get('cursor'),'cursor',0,Number.MAX_SAFE_INTEGER),
          limit:pageInt(url.searchParams.get('limit'),'limit',20)});
      } else if (url.pathname === '/v1/stats') {
        data = index.stats();
      } else if (/^\/v1\/accounts\/0x[0-9a-fA-F]{40}\/pools$/.test(url.pathname)) {
        const account = url.pathname.split('/')[3];
        data = index.accountPools(account, { cursor: pageInt(url.searchParams.get('cursor'), 'cursor', 0, Number.MAX_SAFE_INTEGER),
          limit: pageInt(url.searchParams.get('limit'), 'limit', 20) });
      } else if (url.pathname === '/v1/orders' || url.pathname === '/v1/portfolio-orders') {
        const active = url.searchParams.get('active');
        if (active !== null && active !== 'true' && active !== 'false') throw new Error('Invalid active filter.');
        data = index.orders({ portfolio:url.pathname==='/v1/portfolio-orders',pool: url.searchParams.get('pool') ?? undefined,
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
    } catch { return send(url.pathname === '/v1/notifications' ? 503 : 400,
      { source, error: url.pathname === '/v1/notifications' ? 'Notification snapshot unavailable or changed.' : 'Invalid query.' }); }
  });
}
