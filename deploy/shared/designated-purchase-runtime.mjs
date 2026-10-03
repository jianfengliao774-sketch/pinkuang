/** Exact, chain-derived checks for the staged designated-purchase keeper route. */
export const DESIGNATED_OFFICIAL_MARKET = '0x6feEbbEbC07BcB90bd1Ac8b0CF9BaA4f0fF2B46f';
export const DESIGNATED_OFFICIAL_LISTING_ABI = [
  'function listingFor(address circuits,uint256 tokenId) view returns(uint256 id,address seller,uint96 price,bool valid)',
  'function listingView(uint256) view returns(address seller,address circuits,uint256 tokenId,uint96 price,uint16 feeBps,bool valid)',
];
export const DESIGNATED_MINING_ABI = [
  'function minerKey(address,uint256) view returns(bytes32)',
  'function getMiner(bytes32) view returns(tuple(address circuits,uint64 circuitId,uint32 taskId,uint32 gateCount,uint32 stateCount,uint32 depth,uint64 area,uint32 mult,uint64 since,uint8 status,address registrant,uint32 nandBurn,uint32 latchBurn,uint64 bstar,uint64 bonus,bool optimal,uint64 commitBlock,uint64 firstUnusedId,uint64 stopBlock,uint128 verifWeight,uint128 unverWeight,uint256 debt))',
  'function currentRate() view returns(uint256)',
  'function totalVerifWeight() view returns(uint256)',
  'function UNVERIFIED_BPS() view returns(uint256)',
];
export const DESIGNATED_NFT_ABI = ['function ownerOf(uint256) view returns(address)',
  'function getApproved(uint256) view returns(address)',
  'function isApprovedForAll(address,address) view returns(bool)'];
export const SECONDS_PER_DAY = 86_400n;
const MAX_UINT128 = (1n << 128n) - 1n;
const MAX_UINT256 = (1n << 256n) - 1n;

const asInteger = (value, name, positive = false, maximum = MAX_UINT256) => {
  if (typeof value !== 'bigint' && (typeof value !== 'string' || !/^(0|[1-9]\d*)$/.test(value))) {
    throw new Error(`Invalid exact ${name}.`);
  }
  const result = BigInt(value);
  if (result < (positive ? 1n : 0n) || result > maximum) throw new Error(`Invalid ${name}.`);
  return result;
};
const asPositive = (value, name, maximum = MAX_UINT256) => asInteger(value, name, true, maximum);

/** Mirrors Mining's two integer floors, then projects one second over a day. */
export function designatedDailyOutputAtomic(rate, unverifiedBps, totalVerifiedWeight, verifiedWeight) {
  rate = asPositive(rate, 'current mining rate');
  totalVerifiedWeight = asPositive(totalVerifiedWeight, 'total verified weight');
  verifiedWeight = asPositive(verifiedWeight, 'miner verified weight', MAX_UINT128);
  unverifiedBps = asInteger(unverifiedBps, 'unverified share');
  if (unverifiedBps > 10_000n) throw new Error('Invalid unverified share.');
  if (verifiedWeight > totalVerifiedWeight) throw new Error('Miner verified weight exceeds total verified weight.');
  const unverifiedPerSecond = rate * unverifiedBps / 10_000n;
  const verifiedPerSecond = rate - unverifiedPerSecond;
  const perSecond = verifiedPerSecond * verifiedWeight / totalVerifiedWeight;
  if (perSecond === 0n || perSecond > MAX_UINT256 / SECONDS_PER_DAY) {
    throw new Error('Invalid daily mining output.');
  }
  return perSecond * SECONDS_PER_DAY;
}

export function estimateDesignatedDailyOutput({ currentRate, unverifiedBps,
  totalVerifiedWeight, verifiedWeight } = {}) {
  return designatedDailyOutputAtomic(currentRate, unverifiedBps, totalVerifiedWeight, verifiedWeight);
}

export function designatedFundingAmounts(referenceCostWei) {
  const cost = asPositive(referenceCostWei, 'original gross cost');
  const priceCapWei = (11n * cost + 9n) / 10n;
  const targetRaiseWei = (priceCapWei + 99n) / 100n * 100n;
  if (priceCapWei > MAX_UINT256 || targetRaiseWei > MAX_UINT256) {
    throw new Error('Invalid designated funding amount.');
  }
  return { priceCapWei, targetRaiseWei };
}

/** Seller asks are compared in both ±10% bands; Firsto fees affect only gross spending. */
export function designatedPurchaseBounds({ originalAskWei, originalCostWei, originalDailyOutputAtomic,
  candidateAskWei, candidateCostWei, candidateDailyOutputAtomic, priceCapWei, totalRaisedWei, freeBalanceWei }) {
  const p0 = asPositive(originalAskWei, 'original ask', MAX_UINT128);
  const c0 = asPositive(originalCostWei, 'original gross cost');
  const y0 = asPositive(originalDailyOutputAtomic, 'original daily output');
  const p1 = asPositive(candidateAskWei, 'candidate ask', MAX_UINT128);
  const c1 = asPositive(candidateCostWei, 'candidate gross cost');
  const y1 = asPositive(candidateDailyOutputAtomic, 'candidate daily output');
  const cap = asPositive(priceCapWei, 'pool price cap');
  const raised = asPositive(totalRaisedWei, 'pool funds');
  freeBalanceWei = asInteger(freeBalanceWei, 'free pool balance');
  const { priceCapWei: configuredCap } = designatedFundingAmounts(c0);
  if (c0 < p0 || c0 > 2n * p0 || c1 < p1 || c1 > 2n * p1 || cap !== configuredCap) {
    throw new Error('Invalid designated ask, gross cost or configured cap.');
  }
  const reasons = [];
  if (10n * p1 < 9n * p0) reasons.push('ask-below-90-percent');
  if (10n * p1 > 11n * p0) reasons.push('ask-above-110-percent');
  if (10n * p1 * y0 < 9n * p0 * y1) reasons.push('daily-unit-below-90-percent');
  if (10n * p1 * y0 > 11n * p0 * y1) reasons.push('daily-unit-above-110-percent');
  const grossUpperWei = (11n * c0 + 9n) / 10n;
  if (c1 > grossUpperWei) reasons.push('gross-above-110-percent');
  if (c1 > cap) reasons.push('over-pool-price-cap');
  if (c1 > raised) reasons.push('over-raised-funds');
  if (c1 > freeBalanceWei) reasons.push('over-free-pool-balance');
  return { allowed: reasons.length === 0, reasons, grossUpperWei };
}
