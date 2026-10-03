import { createServer } from 'node:http';
import { cacheEncode } from './pool-display-cache.mjs';
import { DisplayReadError } from './cached-read-api.mjs';
import { communityPage } from './community.mjs';
import { chainIndexInterfaces } from './indexer.mjs';
import { readFirstoAskPublisherStatus } from '../firsto-ask-publisher-store.mjs';
import { FIRSTO_NATIVE_EXCHANGE } from '../../shared/firsto-native-ask.mjs';

class InvalidQueryError extends Error {}
const pageInt = (value, label, fallback, max = 50) => {
  if (value === null) return fallback;
  if (!/^(0|[1-9]\d*)$/.test(value)) throw new InvalidQueryError(`Invalid ${label}.`);
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number > max) throw new InvalidQueryError(`Invalid ${label}.`);
  return number;
};

const displaySnapshots = Object.freeze({
  '/v1/pools': '/v1/snapshot/pools',
  '/v1/portfolios': '/v1/snapshot/portfolios',
  '/v1/stats': '/v1/snapshot/stats',
  '/v1/orders': '/v1/snapshot/orders',
});

/** Separate read-only HTTP surface. Never accepts a transaction, private key or arbitrary RPC address. */
export function createChainIndexServer(index, { syncWaitMs = 1000, displayCache, portfolioReads, displayEvents, saleReferenceStatus, firstoAskStatus } = {}) {
  return createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    const send = (code, body) => {
      res.statusCode = code;
      const bytes = JSON.stringify(body, cacheEncode);
      res.end(req.method === 'HEAD' ? undefined : bytes);
    };
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(405, { error: 'Read-only GET API.' });
    if (!req.url || req.url.length > 2048) return send(400, { error: 'Invalid URL.' });
    let url;
    try { url = new URL(req.url, 'http://localhost'); }
    catch { return send(400, { error: 'Invalid URL.' }); }
    try {
    const referenceMatch = /^\/v1\/display\/sale-reference\/(0x[\da-f]{40})$/i.exec(url.pathname);
    if (referenceMatch) {
      if ([...url.searchParams].length) return send(400, { error: 'Reference status takes no query parameters.' });
      if (!saleReferenceStatus) return send(200, { schemaVersion: 1, chainId: 56, factory: index.factory,
        market: index.market, updatedAt: null, enabled: false, stale: false,
        item: { pool: referenceMatch[1], status: 'disabled', proposalId: null } });
      return send(200, await saleReferenceStatus(referenceMatch[1]));
    }
    if (url.pathname.startsWith('/v1/display/sale-reference/')) return send(400, { error: 'Invalid pool.' });
    const askMatch = /^\/v1\/display\/firsto-ask\/(0x[\da-f]{40})$/i.exec(url.pathname);
    if (askMatch) {
      if ([...url.searchParams].length) return send(400, { error: 'Native ask status takes no query parameters.' });
      return send(200, firstoAskStatus ? await firstoAskStatus(askMatch[1]) : readFirstoAskPublisherStatus(null,
        { factory: index.factory, exchange: FIRSTO_NATIVE_EXCHANGE, pool: askMatch[1] }));
    }
    if (url.pathname.startsWith('/v1/display/firsto-ask/')) return send(400, { error: 'Invalid pool.' });
    if (url.pathname === '/v1/display/events') {
      if ([...url.searchParams].length) return send(400, { error: 'Display stream takes no query parameters.' });
      if (!displayEvents) return send(404, { error: 'Display stream is unavailable.' });
      return displayEvents.subscribe(req, res);
    }
    const portfolioMatch = /^\/v1\/display\/portfolios\/(0x[\da-f]{40})$/i.exec(url.pathname);
    if (url.pathname === '/v1/display/portfolios' || portfolioMatch) {
      if (!portfolioReads) return send(404, { error: 'Portfolio display API is unavailable.' });
      const seen = new Set(), allowed = portfolioMatch ? ['account', 'children'] : ['account', 'cursor', 'limit', 'mine'];
      for (const [name, value] of url.searchParams) {
        if (!allowed.includes(name) || seen.has(name)) return send(400, { error: 'Invalid display query.' });
        seen.add(name);
        if (name === 'account' && !/^0x[\da-f]{40}$/i.test(value)) return send(400, { error: 'Invalid account.' });
        if (['children', 'mine'].includes(name) && !['true', 'false'].includes(value)) return send(400, { error: 'Invalid display flag.' });
      }
      const account = url.searchParams.get('account') ?? undefined;
      if (portfolioMatch) return send(200, await portfolioReads.detail(portfolioMatch[1], {
        account, includeChildren: url.searchParams.get('children') !== 'false',
      }));
      const cursor = pageInt(url.searchParams.get('cursor'), 'cursor', 0, Number.MAX_SAFE_INTEGER);
      const limit = pageInt(url.searchParams.get('limit'), 'limit', 20, 20);
      if (limit < 1 || url.searchParams.get('mine') === 'true' && !account) return send(400, { error: 'Invalid display pagination.' });
      return send(200, await portfolioReads.page({ account, cursor, limit, mine: url.searchParams.get('mine') === 'true' }));
    }
    // No sync wait and no RPC calls on the materialized display path.
    if (url.pathname.startsWith('/v1/display/')) {
      const cached=displayCache?.snapshot();
      if(!cached) return send(503,{error:'Server display cache is warming.'});
      const source=cached.source;
      const allowed=['cursor','limit','account','pool','seller','active'];
      const seen=new Set();
      for(const [name,value] of url.searchParams) {
        if(!allowed.includes(name) || seen.has(name)) throw new InvalidQueryError('Invalid display query.');
        seen.add(name);
        if(['account','pool','seller'].includes(name) && !/^0x[\da-f]{40}$/i.test(value)) throw new InvalidQueryError('Invalid address.');
      }
      const account=url.searchParams.get('account')?.toLowerCase();
      const own=account ? cached.accountRows[account] : null;
      const poolMatch=/^\/v1\/display\/pools\/(0x[\da-f]{40})$/i.exec(url.pathname);
      const positionMatch=/^\/v1\/display\/positions\/(0x[\da-f]{40})$/i.exec(url.pathname);
      const cursor=url.pathname.endsWith('/orders') ? 0 : pageInt(url.searchParams.get('cursor'),'cursor',0,Number.MAX_SAFE_INTEGER);
      const limit=pageInt(url.searchParams.get('limit'),'limit',20,20);
      if(limit<1) throw new InvalidQueryError('Invalid limit.');
      let data;
      if(poolMatch) {
        const pool=poolMatch[1].toLowerCase();
        const item=own?.[pool] ?? cached.rows[pool];
        if(!item) return send(404,{error:'Pool is not in the verified cache.'});
        data={item};
      } else if(url.pathname==='/v1/display/pools') {
        const addresses=cached.directory.slice(cursor,cursor+limit);
        data={items:addresses.map(a=>own?.[a.toLowerCase()] ?? cached.rows[a.toLowerCase()]),
          nextCursor:cursor+limit<cached.directory.length?cursor+limit:null};
      } else if(positionMatch) {
        const wallet=positionMatch[1].toLowerCase(),walletRows=cached.accountRows[wallet];
        if(!walletRows && !cached.accountsComplete) return send(503,{error:'Account display cache is not ready.'});
        const rows=Object.values(walletRows ?? {}).filter(row=>['shares','claimableBEM','bnbOwed'].some(name=>row[name]===null || row[name]>0n));
        data={items:rows.slice(cursor,cursor+limit),nextCursor:cursor+limit<rows.length?cursor+limit:null,
          marketBnbOwed:cached.marketOwed[wallet] ?? 0n};
      } else if(url.pathname==='/v1/display/stats') data=cached.stats;
      else if(url.pathname==='/v1/display/orders') {
        if(!cached.orders) return send(503,{error:'Order display cache is not ready.'});
        const active=url.searchParams.get('active');
        if(active!==null && !['true','false'].includes(active)) throw new InvalidQueryError('Invalid active filter.');
        const pool=url.searchParams.get('pool')?.toLowerCase(),seller=url.searchParams.get('seller')?.toLowerCase();
        const after=url.searchParams.get('cursor');
        if(after!==null && !/^[1-9]\d{0,77}$/.test(after)) throw new InvalidQueryError('Invalid order cursor.');
        const rows=cached.orders.filter(row=>(!pool || row.pool.toLowerCase()===pool) && (!seller || row.seller.toLowerCase()===seller)
          && (active===null || row.openAtSourceBlock===(active==='true')) && (after===null || row.orderId<BigInt(after)));
        data={items:rows.slice(0,limit),nextCursor:rows.length>limit?String(rows[limit-1].orderId):null};
      } else return send(404,{error:'Unknown display route.'});
      return send(200,{source,data});
    }
    let source = index.status();
    // Wait briefly for a fresh proof before falling back to a display-only
    // read view. Explicit snapshot routes remain historical and do not wait.
    if (index.syncing && !url.pathname.startsWith('/v1/snapshot/')) {
      await index.waitForSync(syncWaitMs);
      source = index.status();
    }
    if (url.pathname === '/health') {
      const view = index.syncing || !source.complete ? index.acquireVerifiedReadView() : null;
      try {
        // Keep `source` as the live operational status. Only browser display
        // reads may use the previously verified tip, clearly marked as stale.
        const liveSource = index.syncing ? { ...source, complete: false,
          unknownReason: 'index_refreshing', transactionReady: false } : source;
        return send(200, { source: liveSource, ...(view ? { displaySource: {
          ...view.source, readMode: 'verified_snapshot', stale: true,
          refreshing: Boolean(index.syncing), transactionReady: false,
        } } : {}) });
      } finally { if (view) index.releaseVerifiedReadView(view); }
    }
    const privateSnapshot = url.pathname === '/v1/notifications' || url.pathname === '/v1/community';
    // These pages can drive outbound messages. An earlier display tip must
    // never authorize a notification while fresh verification is underway.
    if (privateSnapshot && (index.syncing || !source.complete))
      return send(503, { source, data: null, error: 'Private snapshot requires a fresh verified index.' });
    // Display-only reads can use a previously completed, canonical snapshot
    // while the next sync runs or an RPC is unavailable. Transaction paths
    // continue to require a fresh graph and finalized on-chain checks.
    const exactPool = /^\/v1\/snapshot\/pools\/(0x[\da-fA-F]{40})$/.exec(url.pathname);
    const snapshotPath = exactPool ? '/v1/snapshot/pools'
      : url.pathname.startsWith('/v1/snapshot/') ? url.pathname
      : !source.complete ? displaySnapshots[url.pathname] : undefined;
    if (snapshotPath && Object.values(displaySnapshots).includes(snapshotPath)) {
      const snapshot = index.verifiedDisplaySnapshot();
      if (!snapshot && url.pathname.startsWith('/v1/snapshot/'))
        return send(503, { source, data: null, error: 'No recent canonical verified display snapshot.' });
      if (snapshot) {
        const snapshotSource = { ...snapshot.source, stale: true, refreshing: index.syncing,
          transactionReady: false };
        const block = { number: snapshotSource.indexedThrough, hash: snapshotSource.indexedBlockHash,
          timestamp: snapshotSource.indexedTimestamp };
        try {
          if (exactPool) {
            if ([...url.searchParams].length) throw new InvalidQueryError('Exact pool lookup takes no query parameters.');
            const lookupAddress = exactPool[1].toLowerCase();
            const matched = index.verifiedDisplayPool(lookupAddress, snapshot);
            return send(200, { source: snapshotSource, block,
              data: { items: matched ? [matched] : [], nextCursor: null, lookupAddress,
                registeredPoolCount: snapshot.source.registeredPoolCount,
                childPoolCount: snapshot.source.childPoolCount,
                reservedChildPoolCount: snapshot.source.reservedChildPoolCount,
                reservedChildPoolAddresses: snapshot.source.reservedChildPoolAddresses,
                reservedChildPoolAddressesComplete: snapshot.source.reservedChildPoolAddressesComplete,
                standalonePoolCount: snapshot.source.standalonePoolCount } });
          }
          if (snapshotPath.endsWith('/stats')) {
            if (!snapshot.stats) return send(503, { source: snapshotSource, block, data: null,
              error: 'Verified statistics snapshot is unavailable.' });
            return send(200, { source: snapshotSource, block, data: snapshot.stats });
          }
          if (snapshotPath.endsWith('/orders')) {
            if (!snapshot.orders) return send(503, { source: snapshotSource, block,
              data: { items: null, nextCursor: null, ordersAvailable: false },
              error: 'Verified order snapshot is unavailable.' });
            const pool = url.searchParams.get('pool'), seller = url.searchParams.get('seller');
            if ([pool, seller].some(value => value !== null && !/^0x[0-9a-fA-F]{40}$/.test(value))) throw new InvalidQueryError('Invalid address filter.');
            const active = url.searchParams.get('active'), cursor = url.searchParams.get('cursor');
            if (active !== null && active !== 'true' && active !== 'false') throw new InvalidQueryError('Invalid active filter.');
            if (cursor !== null && !/^[1-9]\d*$/.test(cursor)) throw new InvalidQueryError('Invalid order cursor.');
            const limit = pageInt(url.searchParams.get('limit'), 'limit', 20);
            const filtered = snapshot.orders.filter(order => (!pool || order.pool.toLowerCase() === pool.toLowerCase())
              && (!seller || order.seller.toLowerCase() === seller.toLowerCase())
              && (active === null || order.openAtSourceBlock === (active === 'true'))
              && (cursor === null || BigInt(order.orderId) < BigInt(cursor)));
            const items = filtered.slice(0, limit);
            return send(200, { source: snapshotSource, block, data: { items, ordersAvailable: true,
              nextCursor: filtered.length > limit ? items.at(-1).orderId : null } });
          }
          const cursor = pageInt(url.searchParams.get('cursor'), 'cursor', 0, Number.MAX_SAFE_INTEGER);
          const limit = pageInt(url.searchParams.get('limit'), 'limit', 20);
          const portfolio = snapshotPath.endsWith('/portfolios');
          const directory = portfolio ? snapshot.portfolios : snapshot.pools;
          if (!directory) return send(503, { source: snapshotSource, block, data: null,
            error: 'Verified directory snapshot is unavailable.' });
          const items = directory.slice(cursor, cursor + limit);
          return send(200, { source: snapshotSource, block,
            data: { items, nextCursor: cursor + limit < directory.length ? cursor + limit : null,
              registeredPoolCount: snapshot.source.registeredPoolCount,
              childPoolCount: snapshot.source.childPoolCount,
              reservedChildPoolCount: snapshot.source.reservedChildPoolCount,
              reservedChildPoolAddresses: snapshot.source.reservedChildPoolAddresses,
              reservedChildPoolAddressesComplete: snapshot.source.reservedChildPoolAddressesComplete,
              standalonePoolCount: snapshot.source.standalonePoolCount } });
        } catch (error) { return send(error instanceof InvalidQueryError ? 400 : 503,
          { source: snapshotSource, error: error instanceof InvalidQueryError ? 'Invalid snapshot query.' : 'Index snapshot unavailable.' }); }
      }
    }
    // A pinned copy of the previous fully verified tip keeps history reads
    // coherent even after the writer commits new scan chunks. Label every
    // response from that copy as display-only history.
    let readView = index.syncing || !source.complete ? index.acquireVerifiedReadView() : null;
    if ((index.syncing || !source.complete) && !readView)
      return send(503, { source: { ...source, complete: false,
        unknownReason: index.syncing ? 'index_refreshing' : source.unknownReason,
        transactionReady: false },
        data: null, error: 'Index is not verified through the observed safe head.' });
    const reader = readView?.index ?? index;
    if (readView) source = { ...readView.source, readMode: 'verified_snapshot', stale: true,
      refreshing: index.syncing, transactionReady: false };
    try {
      let data;
      if (url.pathname === '/v1/notifications' || url.pathname === '/v1/community') {
        const optionalInt = name => url.searchParams.has(name)
          ? pageInt(url.searchParams.get(name), name, 0, Number.MAX_SAFE_INTEGER) : undefined;
        const options = { cursor: pageInt(url.searchParams.get('cursor'), 'cursor', 0, Number.MAX_SAFE_INTEGER),
          limit: pageInt(url.searchParams.get('limit'), 'limit', 5, 10), atBlock: optionalInt('atBlock'),
          atHash: url.searchParams.get('atHash') ?? undefined, anchorBlock: optionalInt('anchorBlock'),
          anchorHash: url.searchParams.get('anchorHash') ?? undefined };
        data = url.pathname === '/v1/community' ? await communityPage(reader, chainIndexInterfaces.pool, options)
          : await reader.notifications(options);
        const current = reader.status();
        if (index.syncing || !current.complete || current.indexedThrough !== source.indexedThrough
          || current.indexedBlockHash !== source.indexedBlockHash) throw new Error('Snapshot source changed.');
      } else if (url.pathname === '/v1/pools') {
        data = reader.pools({ cursor: pageInt(url.searchParams.get('cursor'), 'cursor', 0, Number.MAX_SAFE_INTEGER),
          limit: pageInt(url.searchParams.get('limit'), 'limit', 20) });
      } else if (url.pathname === '/v1/portfolios' || /^\/v1\/accounts\/0x[0-9a-fA-F]{40}\/portfolios$/.test(url.pathname)) {
        data=reader.portfolios({cursor:pageInt(url.searchParams.get('cursor'),'cursor',0,Number.MAX_SAFE_INTEGER),
          limit:pageInt(url.searchParams.get('limit'),'limit',20),account:url.pathname.startsWith('/v1/accounts/')?url.pathname.split('/')[3]:undefined});
      } else if (/^\/v1\/portfolios\/0x[0-9a-fA-F]{40}\/children$/.test(url.pathname)) {
        data=reader.portfolioChildren(url.pathname.split('/')[3],{cursor:pageInt(url.searchParams.get('cursor'),'cursor',0,Number.MAX_SAFE_INTEGER),
          limit:pageInt(url.searchParams.get('limit'),'limit',20)});
      } else if (url.pathname === '/v1/stats') {
        data = reader.stats();
      } else if (/^\/v1\/accounts\/0x[0-9a-fA-F]{40}\/pools$/.test(url.pathname)) {
        const account = url.pathname.split('/')[3];
        data = reader.accountPools(account, { cursor: pageInt(url.searchParams.get('cursor'), 'cursor', 0, Number.MAX_SAFE_INTEGER),
          limit: pageInt(url.searchParams.get('limit'), 'limit', 20) });
      } else if (url.pathname === '/v1/orders' || url.pathname === '/v1/portfolio-orders') {
        const active = url.searchParams.get('active');
        if (active !== null && active !== 'true' && active !== 'false') throw new InvalidQueryError('Invalid active filter.');
        data = reader.orders({ portfolio:url.pathname==='/v1/portfolio-orders',pool: url.searchParams.get('pool') ?? undefined,
          seller: url.searchParams.get('seller') ?? undefined, active: active === null ? undefined : active === 'true',
          cursor: url.searchParams.get('cursor') ?? undefined, limit: pageInt(url.searchParams.get('limit'), 'limit', 20) });
      } else if (url.pathname === '/v1/activity') {
        data = reader.activity({ pool: url.searchParams.get('pool') ?? undefined,
          account: url.searchParams.get('account') ?? undefined, cursor: url.searchParams.get('cursor') ?? undefined,
          limit: pageInt(url.searchParams.get('limit'), 'limit', 20) });
      } else if (url.pathname === '/v1/yield') {
        const pool = url.searchParams.get('pool');
        if (!pool) throw new InvalidQueryError('pool is required.');
        data = reader.yieldCurve({ pool, account: url.searchParams.get('account') ?? undefined,
          days: pageInt(url.searchParams.get('days'), 'days', 30, 90) });
      } else return send(404, { error: 'Unknown route.' });
      if (readView && !index.isVerifiedReadView(readView))
        return send(503, { source: index.status(), data: null, error: 'Previous verified snapshot was invalidated.' });
      if (!readView) {
        const current = index.status();
        if (index.syncing || !current.complete || current.indexedThrough !== source.indexedThrough
          || current.indexedBlockHash !== source.indexedBlockHash)
          return send(503, { source: { ...current, complete: false,
            unknownReason: index.syncing ? 'index_refreshing' : current.unknownReason,
            transactionReady: false }, data: null,
          error: 'Index changed during the read; retry with a fresh verified source.' });
      }
      return send(200, { source, data });
    } catch (error) {
      const invalid = error instanceof InvalidQueryError;
      return send(privateSnapshot || !invalid ? 503 : 400,
        { source, error: privateSnapshot ? 'Private snapshot unavailable or changed.'
          : invalid ? 'Invalid query.' : 'Index read unavailable.' });
    } finally { if (readView) index.releaseVerifiedReadView(readView); }
    } catch (error) {
      if (error instanceof DisplayReadError) return send(error.status, { source: null, error: error.message });
      if (error instanceof InvalidQueryError) return send(400, { error: 'Invalid query.' });
      return send(503, { source: null, error: 'Index unavailable.' });
    }
  });
}
