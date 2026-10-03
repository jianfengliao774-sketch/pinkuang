import { freshRuntimeLayout } from '../../shared/fresh-runtime-identity.mjs';
import { fileURLToPath } from 'node:url';
import { join, dirname, isAbsolute } from 'node:path';
import { PoolDisplayCache } from './pool-display-cache.mjs';
import { overviewQuoteLoader } from './overview-stats.mjs';
import { DisplayEvents, PortfolioDisplayReads } from './cached-read-api.mjs';
import { FetchRequest, JsonRpcProvider } from 'ethers';
import { ChainIndex } from './indexer.mjs';
import { createChainIndexServer } from './api.mjs';
import { loadFreshIndexManifest } from './fresh-manifest.mjs';
import { readSaleReferencePublisherStatus } from '../sale-reference-status-read.mjs';
import { readFirstoAskPublisherStatus } from '../firsto-ask-publisher-store.mjs';
import { FIRSTO_NATIVE_EXCHANGE } from '../../shared/firsto-native-ask.mjs';

/** Independent materializers must not suppress updates from a healthy cache.
 * DisplayEvents still gates publication on a complete index and the pool cache
 * catching up to the latest business event. */
export async function refreshDisplayCaches({displayCache,portfolioReads,displayEvents,
  isStopped=()=>false,onError=()=>console.error('Display cache refresh failed; retaining previous display data.')}={}) {
  const caches=[displayCache,portfolioReads].filter(Boolean);
  const completed=await Promise.allSettled(caches.map(cache=>Promise.resolve().then(()=>cache.refresh())));
  if(completed.some(item=>item.status==='rejected')) onError();
  if(!isStopped() && completed.some(item=>item.status==='fulfilled')) displayEvents.publish();
  return completed;
}

const required = (env, key) => {
  if (!env[key]) throw new Error(`${key} is required.`);
  return env[key];
};
const exactNumber = (value, label) => {
  if (!/^(0|[1-9]\d*)$/.test(String(value))) throw new Error(`Invalid ${label}.`);
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new Error(`Invalid ${label}.`);
  return number;
};
const logsTimeout = value => {
  const timeout = exactNumber(value ?? 12_000, 'logs timeout');
  if (timeout < 12_000 || timeout > 30_000) throw new Error('Logs timeout must be between 12000 and 30000 milliseconds.');
  return timeout;
};

// Catch-up yields to other requests after each bounded sync. Only observed
// progress qualifies; an incomplete but idle index must not busy-loop.
export function chainIndexSyncDelay({ failures = 0, complete = false, progressed = false }) {
  return failures ? Math.min(60_000,4_000*2**(failures-1)) : complete ? 10_000 : progressed ? 0 : 1_000;
}

export function serverConfiguration(env = process.env) {
  const saleReferenceStatusPath = env.SALE_REFERENCE_STATUS_PATH || null;
  if (saleReferenceStatusPath !== null && !isAbsolute(saleReferenceStatusPath))
    throw new Error('SALE_REFERENCE_STATUS_PATH must be absolute.');
  const firstoAskStatusPath = env.BEMINE_NATIVE_FIRSTO_ASKS_STATUS_PATH || null;
  if (firstoAskStatusPath !== null && !isAbsolute(firstoAskStatusPath))
    throw new Error('BEMINE_NATIVE_FIRSTO_ASKS_STATUS_PATH must be absolute.');
  const rpc = required(env, 'CHAIN_INDEX_RPC_URL');
  if (!/^https:\/\//.test(rpc)) throw new Error('CHAIN_INDEX_RPC_URL must use HTTPS.');
  const logsRpc = env.CHAIN_INDEX_LOGS_RPC_URL || null;
  if (logsRpc && !/^https:\/\//.test(logsRpc)) throw new Error('CHAIN_INDEX_LOGS_RPC_URL must use HTTPS.');
  const fallbackLogsRpc = env.CHAIN_INDEX_LOGS_FALLBACK_RPC_URL || null;
  if (fallbackLogsRpc && !/^https:\/\//.test(fallbackLogsRpc)) throw new Error('CHAIN_INDEX_LOGS_FALLBACK_RPC_URL must use HTTPS.');
  if (fallbackLogsRpc && fallbackLogsRpc === (logsRpc || rpc)) throw new Error('Fallback logs RPC must differ from the primary logs RPC.');
  const host = env.CHAIN_INDEX_HOST || '127.0.0.1';
  if (host !== '127.0.0.1' && host !== '::1') throw new Error('Bind the index only to loopback; use an authenticated/rate-limited reverse proxy.');
  const port = exactNumber(env.CHAIN_INDEX_PORT || '4180', 'port');
  if (port < 1 || port > 65535) throw new Error('Invalid port.');
  const scanRange = exactNumber(env.CHAIN_INDEX_SCAN_RANGE ?? '100', 'scan range');
  if (scanRange < 1 || scanRange > 500) throw new Error('Scan range must be between 1 and 500 blocks.');
  const maxBlocksPerSync = exactNumber(env.CHAIN_INDEX_MAX_BLOCKS_PER_SYNC ?? '2000','maximum blocks per sync');
  if (maxBlocksPerSync < 1 || maxBlocksPerSync > 2000) throw new Error('Maximum blocks per sync must be between 1 and 2000.');
  const headerConcurrency = exactNumber(env.CHAIN_INDEX_HEADER_CONCURRENCY ?? '64','header concurrency');
  if (headerConcurrency < 1 || headerConcurrency > 64) throw new Error('Header concurrency must be between 1 and 64.');
  const mode=env.CHAIN_INDEX_MODE || 'legacy';
  if (!['legacy','fresh-v4'].includes(mode)) throw new Error('Invalid chain-index mode.');
  const dbPath=required(env,'CHAIN_INDEX_DB');
  if (mode==='fresh-v4') {
    const layout=freshRuntimeLayout(env);
    for (const key of ['CHAIN_INDEX_FACTORY','CHAIN_INDEX_MARKET','CHAIN_INDEX_PORTFOLIO_FACTORY',
      'CHAIN_INDEX_PORTFOLIO_MARKET','CHAIN_INDEX_START_BLOCK','CHAIN_INDEX_RESERVATION_MODE']) {
      if (env[key] !== undefined) throw new Error(`${key} cannot override the fresh manifest.`);
    }
    if (env.NODE_ENV==='production' && dbPath!==`/var/lib/pinkuang-index-v${layout.version}/index.sqlite`)
      throw new Error('Fresh v4 index requires its independent database path.');
    const manifestPath=required(env,'CHAIN_INDEX_FRESH_MANIFEST_PATH');
    const manifestPattern=layout.version==='5'
      ? /^\/srv\/pinkuang-v5\/releases\/v5-[a-z0-9][a-z0-9-]{1,70}\/public\/fresh-product-manifest\.json$/
      : /^\/srv\/pinkuang-deploy-v4\/releases\/v4-[a-z0-9][a-z0-9-]{1,70}\/public\/fresh-product-manifest\.json$/;
    if (env.NODE_ENV==='production' && !manifestPattern.test(manifestPath))
      throw new Error('Fresh v4 index requires a release-pinned manifest path.');
    const manifest=loadFreshIndexManifest(manifestPath,
      required(env,'CHAIN_INDEX_FRESH_MANIFEST_SHA256'));
    return {rpc,logsRpc,fallbackLogsRpc,logsTimeoutMs:logsTimeout(env.CHAIN_INDEX_LOGS_TIMEOUT_MS),saleReferenceStatusPath,firstoAskStatusPath,
      host,port,dbPath,scanRange,maxBlocksPerSync,headerConcurrency,confirmations:exactNumber(env.CHAIN_INDEX_CONFIRMATIONS || '12','confirmations'),
      factory:manifest.factory,market:manifest.shareMarket,lens:manifest.lens,
      portfolioFactory:manifest.portfolioFactory,portfolioMarket:manifest.portfolioMarket,
      startBlock:manifest.deployment.blockNumber,reservationMode:'required',
      freshCodehashes:Object.freeze([
        ...Object.entries(manifest.codehash).map(([name,expected])=>({address:manifest[name],expected})),
        {address:manifest.authority,expected:manifest.freshAuthority.codehash},
      ])};
  }
  if(Boolean(env.CHAIN_INDEX_PORTFOLIO_FACTORY)!==Boolean(env.CHAIN_INDEX_PORTFOLIO_MARKET))throw new Error('Configure both portfolio Factory and market.');
  const reservationMode=env.CHAIN_INDEX_RESERVATION_MODE || 'legacy';
  if (!['legacy','required'].includes(reservationMode)) throw new Error('Invalid chain-index reservation mode.');
  if (reservationMode==='required' && !env.CHAIN_INDEX_PORTFOLIO_FACTORY)
    throw new Error('Reservation proofs require the integrated portfolio Factory.');
  return { rpc, logsRpc, fallbackLogsRpc, logsTimeoutMs: logsTimeout(env.CHAIN_INDEX_LOGS_TIMEOUT_MS), saleReferenceStatusPath, firstoAskStatusPath, host, port, dbPath, factory: required(env, 'CHAIN_INDEX_FACTORY'),
    ...(env.CHAIN_INDEX_PORTFOLIO_FACTORY?{portfolioFactory:env.CHAIN_INDEX_PORTFOLIO_FACTORY,portfolioMarket:env.CHAIN_INDEX_PORTFOLIO_MARKET}:{}),
    reservationMode,
    market: required(env, 'CHAIN_INDEX_MARKET'), startBlock: exactNumber(required(env, 'CHAIN_INDEX_START_BLOCK'), 'start block'),
    confirmations: exactNumber(env.CHAIN_INDEX_CONFIRMATIONS || '12', 'confirmations'), scanRange, maxBlocksPerSync, headerConcurrency };
}

function readProvider(rpc, timeout = 12_000) {
  const request = new FetchRequest(rpc);
  request.timeout = timeout;
  // The sync loop retries failures; an upstream Retry-After must not hold shutdown open.
  request.retryFunc = async () => false;
  // ChainIndex asks eth_chainId directly on every sync before indexing any data.
  // The static network avoids ethers' separate, indefinitely retrying bootstrap loop.
  return new JsonRpcProvider(request, 56, {
    staticNetwork: true, cacheTimeout: -1, batchMaxCount: 8,
  });
}

export function chainIndexFailureMessage(index, error) {
  const code = typeof error?.code === 'string' && /^[A-Z_]{2,30}$/.test(error.code) ? error.code : 'unknown';
  const rpcCodeValue = error?.error?.code ?? error?.info?.error?.code;
  const rpcCode = Number.isSafeInteger(rpcCodeValue) ? rpcCodeValue : 'unknown';
  const httpStatusValue = error?.statusCode ?? error?.info?.response?.statusCode ?? error?.info?.response?.status;
  const httpStatus = Number.isInteger(httpStatusValue) && httpStatusValue >= 100 && httpStatusValue <= 599
    ? httpStatusValue : 'unknown';
  const method = ['eth_chainId', 'eth_call', 'eth_getBlockByNumber', 'eth_getCode', 'eth_getLogs'].includes(error?.rpcMethod)
    ? error.rpcMethod : 'unknown';
  const type = typeof error?.name === 'string' && /^[A-Za-z]{1,40}$/.test(error.name) ? error.name : 'unknown';
  return `Chain index unavailable: ${index.status().unknownReason}; stage=${index.lastFailureStage ?? 'unknown'}; method=${method}; type=${type}; code=${code}; rpcCode=${rpcCode}; httpStatus=${httpStatus}`;
}

export async function startChainIndex(config) {
  const logsTimeoutMs = logsTimeout(config.logsTimeoutMs);
  const primary = readProvider(config.rpc);
  // A longer logs deadline must never lengthen primary header/code/call requests,
  // including when both roles point at the same URL.
  const logsRpc = config.logsRpc || config.rpc;
  const logs = logsRpc !== config.rpc || logsTimeoutMs !== 12_000 ? readProvider(logsRpc, logsTimeoutMs) : primary;
  const fallbackLogs = config.fallbackLogsRpc ? readProvider(config.fallbackLogsRpc, logsTimeoutMs) : null;
  const providers = [...new Set([primary, logs, fallbackLogs].filter(Boolean))];
  let verifiedTips = new Map();
  let verifiedChains = new Map();
  async function observedRead(method, operation) {
    try { return await operation(); }
    catch (error) {
      // Preserve the original error for the sync loop, but expose only this
      // fixed method name in diagnostics. Provider messages may contain URLs.
      if (error && typeof error === 'object') {
        try { error.rpcMethod ??= method; } catch { /* immutable upstream error */ }
      }
      throw error;
    }
  }
  async function checkedLogs(source, filter) {
    if (source !== primary) {
      const key = `${source === logs ? 'primary' : 'fallback'}:${filter.toBlock}`;
      if (!verifiedTips.has(key)) {
        // A spare endpoint must not gate healthy primary reads. Verify its
        // identity only when this endpoint actually serves an event range.
        if (!verifiedChains.has(source)) verifiedChains.set(source, source.send('eth_chainId', []).then(id => {
          if (!/^0x[0-9a-f]+$/i.test(id) || BigInt(id) !== 56n)
            throw new Error('RPC is not BSC mainnet (56).');
        }));
        const proof = verifiedChains.get(source).then(() => Promise.all([primary.getBlock(filter.toBlock), source.getBlock(filter.toBlock)])).then(([canonical, served]) => {
          if (!canonical?.hash || !served?.hash || canonical.number !== filter.toBlock
            || served.number !== filter.toBlock || canonical.hash.toLowerCase() !== served.hash.toLowerCase())
            throw new Error('Logs RPC is behind or differs from the canonical chain.');
        });
        verifiedTips.set(key, proof);
      }
      await verifiedTips.get(key);
    }
    return source.getLogs(filter);
  }
  const provider = Object.freeze({
    send: (method, params) => observedRead(method === 'eth_chainId' ? method : 'other', async () => {
      if (method === 'eth_chainId') {
        verifiedTips = new Map();
        verifiedChains = new Map();
        const id = await primary.send(method, params);
        if (!/^0x[0-9a-f]+$/i.test(id) || BigInt(id) !== 56n)
          throw new Error('RPC is not BSC mainnet (56).');
        return id;
      }
      return primary.send(method, params);
    }),
    call: (...args) => observedRead('eth_call', () => primary.call(...args)),
    getBlock: (...args) => observedRead('eth_getBlockByNumber', () => primary.getBlock(...args)),
    getCode: (...args) => observedRead('eth_getCode', () => primary.getCode(...args)),
    getLogs: filter => observedRead('eth_getLogs', async () => {
      try { return await checkedLogs(logs, filter); }
      catch (error) {
        if (!fallbackLogs) throw error;
        return checkedLogs(fallbackLogs, filter);
      }
    }),
  });
  let index;
  let server;
  let displayCache;
  let portfolioReads;
  let displayEvents;
  let displayTimer;
  try {
    index = new ChainIndex(provider, config);
    if(config.lens) displayCache=new PoolDisplayCache(index,primary,{lens:config.lens,path:join(dirname(config.dbPath),'pool-display-cache.json'),
      quoteLoader:config.overviewQuoteLoader ?? overviewQuoteLoader(),onUpdate:()=>displayEvents?.publish()});
    if (config.portfolioFactory && config.portfolioMarket) portfolioReads = new PortfolioDisplayReads(index, primary, {
      path: config.dbPath === ':memory:' ? undefined : join(dirname(config.dbPath), 'portfolio-display-cache.json'),
    });
    displayEvents = new DisplayEvents(index,{displayRevision:displayCache?()=>displayCache.revision():null});
    server = createChainIndexServer(index,{displayCache,portfolioReads,displayEvents,
      saleReferenceStatus: config.saleReferenceStatusPath ? pool => readSaleReferencePublisherStatus(config.saleReferenceStatusPath,
        { factory: config.factory, market: config.market, pool }) : undefined,
      firstoAskStatus: config.firstoAskStatusPath ? pool => readFirstoAskPublisherStatus(config.firstoAskStatusPath,
        { factory: config.factory, exchange: FIRSTO_NATIVE_EXCHANGE, pool }) : undefined});
    await new Promise((resolve, reject) => {
      const onError = error => { server.off('listening', onListening); reject(error); };
      const onListening = () => { server.off('error', onError); resolve(); };
      server.once('error', onError);
      server.once('listening', onListening);
      try { server.listen(config.port, config.host); }
      catch (error) { server.off('error', onError); server.off('listening', onListening); reject(error); }
    });
  } catch (error) {
    displayEvents?.close();
    await portfolioReads?.close();
    index?.close();
    for (const source of providers) source.destroy();
    throw error;
  }
  let stopped = false;
  let timer = null;
  let running;
  let closing;
  let consecutiveFailures = 0;
  async function tick() {
    if (stopped) return;
    const previousBlock = index.indexedThrough;
    const previousBackfill = index.eventTopicBackfill?.nextBlock;
    try { await index.sync(); consecutiveFailures = 0; if (!displayCache && !portfolioReads) displayEvents.publish(); }
    catch (error) {
      consecutiveFailures = Math.min(consecutiveFailures + 1, 5);
      console.error(chainIndexFailureMessage(index, error));
    }
    const delay = chainIndexSyncDelay({failures:consecutiveFailures,complete:index.status().complete,
      progressed:index.indexedThrough>previousBlock || previousBackfill !== undefined
        && (index.eventTopicBackfill===null || index.eventTopicBackfill?.nextBlock>previousBackfill)});
    if (!stopped) timer = setTimeout(() => { running = tick(); }, delay);
  }
  const refreshDisplay=async()=>{
    await refreshDisplayCaches({displayCache,portfolioReads,displayEvents,isStopped:()=>stopped});
    if(!stopped && (displayCache || portfolioReads)) displayTimer=setTimeout(()=>void refreshDisplay(),15_000);
  };
  if(displayCache || portfolioReads) void refreshDisplay();
  running = tick();
  return { index, server, close() {
    if (closing) return closing;
    closing = (async () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      if(displayTimer) clearTimeout(displayTimer);
      displayEvents.close();
      // Cancel queued reads now. Active primary requests stay bounded by 12s;
      // logs requests by at most 30s, within the deployment's 45s stop allowance.
      for (const source of providers) source.destroy();
      await running;
      await displayCache?.close();
      await portfolioReads?.close();
      await new Promise(resolve => server.close(resolve));
      index.close();
    })();
    return closing;
  } };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const service = await startChainIndex(serverConfiguration());
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void service.close().then(() => process.exit(0)); });
}
