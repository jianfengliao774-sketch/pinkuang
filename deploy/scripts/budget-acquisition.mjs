/**
 * Read-only basket planner. Input candidates must be independently verified at one
 * canonical block; this output never authorizes a purchase or proves a global minimum.
 */
const UINT256_MAX = (1n << 256n) - 1n;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const OFFICIAL_COLLECTIONS = new Set([
  '0xb1024b89886b9a34aa4ff5f31c411d708b20a14c',
  '0x1f5cb4aeae1807bf60c3b9c0d8adbcc14e91f12c',
]);
const need = (condition, reason) => { if (!condition) throw new Error(reason); };
const exact = (value, field) => {
  need(typeof value === 'bigint' || typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value), `Invalid ${field}.`);
  const amount = BigInt(value);
  need(amount >= 0n && amount <= UINT256_MAX, `Invalid ${field}.`);
  return amount;
};
const identity = candidate => `${candidate.collection.toLowerCase()}:${exact(candidate.tokenId, 'tokenId')}`;
const order = (left, right) => left.costWei < right.costWei ? -1 : left.costWei > right.costWei ? 1
  : left.collection < right.collection ? -1 : left.collection > right.collection ? 1
    : left.tokenId < right.tokenId ? -1 : left.tokenId > right.tokenId ? 1 : 0;

/**
 * Official CircuitMarket listings are tried first, then executable Firsto signed asks.
 * Each source must declare complete coverage for the pinned block. Price and NFT
 * identity still require a fresh check in every on-chain purchase transaction.
 */
export function planBudgetAcquisition({ budgetWei, absoluteCapWei, unitCapWei, official = [], firsto = [], snapshot,
  firstoCoverage, maxMachines = 256, now = Date.now() } = {}) {
  const budget = exact(budgetWei, 'budgetWei');
  const absoluteCap = exact(absoluteCapWei, 'absoluteCapWei');
  const unitCap = exact(unitCapWei, 'unitCapWei');
  need(budget > 0n && budget % 100n === 0n, 'Budget must fund exactly 100 integer shares.');
  need(absoluteCap > 0n && unitCap > 0n, 'Miner price caps must be positive.');
  need(Number.isInteger(maxMachines) && maxMachines > 0 && maxMachines <= 256, 'Invalid machine page limit.');
  need(snapshot && snapshot.complete === true && Number.isSafeInteger(snapshot.blockNumber) && snapshot.blockNumber > 0
    && /^0x[0-9a-fA-F]{64}$/.test(snapshot.blockHash ?? '')
    && Number.isSafeInteger(snapshot.observedAt) && snapshot.observedAt <= now + 30_000
    && now - snapshot.observedAt <= 5 * 60_000, 'Market snapshot is incomplete or stale.');
  need(Array.isArray(official) && Array.isArray(firsto) && official.length + firsto.length <= 20_000,
    'Invalid candidate coverage.');
  // The official discovery snapshot says nothing about Firsto's paginated order book.
  // A single valid signed ask is not evidence that cheaper executable asks were scanned.
  if (firsto.length) need(firstoCoverage?.complete === true
    && firstoCoverage.blockNumber === snapshot.blockNumber
    && firstoCoverage.blockHash === snapshot.blockHash
    && Number.isSafeInteger(firstoCoverage.observedAt)
    && firstoCoverage.observedAt <= now + 30_000
    && now - firstoCoverage.observedAt <= 5 * 60_000,
  'Firsto candidate coverage is incomplete, stale or at a different block.');

  function prepare(rows, venue) {
    return rows.map(candidate => {
      need(candidate && typeof candidate === 'object' && ADDRESS.test(candidate.collection ?? '')
        && OFFICIAL_COLLECTIONS.has(candidate.collection.toLowerCase()), 'Invalid miner collection.');
      const tokenId = exact(candidate.tokenId, 'tokenId');
      const verifiedWeight = exact(candidate.verifiedWeight, 'verifiedWeight');
      const unverifiedWeight = exact(candidate.unverifiedWeight, 'unverifiedWeight');
      const costWei = exact(candidate.costWei, 'costWei');
      const machineCapWei = exact(candidate.machineCapWei, 'machineCapWei');
      const calculatedCap = unitCap * verifiedWeight < absoluteCap ? unitCap * verifiedWeight : absoluteCap;
      need(candidate.venue === venue && candidate.verified === true && candidate.mining === true
        && candidate.optimal === false && verifiedWeight > 0n && unverifiedWeight === 0n
        && machineCapWei === calculatedCap && costWei > 0n && costWei <= calculatedCap
        && candidate.snapshotBlock === snapshot.blockNumber && candidate.snapshotHash === snapshot.blockHash,
      'Unverified or over-cap market candidate.');
      need(candidate.seller && ADDRESS.test(candidate.seller)
        && candidate.seller.toLowerCase() !== `0x${'0'.repeat(40)}`, 'Invalid candidate seller.');
      need(venue === 'official' ? exact(candidate.askWei, 'askWei') === costWei
        : exact(candidate.askWei, 'askWei') <= costWei && candidate.signedAskVerified === true,
      'Invalid market execution cost.');
      return Object.freeze({ ...candidate, collection: candidate.collection.toLowerCase(), tokenId,
        verifiedWeight, costWei, machineCapWei, askWei: exact(candidate.askWei, 'askWei') });
    }).sort(order);
  }

  const selected = [], seen = new Set();
  let spentWei = 0n, officialSpentWei = 0n;
  for (const candidates of [prepare(official, 'official'), prepare(firsto, 'firsto')]) {
    for (const candidate of candidates) {
      const key = identity(candidate);
      if (seen.has(key)) continue;
      if (candidate.costWei > budget - spentWei) continue;
      seen.add(key);
      selected.push(candidate);
      spentWei += candidate.costWei;
      if (candidate.venue === 'official') officialSpentWei += candidate.costWei;
      if (selected.length === maxMachines) break;
    }
    if (selected.length === maxMachines) break;
  }
  const unusedWei = budget - spentWei;
  // The previously approved 1% official procurement service charge is paid only
  // from unspent funds; Firsto's buyer fee is already included in costWei.
  const treasuryFeeWei = officialSpentWei / 100n < unusedWei ? officialSpentWei / 100n : unusedWei;
  return Object.freeze({ snapshot: Object.freeze({ ...snapshot }), selected: Object.freeze(selected),
    budgetWei: budget, absoluteCapWei: absoluteCap, unitCapWei: unitCap, spentWei, officialSpentWei, treasuryFeeWei,
    refundableWei: unusedWei - treasuryFeeWei, remainingWei: unusedWei,
    truncated: selected.length === maxMachines });
}
