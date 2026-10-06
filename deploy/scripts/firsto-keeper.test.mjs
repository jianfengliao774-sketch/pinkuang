import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Interface, Transaction, TypedDataEncoder, Wallet, ZeroAddress, toQuantity } from 'ethers';
import { FIRSTO_ASK_FIELDS, FIRSTO_SIGNED_EXCHANGE } from '../src/firsto-purchase.mjs';
import { KEEPER_POOL_ABI, LISTING_ABI, OFFICIAL_MARKET, OFFICIAL_COLLECTIONS, createKeeperRuntime, fetchCandidates, parseArguments,
  readJournal, readKeeperPool, runKeeperCycle, selectFirstoCandidates, verifyFirstoCandidate, writeJournal } from './purchase-keeper.mjs';

const runtimeFixture = JSON.parse(readFileSync(new URL('./fixtures/firsto-signed-runtime.json', import.meta.url), 'utf8'));
const factory = '0x1111111111111111111111111111111111111111', pool = '0x2222222222222222222222222222222222222222';
const officialFactory = '0x68224F668083c29e9800Be2a646d42d18cedF7e2';
const blockHash = `0x${'ab'.repeat(32)}`, signerWallet = new Wallet(`0x${'11'.repeat(32)}`);
const collection = OFFICIAL_COLLECTIONS[0], owner = signerWallet.address;
const now = Math.floor(Date.now() / 1000);
const domain = { name: 'Firsto Circuit Signed Ask', version: '2', chainId: 56, verifyingContract: FIRSTO_SIGNED_EXCHANGE };
const types = { SignedAsk: FIRSTO_ASK_FIELDS };
const ask = { maker: owner, collection, tokenId: '7', nonce: '9', price: '1000', expiry: String(now + 3600),
  payoutRecipient: owner, feeBps: '100', feeEpoch: '1', schemaVersion: '2' };
const signature = await signerWallet.signTypedData(domain, types, ask);
const askHash = TypedDataEncoder.hash(domain, types, ask);
const row = () => ({ collection, tokenId: '7', owner, category: 'official_mining',
  mining: { status: 'verified', taskId: 42, verifiedWeight: '100', unverifiedWeight: '0' },
  bestAsk: { id: askHash, status: 'open', venue: 'firsto', account: owner, priceWei: '1000', buyerCostWei: '1010',
    expiresAt: Number(ask.expiry) * 1000, execution: { ...ask, feeBps: 100, priceWei: '1000', chainId: 56,
      kind: 'signed_ask', exchange: FIRSTO_SIGNED_EXCHANGE, signature, askHash } } });
const constraints = { circuits: collection, circuitId: 7n, priceCap: 1010n, minVerifiedWeight: 1n, blockNumber: 50 };
const options = journal => ({ factory, pool, journal, venue: 'firsto-signed', send: false, once: true,
  pages: 1, sort: 'price', refreshInterval: 30, maxGasWei: 1000n, maxGasPrice: 2n });
function temporary(t) {
  const directory = mkdtempSync(join(tmpdir(), 'pinkuang-firsto-keeper-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return join(directory, 'journal.json');
}
const feed = (rows = [row()]) => async () => Response.json({ rows, sourceBlock: '50', viewId: 'view-1', totalPages: 1 });
const poolAbi = new Interface(KEEPER_POOL_ABI), registryAbi = new Interface(['function isPool(address) view returns(bool)']);
const exchangeAbi = new Interface(['function factory() view returns(address)', 'function paused() view returns(bool)',
  'function feeEpoch() view returns(uint256)', 'function defaultTakerFeeBps() view returns(uint16)',
  'function feeBpsAtEpoch(uint256) view returns(uint16)', 'function SIGNED_ASK_SCHEMA_VERSION() view returns(uint16)',
  'function isSignedAskNonceInvalidated(address,uint256) view returns(bool)']);
const officialAbi = new Interface([...LISTING_ABI, 'function nextListingId() view returns(uint256)']);
const nftAbi = new Interface(['function ownerOf(uint256) view returns(address)', 'function getApproved(uint256) view returns(address)',
  'function isApprovedForAll(address,address) view returns(bool)']);
function simulatedChain() {
  const state = { funding: 1n, flexible: false, chainId: 56n, block: 50, blockHash, owner,
    fee: 100n, invalid: false, approved: FIRSTO_SIGNED_EXCHANGE, cap: 1010n, estimates: [], signed: 0, broadcasts: [], reads: [],
    timestamp: now, atomicFailure: false, latestNonce: 7, pendingNonce: 7,
    officialListing: false, officialAlternative: false, officialMaxId: 7n };
  const block = () => ({ number: state.block, hash: state.blockHash, timestamp: state.timestamp, gasLimit: 30000000n });
  const provider = {
    getNetwork: async () => ({ chainId: state.chainId }), getBlock: async () => block(),
    getCode: async address => address.toLowerCase() === owner.toLowerCase() ? '0x' : '0x6000',
    getFeeData: async () => ({ gasPrice: 1n }), getBalance: async () => 1000000n,
    getTransactionCount: async (_address, tag) => tag === 'latest' ? state.latestNonce : state.pendingNonce,
    call: async transaction => {
      const target = transaction.to.toLowerCase();
      const abi = target === pool.toLowerCase() ? poolAbi : target === factory.toLowerCase() ? registryAbi
        : target === FIRSTO_SIGNED_EXCHANGE.toLowerCase() ? exchangeAbi
          : target === OFFICIAL_MARKET.toLowerCase() ? officialAbi : nftAbi;
      const decoded = abi.parseTransaction({ data: transaction.data }), name = decoded.name; state.reads.push(name);
      const result = { isPool: [true], factory: [target === FIRSTO_SIGNED_EXCHANGE.toLowerCase() ? officialFactory : factory],
        OFFICIAL_FACTORY: [factory], state: [state.funding], params: [[collection, 7n, 1100n, state.cap, ZeroAddress, 0n, now + 1000, now + 2000]],
        flexiblePurchase: [state.flexible, state.flexible ? 7n : 0n,
          [1n, 1010n, 1n, 1000n, now - 100, 40, blockHash]],
        purchaseModel: [state.flexible, 42n], purchaseReferenceWeight: [state.flexible ? 100n : 0n],
        paused: [false], feeEpoch: [1n], defaultTakerFeeBps: [state.fee], feeBpsAtEpoch: [state.fee], SIGNED_ASK_SCHEMA_VERSION: [2n],
        isSignedAskNonceInvalidated: [state.invalid], ownerOf: [state.owner], getApproved: [state.approved], isApprovedForAll: [false],
        listingFor: decoded.args.length > 1 && decoded.args[1] === 8n && state.officialAlternative ? [8n, owner, 1000n, true]
          : decoded.args.length > 1 && decoded.args[1] === 7n && state.officialListing ? [7n, owner, 1000n, true]
            : [0n, ZeroAddress, 0n, false],
        listingView: decoded.args.length > 0 && decoded.args[0] === 8n && state.officialAlternative ? [owner, collection, 8n, 1000n, 100n, true]
          : decoded.args.length > 0 && decoded.args[0] === 7n && state.officialListing ? [owner, collection, 7n, 1000n, 100n, true]
            : [ZeroAddress, ZeroAddress, 0n, 0n, 0n, false],
        nextListingId: [state.officialMaxId] }[name];
      if (!result) throw new Error(`Unexpected read ${name}`);
      return abi.encodeFunctionResult(name, result);
    },
    send: async (method, params) => {
      state.reads.push(method);
      if (method === 'eth_chainId') return toQuantity(state.chainId);
      if (method === 'eth_getBlockByNumber') return { ...block(), number: toQuantity(state.block), timestamp: toQuantity(state.timestamp) };
      if (method === 'eth_getStorageAt') return `0x${'00'.repeat(12)}${runtimeFixture.implementation.slice(2)}`;
      if (method === 'eth_getCode') return params[0].toLowerCase() === FIRSTO_SIGNED_EXCHANGE.toLowerCase() ? runtimeFixture.proxy : state.implementationCode ?? runtimeFixture.implementationCode;
      if (method === 'eth_call') return provider.call(params[0]);
      throw new Error(`Unexpected RPC ${method}`);
    },
    estimateGas: async transaction => {
      if (transaction.data === '0x' && transaction.to.toLowerCase() === owner.toLowerCase()) return 21000n;
      const decoded = poolAbi.parseTransaction({ data: transaction.data }); state.estimates.push(decoded);
      if (state.atomicFailure || state.funding !== 1n) throw new Error('Pool quality/occupancy/funding simulation failed');
      if (decoded.name === 'buyFromFirsto') assert.equal(decoded.args[0], 0n);
      else assert.equal(decoded.name, state.flexible ? 'buyAlternativeFromMarket' : 'buyFromMarket');
      assert(!transaction.value || transaction.value === 0n);
      return 100n;
    },
    broadcastTransaction: async raw => { const transaction = Transaction.from(raw); state.broadcasts.push(transaction); return { hash: transaction.hash }; },
    getTransaction: async hash => state.broadcasts.find(transaction => transaction.hash === hash) ?? null,
    getTransactionReceipt: async hash => state.receipts?.get(hash) ?? null,
    getBlockNumber: async () => state.block + 1,
  };
  const signer = { provider, getAddress: async () => owner, estimateGas: provider.estimateGas,
    signTransaction: async transaction => { state.signed += 1; return signerWallet.signTransaction(transaction); } };
  return { state, provider, signer };
}

test('Firsto execution requires explicit venue and never enables batch or changes default official mode', () => {
  const base = ['--factory', factory, '--pool', pool];
  assert.equal(parseArguments(base).venue, 'official');
  assert.equal(parseArguments([...base, '--venue', 'firsto-signed']).send, false);
  assert.equal(parseArguments([...base, '--venue', 'auto']).venue, 'auto');
  assert.throws(() => parseArguments([...base, '--venue', 'firsto-signed', '--journal', '/tmp/keeper-test.json', '--send']),
    /read-only for new purchases/);
  assert.equal(parseArguments([...base, '--venue', 'firsto-signed', '--journal', '/tmp/keeper-test.json', '--send', '--once', '--rebroadcast']).rebroadcast, true);
  assert.throws(() => parseArguments([...base, '--venue', 'batch']), /batch orders are disabled/);
});

test('runtime API also refuses a direct signed-Firsto send without official-first selection', async t => {
  const journal = temporary(t), { provider, signer } = simulatedChain();
  await assert.rejects(runKeeperCycle(provider, { ...options(journal), send: true }, signer, feed()),
    /cannot send a new purchase/);
});

test('automatic route buys the original official listing before consulting Firsto', async t => {
  const journal = temporary(t), { provider, state } = simulatedChain();
  state.officialListing = true;
  let firstoReads = 0;
  const result = await runKeeperCycle(provider, { ...options(journal), venue: 'auto' }, null,
    async () => { firstoReads += 1; throw new Error('Firsto must not be read while the official target is purchasable.'); });
  assert.equal(result.status, 'dry-run-ready');
  assert.equal(result.officialPriceWei, 1000n);
  assert.equal(state.estimates[0].name, 'buyFromMarket');
  assert.equal(firstoReads, 0);
});

test('automatic send signs only the official purchase when both venues can sell the same miner', async t => {
  const journal = temporary(t), { provider, state, signer } = simulatedChain();
  state.officialListing = true;
  let firstoReads = 0;
  const result = await runKeeperCycle(provider, { ...options(journal), venue: 'auto', send: true }, signer,
    async () => { firstoReads += 1; return feed()(); });
  assert.equal(result.status, 'broadcast');
  assert.equal(state.signed, 1);
  assert.equal(state.broadcasts.length, 1);
  assert.equal(poolAbi.parseTransaction({ data: state.broadcasts[0].data }).name, 'buyFromMarket');
  assert.equal(firstoReads, 0);
});

test('fresh graph callback can stop an otherwise executable purchase before signature', async t => {
  const journal = temporary(t), { provider, state, signer } = simulatedChain();
  state.officialListing = true;
  let checks = 0;
  await assert.rejects(runKeeperCycle(provider, { ...options(journal), venue: 'auto', send: true,
    verifyBeforeSend: async (_provider, selectedPool) => {
      checks += 1;
      assert.equal(selectedPool, pool);
      throw new Error('Fresh graph changed');
    } }, signer, feed()), /Fresh graph changed/);
  assert.equal(checks, 1);
  assert.equal(state.estimates.length, 1);
  assert.equal(state.signed, 0);
  assert.equal(state.broadcasts.length, 0);
  assert.equal(readJournal(journal, { factory, pool }).transaction, null);
});

test('automatic fixed-pool route checks the official target, then its exact Firsto signed order', async t => {
  const journal = temporary(t), { provider, state } = simulatedChain();
  const result = await runKeeperCycle(provider, { ...options(journal), venue: 'auto' }, null, feed());
  assert.equal(result.status, 'dry-run-ready');
  assert.equal(result.purchaseSequence, 'official-then-firsto');
  assert.equal(result.firstoTotalCostWei, '1010');
  assert.equal(state.estimates[0].name, 'buyFromFirsto');
  assert(state.reads.indexOf('listingFor') < state.reads.indexOf('isSignedAskNonceInvalidated'));
});

test('automatic flexible-pool route never treats a broken official snapshot as an empty market', async t => {
  const journal = temporary(t), { provider, state } = simulatedChain();
  state.flexible = true;
  let calls = 0;
  const result = await runKeeperCycle(provider, { ...options(journal), venue: 'auto' }, null,
    async () => { calls += 1; return feed()(); });
  assert.equal(result.status, 'official-priority-unverified');
  assert.equal(calls, 1, 'the malformed official response must not trigger Firsto discovery');
  assert.equal(state.estimates.length, 0);
});

test('automatic flexible-pool route buys a matching official alternative before Firsto discovery', async t => {
  const journal = temporary(t), { provider, state } = simulatedChain();
  state.flexible = true; state.officialAlternative = true; state.officialMaxId = 8n;
  const marketFeed = { generatedAt: new Date().toISOString(), block: 50, maxId: 8,
    marketAddr: OFFICIAL_MARKET, listings: [{ id: 8, seller: owner, circuits: collection,
      circuitId: '8', price: '1000', valid: true }] };
  let firstoReads = 0;
  const result = await runKeeperCycle(provider, { ...options(journal), venue: 'auto',
    read: { nextListingId: async () => 8n,
      listingView: async id => ({ id, seller: owner, circuits: collection, circuitId: '8', price: '1000', valid: true }),
      miner: async () => ({ circuits: collection, circuitId: 8n, taskId: 42n, status: 1n,
        optimal: false, verifWeight: 100n, unverWeight: 0n }),
    } }, null, async url => {
    if (String(url).includes('tapeout.net')) return Response.json(marketFeed);
    firstoReads += 1; return feed()();
  });
  assert.equal(result.status, 'dry-run-ready');
  assert.equal(result.listingId, 8n);
  assert.equal(state.estimates[0].name, 'buyAlternativeFromMarket');
  assert.equal(firstoReads, 0);
});

test('automatic flexible-pool fallback requires a complete scan and unchanged official listing head', async t => {
  const journal = temporary(t), { provider, state } = simulatedChain();
  state.flexible = true;
  const runtime = createKeeperRuntime();
  runtime.autoOfficial = createKeeperRuntime();
  runtime.autoOfficial.constraints = await readKeeperPool(provider, { ...options(journal), venue: 'official', allowFixedOfficial: true });
  runtime.autoOfficial.discovery = { officialSnapshotComplete: true, maxId: 7n };
  runtime.autoOfficial.lastRefreshStarted = Date.now();
  runtime.autoOfficial.lastRefreshCompleted = Date.now();
  const officialFeed = { generatedAt: new Date().toISOString(), block: 50,
    maxId: 7, marketAddr: OFFICIAL_MARKET, listings: [] };
  const fetcher = async url => String(url).includes('tapeout.net') ? Response.json(officialFeed) : feed()();
  const autoOptions = { ...options(journal), venue: 'auto',
    read: { nextListingId: async () => state.officialMaxId,
      listingView: async id => ({ id, valid: false }) } };
  const ready = await runKeeperCycle(provider, autoOptions, null, fetcher, runtime);
  assert.equal(ready.status, 'dry-run-ready');
  assert.equal(ready.firstoTotalCostWei, '1010');
  assert(state.reads.indexOf('nextListingId') < state.reads.indexOf('isSignedAskNonceInvalidated'));
  runtime.autoOfficial.discovery.maxId = 6n;
  runtime.autoFirsto = createKeeperRuntime();
  const changed = await runKeeperCycle(provider, autoOptions, null, fetcher, runtime);
  assert.equal(changed.status, 'official-priority-unverified');
});

test('an older official alternative repriced during Firsto preparation wins before any Firsto signature', async t => {
  const journal = temporary(t), { provider, state, signer } = simulatedChain();
  state.flexible = true; state.officialMaxId = 8n;
  const runtime = createKeeperRuntime();
  runtime.autoOfficial = createKeeperRuntime();
  runtime.autoOfficial.constraints = await readKeeperPool(provider, { ...options(journal), venue: 'official' });
  runtime.autoOfficial.discovery = { officialSnapshotComplete: true, maxId: 8n, generatedAt: new Date().toISOString() };
  runtime.autoOfficial.lastRefreshStarted = Date.now();
  runtime.autoOfficial.lastRefreshCompleted = Date.now();
  const marketFeed = { generatedAt: new Date().toISOString(), block: 50, maxId: 8,
    marketAddr: OFFICIAL_MARKET, listings: [{ id: 8, seller: owner, circuits: collection,
      circuitId: '8', price: '1500', valid: true }] };
  let firstoReads = 0;
  const result = await runKeeperCycle(provider, { ...options(journal), venue: 'auto', send: true,
    read: { nextListingId: async () => 8n,
      listingView: async id => ({ id, seller: owner, circuits: collection, circuitId: '8',
        price: state.officialAlternative ? '1000' : '1500', valid: true }),
      miner: async () => ({ circuits: collection, circuitId: 8n, taskId: 42n, status: 1n,
        optimal: false, verifWeight: 100n, unverWeight: 0n }),
    } }, signer, async url => {
    if (String(url).includes('tapeout.net')) return Response.json(marketFeed);
    firstoReads += 1;
    state.officialAlternative = true; // Same listing ID, now below the cap while Firsto is discovered.
    return feed()();
  }, runtime);
  assert.equal(result.status, 'broadcast');
  assert.equal(result.listingId, 8n);
  assert.equal(firstoReads, 1);
  assert.equal(state.signed, 1);
  assert.equal(poolAbi.parseTransaction({ data: state.broadcasts[0].data }).name, 'buyAlternativeFromMarket');
});

test('signed discovery is original-target-only, rejects batch/malformed orders, and counts source fee in cap', () => {
  assert.equal(selectFirstoCandidates([row()], constraints).length, 1);
  for (const changed of [
    { ...row(), tokenId: '8' }, { ...row(), collection: OFFICIAL_COLLECTIONS[1] },
    { ...row(), owner: factory }, { ...row(), bestAsk: { ...row().bestAsk, buyerCostWei: '1000' } },
    { ...row(), bestAsk: { ...row().bestAsk, execution: { ...row().bestAsk.execution, kind: 'batch_ask' } } },
    { ...row(), mining: { ...row().mining, status: 'optimal' } },
  ]) assert.equal(selectFirstoCandidates([changed], constraints).length, 0);
  assert.equal(selectFirstoCandidates([row()], { ...constraints, priceCap: 1009n }).length, 0);
  assert.equal(selectFirstoCandidates([row()], constraints, Number(ask.expiry) * 1000).length, 0);
});

test('bounded Firsto search pins exact NFT query and collection series', async () => {
  let queried;
  const result = await fetchCandidates(options('/unused'), constraints, async url => { queried = url; return feed()(); });
  assert.equal(queried.searchParams.get('query'), '7'); assert.equal(queried.searchParams.get('processorName'), 'TapeOut');
  assert.equal(result.candidates.length, 1); assert.equal(result.candidates[0].priceWei, 1010n);
});

test('fixed pools remain disabled in official mode but Firsto reads their exact original target and window', async () => {
  const { provider } = simulatedChain();
  assert.equal((await readKeeperPool(provider, { ...options('/unused'), venue: 'official' })).eligible, false);
  const actual = await readKeeperPool(provider, options('/unused'));
  assert.equal(actual.eligible, true); assert.equal(actual.circuitId, 7n); assert.equal(actual.enabled, false);
});

test('every Firsto attempt freshly rejects moved NFT, invalid nonce, changed fees, lost approval, wrong chain and expired order', async () => {
  const candidate = selectFirstoCandidates([row()], constraints)[0];
  for (const change of [{ owner: factory }, { invalid: true }, { fee: 101n }, { approved: ZeroAddress },
    { chainId: 97n }, { timestamp: Number(ask.expiry) }]) {
    const { provider, state } = simulatedChain(); Object.assign(state, change);
    await assert.rejects(verifyFirstoCandidate(provider, candidate, constraints));
  }
  const { provider } = simulatedChain();
  assert.equal(await verifyFirstoCandidate(provider, candidate, { ...constraints, circuitId: 8n }), null);
  assert.equal(await verifyFirstoCandidate(provider, candidate, { ...constraints, priceCap: 1009n }), null);
});

test('one-shot Firsto dry run verifies source and full Pool simulation without signatures or value transfer', async t => {
  const journal = temporary(t), { provider, state } = simulatedChain();
  const result = await runKeeperCycle(provider, options(journal), null, feed());
  assert.equal(result.status, 'dry-run-ready'); assert.equal(result.firstoSellerPriceWei, '1000');
  assert.equal(result.firstoFeeWei, '10'); assert.equal(result.firstoTotalCostWei, '1010');
  assert.equal(result.officialPriceWei, undefined); assert.equal(result.firstoOrderHash, askHash);
  assert.equal(state.estimates.length, 1); assert.equal(state.signed, 0); assert.equal(state.broadcasts.length, 0);
});

test('stale prewarmed signed orders and failed Pool simulation never reach signing', async t => {
  const journal = temporary(t), runtime = createKeeperRuntime(), { provider, state, signer } = simulatedChain();
  state.funding = 0n;
  assert.equal((await runKeeperCycle(provider, options(journal), null, feed(), runtime)).status, 'funding-prewarming');
  await runtime.refreshTask;
  assert.equal(runtime.queue.length, 1);
  state.funding = 1n; state.invalid = true;
  const failed = await runKeeperCycle(provider, options(journal), signer, feed(), runtime);
  assert.equal(failed.status, 'no-executable-firsto-original-target-in-prepared-queue'); assert.equal(state.estimates.length, 0);
  if (runtime.refreshTask) await runtime.refreshTask;
  state.invalid = false; state.atomicFailure = true;
  const failedPool = await runKeeperCycle(provider, options(journal), null, feed(), createKeeperRuntime());
  assert.equal(failedPool.status, 'no-executable-firsto-original-target-in-prepared-queue'); assert.equal(state.signed, 0);
});

test('unknown broadcast blocks signed-order discovery and all attempts even when venue changes', async t => {
  const journal = temporary(t);
  writeJournal(journal, { version: 1, chainId: 56, factory, pool, gasSpentWei: '0', gasReceipts: {}, transaction: {
    phase: 'intent', from: owner, nonce: 7, data: '0x1234', value: '0', createdAt: new Date().toISOString(),
  } });
  const { provider, state } = simulatedChain();
  const result = await runKeeperCycle(provider, options(journal), null, () => { throw new Error('No discovery allowed'); });
  assert.equal(result.status, 'unknown-broadcast'); assert.equal(state.estimates.length, 0);
  assert.deepEqual(state.reads, []);
});

test('Firsto send retains total gas budget and pending nonce boundaries before any signature', async t => {
  for (const boundary of ['budget', 'nonce']) {
    const journal = temporary(t), { provider, state, signer } = simulatedChain();
    if (boundary === 'nonce') state.pendingNonce = 8;
    const result = await runKeeperCycle(provider, { ...options(journal), venue: 'auto', send: true,
      maxGasWei: boundary === 'budget' ? 119n : 1000n }, signer, feed());
    assert.equal(result.status, boundary === 'budget' ? 'total-gas-budget-exceeded' : 'keeper-account-has-pending-transactions');
    assert.equal(state.signed, 0); assert.equal(state.broadcasts.length, 0);
  }
});

test('Firsto signed bytes are journaled with exact kind/order/zero value and unknown outcomes are never resent', async t => {
  const journal = temporary(t), { provider, state, signer } = simulatedChain();
  const result = await runKeeperCycle(provider, { ...options(journal), venue: 'auto', send: true }, signer, feed());
  assert.equal(result.status, 'broadcast'); assert.equal(state.signed, 1); assert.equal(state.broadcasts.length, 1);
  const persisted = readJournal(journal, options(journal));
  assert.equal(persisted.transaction.venue, 'firsto-signed'); assert.equal(persisted.transaction.orderHash, askHash);
  assert.equal(persisted.transaction.totalCostWei, '1010'); assert.equal(persisted.transaction.value, '0');
  const sent = state.broadcasts[0], decoded = poolAbi.parseTransaction({ data: sent.data });
  assert.equal(decoded.name, 'buyFromFirsto'); assert.equal(decoded.args[0], 0n);
  assert.equal(sent.to.toLowerCase(), pool.toLowerCase()); assert.equal(sent.value, 0n); assert.equal(sent.chainId, 56n);
  const pending = await runKeeperCycle(provider, { ...options(journal), venue: 'auto', send: true }, signer,
    () => { throw new Error('No discovery'); });
  assert.equal(pending.status, 'pending-receipt'); assert.equal(state.broadcasts.length, 1); assert.equal(state.signed, 1);
});

async function pendingPurchase(t) {
  const journal = temporary(t), chain = simulatedChain();
  const result = await runKeeperCycle(chain.provider, { ...options(journal), venue: 'auto', send: true }, chain.signer, feed());
  assert.equal(result.status, 'broadcast');
  // Metadata and the current CLI venue cannot turn this Firsto calldata into an official purchase.
  const persisted = readJournal(journal, options(journal)); persisted.transaction.venue = 'official';
  writeJournal(journal, persisted);
  return { journal, ...chain };
}
async function assertRecoveryBlocked(t, change) {
  for (const action of ['rebroadcast', 'speedUp']) {
    const { journal, provider, state, signer } = await pendingPurchase(t);
    Object.assign(state, change);
    const result = await runKeeperCycle(provider, { ...options(journal), venue: 'official', send: true, [action]: true }, signer,
      () => { throw new Error('Recovery must not fetch a replacement order'); });
    assert.equal(result.status, 'firsto-recovery-order-no-longer-verified');
    assert.equal(state.signed, 1); assert.equal(state.broadcasts.length, 1);
    assert.equal(readJournal(journal, options(journal)).transaction.attempts.length, 1);
  }
}

test('Firsto recovery rejects upgraded implementation for both resend and speed-up regardless of venue metadata', async t => {
  await assertRecoveryBlocked(t, { implementationCode: '0x6001' });
});
test('Firsto recovery rejects changed source fee without changing the persisted order or nonce', async t => {
  await assertRecoveryBlocked(t, { fee: 101n });
});
test('Firsto recovery rejects expired signed orders before resend or replacement signature', async t => {
  await assertRecoveryBlocked(t, { timestamp: Number(ask.expiry) });
});
test('Firsto source failure never blocks explicit cancellation, replaying that cancellation or finalized receipt recovery', async t => {
  const { journal, provider, state, signer } = await pendingPurchase(t);
  state.implementationCode = '0x6001';
  const recovery = { ...options(journal), send: true, maxGasWei: 100000n, maxGasPrice: 3n, cancelPending: true };
  assert.equal((await runKeeperCycle(provider, recovery, signer)).status, 'broadcast');
  const cancel = state.broadcasts.at(-1);
  assert.equal(cancel.data, '0x'); assert.equal(cancel.to.toLowerCase(), owner.toLowerCase()); assert.equal(cancel.nonce, 7);
  assert.equal((await runKeeperCycle(provider, { ...recovery, cancelPending: false, rebroadcast: true }, signer)).status, 'broadcast');
  assert.equal(state.signed, 2, 'a cancellation replay never creates another signature');
  state.receipts = new Map([[cancel.hash, { hash: cancel.hash, from: owner, to: owner, blockNumber: state.block,
    blockHash, status: 1, fee: 42000n }]]);
  const settled = await runKeeperCycle(provider, options(journal));
  assert.equal(settled.status, 'cancelled'); assert.equal(settled.terminal, true);
  assert.equal(state.signed, 2); assert.equal(state.broadcasts.length, 3);

  const original = await pendingPurchase(t), purchase = original.state.broadcasts[0];
  original.state.implementationCode = '0x6001';
  original.state.receipts = new Map([[purchase.hash, { hash: purchase.hash, from: owner, to: pool,
    blockNumber: original.state.block, blockHash, status: 1, fee: 100n }]]);
  assert.equal((await runKeeperCycle(original.provider, options(original.journal))).status, 'confirmed');
  assert.equal(original.state.signed, 1); assert.equal(original.state.broadcasts.length, 1);
});
