import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { JsonRpcProvider, getAddress, getCreateAddress, keccak256, verifyMessage } from 'ethers';
import { fileURLToPath } from 'node:url';
import { JournalConflict, JournalStore } from './journal-store.mjs';

const MAX_BODY = 64 * 1024;
const CHALLENGE_MS = 5 * 60_000;
const SESSION_MS = 12 * 60 * 60_000;
const TOKEN_COOKIE = 'pinkuang_journal';
const HASH = /^0x[\da-f]{64}$/i;
const DATA = /^0x(?:[\da-f]{2})*$/i;
const DECIMAL = /^(0|[1-9]\d*)$/;
const CHALLENGE = /^[A-Za-z0-9_-]{32}$/;
const STATUSES = new Set(['ready','running','paused','failed','aborted','complete']);
const STEP_STATUSES = new Set(['waiting','signing','submitted','confirmed','rejected','failed','uncertain','cancelled','replaced']);
const LIBRARY_STEPS = new Set(['FlexiblePurchase','MiningOperations','PoolFunds','PurchaseValidation',
  'RewardAccounting','SaleGovernance','SaleSettlement','ShareCheckpoints']);
const FINAL_STEPS = ['AtomicDeployment','PoolVault','PoolFactory','ShareMarket','initialize'];

class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const fail = (status, message) => { throw new ApiError(status, message); };
const identity = value => {
  try { return getAddress(value).toLowerCase(); }
  catch { fail(400, 'Invalid wallet or contract address.'); }
};
const exactRevision = value => {
  if (!Number.isSafeInteger(value) || value < 0) fail(400, 'Invalid expectedRevision.');
  return value;
};
const hashed = value => createHash('sha256').update(value).digest('hex');
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const recordedAddressMatches = (value, expected) => typeof value === 'string'
  && /^0x[\da-f]{40}$/i.test(value) && value.toLowerCase() === expected;

async function readJson(req) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? '')) fail(415, 'JSON content type is required.');
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > MAX_BODY) fail(413, 'Request body is too large.');
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) fail(413, 'Request body is too large.');
    chunks.push(chunk);
  }
  try { const value = JSON.parse(Buffer.concat(chunks).toString('utf8')); if (!isRecord(value)) throw new Error(); return value; }
  catch { fail(400, 'Invalid JSON object.'); }
}

function validateDeployment(value, account) {
  if (!isRecord(value) || value.schemaVersion !== 1 || value.chainId !== 56 || identity(value.account) !== account
    || typeof value.id !== 'string' || !/^[A-Za-z0-9_.:-]{1,160}$/.test(value.id)
    || typeof value.sourceCommit !== 'string' || !/^[\da-f]{40,64}$/i.test(value.sourceCommit)
    || !HASH.test(value.artifactDigest) || !STATUSES.has(value.status)
    || !isRecord(value.input) || !/^(0|[1-9]\d*)(?:\.\d{1,18})?$/.test(value.input.maxGasBudgetBnb)
    || !/^(0|[1-9]\d*)(?:\.\d{1,9})?$/.test(value.input.gasPriceCapGwei)
    || !Array.isArray(value.steps) || value.steps.length < 1 || value.steps.length > 32
    || !isRecord(value.addresses) || !DECIMAL.test(value.spentWei)) fail(400, 'Invalid deployment record.');
  const seen = new Set();
  for (const step of value.steps) {
    if (!isRecord(step) || typeof step.id !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(step.id)
      || seen.has(step.id) || !STEP_STATUSES.has(step.status)
      || step.nonce !== undefined && (!Number.isSafeInteger(step.nonce) || step.nonce < 0)
      || step.dataHash !== undefined && !HASH.test(step.dataHash)
      || step.txHash !== undefined && !HASH.test(step.txHash)
      || step.replacementHash !== undefined && !HASH.test(step.replacementHash)) fail(400, 'Invalid deployment step.');
    seen.add(step.id);
  }
  return value;
}

function validateMarket(value, account) {
  if (!isRecord(value) || value.version !== 1 || value.chainId !== 56 || identity(value.account) !== account
    || identity(value.factory) === identity(value.market) || !Number.isSafeInteger(value.nonce) || value.nonce < 0
    || !isRecord(value.action) || !['list','fill','cancel','withdraw'].includes(value.action.kind)
    || typeof value.submittedAt !== 'string' || value.submittedAt.length > 50
    || typeof value.data !== 'string' || !DATA.test(value.data) || value.data.length > 16_384
    || typeof value.value !== 'string' || !DECIMAL.test(value.value)
    || value.hash !== undefined && !HASH.test(value.hash)
    || value.recoveryHashes !== undefined && (!Array.isArray(value.recoveryHashes) || value.recoveryHashes.length > 16
      || value.recoveryHashes.some(hash => typeof hash !== 'string' || !HASH.test(hash)))) fail(400, 'Invalid market intent.');
  return value;
}

/** Read-only chain proof that an account nonce is finalized. */
async function finalizedNonce(provider, account, nonce, hash) {
  if (!provider) fail(503, 'BSC receipt verifier is unavailable.');
  if (typeof hash !== 'string' || !HASH.test(hash)) fail(400, 'A transaction hash is required.');
  try {
    const rawChainId = await provider.send('eth_chainId', []);
    if (typeof rawChainId !== 'string' || !/^0x[\da-f]+$/i.test(rawChainId) || BigInt(rawChainId) !== 56n)
      fail(503, 'Receipt RPC is not BSC mainnet.');
    const [tx, receipt, latest, finalized] = await Promise.all([
      provider.getTransaction(hash), provider.getTransactionReceipt(hash), provider.getBlock('latest'), provider.getBlock('finalized'),
    ]);
    if (!tx || !receipt || !latest || !finalized?.hash) fail(409, 'Transaction is not finalized.');
    if (tx.hash.toLowerCase() !== hash.toLowerCase() || receipt.hash.toLowerCase() !== hash.toLowerCase()
      || tx.chainId !== 56n || identity(tx.from) !== account.toLowerCase() || identity(receipt.from) !== account.toLowerCase()
      || tx.nonce !== nonce || tx.blockNumber !== receipt.blockNumber || tx.blockHash !== receipt.blockHash
      || (tx.to ?? '').toLowerCase() !== (receipt.to ?? '').toLowerCase()
      || receipt.status !== 0 && receipt.status !== 1) fail(409, 'Transaction does not match the recorded wallet nonce.');
    const canonical = await provider.getBlock(receipt.blockNumber);
    if (canonical?.hash !== receipt.blockHash || latest.number - receipt.blockNumber + 1 < 2
      || finalized.number < receipt.blockNumber
      || await provider.getTransactionCount(account, finalized.number) <= nonce) fail(409, 'Transaction is not finalized on the canonical chain.');
    const [again, finalizedAgain, chainAgain] = await Promise.all([
      provider.getBlock(receipt.blockNumber), provider.getBlock(finalized.number), provider.send('eth_chainId', []),
    ]);
    if (again?.hash !== receipt.blockHash || finalizedAgain?.hash !== finalized.hash || BigInt(chainAgain) !== 56n)
      fail(409, 'Chain changed during receipt verification.');
    return { tx, receipt };
  } catch (error) {
    if (error instanceof ApiError) throw error;
    fail(503, 'Receipt RPC could not be verified.');
  }
}

export async function verifyMarketFinalized(provider, record, hash) {
  const { tx } = await finalizedNonce(provider, record.account, record.nonce, hash);
  if (record.hash?.toLowerCase() === hash.toLowerCase()
    && (tx.to?.toLowerCase() !== record.market.toLowerCase() || tx.data.toLowerCase() !== record.data.toLowerCase()
      || tx.value.toString() !== record.value)) fail(409, 'Original market transaction payload differs.');
}

/** Archival must prove that every terminal deployment nonce is finalized. */
export async function verifyAbortedDeployment(provider, record) {
  if (record?.status !== 'aborted') fail(409, 'Only an aborted deployment can be archived.');
  let terminalSeen = false;
  let priorNonce = -1;
  for (const step of record.steps) {
    if (terminalSeen) {
      if (step.nonce !== undefined || step.status !== 'waiting') fail(409, 'Deployment continued after its terminal transaction.');
      continue;
    }
    if (step.nonce === undefined) fail(409, 'Deployment has an unverified step before its terminal transaction.');
    if (!Number.isSafeInteger(step.nonce) || step.nonce <= priorNonce) fail(409, 'Deployment nonces are not ordered.');
    priorNonce = step.nonce;
    if (!['confirmed','failed','cancelled','replaced'].includes(step.status))
      fail(409, 'Deployment still has an unknown transaction.');
    const hash = step.replacementHash ?? step.txHash;
    if (!Number.isSafeInteger(step.nonce) || step.nonce < 0 || !hash || !step.receipt)
      fail(409, 'Aborted deployment lacks a complete terminal receipt.');
    const { tx, receipt } = await finalizedNonce(provider, record.account, step.nonce, hash);
    if (step.receipt.blockNumber !== receipt.blockNumber || step.receipt.blockHash !== receipt.blockHash
      || step.receipt.status !== receipt.status) fail(409, 'Saved deployment receipt differs from the finalized chain.');
    if (step.status === 'confirmed') {
      const plannedTo = step.id === 'initialize' ? record.addresses.AtomicDeployment : null;
      const sameTarget = plannedTo ? tx.to?.toLowerCase() === plannedTo.toLowerCase() : tx.to === null;
      if (!HASH.test(step.dataHash) || !sameTarget || tx.value !== 0n
        || keccak256(tx.data) !== step.dataHash || receipt.status !== 1)
        fail(409, 'Confirmed deployment step lacks exact finalized chain proof.');
      continue;
    }
    terminalSeen = true;
    if (step.status === 'failed' && receipt.status !== 0 || step.status !== 'failed' && receipt.status !== 1)
      fail(409, 'Terminal deployment outcome differs from the finalized chain.');
    if (step.status === 'cancelled' && (tx.to?.toLowerCase() !== record.account.toLowerCase()
      || tx.data !== '0x' || tx.value !== 0n)) fail(409, 'Cancellation payload does not match the wallet.');
    if (step.status === 'replaced') {
      const plannedTo = step.id === 'initialize' ? record.addresses.AtomicDeployment : null;
      const sameTarget = plannedTo ? tx.to?.toLowerCase() === plannedTo.toLowerCase() : tx.to === null;
      if (!HASH.test(step.dataHash) || keccak256(tx.data) === step.dataHash && sameTarget && tx.value === 0n)
        fail(409, 'Replacement does not differ from the original deployment payload.');
    }
  }
  if (!terminalSeen) fail(409, 'Aborted deployment has no finalized terminal transaction.');
}

async function mapInBatches(items, size, action) {
  const results = [];
  for (let start = 0; start < items.length; start += size) {
    const settled = await Promise.allSettled(items.slice(start, start + size).map((item, offset) => action(item, start + offset)));
    const failure = settled.find(result => result.status === 'rejected');
    if (failure) throw failure.reason;
    results.push(...settled.map(result => result.value));
  }
  return results;
}

/** Verify all original nonces against one stable finalized BSC anchor. */
async function finalizedCompletedSteps(provider, account, steps) {
  if (!provider) fail(503, 'BSC receipt verifier is unavailable.');
  try {
    const chainId = await provider.send('eth_chainId', []);
    if (typeof chainId !== 'string' || !/^0x[\da-f]+$/i.test(chainId) || BigInt(chainId) !== 56n)
      fail(503, 'Receipt RPC is not BSC mainnet.');
    const [latest, finalized] = await Promise.all([provider.getBlock('latest'), provider.getBlock('finalized')]);
    if (!latest || !finalized?.hash) fail(409, 'Transaction is not finalized.');
    if (await provider.getTransactionCount(account, finalized.number) <= steps.at(-1).nonce)
      fail(409, 'Deployment nonces are not finalized.');
    const proofs = await mapInBatches(steps, 4, async step => {
      const [tx, receipt] = await Promise.all([
        provider.getTransaction(step.txHash), provider.getTransactionReceipt(step.txHash),
      ]);
      if (!tx || !receipt) fail(409, 'Transaction is not finalized.');
      if (tx.hash.toLowerCase() !== step.txHash.toLowerCase()
        || receipt.hash.toLowerCase() !== step.txHash.toLowerCase()
        || tx.chainId !== 56n || identity(tx.from) !== account.toLowerCase()
        || identity(receipt.from) !== account.toLowerCase()
        || tx.nonce !== step.nonce || tx.blockNumber !== receipt.blockNumber
        || tx.blockHash !== receipt.blockHash
        || (tx.to ?? '').toLowerCase() !== (receipt.to ?? '').toLowerCase()
        || receipt.status !== 0 && receipt.status !== 1) fail(409, 'Transaction does not match the recorded wallet nonce.');
      const canonical = await provider.getBlock(receipt.blockNumber);
      if (canonical?.hash !== receipt.blockHash || latest.number - receipt.blockNumber + 1 < 2
        || finalized.number < receipt.blockNumber) fail(409, 'Transaction is not finalized on the canonical chain.');
      return { tx, receipt };
    });
    // Recheck every observed block before accepting the shared anchor; a reorg
    // or inconsistent RPC response during any batch keeps the journal locked.
    const observedBlocks = new Map();
    for (const { receipt } of proofs) {
      const prior = observedBlocks.get(receipt.blockNumber);
      if (prior && prior !== receipt.blockHash) fail(409, 'Chain changed during receipt verification.');
      observedBlocks.set(receipt.blockNumber, receipt.blockHash);
    }
    const observed = [...observedBlocks.entries()];
    await mapInBatches(observed, 4, async ([number, hash]) => {
      if ((await provider.getBlock(number))?.hash !== hash) fail(409, 'Chain changed during receipt verification.');
    });
    const [finalizedAgain, chainAgain] = await Promise.all([
      provider.getBlock(finalized.number), provider.send('eth_chainId', []),
    ]);
    if (finalizedAgain?.hash !== finalized.hash || BigInt(chainAgain) !== 56n)
      fail(409, 'Chain changed during receipt verification.');
    return proofs;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    fail(503, 'Receipt RPC could not be verified.');
  }
}

/** A completed deployment may be retired only after proving its original transactions. */
export async function verifyCompletedDeployment(provider, record) {
  if (record?.status !== 'complete') fail(409, 'Only a completed deployment can be archived.');
  const librarySteps = record.steps.slice(0, LIBRARY_STEPS.size);
  if (record.steps.length !== LIBRARY_STEPS.size + FINAL_STEPS.length
    || librarySteps.some(step => !LIBRARY_STEPS.has(step.id))
    || new Set(librarySteps.map(step => step.id)).size !== LIBRARY_STEPS.size
    || FINAL_STEPS.some((id, index) => record.steps[LIBRARY_STEPS.size + index].id !== id))
    fail(409, 'Completed deployment has missing or reordered steps.');
  const verification = record.verification;
  if (!verification || !Array.isArray(verification.checks) || verification.checks.length === 0
    || verification.checks.some(check => check?.passed !== true)
    || !isRecord(verification.code)) fail(409, 'Completed deployment lacks a passed graph verification.');
  let previousNonce = -1;
  for (const step of record.steps) {
    if (step.status !== 'confirmed' || step.replacementHash
      || step.previousTxHashes?.length || !Number.isSafeInteger(step.nonce)
      || step.nonce <= previousNonce || !HASH.test(step.txHash)
      || !HASH.test(step.dataHash) || !isRecord(step.receipt))
      fail(409, 'Completed deployment contains an unknown or replaced transaction.');
    previousNonce = step.nonce;
  }
  const proofs = await finalizedCompletedSteps(provider, record.account, record.steps);
  let actualSpent = 0n;
  for (const [index, step] of record.steps.entries()) {
    const { tx, receipt } = proofs[index];
    if (receipt.status !== 1 || tx.value !== 0n || keccak256(tx.data) !== step.dataHash
      || (step.id === 'initialize'
        ? !recordedAddressMatches(record.addresses.AtomicDeployment, tx.to?.toLowerCase())
        : tx.to !== null)
      || step.receipt.blockNumber !== receipt.blockNumber || step.receipt.blockHash !== receipt.blockHash
      || step.receipt.status !== receipt.status
      || step.receipt.gasUsed !== receipt.gasUsed.toString()
      || step.receipt.gasPrice !== receipt.gasPrice.toString()
      || step.receipt.feeWei !== receipt.fee.toString())
      fail(409, 'Completed deployment transaction or receipt differs from the finalized chain.');
    actualSpent += receipt.fee;
    if (step.id === 'initialize') continue;
    const deployed = getCreateAddress({ from: record.account, nonce: step.nonce }).toLowerCase();
    const recordedCode = verification.code[step.id];
    if (receipt.contractAddress?.toLowerCase() !== deployed
      || !recordedAddressMatches(step.address, deployed) || !recordedAddressMatches(record.addresses[step.id], deployed)
      || !isRecord(recordedCode) || !recordedAddressMatches(recordedCode.address, deployed)
      || !HASH.test(step.codehash) || step.codehash.toLowerCase() !== recordedCode.codehash?.toLowerCase())
      fail(409, 'Completed deployment contract address or recorded code identity differs.');
  }
  if (record.spentWei !== actualSpent.toString()) fail(409, 'Completed deployment total Gas fee differs from finalized receipts.');
}

function sessionCookie(token, secure) {
  return `${TOKEN_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/api/journal; Max-Age=${SESSION_MS / 1000}${secure ? '; Secure' : ''}`;
}

export function createJournalService({ dbPath, origin, rpcUrl, secureCookies = false, provider: suppliedProvider } = {}) {
  if (typeof dbPath !== 'string' || !dbPath) throw new Error('Journal database path is required.');
  const parsedOrigin = new URL(origin);
  if (parsedOrigin.origin !== origin || !['https:', 'http:'].includes(parsedOrigin.protocol)) throw new Error('Exact journal origin is required.');
  if (parsedOrigin.protocol === 'http:' && !['127.0.0.1','localhost','[::1]'].includes(parsedOrigin.hostname))
    throw new Error('Journal HTTP origin must be loopback.');
  const cookieSecure = secureCookies || parsedOrigin.protocol === 'https:';
  const store = new JournalStore(dbPath);
  const provider = suppliedProvider ?? (rpcUrl ? new JsonRpcProvider(rpcUrl) : null);
  const inFlight = new Set();
  let closed = false;

  async function respond(req, res) {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    const send = (status, body) => { res.statusCode = status; res.end(JSON.stringify(body)); };
    if (closed) return send(503, { error: 'Journal is unavailable.' });
    try {
      if (!req.url || req.url.length > 2048) fail(400, 'Invalid request URL.');
      const path = new URL(req.url, origin).pathname;
      const method = req.method;
      if (!['GET','POST','PUT','DELETE'].includes(method)) fail(405, 'Method is not allowed.');
      if (method !== 'GET' && req.headers.origin !== origin) fail(403, 'Request origin is not allowed.');
      if (method === 'POST' && path === '/api/journal/challenge') {
        const body = await readJson(req), account = identity(body.account);
        const nonce = randomBytes(24).toString('base64url');
        const expires = Date.now() + CHALLENGE_MS;
        const message = `Pinkuang deployment journal login\nOrigin: ${origin}\nChain ID: 56\nAccount: ${account}\nNonce: ${nonce}\nExpires At: ${new Date(expires).toISOString()}`;
        const active = store.issueChallenge(account, nonce, message, expires);
        return send(200, { message: active.message, nonce: active.nonce });
      }
      if (method === 'POST' && path === '/api/journal/session') {
        const body = await readJson(req), account = identity(body.account);
        if (typeof body.nonce !== 'string' || !CHALLENGE.test(body.nonce) || typeof body.signature !== 'string'
          || body.signature.length > 512) fail(400, 'Invalid wallet login response.');
        const challenge = store.challenge(account, body.nonce);
        if (!challenge || challenge.expires < Date.now()) fail(401, 'Wallet challenge expired.');
        let recovered;
        try { recovered = verifyMessage(challenge.message, body.signature).toLowerCase(); }
        catch { fail(401, 'Wallet signature is invalid.'); }
        if (recovered !== account) fail(401, 'Wallet signature does not match the account.');
        const token = randomBytes(32).toString('base64url');
        if (!store.consumeChallenge(account, body.nonce, hashed(token), Date.now() + SESSION_MS))
          fail(401, 'Wallet challenge has already been used.');
        res.setHeader('Set-Cookie', sessionCookie(token, cookieSecure));
        return send(200, { account });
      }
      const cookies = String(req.headers.cookie ?? '').split(';').map(item => item.trim());
      const token = cookies.find(item => item.startsWith(`${TOKEN_COOKIE}=`))?.slice(TOKEN_COOKIE.length + 1);
      const account = token && /^[A-Za-z0-9_-]{43}$/.test(token) ? store.session(hashed(token)) : null;
      if (!account) fail(401, 'Wallet session is required.');
      const expectedAccount = req.headers['x-pinkuang-account'];
      if (expectedAccount !== undefined && identity(expectedAccount) !== account)
        fail(409, 'Wallet session has switched accounts. Reconnect the selected wallet.');
      if (method === 'GET' && path === '/api/journal/session') return send(200, { account });
      if (method === 'GET' && path === '/api/journal/deployment') return send(200, store.deployment(account));
      if (method === 'GET' && path === '/api/journal/deployment/archives') {
        const url = new URL(req.url, origin);
        if (url.searchParams.getAll('cursor').length > 1 || url.searchParams.getAll('limit').length > 1)
          fail(400, 'Invalid archive page.');
        const cursor = url.searchParams.get('cursor');
        const rawLimit = url.searchParams.get('limit') ?? '20';
        const limit = Number(rawLimit);
        if (cursor !== null && (!/^[1-9]\d{0,18}$/.test(cursor) || BigInt(cursor) > 9223372036854775807n)
          || !DECIMAL.test(rawLimit) || !Number.isSafeInteger(limit) || limit < 1 || limit > 100)
          fail(400, 'Invalid archive page.');
        return send(200, store.archives(account, cursor, limit));
      }
      if (method === 'PUT' && path === '/api/journal/deployment') {
        const body = await readJson(req);
        return send(200, { revision: store.putDeployment(account, validateDeployment(body.record, account), exactRevision(body.expectedRevision)) });
      }
      if (method === 'POST' && path === '/api/journal/deployment/archive') {
        const body = await readJson(req);
        if (typeof body.id !== 'string' || !body.id || body.id.length > 160) fail(400, 'Invalid deployment ID.');
        const current = store.deployment(account);
        if (!current.record || current.revision !== exactRevision(body.expectedRevision) || current.record.id !== body.id)
          fail(409, 'Deployment revision changed.');
        if (current.record.status === 'aborted') await verifyAbortedDeployment(provider, current.record);
        else if (current.record.status === 'complete') await verifyCompletedDeployment(provider, current.record);
        else fail(409, 'Only a completed or aborted deployment can be archived.');
        return send(200, store.archiveDeployment(account, body.id, exactRevision(body.expectedRevision)));
      }
      if (method === 'POST' && path === '/api/journal/deployment/import-archive') {
        const body = await readJson(req);
        return send(200, { id: store.importArchive(account, validateDeployment(body.record, account)) });
      }
      if (method === 'GET' && path === '/api/journal/market') return send(200, store.market(account));
      if (method === 'PUT' && path === '/api/journal/market') {
        const body = await readJson(req);
        return send(200, { revision: store.putMarket(account, validateMarket(body.record, account), exactRevision(body.expectedRevision)) });
      }
      if (method === 'DELETE' && path === '/api/journal/market') {
        const body = await readJson(req), expectedRevision = exactRevision(body.expectedRevision);
        const current = store.market(account);
        if (!current.record || current.revision !== expectedRevision) fail(409, 'Market revision changed.');
        await verifyMarketFinalized(provider, current.record, body.hash);
        return send(200, { revision: store.deleteMarket(account, expectedRevision) });
      }
      if (method === 'POST' && path === '/api/journal/quote') {
        const body = await readJson(req);
        if (!isRecord(body.record)) fail(400, 'Invalid quote record.');
        const id = randomUUID(); store.saveQuote(account, id, body.record);
        return send(200, { id });
      }
      if (method === 'GET' && path === '/api/journal/quotes') {
        const url = new URL(req.url, origin);
        const cursor = url.searchParams.get('cursor') ?? '0', limit = url.searchParams.get('limit') ?? '20';
        if (!DECIMAL.test(cursor) || !DECIMAL.test(limit) || !Number.isSafeInteger(Number(cursor))
          || !Number.isSafeInteger(Number(limit)) || Number(limit) < 1 || Number(limit) > 100)
          fail(400, 'Invalid quote page.');
        return send(200, store.quotes(account, Number(cursor), Number(limit)));
      }
      fail(404, 'Unknown journal route.');
    } catch (error) {
      if (error instanceof JournalConflict) return send(409, { error: error.message });
      if (error instanceof ApiError) return send(error.status, { error: error.message });
      return send(500, { error: 'Journal request failed.' });
    }
  }

  return {
    handle(req, res) {
      const task = respond(req, res);
      inFlight.add(task);
      task.finally(() => inFlight.delete(task));
    },
    async close() {
      closed = true;
      await Promise.allSettled([...inFlight]);
      store.close();
      if (!suppliedProvider) provider?.destroy();
    },
  };
}

export function journalConfiguration(env = process.env) {
  const production = env.NODE_ENV === 'production';
  const dbPath = env.DEPLOYMENT_JOURNAL_DB || (!production && fileURLToPath(new URL('../.local/journal.sqlite', import.meta.url)));
  const origin = env.DEPLOYMENT_JOURNAL_ORIGIN || (!production && 'http://127.0.0.1:4173');
  const rpcUrl = env.DEPLOYMENT_JOURNAL_RPC_URL;
  if (!dbPath || !origin || production && !rpcUrl) throw new Error('Production journal requires explicit DB, origin and BSC RPC URL.');
  if (rpcUrl && !/^https:\/\//.test(rpcUrl)) throw new Error('Journal BSC RPC URL must use HTTPS.');
  if (production && !/^https:\/\//.test(origin)) throw new Error('Production journal origin must use HTTPS.');
  return { dbPath, origin, rpcUrl,
    secureCookies: production || origin.startsWith('https://') || env.DEPLOYMENT_JOURNAL_SECURE_COOKIES === '1' };
}
