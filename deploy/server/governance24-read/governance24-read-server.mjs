import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { createLiveDataProxy, liveDataProxyConfiguration } from '../upgrade-read/live-data-proxy.mjs';
import { createRequestLimiter } from '../upgrade-read/request-limiter.mjs';
import { createGovernance24ScheduledLogs, Governance24ReadError } from './scheduled-logs.mjs';

export const GOVERNANCE24_READ_PROXY_LIMITS = Object.freeze({ maxConcurrent: 4, maxConcurrentPerClient: 4,
  retryArchiveRateLimit: true, archiveReadStartIntervalMs: 100, archiveReadMaxConcurrent: 4, pinnedRpcTtlMs: 15 * 60 * 1000 });
export const GOVERNANCE24_REVIEW_ANCHOR_BLOCK = 126156767;

export function governance24ReadServerConfiguration(env = process.env) {
  const port = env.GOVERNANCE24_READ_PORT ?? '4230', anchor = env.GOVERNANCE24_REVIEW_ANCHOR_BLOCK;
  if (typeof port !== 'string' || !/^[1-9]\d*$/.test(port) || !Number.isSafeInteger(Number(port)) || Number(port) > 65535)
    throw new Error('GOVERNANCE24_READ_PORT must be an integer from 1 to 65535.');
  if (anchor !== String(GOVERNANCE24_REVIEW_ANCHOR_BLOCK))
    throw new Error('GOVERNANCE24_REVIEW_ANCHOR_BLOCK must match the reviewed positive block number.');
  const config = liveDataProxyConfiguration({ BEMINE_READ_RPC_URL: env.GOVERNANCE24_READ_RPC_URL,
    BEMINE_READ_TRANSACTION_RPC_URL: env.GOVERNANCE24_READ_TRANSACTION_RPC_URL });
  if (!config.rpcUrl || !config.transactionRpcUrl || config.transactionRpcUrl === config.rpcUrl)
    throw new Error('Governance24 reads require separate archive and transaction RPC destinations.');
  return { host: '127.0.0.1', port: Number(port), reviewAnchorBlock: Number(anchor), rpcUrl: config.rpcUrl, transactionRpcUrl: config.transactionRpcUrl };
}

async function body(req) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? '')
    || req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity') throw new Governance24ReadError(415, 'JSON content type without compression is required.');
  if (Number(req.headers['content-length'] ?? 0) > 65536) throw new Governance24ReadError(413, 'Request is too large.');
  return new Promise((resolveBody, reject) => {
    const chunks = []; let size = 0;
    const cleanup = () => { clearTimeout(timer); req.off('data', data); req.off('end', end); req.off('error', failed); req.off('aborted', aborted); };
    const failed = () => { cleanup(); req.pause(); reject(new Governance24ReadError(400, 'Request could not be read.')); };
    const aborted = () => failed();
    const data = chunk => { size += chunk.length; if (size > 65536) { cleanup(); req.pause(); reject(new Governance24ReadError(413, 'Request is too large.')); }
      else chunks.push(chunk); };
    const end = () => { cleanup(); const bytes = Buffer.concat(chunks); try { resolveBody({ payload: JSON.parse(bytes.toString('utf8')), bytes }); }
      catch { reject(new Governance24ReadError(400, 'Invalid JSON request.')); } };
    const timer = setTimeout(() => { cleanup(); req.pause(); reject(new Governance24ReadError(408, 'Request timed out.')); }, 10000);
    req.on('data', data); req.on('end', end); req.on('error', failed); req.on('aborted', aborted);
  });
}

/** Buffer once to select the scoped log handler; ordinary requests use the unchanged guarded proxy. */
export function createGovernance24ReadServer(proxy, scheduledLogs) {
  if (!proxy || typeof proxy.handle !== 'function' || typeof scheduledLogs !== 'function') throw new Error('Both reviewed read handlers are required.');
  const allow = createRequestLimiter({ perClient: 900 });
  return createServer(async (req, res) => {
    const send = (status, value) => { res.statusCode = status; res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff');
      if (status >= 400) res.setHeader('Connection', 'close'); res.end(JSON.stringify(value)); };
    try {
      if (typeof req.url !== 'string' || req.url.length > 2048 || !req.url.startsWith('/') || req.url.startsWith('//'))
        throw new Governance24ReadError(400, 'Invalid request URL.');
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname !== '/api/rpc') throw new Governance24ReadError(404, 'Not found.');
      if (req.method !== 'POST') throw new Governance24ReadError(405, 'RPC requires POST.');
      if (url.search || url.hash) throw new Governance24ReadError(400, 'RPC does not accept URL parameters.');
      if (!allow(req)) throw new Governance24ReadError(429, 'RPC request rate exceeded.');
      const { payload, bytes } = await body(req);
      if (payload?.method === 'eth_getLogs') return send(200, await scheduledLogs(payload, req));
      const replay = Readable.from([bytes]); Object.assign(replay, { headers: req.headers, method: req.method, url: req.url, socket: req.socket });
      await proxy.handle(replay, res);
    } catch (error) { if (!res.headersSent) send(error instanceof Governance24ReadError ? error.status : 502,
      { error: error instanceof Governance24ReadError ? error.message : 'Read-only RPC unavailable.' }); else res.destroy(); }
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const config = governance24ReadServerConfiguration();
  const proxy = createLiveDataProxy({ rpcUrl: config.rpcUrl, transactionRpcUrl: config.transactionRpcUrl,
    logsRpcUrl: config.rpcUrl, fallbackRpcUrl: null, ...GOVERNANCE24_READ_PROXY_LIMITS,
    onRpcDiagnostic: item => console.error(JSON.stringify({ event: 'governance24-read-rpc', ...item })) });
  const server = createGovernance24ReadServer(proxy, createGovernance24ScheduledLogs(config));
  server.listen(config.port, config.host, () => console.log(`Governance24 read RPC listening on ${config.host}:${config.port}`));
}
