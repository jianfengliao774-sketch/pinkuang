import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, extname, sep } from 'node:path';
import { proxyFirsto } from './firsto-proxy.mjs';
import { createJournalService, journalConfiguration } from './journal-api.mjs';

const root = fileURLToPath(new URL('../dist/', import.meta.url));
const types = {'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.woff2':'font/woff2'};
export function createDeploymentServer({ journalService } = {}) { return createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('Referrer-Policy','no-referrer');
  res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; connect-src 'self' https:; img-src 'self' data:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'");
  let pathname;
  try { pathname = new URL(req.url, 'http://localhost').pathname; }
  catch { res.statusCode = 400; res.end('Invalid request URL'); return; }
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

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { host, port } = serverConfiguration();
  // `npm start` serves real wallet actions, regardless of NODE_ENV. Only the
  // explicit Vite development integration may use local defaults.
  const journalService = createJournalService(journalConfiguration({ ...process.env, NODE_ENV: 'production' }));
  const server = createDeploymentServer({ journalService });
  server.listen(port, host, () => {
    console.log(`拼矿部署台：http://${host}:${port}`);
  });
  for (const signal of ['SIGINT','SIGTERM']) process.once(signal, () => {
    server.close(() => { void journalService.close().then(() => process.exit(0)); });
  });
}
