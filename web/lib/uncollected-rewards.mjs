import { Interface, ZeroAddress, getAddress, toQuantity } from 'ethers';
import { abi, CHAIN_ID, uint } from './chain-client.mjs';
import { settleReadRound } from './read-retry.mjs';

// Pinned protocol identities and Miner layout: contracts/script/Addresses.sol
// and contracts/src/interfaces/ITapeoutMining.sol. These are read targets only.
const MINING = '0x7E2E0DC66a3bD9103E69b766afA62d9f7b697b46';
const BEM = '0x5ce033B2bFCa3Af30b3e8C8457DeaF776A8b695a';
const COLLECTIONS = new Set([
  '0xb1024b89886b9a34aa4ff5f31c411d708b20a14c',
  '0x1f5cb4aeae1807bf60c3b9c0d8adbcc14e91f12c',
]);
const mining = new Interface([
  'function minerKey(address,uint256) view returns(bytes32)',
  'function pending(bytes32) view returns(uint256)',
  'function getMiner(bytes32) view returns(tuple(address circuits,uint64 circuitId,uint32 taskId,uint32 gateCount,uint32 stateCount,uint32 depth,uint64 area,uint32 mult,uint64 since,uint8 status,address registrant,uint32 nandBurn,uint32 latchBurn,uint64 bstar,uint64 bonus,bool optimal,uint64 commitBlock,uint64 firstUnusedId,uint64 stopBlock,uint128 verifWeight,uint128 unverWeight,uint256 debt))',
]);
const token = new Interface(['function balanceOf(address) view returns(uint256)']);
const nft = new Interface(['function ownerOf(uint256) view returns(address)']);
const HASH = /^0x[\da-f]{64}$/i;
const QUANTITY = /^0x(?:0|[1-9a-f][\da-f]*)$/i;
const TTL_MS = 30_000;
const MAX_POOLS = 500;
const valueFields = ['bookedBEM', 'shares', 'uncollectedBEM', 'pendingGrossBEM',
  'unaccountedBEM', 'grossBEM', 'platformFeeBEM', 'totalEstimatedBEM', 'state', 'minerStatus'];
const same = (left, right) => typeof left === 'string' && typeof right === 'string'
  && left.toLowerCase() === right.toLowerCase();

class ReadProblem extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
function requireValue(ok, code, message) { if (!ok) throw new ReadProblem(code, message); }
function address(value) {
  let result;
  try { result = getAddress(value); } catch { throw new ReadProblem('invalid_address', 'Invalid reward read address.'); }
  requireValue(result !== ZeroAddress, 'invalid_address', 'A nonzero reward read address is required.');
  return result;
}
function quantity(value) {
  requireValue(typeof value === 'string' && QUANTITY.test(value), 'invalid_rpc_quantity', 'RPC returned an invalid integer.');
  return uint(BigInt(value));
}
function blockHeader(raw, expected) {
  requireValue(raw && HASH.test(raw.hash ?? ''), 'invalid_header', 'RPC block header is unavailable.');
  const blockNumber = quantity(raw.number), timestamp = quantity(raw.timestamp);
  requireValue(expected === undefined || blockNumber === expected, 'invalid_header', 'RPC returned a different block.');
  return { blockNumber, blockHash: raw.hash.toLowerCase(), timestamp };
}
function failure(pool, error, block = {}) {
  const known = error instanceof ReadProblem;
  return Object.freeze({ pool, status: 'unknown', reason: known ? error.code : 'read_unavailable',
    error: known ? error.message : 'Reward data could not be read.',
    ...Object.fromEntries(valueFields.map(field => [field, null])),
    blockNumber: block.blockNumber ?? null, blockHash: block.blockHash ?? null, timestamp: block.timestamp ?? null });
}
function result({ account, factory, items, block = {}, canonical, error = null, checkedAt }) {
  const complete = canonical && items.every(item => item.status === 'ready');
  const total = field => complete ? items.reduce((sum, item) => sum + item[field], 0n) : null;
  return Object.freeze({ scope: 'loaded-single-pools', account, factory, chainId: CHAIN_ID,
    status: complete ? 'ready' : canonical && items.some(item => item.status === 'ready') ? 'partial' : 'unavailable',
    canonical, complete, error, blockNumber: block.blockNumber ?? null,
    blockHash: block.blockHash ?? null, timestamp: block.timestamp ?? null, checkedAt,
    items: Object.freeze(items), totals: Object.freeze({ bookedBEM: total('bookedBEM'),
      uncollectedBEM: total('uncollectedBEM'), totalEstimatedBEM: total('totalEstimatedBEM') }) });
}

/** Display only. Never feeds claimableBEM, transaction preparation or wallet calls.
 * The estimate applies the current 1% harvest fee to protocol pending plus BEM
 * already received but not booked. Per-user fractional accounting can increase
 * the eventual additional credit by one BEM atom (1e-8 BEM) per pool.
 */
export function createUncollectedRewardReader({ provider, config, now = Date.now } = {}) {
  requireValue(typeof provider?.request === 'function', 'invalid_provider', 'A read-only RPC provider is required.');
  requireValue(typeof now === 'function', 'invalid_clock', 'A reward read clock is required.');
  const factory = address(config?.manifest?.factory ?? config?.factory);
  requireValue(!config?.status || config.status === 'ready', 'invalid_config', 'The reviewed deployment is not ready.');
  requireValue(!config?.factory || same(config.factory, factory), 'invalid_config', 'Configured Factory identities differ.');
  for (const configured of [config?.chainId, config?.manifest?.chainId]) {
    if (configured == null) continue;
    const chain = typeof configured === 'number' && Number.isSafeInteger(configured)
      ? BigInt(configured) : typeof configured === 'string' && QUANTITY.test(configured)
        ? quantity(configured) : uint(configured);
    requireValue(chain === CHAIN_ID, 'wrong_chain', 'The configured chain is not BSC mainnet.');
  }
  const cached = new Map(), inflight = new Map();
  const request = (method, params = []) => provider.request({ method, params });

  async function capture(account, pools) {
    const checkedAt = now();
    let block;
    try {
      const first = await settleReadRound({ chain: () => request('eth_chainId'),
        block: () => request('eth_getBlockByNumber', ['latest', false]) });
      requireValue(quantity(first.chain) === CHAIN_ID, 'wrong_chain', 'Switch to BSC mainnet (56).');
      block = blockHeader(first.block);
      const tag = toQuantity(block.blockNumber);
      const call = async (to, contract, method, args = []) => contract.decodeFunctionResult(method,
        await request('eth_call', [{ to, data: contract.encodeFunctionData(method, args) }, tag]))[0];
      const readPool = async pool => {
        try {
          const base = await settleReadRound({
            registered: () => call(factory, abi.PoolFactory, 'isPool', [pool]),
            poolFactory: () => call(pool, abi.PoolVault, 'factory'),
            state: () => call(pool, abi.PoolVault, 'state'),
            params: () => call(pool, abi.PoolVault, 'params'),
            shares: () => call(pool, abi.PoolVault, 'balanceOf', [account]),
            booked: () => call(pool, abi.PoolVault, 'claimable', [account]),
            accounted: () => call(pool, abi.PoolVault, 'bemAccounted'),
            bemBalance: () => call(BEM, token, 'balanceOf', [pool]),
          });
          requireValue(base.registered === true && same(base.poolFactory, factory), 'untrusted_pool',
            'Pool is not registered to the reviewed Factory.');
          const state = uint(base.state), shares = uint(base.shares), bookedBEM = uint(base.booked);
          const accounted = uint(base.accounted), bemBalance = uint(base.bemBalance);
          requireValue(state <= 5n && shares <= 100n, 'invalid_pool_state', 'Pool state or shares are invalid.');
          requireValue(bemBalance >= accounted, 'accounting_deficit', 'Pool BEM balance is below its booked liabilities.');
          const collection = address(base.params.circuits), circuitId = uint(base.params.circuitId);
          requireValue(COLLECTIONS.has(collection.toLowerCase()), 'unknown_collection', 'Unsupported miner collection.');
          let pendingGrossBEM = 0n, minerStatus = null;
          const canHarvest = state === 2n || state === 3n;
          if (canHarvest) {
            const identity = await settleReadRound({ owner: () => call(collection, nft, 'ownerOf', [circuitId]),
              key: () => call(MINING, mining, 'minerKey', [collection, circuitId]) });
            requireValue(same(identity.owner, pool), 'not_miner_owner', 'Pool no longer owns this miner.');
            requireValue(HASH.test(identity.key), 'invalid_miner_key', 'Miner key is invalid.');
            const miningState = await settleReadRound({ miner: () => call(MINING, mining, 'getMiner', [identity.key]),
              pending: () => call(MINING, mining, 'pending', [identity.key]) });
            requireValue(same(miningState.miner.circuits, collection) && miningState.miner.circuitId === circuitId,
              'miner_identity', 'Mining record identifies a different miner.');
            minerStatus = uint(miningState.miner.status);
            pendingGrossBEM = uint(miningState.pending);
            requireValue(minerStatus <= 3n && (minerStatus === 1n || pendingGrossBEM === 0n),
              'unknown_miner_state', 'Mining state does not establish collectable output.');
          }
          // Closed/funding/refunding pools retain historical booked credits,
          // but can neither harvest their former NFT nor allocate its output.
          const unaccountedBEM = canHarvest ? bemBalance - accounted : 0n;
          const grossBEM = uint(pendingGrossBEM + unaccountedBEM);
          const platformFeeBEM = grossBEM / 100n;
          const uncollectedBEM = (grossBEM - platformFeeBEM) * shares / 100n;
          const totalEstimatedBEM = uint(bookedBEM + uncollectedBEM);
          return Object.freeze({ pool, status: 'ready', reason: null, error: null,
            bookedBEM, shares, uncollectedBEM, pendingGrossBEM, unaccountedBEM,
            grossBEM, platformFeeBEM, totalEstimatedBEM, state, minerStatus, ...block });
        } catch (error) { return failure(pool, error, block); }
      };
      const items = [];
      // Pagination can be merged by the UI. Bound each page and active pools,
      // while retaining the same block tag for the whole loaded set.
      for (let page = 0; page < pools.length; page += 20) {
        const batch = pools.slice(page, page + 20), rows = new Array(batch.length);
        let next = 0;
        await Promise.all(Array.from({ length: Math.min(3, batch.length) }, async () => {
          while (next < batch.length) { const index = next++; rows[index] = await readPool(batch[index]); }
        }));
        items.push(...rows);
      }
      const final = await settleReadRound({ chain: () => request('eth_chainId'),
        block: () => request('eth_getBlockByNumber', [tag, false]) });
      const after = blockHeader(final.block, block.blockNumber);
      requireValue(quantity(final.chain) === CHAIN_ID && after.blockHash === block.blockHash
        && after.timestamp === block.timestamp, 'source_changed', 'Chain or block changed during the reward read.');
      return result({ account, factory, items, block, canonical: true, checkedAt });
    } catch (error) {
      // A failed canonical check invalidates every new row, including pools
      // whose individual calls succeeded. Never substitute old or zero data.
      return result({ account, factory, items: pools.map(pool => failure(pool, error)),
        canonical: false, checkedAt, error: error instanceof ReadProblem ? error.message : 'Reward source is unavailable.' });
    }
  }

  return async function read({ account, positions, force = false } = {}) {
    const rows = Array.isArray(positions) ? positions : positions?.items;
    requireValue(Array.isArray(rows), 'invalid_positions', 'Loaded single-pool positions are required.');
    const pools = [...new Set(rows.filter(row => row?.kind !== 'portfolio')
      .map(row => address(row?.pool ?? row?.poolAddress).toLowerCase()))].sort().map(getAddress);
    requireValue(pools.length <= MAX_POOLS, 'too_many_pools', 'Too many loaded pools for a bounded reward read.');
    if (!pools.length) return result({ account: account ? address(account) : null, factory,
      items: [], canonical: true, checkedAt: now() });
    const owner = address(account);
    const key = `${owner.toLowerCase()}:${factory.toLowerCase()}:${pools.map(pool => pool.toLowerCase()).join(',')}`;
    if (inflight.has(key)) return inflight.get(key);
    const previous = cached.get(key), time = now();
    if (!force && previous && time >= previous.savedAt && time - previous.savedAt < TTL_MS) return previous.value;
    cached.delete(key);
    const work = capture(owner, pools).then(value => {
      if (value.canonical) cached.set(key, { savedAt: now(), value });
      for (const [entry, saved] of cached) if (time - saved.savedAt >= TTL_MS) cached.delete(entry);
      while (cached.size > 20) cached.delete(cached.keys().next().value);
      return value;
    }).finally(() => { inflight.delete(key); });
    inflight.set(key, work);
    return work;
  };
}
