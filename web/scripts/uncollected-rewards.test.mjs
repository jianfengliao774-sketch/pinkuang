import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Interface, ZeroAddress, getAddress } from 'ethers';
import { abi } from '../lib/chain-client.mjs';
import { createUncollectedRewardReader } from '../lib/uncollected-rewards.mjs';
import { claimDisplayState } from '../lib/claim-display.mjs';

const address = value => getAddress(`0x${BigInt(value).toString(16).padStart(40, '0')}`);
const FACTORY = address(101), ACCOUNT = address(102), OTHER = address(103), POOL = address(104);
const COLLECTION = '0xb1024b89886B9a34Aa4ff5F31C411D708b20a14C';
const MINING = '0x7E2E0DC66a3bD9103E69b766afA62d9f7b697b46';
const BEM = '0x5ce033B2bFCa3Af30b3e8C8457DeaF776A8b695a';
const BLOCK_HASH = `0x${'a'.repeat(64)}`, OTHER_HASH = `0x${'b'.repeat(64)}`;
const TAG = '0x64', TIMESTAMP = '0x65';
const mining = new Interface([
  'function minerKey(address,uint256) view returns(bytes32)',
  'function pending(bytes32) view returns(uint256)',
  'function getMiner(bytes32) view returns(tuple(address circuits,uint64 circuitId,uint32 taskId,uint32 gateCount,uint32 stateCount,uint32 depth,uint64 area,uint32 mult,uint64 since,uint8 status,address registrant,uint32 nandBurn,uint32 latchBurn,uint64 bstar,uint64 bonus,bool optimal,uint64 commitBlock,uint64 firstUnusedId,uint64 stopBlock,uint128 verifWeight,uint128 unverWeight,uint256 debt))',
]);
const token = new Interface(['function balanceOf(address) view returns(uint256)']);
const nft = new Interface(['function ownerOf(uint256) view returns(address)']);
const config = { status: 'ready', manifest: { factory: FACTORY, chainId: 56 } };
const row = (pool = POOL, changes = {}) => ({ pool, kind: 'single', trusted: true,
  shares: 99n, claimableBEM: 0n, state: 0n, ...changes });
const minerKey = id => `0x${id.toString(16).padStart(64, '0')}`;
const miner = (id, changes = {}) => ({ circuits: COLLECTION, circuitId: id, taskId: 1n,
  gateCount: 1n, stateCount: 0n, depth: 1n, area: 1n, mult: 1n, since: 1n, status: 1n,
  registrant: ACCOUNT, nandBurn: 0n, latchBurn: 0n, bstar: 0n, bonus: 0n, optimal: false,
  commitBlock: 0n, firstUnusedId: 0n, stopBlock: 0n, verifWeight: 1n, unverWeight: 0n, debt: 0n, ...changes });

function fixture({ records = [{ pool: POOL }], chain = '0x38', finalChain = chain,
  finalHash = BLOCK_HASH, finalTimestamp = TIMESTAMP, hook, now = () => 1000 } = {}) {
  const states = new Map(records.map((record, index) => [record.pool.toLowerCase(), {
    id: BigInt(index + 1), registered: true, factory: FACTORY, state: 2n, shares: 20n,
    booked: 7n, accounted: 100n, bemBalance: 100n, pending: 1000n, owner: record.pool,
    minerChanges: {}, ...record,
  }]));
  const calls = [];
  let chainReads = 0, active = 0, maxActive = 0;
  const activePools = new Set();
  const provider = { async request({ method, params = [] }) {
    calls.push({ method, params });
    if (method === 'eth_chainId') return chainReads++ % 2 === 0 ? chain : finalChain;
    if (method === 'eth_getBlockByNumber') {
      const final = params[0] !== 'latest';
      const overridden = await hook?.({ method, params, final });
      if (overridden !== undefined) return overridden;
      return { number: TAG, hash: final ? finalHash : BLOCK_HASH,
        timestamp: final ? finalTimestamp : TIMESTAMP };
    }
    assert.equal(method, 'eth_call', 'the reader must never invoke a wallet/write method');
    assert.equal(params[1], TAG, 'every contract read must share the captured block');
    const target = params[0].to.toLowerCase();
    let contract, state;
    if (target === FACTORY.toLowerCase()) contract = abi.PoolFactory;
    else if (target === MINING.toLowerCase()) contract = mining;
    else if (target === BEM.toLowerCase()) contract = token;
    else if (target === COLLECTION.toLowerCase()) contract = nft;
    else { contract = abi.PoolVault; state = states.get(target); assert(state, 'unexpected read target'); }
    const parsed = contract.parseTransaction(params[0]), name = parsed.name, args = parsed.args;
    if (name === 'isPool') state = states.get(args[0].toLowerCase());
    if (target === BEM.toLowerCase()) state = states.get(args[0].toLowerCase());
    if (target === COLLECTION.toLowerCase()) state = [...states.values()].find(item => item.id === args[0]);
    if (target === MINING.toLowerCase()) state = name === 'minerKey'
      ? [...states.values()].find(item => item.id === args[1])
      : [...states.values()].find(item => minerKey(item.id) === args[0]);
    assert(state, 'unexpected miner identity');
    if (name === 'isPool') {
      activePools.add(state.pool); active++; maxActive = Math.max(maxActive, active);
    }
    const overridden = await hook?.({ method, params, name, args, state, target });
    if (overridden !== undefined) return overridden;
    let value;
    if (name === 'isPool') value = state.registered;
    else if (name === 'factory') value = state.factory;
    else if (name === 'state') value = state.state;
    else if (name === 'params') value = { circuits: state.collection ?? COLLECTION, circuitId: state.id,
      targetRaise: 100n, priceCap: 10n, directSeller: ZeroAddress, directPrice: 0n,
      fundingDeadline: 1n, purchaseDeadline: 2n };
    else if (name === 'balanceOf') value = target === BEM.toLowerCase() ? state.bemBalance
      : args[0].toLowerCase() === ACCOUNT.toLowerCase() ? state.shares : state.otherShares ?? 50n;
    else if (name === 'claimable') value = state.booked;
    else if (name === 'bemAccounted') value = state.accounted;
    else if (name === 'ownerOf') value = state.owner;
    else if (name === 'minerKey') value = minerKey(state.id);
    else if (name === 'getMiner') value = miner(state.id, state.minerChanges);
    else if (name === 'pending') {
      value = state.pending;
      if (activePools.delete(state.pool)) active--;
    } else assert.fail(`unexpected read ${name}`);
    return contract.encodeFunctionResult(parsed.fragment, [value]);
  } };
  return { reader: createUncollectedRewardReader({ provider, config, now }), provider, states, calls,
    maxActive: () => maxActive, read: (positions = records.map(item => row(item.pool)), changes = {}) =>
      createReadArgs(positions, changes) };
}
const createReadArgs = (positions, changes = {}) => ({ account: ACCOUNT, positions, ...changes });

test('reads real ABI values at one block, combines unbooked receipts and applies the 1% fee once', async () => {
  const f = fixture({ records: [{ pool: POOL, pending: 999n, bemBalance: 101n }] });
  const result = await f.reader(f.read());
  assert.equal(result.status, 'ready'); assert.equal(result.canonical, true);
  assert.equal(result.blockNumber, 100n); assert.equal(result.blockHash, BLOCK_HASH);
  assert.equal(result.timestamp, 101n);
  const item = result.items[0];
  assert.equal(item.bookedBEM, 7n); assert.equal(item.shares, 20n);
  assert.equal(item.pendingGrossBEM, 999n); assert.equal(item.unaccountedBEM, 1n);
  assert.equal(item.platformFeeBEM, 10n); assert.equal(item.uncollectedBEM, 198n);
  assert.equal(item.totalEstimatedBEM, 205n); assert.equal(result.totals.totalEstimatedBEM, 205n);
  assert(!Object.hasOwn(item, 'claimableBEM'), 'display estimate never overwrites the action balance');
  assert.deepEqual(f.calls.filter(call => call.method === 'eth_getBlockByNumber').map(call => call.params[0]), ['latest', TAG]);
  assert(!f.calls.some(call => call.params[0]?.data === abi.PoolVault.encodeFunctionData('lastClaimAt', [ACCOUNT])));
});

test('retains BigInt precision, atomic rewards and fee floor rather than floating point', async () => {
  const large = 900719925474099312345678n;
  for (const pending of [1n, 99n, 100n, 101n, large]) {
    const f = fixture({ records: [{ pool: POOL, shares: 100n, pending }] });
    const result = await f.reader(f.read());
    assert.equal(result.items[0].uncollectedBEM, pending - pending / 100n);
    assert.equal(result.items[0].pendingGrossBEM, pending);
  }
  const f = fixture({ records: [{ pool: POOL, shares: 1n, pending: 1n }] });
  const result = await f.reader(f.read());
  assert.equal(result.items[0].pendingGrossBEM, 1n);
  assert.equal(result.items[0].uncollectedBEM, 0n, 'fractional atom is conservatively retained until booking');
});

test('fresh shares supersede cached shares and zero-share historical credits remain visible', async () => {
  const f = fixture({ records: [{ pool: POOL, shares: 0n, booked: 123n }] });
  let result = await f.reader(f.read());
  assert.equal(result.items[0].shares, 0n); assert.equal(result.items[0].bookedBEM, 123n);
  assert.equal(result.items[0].uncollectedBEM, 0n); assert.equal(result.items[0].totalEstimatedBEM, 123n);
  f.states.get(POOL.toLowerCase()).shares = 1n;
  result = await f.reader(f.read(undefined, { force: true }));
  assert.equal(result.items[0].shares, 1n); assert.equal(result.items[0].uncollectedBEM, 9n);
});

test('closed, funding, funded and refunding pools cannot allocate their former miner output', async () => {
  for (const state of [0n, 1n, 4n, 5n]) {
    const f = fixture({ records: [{ pool: POOL, state, booked: 100n, owner: OTHER, pending: 1_000_000n, bemBalance: 200n }] });
    const result = await f.reader(f.read());
    assert.equal(result.items[0].bookedBEM, 100n); assert.equal(result.items[0].uncollectedBEM, 0n);
    assert.equal(result.items[0].pendingGrossBEM, 0n);
    assert(!f.calls.some(call => call.params[0]?.to === MINING || call.params[0]?.to === COLLECTION));
  }
});

test('Listed pools collect; known nonmining zero settlements can still book existing pool receipts', async () => {
  for (const status of [0n, 1n, 2n, 3n]) {
    const f = fixture({ records: [{ pool: POOL, state: 3n, pending: 0n, bemBalance: 200n, minerChanges: { status } }] });
    const result = await f.reader(f.read());
    assert.equal(result.status, 'ready'); assert.equal(result.items[0].minerStatus, status);
    assert.equal(result.items[0].uncollectedBEM, 19n);
  }
});

test('unknown state, ownership, miner identity, registration and accounting never become zero', async () => {
  for (const [changes, reason] of [
    [{ state: 6n }, 'invalid_pool_state'], [{ shares: 101n }, 'invalid_pool_state'],
    [{ registered: false }, 'untrusted_pool'], [{ factory: OTHER }, 'untrusted_pool'],
    [{ owner: OTHER }, 'not_miner_owner'], [{ collection: OTHER }, 'unknown_collection'],
    [{ minerChanges: { circuits: OTHER } }, 'miner_identity'],
    [{ minerChanges: { circuitId: 2n } }, 'miner_identity'],
    [{ minerChanges: { status: 4n } }, 'unknown_miner_state'],
    [{ minerChanges: { status: 2n } }, 'unknown_miner_state'],
    [{ accounted: 101n, bemBalance: 100n }, 'accounting_deficit'],
  ]) {
    const f = fixture({ records: [{ pool: POOL, ...changes }] });
    const result = await f.reader(f.read());
    assert.equal(result.items[0].status, 'unknown'); assert.equal(result.items[0].reason, reason);
    assert.equal(result.items[0].uncollectedBEM, null); assert.equal(result.items[0].bookedBEM, null);
    assert.equal(result.totals.totalEstimatedBEM, null);
  }
});

test('one failed pool does not discard independently canonical pools or expose the RPC error', async () => {
  const pool2 = address(105);
  const f = fixture({ records: [{ pool: POOL }, { pool: pool2 }], hook: ({ state, name }) => {
    if (state?.pool === POOL && name === 'pending') throw Error('private-rpc-secret');
  } });
  const result = await f.reader(f.read());
  assert.equal(result.status, 'partial'); assert.equal(result.canonical, true);
  assert.equal(result.items[0].uncollectedBEM, null);
  assert.equal(result.items[1].uncollectedBEM, 198n);
  assert.equal(result.totals.bookedBEM, null);
  assert(!JSON.stringify(result, (_key, value) => typeof value === 'bigint' ? String(value) : value).includes('private-rpc-secret'));
});

test('chain switch, reorg or changed header invalidates all newly read data', async () => {
  for (const options of [{ chain: '0x1' }, { finalChain: '0x1' },
    { finalHash: OTHER_HASH }, { finalTimestamp: '0x66' },
    { hook: ({ method, final }) => method === 'eth_getBlockByNumber' && final ? { number: '0x63', hash: BLOCK_HASH, timestamp: TIMESTAMP } : undefined }]) {
    const f = fixture(options), result = await f.reader(f.read());
    assert.equal(result.status, 'unavailable'); assert.equal(result.canonical, false);
    assert.equal(result.blockHash, null); assert.equal(result.items[0].blockHash, null);
    assert.equal(result.items[0].bookedBEM, null); assert.equal(result.items[0].pendingGrossBEM, null);
    assert.equal(result.totals.uncollectedBEM, null);
  }
});

test('cache keys are account and merged pool set; TTL, force and in-flight reads do not duplicate RPC', async () => {
  let time = 1000, held, release;
  const gate = new Promise(resolve => { release = resolve; });
  const f = fixture({ now: () => time, hook: async ({ method, params }) => {
    if (held && method === 'eth_getBlockByNumber' && params[0] === 'latest') await gate;
  } });
  const first = await f.reader(f.read()), count = f.calls.length;
  assert.equal(await f.reader(f.read([row(), row(POOL.toLowerCase(), { shares: 1n })])), first);
  assert.equal(f.calls.length, count);
  time += 29_999;
  assert.equal(await f.reader(f.read()), first); assert.equal(f.calls.length, count);
  time++;
  assert.notEqual(await f.reader(f.read()), first);
  const beforeForce = f.calls.length;
  held = true;
  const a = f.reader(f.read(undefined, { force: true }));
  const b = f.reader(f.read(undefined, { force: true }));
  const c = f.reader(f.read());
  release();
  const values = await Promise.all([a, b, c]);
  assert.equal(values[0], values[1]); assert.equal(values[0], values[2]);
  assert.equal(f.calls.length - beforeForce, count);
  const beforeWallet = f.calls.length;
  await f.reader(f.read(undefined, { account: OTHER }));
  assert(f.calls.length > beforeWallet);
});

test('empty and portfolio-only positions perform no RPC; merged pages deduplicate and limit active pools to three', async () => {
  const records = Array.from({ length: 25 }, (_, index) => ({ pool: address(200 + index) }));
  const f = fixture({ records });
  const empty = await f.reader({ positions: [], account: ACCOUNT });
  assert.equal(empty.status, 'ready'); assert.equal(empty.totals.totalEstimatedBEM, 0n);
  await f.reader({ positions: [row(POOL, { kind: 'portfolio' })] });
  assert.equal(f.calls.length, 0);
  const result = await f.reader(f.read([...records.map(item => row(item.pool)), row(records[0].pool)]));
  assert.equal(result.items.length, 25); assert.equal(result.complete, true);
  assert(f.maxActive() <= 3);
  assert.equal(f.calls.filter(call => call.method === 'eth_getBlockByNumber').length, 2);
  const calls = f.calls.length;
  await f.reader(f.read([...records.map(item => row(item.pool))].reverse()));
  assert.equal(f.calls.length, calls, 'pool-set ordering must not bust the cache');
});

test('harvest transition uses fresh booked balance and pending together instead of adding old cached income', async () => {
  const f = fixture();
  const before = await f.reader(f.read());
  assert.equal(before.totals.totalEstimatedBEM, 205n);
  Object.assign(f.states.get(POOL.toLowerCase()), { pending: 0n, booked: 205n, accounted: 1090n, bemBalance: 1090n });
  const after = await f.reader(f.read(undefined, { force: true }));
  assert.equal(after.items[0].uncollectedBEM, 0n); assert.equal(after.totals.totalEstimatedBEM, 205n);
});

test('a failed forced canonical read retires the prior cache rather than resurrecting its numbers', async () => {
  let fail = false;
  const f = fixture({ hook: ({ method, final }) => fail && method === 'eth_getBlockByNumber' && final
    ? { number: TAG, hash: OTHER_HASH, timestamp: TIMESTAMP } : undefined });
  await f.reader(f.read()); fail = true;
  const bad = await f.reader(f.read(undefined, { force: true }));
  assert.equal(bad.canonical, false);
  const calls = f.calls.length;
  const retried = await f.reader(f.read());
  assert(f.calls.length > calls); assert.equal(retried.items[0].totalEstimatedBEM, null);
});

test('configuration and malformed loaded identities cannot make arbitrary reads', async () => {
  const f = fixture();
  assert.throws(() => createUncollectedRewardReader({ provider: f.provider,
    config: { manifest: { factory: FACTORY, chainId: 1 } } }), /configured chain/);
  await assert.rejects(f.reader({ account: ACCOUNT, positions: [row('invalid')] }), /address/);
  assert.equal(f.calls.length, 0);
});

// Connect the real RPC reader's output to the existing claim feedback helper.
// Only the booked field is projected onto the display row; neither pending nor
// its estimated total can become the balance that enables a direct claim.
function claimFromRead(snapshot, cachedRow, options = {}) {
  const estimate = snapshot.items.find(item => item.pool.toLowerCase() === cachedRow.pool.toLowerCase());
  const bookedRow = estimate?.status === 'ready'
    ? { ...cachedRow, claimableBEM: estimate.bookedBEM } : cachedRow;
  return claimDisplayState({ pool: bookedRow.pool, account: snapshot.account, currency: 'BEM',
    balance: bookedRow.claimableBEM, balanceBlock: estimate?.status === 'ready' ? estimate.blockNumber : 90n,
    ...options });
}

test('reader-to-claim integration: positive protocol pending with no booked balance cannot enable a claim', async () => {
  const pool2 = address(105);
  // Atomic values from the canonical production read of TapeOut #7223/#16803.
  const f = fixture({ records: [{ pool: POOL, booked: 0n, shares: 50n, pending: 580778n },
    { pool: pool2, booked: 0n, shares: 51n, pending: 199076n }] });
  const result = await f.reader(f.read());
  assert.equal(result.totals.uncollectedBEM, 387998n);
  assert.deepEqual(result.items.map(item => item.uncollectedBEM), [287485n, 100513n]);
  for (const item of result.items) {
    const claim = claimFromRead(result, row(item.pool));
    assert.equal(claim.state, 'empty'); assert.equal(claim.canClaim, false);
    assert.equal(claim.amount, 0n); assert(item.totalEstimatedBEM > 0n);
  }
});

test('reader-to-claim integration: freshly booked income supersedes a cached zero without mutating that cache', async () => {
  const f = fixture({ records: [{ pool: POOL, booked: 123n, pending: 0n }] });
  const cached = row(POOL, { claimableBEM: 0n }), result = await f.reader(f.read([cached]));
  const claim = claimFromRead(result, cached);
  assert.equal(claim.state, 'available'); assert.equal(claim.canClaim, true); assert.equal(claim.amount, 123n);
  assert.equal(cached.claimableBEM, 0n);
});

test('reader-to-claim integration: freshly empty booked balance overrides a cached positive balance', async () => {
  const f = fixture({ records: [{ pool: POOL, booked: 0n, pending: 1000n }] });
  const cached = row(POOL, { claimableBEM: 999n }), result = await f.reader(f.read([cached]));
  const claim = claimFromRead(result, cached);
  assert.equal(claim.state, 'empty'); assert.equal(claim.canClaim, false); assert.equal(claim.amount, 0n);
  assert.equal(cached.claimableBEM, 999n); assert(result.items[0].uncollectedBEM > 0n);
});

test('reader-to-claim integration: a fresh post-claim block retires old confirmed/updating feedback', async () => {
  const record = { status: 'confirmed', chainId: 56, action: 'claim', account: ACCOUNT, target: POOL,
    hash: OTHER_HASH, data: abi.PoolVault.encodeFunctionData('claim'), value: '0',
    blockNumber: 99n, confirmedAt: 1000 };
  const options = { transactions: [record], now: 1001 };
  assert.equal(claimDisplayState({ pool: POOL, account: ACCOUNT, currency: 'BEM', balance: 0n,
    balanceBlock: 90n, ...options }).state, 'confirmed');
  for (const [booked, expected] of [[0n, 'claimed'], [123n, 'available']]) {
    const f = fixture({ records: [{ pool: POOL, booked, pending: 1000n }] });
    const result = await f.reader(f.read());
    const claim = claimFromRead(result, row(), options);
    assert.equal(claim.state, expected); assert.equal(claim.updating, false);
    assert.equal(claim.canClaim, booked > 0n); assert.equal(claim.amount, booked);
  }
});

test('reader-to-claim integration: zero shares do not prevent claiming historical booked income', async () => {
  const f = fixture({ records: [{ pool: POOL, shares: 0n, booked: 123n, state: 4n, owner: OTHER }] });
  const result = await f.reader(f.read()), claim = claimFromRead(result, row(POOL, { shares: 0n }));
  assert.equal(result.items[0].uncollectedBEM, 0n);
  assert.equal(claim.state, 'available'); assert.equal(claim.canClaim, true); assert.equal(claim.amount, 123n);
});
