import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer as createHttpServer, request as httpRequest } from 'node:http';
import { chmodSync, existsSync, lstatSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { Readable } from 'node:stream';
import { FetchRequest, Interface, JsonRpcProvider, getAddress } from 'ethers';
import { reviewedSingleAdministrator, verifyCurrentAuthorityAdministrator } from './authority-role.mjs';
import { JournalStore } from './journal-store.mjs';
import { productGraphConfiguration } from './product-graph.mjs';
import { createKeyedLimiter, createRequestLimiter } from './request-limiter.mjs';
import { FRESH_READINESS_PATH } from '../shared/fresh-runtime-identity.mjs';
import { gasSignerAttestationMessage } from '../shared/gas-signer-attestation.mjs';

export const AUTHORITY_SOCKET = '/run/pinkuang-v4-relay/authority.sock';
export const GAS_ATTESTATION_PATH = '/internal/fresh-gas-attestation';
const ROUTES = new Map([
  ['/api/journal/authority-relay', 'POST'],
  ['/api/journal/authority-relay/status', 'GET'],
]);
const MAX_BODY = 64 * 1024;
const MAX_REPLY = 64 * 1024;
const ASSERTION_AGE_MS = 15_000;
const ASSERTION_HEADER = 'x-bemine-relay-assertion';
const BLOCK_HASH = /^0x[0-9a-f]{64}$/i;
const ZERO_ADDRESS = `0x${'0'.repeat(40)}`;
const roleInterface = new Interface([
  'function administratorOne() view returns (address)',
  'function administratorTwo() view returns (address)',
]);

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
  if (!env.DEPLOYMENT_JOURNAL_RPC_URL?.startsWith('https://')
    || !env.BEMINE_EXPECTED_GAS_WALLET
    || env.AUTHORITY_RELAY_PUBLIC_ENABLED === '1'
      && !['BEMINE_DEPLOYMENT_RECORD_PATH','BEMINE_PRODUCT_GENESIS_ARTIFACT_PATH',
        'BEMINE_PRODUCT_ACTIVATION_PATH'].every(name => isAbsolute(env[name] ?? '')))
    throw new Error('Authority IPC requires the Gas public address, an HTTPS BSC RPC, and graph evidence before relay.');
  return { socketPath: AUTHORITY_SOCKET, origin: env.DEPLOYMENT_JOURNAL_ORIGIN,
    dbPath: env.DEPLOYMENT_JOURNAL_DB, key: readAuthorityIpcKey(env),
    rpcUrl: env.DEPLOYMENT_JOURNAL_RPC_URL, expectedGasWallet: env.BEMINE_EXPECTED_GAS_WALLET,
    recordPath: env.BEMINE_DEPLOYMENT_RECORD_PATH,
    bundlePath: env.BEMINE_PRODUCT_GENESIS_ARTIFACT_PATH,
    salePolicyCatalogPath: env.BEMINE_SALE_POLICY_CATALOG_PATH,
    salePolicyArtifactPath: env.BEMINE_SALE_POLICY_ARTIFACT_PATH,
    nativeSaleCatalogPath: env.BEMINE_NATIVE_SALE_CATALOG_PATH,
    nativeSaleArtifactPath: env.BEMINE_NATIVE_SALE_ARTIFACT_PATH,
    activationPath: env.BEMINE_PRODUCT_ACTIVATION_PATH, freshProductRequired: env.BEMINE_FRESH_PRODUCT_ENABLED === '1' };
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

/** Only the public server can reach this local socket; the returned signature
 * is verified again against the current deployment by journal-api.mjs. */
export function createGasSignerProofReader(config, dependencies = {}) {
  if (!config || (!dependencies.allowTestPath && config.socketPath !== AUTHORITY_SOCKET)
    || !isAbsolute(config.socketPath) || !config.origin?.startsWith('https://'))
    throw new Error('Gas signer proof requires the reviewed private socket and HTTPS origin.');
  const key = keyBytes(config.key);
  const transport = dependencies.transport ?? httpRequest;
  return async challenge => {
    gasSignerAttestationMessage(challenge);
    if (challenge.origin !== config.origin || getAddress(challenge.expectedGasWallet)
      !== getAddress(config.expectedGasWallet))
      throw new Error('Gas signer proof differs from the reviewed public configuration.');
    const body = Buffer.from(JSON.stringify(challenge));
    const assertion = signAuthorityAssertion(key, { account: challenge.deploymentAccount,
      method: 'POST', path: GAS_ATTESTATION_PATH, body });
    const result = await new Promise((resolve, reject) => {
      const upstream = transport({ socketPath: config.socketPath, path: GAS_ATTESTATION_PATH,
        method: 'POST', headers: { [ASSERTION_HEADER]: assertion, origin: config.origin,
          'content-type': 'application/json', 'content-length': String(body.length) } }, response => {
        let size = 0; const parts = [];
        response.on('data', part => {
          size += part.length;
          if (size > 2048) { upstream.destroy(); reject(new Error('Gas signer proof response is oversized.')); }
          else parts.push(part);
        });
        response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(parts) }));
        response.on('error', reject);
      });
      upstream.setTimeout(3000, () => upstream.destroy(new Error('Gas signer proof timed out.')));
      upstream.on('error', reject);
      upstream.end(body);
    });
    if (result.status !== 200) throw new Error('The isolated Gas signer did not attest its public address.');
    return JSON.parse(result.body.toString('utf8'));
  };
}

/** Authenticated machine query, not a wallet session or possession signature. */
export function createFreshProductReadinessReader(config, dependencies = {}) {
  if (!config || (!dependencies.allowTestPath && config.socketPath !== AUTHORITY_SOCKET)
    || !isAbsolute(config.socketPath) || !config.origin?.startsWith('https://'))
    throw new Error('Machine readiness requires the reviewed private socket.');
  const key = keyBytes(config.key), transport = dependencies.transport ?? httpRequest;
  return async () => {
    const nonce = randomBytes(16).toString('hex');
    const body = Buffer.from(JSON.stringify({nonce, gasWallet:getAddress(config.expectedGasWallet)}));
    const assertion = signAuthorityAssertion(key,{account:config.expectedGasWallet,
      method:'POST',path:FRESH_READINESS_PATH,body});
    const result = await new Promise((resolve,reject)=>{
      const upstream=transport({socketPath:config.socketPath,path:FRESH_READINESS_PATH,method:'POST',
        headers:{[ASSERTION_HEADER]:assertion,origin:config.origin,
          'content-type':'application/json','content-length':String(body.length)}},response=>{
        let size=0;const parts=[];
        response.on('data',part=>{size+=part.length;if(size>MAX_REPLY){upstream.destroy();reject(new Error('Oversized readiness response.'));}else parts.push(part);});
        response.on('end',()=>resolve({status:response.statusCode,body:Buffer.concat(parts)}));
        response.on('error',reject);
      });
      upstream.setTimeout(30_000,()=>upstream.destroy(new Error('Machine readiness timed out.')));
      upstream.on('error',reject);upstream.end(body);
    });
    if(result.status!==200)throw new Error('Fresh signing and operational services are not ready.');
    const value=JSON.parse(result.body.toString('utf8'));
    if(value.nonce!==nonce || getAddress(value.identity?.gasWallet)!==getAddress(config.expectedGasWallet))
      throw new Error('Machine readiness identity changed.');
    return value;
  };
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
    if (seen.has(claim.nonce)) fail(409, 'Authority IPC assertion was reused.');
    if (seen.size >= 4096) fail(503, 'Authority IPC replay table is busy.');
    seen.set(claim.nonce, claim.expiresAt);
    return account;
  };
}

/** A cheap, short-lived rejection filter only. The full role and deployment proof
 * still runs for every admitted request, and the isolated signer verifies again. */
export function createAuthorityRolePrefilter(provider, trusted, { now = Date.now, ttlMs = 15_000 } = {}) {
  if (!trusted?.freshAuthority?.authority?.address || !Number.isSafeInteger(ttlMs)
    || ttlMs < 1 || ttlMs > 30_000) throw new Error('Authority role prefilter needs reviewed evidence and a bounded TTL.');
  const authority = getAddress(trusted.freshAuthority.authority.address);
  let snapshot = null;
  let refreshing = null;
  async function refresh() {
    if (BigInt(await provider.send('eth_chainId', [])) !== 56n) fail(503, 'RPC is not BSC mainnet.');
    const block = await provider.getBlock('latest');
    if (!block || !Number.isSafeInteger(block.number) || !BLOCK_HASH.test(block.hash ?? '')
      || !Number.isSafeInteger(block.timestamp)
      || Math.abs(Math.floor(now() / 1000) - block.timestamp) > 90)
      fail(503, 'Current BSC block is unavailable.');
    const tag = `0x${block.number.toString(16)}`;
    const role = async method => getAddress(roleInterface.decodeFunctionResult(method,
      await provider.send('eth_call', [{ to: authority,
        data: roleInterface.encodeFunctionData(method) }, tag]))[0]);
    const [first, second] = await Promise.all([
      role('administratorOne'), role('administratorTwo'),
    ]);
    const [canonical, chainId] = await Promise.all([
      provider.getBlock(block.number), provider.send('eth_chainId', []),
    ]);
    if (!canonical || canonical.hash?.toLowerCase() !== block.hash.toLowerCase()
      || BigInt(chainId) !== 56n) fail(503, 'Current BSC block changed during role prefilter.');
    if (first === ZERO_ADDRESS || second === ZERO_ADDRESS
      || first === second && !reviewedSingleAdministrator(trusted))
      fail(409, 'Current Authority administrators are invalid.');
    return new Set([first.toLowerCase(), second.toLowerCase()]);
  }
  return async account => {
    if (!snapshot || now() >= snapshot.expiresAt) {
      if (!refreshing) refreshing = refresh().then(
        roles => ({ roles, expiresAt: now() + ttlMs }),
        error => ({ error, expiresAt: now() + ttlMs }),
      ).then(result => { snapshot = result; return result; }).finally(() => { refreshing = null; });
      snapshot = await refreshing;
    }
    if (snapshot.error) throw snapshot.error;
    if (!snapshot.roles.has(getAddress(account).toLowerCase())) fail(403, 'Administrator wallet is required.');
  };
}

/** Public process: authenticate a wallet session, then proxy one exact route. */
export function createAuthorityRelayProxy(config, dependencies = {}) {
  if (!config) return null;
  if (!isAbsolute(config.socketPath) || !config.origin?.startsWith('https://'))
    throw new Error('Authority IPC proxy needs an absolute socket and exact HTTPS origin.');
  if (config.freshProductRequired && typeof dependencies.verifyOperationalReadiness !== 'function')
    throw new Error('Fresh product relay requires its independent graph and index gate.');
  const key = keyBytes(config.key);
  const store = dependencies.store ?? new JournalStore(config.dbPath);
  const transport = dependencies.transport ?? httpRequest;
  const trusted = dependencies.verifyAdministrator ? null : (dependencies.configuration ?? productGraphConfiguration)({
    recordPath: config.recordPath, bundlePath: config.bundlePath,
    productActivationPath: config.activationPath, expectedGasWallet: config.expectedGasWallet,
    salePolicyCatalogPath: config.salePolicyCatalogPath, salePolicyArtifactPath: config.salePolicyArtifactPath,
    nativeSaleCatalogPath: config.nativeSaleCatalogPath, nativeSaleArtifactPath: config.nativeSaleArtifactPath,
  });
  if (!dependencies.verifyAdministrator && !trusted?.freshAuthority)
    throw new Error('Authority IPC requires reviewed fresh Authority evidence.');
  const rpcRequest = dependencies.verifyAdministrator ? null : new FetchRequest(config.rpcUrl);
  if (rpcRequest) {
    rpcRequest.timeout = 12_000;
    rpcRequest.setThrottleParams({ maxAttempts: 1 });
  }
  const provider = rpcRequest ? new JsonRpcProvider(rpcRequest, 56,
    { staticNetwork: true, cacheTimeout: -1, batchMaxCount: 1 }) : null;
  const verifyAdministrator = dependencies.verifyAdministrator
    ?? (account => verifyCurrentAuthorityAdministrator(provider, trusted, account));
  const prefilterAdministrator = dependencies.prefilterAdministrator
    ?? (provider ? createAuthorityRolePrefilter(provider, trusted) : async () => {});
  const timeoutMs = dependencies.timeoutMs ?? 45_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 45_000)
    throw new Error('Authority IPC timeout exceeds the reviewed bound.');
  const allowIp = createRequestLimiter({ windowMs: 60_000, perClient: 90, maxClients: 5_000 });
  const allowSessionAccount = createKeyedLimiter({ windowMs: 60_000, perKey: 30, maxKeys: 5_000 });
  const allowAdministrator = createKeyedLimiter({ windowMs: 60_000, perKey: 30, maxKeys: 32 });
  return {
    async handle(req, res) {
      try {
        const path = exactRoute(req);
        if (req.headers.origin && req.headers.origin !== config.origin) fail(403, 'Request origin is not allowed.');
        if (req.method === 'POST' && req.headers.origin !== config.origin) fail(403, 'Exact request origin is required.');
        if (!allowIp(req)) fail(429, 'Too many authority relay requests from this client.');
        const account = sessionAccount(req, store);
        const body = await bodyBytes(req);
        if (!allowSessionAccount(account.toLowerCase())) fail(429, 'Too many authority relay requests for this wallet.');
        await prefilterAdministrator(account);
        await verifyAdministrator(account);
        if (req.method === 'POST' && config.freshProductRequired) await dependencies.verifyOperationalReadiness();
        if (!allowAdministrator(account.toLowerCase())) fail(429, 'Too many authority relay requests for this administrator.');
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
    close() { if (!dependencies.store) store.close(); provider?.destroy(); },
  };
}

/** Private process: verify HMAC, body, time and replay before business checks. */
export function createAuthoritySignerServer(service, key, dependencies = {}) {
  const verify = dependencies.verify ?? createAuthorityAssertionVerifier(key);
  const attestation = dependencies.attestation;
  const machine = dependencies.machine;
  const allowAttestation = createKeyedLimiter({ windowMs: 60_000, perKey: 12, maxKeys: 1024 });
  // A compromised proxy can mint assertions for many accounts. Keep a
  // signer-wide ceiling on actual signatures as well as the account quota.
  const allowAttestationGlobal = createKeyedLimiter({ windowMs: 60_000, perKey: 30, maxKeys: 1 });
  return createHttpServer(async (req, res) => {
    try {
      if (req.url === GAS_ATTESTATION_PATH && req.method === 'POST') {
        if (!attestation) fail(503, 'Gas signer attestation is unavailable.');
        const body = await bodyBytes(req);
        if (body.length > 1024 || req.headers.origin !== attestation.origin)
          fail(400, 'Invalid Gas signer attestation request.');
        const account = verify(req.headers[ASSERTION_HEADER], req, body);
        if (!allowAttestation(account.toLowerCase())) fail(429, 'Too many Gas signer attestation requests.');
        let challenge;
        try { challenge = JSON.parse(body.toString('utf8')); }
        catch { fail(400, 'Invalid Gas signer attestation request.'); }
        let message;
        try { message = gasSignerAttestationMessage(challenge); }
        catch { fail(400, 'Invalid Gas signer attestation request.'); }
        if (challenge.origin !== attestation.origin
          || getAddress(challenge.expectedGasWallet) !== getAddress(attestation.wallet.address)
          || getAddress(challenge.deploymentAccount) !== account)
          fail(403, 'Gas signer attestation identity differs.');
        if (!allowAttestationGlobal('signer')) fail(429, 'Too many Gas signer attestation requests.');
        const signature = await attestation.wallet.signMessage(message);
        res.statusCode = 200;
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(JSON.stringify({ gasWallet: attestation.wallet.address, signature }));
        return;
      }
      if (req.url === FRESH_READINESS_PATH && req.method === 'POST') {
        if (!service?.readiness || !machine) fail(503, 'Fresh relay is not active.');
        const body=await bodyBytes(req);
        if(body.length>1024 || req.headers.origin!==machine.origin) fail(400,'Invalid machine readiness request.');
        const account=verify(req.headers[ASSERTION_HEADER],req,body);
        let challenge;try{challenge=JSON.parse(body.toString('utf8'));}catch{fail(400,'Invalid readiness JSON.');}
        if(!/^[a-f0-9]{32}$/.test(challenge.nonce ?? '')
          || getAddress(challenge.gasWallet)!==getAddress(machine.gasWallet)
          || account!==getAddress(machine.gasWallet)) fail(403,'Machine readiness identity differs.');
        const result=await service.readiness();
        res.statusCode=200;res.setHeader('Cache-Control','no-store');res.setHeader('Content-Type','application/json');
        res.end(JSON.stringify({...result,nonce:challenge.nonce}));return;
      }
      exactRoute(req);
      if (!service) fail(503, 'Authority relay is not active.');
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
