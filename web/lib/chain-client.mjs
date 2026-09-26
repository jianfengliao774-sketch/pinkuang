import { Interface, ZeroAddress, getAddress, toQuantity } from 'ethers';
import contracts from './contracts.generated.json' with { type: 'json' };

export const CHAIN_ID = 56n;
export const ARTIFACT_DIGEST = contracts.artifactDigest;
export const abi = Object.freeze(Object.fromEntries(Object.entries(contracts.abis).map(([name, value]) => [name, new Interface(value)])));
const MAX_UINT256 = (1n << 256n) - 1n;
const rowBits = Object.freeze({ params: 1, state: 2, unitPriceWei: 3, totalRaised: 4, totalSupply: 5,
  memberCount: 6, depositPaused: 7, purchaseCost: 8, activatedAt: 9, shareTradingAllowed: 10,
  shares: 11, lockedShares: 12, availableShares: 13, claimableBEM: 14, bnbOwed: 15, initialContributedWei: 16 });

function requireCondition(condition, message) { if (!condition) throw new Error(message); }
export function uint(value, bits = 256) {
  requireCondition(typeof value === 'bigint' || (typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value)), 'Use an exact bigint or unsigned decimal string.');
  const n = BigInt(value);
  requireCondition(n >= 0n && n < (1n << BigInt(bits)), `Value outside uint${bits}.`);
  return n;
}
const address = value => { const a = getAddress(value); requireCondition(a !== ZeroAddress, 'Zero address.'); return a; };
const hasBit = (value, bit) => (BigInt(value) & (1n << BigInt(bit))) !== 0n;
const goodField = (status, bit) => hasBit(status.validMask, bit) && !hasBit(status.errorMask, bit);
export const poolKey = (factory, pool) => `56:${address(factory).toLowerCase()}:${address(pool).toLowerCase()}`;
export const assetKey = (collection, tokenId) => `56:${address(collection).toLowerCase()}:${uint(tokenId)}`;

/** Exact mirror of FlexiblePurchase.configure; reserve is funding, never buying permission. */
export function referenceQuote(referencePriceWei, extraBps = 1000n) {
  const price = uint(referencePriceWei), extra = uint(extraBps, 16);
  requireCondition(price > 0n, 'Reference price must be positive.');
  const rawTarget = (price * (10000n + extra) + 9999n) / 10000n;
  const targetRaise = ((rawTarget + 99n) / 100n) * 100n;
  requireCondition(targetRaise <= MAX_UINT256, 'Funding target overflow.');
  return Object.freeze({ referencePriceWei: price, extraBps: extra, priceCap: price,
    targetRaise, unitPriceWei: targetRaise / 100n, reserveWei: targetRaise - price });
}

/** Failed fields are null, not zero; untrusted rows have no actionable data. */
export function decodePoolRow(row, factory) {
  const status = { validMask: BigInt(row.status.validMask), errorMask: BigInt(row.status.errorMask), trustError: BigInt(row.status.trustError) };
  const trusted = status.trustError === 0n && goodField(status, 0);
  const result = { pool: row.pool, key: row.pool === ZeroAddress ? null : poolKey(factory, row.pool), trusted, status };
  for (const [field, bit] of Object.entries(rowBits)) {
    result[field] = trusted && goodField(status, bit) ? row[field] : null;
  }
  return Object.freeze(result);
}

/** A sold-out holder can still own rewards/refunds. Unknown claims must stay visible. */
export function hasPosition(row) {
  if (!row.trusted) return true;
  return ['shares', 'claimableBEM', 'bnbOwed'].some(field => row[field] === null || row[field] > 0n);
}

/**
 * Read-only EIP-1193 adapter. Factory must come from the reviewed deployment config,
 * never a catalog row. Pin one block for all calls and reject a reorg before returning.
 * No wallet requests, signing, account permissions, sends, polling or RPC URL handling.
 */
export async function readPoolSnapshot(provider, { factory: factoryInput, account = ZeroAddress, pools, offset = 0n, limit = 20n, blockNumber }) {
  const factory = address(factoryInput), owner = getAddress(account);
  const request = (method, params = []) => provider.request({ method, params });
  requireCondition(BigInt(await request('eth_chainId')) === CHAIN_ID, 'Switch to BSC mainnet (56).');
  const block = await request('eth_getBlockByNumber', [blockNumber === undefined ? 'latest' : toQuantity(uint(blockNumber)), false]);
  requireCondition(block?.hash && block.number && block.timestamp, 'RPC block unavailable.');
  requireCondition(blockNumber === undefined || BigInt(block.number) === uint(blockNumber), 'RPC returned a different requested block.');
  const blockTag = toQuantity(BigInt(block.number));
  async function call(to, contract, method, args = []) {
    const data = contract.encodeFunctionData(method, args);
    return contract.decodeFunctionResult(method, await request('eth_call', [{ to, data }, blockTag]));
  }
  const lens = address((await call(factory, abi.PoolFactory, 'lens'))[0]);
  requireCondition(getAddress((await call(lens, abi.PoolLens, 'factory'))[0]) === factory, 'Lens belongs to a different Factory.');
  requireCondition((await call(lens, abi.PoolLens, 'VERSION'))[0] === 1n, 'Unsupported Lens version.');
  let snapshot;
  if (pools !== undefined) {
    requireCondition(Array.isArray(pools) && pools.length <= 20, 'At most 20 pool addresses per read.');
    const unique = [...new Set(pools.map(address))];
    snapshot = (await call(lens, abi.PoolLens, 'positions', [unique, owner]))[0];
  } else {
    const size = uint(limit); requireCondition(size <= 20n, 'At most 20 pools per page.');
    snapshot = (await call(lens, abi.PoolLens, 'poolPage', [uint(offset), size, owner]))[0];
  }
  requireCondition(snapshot.blockNumber === BigInt(block.number) && snapshot.timestamp === BigInt(block.timestamp), 'RPC snapshot block mismatch.');
  const again = await request('eth_getBlockByNumber', [blockTag, false]);
  requireCondition(again?.hash === block.hash && BigInt(await request('eth_chainId')) === CHAIN_ID, 'Chain changed during read; refresh.');
  return Object.freeze({ chainId: CHAIN_ID, factory, lens, account: owner, blockNumber: snapshot.blockNumber,
    blockHash: block.hash, timestamp: snapshot.timestamp, totalPools: snapshot.registryCountValid ? snapshot.totalPools : null,
    nextCursor: snapshot.nextCursor, pools: snapshot.pools.map(row => decodePoolRow(row, factory)) });
}

function transaction(from, to, contract, method, args = [], value = 0n) {
  return Object.freeze({ chainId: '0x38', from: address(from), to: address(to), data: contract.encodeFunctionData(method, args), value: toQuantity(value) });
}

/** Unsigned direct calls only. Re-read and simulate immediately before a user's signature. */
export function personalPoolAction(snapshot, pool, from, action, quantity) {
  const owner = address(from), target = address(pool);
  requireCondition(snapshot.chainId === CHAIN_ID && snapshot.account === owner, 'Snapshot belongs to another wallet or chain.');
  const row = snapshot.pools.find(item => getAddress(item.pool) === target);
  requireCondition(row?.trusted && row.key === poolKey(snapshot.factory, target), 'Pool identity is not verified.');
  if (action === 'deposit') {
    const qty = uint(quantity, 8);
    requireCondition(row.state === 0n && row.depositPaused === false && row.params !== null && snapshot.timestamp < row.params.fundingDeadline, 'Pool is not open for funding.');
    requireCondition(qty > 0n && qty <= 100n && row.totalSupply !== null
      && row.unitPriceWei !== null && row.totalSupply + qty <= 100n, 'Share quantity unavailable.');
    return transaction(owner, target, abi.PoolVault, 'deposit', [qty], uint(row.unitPriceWei * qty));
  }
  requireCondition(['harvest', 'claim', 'withdrawBnb'].includes(action), 'Unsupported personal pool action.');
  if (action === 'harvest') requireCondition(row.state === 2n || row.state === 3n, 'Pool cannot harvest in this state.');
  // claim only pays already-accounted rewards; harvest is a separate permissionless call.
  return transaction(owner, target, abi.PoolVault, action);
}

/**
 * Personal claims stay as separate direct wallet calls, including zero-share positions.
 * Unknown amounts are excluded, so an empty queue is not proof that all balances are zero.
 */
export function personalClaimQueue(snapshot, from) {
  const unique = [...new Map(snapshot.pools.map(row => [row.key, row])).values()];
  return unique.filter(row => row.trusted && row.claimableBEM !== null && row.claimableBEM > 0n)
    .map(row => personalPoolAction(snapshot, row.pool, from, 'claim'));
}

/** Operator transaction; the contract rechecks the quoted model/weight atomically. */
export function checkedPoolCreation({ factory, from, params, config, expectedTaskId, expectedReferenceWeight }) {
  const quote = referenceQuote(config.referencePriceWei, config.extraBps);
  requireCondition(uint(params.targetRaise) === quote.targetRaise && uint(params.priceCap) > 0n && uint(params.priceCap) <= quote.priceCap, 'Creation parameters contradict reference funding/cap.');
  requireCondition(getAddress(params.directSeller) === ZeroAddress && uint(params.directPrice) === 0n, 'Flexible pools use the official market route.');
  const weight = uint(expectedReferenceWeight, 128);
  requireCondition(weight > 0n && uint(config.minVerifiedWeight, 128) > 0n && uint(config.minVerifiedWeight, 128) <= weight, 'Reference weight is incompatible.');
  const exactParams = { circuits: address(params.circuits), circuitId: uint(params.circuitId),
    targetRaise: quote.targetRaise, priceCap: uint(params.priceCap), directSeller: ZeroAddress, directPrice: 0n,
    fundingDeadline: uint(params.fundingDeadline, 64), purchaseDeadline: uint(params.purchaseDeadline, 64) };
  const exactConfig = { minVerifiedWeight: uint(config.minVerifiedWeight, 128), referencePriceWei: quote.referencePriceWei,
    targetDailyYieldAtomic: uint(config.targetDailyYieldAtomic), extraBps: quote.extraBps,
    referenceObservedAt: uint(config.referenceObservedAt, 64), referenceBlock: uint(config.referenceBlock, 64), referenceDigest: config.referenceDigest };
  return transaction(from, factory, abi.PoolFactory, 'createFlexiblePoolChecked', [exactParams, exactConfig, uint(expectedTaskId, 32), weight]);
}
