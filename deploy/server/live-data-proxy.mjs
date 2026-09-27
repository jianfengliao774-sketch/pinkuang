const ADDRESS = /^0x[\da-f]{40}$/i;
const QUANTITY = /^0x(?:0|[1-9a-f][\da-f]{0,63})$/i;
const DATA = /^0x(?:[\da-f]{2})*$/i;
const DECIMAL = /^(?:0|[1-9]\d*)$/;
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const ownKeys = (value, allowed) => isRecord(value) && Object.keys(value).every(key => allowed.includes(key));
const BLOCK = value => ['latest', 'safe', 'finalized', 'earliest'].includes(value) || typeof value === 'string' && QUANTITY.test(value);

class ProxyError extends Error { constructor(status, message) { super(message); this.status = status; } }
const requireValue = (condition, status, message) => { if (!condition) throw new ProxyError(status, message); };

function upstreamUrl(value, name, { query = false } = {}) {
  if (!value) return null;
  let url;
  try { url = new URL(value); } catch { throw new Error(`${name} must be an HTTP(S) URL.`); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash || !query && url.search)
    throw new Error(`${name} must be a fixed HTTP(S) URL without credentials or fragments.`);
  return url.href;
}

/** Only operator environment chooses destinations; incoming URL/query/body never can. */
export function liveDataProxyConfiguration(env = process.env) {
  return { rpcUrl: upstreamUrl(env.BEMINE_READ_RPC_URL || env.DEPLOYMENT_JOURNAL_RPC_URL, 'BEMINE_READ_RPC_URL', { query: true }),
    indexUrl: upstreamUrl(env.BEMINE_INDEX_URL || 'http://127.0.0.1:4180', 'BEMINE_INDEX_URL') };
}

export function validateReadRpc(payload) {
  requireValue(ownKeys(payload, ['jsonrpc', 'id', 'method', 'params']) && payload.jsonrpc === '2.0'
    && (Number.isSafeInteger(payload.id) && payload.id >= 0 || typeof payload.id === 'string' && payload.id.length > 0 && payload.id.length <= 64)
    && Array.isArray(payload.params), 400, 'A single identified JSON-RPC request is required.');
  const p = payload.params;
  const valid = {
    eth_chainId: () => p.length === 0,
    eth_blockNumber: () => p.length === 0,
    eth_getBlockByNumber: () => p.length === 2 && BLOCK(p[0]) && p[1] === false,
    eth_getCode: () => p.length === 2 && typeof p[0] === 'string' && ADDRESS.test(p[0]) && BLOCK(p[1]),
    eth_getStorageAt: () => p.length === 3 && typeof p[0] === 'string' && ADDRESS.test(p[0])
      && typeof p[1] === 'string' && QUANTITY.test(p[1]) && BLOCK(p[2]),
    eth_call: () => p.length === 2 && BLOCK(p[1]) && ownKeys(p[0], ['to', 'data', 'from', 'value', 'gas'])
      && typeof p[0].to === 'string' && ADDRESS.test(p[0].to) && typeof p[0].data === 'string'
      && DATA.test(p[0].data) && p[0].data.length <= 32770
      && (p[0].from === undefined || typeof p[0].from === 'string' && ADDRESS.test(p[0].from))
      && (p[0].value === undefined || typeof p[0].value === 'string' && QUANTITY.test(p[0].value))
      && (p[0].gas === undefined || typeof p[0].gas === 'string' && QUANTITY.test(p[0].gas) && BigInt(p[0].gas) <= 30000000n),
  };
  requireValue(Object.hasOwn(valid, payload.method), 403, 'RPC method is not enabled on this read-only endpoint.');
  requireValue(valid[payload.method](), 400, 'Invalid read-only RPC parameters.');
  return { jsonrpc: '2.0', id: payload.id, method: payload.method,
    params: payload.method === 'eth_call' ? [{ ...p[0], gas: p[0].gas ?? '0x1c9c380' }, p[1]] : p };
}

function natural(value, max = Number.MAX_SAFE_INTEGER) {
  return typeof value === 'string' && DECIMAL.test(value) && Number.isSafeInteger(Number(value)) && Number(value) <= max;
}
export function validateIndexRequest(url) {
  const route = url.pathname.slice('/api/chain-index'.length);
  const routes = {
    '/health': [], '/v1/stats': [], '/v1/pools': ['cursor', 'limit'],
    '/v1/orders': ['pool', 'seller', 'active', 'cursor', 'limit'],
    '/v1/activity': ['pool', 'account', 'cursor', 'limit'],
    '/v1/yield': ['pool', 'account', 'days'],
  };
  const allowed = /^\/v1\/accounts\/0x[\da-f]{40}\/pools$/i.test(route) ? ['cursor', 'limit'] : routes[route];
  requireValue(allowed, 404, 'Unknown read-only index route.');
  const seen = new Set();
  for (const [key, value] of url.searchParams) {
    requireValue(allowed.includes(key) && !seen.has(key), 400, 'Unknown or duplicate index query parameter.'); seen.add(key);
    let valid = false;
    if (['pool', 'seller', 'account'].includes(key)) valid = ADDRESS.test(value);
    else if (key === 'active') valid = value === 'true' || value === 'false';
    else if (key === 'limit') valid = natural(value, 50) && Number(value) > 0;
    else if (key === 'days') valid = natural(value, 90) && Number(value) > 0;
    else if (key === 'cursor') valid = route === '/v1/orders' ? /^[1-9]\d{0,77}$/.test(value) && BigInt(value) < 2n ** 256n
      : route === '/v1/activity' ? /^\d+:\d+:\d+$/.test(value) && value.split(':').every(n => natural(n)) : natural(value);
    requireValue(valid, 400, 'Invalid index query parameter.');
  }
  requireValue(route !== '/v1/yield' || seen.has('pool'), 400, 'A pool address is required.');
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
    requireValue(/\bapplication\/([\w.+-]*\+)?json\b/i.test(response.headers?.get('content-type') ?? ''), 502, 'Upstream returned invalid JSON content.');
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
    let value; try { value = JSON.parse(text); } catch { throw new ProxyError(502, 'Upstream returned invalid JSON.'); }
    requireValue(isRecord(value), 502, 'Upstream returned an invalid object.');
    return { status: response.status, value };
  };
  try {
    return await Promise.race([work(), new Promise((_, reject) => { timer = setTimeout(() => {
      controller.abort(); reject(new ProxyError(504, 'Read-only data service timed out.')); }, timeoutMs); })]);
  } catch (error) { if (error instanceof ProxyError) throw error; throw new ProxyError(502, 'Read-only data service is unavailable.'); }
  finally { clearTimeout(timer); controller.abort(); }
}

export function createLiveDataProxy({ rpcUrl, indexUrl = 'http://127.0.0.1:4180', fetcher = globalThis.fetch,
  timeoutMs = 10000, maxRequestBytes = 65536, maxResponseBytes = 1048576, maxConcurrent = 24 } = {}) {
  rpcUrl = upstreamUrl(rpcUrl, 'rpcUrl', { query: true }); indexUrl = upstreamUrl(indexUrl, 'indexUrl');
  for (const [key, value] of Object.entries({ timeoutMs, maxRequestBytes, maxResponseBytes, maxConcurrent }))
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${key} must be a positive integer.`);
  let concurrent = 0;
  return Object.freeze({ async handle(req, res) {
    const send = (status, value) => { res.statusCode = status; res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff');
      if (status >= 400) res.setHeader('Connection', 'close'); res.end(JSON.stringify(value)); };
    let acquired = false;
    try {
      requireValue(typeof req.url === 'string' && req.url.length <= 2048 && req.url.startsWith('/') && !req.url.startsWith('//'), 400, 'Invalid request URL.');
      const url = new URL(req.url, 'http://localhost');
      requireValue(concurrent < maxConcurrent, 503, 'Read-only data service is busy.'); concurrent++; acquired = true;
      if (url.pathname === '/api/rpc') {
        requireValue(req.method === 'POST', 405, 'RPC requires POST.');
        requireValue(!url.search && !url.hash, 400, 'RPC does not accept URL parameters.');
        requireValue(rpcUrl, 503, 'Read-only RPC is not configured.');
        const payload = validateReadRpc(await readJson(req, { maxBytes: maxRequestBytes, timeoutMs }));
        const { status, value } = await fetchJson(rpcUrl, { method: 'POST', body: JSON.stringify(payload) }, { fetcher, timeoutMs, maxResponseBytes });
        requireValue(status === 200 && value.jsonrpc === '2.0' && value.id === payload.id
          && (Object.hasOwn(value, 'result') !== Object.hasOwn(value, 'error')), 502, 'RPC response did not match the read request.');
        return send(200, value.error ? { jsonrpc: '2.0', id: payload.id, error: { code: -32000, message: 'Upstream rejected the read request.' } }
          : { jsonrpc: '2.0', id: payload.id, result: value.result });
      }
      requireValue(url.pathname.startsWith('/api/chain-index/'), 404, 'Unknown data route.');
      requireValue(req.method === 'GET', 405, 'Index requires GET.');
      const route = validateIndexRequest(url);
      requireValue(indexUrl, 503, 'Read-only index is not configured.');
      const upstream = new URL(`${indexUrl.replace(/\/$/, '')}${route}`); upstream.search = url.search;
      const { status, value } = await fetchJson(upstream.href, { method: 'GET' }, { fetcher, timeoutMs, maxResponseBytes });
      requireValue([200, 400, 503].includes(status), 502, 'Read-only index is unavailable.');
      return send(status, value);
    } catch (error) { if (!res.destroyed && !res.writableEnded) send(error instanceof ProxyError ? error.status : 502,
      { error: error instanceof ProxyError ? error.message : 'Read-only data service is unavailable.' }); }
    finally { if (acquired) concurrent--; }
  } });
}
