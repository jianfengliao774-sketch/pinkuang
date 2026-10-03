import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, extname, sep } from 'node:path';
import { proxyFirsto } from './firsto-proxy.mjs';
import { createJournalService, journalConfiguration } from './journal-api.mjs';
import { servedArtifactDigest } from './artifact-digest.mjs';
import { startOptionalNotifications } from './notifications/runtime.mjs';
import { createLiveDataProxy, liveDataProxyConfiguration } from './live-data-proxy.mjs';
import { authorityIpcConfiguration, createAuthorityRelayProxy,
  createGasSignerProofReader, createFreshProductReadinessReader } from './authority-ipc.mjs';

const root = fileURLToPath(new URL('../dist/', import.meta.url));
const types = {'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.woff2':'font/woff2'};
export function createDeploymentServer({ journalService, liveDataProxy, authorityRelayService } = {}) { return createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('Referrer-Policy','no-referrer');
  res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; connect-src 'self' https: wss://relay.walletconnect.com wss://relay.walletconnect.org; img-src 'self' data:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'");
  let pathname;
  try { pathname = new URL(req.url, 'http://localhost').pathname; }
  catch { res.statusCode = 400; res.end('Invalid request URL'); return; }
  if (pathname === '/api/journal/authority-relay' || pathname === '/api/journal/authority-relay/status') {
    if (authorityRelayService) authorityRelayService.handle(req, res);
    else { res.statusCode = 503; res.setHeader('Cache-Control', 'no-store'); res.end('Authority relay is not active'); }
    return;
  }
  if (pathname === '/api/rpc' || pathname.startsWith('/api/rpc/') || pathname === '/api/chain-index' || pathname.startsWith('/api/chain-index/')) {
    if (liveDataProxy) await liveDataProxy.handle(req, res);
    else { res.statusCode = 503; res.setHeader('Cache-Control', 'no-store'); res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(JSON.stringify({ error: 'Read-only data service is not configured.' })); }
    return;
  }
  if (pathname.startsWith('/api/journal/')) {
    if (journalService) journalService.handle(req, res);
    else { res.statusCode = 503; res.setHeader('Cache-Control', 'no-store'); res.end('Journal unavailable'); }
    return;
  }
  if (pathname.startsWith('/firsto-api/')) return proxyFirsto(req, res);
  if (!['GET','HEAD'].includes(req.method)) {res.statusCode=405;res.end();return;}
  try {
    const path = resolve(root, '.' + decodeURIComponent(pathname === '/' ? '/index.html' : pathname));
    if (!path.startsWith(root.endsWith(sep) ? root : root + sep)) throw new Error('Invalid path');
    const body = await readFile(path);
    res.setHeader('Content-Type',types[extname(path)] || 'application/octet-stream');
    res.setHeader('Cache-Control',pathname.startsWith('/assets/')?'public, max-age=31536000, immutable':'no-store');
    res.end(req.method==='HEAD'?undefined:body);
  } catch {res.statusCode=404;res.end('Not found');}
}); }

export function serverConfiguration(env = process.env) {
  const host = env.HOST || '127.0.0.1';
  const port = Number(env.PORT || 4173);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be 1–65535.');
  return { host, port };
}

/** Only fixed status names enter logs; never print tokens, chat IDs or transport errors. */
export function logNotificationStatus(value, log = console.error) {
  const messages = {
    startup_unavailable: 'Notification service unavailable; wallet actions remain independent.',
    source_or_delivery_unavailable: 'Private notification source or delivery unavailable.',
    outcome_unknown: 'Private notification outcome unknown; inspect the durable queue before resuming.',
    community_configuration_unavailable: 'Community announcements unavailable: configuration requires inspection.',
    community_source_or_delivery_unavailable: 'Community announcements unavailable: source or destination requires inspection.',
    community_delivery_blocked: 'Community announcement delivery blocked; inspect durable queue before resuming.',
    community_outcome_unknown: 'Community announcement outcome unknown; inspect the exact group topic before resuming.',
    community_degraded: 'Community announcements degraded: one or more pools require inspection.',
  };
  if (Object.hasOwn(messages, value?.status)) log(messages[value.status]);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { host, port } = serverConfiguration();
  if (process.env.AUTHORITY_RELAY_PUBLIC_ENABLED !== undefined
    && !['0', '1'].includes(process.env.AUTHORITY_RELAY_PUBLIC_ENABLED))
    throw new Error('AUTHORITY_RELAY_PUBLIC_ENABLED must be 0 or 1.');
  const ipc = authorityIpcConfiguration();
  if (process.env.AUTHORITY_RELAY_PUBLIC_ENABLED === '1' && !ipc)
    throw new Error('Public Authority relay requires the reviewed private socket.');
  const lastNotificationLog = new Map();
  // `npm start` serves real wallet actions, regardless of NODE_ENV. Only the
  // explicit Vite development integration may use local defaults.
  const notifications = await startOptionalNotifications({ ...process.env, NODE_ENV: 'production' }, {
    onStatus: status => logNotificationStatus(status, message => {
      const at = Date.now();
      if (at - (lastNotificationLog.get(message) ?? -Infinity) < 300_000) return;
      lastNotificationLog.set(message, at);
      console.error(message);
    }),
  });
  const journalConfig = journalConfiguration({ ...process.env, NODE_ENV: 'production' });
  const journalService = createJournalService({ ...journalConfig, notificationService: notifications,
    gasWalletProofReader: ipc ? createGasSignerProofReader(ipc) : undefined,
    freshProductReadinessReader: ipc ? createFreshProductReadinessReader(ipc) : undefined,
    currentArtifactDigest: () => servedArtifactDigest(resolve(root, 'deployment-artifacts.json')) });
  const liveDataProxy = createLiveDataProxy(liveDataProxyConfiguration(process.env, { freshProduct: journalConfig.freshProduct }));
  const authorityRelayService = process.env.AUTHORITY_RELAY_PUBLIC_ENABLED === '1'
    ? createAuthorityRelayProxy(ipc, {verifyOperationalReadiness:()=>journalService.verifyFreshOperationalReadiness()}) : null;
  const server = createDeploymentServer({ journalService, liveDataProxy, authorityRelayService });
  server.listen(port, host, () => {
    console.log(`拼矿部署台：http://${host}:${port}`);
  });
  for (const signal of ['SIGINT','SIGTERM']) process.once(signal, () => {
    server.close(() => { void Promise.all([journalService.close(), authorityRelayService?.close(),
      notifications?.close()]).then(() => process.exit(0)); });
  });
}
