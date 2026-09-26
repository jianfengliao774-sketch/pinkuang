import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Interface, ZeroAddress, Wallet, Transaction }  from 'ethers';
import {
  OFFICIAL_COLLECTIONS, OFFICIAL_MARKET, acquireKeeperLock, compareCandidates, fetchCandidates, inspectPoolState,
  parseArguments, readJournal, reconcilePending, runKeeperCycle, selectCandidates, writeJournal,
  KEEPER_POOL_ABI, LISTING_ABI, createKeeperRuntime, gasBudget, startCandidateRefresh, acquireWalletLock, recoverPending, MAX_DISCOVERY_BYTES,
} from './purchase-keeper.mjs';

const factory = '0x1111111111111111111111111111111111111111';
const pool = '0x2222222222222222222222222222222222222222';
const testWallet = Wallet.createRandom(); // Ephemeral local test key; no real account or network.
const from = testWallet.address;
const blockHash = `0x${'bc'.repeat(32)}`;
const finalityProof = { finality: 'bsc-finalized', blockNumber: 49, blockHash, finalizedBlockNumber: 50, finalizedBlockHash: blockHash };
const constraints = { taskId: 42n, circuits: OFFICIAL_COLLECTIONS[0], minVerifiedWeight: 100n, priceCap: 1_000_000n };
const row = (id = '1', price = '1000', weight = '200') => ({
  collection: OFFICIAL_COLLECTIONS[0], tokenId: id, category: 'official_mining',
  mining: { taskId: 42, status: 'verified', verifiedWeight: weight, unverifiedWeight: '0', estimated24hAtomic: '100' },
  bestAsk: { id: `official:${OFFICIAL_MARKET}:${id}`, venue: 'official', status: 'open', priceWei: price, buyerCostWei: '1010' },
});
function temporary(t) {
  const directory = mkdtempSync(join(tmpdir(), 'pinkuang-keeper-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return join(directory, 'journal.json');
}
const options = journal => ({ factory, pool, journal, send: false, pages: 1, sort: 'price', refreshInterval: 30, maxGasWei: 1000n, maxGasPrice: 2n });
const pending = () => ({ version: 1, chainId: 56, factory, pool, gasSpentWei: '0', gasReceipts: {}, transaction: {
  phase: 'intent', from, nonce: 7, data: '0x1234', value: '0', listingId: '1', createdAt: new Date().toISOString(),
} });

test('keeper defaults to read-only 2-second polls and 30-second prewarming, with explicit send plus journal', () => {
  const base = ['--factory', factory, '--pool', pool];
  const config = parseArguments(base);
  assert.equal(config.send, false); assert.equal(config.once, false); assert.equal(config.interval, 2); assert.equal(config.refreshInterval, 30);
  assert.equal(parseArguments([...base, '--once']).once, true);
  assert.throws(() => parseArguments([...base, '--send']), /explicit --journal/);
  assert.equal(parseArguments([...base, '--send', '--journal', '/tmp/specific.json']).send, true);
  assert.throws(() => parseArguments([...base, '--private-key', 'never accepted']), /Unknown/);
  assert.throws(() => parseArguments([...base, '--pages', '1000']), /1–10/);
});
test('NFT discovery requires official collection and verified capacity, without trusting Firsto execution venue', () => {
  const good = row();
  assert.equal(selectCandidates([good], constraints).length, 1);
  for (const changed of [
    { ...good, collection: factory }, { ...good, category: 'other' },
    { ...good, mining: { ...good.mining, status: 'optimal' } },
    { ...good, mining: { ...good.mining, verifiedWeight: '99' } },
    { ...good, mining: { ...good.mining, unverifiedWeight: '1' } },
  ]) assert.equal(selectCandidates([changed], constraints).length, 0);
  for (const venue of ['signed', 'batch', 'official']) assert.equal(selectCandidates([{ ...good, bestAsk: { ...good.bestAsk, venue } }], constraints).length, 1);
  assert.equal(selectCandidates([good, { ...good, bestAsk: { ...good.bestAsk, venue: 'signed' } }], constraints).length, 1, 'same collection+tokenId is deduplicated');
  assert.equal(selectCandidates([{ ...good, bestAsk: { ...good.bestAsk, priceWei: '1000001' } }], constraints).length, 1, 'an expensive Firsto quote does not exclude a cheaper official listing');
});
test('capacity ordering uses exact integer ratios and never treats indexer buyer cost as official price', () => {
  const selected = selectCandidates([row('1', '1000', '100'), row('2', '2000', '400')], constraints, 'capacity');
  assert.equal(selected[0].tokenId, 2n);
  assert.equal(selected[0].priceWei, 2000n); assert.equal(selected[0].indexerBuyerCostWei, 1010n);
  assert.equal(selectCandidates([row('1', '1000', '100'), row('2', '2000', '400')], constraints, 'price')[0].tokenId, 1n);
  assert.equal(compareCandidates({ listingId: 1n, priceWei: 900719925474099301n, verifiedWeight: 1n }, { listingId: 2n, priceWei: 900719925474099300n, verifiedWeight: 1n }, 'price'), 1);
});
test('Funded and pre-deadline gates are mandatory; Active/Listed/Closed and fixed pools stop', () => {
  assert.equal(inspectPoolState(1n, true, 101n, 100n).eligible, true);
  assert.equal(inspectPoolState(1n, true, 100n, 100n).reason, 'purchase-window-expired-finalizeFailure-available');
  assert.equal(inspectPoolState(1n, false, 101n, 100n).eligible, false);
  assert.equal(inspectPoolState(0n, true, 101n, 100n).terminal, false);
  for (const state of [2n, 3n, 4n, 5n]) assert.equal(inspectPoolState(state, true, 101n, 100n).terminal, true);
});
test('public feed uses bounded official_mining pages and retains signed-venue NFTs for official lookup', async () => {
  const calls = [];
  const result = await fetchCandidates({ pages: 3, sort: 'price' }, constraints, async url => {
    calls.push(url);
    return Response.json({ rows: [row(), { ...row('2'), bestAsk: { ...row('2').bestAsk, venue: 'signed' } }], sourceBlock: '123', totalPages: 1 });
  });
  assert.equal(calls.length, 1); assert.equal(calls[0].searchParams.get('category'), 'official_mining');
  assert.equal(calls[0].searchParams.get('pageSize'), '50');
  assert.equal(result.candidates.length, 2); assert.equal(result.nonOfficialBestAsks, 1);
});
test('journal persists intent durably with protected permissions and rejects wrong pool binding', t => {
  const path = temporary(t), journal = pending();
  writeJournal(path, journal);
  assert.deepEqual(readJournal(path, options(path)), journal);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.throws(() => readJournal(path, { ...options(path), pool: factory }), /different chain, factory or pool/);
  assert(!readFileSync(path, 'utf8').includes('PRIVATE_KEY'));
});
test('exclusive lock prevents another process from using the same journal and releases cleanly', t => {
  const path = temporary(t), root = join(path, '..', 'process-locks'), release = acquireKeeperLock(path, root);
  assert.throws(() => acquireKeeperLock(path, root), /already exists/);
  release(); release();
  assert.equal(statSync(root).mode & 0o777, 0o700);
  const next = acquireKeeperLock(path, root); next();
});
test('unknown broadcast blocks all chain reads and all resends until a matching receipt is provided', async t => {
  const path = temporary(t); writeJournal(path, pending());
  let broadcasts = 0;
  const provider = { getNetwork: async () => ({ chainId: 56n }), getBlock: async () => { throw new Error('Must not inspect a new candidate.'); } };
  const result = await runKeeperCycle(provider, options(path), { getAddress: async () => from, sendTransaction: async () => { broadcasts += 1; } });
  assert.equal(result.status, 'unknown-broadcast'); assert.equal(broadcasts, 0);
});
test('receipt recovery checks exact transaction identity and records confirmation without another send', async t => {
  const path = temporary(t), journal = pending(), hash = `0x${'ab'.repeat(32)}`;
  writeJournal(path, journal);
  const transaction = { from, to: pool, nonce: 7, data: '0x1234', value: 0n, chainId: 56n };
  const provider = { getNetwork: async () => ({ chainId: 56n }), getTransaction: async () => transaction,
    getTransactionReceipt: async () => ({ hash, from, to: pool, blockHash, status: 1, blockNumber: 99, fee: 100n }), getBlockNumber: async () => 100, getBlock: async () => ({ hash: blockHash, number: 101 }), getTransactionCount: async () => 7 };
  const result = await reconcilePending(provider, { ...options(path), recoverHash: hash }, journal);
  assert.equal(result.status, 'confirmed'); assert.equal(result.terminal, true);
  assert.equal(readJournal(path, options(path)).transaction.hash, hash);
  const blocked = await runKeeperCycle(provider, options(path));
  assert.equal(blocked.status, 'purchase-transaction-already-confirmed');
  const mismatch = pending(); transaction.nonce = 8;
  await assert.rejects(reconcilePending(provider, { ...options(path), recoverHash: hash }, mismatch), /does not match/);
});
test('failed transaction clears unknown phase only after a real status-0 receipt, never by timeout', async t => {
  const path = temporary(t), journal = pending(), hash = `0x${'cd'.repeat(32)}`;
  journal.transaction.hash = hash; writeJournal(path, journal);
  const provider = { getNetwork: async () => ({ chainId: 56n }), getTransaction: async () => ({ from, to: pool, nonce: 7, data: '0x1234', value: 0n, chainId: 56n }), getTransactionReceipt: async () => null, getBlockNumber: async () => 101, getBlock: async () => ({ hash: blockHash, number: 101 }), getTransactionCount: async () => 7 };
  assert.equal((await reconcilePending(provider, options(path), journal)).status, 'pending-receipt');
  provider.getTransactionReceipt = async () => ({ hash, from, to: pool, blockHash, status: 0, blockNumber: 100, fee: 90n });
  assert.equal((await reconcilePending(provider, options(path), journal)).status, 'reverted');
  assert.equal(readJournal(path, options(path)).transaction.phase, 'reverted');
});

function simulatedChain() {
  const poolAbi = new Interface(KEEPER_POOL_ABI), listingAbi = new Interface(LISTING_ABI);
  const registryAbi = new Interface(['function isPool(address) view returns(bool)']);
  const chain = { state: 0n, block: 50, chainId: 56n, estimates: [], reads: [], sends: [], onEstimate: null,
    listings: new Map([['1', { id: 101n, price: 1000n, valid: true, capacityValid: true }], ['2', { id: 102n, price: 1200n, valid: true, capacityValid: true }]]) };
  const provider = {
    getNetwork: async () => ({ chainId: chain.chainId }),
    getBlock: async tag => {
      if (tag === 'finalized' && chain.finalityUnsupported) throw new Error('unsupported finalized tag');
      return { hash: blockHash, number: tag === 'finalized' ? (chain.finalizedBlock ?? chain.block) : chain.block, timestamp: 1000, gasLimit: 30_000_000n };
    },
    getBlockNumber: async () => chain.block,
    getCode: async address => address.toLowerCase() === from.toLowerCase() ? (chain.signerCode ?? '0x') : '0x6000',
    getFeeData: async () => ({ gasPrice: chain.gasPrice ?? 1n }), getBalance: async () => 100000n,
    getTransactionCount: async (_address, tag) => tag === 'latest' ? (chain.latestNonce ?? 7) : (chain.pendingNonce ?? 7),
    getTransaction: async hash => chain.sends.find(item => item.hash === hash) ?? null,
    getTransactionReceipt: async hash => {
      const receipt = chain.receipts?.get(hash), transaction = chain.sends.find(item => item.hash === hash);
      return receipt ? { hash, from, to: transaction?.to ?? pool, ...receipt } : null;
    },
    broadcastTransaction: async raw => {
      const transaction = Transaction.from(raw);
      if (chain.beforeBroadcast) chain.beforeBroadcast(raw);
      chain.sends.push(transaction);
      if (chain.broadcastError) throw new Error('RPC timed out');
      return { hash: transaction.hash };
    },
    call: async transaction => {
      const target = transaction.to.toLowerCase();
      const abi = target === pool.toLowerCase() ? poolAbi : target === factory.toLowerCase() ? registryAbi : listingAbi;
      const decoded = abi.parseTransaction({ data: transaction.data });
      const name = decoded.name; chain.reads.push(name);
      let result;
      if (name === 'isPool') result = [true];
      else if (name === 'factory' || name === 'OFFICIAL_FACTORY') result = [factory];
      else if (name === 'state') result = [chain.state];
      else if (name === 'params') result = [[OFFICIAL_COLLECTIONS[0], 1n, 1_000_000n, 1_000_000n, ZeroAddress, 0n, 1500n, 2000n]];
      else if (name === 'purchaseReferenceWeight') result = [chain.referenceWeight ?? 200n];
      else if (name === 'purchaseModel') result = [chain.modelInitialized !== false, 42n];
      else if (name === 'flexiblePurchase') result = [true, 1n, [100n, 1000n, 100n, 1000n, 900n, 40n, `0x${'ab'.repeat(32)}`]];
      else if (name === 'listingFor') {
        const listing = chain.listings.get(decoded.args[1].toString());
        result = listing?.valid ? [listing.id, from, listing.price, true] : [0n, ZeroAddress, 0n, false];
      } else if (name === 'listingView') {
        const item = [...chain.listings].find(([_token, listing]) => listing.id === decoded.args[0]);
        result = item ? [from, OFFICIAL_COLLECTIONS[0], BigInt(item[0]), item[1].price, 100n, item[1].valid] : [ZeroAddress, ZeroAddress, 0n, 0n, 0n, false];
      } else throw new Error(`Unexpected read: ${name}`);
      return abi.encodeFunctionResult(name, result);
    },
    estimateGas: async transaction => {
      if (transaction.data === '0x' && transaction.to === from && transaction.value === 0n) return 21000n;
      const id = poolAbi.parseTransaction({ data: transaction.data }).args[0]; chain.estimates.push(id);
      if (chain.onEstimate) chain.onEstimate(id);
      const listing = [...chain.listings.values()].find(item => item.id === id);
      if (chain.state !== 1n || !listing?.valid || !listing.capacityValid || listing.price > constraints.priceCap) throw new Error('Atomic purchase constraints failed.');
      return 100n;
    },
  };
  const signer = { provider, getAddress: async () => from, call: provider.call, estimateGas: provider.estimateGas,
    signTransaction: transaction => testWallet.signTransaction(transaction) };
  return { chain, provider, signer };
}

function feed(rows = [row('1'), row('2', '1200')]) {
  return async () => Response.json({ rows, sourceBlock: '45', totalPages: 1 });
}

async function prewarm(t, customRows) {
  const path = temporary(t), runtime = createKeeperRuntime(), simulated = simulatedChain();
  const result = await runKeeperCycle(simulated.provider, options(path), null, feed(customRows), runtime);
  assert.equal(result.status, 'funding-prewarming');
  await runtime.refreshTask;
  assert.equal(runtime.queue.length, 2);
  return { path, runtime, ...simulated };
}

test('Funding prewarms official listings including signed bestAsk; Funded fast path does not await or refetch API', async t => {
  const signed = { ...row('1'), bestAsk: { ...row('1').bestAsk, venue: 'signed', id: '0xsigned-order-hash', priceWei: '2000000' } };
  const { path, runtime, chain, provider, signer } = await prewarm(t, [signed, row('2', '1200')]);
  assert.equal(runtime.queue[0].listingId, 101n, 'official lookup replaces the more expensive Firsto signed quote');
  assert.equal(runtime.queue[0].discoveryVenue, 'signed');
  chain.state = 1n;
  let apiCalls = 0;
  const result = await runKeeperCycle(provider, { ...options(path), send: true }, signer, async () => { apiCalls += 1; throw new Error('Must not wait for API at funding completion.'); }, runtime);
  assert.equal(result.status, 'broadcast'); assert.equal(apiCalls, 0);
  assert.equal(result.officialPriceWei, 1000n); assert.equal(result.officialListingSource, 'CircuitMarket.listingFor');
  assert.deepEqual(chain.estimates, [101n], 'first executable candidate sends without simulating all 30 candidates');
  assert.equal(chain.sends.length, 1); assert.equal(chain.sends[0].value, 0n);
  assert.equal(readJournal(path, options(path)).transaction.phase, 'broadcast');
});

test('a target sold during final simulation is skipped and the next prepared candidate is attempted immediately', async t => {
  const { path, runtime, chain, provider } = await prewarm(t);
  chain.state = 1n;
  chain.onEstimate = id => { if (id === 101n) chain.listings.get('1').valid = false; };
  const result = await runKeeperCycle(provider, options(path), null, async () => { throw new Error('No rescan expected.'); }, runtime);
  assert.equal(result.status, 'dry-run-ready'); assert.equal(result.listingId, 102n);
  assert.deepEqual(chain.estimates, [101n, 102n]); assert.equal(chain.sends.length, 0);
  assert.equal(result.skipped[0].reason, 'purchase-simulation-reverted-or-listing-changed');
});

test('background API failure retains hints but never substitutes cached capacity or listing checks for current chain simulation', async t => {
  const { path, runtime, chain, provider } = await prewarm(t);
  await startCandidateRefresh(provider, options(path), runtime.constraints, runtime, async () => { throw new Error('API unavailable'); });
  assert.equal(runtime.queue.length, 2); assert.match(runtime.refreshError, /API unavailable/);
  chain.state = 1n;
  chain.listings.get('1').capacityValid = false;
  chain.listings.get('2').valid = false;
  const result = await runKeeperCycle(provider, options(path), null, feed(), runtime);
  assert.equal(result.status, 'no-executable-official-candidate-in-prepared-queue');
  assert.deepEqual(chain.estimates, [101n], 'fresh atomic simulation rejected capacity even though cached indexer weight was valid');
  assert.equal(chain.sends.length, 0);
  assert(result.skipped.some(item => item.reason === 'official-listing-sold-or-outside-constraints'));
});

test('an unknown intent blocks a fully prewarmed Funded queue without checking API or attempting another signature', async t => {
  const { path, runtime, chain, provider, signer } = await prewarm(t);
  chain.state = 1n; writeJournal(path, pending());
  const reads = chain.reads.length;
  const result = await runKeeperCycle(provider, { ...options(path), send: true }, signer, async () => { throw new Error('No API read permitted.'); }, runtime);
  assert.equal(result.status, 'unknown-broadcast'); assert.equal(chain.reads.length, reads);
  assert.equal(chain.sends.length, 0); assert.equal(chain.estimates.length, 0);
});

test('a single confirmation keeps the purchase pending; gas receipt is counted exactly once after two confirmations', async t => {
  const path = temporary(t), journal = pending(), hash = `0x${'de'.repeat(32)}`;
  journal.transaction.hash = hash; writeJournal(path, journal);
  let head = 100;
  const provider = { getNetwork: async () => ({ chainId: 56n }), getTransaction: async () => ({ from, to: pool, nonce: 7, data: '0x1234', value: 0n, chainId: 56n }),
    getTransactionReceipt: async () => ({ hash, from, to: pool, blockHash, status: 0, blockNumber: 100, fee: 60n }), getBlockNumber: async () => head, getBlock: async () => ({ hash: blockHash, number: 101 }), getTransactionCount: async () => 7 };
  assert.equal((await reconcilePending(provider, options(path), journal)).status, 'pending-confirmations');
  assert.equal(journal.transaction.phase, 'intent'); assert.equal(journal.gasSpentWei, '0');
  head = 101;
  assert.equal((await reconcilePending(provider, options(path), journal)).status, 'reverted');
  assert.equal(journal.gasSpentWei, '60'); assert.equal(journal.gasReceipts[hash], '60');
  assert.equal(await reconcilePending(provider, options(path), journal), null);
  journal.transaction.phase = 'broadcast'; // Replay an already-accounted receipt during recovery.
  await reconcilePending(provider, options(path), journal);
  assert.equal(journal.gasSpentWei, '60');
  assert.equal(readJournal(path, options(path)).gasSpentWei, '60');
});

test('failed-transaction gas counts against the total keeper budget before another candidate can broadcast', async t => {
  const { path, runtime, chain, provider, signer } = await prewarm(t);
  const journal = pending(), hash = `0x${'dc'.repeat(32)}`;
  journal.transaction = { ...journal.transaction, hash, phase: 'reverted', gasCostWei: '90', ...finalityProof };
  journal.gasSpentWei = '90'; journal.gasReceipts = { [hash]: '90' }; writeJournal(path, journal);
  chain.state = 1n;
  assert.equal(gasBudget(journal, 120n, 1n, 200n).allowed, false);
  assert.equal(gasBudget(journal, 110n, 1n, 200n).allowed, true);
  const result = await runKeeperCycle(provider, { ...options(path), send: true, maxGasWei: 200n }, signer, feed(), runtime);
  assert.equal(result.status, 'total-gas-budget-exceeded'); assert.equal(result.spentGasWei, 90n);
  assert.equal(result.maximumNextGasWei, 120n); assert.equal(chain.sends.length, 0);
  assert.equal(readJournal(path, options(path)).transaction.phase, 'reverted');
});

test('known reference target remains immediately executable while the prewarm API request is hanging', async t => {
  const path = temporary(t), runtime = createKeeperRuntime(), { chain, provider } = simulatedChain();
  let finishFetch, apiCalls = 0;
  const hangingApi = async () => { apiCalls += 1; return new Promise(resolve => { finishFetch = resolve; }); };
  const funding = await runKeeperCycle(provider, options(path), null, hangingApi, runtime);
  assert.equal(funding.status, 'funding-prewarming'); assert.equal(apiCalls, 1);
  assert.equal(runtime.queue[0].tokenId, 1n); assert.equal(runtime.queue[0].discoverySource, 'pool-reference');
  assert(runtime.refreshTask, 'background discovery remains unresolved');
  chain.state = 1n;
  const result = await runKeeperCycle(provider, options(path), null, hangingApi, runtime);
  assert.equal(result.status, 'dry-run-ready'); assert.equal(result.listingId, 101n);
  assert.equal(result.discoverySource, 'pool-reference'); assert.equal(result.indexerVerifiedWeight, null);
  assert.equal(apiCalls, 1); assert.deepEqual(chain.estimates, [101n]);
  finishFetch(Response.json({ rows: [], sourceBlock: '50', totalPages: 1 }));
  await runtime.refreshTask;
});

test('cold-start Funded pool resolves the reference through listingFor before making any API request', async t => {
  const path = temporary(t), { chain, provider } = simulatedChain(); chain.state = 1n;
  let apiCalls = 0;
  const result = await runKeeperCycle(provider, { ...options(path), once: true }, null, async () => { apiCalls += 1; throw new Error('Indexer unavailable'); });
  assert.equal(result.status, 'dry-run-ready'); assert.equal(result.listingId, 101n);
  assert.equal(apiCalls, 0); assert.equal(result.isReference, true);
});

test('recovery including cancellation is explicit, one-shot and bounded', () => {
  const base = ['--factory', factory, '--pool', pool, '--journal', '/tmp/recovery.json'];
  assert.throws(() => parseArguments([...base, '--speed-up']), /explicit --send --once/);
  assert.throws(() => parseArguments([...base, '--send', '--speed-up']), /explicit --send --once/);
  const config = parseArguments([...base, '--send', '--once', '--speed-up']);
  assert.equal(config.speedUp, true); assert.equal(config.maxSpeedUps, 3); assert.equal(config.pendingSeconds, 120);
  assert.throws(() => parseArguments([...base, '--send', '--once', '--speed-up', '--rebroadcast']), /not both/);
  assert.throws(() => parseArguments([...base, '--max-speed-ups', '6']), /0–5/);
  assert.throws(() => parseArguments([...base, '--cancel-pending']), /explicit --send --once/);
  assert.equal(parseArguments([...base, '--send', '--once', '--cancel-pending']).cancelPending, true);
});

test('wallet lock serializes different pool journals and keeps unresolved nonce ownership after process exit', t => {
  const firstPath = temporary(t), otherPath = join(firstPath, '..', 'other-pool.json'), root = join(firstPath, '..', 'wallet-locks');
  writeJournal(firstPath, readJournal(firstPath, options(firstPath)));
  writeJournal(otherPath, { ...readJournal(firstPath, options(firstPath)), pool: factory });
  const release = acquireWalletLock(from, firstPath, root);
  assert.throws(() => acquireWalletLock(from, otherPath, root), /already exists/);
  writeJournal(firstPath, pending()); release();
  assert.throws(() => acquireWalletLock(from, otherPath, root), /unresolved transaction in another pool/);
  const old = pending(); old.transaction = { ...old.transaction, phase: 'reverted', ...finalityProof }; writeJournal(firstPath, old);
  const releaseOther = acquireWalletLock(from, otherPath, root); releaseOther();
});

async function signedPurchase(t, configure = () => {}) {
  const path = temporary(t), runtime = createKeeperRuntime(), simulated = simulatedChain();
  simulated.chain.state = 1n;
  configure(simulated, path);
  const config = { ...options(path), send: true };
  const result = await runKeeperCycle(simulated.provider, config, simulated.signer, feed(), runtime);
  return { path, runtime, config, result, ...simulated };
}

test('signed bytes and deterministic hash are durable before broadcast; RPC timeout cannot lose identity', async t => {
  const item = await signedPurchase(t, ({ chain }, path) => {
    chain.broadcastError = true;
    chain.beforeBroadcast = raw => {
      const saved = readJournal(path, options(path)), decoded = Transaction.from(raw);
      assert.equal(saved.transaction.hash, decoded.hash); assert.equal(saved.transaction.attempts[0].raw, raw);
      assert.equal(saved.transaction.phase, 'signed'); assert.equal(statSync(path).mode & 0o777, 0o600);
    };
  });
  assert.equal(item.result.status, 'broadcast-result-unknown');
  assert.equal(item.result.hash, item.chain.sends[0].hash);
  assert(!JSON.stringify(item.result, (_key, value) => typeof value === 'bigint' ? String(value) : value).includes(item.chain.sends[0].serialized));
  const diagnostic = await runKeeperCycle(item.provider, item.config, item.signer, feed(), item.runtime);
  assert.equal(diagnostic.status, 'pending-receipt'); assert.equal(item.chain.sends.length, 1);
});

test('explicit rebroadcast uses exactly the same signed bytes, hash and nonce without another signature', async t => {
  const item = await signedPurchase(t, ({ chain }) => { chain.broadcastError = true; });
  item.chain.broadcastError = false;
  item.signer.signTransaction = () => { throw new Error('Must reuse existing signature'); };
  const result = await runKeeperCycle(item.provider, { ...item.config, once: true, rebroadcast: true }, item.signer);
  assert.equal(result.status, 'broadcast'); assert.equal(item.chain.sends.length, 2);
  assert.equal(item.chain.sends[0].serialized, item.chain.sends[1].serialized);
  assert.equal(item.chain.sends[0].hash, item.chain.sends[1].hash);
  assert.equal(readJournal(item.path, item.config).transaction.speedUps, 0);
});

test('explicit speed-up signs only identical purchase payload and nonce; count, price and cumulative budget remain bounded', async t => {
  const item = await signedPurchase(t);
  const original = item.chain.sends[0];
  const config = { ...item.config, once: true, speedUp: true, maxSpeedUps: 1 };
  assert.equal((await runKeeperCycle(item.provider, config, item.signer)).status, 'broadcast');
  const replacement = item.chain.sends[1];
  assert.equal(replacement.nonce, original.nonce); assert.equal(replacement.to, original.to);
  assert.equal(replacement.data, original.data); assert.equal(replacement.value, 0n); assert.equal(replacement.chainId, 56n);
  assert.equal(replacement.gasPrice, 2n); assert.notEqual(replacement.hash, original.hash);
  assert.equal((await runKeeperCycle(item.provider, config, item.signer)).status, 'speed-up-limit-reached');
  assert.equal(item.chain.sends.length, 2);
  assert.equal((await runKeeperCycle(item.provider, { ...config, maxSpeedUps: 3, maxGasPrice: 2n }, item.signer)).status, 'recovery-gas-budget-exceeded');
  assert.equal((await runKeeperCycle(item.provider, { ...config, maxSpeedUps: 3, maxGasPrice: 10n, maxGasWei: 300n }, item.signer)).status, 'recovery-gas-budget-exceeded');
  assert.equal(item.chain.sends.length, 2);
});

test('all same-nonce hashes remain tracked and original purchase can confirm after a replacement broadcast', async t => {
  const item = await signedPurchase(t);
  await runKeeperCycle(item.provider, { ...item.config, once: true, speedUp: true }, item.signer);
  const originalHash = item.chain.sends[0].hash, replacementHash = item.chain.sends[1].hash;
  item.chain.receipts = new Map([[originalHash, { status: 1, blockNumber: 49, blockHash, fee: 60n }]]);
  const result = await runKeeperCycle(item.provider, item.config, item.signer);
  assert.equal(result.status, 'confirmed'); assert.equal(result.hash, originalHash);
  const journal = readJournal(item.path, item.config);
  assert.deepEqual(journal.transaction.attempts.map(attempt => attempt.hash), [originalHash, replacementHash]);
  assert.equal(journal.gasSpentWei, '60'); assert.equal(Object.keys(journal.gasReceipts).length, 1);
  await runKeeperCycle(item.provider, item.config, item.signer);
  assert.equal(item.chain.sends.length, 2); assert.equal(readJournal(item.path, item.config).gasSpentWei, '60');
});

test('orphaned receipt never confirms, spends no accounted gas and cannot trigger a fee replacement', async t => {
  const item = await signedPurchase(t);
  item.chain.receipts = new Map([[item.result.hash, { status: 1, blockNumber: 49, blockHash: `0x${'dd'.repeat(32)}`, fee: 60n }]]);
  const result = await runKeeperCycle(item.provider, { ...item.config, once: true, speedUp: true }, item.signer);
  assert.equal(result.status, 'receipt-not-canonical');
  assert.equal(item.chain.sends.length, 1); assert.equal(readJournal(item.path, item.config).gasSpentWei, '0');
  assert.equal(readJournal(item.path, item.config).transaction.phase, 'broadcast');
});

test('nonce consumed by an unknown transaction stops instead of signing another purchase', async t => {
  const item = await signedPurchase(t);
  item.chain.latestNonce = 8; item.chain.pendingNonce = 8;
  const result = await runKeeperCycle(item.provider, { ...item.config, once: true, speedUp: true }, item.signer);
  assert.equal(result.status, 'unknown-wallet-nonce-manual-review'); assert.equal(result.terminal, true);
  assert.equal(item.chain.sends.length, 1); assert.equal(readJournal(item.path, item.config).transaction.phase, 'broadcast');
});

test('missing RPC transaction plus advanced pending nonce never authorizes overwriting an unknown replacement', async t => {
  const item = await signedPurchase(t);
  item.provider.getTransaction = async () => null; item.chain.pendingNonce = 8;
  const result = await runKeeperCycle(item.provider, { ...item.config, once: true, rebroadcast: true }, item.signer);
  assert.equal(result.status, 'unknown-pending-replacement-manual-review'); assert.equal(result.terminal, true);
  assert.equal(item.chain.sends.length, 1);
});

test('pending diagnostics become overdue without timing out the purchase or automatically increasing fees', async t => {
  const item = await signedPurchase(t);
  const journal = readJournal(item.path, item.config); journal.transaction.createdAt = new Date(Date.now() - 300_000).toISOString(); writeJournal(item.path, journal);
  item.provider.getTransaction = async () => null;
  const result = await runKeeperCycle(item.provider, item.config, item.signer);
  assert.equal(result.status, 'pending-not-indexed'); assert.equal(result.overdue, true); assert(result.pendingSeconds >= 300);
  assert.equal(item.chain.sends.length, 1); assert.equal(result.recoveryAllowed, true);
});

test('broadcast boundary rejects chain or nonce races even after local signing', async t => {
  for (const race of ['chain', 'nonce']) {
    const item = await signedPurchase(t, ({ chain, signer }) => {
      signer.signTransaction = async transaction => {
        const raw = await testWallet.signTransaction(transaction);
        if (race === 'chain') chain.chainId = 1n;
        else { chain.latestNonce = 8; chain.pendingNonce = 8; }
        return raw;
      };
    });
    assert.match(item.result.status, /before-broadcast/); assert.equal(item.result.terminal, true);
    assert.equal(item.chain.sends.length, 0); assert.equal(readJournal(item.path, item.config).transaction.phase, 'signed');
  }
});

test('journal recovery rejects changed signer and tampered signed identity', async t => {
  const item = await signedPurchase(t);
  await assert.rejects(runKeeperCycle(item.provider, item.config, { ...item.signer, getAddress: async () => factory }), /different keeper wallet/);
  const journal = readJournal(item.path, item.config); journal.transaction.data = '0x1234'; writeJournal(item.path, journal);
  assert.throws(() => readJournal(item.path, item.config), /does not match/);
  assert.equal(item.chain.sends.length, 1);
});

test('speed-up refuses a sold original target and never substitutes the available second target', async t => {
  const item = await signedPurchase(t);
  item.chain.listings.get('1').valid = false;
  const result = await runKeeperCycle(item.provider, { ...item.config, once: true, speedUp: true }, item.signer);
  assert.equal(result.status, 'speed-up-purchase-no-longer-executable');
  assert.equal(item.chain.sends.length, 1); assert.deepEqual(item.chain.estimates, [101n, 101n]);
});

test('flexible pool without locked on-chain purchase model is rejected before signing', async t => {
  const path = temporary(t), { chain, provider, signer } = simulatedChain(); chain.state = 1n; chain.modelInitialized = false;
  await assert.rejects(runKeeperCycle(provider, { ...options(path), send: true }, signer), /immutable on-chain purchase model/);
  assert.equal(chain.sends.length, 0); assert.equal(chain.estimates.length, 0);
});

test('explicit cancel replaces only the same nonce with an estimated empty EOA self-transfer and stops after finalization', async t => {
  const item = await signedPurchase(t);
  item.chain.listings.get('1').valid = false; // Cancellation never needs the old machine to remain purchasable.
  const config = { ...item.config, once: true, cancelPending: true, maxGasWei: 1000000n };
  const broadcast = await runKeeperCycle(item.provider, config, item.signer);
  assert.equal(broadcast.status, 'broadcast'); assert.equal(item.chain.sends.length, 2);
  const original = item.chain.sends[0], cancel = item.chain.sends[1];
  assert.equal(cancel.nonce, original.nonce); assert.equal(cancel.to, from); assert.equal(cancel.data, '0x'); assert.equal(cancel.value, 0n);
  assert.equal(cancel.gasLimit, 25200n); assert.equal(cancel.gasPrice, 2n);
  item.chain.receipts = new Map([[cancel.hash, { status: 1, blockNumber: 49, blockHash, fee: 42000n }]]);
  const result = await runKeeperCycle(item.provider, config, item.signer);
  assert.equal(result.status, 'cancelled'); assert.equal(result.transactionKind, 'cancel'); assert.equal(result.terminal, true);
  assert.equal(result.finality, 'bsc-finalized'); assert.equal(readJournal(item.path, config).gasSpentWei, '42000');
  assert.equal((await runKeeperCycle(item.provider, item.config, item.signer)).status, 'purchase-nonce-cancelled');
  assert.equal(item.chain.sends.length, 2);
});

test('original purchase winning a cancellation race is recorded as a purchase, never a cancellation', async t => {
  const item = await signedPurchase(t);
  const config = { ...item.config, once: true, cancelPending: true, maxGasWei: 1000000n };
  await runKeeperCycle(item.provider, config, item.signer);
  const original = item.chain.sends[0];
  item.chain.receipts = new Map([[original.hash, { status: 1, blockNumber: 49, blockHash, fee: 60n }]]);
  const result = await runKeeperCycle(item.provider, config, item.signer);
  assert.equal(result.status, 'confirmed'); assert.equal(result.transactionKind, 'purchase'); assert.equal(result.hash, original.hash);
  assert.equal(readJournal(item.path, config).gasSpentWei, '60'); assert.equal(item.chain.sends.length, 2);
});

test('cancellation obeys gas budget, price and attempt limits; accounts with code require wallet handling', async t => {
  const item = await signedPurchase(t);
  const config = { ...item.config, once: true, cancelPending: true };
  assert.equal((await runKeeperCycle(item.provider, config, item.signer)).status, 'recovery-gas-budget-exceeded');
  assert.equal((await runKeeperCycle(item.provider, { ...config, maxGasWei: 1000000n, maxGasPrice: 1n }, item.signer)).status, 'recovery-gas-budget-exceeded');
  assert.equal((await runKeeperCycle(item.provider, { ...config, maxSpeedUps: 0 }, item.signer)).status, 'speed-up-limit-reached');
  item.chain.signerCode = '0xef01000000000000000000000000000000000000000000';
  assert.equal((await runKeeperCycle(item.provider, { ...config, maxGasWei: 1000000n }, item.signer)).status, 'keeper-account-has-code-use-wallet-to-cancel');
  assert.equal(item.chain.sends.length, 1);
});

test('failed cancellation is accounted as reverted and cannot cause an automatic next purchase', async t => {
  const item = await signedPurchase(t);
  const config = { ...item.config, once: true, cancelPending: true, maxGasWei: 1000000n };
  await runKeeperCycle(item.provider, config, item.signer);
  const cancel = item.chain.sends[1];
  item.chain.receipts = new Map([[cancel.hash, { status: 0, blockNumber: 49, blockHash, fee: 42000n }]]);
  const result = await runKeeperCycle(item.provider, config, item.signer);
  assert.equal(result.status, 'cancel-reverted'); assert.equal(result.terminal, true);
  assert.equal(readJournal(item.path, config).gasSpentWei, '42000');
  assert.equal((await runKeeperCycle(item.provider, item.config, item.signer)).status, 'cancellation-flow-reverted');
  assert.equal(item.chain.sends.length, 2);
});

test('unknown consumed nonce blocks cancellation too; signed cancellation cannot become a new purchase speed-up', async t => {
  const item = await signedPurchase(t);
  const config = { ...item.config, once: true, cancelPending: true, maxGasWei: 1000000n };
  item.chain.latestNonce = 8; item.chain.pendingNonce = 8;
  assert.equal((await runKeeperCycle(item.provider, config, item.signer)).status, 'unknown-wallet-nonce-manual-review');
  assert.equal(item.chain.sends.length, 1);
  item.chain.latestNonce = 7; item.chain.pendingNonce = 7;
  await runKeeperCycle(item.provider, config, item.signer);
  const result = await runKeeperCycle(item.provider, { ...item.config, once: true, speedUp: true, maxGasWei: 1000000n }, item.signer);
  assert.equal(result.status, 'cancellation-already-signed-use-cancel-pending-or-rebroadcast'); assert.equal(item.chain.sends.length, 2);
});

test('receipt hash, sender and target must each match the recorded signed attempt', async t => {
  const item = await signedPurchase(t);
  for (const wrong of [{ hash: `0x${'ab'.repeat(32)}` }, { from: factory }, { to: factory }]) {
    item.chain.receipts = new Map([[item.result.hash, { status: 1, blockNumber: 49, blockHash, fee: 60n, ...wrong }]]);
    await assert.rejects(runKeeperCycle(item.provider, item.config, item.signer), /Receipt identity/);
  }
  assert.equal(readJournal(item.path, item.config).gasSpentWei, '0');
});

test('two canonical confirmations stay pending until finalized and an unsupported finality RPC fails closed', async t => {
  const item = await signedPurchase(t);
  item.chain.receipts = new Map([[item.result.hash, { status: 1, blockNumber: 49, blockHash, fee: 60n }]]);
  item.chain.finalizedBlock = 48;
  let result = await runKeeperCycle(item.provider, { ...item.config, once: true, speedUp: true }, item.signer);
  assert.equal(result.status, 'pending-finality'); assert.equal(result.confirmations, 2);
  assert.equal(readJournal(item.path, item.config).gasSpentWei, '0');
  item.chain.finalityUnsupported = true;
  result = await runKeeperCycle(item.provider, item.config, item.signer);
  assert.equal(result.status, 'pending-finality-rpc-unavailable'); assert.equal(result.terminal, false);
  assert.equal(readJournal(item.path, item.config).transaction.phase, 'broadcast'); assert.equal(item.chain.sends.length, 1);
  item.chain.finalityUnsupported = false; item.chain.finalizedBlock = 49;
  assert.equal((await runKeeperCycle(item.provider, item.config, item.signer)).status, 'confirmed');
});

test('persistent wallet ledger directory and pointer stay private', t => {
  const path = temporary(t), root = join(path, '..', 'persistent-wallets');
  writeJournal(path, readJournal(path, options(path)));
  const release = acquireWalletLock(from, path, root);
  assert.equal(statSync(root).mode & 0o777, 0o700);
  assert.equal(statSync(join(root, `56-${from.toLowerCase()}.json`)).mode & 0o777, 0o600);
  release();
});

test('lower-cost cancellation cannot erase maximum gas exposure from an already signed purchase', async t => {
  const path = temporary(t), { chain, provider, signer } = simulatedChain(); chain.state = 1n;
  provider.getBalance = async () => 1000000n;
  const baseEstimate = provider.estimateGas;
  provider.estimateGas = async transaction => transaction.data === '0x' ? baseEstimate(transaction) : 100000n;
  signer.estimateGas = provider.estimateGas;
  const config = { ...options(path), send: true, maxGasWei: 1000000n };
  assert.equal((await runKeeperCycle(provider, config, signer)).status, 'broadcast');
  const original = chain.sends[0]; assert.equal(original.gasLimit * original.gasPrice, 120000n);
  const journal = readJournal(path, config), budget = gasBudget(journal, 25200n, 2n, 100000n);
  assert.equal(budget.maximumNextFee, 50400n); assert.equal(budget.maximumPendingFee, 120000n);
  assert.equal(budget.reservedFee, 120000n); assert.equal(budget.allowed, false);
  const result = await runKeeperCycle(provider, { ...config, once: true, cancelPending: true, maxGasWei: 100000n }, signer);
  assert.equal(result.status, 'recovery-gas-budget-exceeded'); assert.equal(chain.sends.length, 1);
});

test('legacy two-confirmation terminal journal cannot release its wallet or authorize another purchase', t => {
  const path = temporary(t), root = join(path, '..', 'wallets'), second = join(path, '..', 'other.json');
  const old = pending(); old.transaction.phase = 'confirmed'; old.transaction.blockNumber = 49; old.transaction.blockHash = blockHash;
  writeJournal(path, old); writeJournal(second, readJournal(second, options(second)));
  assert.throws(() => readJournal(path, options(path)), /no BSC finalized proof/);
  const release = acquireWalletLock(from, path, root); release();
  assert.throws(() => acquireWalletLock(from, second, root), /no BSC finalized proof/);
});

test('candidate discovery rejects wrong or missing model task IDs even at identical weight and price', () => {
  const good = row(), wrong = { ...row('2'), mining: { ...good.mining, taskId: 43 } };
  const missing = { ...row('3'), mining: { ...good.mining } }; delete missing.mining.taskId;
  assert.deepEqual(selectCandidates([wrong, missing, good], constraints).map(candidate => candidate.tokenId), [1n]);
  assert.equal(selectCandidates([{ ...good, mining: { ...good.mining, taskId: '42' } }], constraints).length, 1);
  assert.equal(selectCandidates([{ ...good, mining: { ...good.mining, taskId: 42.5 } }], constraints).length, 0);
});

test('Firsto discovery stops oversized streamed bodies without trusting a missing content-length', async () => {
  let cancelled = false, sent = 0;
  const response = new Response(new ReadableStream({
    pull(controller) {
      sent += 1;
      controller.enqueue(new Uint8Array(MAX_DISCOVERY_BYTES / 2 + 1));
    },
    cancel() { cancelled = true; },
  }), { headers: { 'content-type': 'application/json' } });
  await assert.rejects(fetchCandidates({ pages: 1, sort: 'price' }, constraints, async () => response), /2 MiB total body limit/);
  assert.equal(cancelled, true); assert(sent <= 3, 'bounded reads stop the stream early');
});

test('Firsto discovery rejects oversized declared bodies and excessive rows per page', async () => {
  const oversized = new Response('{}', { headers: { 'content-type': 'application/json', 'content-length': String(MAX_DISCOVERY_BYTES + 1) } });
  await assert.rejects(fetchCandidates({ pages: 1, sort: 'price' }, constraints, async () => oversized), /2 MiB total body limit/);
  await assert.rejects(fetchCandidates({ pages: 1, sort: 'price' }, constraints, async () => Response.json({ rows: Array.from({ length: 51 }, (_, index) => row(String(index))) })), /50-row page limit/);
});

test('the 2 MiB discovery byte budget applies across all fetched pages', async () => {
  let requests = 0;
  await assert.rejects(fetchCandidates({ pages: 3, sort: 'price' }, constraints, async () => {
    requests += 1;
    return Response.json({ rows: Array.from({ length: 50 }, (_, index) => row(String(index))), padding: 'x'.repeat(MAX_DISCOVERY_BYTES / 2), totalPages: 3 });
  }), /2 MiB total body limit/);
  assert.equal(requests, 2);
});

test('Firsto discovery requires JSON content-type and forbids redirects', async () => {
  await assert.rejects(fetchCandidates({ pages: 1, sort: 'price' }, constraints, async () => new Response('{"rows":[]}', { headers: { 'content-type': 'text/html' } })), /JSON content type/);
  const redirected = Response.json({ rows: [] }); Object.defineProperty(redirected, 'redirected', { value: true });
  await assert.rejects(fetchCandidates({ pages: 1, sort: 'price' }, constraints, async (_url, init) => {
    assert.equal(init.redirect, 'error'); return redirected;
  }), /redirects are not permitted/);
});

test('abort covers a stalled streamed body and cancels its reader instead of hanging the refresh', { timeout: 1000 }, async () => {
  const controller = new AbortController(); let cancelled = false, startedReading = false;
  const response = new Response(new ReadableStream({
    pull() { startedReading = true; setImmediate(() => controller.abort()); },
    cancel() { cancelled = true; return new Promise(() => {}); }, // Cancellation itself must not extend the deadline.
  }), { headers: { 'content-type': 'application/json' } });
  await assert.rejects(fetchCandidates({ pages: 1, sort: 'price', signal: controller.signal }, constraints, async () => response), /timed out or was aborted/);
  assert.equal(startedReading, true); assert.equal(cancelled, true);
});

test('pre-aborted discovery sends no request and abort also bounds a fetcher stalled before headers', { timeout: 1000 }, async () => {
  const prior = new AbortController(); prior.abort(); let requests = 0;
  await assert.rejects(fetchCandidates({ pages: 1, sort: 'price', signal: prior.signal }, constraints, async () => { requests += 1; return Response.json({ rows: [] }); }), /aborted/);
  assert.equal(requests, 0);
  const active = new AbortController();
  await assert.rejects(fetchCandidates({ pages: 1, sort: 'price', signal: active.signal }, constraints, async () => {
    setImmediate(() => active.abort()); return new Promise(() => {});
  }), /aborted/);
});


test('sending requires HTTPS RPC except explicit loopback test URLs', () => {
  const base = ['--factory', factory, '--pool', pool, '--send', '--once', '--journal', '/private/journal.json'];
  for (const rpc of ['http://bsc.example', 'http://192.168.1.10:8545', 'http://localhost.evil.example', 'http://8.8.8.8']) {
    assert.throws(() => parseArguments([...base, '--rpc', rpc]), /requires HTTPS RPC/);
  }
  for (const rpc of ['https://bsc.example', 'http://127.0.0.1:8545', 'http://localhost:8545', 'http://[::1]:8545']) {
    assert.equal(parseArguments([...base, '--rpc', rpc]).rpc, rpc);
  }
  assert.equal(parseArguments(['--factory', factory, '--pool', pool, '--rpc', 'http://read-only.example']).send, false);
});


test('legacy flexible pools with zero locked reference weight stop before candidate simulation', async t => {
  const path = temporary(t), { chain, provider, signer } = simulatedChain(); chain.state = 1n; chain.referenceWeight = 0n;
  await assert.rejects(runKeeperCycle(provider, { ...options(path), send: true }, signer), /no immutable reference weight/);
  assert.equal(chain.sends.length, 0); assert.equal(chain.estimates.length, 0);
});


test('resuming the same missing journal cannot overwrite persistent wallet ownership with an empty ledger', t => {
  const path = temporary(t), root = join(path, '..', 'wallets'); writeJournal(path, pending());
  const release = acquireWalletLock(from, path, root); release();
  rmSync(path);
  assert.throws(() => acquireWalletLock(from, path, root), /unavailable previous journal/);
});
