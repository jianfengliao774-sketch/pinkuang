import { openSync, closeSync, existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, unlinkSync, fsyncSync, statSync, chmodSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { Contract, Interface, JsonRpcProvider, FetchRequest, Wallet, ZeroAddress, formatEther, getAddress, parseEther, parseUnits, Transaction, keccak256 } from 'ethers';

export const KEEPER_STATE_ROOT = resolve(homedir(), '.local/state/pinkuang/purchase-keeper');

export const OFFICIAL_MARKET = '0x6feEbbEbC07BcB90bd1Ac8b0CF9BaA4f0fF2B46f';
export const OFFICIAL_COLLECTIONS = ['0xb1024b89886B9a34Aa4ff5F31C411D708b20a14C', '0x1F5Cb4aeaE1807Bf60c3b9C0D8aDBCC14e91f12C'];
export const MINING = '0x7E2E0DC66a3bD9103E69b766afA62d9f7b697b46';
export const FIRSTO_API = 'https://api-tapeout.firsto.ai/v1/circuits';
export const KEEPER_POOL_ABI = [
  'function factory() view returns(address)', 'function OFFICIAL_FACTORY() view returns(address)',
  'function state() view returns(uint8)',
  'function params() view returns(tuple(address circuits,uint256 circuitId,uint256 targetRaise,uint256 priceCap,address directSeller,uint256 directPrice,uint64 fundingDeadline,uint64 purchaseDeadline))',
  'function flexiblePurchase() view returns(bool enabled,uint256 referenceCircuitId,tuple(uint128 minVerifiedWeight,uint256 referencePriceWei,uint256 targetDailyYieldAtomic,uint16 extraBps,uint64 referenceObservedAt,uint64 referenceBlock,bytes32 referenceDigest) config)',
  'function buyAlternativeFromMarket(uint256 listingId)',
  'function purchaseModel() view returns(bool initialized,uint32 taskId)',
  'function purchaseReferenceWeight() view returns(uint128)',
];
const FACTORY_ABI = ['function isPool(address) view returns(bool)'];
export const LISTING_ABI = [
  'function listingFor(address circuits,uint256 tokenId) view returns(uint256 id,address seller,uint96 price,bool valid)',
  'function listingView(uint256) view returns(address seller,address circuits,uint256 tokenId,uint96 price,uint16 feeBps,bool valid)',
];
const same = (left, right) => left.toLowerCase() === right.toLowerCase();
const integer = value => typeof value === 'bigint' ? value : typeof value === 'string' && /^\d+$/.test(value) ? BigInt(value) : null;
const serial = value => JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? item.toString() : item, 2);
const normalizeAddress = value => { const result = getAddress(value); if (result === ZeroAddress) throw new Error('Zero address is not allowed.'); return result; };

export function parseArguments(args) {
  const values = {};
  const flags = new Set(['send', 'once', 'help', 'speed-up', 'rebroadcast', 'cancel-pending']);
  const supported = new Set(['factory', 'pool', 'rpc', 'journal', 'interval', 'refresh-interval', 'pages', 'sort', 'from', 'max-gas-bnb', 'max-gas-price-gwei', 'recover-hash', 'max-speed-ups', 'pending-seconds']);
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index].startsWith('--') ? args[index].slice(2) : '';
    if (!key || Object.hasOwn(values, key)) throw new Error(`Invalid or repeated option: ${args[index]}`);
    if (flags.has(key)) values[key] = true;
    else if (supported.has(key) && args[index + 1] && !args[index + 1].startsWith('--')) values[key] = args[++index];
    else throw new Error(`Unknown option or missing value: --${key}`);
  }
  if (values.help) return { help: true };
  if (!values.factory || !values.pool) throw new Error('--factory and --pool are required. Use --help for usage.');
  const factory = normalizeAddress(values.factory), pool = normalizeAddress(values.pool);
  const interval = Number(values.interval ?? 2), refreshInterval = Number(values['refresh-interval'] ?? 30), pages = Number(values.pages ?? 3);
  if (!Number.isSafeInteger(interval) || interval < 1 || interval > 3600) throw new Error('--interval must be 1–3600 seconds.');
  if (!Number.isSafeInteger(refreshInterval) || refreshInterval < 5 || refreshInterval > 3600) throw new Error('--refresh-interval must be 5–3600 seconds.');
  if (!Number.isSafeInteger(pages) || pages < 1 || pages > 10) throw new Error('--pages must be 1–10.');
  const sort = values.sort ?? 'capacity';
  if (!['capacity', 'price'].includes(sort)) throw new Error('--sort must be capacity or price.');
  const rpc = values.rpc ?? 'https://bsc-dataseed.bnbchain.org';
  const rpcUrl = new URL(rpc);
  if (!/^https?:$/.test(rpcUrl.protocol)) throw new Error('RPC must be an HTTP(S) URL.');
  const loopback = rpcUrl.hostname === 'localhost' || rpcUrl.hostname === '[::1]' || /^127\.(?:\d{1,3}\.){2}\d{1,3}$/.test(rpcUrl.hostname);
  if (values.send && rpcUrl.protocol !== 'https:' && !loopback) throw new Error('--send requires HTTPS RPC; HTTP is permitted only on loopback for local tests.');
  if (values.send && !values.journal) throw new Error('--send requires an explicit --journal path for durable recovery.');
  const maxGasWei = parseEther(values['max-gas-bnb'] ?? '0.01'), maxGasPrice = parseUnits(values['max-gas-price-gwei'] ?? '1', 'gwei');
  if (maxGasWei <= 0n || maxGasPrice <= 0n) throw new Error('Gas limits must be positive.');
  if (values['recover-hash'] && !/^0x[0-9a-f]{64}$/i.test(values['recover-hash'])) throw new Error('Invalid --recover-hash.');
  if ([values['speed-up'], values.rebroadcast, values['cancel-pending']].filter(Boolean).length > 1) throw new Error('Choose only one recovery action, not both or several.');
  if ((values['speed-up'] || values.rebroadcast || values['cancel-pending']) && (!values.send || !values.once)) throw new Error('Recovery requires explicit --send --once.');
  const maxSpeedUps = Number(values['max-speed-ups'] ?? 3), pendingSeconds = Number(values['pending-seconds'] ?? 120);
  if (!Number.isSafeInteger(maxSpeedUps) || maxSpeedUps < 0 || maxSpeedUps > 5) throw new Error('--max-speed-ups must be 0–5.');
  if (!Number.isSafeInteger(pendingSeconds) || pendingSeconds < 30 || pendingSeconds > 86400) throw new Error('--pending-seconds must be 30–86400.');
  return { factory, pool, rpc, cancelPending: values['cancel-pending'] === true, speedUp: values['speed-up'] === true, rebroadcast: values.rebroadcast === true, maxSpeedUps, pendingSeconds, send: values.send === true, once: values.once === true, interval, refreshInterval, pages, sort,
    from: values.from ? normalizeAddress(values.from) : null, maxGasWei, maxGasPrice,
    journal: resolve(values.journal ?? `keeper-journal/${pool.toLowerCase()}.json`), recoverHash: values['recover-hash'] };
}

/** Discover NFTs, not execution routes. Even a signed/batch bestAsk may have a separate official listing. */
export function selectCandidates(rows, constraints, sort = 'capacity') {
  const candidates = new Map();
  for (const row of rows) {
    if (!row || !OFFICIAL_COLLECTIONS.some(item => same(item, String(row.collection))) || !same(row.collection, constraints.circuits)) continue;
    const ask = row.bestAsk, mining = row.mining;
    if (row.category !== 'official_mining' || mining?.status !== 'verified') continue;
    const taskId = typeof mining.taskId === 'number' && Number.isSafeInteger(mining.taskId) && mining.taskId >= 0 ? BigInt(mining.taskId) : integer(mining.taskId);
    if (taskId === null || constraints.taskId === undefined || taskId !== BigInt(constraints.taskId)) continue;
    const tokenId = integer(row.tokenId), priceWei = integer(ask?.priceWei) ?? constraints.priceCap + 1n;
    const verifiedWeight = integer(mining.verifiedWeight), unverifiedWeight = integer(mining.unverifiedWeight), daily = integer(mining.estimated24hAtomic);
    if (tokenId === null || verifiedWeight === null || verifiedWeight < constraints.minVerifiedWeight
      || verifiedWeight === 0n || unverifiedWeight !== 0n) continue;
    const collection = normalizeAddress(row.collection), key = `${collection.toLowerCase()}:${tokenId}`;
    candidates.set(key, { key, collection, tokenId, taskId, priceWei, verifiedWeight, estimated24hAtomic: daily ?? 0n,
      indexerBuyerCostWei: integer(ask?.buyerCostWei), discoverySource: 'Firsto official_mining',
      discoveryVenue: typeof ask?.venue === 'string' ? ask.venue.slice(0, 40) : null });
  }
  return [...candidates.values()].sort((a, b) => compareCandidates(a, b, sort));
}

export function compareCandidates(a, b, sort) {
  // Verified weight has the same daily-emission multiplier for eligible active miners.
  const difference = sort === 'capacity' ? a.priceWei * b.verifiedWeight - b.priceWei * a.verifiedWeight : a.priceWei - b.priceWei;
  if (difference !== 0n) return difference < 0n ? -1 : 1;
  const left = a.listingId ?? a.tokenId, right = b.listingId ?? b.tokenId;
  return left < right ? -1 : left > right ? 1 : 0;
}

export const MAX_DISCOVERY_BYTES = 2 * 1024 * 1024;

function abortable(operation, signal) {
  return new Promise((resolve, reject) => {
    const finish = (settle, value) => { signal.removeEventListener('abort', aborted); settle(value); };
    const aborted = () => finish(reject, new Error('Firsto discovery timed out or was aborted.'));
    // Always attach rejection handlers, including for an already-aborted signal.
    Promise.resolve(operation).then(value => finish(resolve, value), error => finish(reject, error));
    if (signal.aborted) aborted();
    else signal.addEventListener('abort', aborted, { once: true });
  });
}

async function readDiscoveryJson(response, remainingBytes, signal) {
  let reader, complete = false;
  try {
    if (response.redirected) throw new Error('Firsto redirects are not permitted.');
    if (!response.ok) throw new Error(`Firsto indexer returned HTTP ${response.status}.`);
    const contentType = (response.headers.get('content-type') ?? '').split(';', 1)[0].trim().toLowerCase();
    if (contentType !== 'application/json' && !/^application\/[a-z0-9!#$&^_.+-]+\+json$/.test(contentType)) throw new Error('Firsto response must have a JSON content type.');
    const declared = response.headers.get('content-length');
    if (declared && /^\d+$/.test(declared) && BigInt(declared) > BigInt(remainingBytes)) throw new Error('Firsto discovery exceeds the 2 MiB total body limit.');
    if (!response.body) throw new Error('Firsto response has no readable body.');
    reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let bytes = 0, text = '';
    for (;;) {
      const { done, value } = await abortable(reader.read(), signal);
      if (done) break;
      bytes += value.byteLength;
      if (bytes > remainingBytes) throw new Error('Firsto discovery exceeds the 2 MiB total body limit.');
      text += decoder.decode(value, { stream: true });
    }
    if (signal.aborted) throw new Error('Firsto discovery timed out or was aborted.');
    text += decoder.decode();
    let payload;
    try { payload = JSON.parse(text); } catch { throw new Error('Firsto response contains invalid JSON.'); }
    complete = true;
    return { payload, bytes };
  } finally {
    // Never await a stalled server's cancellation callback. Abort bounds body
    // consumption as well as headers; there is no unbounded response.json().
    if (!complete) {
      const cancellation = reader ? reader.cancel() : response.body?.cancel();
      cancellation?.catch(() => {});
    }
    reader?.releaseLock();
  }
}

export async function fetchCandidates(options, constraints, fetcher = fetch) {
  const rows = []; let pagesRead = 0, sourceBlock = null, consumedBytes = 0;
  // One deadline covers every page, including streamed bodies and header waits.
  const signal = options.signal ? AbortSignal.any([AbortSignal.timeout(20_000), options.signal]) : AbortSignal.timeout(20_000);
  for (let page = 1; page <= options.pages; page += 1) {
    if (signal.aborted) throw new Error('Firsto discovery timed out or was aborted.');
    const url = new URL(FIRSTO_API);
    url.search = new URLSearchParams({ category: 'official_mining', sort: options.sort === 'price' ? 'price_low' : 'daily_capacity_price_low', page: String(page), pageSize: '50' }).toString();
    const response = await abortable(fetcher(url, { headers: { accept: 'application/json' }, redirect: 'error', signal }), signal);
    const { payload, bytes } = await readDiscoveryJson(response, MAX_DISCOVERY_BYTES - consumedBytes, signal);
    consumedBytes += bytes;
    if (!Array.isArray(payload?.rows)) throw new Error('Firsto response is missing rows.');
    if (payload.rows.length > 50) throw new Error('Firsto response exceeds the 50-row page limit.');
    rows.push(...payload.rows); pagesRead += 1; sourceBlock = payload.sourceBlock ?? sourceBlock;
    if (payload.rows.length < 50 || Number(payload.totalPages) <= page) break;
  }
  return { candidates: selectCandidates(rows, constraints, options.sort), scannedRows: rows.length, pagesRead, sourceBlock,
    nonOfficialBestAsks: rows.filter(row => row?.bestAsk && row.bestAsk.venue !== 'official').length };
}

export function inspectPoolState(state, enabled, deadline, timestamp) {
  if (!enabled) return { eligible: false, terminal: true, reason: 'fixed-purchase-policy-disabled' };
  if (state === 2n || state === 3n || state === 4n) return { eligible: false, terminal: true, reason: 'purchase-already-completed' };
  if (state === 5n) return { eligible: false, terminal: true, reason: 'pool-refunding' };
  if (timestamp >= deadline) return { eligible: false, terminal: true, reason: 'purchase-window-expired-finalizeFailure-available' };
  if (state !== 1n) return { eligible: false, terminal: false, reason: 'waiting-for-Funded-state' };
  return { eligible: true, terminal: false, reason: 'ready' };
}

export async function readKeeperPool(provider, options) {
  if ((await provider.getNetwork()).chainId !== 56n) throw new Error('Keeper only supports BSC mainnet chainId 56.');
  const block = await provider.getBlock('latest');
  if (!block) throw new Error('Cannot read latest block.');
  const opts = { blockTag: block.number };
  const registry = new Contract(options.factory, FACTORY_ABI, provider), pool = new Contract(options.pool, KEEPER_POOL_ABI, provider);
  const [registered, boundFactory, officialFactory, state, params, policy, model, referenceWeight, factoryCode, poolCode] = await Promise.all([
    registry.isPool(options.pool, opts), pool.factory(opts), pool.OFFICIAL_FACTORY(opts), pool.state(opts), pool.params(opts), pool.flexiblePurchase(opts), pool.purchaseModel(opts), pool.purchaseReferenceWeight(opts),
    provider.getCode(options.factory, block.number), provider.getCode(options.pool, block.number),
  ]);
  if (factoryCode === '0x' || poolCode === '0x') throw new Error('Factory or pool has no deployed code.');
  if (!registered || !same(boundFactory, options.factory) || !same(officialFactory, options.factory)) throw new Error('Factory membership or immutable factory binding does not match.');
  if (!OFFICIAL_COLLECTIONS.some(item => same(item, params.circuits))) throw new Error('Pool collection is not an official TapeOut/Behemoth collection.');
  if (policy.enabled && !model.initialized) throw new Error('Flexible pool has no immutable on-chain purchase model; create a new configured pool.');
  if (policy.enabled && referenceWeight === 0n) throw new Error('Flexible pool has no immutable reference weight; legacy pricing cannot purchase. Create a new configured pool.');
  const check = inspectPoolState(state, policy.enabled, params.purchaseDeadline, BigInt(block.timestamp));
  if (policy.enabled && (policy.config.minVerifiedWeight === 0n || params.priceCap === 0n)) throw new Error('Invalid flexible-purchase constraints.');
  return { ...check, blockNumber: block.number, blockGasLimit: block.gasLimit, enabled: policy.enabled, state, circuits: params.circuits, priceCap: params.priceCap,
    purchaseDeadline: params.purchaseDeadline, taskId: model.taskId, referenceVerifiedWeight: referenceWeight, minVerifiedWeight: policy.config.minVerifiedWeight,
    referencePriceWei: policy.config.referencePriceWei, referenceCircuitId: policy.referenceCircuitId };
}

export async function verifyCandidate(provider, candidate, constraints) {
  const opts = { blockTag: constraints.blockNumber }, exchange = new Contract(OFFICIAL_MARKET, LISTING_ABI, provider);
  const current = await exchange.listingFor(candidate.collection, candidate.tokenId, opts);
  if (!current.valid || current.id === 0n || current.seller === ZeroAddress || current.price === 0n || current.price > constraints.priceCap) return null;
  const listing = await exchange.listingView(current.id, opts);
  if (!listing.valid || listing.seller === ZeroAddress || listing.price === 0n || listing.price > constraints.priceCap
    || !same(listing.circuits, constraints.circuits) || listing.tokenId !== candidate.tokenId
    || !same(listing.seller, current.seller) || listing.price !== current.price) return null;
  // The Vault's mandatory estimateGas EVM simulation checks current mining status, non-optimal/verified
  // capacity, total-price and unit-weight caps, deadline and NFT ownership together with purchase settlement.
  // Repeating minerKey/getMiner here would add RPCs without strengthening that atomic check.
  return { ...candidate, listingId: current.id, priceWei: listing.price,
    officialListingSource: 'CircuitMarket.listingFor', officialObservedBlock: constraints.blockNumber };
}

export function createKeeperRuntime() {
  return { constraints: null, queue: [], refreshTask: null, lastRefreshStarted: 0, lastRefreshCompleted: 0,
    refreshError: null, discovery: null, stopped: false, abortController: new AbortController() };
}

function referenceFirst(candidates, constraints, sort) {
  const key = `${constraints.circuits.toLowerCase()}:${constraints.referenceCircuitId}`;
  const existing = candidates.find(candidate => candidate.key === key);
  const reference = existing ? { ...existing, isReference: true } : {
    key, collection: constraints.circuits, tokenId: constraints.referenceCircuitId, priceWei: constraints.referencePriceWei,
    verifiedWeight: constraints.minVerifiedWeight, isReference: true, discoverySource: 'pool-reference', discoveryVenue: null,
    indexerSourceBlock: null, indexerBuyerCostWei: null,
  };
  return [reference, ...candidates.filter(candidate => candidate.key !== key).sort((a, b) => compareCandidates(a, b, sort))].slice(0, 30);
}

async function pollPoolState(provider, options, cached) {
  if ((await provider.getNetwork()).chainId !== 56n) throw new Error('Keeper only supports BSC mainnet chainId 56.');
  const block = await provider.getBlock('latest');
  if (!block) throw new Error('Cannot read latest block.');
  const state = await new Contract(options.pool, KEEPER_POOL_ABI, provider).state({ blockTag: block.number });
  return { ...cached, ...inspectPoolState(state, cached.enabled, cached.purchaseDeadline, BigInt(block.timestamp)), state,
    blockNumber: block.number, blockGasLimit: block.gasLimit };
}

/** Refresh discovery in the background while the state watcher keeps polling. Never signs. */
export function startCandidateRefresh(provider, options, constraints, runtime, fetcher = fetch) {
  if (runtime.refreshTask || runtime.stopped) return runtime.refreshTask;
  runtime.lastRefreshStarted = Date.now();
  runtime.refreshTask = (async () => {
    try {
      const indexed = await fetchCandidates({ ...options, signal: runtime.abortController.signal }, constraints, fetcher);
      if (runtime.stopped) return;
      const block = await provider.getBlock('latest');
      if (!block) throw new Error('Cannot read block for candidate preparation.');
      const discoveryConstraints = { ...constraints, blockNumber: block.number }, prepared = [];
      const candidates = referenceFirst(indexed.candidates, constraints, options.sort);
      for (let offset = 0; offset < candidates.length && !runtime.stopped; offset += 4) {
        const resolved = await Promise.allSettled(candidates.slice(offset, offset + 4).map(candidate => verifyCandidate(provider,
          { ...candidate, indexerSourceBlock: indexed.sourceBlock }, discoveryConstraints)));
        for (const result of resolved) if (result.status === 'fulfilled' && result.value) prepared.push(result.value);
        // Publish early batches: funding completion need not wait for the remaining NFT lookups.
        if (prepared.length) {
          const merged = new Map([...runtime.queue, ...prepared].map(candidate => [candidate.key, candidate]));
          runtime.queue = referenceFirst([...merged.values()], constraints, options.sort);
        }
      }
      if (!runtime.stopped) {
        runtime.queue = referenceFirst(prepared, constraints, options.sort);
        runtime.discovery = { scannedRows: indexed.scannedRows, pagesRead: indexed.pagesRead, sourceBlock: indexed.sourceBlock,
          nonOfficialBestAsks: indexed.nonOfficialBestAsks, resolvedOfficialListings: prepared.length };
        runtime.lastRefreshCompleted = Date.now(); runtime.refreshError = null;
      }
    } catch (error) {
      // Old entries remain discovery hints only. Every attempt still resolves the
      // current listing and simulates against the chain; an API failure grants no permission.
      if (!runtime.stopped) runtime.refreshError = String(error?.message || 'Candidate refresh failed.').slice(0, 250);
    } finally { runtime.refreshTask = null; }
  })();
  return runtime.refreshTask;
}

const RESOLVED_PHASES = ['confirmed', 'reverted', 'cancelled', 'cancel-reverted'];
function finalizedRecord(transaction) {
  return RESOLVED_PHASES.includes(transaction?.phase) && transaction.finality === 'bsc-finalized'
    && Number.isSafeInteger(transaction.blockNumber) && transaction.blockNumber >= 0
    && Number.isSafeInteger(transaction.finalizedBlockNumber) && transaction.finalizedBlockNumber >= transaction.blockNumber
    && /^0x[0-9a-f]{64}$/i.test(transaction.blockHash ?? '') && /^0x[0-9a-f]{64}$/i.test(transaction.finalizedBlockHash ?? '');
}

function readPrivateJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch { throw new Error('Private keeper ledger cannot be read or parsed. Preserve it for manual recovery.'); }
}

export function readJournal(path, options) {
  if (!existsSync(path)) return { version: 1, chainId: 56, factory: options.factory, pool: options.pool, transaction: null, gasSpentWei: '0', gasReceipts: {} };
  const journal = readPrivateJson(path);
  if (journal.version !== 1 || journal.chainId !== 56 || !same(journal.factory ?? '', options.factory) || !same(journal.pool ?? '', options.pool)) throw new Error('Journal belongs to a different chain, factory or pool; use the original path.');
  const tx = journal.transaction;
  if (tx && (!['intent', 'signed', 'broadcast', 'confirmed', 'reverted', 'cancelled', 'cancel-reverted'].includes(tx.phase) || !Number.isSafeInteger(tx.nonce) || tx.nonce < 0
    || !/^0x[0-9a-f]+$/i.test(tx.data ?? '') || tx.value !== '0' || !tx.from || (tx.hash && !/^0x[0-9a-f]{64}$/i.test(tx.hash)))) throw new Error('Malformed journal transaction. Do not erase unresolved records.');
  if (tx) normalizeAddress(tx.from);
  if (tx && RESOLVED_PHASES.includes(tx.phase) && !finalizedRecord(tx)) throw new Error('Legacy terminal journal has no BSC finalized proof. Manually reconcile its receipt before releasing this wallet.');
  if (tx?.attempts) {
    if (!Array.isArray(tx.attempts) || tx.attempts.length < 1 || tx.attempts.length > 6 || tx.speedUps !== tx.attempts.length - 1) throw new Error('Malformed signed attempt history.');
    if ((statSync(path).mode & 0o077) !== 0) throw new Error('Signed transaction journal must have private 0600 permissions.');
    const hashes = new Set();
    for (const attempt of tx.attempts) {
      validateSignedAttempt(attempt, tx, options);
      if (hashes.has(attempt.hash)) throw new Error('Duplicate signed attempt hash.');
      hashes.add(attempt.hash);
    }
    if (!hashes.has(tx.hash)) throw new Error('Current hash is missing from signed attempts.');
  }
  if (journal.gasSpentWei === undefined) {
    if (journal.previousTransaction || (tx && ['confirmed', 'reverted', 'cancelled', 'cancel-reverted'].includes(tx.phase))) throw new Error('Legacy journal lacks cumulative gas accounting. Reconstruct receipt history before any further send.');
    journal.gasSpentWei = '0'; journal.gasReceipts = {};
  }
  if (!/^\d+$/.test(journal.gasSpentWei) || !journal.gasReceipts || typeof journal.gasReceipts !== 'object') throw new Error('Malformed cumulative gas journal.');
  let total = 0n;
  for (const [hash, cost] of Object.entries(journal.gasReceipts)) {
    if (!/^0x[0-9a-f]{64}$/i.test(hash) || typeof cost !== 'string' || !/^\d+$/.test(cost)) throw new Error('Malformed gas receipt entry.');
    total += BigInt(cost);
  }
  if (total.toString() !== journal.gasSpentWei) throw new Error('Cumulative gas budget does not match receipt accounting.');
  return journal;
}

export function gasBudget(journal, gasLimit, gasPrice, totalLimit) {
  const spent = BigInt(journal.gasSpentWei ?? '0'), maximumNextFee = gasLimit * gasPrice;
  const unresolved = journal.transaction && !['confirmed', 'reverted', 'cancelled', 'cancel-reverted'].includes(journal.transaction.phase);
  const maximumPendingFee = unresolved ? (journal.transaction.attempts ?? []).reduce((maximum, attempt) => {
    const cost = BigInt(attempt.gasLimit) * BigInt(attempt.gasPrice); return cost > maximum ? cost : maximum;
  }, 0n) : 0n;
  // Only one same-nonce attempt can win, but every signed attempt can still win.
  // A smaller cancellation or a lower new CLI budget cannot revoke that exposure.
  const reservedFee = maximumNextFee > maximumPendingFee ? maximumNextFee : maximumPendingFee;
  return { allowed: spent + reservedFee <= totalLimit, spent, maximumNextFee, maximumPendingFee, reservedFee, remaining: totalLimit > spent ? totalLimit - spent : 0n };
}

export function writeJournal(path, journal) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  const fd = openSync(temporary, 'wx', 0o600);
  try { writeFileSync(fd, `${serial(journal)}\n`); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temporary, path);
  const directory = openSync(dirname(path), 'r');
  try { fsyncSync(directory); } finally { closeSync(directory); }
}

export function acquireKeeperLock(resourcePath, root = resolve(KEEPER_STATE_ROOT, 'locks')) {
  mkdirSync(root, { recursive: true, mode: 0o700 }); chmodSync(root, 0o700);
  const identity = keccak256(new TextEncoder().encode(resolve(resourcePath))).slice(2);
  const lock = resolve(root, `${identity}.lock`);
  let fd;
  try { fd = openSync(lock, 'wx', 0o600); }
  catch (error) { if (error.code === 'EEXIST') throw new Error(`Keeper lock already exists: ${lock}. Check its PID before manually removing a stale lock.`); throw error; }
  writeFileSync(fd, `${serial({ pid: process.pid, resource: resolve(resourcePath), createdAt: new Date().toISOString() })}\n`); closeSync(fd);
  let released = false;
  return () => { if (!released) { released = true; unlinkSync(lock); } };
}

/** The persistent wallet pointer also blocks a different pool after --once exits or a process crashes. */
export function acquireWalletLock(address, journalPath, root = resolve(KEEPER_STATE_ROOT, 'wallets')) {
  mkdirSync(root, { recursive: true, mode: 0o700 }); chmodSync(root, 0o700);
  const path = resolve(root, `56-${normalizeAddress(address).toLowerCase()}.json`);
  const release = acquireKeeperLock(path, resolve(root, 'locks'));
  try {
    if (existsSync(path)) {
      const owner = readPrivateJson(path);
      // Check even when resuming the same path. Never silently replace a lost
      // pending ledger with a fresh empty file before reserving another nonce.
      if (!existsSync(owner.journal)) throw new Error('Wallet has an unavailable previous journal; preserve the pointer and recover that journal before sending.');
      const previous = readPrivateJson(owner.journal);
      readJournal(owner.journal, { factory: previous.factory, pool: previous.pool });
      if (owner.journal !== resolve(journalPath) && previous.transaction && !finalizedRecord(previous.transaction)) throw new Error('Wallet has an unresolved transaction in another pool journal. Reconcile that journal first.');
    }
    writeJournal(path, { chainId: 56, address: normalizeAddress(address), journal: resolve(journalPath) });
    return release;
  } catch (error) { release(); throw error; }
}

function validateTransaction(transaction, pending, options, kind = 'purchase') {
  const expectedTo = kind === 'cancel' ? pending.from : options.pool, expectedData = kind === 'cancel' ? '0x' : pending.data;
  if (!transaction || !same(transaction.from ?? '', pending.from) || !transaction.to || !same(transaction.to, expectedTo)
    || transaction.nonce !== pending.nonce || transaction.data !== expectedData || transaction.value !== 0n || transaction.chainId !== 56n) {
    throw new Error('Recovered hash does not match the persisted keeper transaction.');
  }
}

function validateSignedAttempt(attempt, pending, options) {
  let transaction;
  try { transaction = Transaction.from(attempt.raw); } catch { throw new Error('Invalid signed transaction journal.'); }
  if (attempt.kind && !['purchase', 'cancel'].includes(attempt.kind)) throw new Error('Unknown signed attempt kind.');
  validateTransaction(transaction, pending, options, attempt.kind);
  if (!transaction.isSigned() || transaction.type !== 0 || keccak256(attempt.raw) !== attempt.hash || transaction.hash !== attempt.hash
    || transaction.gasPrice?.toString() !== attempt.gasPrice || transaction.gasLimit.toString() !== attempt.gasLimit) throw new Error('Signed transaction identity or gas fields do not match journal.');
  return transaction;
}

async function signAttempt(signer, pending, options, gasLimit, gasPrice, kind = 'purchase') {
  let raw;
  try { raw = await signer.signTransaction({ type: 0, chainId: 56, to: kind === 'cancel' ? pending.from : options.pool, nonce: pending.nonce,
    data: kind === 'cancel' ? '0x' : pending.data, value: 0n, gasLimit, gasPrice }); } catch { throw new Error('Local transaction signing failed; nothing was broadcast.'); }
  const attempt = { kind, raw, hash: keccak256(raw), gasLimit: gasLimit.toString(), gasPrice: gasPrice.toString(),
    createdAt: new Date().toISOString(), broadcastCount: 0 };
  validateSignedAttempt(attempt, pending, options);
  return attempt;
}

async function finalBroadcastBoundary(provider, pending, replacement = false) {
  const [network, latest, queued] = await Promise.all([provider.getNetwork(), provider.getTransactionCount(pending.from, 'latest'), provider.getTransactionCount(pending.from, 'pending')]);
  if (network.chainId !== 56n) return 'chain-changed-before-broadcast';
  if (latest !== pending.nonce || queued < latest || queued > pending.nonce + (replacement ? 1 : 0)) return 'nonce-changed-before-broadcast-manual-review';
  return null;
}

function stoppedResult(runtime, stage, hash) {
  return runtime?.stopped || runtime?.abortController.signal.aborted
    ? { status: `stopped-before-${stage}`, terminal: true, ...(hash ? { hash } : {}),
      message: 'No new signature or broadcast will start. Any already signed attempt remains in its journal for explicit recovery.' }
    : null;
}

async function broadcastSigned(provider, options, journal, attempt, replacement = false, runtime) {
  const beforeBoundary = stoppedResult(runtime, 'broadcast', attempt.hash);
  if (beforeBoundary) return beforeBoundary;
  const blocked = await finalBroadcastBoundary(provider, journal.transaction, replacement);
  if (blocked) return { status: blocked, terminal: true, hash: attempt.hash };
  // A stop during the RPC boundary must not start a new send. Keep signed bytes
  // and nonce ownership durable; stopping does not cancel an earlier broadcast.
  const beforeBroadcast = stoppedResult(runtime, 'broadcast', attempt.hash);
  if (beforeBroadcast) return beforeBroadcast;
  // The exact raw bytes and their deterministic hash are already fsynced. A timeout
  // therefore leaves a queryable transaction; recovery can only rebroadcast these bytes.
  attempt.broadcastCount += 1; attempt.lastBroadcastAt = new Date().toISOString();
  writeJournal(options.journal, journal);
  try {
    const response = await provider.broadcastTransaction(attempt.raw);
    if (response.hash.toLowerCase() !== attempt.hash) throw new Error('Unexpected broadcast hash.');
    journal.transaction.phase = 'broadcast'; writeJournal(options.journal, journal);
    return { status: 'broadcast', terminal: false, hash: attempt.hash };
  } catch {
    return { status: 'broadcast-result-unknown', terminal: false, hash: attempt.hash,
      message: 'The signed transaction and hash are retained. Default recovery only checks receipts; --rebroadcast can send the exact same bytes.' };
  }
}

export async function reconcilePending(provider, options, journal) {
  const pending = journal.transaction;
  if (!pending) return null;
  if (RESOLVED_PHASES.includes(pending.phase)) {
    if (!finalizedRecord(pending)) throw new Error('Legacy terminal journal has no BSC finalized proof; manual reconciliation required.');
    return null;
  }
  if ((await provider.getNetwork()).chainId !== 56n) throw new Error('Receipt lookup must use BSC chainId 56.');
  const attempts = pending.attempts ?? (pending.hash ? [{ hash: pending.hash.toLowerCase() }] : []);
  if (options.recoverHash) {
    const hash = options.recoverHash.toLowerCase();
    if (pending.attempts && !attempts.some(attempt => attempt.hash === hash)) throw new Error('Recovery hash is not one of the signed transaction attempts.');
    if (!attempts.some(attempt => attempt.hash === hash)) attempts.push({ hash });
  }
  if (!attempts.length) return { status: 'unknown-broadcast', terminal: false, message: 'Legacy intent has no signed hash. No resend; recover using the exact transaction hash from wallet history.' };
  const pendingSeconds = Math.max(0, Math.floor((Date.now() - Date.parse(pending.createdAt)) / 1000));
  const info = { hashes: attempts.map(attempt => attempt.hash), hash: pending.hash ?? attempts[0].hash, pendingSeconds,
    overdue: pendingSeconds >= (options.pendingSeconds ?? 120), speedUps: pending.speedUps ?? 0,
    message: 'No automatic resend or fee increase. Explicit --rebroadcast sends identical bytes; --speed-up replaces only this purchase at the same nonce.' };
  const observations = await Promise.all(attempts.map(async attempt => {
    if (attempt.raw) validateSignedAttempt(attempt, pending, options);
    const [transaction, receipt] = await Promise.all([provider.getTransaction(attempt.hash), provider.getTransactionReceipt(attempt.hash)]);
    if (transaction) validateTransaction(transaction, pending, options, attempt.kind);
    if (receipt && !transaction && !attempt.raw) throw new Error('Cannot authenticate a legacy receipt without its transaction.');
    if (!receipt) return { attempt, transaction, receipt: null };
    if (!same(receipt.hash ?? '', attempt.hash) || !same(receipt.from ?? '', pending.from)
      || !same(receipt.to ?? '', attempt.kind === 'cancel' ? pending.from : options.pool)) throw new Error('Receipt identity does not match signed transaction attempt.');
    if (![0, 1].includes(receipt.status) || !/^0x[0-9a-f]{64}$/i.test(receipt.blockHash ?? '')) throw new Error('Receipt is missing a final status or canonical block identity.');
    const block = await provider.getBlock(receipt.blockNumber);
    return { attempt, transaction, receipt, canonical: !!block && same(block.hash ?? '', receipt.blockHash) };
  }));
  if (!pending.attempts && options.recoverHash && observations.some(item => item.attempt.hash === options.recoverHash.toLowerCase() && item.transaction)) {
    pending.hash = options.recoverHash.toLowerCase(); writeJournal(options.journal, journal);
  }
  const mined = observations.filter(item => item.receipt && item.canonical);
  if (mined.length > 1) throw new Error('Conflicting canonical receipts for the same nonce; manual reconciliation required.');
  if (mined.length) {
    const { attempt, receipt } = mined[0];
    const confirmations = (await provider.getBlockNumber()) - receipt.blockNumber + 1;
    if (confirmations < 2) return { status: 'pending-confirmations', terminal: false, ...info, hash: attempt.hash, confirmations, requiredConfirmations: 2 };
    let finalized;
    try { finalized = await provider.getBlock('finalized'); } catch { /* Fail closed when the RPC lacks BSC finality support. */ }
    if (!finalized || !Number.isSafeInteger(finalized.number) || !/^0x[0-9a-f]{64}$/i.test(finalized.hash ?? '')) return { status: 'pending-finality-rpc-unavailable', terminal: false, ...info, hash: attempt.hash, confirmations,
      message: 'Use a BSC RPC that supports the finalized block tag. The nonce remains reserved; no new purchase is allowed.' };
    if (finalized.number < receipt.blockNumber) return { status: 'pending-finality', terminal: false, ...info, hash: attempt.hash, confirmations, finalizedBlock: finalized.number };
    const canonical = await provider.getBlock(receipt.blockNumber);
    if (!canonical || !same(canonical.hash ?? '', receipt.blockHash)) return { status: 'receipt-not-canonical', terminal: false, ...info };
    const gasCost = receipt.fee ?? (receipt.gasUsed * receipt.gasPrice);
    if (typeof gasCost !== 'bigint' || gasCost < 0n) throw new Error('Cannot account for confirmed gas fee.');
    journal.gasReceipts ??= {}; journal.gasSpentWei ??= '0';
    if (!Object.hasOwn(journal.gasReceipts, attempt.hash)) {
      journal.gasReceipts[attempt.hash] = gasCost.toString();
      journal.gasSpentWei = (BigInt(journal.gasSpentWei) + gasCost).toString();
    } else if (journal.gasReceipts[attempt.hash] !== gasCost.toString()) throw new Error('Receipt gas cost changed; stop for reconciliation.');
    pending.hash = attempt.hash; pending.phase = receipt.status === 1 ? (attempt.kind === 'cancel' ? 'cancelled' : 'confirmed')
      : pending.attempts?.some(item => item.kind === 'cancel') ? 'cancel-reverted' : 'reverted';
    pending.blockNumber = receipt.blockNumber; pending.blockHash = receipt.blockHash;
    pending.finality = 'bsc-finalized'; pending.finalizedBlockNumber = finalized.number; pending.finalizedBlockHash = finalized.hash;
    pending.gasCostWei = gasCost.toString(); pending.confirmedAt = new Date().toISOString(); writeJournal(options.journal, journal);
    return { status: pending.phase, terminal: receipt.status === 1 || pending.phase === 'cancel-reverted', hash: attempt.hash, blockNumber: receipt.blockNumber, confirmations,
      gasCostBnb: formatEther(gasCost), cumulativeGasBnb: formatEther(journal.gasSpentWei), finality: 'bsc-finalized', finalizedBlock: finalized.number, transactionKind: attempt.kind ?? 'purchase' };
  }
  if (observations.some(item => item.receipt)) return { status: 'receipt-not-canonical', terminal: false, ...info };
  const [latest, queued] = await Promise.all([provider.getTransactionCount(pending.from, 'latest'), provider.getTransactionCount(pending.from, 'pending')]);
  if (latest > pending.nonce || latest < pending.nonce || queued > pending.nonce + 1 || queued < latest) return {
    status: 'unknown-wallet-nonce-manual-review', terminal: true, ...info, latestNonce: latest, pendingNonce: queued };
  const indexed = observations.some(item => item.transaction);
  if (queued > pending.nonce && !indexed) return { status: 'unknown-pending-replacement-manual-review', terminal: true, ...info };
  return { status: indexed ? 'pending-receipt' : 'pending-not-indexed', terminal: false, ...info, recoveryAllowed: !!pending.attempts };
}

export async function recoverPending(provider, options, signer, journal, diagnostic, runtime) {
  const stopped = stoppedResult(runtime, 'recovery', journal.transaction?.hash);
  if (stopped) return stopped;
  if (!options.send || (!options.speedUp && !options.rebroadcast && !options.cancelPending) || !diagnostic.recoveryAllowed || diagnostic.terminal) return diagnostic;
  if (!signer || !same(await signer.getAddress(), journal.transaction.from)) throw new Error('Pending transaction belongs to another keeper wallet.');
  const pending = journal.transaction, previous = pending.attempts.at(-1);
  if (options.rebroadcast) {
    const budget = gasBudget(journal, BigInt(previous.gasLimit), BigInt(previous.gasPrice), options.maxGasWei);
    if (BigInt(previous.gasPrice) > options.maxGasPrice || !budget.allowed || await provider.getBalance(pending.from) < budget.reservedFee) return { status: 'recovery-gas-budget-exceeded', terminal: false, hash: previous.hash };
    return broadcastSigned(provider, options, journal, previous, true, runtime);
  }
  if (pending.speedUps >= Math.min(options.maxSpeedUps ?? 3, 5)) return { status: 'speed-up-limit-reached', terminal: false, hash: pending.hash };
  if (options.speedUp && pending.attempts.some(attempt => attempt.kind === 'cancel')) return { status: 'cancellation-already-signed-use-cancel-pending-or-rebroadcast', terminal: false, hash: pending.hash };
  if (options.cancelPending && await provider.getCode(pending.from) !== '0x') return { status: 'keeper-account-has-code-use-wallet-to-cancel', terminal: false, hash: pending.hash };
  const [fee, balance] = await Promise.all([provider.getFeeData(), provider.getBalance(pending.from)]);
  const minimum = (BigInt(previous.gasPrice) * 120n + 99n) / 100n;
  const gasPrice = fee.gasPrice && fee.gasPrice > minimum ? fee.gasPrice : minimum;
  // A fee bump preserves the purchase. Explicit cancellation alone substitutes
  // an empty self-transfer; no target can change while this nonce is unresolved.
  const kind = options.cancelPending ? 'cancel' : 'purchase';
  let gasLimit;
  try { gasLimit = (await provider.estimateGas({ from: pending.from, to: kind === 'cancel' ? pending.from : options.pool, data: kind === 'cancel' ? '0x' : pending.data, value: 0n }) * 120n + 99n) / 100n; }
  catch { return { status: kind === 'cancel' ? 'cancel-simulation-failed' : 'speed-up-purchase-no-longer-executable', terminal: false, hash: pending.hash }; }
  if (kind === (previous.kind ?? 'purchase') && gasLimit < BigInt(previous.gasLimit)) gasLimit = BigInt(previous.gasLimit);
  const budget = gasBudget(journal, gasLimit, gasPrice, options.maxGasWei);
  if (gasPrice > options.maxGasPrice || !budget.allowed || balance < budget.reservedFee) return { status: 'recovery-gas-budget-exceeded', terminal: false, hash: pending.hash };
  const beforeSigning = stoppedResult(runtime, 'signing', pending.hash);
  if (beforeSigning) return beforeSigning;
  const attempt = await signAttempt(signer, pending, options, gasLimit, gasPrice, kind);
  pending.attempts.push(attempt); pending.speedUps += 1; pending.hash = attempt.hash; pending.phase = 'signed';
  writeJournal(options.journal, journal);
  return broadcastSigned(provider, options, journal, attempt, true, runtime);
}

export async function runKeeperCycle(provider, options, signer = null, fetcher = fetch, runtime = createKeeperRuntime()) {
  const stopped = stoppedResult(runtime, 'cycle');
  if (stopped) return stopped;
  const binding = `56:${options.factory.toLowerCase()}:${options.pool.toLowerCase()}`;
  if (runtime.binding && runtime.binding !== binding) throw new Error('In-memory keeper state belongs to another pool.');
  runtime.binding = binding;
  const journal = readJournal(options.journal, options);
  if (options.send && journal.transaction && (!signer || !same(await signer.getAddress(), journal.transaction.from))) throw new Error('Journal belongs to a different keeper wallet; use its original signer.');
  const pendingResult = await reconcilePending(provider, options, journal);
  if (pendingResult) return recoverPending(provider, options, signer, journal, pendingResult, runtime); // Recovery can only act on this reserved nonce; never enter candidate selection.
  if (['cancelled', 'cancel-reverted'].includes(journal.transaction?.phase)) return { status: journal.transaction.phase === 'cancelled' ? 'purchase-nonce-cancelled' : 'cancellation-flow-reverted', terminal: true, hash: journal.transaction.hash, message: 'This cancellation flow has ended and this journal has stopped; no automatic next purchase.' };
  if (journal.transaction?.phase === 'confirmed') return { status: 'purchase-transaction-already-confirmed', terminal: true, hash: journal.transaction.hash };
  if (options.speedUp || options.rebroadcast || options.cancelPending) return { status: 'no-unresolved-purchase-to-recover', terminal: true };
  const firstRead = !runtime.constraints;
  let constraints = firstRead ? await readKeeperPool(provider, options) : await pollPoolState(provider, options, runtime.constraints);
  runtime.constraints = constraints;
  if (constraints.terminal) return { status: constraints.reason, terminal: true, state: constraints.state };
  // The immutable original target is known without the indexer. It is always
  // tried first, including cold starts and API outages, through live listingFor.
  runtime.queue = referenceFirst(runtime.queue, constraints, options.sort);
  const refreshDue = Date.now() - runtime.lastRefreshStarted >= (options.refreshInterval ?? 30) * 1000;
  // A ready Funded queue gets priority over any API refresh. While Funding, refresh
  // proceeds in parallel with short state polling and publishes bounded early batches.
  if ((!constraints.eligible || runtime.queue.length === 0) && refreshDue) startCandidateRefresh(provider, options, constraints, runtime, fetcher);
  const queueInfo = () => ({ preparedCandidates: runtime.queue.length, resolvedCandidates: runtime.queue.filter(candidate => candidate.listingId !== undefined).length,
    referenceSeeded: true, discovery: runtime.discovery,
    refreshInProgress: !!runtime.refreshTask, refreshError: runtime.refreshError });
  if (!constraints.eligible) return { status: 'funding-prewarming', terminal: false, state: constraints.state, ...queueInfo() };
  if (runtime.queue.length === 0) return { status: runtime.refreshTask ? 'preparing-candidate-queue' : 'no-official-candidate-in-scanned-pages', terminal: false, ...queueInfo() };
  // Exactly one fresh full pool/registry boundary snapshot per purchase attempt
  // cycle. Regular Funding polls only read chain, block and pool state.
  if (!firstRead) constraints = await readKeeperPool(provider, options);
  runtime.constraints = constraints;
  if (!constraints.eligible) return { status: constraints.reason, terminal: constraints.terminal, state: constraints.state };
  const skipped = [], preparedQueue = [...runtime.queue];
  const runner = signer ?? provider, pool = new Contract(options.pool, KEEPER_POOL_ABI, runner);
  for (const prepared of preparedQueue) {
    const beforeCandidate = stoppedResult(runtime, 'candidate');
    if (beforeCandidate) return beforeCandidate;
    let candidate;
    try { candidate = await verifyCandidate(provider, prepared, constraints); }
    catch { skipped.push({ tokenId: prepared.tokenId, reason: 'live-official-listing-read-failed' }); continue; }
    if (!candidate) {
      skipped.push({ tokenId: prepared.tokenId, reason: 'official-listing-sold-or-outside-constraints' });
      runtime.queue = runtime.queue.filter(item => item.key !== prepared.key); continue;
    }
    const overrides = !signer && options.from ? { from: options.from } : {};
    let gasLimit;
    try {
      // estimateGas executes the complete atomic purchase path once: this is the
      // authoritative fresh capacity/status/ownership/total-price/unit-weight/deadline simulation. API weights only order discovery hints.
      gasLimit = ((await pool.buyAlternativeFromMarket.estimateGas(candidate.listingId, overrides)) * 120n + 99n) / 100n;
    } catch { skipped.push({ listingId: candidate.listingId, reason: 'purchase-simulation-reverted-or-listing-changed' }); continue; }
    const details = { listingId: candidate.listingId, tokenId: candidate.tokenId, collection: candidate.collection,
      officialPriceWei: candidate.priceWei, officialPriceBnb: formatEther(candidate.priceWei), indexerBuyerCostWei: candidate.indexerBuyerCostWei,
      indexerVerifiedWeight: candidate.discoverySource === 'pool-reference' ? null : candidate.verifiedWeight,
      isReference: candidate.isReference === true, capacityValidation: 'atomic-purchase-eth_estimateGas', gasLimit,
      discoverySource: candidate.discoverySource, discoveryVenue: candidate.discoveryVenue, indexerSourceBlock: candidate.indexerSourceBlock,
      officialListingSource: candidate.officialListingSource, officialObservedBlock: candidate.officialObservedBlock,
      usedPreparedQueue: true, ...queueInfo(), skipped };
    if (!options.send) return { status: 'dry-run-ready', terminal: false, ...details, message: 'Simulation only. No signature, approval, purchase or fee transfer was sent.' };
    if (!signer) throw new Error('--send requires a locally supplied keeper signer.');
    const from = await signer.getAddress();
    const [fee, balance, nonce, latestNonce] = await Promise.all([provider.getFeeData(), provider.getBalance(from),
      provider.getTransactionCount(from, 'pending'), provider.getTransactionCount(from, 'latest')]);
    const gasPrice = fee.gasPrice;
    if (!gasPrice || gasPrice > options.maxGasPrice || (constraints.blockGasLimit && gasLimit > constraints.blockGasLimit)) return { status: 'gas-price-or-block-limit-exceeded', terminal: false, ...details };
    const budget = gasBudget(journal, gasLimit, gasPrice, options.maxGasWei);
    if (!budget.allowed) return { status: 'total-gas-budget-exceeded', terminal: false, spentGasWei: budget.spent,
      maximumNextGasWei: budget.maximumNextFee, totalBudgetWei: options.maxGasWei, ...details };
    if (balance < budget.reservedFee) return { status: 'keeper-gas-balance-insufficient', terminal: false, ...details };
    if (nonce !== latestNonce) return { status: 'keeper-account-has-pending-transactions', terminal: false, ...details };
    const data = new Interface(KEEPER_POOL_ABI).encodeFunctionData('buyAlternativeFromMarket', [candidate.listingId]);
    const pending = { phase: 'signed', from, nonce, to: options.pool, data, value: '0', listingId: candidate.listingId.toString(),
      createdAt: new Date().toISOString(), speedUps: 0 };
    const beforeSigning = stoppedResult(runtime, 'signing');
    if (beforeSigning) return beforeSigning;
    const attempt = await signAttempt(signer, pending, options, gasLimit, gasPrice);
    pending.attempts = [attempt]; pending.hash = attempt.hash;
    if (journal.transaction) journal.previousTransaction = journal.transaction;
    journal.transaction = pending;
    writeJournal(options.journal, journal); // Exact signed bytes and deterministic hash are durable before any RPC broadcast.
    return { ...await broadcastSigned(provider, options, journal, attempt, false, runtime), ...details };
  }
  if (refreshDue) startCandidateRefresh(provider, options, constraints, runtime, fetcher);
  return { status: 'no-executable-official-candidate-in-prepared-queue', terminal: false, ...queueInfo(), skipped,
    message: 'Only official listings are executable here; signed/batch Firsto quotes are not purchase routes.' };
}

function help() {
  console.log(`Purchase keeper — BSC flexible pools only\n\nDefault: read-only, state polls every 2 seconds, candidate prewarming every 30 seconds.\nFunded pools try the original target then the prepared queue immediately; --once performs one cycle.\nThe original target is seeded from the pool and never waits for Firsto API discovery.\n\nnode scripts/purchase-keeper.mjs --factory 0x... --pool 0x... --once\nnode scripts/purchase-keeper.mjs --factory 0x... --pool 0x... --journal /private/path/pool.json --send\n\n--send reads KEEPER_PRIVATE_KEY only from this process environment. Never put a key in command arguments.\nOptions: --rpc URL, --sort capacity|price, --pages 1..10 (default 3), --interval seconds (default 2),\n--refresh-interval seconds (default 30), --from ADDRESS (optional dry-run caller),\n--max-gas-bnb 0.01 (cumulative budget including failed transactions), --max-gas-price-gwei 1, --recover-hash 0x...\nDiscovery uses official NFTs from Firsto; CircuitMarket.listingFor resolves the executable official listing, regardless of Firsto bestAsk venue.\nTwo canonical confirmations plus BSC finalized inclusion are required before releasing a nonce. Unsupported finalized RPCs fail closed. Default pending handling never resends.\nRecovery: --send --once --rebroadcast (identical bytes), or --send --once --speed-up (same purchase + nonce, 20% fee bump; a node may require a higher replacement threshold).\n--send --once --cancel-pending replaces this nonce with a zero-value empty self-transfer for an EOA; confirmation stops this journal.\n--max-speed-ups 3 (hard ceiling 5), --pending-seconds 120 (diagnostic threshold, never an expiry).\nWallet locks coordinate this machine only: run one executor per wallet, including across machines.\nAll process locks persist in private 0700 state directories; send mode requires HTTPS RPC (loopback HTTP is for tests).\nWallet journal pointers persist under ~/.local/state/pinkuang/purchase-keeper/wallets (0700/0600).\nPreviously signed attempts remain executable: lowering a later budget cannot revoke their gas exposure.\nSigned raw transactions stay in the private journal; keep it and its wallet lock state until every pending nonce is resolved.\nThe factory address is a user trust input; reciprocal getters do not authenticate an arbitrary deployment.\nNo pool creation, funding, finalization, share trading or service-fee collection is performed.`);
}

export async function main(args = process.argv.slice(2)) {
  const options = parseArguments(args);
  if (options.help) { help(); return; }
  const releaseJournal = acquireKeeperLock(options.journal);
  let releasePool;
  try { releasePool = acquireKeeperLock(resolve(KEEPER_STATE_ROOT, 'pools', `56-${options.pool.toLowerCase()}`)); }
  catch (error) { releaseJournal(); throw error; }
  const release = () => { releasePool(); releaseJournal(); };
  const runtime = createKeeperRuntime();
  let stopping = false;
  const stop = () => { stopping = true; runtime.stopped = true; runtime.abortController.abort(); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  const rpcRequest = new FetchRequest(options.rpc);
  rpcRequest.timeout = 15_000;
  const provider = new JsonRpcProvider(rpcRequest);
  let releaseWallet;
  try {
    let signer = null;
    if (options.send) {
      // Do not inspect this environment variable at all in dry-run mode.
      const key = process.env.KEEPER_PRIVATE_KEY;
      if (!/^0x[0-9a-f]{64}$/i.test(key ?? '')) throw new Error('Set a valid KEEPER_PRIVATE_KEY in the local process environment before --send.');
      try { signer = new Wallet(key, provider); } catch { throw new Error('The supplied keeper key is invalid.'); }
      releaseWallet = acquireWalletLock(await signer.getAddress(), options.journal);
      if (!existsSync(options.journal)) writeJournal(options.journal, readJournal(options.journal, options));
    }
    do {
      try {
        const result = await runKeeperCycle(provider, options, signer, fetch, runtime);
        console.log(serial({ at: new Date().toISOString(), mode: options.send ? 'send' : 'dry-run', pool: options.pool, ...result }));
        if (result.terminal || options.once) break;
      } catch (error) {
        // Avoid provider error dumps and request bodies. No private material is printed.
        const message = String(error?.shortMessage || error?.message || 'Keeper cycle failed.').replace(/0x[0-9a-f]{130,}/ig, '[signed-data-redacted]');
        const redacted = options.send && process.env.KEEPER_PRIVATE_KEY ? message.split(process.env.KEEPER_PRIVATE_KEY).join('[redacted]') : message;
        console.error(serial({ at: new Date().toISOString(), status: 'cycle-error', message: redacted.slice(0, 400) }));
        if (options.once) { process.exitCode = 1; break; }
      }
      for (let elapsed = 0; !stopping && elapsed < options.interval; elapsed += 1) await new Promise(done => setTimeout(done, 1000));
    } while (!stopping);
  } finally {
    runtime.stopped = true; runtime.abortController.abort();
    if (runtime.refreshTask) await runtime.refreshTask;
    releaseWallet?.(); provider.destroy(); process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); release();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error?.message || 'Keeper could not start.'); process.exitCode = 1; });
}
