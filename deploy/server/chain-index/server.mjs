import { fileURLToPath } from 'node:url';
import { FetchRequest, JsonRpcProvider } from 'ethers';
import { ChainIndex } from './indexer.mjs';
import { createChainIndexServer } from './api.mjs';

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

export function serverConfiguration(env = process.env) {
  const rpc = required(env, 'CHAIN_INDEX_RPC_URL');
  if (!/^https:\/\//.test(rpc)) throw new Error('CHAIN_INDEX_RPC_URL must use HTTPS.');
  const logsRpc = env.CHAIN_INDEX_LOGS_RPC_URL || null;
  if (logsRpc && !/^https:\/\//.test(logsRpc)) throw new Error('CHAIN_INDEX_LOGS_RPC_URL must use HTTPS.');
  const host = env.CHAIN_INDEX_HOST || '127.0.0.1';
  if (host !== '127.0.0.1' && host !== '::1') throw new Error('Bind the index only to loopback; use an authenticated/rate-limited reverse proxy.');
  const port = exactNumber(env.CHAIN_INDEX_PORT || '4180', 'port');
  if (port < 1 || port > 65535) throw new Error('Invalid port.');
  const scanRange = exactNumber(env.CHAIN_INDEX_SCAN_RANGE ?? '100', 'scan range');
  if (scanRange < 1 || scanRange > 500) throw new Error('Scan range must be between 1 and 500 blocks.');
  return { rpc, logsRpc, host, port, dbPath: required(env, 'CHAIN_INDEX_DB'), factory: required(env, 'CHAIN_INDEX_FACTORY'),
    market: required(env, 'CHAIN_INDEX_MARKET'), startBlock: exactNumber(required(env, 'CHAIN_INDEX_START_BLOCK'), 'start block'),
    confirmations: exactNumber(env.CHAIN_INDEX_CONFIRMATIONS || '12', 'confirmations'), scanRange };
}

function readProvider(rpc) {
  const request = new FetchRequest(rpc);
  request.timeout = 12_000;
  // The sync loop retries failures; an upstream Retry-After must not hold shutdown open.
  request.retryFunc = async () => false;
  // ChainIndex asks eth_chainId directly on every sync before indexing any data.
  // The static network avoids ethers' separate, indefinitely retrying bootstrap loop.
  return new JsonRpcProvider(request, 56, {
    staticNetwork: true, cacheTimeout: -1, batchMaxCount: 8,
  });
}

export async function startChainIndex(config) {
  const primary = readProvider(config.rpc);
  const logs = config.logsRpc && config.logsRpc !== config.rpc ? readProvider(config.logsRpc) : primary;
  const providers = [...new Set([primary, logs])];
  const provider = Object.freeze({
    send: async (method, params) => {
      if (method === 'eth_chainId' && logs !== primary) {
        const [chainId, logsChainId] = await Promise.all([primary.send(method, params), logs.send(method, params)]);
        if (!/^0x[0-9a-f]+$/i.test(logsChainId) || BigInt(logsChainId) !== 56n)
          throw new Error('RPC is not BSC mainnet (56).');
        return chainId;
      }
      return primary.send(method, params);
    },
    call: primary.call.bind(primary),
    getBlock: primary.getBlock.bind(primary),
    getCode: primary.getCode.bind(primary),
    getLogs: logs.getLogs.bind(logs),
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
    catch { consecutiveFailures = Math.min(consecutiveFailures + 1, 5); console.error(`Chain index unavailable: ${index.status().unknownReason}`); }
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
      // Cancel queued reads now; any active HTTP request is bounded by its 12s timeout.
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
