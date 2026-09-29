import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer as createHttpServer, request as httpRequest } from 'node:http';
import { chmodSync, existsSync, lstatSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { Readable } from 'node:stream';
import { getAddress } from 'ethers';
import { JournalStore } from './journal-store.mjs';

export const AUTHORITY_SOCKET = '/run/pinkuang-v4-relay/authority.sock';
const ROUTES = new Map([
  ['/api/journal/authority-relay', 'POST'],
  ['/api/journal/authority-relay/status', 'GET'],
]);
const MAX_BODY = 64 * 1024;
const MAX_REPLY = 64 * 1024;
const ASSERTION_AGE_MS = 15_000;
const ASSERTION_HEADER = 'x-bemine-relay-assertion';

function fail(status, message) { const error = new Error(message); error.status = status; throw error; }
function exactRoute(req) {
  if (!ROUTES.has(req.url) || ROUTES.get(req.url) !== req.method)
    fail(404, 'Unknown authority relay route.');
  return req.url;
}
function keyBytes(key) {
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error('Authority IPC key must be 32 bytes.');
  return key;
}
function bodyDigest(body) { return createHash('sha256').update(body).digest('hex'); }
async function bodyBytes(req) {
  const declared = req.headers['content-length'];
  if (declared !== undefined && (!/^\d+$/.test(String(declared)) || Number(declared) > MAX_BODY))
    fail(413, 'Authority request is too large.');
  const parts = []; let bytes = 0;
  for await (const part of req) {
    bytes += part.length;
    if (bytes > MAX_BODY) fail(413, 'Authority request is too large.');
    parts.push(part);
  }
  const result = Buffer.concat(parts);
  if (req.method === 'GET' && result.length) fail(400, 'Status request must not have a body.');
  return result;
}
function reply(res, status, message) {
  if (res.headersSent) return;
  res.statusCode = status;
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify({ error: message }));
}

/** A systemd credential shared by the web proxy and signer, never the Gas key. */
export function readAuthorityIpcKey(env = process.env) {
  const dir = env.CREDENTIALS_DIRECTORY;
  if (!dir || !isAbsolute(dir) || env.AUTHORITY_IPC_KEY) throw new Error('Authority IPC requires a systemd credential.');
  const path = join(dir, 'authority-ipc-hmac');
  const info = lstatSync(path);
  if (!info.isFile() || info.size !== 32) throw new Error('Invalid authority IPC credential.');
  return keyBytes(readFileSync(path));
}

export function authorityIpcConfiguration(env = process.env) {
  if (!env.AUTHORITY_RELAY_SOCKET) return null;
  if (env.AUTHORITY_RELAY_SOCKET !== AUTHORITY_SOCKET || env.AUTHORITY_RELAY_ENABLED === '1')
    throw new Error('Public deployment server requires the reviewed local relay socket and cannot sign.');
  if (!env.DEPLOYMENT_JOURNAL_ORIGIN || new URL(env.DEPLOYMENT_JOURNAL_ORIGIN).origin
    !== env.DEPLOYMENT_JOURNAL_ORIGIN || !env.DEPLOYMENT_JOURNAL_ORIGIN.startsWith('https://')
    || !isAbsolute(env.DEPLOYMENT_JOURNAL_DB ?? ''))
    throw new Error('Authority IPC requires the exact HTTPS journal origin and private session DB.');
  if (env.KEEPER_PRIVATE_KEY || existsSync(join(env.CREDENTIALS_DIRECTORY ?? '/', 'keeper-private-key'))
    || existsSync(join(env.CREDENTIALS_DIRECTORY ?? '/', 'authority-gas-private-key')))
    throw new Error('Public Authority IPC process must not receive a Gas private key.');
  return { socketPath: AUTHORITY_SOCKET, origin: env.DEPLOYMENT_JOURNAL_ORIGIN,
    dbPath: env.DEPLOYMENT_JOURNAL_DB, key: readAuthorityIpcKey(env) };
}

function sessionAccount(req, store) {
  const cookies = String(req.headers.cookie ?? '').split(';').map(item => item.trim());
  const token = cookies.find(item => item.startsWith('pinkuang_journal='))?.slice('pinkuang_journal='.length);
  const account = token && /^[A-Za-z0-9_-]{43}$/.test(token)
    ? store.session(createHash('sha256').update(token).digest('hex')) : null;
  if (!account) fail(401, 'Wallet session is required.');
  let selected;
  try { selected = getAddress(req.headers['x-pinkuang-account']); }
  catch { fail(409, 'Selected wallet does not match the session.'); }
  if (selected.toLowerCase() !== account.toLowerCase()) fail(409, 'Selected wallet does not match the session.');
  return getAddress(account);
}

export function signAuthorityAssertion(key, { account, method, path, body, now = Date.now(), nonce = randomBytes(16).toString('hex') }) {
  keyBytes(key);
  const payload = { v: 1, account: getAddress(account), method, path,
    bodySha256: bodyDigest(body), issuedAt: now, expiresAt: now + ASSERTION_AGE_MS, nonce };
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = createHmac('sha256', key).update(encoded).digest('base64url');
  return `${encoded}.${mac}`;
}

/** The signer checks the exact body and rejects a duplicate assertion. */
export function createAuthorityAssertionVerifier(key, now = Date.now) {
  keyBytes(key);
  const seen = new Map();
  return (header, req, body) => {
    if (typeof header !== 'string' || header.length > 2048 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(header))
      fail(401, 'Authority IPC assertion is required.');
    const [encoded, supplied] = header.split('.');
    const expected = createHmac('sha256', key).update(encoded).digest();
    const candidate = Buffer.from(supplied, 'base64url');
    if (candidate.length !== expected.length || !timingSafeEqual(candidate, expected))
      fail(401, 'Authority IPC assertion is invalid.');
    let claim;
    try { claim = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')); }
    catch { fail(401, 'Authority IPC assertion is invalid.'); }
    const stamp = now();
    if (claim.v !== 1 || !/^[a-f0-9]{32}$/.test(claim.nonce ?? '')
      || !Number.isSafeInteger(claim.issuedAt) || !Number.isSafeInteger(claim.expiresAt)
      || claim.expiresAt - claim.issuedAt !== ASSERTION_AGE_MS
      || claim.issuedAt > stamp + 1_000 || claim.expiresAt <= stamp
      || claim.method !== req.method || claim.path !== req.url
      || claim.bodySha256 !== bodyDigest(body)) fail(401, 'Authority IPC assertion is stale or mismatched.');
    let account;
    try { account = getAddress(claim.account); }
    catch { fail(401, 'Authority IPC account is invalid.'); }
    for (const [nonce, expiry] of seen) if (expiry <= stamp) seen.delete(nonce);
    if (seen.size >= 4096 || seen.has(claim.nonce)) fail(409, 'Authority IPC assertion was reused.');
    seen.set(claim.nonce, claim.expiresAt);
    return account;
  };
}

/** Public process: authenticate a wallet session, then proxy one exact route. */
export function createAuthorityRelayProxy(config, dependencies = {}) {
  if (!config) return null;
  if (!isAbsolute(config.socketPath) || !config.origin?.startsWith('https://'))
    throw new Error('Authority IPC proxy needs an absolute socket and exact HTTPS origin.');
  const key = keyBytes(config.key);
  const store = dependencies.store ?? new JournalStore(config.dbPath);
  const transport = dependencies.transport ?? httpRequest;
  const timeoutMs = dependencies.timeoutMs ?? 45_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 45_000)
    throw new Error('Authority IPC timeout exceeds the reviewed bound.');
  return {
    async handle(req, res) {
      try {
        const path = exactRoute(req);
        if (req.headers.origin && req.headers.origin !== config.origin) fail(403, 'Request origin is not allowed.');
        if (req.method === 'POST' && req.headers.origin !== config.origin) fail(403, 'Exact request origin is required.');
        const account = sessionAccount(req, store);
        const body = await bodyBytes(req);
        const assertion = signAuthorityAssertion(key, { account, method: req.method, path, body });
        const status = await new Promise((resolve, reject) => {
          const upstream = transport({ socketPath: config.socketPath, path, method: req.method,
            headers: { [ASSERTION_HEADER]: assertion, origin: req.headers.origin ?? '',
              'x-pinkuang-account': account, 'content-type': req.headers['content-type'] ?? '',
              'content-length': String(body.length) } }, response => {
            let size = 0; const parts = [];
            response.on('data', part => {
              size += part.length;
              if (size > MAX_REPLY) { upstream.destroy(); reject(new Error('Authority IPC response is oversized.')); }
              else parts.push(part);
            });
            response.on('end', () => resolve({ code: response.statusCode, body: Buffer.concat(parts) }));
            response.on('error', reject);
          });
          upstream.setTimeout(timeoutMs, () => upstream.destroy(new Error('Authority IPC timed out.')));
          upstream.on('error', reject);
          upstream.end(body);
        });
        if (res.writableEnded) return;
        res.statusCode = status.code;
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(status.body);
      } catch (error) {
        reply(res, Number.isInteger(error.status) ? error.status : 503,
          Number.isInteger(error.status) ? error.message : 'Authority signer is unavailable. Check status before retrying.');
      }
    },
    close() { if (!dependencies.store) store.close(); },
  };
}

/** Private process: verify HMAC, body, time and replay before business checks. */
export function createAuthoritySignerServer(service, key, dependencies = {}) {
  const verify = dependencies.verify ?? createAuthorityAssertionVerifier(key);
  return createHttpServer(async (req, res) => {
    try {
      exactRoute(req);
      const body = await bodyBytes(req);
      const account = verify(req.headers[ASSERTION_HEADER], req, body);
      const forwarded = Readable.from(body.length ? [body] : []);
      Object.assign(forwarded, { url: req.url, method: req.method,
        headers: { origin: req.headers.origin, 'x-pinkuang-account': account,
          'content-type': req.headers['content-type'], 'content-length': String(body.length) },
        authorityIpcAccount: account });
      service.handle(forwarded, res);
    } catch (error) {
      reply(res, Number.isInteger(error.status) ? error.status : 503,
        Number.isInteger(error.status) ? error.message : 'Authority IPC request failed.');
    }
  });
}

export async function listenAuthoritySigner(server, socketPath = AUTHORITY_SOCKET, { allowTestPath = false } = {}) {
  if (!allowTestPath && socketPath !== AUTHORITY_SOCKET) throw new Error('Unreviewed authority socket path.');
  const parent = dirname(socketPath);
  const parentInfo = lstatSync(parent);
  if (!parentInfo.isDirectory() || (parentInfo.mode & 0o777) !== 0o750
    || parentInfo.uid !== process.getuid() || parentInfo.gid !== process.getgid()
    || existsSync(socketPath))
    throw new Error('Authority socket requires a private 0750 directory and a new socket.');
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => { server.off('error', reject); resolve(); });
  });
  chmodSync(socketPath, 0o660);
  const socketInfo = statSync(socketPath);
  if ((socketInfo.mode & 0o777) !== 0o660
    || socketInfo.uid !== process.getuid() || socketInfo.gid !== process.getgid())
    throw new Error('Authority socket mode differs from 0660.');
}
