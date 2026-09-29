import { fileURLToPath } from 'node:url';
import { FetchRequest, JsonRpcProvider } from 'ethers';
import { ChainIndex } from './indexer.mjs';
import { createChainIndexServer } from './api.mjs';
import { loadFreshIndexManifest } from './fresh-manifest.mjs';

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

export function serverConfiguration(env = process.env) {
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
  const mode=env.CHAIN_INDEX_MODE || 'legacy';
  if (!['legacy','fresh-v4'].includes(mode)) throw new Error('Invalid chain-index mode.');
  const dbPath=required(env,'CHAIN_INDEX_DB');
  if (mode==='fresh-v4') {
    for (const key of ['CHAIN_INDEX_FACTORY','CHAIN_INDEX_MARKET','CHAIN_INDEX_PORTFOLIO_FACTORY',
      'CHAIN_INDEX_PORTFOLIO_MARKET','CHAIN_INDEX_START_BLOCK','CHAIN_INDEX_RESERVATION_MODE']) {
      if (env[key] !== undefined) throw new Error(`${key} cannot override the fresh manifest.`);
    }
    if (env.NODE_ENV==='production' && dbPath!=='/var/lib/pinkuang-index-v4/index.sqlite')
      throw new Error('Fresh v4 index requires its independent database path.');
    const manifestPath=required(env,'CHAIN_INDEX_FRESH_MANIFEST_PATH');
    if (env.NODE_ENV==='production' && !/^\/srv\/pinkuang-deploy-v4\/releases\/v4-[a-z0-9][a-z0-9-]{1,70}\/public\/fresh-product-manifest\.json$/.test(manifestPath))
      throw new Error('Fresh v4 index requires a release-pinned manifest path.');
    const manifest=loadFreshIndexManifest(manifestPath,
      required(env,'CHAIN_INDEX_FRESH_MANIFEST_SHA256'));
    return {rpc,logsRpc,fallbackLogsRpc,logsTimeoutMs:logsTimeout(env.CHAIN_INDEX_LOGS_TIMEOUT_MS),
      host,port,dbPath,scanRange,confirmations:exactNumber(env.CHAIN_INDEX_CONFIRMATIONS || '12','confirmations'),
      factory:manifest.factory,market:manifest.shareMarket,
      portfolioFactory:manifest.portfolioFactory,portfolioMarket:manifest.portfolioMarket,
      startBlock:manifest.deployment.blockNumber,reservationMode:'required'};
  }
  if(Boolean(env.CHAIN_INDEX_PORTFOLIO_FACTORY)!==Boolean(env.CHAIN_INDEX_PORTFOLIO_MARKET))throw new Error('Configure both portfolio Factory and market.');
  const reservationMode=env.CHAIN_INDEX_RESERVATION_MODE || 'legacy';
  if (!['legacy','required'].includes(reservationMode)) throw new Error('Invalid chain-index reservation mode.');
  if (reservationMode==='required' && !env.CHAIN_INDEX_PORTFOLIO_FACTORY)
    throw new Error('Reservation proofs require the integrated portfolio Factory.');
  return { rpc, logsRpc, fallbackLogsRpc, logsTimeoutMs: logsTimeout(env.CHAIN_INDEX_LOGS_TIMEOUT_MS), host, port, dbPath, factory: required(env, 'CHAIN_INDEX_FACTORY'),
    ...(env.CHAIN_INDEX_PORTFOLIO_FACTORY?{portfolioFactory:env.CHAIN_INDEX_PORTFOLIO_FACTORY,portfolioMarket:env.CHAIN_INDEX_PORTFOLIO_MARKET}:{}),
    reservationMode,
    market: required(env, 'CHAIN_INDEX_MARKET'), startBlock: exactNumber(required(env, 'CHAIN_INDEX_START_BLOCK'), 'start block'),
    confirmations: exactNumber(env.CHAIN_INDEX_CONFIRMATIONS || '12', 'confirmations'), scanRange };
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
        const proof = Promise.all([primary.getBlock(filter.toBlock), source.getBlock(filter.toBlock)]).then(([canonical, served]) => {
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
        const ids = await Promise.all(providers.map(source => source.send(method, params)));
        if (ids.some(id => !/^0x[0-9a-f]+$/i.test(id) || BigInt(id) !== 56n))
          throw new Error('RPC is not BSC mainnet (56).');
        return ids[0];
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
  try {
    index = new ChainIndex(provider, config);
    server = createChainIndexServer(index);
    await new Promise((resolve, reject) => {
      const onError = error => { server.off('listening', onListening); reject(error); };
      const onListening = () => { server.off('error', onError); resolve(); };
      server.once('error', onError);
      server.once('listening', onListening);
      try { server.listen(config.port, config.host); }
      catch (error) { server.off('error', onError); server.off('listening', onListening); reject(error); }
    });
  } catch (error) {
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
    try { await index.sync(); consecutiveFailures = 0; }
    catch (error) {
      consecutiveFailures = Math.min(consecutiveFailures + 1, 5);
      console.error(chainIndexFailureMessage(index, error));
    }
    const delay = consecutiveFailures ? Math.min(60_000, 4_000 * 2 ** (consecutiveFailures - 1))
      : index.status().complete ? 10_000 : 1_000;
    if (!stopped) timer = setTimeout(() => { running = tick(); }, delay);
  }
  running = tick();
  return { index, server, close() {
    if (closing) return closing;
    closing = (async () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      // Cancel queued reads now. Active primary requests stay bounded by 12s;
      // logs requests by at most 30s, within the deployment's 45s stop allowance.
      for (const source of providers) source.destroy();
      await running;
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
