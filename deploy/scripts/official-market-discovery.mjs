import { Contract, Interface, ZeroAddress, getAddress } from 'ethers';
import { createBudgetMulticallReader, MAX_READ_BATCH, MAX_READ_CONCURRENCY } from './budget-multicall-read.mjs';

export const OFFICIAL_SNAPSHOT_URL = 'https://tapeout.net/circuit-market.json';
export const OFFICIAL_MARKET = '0x6feEbbEbC07BcB90bd1Ac8b0CF9BaA4f0fF2B46f';
export const OFFICIAL_MINING = '0x7E2E0DC66a3bD9103E69b766afA62d9f7b697b46';
export const MAX_OFFICIAL_SNAPSHOT_BYTES = 8 * 1024 * 1024;
export const MAX_OFFICIAL_SNAPSHOT_AGE_MS = 6 * 60_000;
export const MAX_NEW_LISTINGS = 128;
export const MAX_ACTIVE_TARGET_LISTINGS = 10_000;
export const MAX_HISTORICAL_LISTINGS = 100_000;

const MARKET_ABI = [
  'function nextListingId() view returns(uint256)',
  'function listingView(uint256) view returns(address seller,address circuits,uint256 tokenId,uint96 price,uint16 feeBps,bool valid)',
];
const MINING_ABI = [
  'function minerKey(address,uint256) view returns(bytes32)',
  'function getMiner(bytes32) view returns(tuple(address circuits,uint64 circuitId,uint32 taskId,uint32 gateCount,uint32 stateCount,uint32 depth,uint64 area,uint32 mult,uint64 since,uint8 status,address registrant,uint32 nandBurn,uint32 latchBurn,uint64 bstar,uint64 bonus,bool optimal,uint64 commitBlock,uint64 firstUnusedId,uint64 stopBlock,uint128 verifWeight,uint128 unverWeight,uint256 debt))',
];
const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
const need = (condition, reason) => { if (!condition) throw new Error(reason); };
const live = signal => need(!signal?.aborted, 'Official market scan was aborted.');
const natural = (value, name) => {
  need((typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value)) || (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) || (typeof value === 'bigint' && value >= 0n), `Invalid ${name}.`);
  return BigInt(value);
};
const boundedNumber = (value, name) => {
  const number = natural(value, name);
  need(number <= BigInt(Number.MAX_SAFE_INTEGER), `Invalid ${name}.`);
  return Number(number);
};
const address = (value, name) => {
  need(typeof value === 'string', `Invalid ${name}.`);
  try { return getAddress(value); } catch { throw new Error(`Invalid ${name}.`); }
};

/** The official site's JSON is a discovery hint; no price, miner state or ownership is trusted for payment. */
export function parseOfficialSnapshot(raw, { now = Date.now(), maxAgeMs = MAX_OFFICIAL_SNAPSHOT_AGE_MS } = {}) {
  need(raw && typeof raw === 'object' && !Array.isArray(raw), 'Invalid official market snapshot.');
  need(same(address(raw.marketAddr, 'official market address'), OFFICIAL_MARKET), 'Official market address mismatch.');
  const generatedAt = Date.parse(raw.generatedAt);
  need(Number.isFinite(generatedAt) && generatedAt <= now + 30_000 && now - generatedAt <= maxAgeMs,
    'Official market snapshot is stale or has an invalid timestamp.');
  const blockNumber = boundedNumber(raw.block, 'official source block');
  const maxId = boundedNumber(raw.maxId, 'official max listing ID');
  need(blockNumber > 0 && Array.isArray(raw.listings) && raw.listings.length <= 100_000,
    'Official market snapshot has invalid listings.');
  return { generatedAt, blockNumber, maxId, listings: raw.listings };
}

/** Bound header wait and streamed body together. The current official snapshot is about 3 MiB. */
export async function fetchOfficialSnapshot({ fetcher = fetch, signal, now = Date.now(),
  sourceUrl = OFFICIAL_SNAPSHOT_URL, maxBytes = MAX_OFFICIAL_SNAPSHOT_BYTES,
  maxAgeMs = MAX_OFFICIAL_SNAPSHOT_AGE_MS, timeoutMs = 15_000 } = {}) {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  const forward = () => abort.abort();
  signal?.addEventListener('abort', forward, { once: true });
  if (signal?.aborted) abort.abort();
  try {
    const response = await fetcher(sourceUrl, { method: 'GET', cache: 'no-store', credentials: 'omit',
      redirect: 'error', headers: { Accept: 'application/json' }, signal: abort.signal });
    need(!response.redirected && response.ok, `Official market snapshot unavailable (HTTP ${response.status}).`);
    need((response.headers.get('content-type') ?? '').split(';', 1)[0].trim().toLowerCase() === 'application/json',
      'Official market snapshot is not JSON.');
    const declared = response.headers.get('content-length');
    if (declared && /^\d+$/.test(declared)) need(BigInt(declared) <= BigInt(maxBytes), 'Official market snapshot exceeds byte limit.');
    need(response.body, 'Official market snapshot has no readable body.');
    const reader = response.body.getReader();
    const chunks = []; let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        need(size <= maxBytes, 'Official market snapshot exceeds byte limit.');
        chunks.push(value);
      }
    } finally {
      if (size > maxBytes) reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    need(!abort.signal.aborted, 'Official market snapshot timed out or was aborted.');
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    let raw;
    try { raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
    catch { throw new Error('Official market snapshot contains invalid JSON.'); }
    return parseOfficialSnapshot(raw, { now, maxAgeMs });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', forward);
  }
}

function parseListing(row, constraints, maxId, allowOverCap = false) {
  need(row && typeof row === 'object' && !Array.isArray(row), 'Invalid official listing row.');
  const listingId = natural(row.id, 'official listing ID');
  need(listingId > 0n && listingId <= BigInt(maxId), 'Official listing ID exceeds snapshot head.');
  need(typeof row.valid === 'boolean', 'Official listing validity is missing.');
  if (!row.valid) return null;
  const collection = address(row.circuits, 'official listing collection');
  if (!same(collection, constraints.circuits)) return null;
  const seller = address(row.seller, 'official listing seller');
  const tokenId = natural(row.circuitId ?? row.tokenId, 'official miner token ID');
  const priceWei = natural(row.price, 'official listing price');
  if (seller === ZeroAddress || priceWei === 0n || (!allowOverCap && priceWei > constraints.priceCap)) return null;
  const key = `${collection.toLowerCase()}:${tokenId}`;
  return { key, collection, tokenId, listingId, seller, priceWei };
}

async function defaultRead(provider, blockNumber, signal) {
  const reader = await createBudgetMulticallReader({ provider, blockNumber, signal });
  const market = new Interface(MARKET_ABI);
  const mining = new Interface(MINING_ABI);
  return {
    chainId: async () => BigInt(await provider.send('eth_chainId', [])),
    blockHash: async () => (await provider.getBlock(blockNumber))?.hash,
    nextListingId: async () => (await reader.call(OFFICIAL_MARKET, market, 'nextListingId'))[0],
    listingView: async id => {
      const row = await reader.call(OFFICIAL_MARKET, market, 'listingView', [id]);
      return { id, seller: row.seller, circuits: row.circuits, circuitId: row.tokenId,
        price: row.price, valid: row.valid };
    },
    miner: async (collection, tokenId) => {
      const key = (await reader.call(OFFICIAL_MINING, mining, 'minerKey', [collection, tokenId]))[0];
      live(signal);
      return (await reader.call(OFFICIAL_MINING, mining, 'getMiner', [key]))[0];
    },
  };
}

function isEligibleMiner(miner, candidate, constraints) {
  if (!miner || !same(miner.circuits, candidate.collection) || natural(miner.circuitId, 'miner ID') !== candidate.tokenId
    || natural(miner.taskId, 'miner task') !== constraints.taskId || natural(miner.status, 'miner status') !== 1n
    || miner.optimal !== false || natural(miner.unverWeight, 'unverified weight') !== 0n) return false;
  const verifiedWeight = natural(miner.verifWeight, 'verified weight');
  if (verifiedWeight < constraints.minVerifiedWeight) return false;
  const limit = verifiedWeight >= constraints.referenceVerifiedWeight ? constraints.referencePriceWei
    : constraints.referencePriceWei * verifiedWeight / constraints.referenceVerifiedWeight;
  return candidate.priceWei <= limit ? verifiedWeight : false;
}

const compare = (a, b, sort) => {
  const difference = sort === 'price' ? a.priceWei - b.priceWei
    : a.priceWei * b.verifiedWeight - b.priceWei * a.verifiedWeight;
  if (difference !== 0n) return difference < 0n ? -1 : 1;
  return a.listingId < b.listingId ? -1 : a.listingId > b.listingId ? 1 : 0;
};

/** All official candidates are checked before Firsto fallback. Every buy still needs fresh listingFor + Vault simulation. */
export async function discoverOfficialMarketCandidates({ provider, constraints, fetcher = fetch, signal,
  now = Date.now(), blockNumber, read, sort = 'capacity', maxNewListings = MAX_NEW_LISTINGS,
  maxHistoricalListings = MAX_HISTORICAL_LISTINGS,
  ...snapshotOptions }) {
  need(provider || read, 'A read-only BSC provider is required.');
  live(signal);
  const source = await fetchOfficialSnapshot({ fetcher, signal, now, ...snapshotOptions });
  live(signal);
  const head = blockNumber ?? await provider.getBlockNumber();
  live(signal);
  need(Number.isSafeInteger(head) && head > 0 && source.blockNumber <= head && head - source.blockNumber <= 1_200,
    'Official market source block is missing, ahead or too far behind.');
  const model = {
    circuits: address(constraints.circuits, 'pool collection'),
    taskId: natural(constraints.taskId, 'pool task ID'),
    minVerifiedWeight: natural(constraints.minVerifiedWeight, 'minimum verified weight'),
    referenceVerifiedWeight: natural(constraints.referenceVerifiedWeight, 'reference verified weight'),
    referencePriceWei: natural(constraints.referencePriceWei, 'reference price'),
    priceCap: natural(constraints.priceCap, 'purchase price cap'),
  };
  need(model.minVerifiedWeight > 0n && model.referenceVerifiedWeight > 0n && model.referencePriceWei > 0n && model.priceCap > 0n,
    'Invalid pool purchase constraints.');
  const chain = read ?? await defaultRead(provider, head, signal);
  live(signal);
  const [nextIdRaw, chainId, hash] = await Promise.all([
    chain.nextListingId(), chain.chainId?.(), chain.blockHash?.(),
  ]);
  const nextId = natural(nextIdRaw, 'chain next listing ID');
  if (chain.chainId) need(natural(chainId, 'chain ID') === 56n, 'Official market scan requires BSC mainnet.');
  if (chain.blockHash) need(/^0x[0-9a-fA-F]{64}$/.test(hash ?? ''), 'Missing pinned BSC block hash.');
  live(signal);
  // Despite its name, CircuitMarket.nextListingId() is the latest assigned ID.
  // The official UI starts its descending scan at nextListingId() + 1.
  need(nextId >= BigInt(source.maxId), 'Official snapshot is ahead of the chain listing head.');
  const unseen = nextId - BigInt(source.maxId);
  need(unseen <= BigInt(maxNewListings), 'Official snapshot omitted too many recent listings.');
  need(nextId <= natural(maxHistoricalListings, 'historical listing limit'), 'Official market history exceeds the bounded complete-scan limit.');
  // The JSON snapshot is a freshness hint, never proof that every old live listing
  // is present. Enumerate all IDs, including old orders omitted by the snapshot.
  const width = read ? 8 : MAX_READ_BATCH * MAX_READ_CONCURRENCY;
  const rows = [];
  let activeTargetCount = 0;
  for (let id = 1n; id <= nextId; id += BigInt(width)) {
    live(signal);
    const ids = Array.from({ length: Number(nextId - id + 1n < BigInt(width) ? nextId - id + 1n : BigInt(width)) }, (_, index) => id + BigInt(index));
    const batch = await Promise.all(ids.map(value => chain.listingView(value)));
    live(signal);
    const target = batch.map(row => parseListing(row, model, nextId, true)).filter(Boolean);
    activeTargetCount += target.length;
    need(activeTargetCount <= MAX_ACTIVE_TARGET_LISTINGS, 'Official market has too many active target listings for complete review.');
    rows.push(...target);
  }
  const byMiner = new Map();
  for (const candidate of rows) {
    if (!byMiner.has(candidate.key) || candidate.listingId > byMiner.get(candidate.key).listingId)
      byMiner.set(candidate.key, candidate);
  }
  const candidates = [...byMiner.values()].filter(candidate => candidate.priceWei <= model.priceCap);
  const qualified = [];
  const proofWidth = read ? 8 : MAX_READ_BATCH * MAX_READ_CONCURRENCY;
  for (let offset = 0; offset < candidates.length; offset += proofWidth) {
    live(signal);
    const batch = await Promise.all(candidates.slice(offset, offset + proofWidth).map(async candidate => {
      const miner = await chain.miner(candidate.collection, candidate.tokenId);
      const verifiedWeight = isEligibleMiner(miner, candidate, model);
      if (verifiedWeight === false) return null;
      return { ...candidate, verifiedWeight, taskId: model.taskId, estimated24hAtomic: 0n,
        indexerBuyerCostWei: null, discoverySource: 'TapeOut official snapshot', discoveryVenue: 'official',
        officialListingSource: 'CircuitMarket listing snapshot', officialObservedBlock: head };
    }));
    live(signal);
    qualified.push(...batch.filter(Boolean));
  }
  live(signal);
  const [finalChainId, finalHash] = await Promise.all([chain.chainId?.(), chain.blockHash?.()]);
  live(signal);
  if (chain.chainId) need(natural(finalChainId, 'final chain ID') === 56n, 'Official market chain changed during scan.');
  if (chain.blockHash) need(finalHash === hash, 'BSC block changed during official market scan.');
  qualified.sort((a, b) => compare(a, b, sort));
  return { candidates: qualified, source: OFFICIAL_SNAPSHOT_URL, sourceBlock: source.blockNumber,
    generatedAt: new Date(source.generatedAt).toISOString(), chainBlock: head,
    snapshotListings: source.listings.length, liveListingsChecked: activeTargetCount,
    recentListingsScanned: Number(unseen),
    coverage: 'all-chain-listing-ids', chainListingsScanned: Number(nextId), chainHash: hash ?? null,
    modelChecked: candidates.length, nextListingId: nextId };
}

/** Read the public market's enumeration boundary at one block; no wallet or transaction involved. */
export async function verifyOfficialSnapshotBoundary(provider, maxId, blockNumber) {
  const head = blockNumber ?? await provider.getBlockNumber();
  need(Number.isSafeInteger(head) && head > 0, 'Invalid BSC block number.');
  const nextListingId = natural(await new Contract(OFFICIAL_MARKET, MARKET_ABI, provider)
    .nextListingId({ blockTag: head }), 'chain next listing ID');
  const listed = natural(maxId, 'official max listing ID');
  need(nextListingId >= listed, 'Official snapshot is ahead of the chain listing head.');
  return { nextListingId, unseenListings: nextListingId - listed,
    complete: nextListingId === listed, blockNumber: head };
}

/** Keeper-compatible entry point. A failed/incomplete official read must not be treated as an empty market. */
export async function fetchOfficialCandidates(provider, options, constraints, fetcher = fetch) {
  const result = await discoverOfficialMarketCandidates({ provider, constraints, fetcher, ...options });
  return { ...result, scannedRows: result.chainListingsScanned,
    maxId: result.nextListingId, complete: true };
}
