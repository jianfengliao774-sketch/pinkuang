import { clientAddress, createRequestLimiter } from './request-limiter.mjs';

const ADDRESS = /^0x[\da-f]{40}$/i;
const QUANTITY = /^0x(?:0|[1-9a-f][\da-f]{0,63})$/i;
const DATA = /^0x(?:[\da-f]{2})*$/i;
const DECIMAL = /^(?:0|[1-9]\d*)$/;
const HASH = /^0x[\da-f]{64}$/i;
const BSC_CHAIN_ID = '0x38';
const MAX_HEADER_CACHE_ENTRIES = 64;
const MAX_CACHED_HEADER_BYTES = 64 * 1024;
const MAX_FEE_LOG_CACHE_ENTRIES = 64;
const MAX_CACHED_FEE_LOG_BYTES = 64 * 1024;
const FEE_LOG_CACHE_MS = 30_000;
export const FEES_CLAIMED_TOPIC = '0x1ac537f0ad67b64ac68a04587ff3a4cb6977de22eb2c37ee560897a92c6d07c7';
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const ownKeys = (value, allowed) => isRecord(value) && Object.keys(value).every(key => allowed.includes(key));
const BLOCK = value => ['latest', 'safe', 'finalized', 'earliest'].includes(value) || typeof value === 'string' && QUANTITY.test(value);

class ProxyError extends Error { constructor(status, message, { transportFailure = false } = {}) {
  super(message); this.status = status; this.transportFailure = transportFailure;
} }
const requireValue = (condition, status, message, options) => { if (!condition) throw new ProxyError(status, message, options); };

function upstreamUrl(value, name, { query = false } = {}) {
  if (!value) return null;
  let url;
  try { url = new URL(value); } catch { throw new Error(`${name} must be an HTTP(S) URL.`); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash || !query && url.search)
    throw new Error(`${name} must be a fixed HTTP(S) URL without credentials or fragments.`);
  return url.href;
}

/** Only operator environment chooses destinations; incoming URL/query/body never can. */
export function liveDataProxyConfiguration(env = process.env, { freshProduct } = {}) {
  const config = { rpcUrl: upstreamUrl(env.BEMINE_READ_RPC_URL || env.DEPLOYMENT_JOURNAL_RPC_URL, 'BEMINE_READ_RPC_URL', { query: true }),
    indexUrl: upstreamUrl(env.BEMINE_INDEX_URL || 'http://127.0.0.1:4180', 'BEMINE_INDEX_URL') };
  // Reuse the indexer's fixed log-capable destination. Ordinary product reads
  // may have a different RPC allowance even for a single-block log request.
  config.logsRpcUrl = env.CHAIN_INDEX_LOGS_RPC_URL
    ? upstreamUrl(env.CHAIN_INDEX_LOGS_RPC_URL, 'CHAIN_INDEX_LOGS_RPC_URL', { query: true }) : config.rpcUrl;
  config.fallbackRpcUrl = env.BEMINE_READ_FALLBACK_RPC_URL
    ? upstreamUrl(env.BEMINE_READ_FALLBACK_RPC_URL, 'BEMINE_READ_FALLBACK_RPC_URL', { query: true })
    : config.logsRpcUrl !== config.rpcUrl ? config.logsRpcUrl : null;
  if (freshProduct) config.feeHistoryLogScope = normalizeFeeHistoryScope({
    authority: freshProduct.manifest?.authority, deploymentBlock: freshProduct.manifest?.deployment?.blockNumber });
  return config;
}

function normalizeFeeHistoryScope(scope) {
  if (scope == null) return null;
  if (!ownKeys(scope, ['authority', 'deploymentBlock']) || typeof scope.authority !== 'string'
    || !ADDRESS.test(scope.authority) || BigInt(scope.authority) === 0n
    || !Number.isSafeInteger(scope.deploymentBlock) || scope.deploymentBlock < 1)
    throw new Error('Fee history requires the pinned fresh Authority and a positive genesis deployment block.');
  return Object.freeze({ authority: scope.authority.toLowerCase(), deploymentBlock: scope.deploymentBlock });
}

export function validateReadRpc(payload, { feeHistoryLogScope } = {}) {
  requireValue(ownKeys(payload, ['jsonrpc', 'id', 'method', 'params']) && payload.jsonrpc === '2.0'
    && (Number.isSafeInteger(payload.id) && payload.id >= 0 || typeof payload.id === 'string' && payload.id.length > 0 && payload.id.length <= 64)
    && Array.isArray(payload.params), 400, 'A single identified JSON-RPC request is required.');
  const p = payload.params;
  const valid = {
    eth_chainId: () => p.length === 0,
    eth_blockNumber: () => p.length === 0,
    eth_getTransactionByHash: () => p.length === 1 && typeof p[0] === 'string' && HASH.test(p[0]),
    eth_getTransactionReceipt: () => p.length === 1 && typeof p[0] === 'string' && HASH.test(p[0]),
    eth_getBlockByNumber: () => p.length === 2 && BLOCK(p[0]) && p[1] === false,
    eth_getCode: () => p.length === 2 && typeof p[0] === 'string' && ADDRESS.test(p[0]) && BLOCK(p[1]),
    eth_getStorageAt: () => p.length === 3 && typeof p[0] === 'string' && ADDRESS.test(p[0])
      && typeof p[1] === 'string' && QUANTITY.test(p[1]) && BLOCK(p[2]),
    eth_getLogs: () => {
      const scope = normalizeFeeHistoryScope(feeHistoryLogScope), filter = p[0];
      return p.length === 1 && ownKeys(filter, ['address', 'topics', 'fromBlock', 'toBlock'])
        && typeof filter.address === 'string' && filter.address.toLowerCase() === scope.authority
        && Array.isArray(filter.topics) && filter.topics.length === 1
        && typeof filter.topics[0] === 'string' && filter.topics[0].toLowerCase() === FEES_CLAIMED_TOPIC
        && typeof filter.fromBlock === 'string' && QUANTITY.test(filter.fromBlock)
        && typeof filter.toBlock === 'string' && QUANTITY.test(filter.toBlock)
        // Manifest deployment is the later Factory/genesis transaction, not
        // Authority creation. The client verifies that separate receipt; do
        // not discard legitimate earlier events from this exact Authority.
        && BigInt(filter.toBlock) >= BigInt(filter.fromBlock)
        && BigInt(filter.toBlock) - BigInt(filter.fromBlock) < 5000n;
    },
    eth_call: () => p.length === 2 && BLOCK(p[1]) && ownKeys(p[0], ['to', 'data', 'from', 'value', 'gas'])
      && typeof p[0].to === 'string' && ADDRESS.test(p[0].to) && typeof p[0].data === 'string'
      && DATA.test(p[0].data) && p[0].data.length <= 32770
      && (p[0].from === undefined || typeof p[0].from === 'string' && ADDRESS.test(p[0].from))
      && (p[0].value === undefined || typeof p[0].value === 'string' && QUANTITY.test(p[0].value))
      && (p[0].gas === undefined || typeof p[0].gas === 'string' && QUANTITY.test(p[0].gas) && BigInt(p[0].gas) <= 30000000n),
  };
  requireValue(Object.hasOwn(valid, payload.method), 403, 'RPC method is not enabled on this read-only endpoint.');
  requireValue(payload.method !== 'eth_getLogs' || feeHistoryLogScope, 403, 'Fee history logs are not enabled for this deployment.');
  requireValue(valid[payload.method](), 400, 'Invalid read-only RPC parameters.');
  if (payload.method === 'eth_getLogs') return { jsonrpc: '2.0', id: payload.id, method: payload.method,
    params: [{ address: feeHistoryLogScope.authority.toLowerCase(), topics: [FEES_CLAIMED_TOPIC],
      fromBlock: `0x${BigInt(p[0].fromBlock).toString(16)}`, toBlock: `0x${BigInt(p[0].toBlock).toString(16)}` }] };
  return { jsonrpc: '2.0', id: payload.id, method: payload.method,
    params: payload.method === 'eth_call' ? [{ ...p[0], gas: p[0].gas ?? '0x1c9c380' }, p[1]] : p };
}

function natural(value, max = Number.MAX_SAFE_INTEGER) {
  return typeof value === 'string' && DECIMAL.test(value) && Number.isSafeInteger(Number(value)) && Number(value) <= max;
}
export function validateIndexRequest(url) {
  const route = url.pathname.slice('/api/chain-index'.length);
  const routes = {
    '/health': [], '/v1/stats': [], '/v1/pools': ['cursor', 'limit'], '/v1/portfolios':['cursor','limit'],
    '/v1/display/pools': ['cursor','limit','account'], '/v1/display/stats': [],
    '/v1/display/portfolios': ['account','cursor','limit','mine'],
    '/v1/display/orders': ['pool','seller','active','cursor','limit'],
    '/v1/snapshot/pools': ['cursor', 'limit'], '/v1/snapshot/portfolios': ['cursor', 'limit'],
    '/v1/snapshot/stats': [], '/v1/snapshot/orders': ['pool', 'seller', 'active', 'cursor', 'limit'],
    '/v1/orders': ['pool', 'seller', 'active', 'cursor', 'limit'],
    '/v1/portfolio-orders':['pool','seller','active','cursor','limit'],
    '/v1/activity': ['pool', 'account', 'cursor', 'limit'],
    '/v1/yield': ['pool', 'account', 'days'],
  };
  const allowed = /^\/v1\/display\/pools\/0x[\da-f]{40}$/i.test(route) ? ['account']
    : /^\/v1\/display\/portfolios\/0x[\da-f]{40}$/i.test(route) ? ['account','children']
    : /^\/v1\/display\/positions\/0x[\da-f]{40}$/i.test(route) ? ['cursor','limit']
    : /^\/v1\/display\/sale-reference\/0x[\da-f]{40}$/i.test(route) ? []
    : /^\/v1\/display\/firsto-ask\/0x[\da-f]{40}$/i.test(route) ? []
    : /^\/v1\/snapshot\/pools\/0x[\da-f]{40}$/i.test(route) ? []
    : /^\/v1\/accounts\/0x[\da-f]{40}\/(pools|portfolios)$/i.test(route)
    || /^\/v1\/portfolios\/0x[\da-f]{40}\/children$/i.test(route) ? ['cursor', 'limit'] : routes[route];
  requireValue(allowed, 404, 'Unknown read-only index route.');
  const seen = new Set();
  for (const [key, value] of url.searchParams) {
    requireValue(allowed.includes(key) && !seen.has(key), 400, 'Unknown or duplicate index query parameter.'); seen.add(key);
    let valid = false;
    if (['pool', 'seller', 'account'].includes(key)) valid = ADDRESS.test(value);
    else if (['active','mine','children'].includes(key)) valid = value === 'true' || value === 'false';
    else if (key === 'limit') valid = natural(value, route === '/v1/display/portfolios' ? 20 : 50) && Number(value) > 0;
    else if (key === 'days') valid = natural(value, 90) && Number(value) > 0;
      else if (key === 'cursor') valid = ['/v1/orders','/v1/portfolio-orders','/v1/display/orders'].includes(route) ? /^[1-9]\d{0,77}$/.test(value) && BigInt(value) < 2n ** 256n
      : route === '/v1/activity' ? /^\d+:\d+:\d+$/.test(value) && value.split(':').every(n => natural(n)) : natural(value);
    requireValue(valid, 400, 'Invalid index query parameter.');
  }
  requireValue(route !== '/v1/yield' || seen.has('pool'), 400, 'A pool address is required.');
  requireValue(route !== '/v1/display/portfolios' || url.searchParams.get('mine') !== 'true' || seen.has('account'),
    400, 'An account is required for personal portfolio display.');
  return route;
}

function readJson(req, { maxBytes, timeoutMs }) {
  requireValue(/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? ''), 415, 'JSON content type is required.');
  requireValue(!req.headers['content-encoding'] || req.headers['content-encoding'] === 'identity', 415, 'Compressed requests are not supported.');
  requireValue(Number(req.headers['content-length'] || 0) <= maxBytes, 413, 'Request is too large.');
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    const cleanup = () => { clearTimeout(timer); req.off('data', data); req.off('end', end); req.off('error', error); req.off('aborted', aborted); };
    const error = reason => { cleanup(); req.pause(); reject(reason instanceof ProxyError ? reason : new ProxyError(400, 'Request could not be read.')); };
    const aborted = () => error(new ProxyError(400, 'Request was interrupted.'));
    const data = chunk => { size += chunk.length; if (size > maxBytes) return error(new ProxyError(413, 'Request is too large.')); chunks.push(chunk); };
    const end = () => { cleanup(); try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new ProxyError(400, 'Invalid JSON request.')); } };
    const timer = setTimeout(() => error(new ProxyError(408, 'Request timed out.')), timeoutMs);
    req.on('data', data); req.on('end', end); req.on('error', error); req.on('aborted', aborted);
  });
}

async function fetchJson(url, options, { fetcher, timeoutMs, maxResponseBytes }) {
  const controller = new AbortController(); let timer;
  const work = async () => {
    const response = await fetcher(url, { ...options, redirect: 'error', signal: controller.signal,
      headers: { Accept: 'application/json', ...(options.body ? { 'Content-Type': 'application/json' } : {}) } });
    requireValue(!response.redirected && ![301, 302, 303, 307, 308].includes(response.status), 502, 'Upstream redirects are not allowed.');
    requireValue(/\bapplication\/([\w.+-]*\+)?json\b/i.test(response.headers?.get('content-type') ?? ''), 502,
      'Upstream returned invalid JSON content.', { transportFailure: true });
    const declared = Number(response.headers?.get('content-length') || 0);
    requireValue(Number.isFinite(declared) && declared >= 0 && declared <= maxResponseBytes, 502, 'Upstream response exceeds its limit.');
    let text;
    if (response.body?.getReader) {
      const reader = response.body.getReader(), chunks = []; let size = 0;
      try { while (true) { const chunk = await reader.read(); if (chunk.done) break; size += chunk.value.byteLength;
        requireValue(size <= maxResponseBytes, 502, 'Upstream response exceeds its limit.'); chunks.push(Buffer.from(chunk.value)); } }
      catch (error) { void reader.cancel().catch(() => {}); throw error; }
      text = Buffer.concat(chunks).toString('utf8');
    } else { text = await response.text(); requireValue(Buffer.byteLength(text) <= maxResponseBytes, 502, 'Upstream response exceeds its limit.'); }
    let value; try { value = JSON.parse(text); } catch { throw new ProxyError(502, 'Upstream returned invalid JSON.', { transportFailure: true }); }
    requireValue(isRecord(value), 502, 'Upstream returned an invalid object.');
    return { status: response.status, value };
  };
  try {
    return await Promise.race([work(), new Promise((_, reject) => { timer = setTimeout(() => {
      controller.abort(); reject(new ProxyError(504, 'Read-only data service timed out.', { transportFailure: true })); }, timeoutMs); })]);
  } catch (error) { if (error instanceof ProxyError) throw error; throw new ProxyError(502, 'Read-only data service is unavailable.', { transportFailure: true }); }
  finally { clearTimeout(timer); controller.abort(); }
}

export function createLiveDataProxy({ rpcUrl, logsRpcUrl = rpcUrl, fallbackRpcUrl = logsRpcUrl !== rpcUrl ? logsRpcUrl : null,
  indexUrl = 'http://127.0.0.1:4180', fetcher = globalThis.fetch,
  timeoutMs = 10000, maxRequestBytes = 65536, maxResponseBytes = 1048576, maxConcurrent = 24,
  // A portfolio page can issue ~104 independent reads at once. Allow one
  // page's burst while bounding each client's share of the global wait queue.
  maxQueued = 128, maxQueuedPerClient = 96, maxConcurrentPerClient = 12, queueTimeoutMs = 8000,
  pinnedRpcTtlMs = 60000,
  chainIdTtlMs = 5000, headerTtlMs = 250, now = Date.now, feeHistoryLogScope } = {}) {
  rpcUrl = upstreamUrl(rpcUrl, 'rpcUrl', { query: true }); indexUrl = upstreamUrl(indexUrl, 'indexUrl');
  logsRpcUrl = upstreamUrl(logsRpcUrl, 'logsRpcUrl', { query: true });
  fallbackRpcUrl = upstreamUrl(fallbackRpcUrl, 'fallbackRpcUrl', { query: true });
  if (fallbackRpcUrl === rpcUrl) fallbackRpcUrl = null;
  feeHistoryLogScope = normalizeFeeHistoryScope(feeHistoryLogScope);
  for (const [key, value] of Object.entries({ timeoutMs, maxRequestBytes, maxResponseBytes, maxConcurrent,
    maxQueuedPerClient, maxConcurrentPerClient, queueTimeoutMs, pinnedRpcTtlMs, chainIdTtlMs, headerTtlMs }))
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${key} must be a positive integer.`);
  if (!Number.isSafeInteger(maxQueued) || maxQueued < 0) throw new Error('maxQueued must be a nonnegative integer.');
  if (chainIdTtlMs > 5000 || headerTtlMs > 1000) throw new Error('RPC identity and header cache TTLs exceed their reviewed limits.');
  let concurrent = 0;
  const activeClients = new Map();
  const queue = [];
  const queuedClients = new Map();
  let lastGrantedClient = null;
  const activeFor = client => activeClients.get(client) ?? 0;
  const queuedFor = client => queuedClients.get(client) ?? 0;
  const removeQueued = client => {
    const remaining=queuedFor(client)-1;
    if (remaining) queuedClients.set(client,remaining);
    else queuedClients.delete(client);
  };
  const enter = client => { concurrent++; activeClients.set(client, activeFor(client) + 1); lastGrantedClient=client; };
  const acquire = client => {
    if (concurrent < maxConcurrent && activeFor(client) < maxConcurrentPerClient) {
      enter(client); return Promise.resolve();
    }
    if (queue.length >= maxQueued) {
      // Preserve a place for a new visitor under a full queue. Evict only a
      // duplicate waiter from the largest client; active work is untouched.
      if (queuedFor(client) > 0) throw new ProxyError(503, 'Read-only data service is busy.');
      let victimClient=null, victimCount=1;
      for (const [key,count] of queuedClients) if (count>victimCount) {victimClient=key;victimCount=count;}
      if (!victimClient) throw new ProxyError(503, 'Read-only data service is busy.');
      const victimIndex=queue.findLastIndex(entry=>entry.client===victimClient);
      const [victim]=queue.splice(victimIndex,1);
      clearTimeout(victim.timer);removeQueued(victim.client);
      victim.reject(new ProxyError(429, 'RPC client queue limit exceeded; retry shortly.'));
    }
    requireValue(queuedFor(client) < maxQueuedPerClient, 429, 'RPC client queue limit exceeded; retry shortly.');
    return new Promise((resolve, reject) => {
      const entry = { client, resolve, reject, timer: null };
      entry.timer = setTimeout(() => {
        const position = queue.indexOf(entry);
        if (position !== -1) {queue.splice(position, 1);removeQueued(client);}
        reject(new ProxyError(503, 'Read-only data service is busy.'));
      }, queueTimeoutMs);
      queue.push(entry);
      queuedClients.set(client,queuedFor(client)+1);
    });
  };
  const release = client => {
    concurrent--;
    const remaining = activeFor(client) - 1;
    if (remaining) activeClients.set(client, remaining);
    else activeClients.delete(client);
    // Rotate clients while keeping FIFO within each client's own requests.
    // A newcomer admitted after queue pressure is served on the next free slot.
    while (concurrent < maxConcurrent) {
      const clients=[...new Set(queue.map(entry=>entry.client))];
      const start=clients.indexOf(lastGrantedClient);
      let nextClient=null;
      for(let offset=1;offset<=clients.length;offset++){
        const candidate=clients[(start+offset+clients.length)%clients.length];
        if(activeFor(candidate)<maxConcurrentPerClient){nextClient=candidate;break;}
      }
      if (!nextClient) break;
      const nextIndex=queue.findIndex(entry=>entry.client===nextClient);
      const [next] = queue.splice(nextIndex, 1);
      clearTimeout(next.timer);removeQueued(next.client);
      enter(next.client);
      next.resolve();
    }
  };
  const pinnedRpc = new Map(), headerRpc = new Map(), feeLogRpc = new Map(), pendingRpc = new Map(), observedHeaders = new Map();
  let verifiedChainUntil = 0, chainProof = null, chainEpoch = 0, forkEpoch = 0, headerSequence = 0;
  let fallbackChainUntil = 0, fallbackChainProof = null, primaryUnavailableUntil = 0;
  // Latest display calls and transaction receipts do not introduce a second
  // node into pinned block/cache proofs or the scoped fee-history path.
  const fallbackEligible = payload => ['eth_getTransactionByHash', 'eth_getTransactionReceipt'].includes(payload.method)
    || ['eth_call', 'eth_getCode'].includes(payload.method) && payload.params[1] === 'latest'
    || payload.method === 'eth_getStorageAt' && payload.params[2] === 'latest';
  const fetchRpcJson = async (destination, payload) => {
    const reply = await fetchJson(destination, { method: 'POST', body: JSON.stringify(payload) },
      { fetcher, timeoutMs, maxResponseBytes });
    // A JSON-RPC error is a business answer, even if a node uses HTTP 5xx for it.
    const rpcReply = Object.hasOwn(reply.value, 'jsonrpc') || Object.hasOwn(reply.value, 'id')
      || Object.hasOwn(reply.value, 'result') || isRecord(reply.value.error) && typeof reply.value.error.code === 'number';
    requireValue(rpcReply || reply.status !== 429 && reply.status < 500, 502,
      'Read-only RPC upstream is temporarily unavailable.', { transportFailure: true });
    return reply;
  };
  const ensureFallbackBscChain = async () => {
    requireValue(fallbackRpcUrl, 503, 'Read-only fallback RPC is not configured.');
    if (now() < fallbackChainUntil) return;
    if (!fallbackChainProof) {
      const proof = (async () => {
        try {
          const request = { jsonrpc: '2.0', id: 0, method: 'eth_chainId', params: [] };
          const { status, value } = await fetchRpcJson(fallbackRpcUrl, request);
          requireValue(status === 200 && value.jsonrpc === '2.0' && value.id === request.id
            && typeof value.result === 'string' && /^0x[\da-f]+$/i.test(value.result)
            && BigInt(value.result) === 56n && !Object.hasOwn(value, 'error'),
          502, 'Read-only fallback RPC is not BSC mainnet.');
          fallbackChainUntil = now() + chainIdTtlMs;
        } catch (error) { fallbackChainUntil = 0; throw error; }
      })();
      fallbackChainProof = proof;
      proof.finally(() => { if (fallbackChainProof === proof) fallbackChainProof = null; }).catch(() => {});
    }
    await fallbackChainProof;
  };
  const clearReadCaches = () => {
    pinnedRpc.clear(); headerRpc.clear(); feeLogRpc.clear(); pendingRpc.clear(); observedHeaders.clear(); chainEpoch++;
  };
  const canonicalBlockTag = tag => `0x${BigInt(tag).toString(16)}`;
  const pinnedKey = payload => ['eth_call', 'eth_getCode'].includes(payload.method) && QUANTITY.test(payload.params[1])
    ? JSON.stringify([payload.method, payload.params]) : null;
  const headerKey = payload => payload.method === 'eth_getBlockByNumber' && QUANTITY.test(payload.params[0])
    ? canonicalBlockTag(payload.params[0]) : null;
  const feeLogKey = payload => payload.method === 'eth_getLogs' ? JSON.stringify([payload.method, payload.params]) : null;
  const pinnedBlockKey = payload => {
    const tag = payload.method === 'eth_getStorageAt' ? payload.params[2]
      : ['eth_call', 'eth_getCode'].includes(payload.method) ? payload.params[1] : null;
    return typeof tag === 'string' && QUANTITY.test(tag) ? canonicalBlockTag(tag) : null;
  };
  const invalidateHeaderForPinnedRead = tag => {
    headerRpc.delete(tag);
    const pending = pendingRpc.get(tag);
    if (pending) {
      // A header started before (or during) a pinned read cannot certify the
      // chain after that read. Do not let the next check join or cache it.
      pending.invalidated = true;
      pendingRpc.delete(tag);
    }
  };
  const invalidateHeadersForLogRead = () => {
    // A caller's post-log canonical proof may be at a newer safe head, rather
    // than a range endpoint. It must not reuse a header begun before the logs.
    headerRpc.clear();
    for (const [key, entry] of pendingRpc) if (QUANTITY.test(key)) {
      entry.invalidated = true; pendingRpc.delete(key);
    }
  };
  const validFeeLogs = (rows, filter) => Array.isArray(rows) && rows.every(row => isRecord(row)
    && typeof row.address === 'string' && row.address.toLowerCase() === feeHistoryLogScope.authority
    && Array.isArray(row.topics) && row.topics.length === 2 && row.topics[0]?.toLowerCase() === FEES_CLAIMED_TOPIC
    && typeof row.topics[1] === 'string' && HASH.test(row.topics[1])
    && typeof row.data === 'string' && /^0x[\da-f]{128}$/i.test(row.data)
    && typeof row.blockNumber === 'string' && QUANTITY.test(row.blockNumber)
    && BigInt(row.blockNumber) >= BigInt(filter.fromBlock) && BigInt(row.blockNumber) <= BigInt(filter.toBlock)
    && HASH.test(row.blockHash ?? '') && HASH.test(row.transactionHash ?? '')
    && typeof row.logIndex === 'string' && QUANTITY.test(row.logIndex) && row.removed !== true);
  const validHeader = (header, requestedTag) => isRecord(header) && QUANTITY.test(header.number)
    && HASH.test(header.hash ?? '') && QUANTITY.test(header.timestamp)
    && (requestedTag === null || BigInt(header.number) === BigInt(requestedTag));
  const observeHeader = (header, sequence) => {
    if (!validHeader(header, null)) return false;
    const key = canonicalBlockTag(header.number), hash = header.hash.toLowerCase();
    const prior = observedHeaders.get(key);
    // A slower request cannot reinstate an old fork after a newer header has
    // already exposed a different canonical hash at the same height.
    if (prior && prior.sequence > sequence) return prior.hash === hash;
    if (prior && prior.hash !== hash) {
      // A same-height reorg invalidates both headers and calls pinned to the
      // old fork. Pending old-fork calls may finish, but must not return or
      // repopulate the cache after this newer header has been observed.
      headerRpc.delete(key);
      pinnedRpc.clear();
      feeLogRpc.clear();
      pendingRpc.clear();
      forkEpoch++;
    }
    observedHeaders.delete(key);
    observedHeaders.set(key, { hash, sequence });
    if (observedHeaders.size > MAX_HEADER_CACHE_ENTRIES) observedHeaders.delete(observedHeaders.keys().next().value);
    return true;
  };
  // A fixed BSC URL is still a configuration claim, not chain evidence. Verify
  // it upstream before answering locally, then recheck at most five seconds later.
  const ensureBscChain = async ({ allowFallback = false } = {}) => {
    if (now() < verifiedChainUntil) return rpcUrl;
    if (allowFallback && fallbackRpcUrl && now() < primaryUnavailableUntil) {
      await ensureFallbackBscChain();
      return fallbackRpcUrl;
    }
    if (!chainProof) {
      const proof = (async () => {
        try {
          const request = { jsonrpc: '2.0', id: 0, method: 'eth_chainId', params: [] };
          const { status, value } = await fetchRpcJson(rpcUrl, request);
          requireValue(status === 200 && value.jsonrpc === '2.0' && value.id === request.id
            && typeof value.result === 'string' && /^0x[\da-f]+$/i.test(value.result)
            && BigInt(value.result) === 56n && !Object.hasOwn(value, 'error'),
          502, 'Read-only RPC is not BSC mainnet.');
          verifiedChainUntil = now() + chainIdTtlMs;
          primaryUnavailableUntil = 0;
        } catch (error) {
          verifiedChainUntil = 0;
          clearReadCaches();
          throw error;
        }
      })();
      chainProof = proof;
      proof.finally(() => { if (chainProof === proof) chainProof = null; }).catch(() => {});
    }
    try { await chainProof; return rpcUrl; }
    catch (error) {
      if (!allowFallback || !fallbackRpcUrl || !error.transportFailure) throw error;
      await ensureFallbackBscChain();
      // This remembers a transport outage only. It never establishes the
      // primary identity or allows pinned/header reads to use the backup.
      primaryUnavailableUntil = now() + chainIdTtlMs;
      return fallbackRpcUrl;
    }
  };
  const readRpc = async (payload, key, { rpcDestination = rpcUrl, allowTransportFallback = false } = {}) => {
    let entry = key && pendingRpc.get(key);
    if (!entry) {
      const epoch = chainEpoch, startedForkEpoch = forkEpoch;
      const sequence = ['eth_getBlockByNumber', 'eth_getLogs'].includes(payload.method) ? ++headerSequence : 0;
      const created = { pending: null, epoch, forkEpoch: startedForkEpoch, invalidated: false,
        isFeeLog: payload.method === 'eth_getLogs' };
      created.pending = (async () => {
        const destination = created.isFeeLog ? logsRpcUrl : rpcDestination;
        const dataRead = created.isFeeLog || !allowTransportFallback
          ? fetchJson(destination, { method: 'POST', body: JSON.stringify(payload) }, { fetcher, timeoutMs, maxResponseBytes })
          : (async () => {
            try { return await fetchRpcJson(destination, payload); }
            catch (error) {
              if (destination !== rpcUrl || !fallbackRpcUrl || !error.transportFailure) throw error;
              await ensureFallbackBscChain();
              // Exactly one secondary data request. Contract errors, invalid
              // envelopes and a failed backup are returned without retrying.
              return fetchRpcJson(fallbackRpcUrl, payload);
            }
          })();
        let response;
        if (created.isFeeLog && logsRpcUrl !== rpcUrl) {
          const tag = payload.params[0].toBlock;
          const request = { jsonrpc: '2.0', id: 0, method: 'eth_getBlockByNumber', params: [tag, false] };
          const readAnchor = async url => {
            const { status, value } = await fetchJson(url, { method: 'POST', body: JSON.stringify(request) },
              { fetcher, timeoutMs, maxResponseBytes });
            requireValue(status === 200 && value.jsonrpc === '2.0' && value.id === request.id
              && Object.hasOwn(value, 'result') && !Object.hasOwn(value, 'error') && validHeader(value.result, tag),
            502, 'Fee history range is not available on both BSC nodes.');
            return value.result;
          };
          try {
            // The primary BSC proof plus this exact block hash identifies the
            // logs node's range, even when its standalone chainId is unavailable.
            // Prove empty ranges too; these reads run in parallel with the logs.
            const [data, primary, logs] = await Promise.all([dataRead, readAnchor(rpcUrl), readAnchor(logsRpcUrl)]);
            requireValue(primary.hash.toLowerCase() === logs.hash.toLowerCase()
              && observeHeader(primary, sequence), 502, 'Fee history nodes disagree on the requested canonical block.');
            response = data;
          } catch (error) { if (key) feeLogRpc.delete(key); throw error; }
        } else response = await dataRead;
        const { status, value } = response;
        requireValue(status === 200 && value.jsonrpc === '2.0' && value.id === payload.id
          && (Object.hasOwn(value, 'result') !== Object.hasOwn(value, 'error')), 502, 'RPC response did not match the read request.');
        const normalized = value.error ? { error: { code: -32000, message: 'Upstream rejected the read request.' } } : { result: value.result };
        if (payload.method === 'eth_getLogs' && !value.error)
          requireValue(validFeeLogs(normalized.result, payload.params[0]), 502, 'Upstream fee history is outside the pinned event scope.');
        const canonical = !created.invalidated && epoch === chainEpoch && payload.method === 'eth_getBlockByNumber'
          && observeHeader(normalized.result, sequence);
        return { value: normalized, canonical };
      })();
      entry = created;
      if (key) pendingRpc.set(key, entry);
    }
    try {
      const { value, canonical } = await entry.pending;
        // A different caller's pinned read invalidates this header for cache
        // reuse, but the header remains a valid answer to its original caller.
        // That caller must perform its own post-read header check if needed.
      requireValue(entry.epoch === chainEpoch, 502, 'Read-only RPC chain changed during request.');
      if (payload.method !== 'eth_getBlockByNumber')
        requireValue(entry.forkEpoch === forkEpoch, 502, 'Read-only RPC fork changed during request.');
      if (key && canonical && chainEpoch === entry.epoch && entry.forkEpoch === forkEpoch && now() < verifiedChainUntil
        && payload.method === 'eth_getBlockByNumber' && validHeader(value.result, payload.params[0])
        && Buffer.byteLength(JSON.stringify(value.result)) <= MAX_CACHED_HEADER_BYTES) {
        const tag = canonicalBlockTag(payload.params[0]);
        headerRpc.delete(tag);
        headerRpc.set(tag, { value, hash: value.result.hash.toLowerCase(), until: now() + headerTtlMs });
        if (headerRpc.size > MAX_HEADER_CACHE_ENTRIES) headerRpc.delete(headerRpc.keys().next().value);
      } else if (key && payload.method === 'eth_getLogs' && Array.isArray(value.result)
        && chainEpoch === entry.epoch && entry.forkEpoch === forkEpoch && now() < verifiedChainUntil
        && Buffer.byteLength(JSON.stringify(value.result)) <= MAX_CACHED_FEE_LOG_BYTES) {
        feeLogRpc.delete(key);
        feeLogRpc.set(key, { value, until: now() + FEE_LOG_CACHE_MS });
        if (feeLogRpc.size > MAX_FEE_LOG_CACHE_ENTRIES) feeLogRpc.delete(feeLogRpc.keys().next().value);
      } else if (key && payload.method !== 'eth_getBlockByNumber' && payload.method !== 'eth_getLogs'
        && chainEpoch === entry.epoch && entry.forkEpoch === forkEpoch && now() < verifiedChainUntil
        && typeof value.result === 'string' && value.result.length <= 65536) {
        pinnedRpc.delete(key);
        pinnedRpc.set(key, { value, until: now() + pinnedRpcTtlMs });
        if (pinnedRpc.size > 256) pinnedRpc.delete(pinnedRpc.keys().next().value);
      }
      return value;
    } finally { if (key && pendingRpc.get(key) === entry) pendingRpc.delete(key); }
  };
  // A single verified budget page can issue more than 300 independent reads
  // on first load. The bounded queue still caps concurrent upstream work.
  const allowRpc = createRequestLimiter({ perClient: 900 });
  return Object.freeze({ async handle(req, res) {
    const send = (status, value) => { res.statusCode = status; res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff');
      if (status >= 400) res.setHeader('Connection', 'close'); res.end(JSON.stringify(value)); };
    let acquired = false;
    const client = clientAddress(req);
    try {
      requireValue(typeof req.url === 'string' && req.url.length <= 2048 && req.url.startsWith('/') && !req.url.startsWith('//'), 400, 'Invalid request URL.');
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname === '/api/rpc') {
        requireValue(allowRpc(req), 429, 'RPC request rate exceeded; retry shortly.');
        requireValue(req.method === 'POST', 405, 'RPC requires POST.');
        requireValue(!url.search && !url.hash, 400, 'RPC does not accept URL parameters.');
        requireValue(rpcUrl, 503, 'Read-only RPC is not configured.');
        const payload = validateReadRpc(await readJson(req, { maxBytes: maxRequestBytes, timeoutMs }), { feeHistoryLogScope });
        if (payload.method === 'eth_chainId' && now() < verifiedChainUntil)
          return send(200, { jsonrpc: '2.0', id: payload.id, result: BSC_CHAIN_ID });
        await acquire(client); acquired = true;
        if (payload.method === 'eth_chainId') {
          await ensureBscChain({ allowFallback: true });
          return send(200, { jsonrpc: '2.0', id: payload.id, result: BSC_CHAIN_ID });
        }
        const pinned = pinnedKey(payload), header = headerKey(payload), feeLog = feeLogKey(payload), key = pinned ?? header ?? feeLog;
        const allowTransportFallback = fallbackEligible(payload);
        const rpcDestination = await ensureBscChain({ allowFallback: allowTransportFallback });
        if (feeLog) requireValue(logsRpcUrl, 503, 'Read-only fee history RPC is not configured.');
        // A caller can use the next header as its post-read canonical check.
        // Do not answer that check from a header cached before a pinned read.
        const readBlock = pinnedBlockKey(payload);
        if (readBlock) invalidateHeaderForPinnedRead(readBlock);
        if (feeLog) invalidateHeadersForLogRead();
        const cache = pinned ? pinnedRpc : header ? headerRpc : feeLog ? feeLogRpc : null;
        const cached = cache?.get(key);
        const hit = cached && now() < cached.until;
        if (!hit && cached) cache.delete(key);
        const value = hit ? cached.value : await readRpc(payload, key, { rpcDestination, allowTransportFallback });
        if (hit) res.setHeader('X-Bemine-Server-Cache', 'hit');
        if (readBlock) invalidateHeaderForPinnedRead(readBlock);
        if (feeLog) invalidateHeadersForLogRead();
        return send(200, { jsonrpc: '2.0', id: payload.id, ...value });
      }
      requireValue(url.pathname.startsWith('/api/chain-index/'), 404, 'Unknown data route.');
      requireValue(req.method === 'GET', 405, 'Index requires GET.');
      const route = validateIndexRequest(url);
      requireValue(indexUrl, 503, 'Read-only index is not configured.');
      await acquire(client); acquired = true;
      const upstream = new URL(`${indexUrl.replace(/\/$/, '')}${route}`); upstream.search = url.search;
      const { status, value } = await fetchJson(upstream.href, { method: 'GET' }, { fetcher, timeoutMs, maxResponseBytes });
      requireValue([200, 400, 503].includes(status), 502, 'Read-only index is unavailable.');
      return send(status, value);
    } catch (error) { if (!res.destroyed && !res.writableEnded) send(error instanceof ProxyError ? error.status : 502,
      { error: error instanceof ProxyError ? error.message : 'Read-only data service is unavailable.' }); }
    finally { if (acquired) release(client); }
  } });
}
