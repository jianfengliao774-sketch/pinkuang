import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { createLiveDataProxy, liveDataProxyConfiguration } from './live-data-proxy.mjs';

export const TARGET_OWNER_READ_PROXY_LIMITS = Object.freeze({
  maxConcurrent: 4, maxConcurrentPerClient: 4, retryArchiveRateLimit: true,
  archiveReadStartIntervalMs: 100, archiveReadMaxConcurrent: 4,
  pinnedRpcTtlMs: 15 * 60 * 1000,
});

export function targetOwnerReadServerConfiguration(env = process.env) {
  const raw = env.TARGET_OWNER_READ_PORT ?? '4228';
  if (typeof raw !== 'string' || !/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) > 65535)
    throw new Error('TARGET_OWNER_READ_PORT must be an integer from 1 to 65535.');
  return { host: '127.0.0.1', port: Number(raw) };
}

/** The upgrade entry exposes one read route and cannot inherit journal, index or static handlers. */
export function createTargetOwnerReadServer(liveDataProxy) {
  if (!liveDataProxy || typeof liveDataProxy.handle !== 'function') throw new Error('A read-only RPC proxy is required.');
  return createServer(async (req, res) => {
    let pathname;
    try { pathname = new URL(req.url, 'http://localhost').pathname; }
    catch { res.statusCode = 400; res.end('Invalid request URL'); return; }
    if (pathname !== '/api/rpc') { res.statusCode = 404; res.end('Not found'); return; }
    try { await liveDataProxy.handle(req, res); }
    catch {
      if (!res.headersSent) { res.statusCode = 502; res.end('Read-only RPC unavailable'); }
      else res.destroy();
    }
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { host, port } = targetOwnerReadServerConfiguration();
  const config = liveDataProxyConfiguration(process.env);
  if (!process.env.BEMINE_READ_RPC_URL || !config.rpcUrl || !config.transactionRpcUrl
    || config.transactionRpcUrl === config.rpcUrl)
    throw new Error('Target-owner reads require separate archive and transaction RPC destinations.');
  // This entry does not inherit product/index fallbacks. Every state, code and
  // header proof stays on the configured archive node; fee logs are disabled.
  const server = createTargetOwnerReadServer(createLiveDataProxy({ rpcUrl: config.rpcUrl,
    transactionRpcUrl: config.transactionRpcUrl, logsRpcUrl: config.rpcUrl, fallbackRpcUrl: null,
    ...TARGET_OWNER_READ_PROXY_LIMITS,
    onRpcDiagnostic: item => console.error(JSON.stringify({ event: 'target-owner-read-rpc', ...item })) }));
  server.listen(port, host, () => console.log(`Target-owner read RPC listening on ${host}:${port}`));
}
