import { Contract, ZeroAddress, getAddress } from 'ethers';
import { fetchOfficialSnapshot, OFFICIAL_MARKET, MAX_NEW_LISTINGS } from './official-market-discovery.mjs';

const COLLECTIONS = new Set([
  '0xb1024b89886b9a34aa4ff5f31c411d708b20a14c',
  '0x1f5cb4aeae1807bf60c3b9c0d8adbcc14e91f12c',
]);
const MARKET_ABI = [
  'function nextListingId() view returns(uint256)',
  'function listingView(uint256) view returns(address seller,address circuits,uint256 tokenId,uint96 price,uint16 feeBps,bool valid)',
  'function listingFor(address,uint256) view returns(uint256 id,address seller,uint96 price,bool valid)',
];
const NFT_ABI = ['function ownerOf(uint256) view returns(address)'];
const MINING = '0x7E2E0DC66a3bD9103E69b766afA62d9f7b697b46';
const MINING_ABI = [
  'function minerKey(address,uint256) view returns(bytes32)',
  'function getMiner(bytes32) view returns(tuple(address circuits,uint64 circuitId,uint32 taskId,uint32 gateCount,uint32 stateCount,uint32 depth,uint64 area,uint32 mult,uint64 since,uint8 status,address registrant,uint32 nandBurn,uint32 latchBurn,uint64 bstar,uint64 bonus,bool optimal,uint64 commitBlock,uint64 firstUnusedId,uint64 stopBlock,uint128 verifWeight,uint128 unverWeight,uint256 debt))',
];
const need = (condition, message) => { if (!condition) throw new Error(message); };
const uint = (value, label) => {
  need(typeof value === 'bigint' && value >= 0n || typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    || typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value), `Invalid ${label}.`);
  return BigInt(value);
};
const same = (a, b) => getAddress(a) === getAddress(b);
const keyOf = row => `${row.collection.toLowerCase()}:${row.tokenId}`;
const active = signal => need(!signal?.aborted, 'Budget market scan aborted.');
const order = (a, b) => BigInt(a.costWei) < BigInt(b.costWei) ? -1 : BigInt(a.costWei) > BigInt(b.costWei) ? 1
  : a.collection < b.collection ? -1 : a.collection > b.collection ? 1
    : BigInt(a.tokenId) < BigInt(b.tokenId) ? -1 : BigInt(a.tokenId) > BigInt(b.tokenId) ? 1 : 0;

function listing(row, maxId) {
  need(row && typeof row === 'object' && typeof row.valid === 'boolean', 'Invalid official listing.');
  if (!row.valid) return null;
  const id = uint(row.id, 'listing ID');
  need(id > 0n && id <= maxId, 'Official listing exceeds pinned head.');
  const collection = getAddress(row.circuits);
  if (!COLLECTIONS.has(collection.toLowerCase())) return null;
  const tokenId = uint(row.circuitId ?? row.tokenId, 'miner ID');
  const seller = getAddress(row.seller);
  const costWei = uint(row.price, 'official price');
  if (seller === ZeroAddress || costWei === 0n) return null;
  return { id, collection, tokenId, seller, costWei };
}

function defaultRead(provider, blockNumber) {
  const market = new Contract(OFFICIAL_MARKET, MARKET_ABI, provider);
  const mining = new Contract(MINING, MINING_ABI, provider);
  const opts = { blockTag: blockNumber };
  return {
    chainId: async () => (await provider.getNetwork()).chainId,
    nextListingId: () => market.nextListingId(opts),
    listingView: async id => {
      const row = await market.listingView(id, opts);
      return { id, seller: row.seller, circuits: row.circuits, circuitId: row.tokenId,
        price: row.price, valid: row.valid };
    },
    listingFor: (collection, tokenId) => market.listingFor(collection, tokenId, opts),
    ownerOf: (collection, tokenId) => new Contract(collection, NFT_ABI, provider).ownerOf(tokenId, opts),
    miner: async (collection, tokenId) => {
      const key = await mining.minerKey(collection, tokenId, opts);
      return mining.getMiner(key, opts);
    },
    blockHash: async () => (await provider.getBlock(blockNumber))?.hash,
  };
}

/** Complete, pinned official-market candidate discovery for a reviewed basket budget. */
export async function discoverOfficialBudgetCandidates({ provider, read, fetcher = fetch, now = Date.now(),
  blockNumber, signal, absoluteCapWei, unitCapWei, maxActive = 2_000,
  maxNewListings = MAX_NEW_LISTINGS } = {}) {
  need(provider || read, 'A read-only BSC source is required.');
  const absolute = uint(absoluteCapWei, 'absolute miner cap');
  const perWeight = uint(unitCapWei, 'verified-weight unit cap');
  need(absolute > 0n && perWeight > 0n, 'Miner price caps must be positive.');
  active(signal);
  const source = await fetchOfficialSnapshot({ fetcher, now, signal });
  active(signal);
  const head = blockNumber ?? await provider.getBlockNumber();
  need(Number.isSafeInteger(head) && head > 0 && source.blockNumber <= head && head - source.blockNumber <= 1_200,
    'Official snapshot is outside the chain read window.');
  const chain = read ?? defaultRead(provider, head);
  const [chainId, headIdRaw, hash] = await Promise.all([chain.chainId(), chain.nextListingId(), chain.blockHash()]);
  active(signal);
  need(uint(chainId, 'chain ID') === 56n, 'Budget market scan requires BSC mainnet.');
  need(/^0x[0-9a-fA-F]{64}$/.test(hash ?? ''), 'Missing pinned BSC block hash.');
  const headId = uint(headIdRaw, 'latest listing ID');
  need(headId >= BigInt(source.maxId) && headId - BigInt(source.maxId) <= BigInt(maxNewListings),
    'Official snapshot omitted too many recent listings.');
  const prior = source.listings.map(row => listing(row, BigInt(source.maxId))).filter(Boolean);
  need(prior.length <= maxActive, 'Official market has too many active listings for complete review.');

  const current = [];
  for (let offset = 0; offset < prior.length; offset += 8) {
    active(signal);
    const batch = await Promise.all(prior.slice(offset, offset + 8).map(async earlier => {
      const latest = listing(await chain.listingView(earlier.id), headId);
      if (latest && keyOf(latest) !== keyOf(earlier)) throw new Error('Official listing changed miner identity.');
      return latest;
    }));
    active(signal);
    current.push(...batch.filter(Boolean));
  }
  for (let id = BigInt(source.maxId) + 1n; id <= headId; id += 8n) {
    active(signal);
    const count = Number(headId - id + 1n < 8n ? headId - id + 1n : 8n);
    const batch = await Promise.all(Array.from({ length: count }, (_, index) => chain.listingView(id + BigInt(index))));
    active(signal);
    current.push(...batch.map(row => listing(row, headId)).filter(Boolean));
  }

  const latestByMiner = new Map();
  for (const row of current) {
    const key = keyOf(row);
    if (!latestByMiner.has(key) || latestByMiner.get(key).id < row.id) latestByMiner.set(key, row);
  }
  const distinct = [...latestByMiner.values()];
  const qualified = [];
  for (let offset = 0; offset < distinct.length; offset += 8) {
    active(signal);
    const batch = await Promise.all(distinct.slice(offset, offset + 8).map(async row => {
      const [canonical, owner, miner] = await Promise.all([
        chain.listingFor(row.collection, row.tokenId),
        chain.ownerOf(row.collection, row.tokenId),
        chain.miner(row.collection, row.tokenId),
      ]);
      if (!canonical.valid || uint(canonical.id, 'canonical listing ID') !== row.id
        || !same(canonical.seller, row.seller) || uint(canonical.price, 'canonical price') !== row.costWei
        || !same(owner, row.seller) || !same(miner.circuits, row.collection)
        || uint(miner.circuitId, 'miner ID') !== row.tokenId
        || uint(miner.status, 'mining status') !== 1n || miner.optimal !== false
        || uint(miner.unverWeight, 'unverified weight') !== 0n) return null;
      const weight = uint(miner.verifWeight, 'verified weight');
      if (weight === 0n) return null;
      const machineCapWei = perWeight * weight < absolute ? perWeight * weight : absolute;
      if (row.costWei > machineCapWei) return null;
      return Object.freeze({ venue: 'official', verified: true, mining: true, optimal: false,
        collection: row.collection, tokenId: row.tokenId.toString(), seller: row.seller,
        listingId: row.id.toString(), askWei: row.costWei.toString(), costWei: row.costWei.toString(),
        machineCapWei: machineCapWei.toString(), verifiedWeight: weight.toString(), unverifiedWeight: '0',
        taskId: uint(miner.taskId, 'task ID').toString(), snapshotBlock: head, snapshotHash: hash });
    }));
    active(signal);
    qualified.push(...batch.filter(Boolean));
  }
  qualified.sort(order);
  const [finalChainId, finalHash] = await Promise.all([chain.chainId(), chain.blockHash()]);
  active(signal);
  need(uint(finalChainId, 'final chain ID') === 56n && finalHash === hash,
    'BSC block changed during budget market scan.');
  return Object.freeze({ candidates: Object.freeze(qualified), snapshot: Object.freeze({
    complete: true, blockNumber: head, blockHash: hash, observedAt: now,
    officialSourceBlock: source.blockNumber, officialGeneratedAt: source.generatedAt,
    scannedListings: prior.length + Number(headId - BigInt(source.maxId)),
  }) });
}
