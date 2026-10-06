import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Interface, Transaction, Wallet, keccak256, parseEther } from 'ethers';
import { createFirstoListingExpiryKeeper, firstoExpiryKeeperConfiguration, readFirstoListingExpiry,
  assertFirstoExpiryJournal, FIRSTO_EXPIRY_CALLDATA, trackFirstoListingExpiry } from './firsto-listing-expiry-keeper.mjs';

const address = n => `0x${n.toString(16).padStart(40, '0')}`, factory = address(1), pool = address(2), secondPool = address(3);
const blockHash = n => `0x${n.toString(16).padStart(64, '0')}`;
function fixture(options = {}) {
  const wallet = Wallet.createRandom(), journals = new Map(), writes = [], observations = [];
  let clock = 1790904988000, signatures = 0, broadcasts = 0, laneChecks = 0, stateReads = 0, nonceReads = 0;
  const state = { version: 1n, state: 3n, listedProposalId: 7n, expiresAt: 1790904900n,
    timestamp: 1790904988n, eligible: true };
  const config = { journalDir: '/private/listing-expiry', statusPath: '/public/expiry.json', expectedGasWallet: wallet.address,
    maxGasWei: parseEther('0.001'), hourlyGasWei: parseEther('0.01'), maxGasPrice: 1_000_000_000n,
    maxGasLimit: 300_000n, retryIntervalMs: 60_000, maxAttempts: 2, batch: 1, maxPools: 1000, ...options.config };
  const provider = {
    getNetwork: async () => ({ chainId: options.wrongChain ? 1n : 56n }),
    estimateGas: async tx => { assert.equal(tx.to, pool); assert.equal(tx.data, FIRSTO_EXPIRY_CALLDATA);
      assert.equal(tx.value, 0n); if (options.simulationFails) throw Error('deadline or state changed'); return 100_000n; },
    getFeeData: async () => ({ gasPrice: options.gasPrice ?? 100_000_000n }),
    getBalance: async () => parseEther('1'),
    getTransactionCount: async (_from, tag) => { nonceReads++; return options.nonceChange && nonceReads > 2 ? 5 : 4; },
    getBlock: async () => ({ number: 100, timestamp: 1790904988, hash: blockHash(100), gasLimit: 30_000_000n }),
    broadcastTransaction: async raw => {
      broadcasts++;
      const tx = Transaction.from(raw), saved = journals.get(pool);
      assert.equal(tx.to.toLowerCase(), pool); assert.equal(tx.data, FIRSTO_EXPIRY_CALLDATA);
      assert.equal(tx.value, 0n); assert.equal(tx.nonce, 4); assert.equal(tx.chainId, 56n); assert.equal(tx.from, wallet.address);
      assert.equal(saved.transaction.phase, 'signed'); assert.equal(saved.transaction.attempts[0].broadcastCount, 1);
      if (options.ambiguous) throw Error('connection closed after send'); return { hash: keccak256(raw) };
    },
  };
  const dependencies = { now: () => clock, lockJournal: () => () => {},
    lockWallet: (_from, path) => { laneChecks++; assert(journals.has(pool), 'journal exists before persistent wallet pointer');
      assert(path.endsWith(`${pool}.json`)); if (options.busy) throw Error('Wallet has an unresolved transaction in another pool journal. Reconcile that journal first.');
      return () => {}; },
    readJournal: (_path, scope) => structuredClone(journals.get(scope.pool) ?? { version: 1, chainId: 56,
      factory, pool: scope.pool, transactionTarget: scope.pool, transaction: null, gasSpentWei: '0', gasReceipts: {} }),
    writeJournal: (_path, value) => { journals.set(value.pool, structuredClone(value)); writes.push(structuredClone(value)); },
    reconcilePending: async (_provider, scope, journal) => options.reconcile ? options.reconcile(scope, journal)
      : journal.transaction && !['confirmed', 'reverted'].includes(journal.transaction.phase) ? { status: 'pending-receipt' } : null,
    discoverPools: async () => options.pools ?? [pool],
    readExpiry: async (_provider, scope) => { stateReads++; options.onRead?.(stateReads, state); return { ...state, pool: scope.pool }; },
    publishStatus: (_path, value) => observations.push(structuredClone(value)),
  };
  const create = () => createFirstoListingExpiryKeeper({ config, provider, signer: { getAddress: () => wallet.getAddress(),
    signTransaction: async request => { signatures++; return wallet.signTransaction(request); } }, factory,
    verifyDeployment: async () => options.graphError ? Promise.reject(Error('unapproved graph'))
      : options.oldGraph ? {} : { nativeSaleUpgrade: { version: 1 } }, dependencies });
  const keeper = create();
  return { keeper, create, config, provider, wallet, state, journals, writes, observations,
    get signatures() { return signatures; }, get broadcasts() { return broadcasts; }, get laneChecks() { return laneChecks; },
    get journal() { return journals.get(pool); }, get row() { return keeper.snapshot().pools[pool]; }, advance(ms) { clock += ms; } };
}
const finalize = (f, phase = 'confirmed', cost = 10_000_000_000_000n) => {
  const journal = f.journal; Object.assign(journal.transaction, { phase, finality: 'bsc-finalized', blockNumber: 100,
    blockHash: blockHash(100), finalizedBlockNumber: 102, finalizedBlockHash: blockHash(102),
    confirmedAt: new Date(1790904988000).toISOString(), gasCostWei: cost.toString() });
  journal.gasSpentWei = cost.toString(); journal.gasReceipts[journal.transaction.hash] = cost.toString();
};

test('expiry signs only exact permissionless calldata and reserves the existing wallet lane before durable broadcast', async () => {
  const f = fixture(); await f.keeper.tick();
  assert.equal(f.signatures, 1); assert.equal(f.broadcasts, 1); assert.equal(f.laneChecks, 1);
  assert.equal(f.row.status, 'pending'); assert.equal(f.journal.transaction.expiry.listedProposalId, '7');
  assert(f.writes.some(value => value.transaction?.phase === 'signed' && value.transaction.attempts[0].broadcastCount === 0));
  assert.equal(f.journal.transaction.to, pool); assert.equal(f.journal.transaction.value, '0'); await f.keeper.close();
});

test('old graphs, unsupported pools, unexpired or closed listings never sign or broadcast', async () => {
  for (const fault of ['old-graph', 'version', 'unexpired', 'closed']) {
    const f = fixture({ oldGraph: fault === 'old-graph' });
    if (fault !== 'old-graph') Object.assign(f.state, fault === 'version' ? { version: 0n, eligible: false }
      : fault === 'unexpired' ? { timestamp: f.state.expiresAt - 1n, eligible: false } : { state: 4n, eligible: false });
    await f.keeper.tick(); assert.equal(f.signatures, 0); assert.equal(f.broadcasts, 0); await f.keeper.close();
  }
  for (const options of [{ wrongChain: true }, { graphError: true }]) {
    const f = fixture(options); await assert.rejects(f.keeper.tick()); assert.equal(f.signatures, 0); await f.keeper.close();
  }
});

test('wallet contention and sale completion during expiry reads leave the original listing and foreign reservation alone', async () => {
  const busy = fixture({ busy: true }); await busy.keeper.tick();
  assert.equal(busy.row.status, 'queued'); assert.equal(busy.signatures, 0); assert.equal(busy.journal.transaction, null); await busy.keeper.close();
  const race = fixture({ onRead: (count, state) => { if (count > 1) { state.eligible = false; state.state = 4n; } } });
  await race.keeper.tick(); assert.equal(race.signatures, 0); assert.equal(race.broadcasts, 0); await race.keeper.close();
});

test('unknown broadcasts and process restart only reconcile the same reserved raw hash, never resending', async () => {
  const f = fixture({ ambiguous: true }); await f.keeper.tick(); const hash = f.journal.transaction.hash;
  assert.equal(f.journal.transaction.phase, 'signed'); await f.keeper.tick(); assert.equal(f.signatures, 1); assert.equal(f.broadcasts, 1);
  await f.keeper.close(); const restarted = f.create(); await restarted.tick();
  assert.equal(f.journal.transaction.hash, hash); assert.equal(f.signatures, 1); assert.equal(f.broadcasts, 1); await restarted.close();
});

test('nonce changes after signing hold the exact bytes before any broadcast', async () => {
  const f = fixture({ nonceChange: true }); await f.keeper.tick();
  assert.equal(f.signatures, 1); assert.equal(f.broadcasts, 0); assert.equal(f.row.status, 'review-required');
  assert.equal(f.journal.transaction.attempts[0].broadcastCount, 0); await f.keeper.tick(); assert.equal(f.signatures, 1); await f.keeper.close();
});

test('a finalized expiry only reports active after observing chain state, and a new listing uses a new bound job', async () => {
  const f = fixture(); await f.keeper.tick(); finalize(f); f.state.state = 2n; f.state.eligible = false;
  await f.keeper.tick(); assert.equal(f.row.status, 'active'); assert.equal(f.signatures, 1);
  f.state.state = 3n; f.state.eligible = true; f.state.listedProposalId = 8n; f.state.expiresAt += 1n;
  await f.keeper.tick(); assert.equal(f.signatures, 2); assert.equal(f.journal.transaction.expiry.listedProposalId, '8');
  assert.equal(f.journal.previousTransaction.expiry.listedProposalId, '7'); await f.keeper.close();
});

test('finalized failed expiry retries only after a fresh state/simulation and backoff, with bounded same-listing attempts', async () => {
  const f = fixture(); await f.keeper.tick(); finalize(f, 'reverted');
  await f.keeper.tick(); assert.equal(f.row.status, 'retrying'); assert.equal(f.signatures, 1);
  f.advance(60_001); await f.keeper.tick(); assert.equal(f.signatures, 2); finalize(f, 'reverted');
  f.advance(60_001); await f.keeper.tick(); assert.equal(f.row.status, 'review-required'); assert.equal(f.signatures, 2); await f.keeper.close();
});

test('simulation failure and configured Gas bounds stop before any signature', async () => {
  for (const options of [{ simulationFails: true }, { gasPrice: 2_000_000_000n }, { config: { maxGasWei: 1n } }]) {
    const f = fixture(options); await f.keeper.tick(); assert.equal(f.signatures, 0); assert.equal(f.broadcasts, 0); await f.keeper.close();
  }
});

test('a receipt reconciled in this tick is included in the rolling Gas budget before another job', async () => {
  let ready = false;
  const f = fixture({ reconcile: (_scope, journal) => {
    if (ready && journal.transaction) Object.assign(journal.transaction, { phase: 'confirmed', confirmedAt: new Date(1790904988000).toISOString(), gasCostWei: '10000000000000' });
    return journal.transaction && journal.transaction.phase !== 'confirmed' ? { status: 'pending' } : null;
  } });
  await f.keeper.tick(); ready = true; f.state.listedProposalId = 8n; f.config.hourlyGasWei = 15_000_000_000_000n;
  await f.keeper.tick(); assert.equal(f.row.status, 'gas-paused'); assert.equal(f.signatures, 1); await f.keeper.close();
});

test('unresolved jobs are prioritized across round-robin pools without spending another nonce', async () => {
  const f = fixture({ pools: [pool, secondPool] }); await f.keeper.tick(); await f.keeper.tick();
  assert.equal(f.signatures, 1); assert.equal(f.broadcasts, 1); assert.equal(f.row.status, 'pending');
  assert(!f.keeper.snapshot().pools[secondPool]); await f.keeper.close();
});

test('exact action binding rejects swapped target, selector, signer, listing IDs and signed bytes', async () => {
  const f = fixture(); await f.keeper.tick(); const good = structuredClone(f.journal), scope = { factory, pool, expectedGasWallet: f.wallet.address };
  for (const mutate of [j => j.transaction.to = secondPool, j => j.transaction.data = '0xdeadbeef',
    j => j.transaction.from = secondPool, j => j.transaction.expiry.listedProposalId = '0',
    j => j.transaction.attempts[0].hash = blockHash(888)]) {
    const changed = structuredClone(good); mutate(changed); assert.throws(() => assertFirstoExpiryJournal(changed, scope));
  }
  await f.keeper.close();
});

test('chain snapshot uses the registered native pool and exact block timestamp, including expiry equality', async () => {
  const iface = new Interface(['function nativeFirstoSaleVersion() view returns(uint8)', 'function factory() view returns(address)',
    'function state() view returns(uint8)', 'function listedProposalId() view returns(uint256)', 'function expiresAt() view returns(uint64)',
    'function isPool(address) view returns(bool)']);
  let timestamp = 1000, registered = true; const calls = [];
  const provider = { getBlock: async () => ({ number: 9, hash: blockHash(9), timestamp }), call: async request => {
    assert.equal(request.blockTag, 9); const parsed = iface.parseTransaction(request); calls.push(parsed.name);
    const value = { nativeFirstoSaleVersion: 1n, factory, state: 3n, listedProposalId: 7n, expiresAt: 1000n, isPool: registered }[parsed.name];
    return iface.encodeFunctionResult(parsed.name, [value]);
  } };
  assert.equal((await readFirstoListingExpiry(provider, { factory, pool })).eligible, true);
  timestamp = 999; assert.equal((await readFirstoListingExpiry(provider, { factory, pool })).eligible, false);
  registered = false; await assert.rejects(readFirstoListingExpiry(provider, { factory, pool }), /not registered/);
  assert(calls.includes('nativeFirstoSaleVersion')); assert(calls.includes('isPool'));
});

test('expiry configuration is explicitly disabled by default and isolated from administrator/ask journals', () => {
  const dir = mkdtempSync(join(tmpdir(), 'firsto-expiry-config-')); chmodSync(dir, 0o700);
  try {
    const env = { BEMINE_FIRSTO_EXPIRY_ENABLE: '1', BEMINE_FIRSTO_EXPIRY_JOURNAL_DIR: dir,
      BEMINE_FIRSTO_EXPIRY_STATUS_PATH: join(tmpdir(), 'public', 'expiry.json') }, context = { journal: join(dirname(dir), 'authority.json'), expectedGasWallet: address(6) };
    assert.equal(firstoExpiryKeeperConfiguration({}, context), null);
    assert.equal(firstoExpiryKeeperConfiguration(env, context).intervalMs, 10_000);
    assert.throws(() => firstoExpiryKeeperConfiguration({ ...env, BEMINE_FIRSTO_EXPIRY_HOURLY_GAS_BNB: '1' }, context));
    assert.throws(() => firstoExpiryKeeperConfiguration({ ...env, BEMINE_FIRSTO_EXPIRY_STATUS_PATH: join(dir, 'leak.json') }, context));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('expiry task coalesces and its independent timer waits for shutdown without scheduling another transaction', async () => {
  const f = fixture(); const one = f.keeper.tick(), two = f.keeper.tick(); assert.equal(one, two); await one;
  assert.equal(f.signatures, 1); await f.keeper.close();
  let calls = 0, release; const work = new Promise(resolve => release = resolve);
  const stop = trackFirstoListingExpiry({ tick: () => { calls++; return work; } }, { intervalMs: 1, onError: () => assert.fail() });
  await new Promise(resolve => setImmediate(resolve)); const closing = stop(); assert.equal(calls, 1); release(); await closing;
  await new Promise(resolve => setTimeout(resolve, 5)); assert.equal(calls, 1);
});
