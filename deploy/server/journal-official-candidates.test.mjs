import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Interface, getAddress } from 'ethers';
import { createBoundedOfficialProvider, createJournalService } from './journal-api.mjs';

const address = value => getAddress(`0x${value.toString(16).padStart(40, '0')}`);
const hash = value => `0x${value.toString(16).padStart(64, '0')}`;
const factory = address(1), pool = address(2), seller = address(3);
const collection = getAddress('0xb1024b89886b9a34aa4ff5f31c411d708b20a14c');
const digest = hash(99), origin = 'http://127.0.0.1:4173';
const factoryAbi = new Interface(['function isPool(address) view returns(bool)']);
const poolAbi = new Interface([
  'function factory() view returns(address)', 'function OFFICIAL_FACTORY() view returns(address)',
  'function state() view returns(uint8)',
  'function params() view returns((address circuits,uint256 circuitId,uint256 targetRaise,uint256 priceCap,address directSeller,uint256 directPrice,uint64 fundingDeadline,uint64 purchaseDeadline))',
  'function flexiblePurchase() view returns(bool enabled,uint256 referenceCircuitId,(uint128 minVerifiedWeight,uint256 referencePriceWei,uint256 targetDailyYieldAtomic,uint16 extraBps,uint64 referenceObservedAt,uint64 referenceBlock,bytes32 referenceDigest) config)',
  'function purchaseModel() view returns(bool initialized,uint32 taskId)',
  'function purchaseReferenceWeight() view returns(uint128)',
]);
const path = number => `/api/journal/official-candidates?pool=${pool}&block=${number}&hash=${hash(number)}`;

async function fixture({ discovery = async (_rpc, options) =>
  ({ complete: true, chainBlock: options.blockNumber, candidates: [] }),
  graphWork = async () => {}, officialScanTimeoutMs, now = Date.now } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'journal-official-'));
  const state = { chain: 56n, head: 20, registered: true, funded: 1n, timestamp: 1000,
    flexible: true, collection, referenceId: 77n, weight: 100n, initialized: true,
    graphValid: true, activity: { chain: 0, blocks: 0, codes: 0, calls: 0, graphs: 0 }, blockHashes: new Map() };
  const provider = {
    async getBlock(number) {
      state.activity.blocks += 1;
      const height = number === 'latest' ? state.head : number;
      return { number: height, hash: state.blockHashes.get(height) ?? hash(height), timestamp: state.timestamp };
    },
    async getCode() { state.activity.codes += 1; return '0x6000'; },
    async send(method, args) {
      if (method === 'eth_chainId') { state.activity.chain += 1; return `0x${state.chain.toString(16)}`; }
      assert.equal(method, 'eth_call');
      state.activity.calls += 1;
      const [tx, tag] = args;
      assert.match(tag, /^0x[\da-f]+$/);
      const iface = tx.to.toLowerCase() === factory.toLowerCase() ? factoryAbi : poolAbi;
      const parsed = iface.parseTransaction(tx);
      if (parsed.name === 'isPool') return iface.encodeFunctionResult(parsed.name, [state.registered]);
      const values = { factory, OFFICIAL_FACTORY: factory, state: state.funded,
        params: [state.collection, 77n, 1100n, 1000n, address(0), 0n, 900n, 2000n],
        flexiblePurchase: [state.flexible, state.referenceId,
          [50n, 1000n, 10n, 1000n, 900n, 9n, hash(1)]],
        purchaseModel: [state.initialized, 42n], purchaseReferenceWeight: state.weight };
      return iface.encodeFunctionResult(parsed.name,
        parsed.name === 'flexiblePurchase' || parsed.name === 'purchaseModel' ? values[parsed.name] : [values[parsed.name]]);
    },
  };
  const service = createJournalService({ dbPath: join(directory, 'private', 'journal.sqlite'), origin,
    provider, currentArtifactDigest: () => digest, allowedProductFactories: [factory],
    productGraphVerifier: async (_rpc, expected, block) => {
      state.activity.graphs += 1;
      assert.equal(expected.toLowerCase(), factory.toLowerCase());
      assert.equal(block.hash, state.blockHashes.get(block.number) ?? hash(block.number));
      await graphWork(state, block);
      if (!state.graphValid) throw Error('schema2 upgrade changed');
      return { factory, artifactDigest: digest, blockNumber: block.number };
    }, officialCandidateDiscovery: discovery, officialScanTimeoutMs, now });
  const server = createServer((req, res) => service.handle(req, res));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { state, provider, async get(route) {
    const response = await fetch(base + route);
    return { status: response.status, body: await response.json(), cacheControl: response.headers.get('cache-control') };
  }, async close() {
    await new Promise(resolve => server.close(resolve));
    await service.close();
    await rm(directory, { recursive: true, force: true });
  } };
}

test('public journal route verifies graph, registered Funded pool and pinned model before listing candidates', async () => {
  let scans = 0;
  const f = await fixture({ discovery: async (_rpc, options, constraints) => {
    scans += 1;
    assert.equal(options.blockNumber, 10);
    assert.equal(constraints.circuits, collection);
    assert.equal(constraints.taskId, 42n);
    assert.equal(constraints.referenceVerifiedWeight, 100n);
    return { complete: true, chainBlock: 10,
      candidates: [{ listingId: 8n, collection, tokenId: 78n, seller, priceWei: 700n, verifiedWeight: 80n }] };
  } });
  try {
    const first = await f.get(path(10));
    assert.equal(first.status, 200);
    assert.equal(first.cacheControl, 'no-store');
    assert.deepEqual(first.body, { complete: true, chainId: 56, factory, artifactDigest: digest,
      pool, blockNumber: '10', blockHash: hash(10), flexible: true,
      model: { circuits: collection, taskId: '42', minVerifiedWeight: '50',
        referenceVerifiedWeight: '100', referencePriceWei: '1000', priceCap: '1000' },
      candidates: [{ listingId: '8', collection, tokenId: '78', seller,
        priceWei: '700', verifiedWeight: '80' }] });
    assert.equal((await f.get(path(10))).status, 200);
    assert.equal(scans, 1);
    assert.equal(f.state.activity.graphs, 1, 'same canonical block reuses the short graph proof');
  } finally { await f.close(); }
});

test('fixed pool returns complete empty set without an external scan', async () => {
  const f = await fixture({ discovery: async () => { throw Error('must not scan'); } });
  try {
    f.state.flexible = false;
    const response = await f.get(path(10));
    assert.equal(response.status, 200);
    assert.equal(response.body.complete, true);
    assert.equal(response.body.flexible, false);
    assert.equal(response.body.model, null);
    assert.deepEqual(response.body.candidates, []);
  } finally { await f.close(); }
});

test('query, graph, membership, deadline and model failures never return a complete empty market', async () => {
  const f = await fixture();
  try {
    for (const invalid of ['/api/journal/official-candidates', `${path(10)}&x=1`,
      `/api/journal/official-candidates?pool=${pool}&block=010&hash=${hash(10)}`])
      assert.equal((await f.get(invalid)).status, 400);
    assert.equal((await f.get(`/api/journal/official-candidates?pool=${pool}&block=10&hash=${hash(11)}`)).status, 409);
    f.state.graphValid = false;
    assert.equal((await f.get(path(10))).status, 503);
    f.state.graphValid = true; f.state.registered = false;
    assert.equal((await f.get(path(10))).status, 409);
    f.state.registered = true; f.state.timestamp = 2000;
    assert.equal((await f.get(path(10))).status, 409);
    f.state.timestamp = 1000; f.state.referenceId = 78n;
    assert.equal((await f.get(path(10))).status, 503);
  } finally { await f.close(); }
});

test('snapshot failure, incomplete result and mid-scan reorg fail closed', async () => {
  let mode = 'error', release;
  const f = await fixture({ discovery: (_rpc, options) => {
    if (mode === 'error') throw Error('snapshot unavailable');
    if (mode === 'incomplete') return { complete: false, chainBlock: options.blockNumber, candidates: [] };
    if (mode === 'reorg') return new Promise(resolve => { release = () => resolve({ complete: true, chainBlock: options.blockNumber, candidates: [] }); });
    return { complete: true, chainBlock: options.blockNumber, candidates: [] };
  } });
  try {
    assert.equal((await f.get(path(10))).status, 503);
    mode = 'incomplete';
    assert.equal((await f.get(path(10))).status, 503);
    mode = 'reorg';
    const pending = f.get(path(10));
    for (let i = 0; !release && i < 100; i += 1) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(typeof release, 'function');
    f.state.blockHashes.set(10, hash(99));
    release();
    assert.equal((await pending).status, 409);
    f.state.blockHashes.set(10, hash(10));
    mode = 'success';
    assert.equal((await f.get(path(10))).status, 200);
  } finally { await f.close(); }
});

test('a complete official scan taking longer than the old 12-second budget remains usable', async () => {
  const f = await fixture({ discovery: async (_rpc, options) => {
    await new Promise(resolve => setTimeout(resolve, 12_100));
    return { complete: true, chainBlock: options.blockNumber, candidates: [] };
  } });
  try {
    const result = await f.get(path(10));
    assert.equal(result.status, 200);
    assert.equal(result.body.complete, true);
    assert.deepEqual(result.body.candidates, []);
  } finally { await f.close(); }
});

test('bounded official RPC rejects a hung response and does not retry a throttled request', async () => {
  let mode = 'hang', requests = 0;
  const server = createServer((req, res) => {
    requests += 1;
    req.resume();
    if (mode === 'rate') { res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '60' }); res.end('{}'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    const bounded = createBoundedOfficialProvider(url, 80);
    assert.equal(bounded._getConnection().timeout, 80);
    await assert.rejects(bounded.send('eth_chainId', []));
    assert.equal(requests, 1, 'the hung request must end at its FetchRequest timeout');
    bounded.destroy();
    mode = 'rate'; requests = 0;
    const noRetry = createBoundedOfficialProvider(url, 500);
    await assert.rejects(noRetry.send('eth_chainId', []));
    assert.equal(requests, 1, 'HTTP 429 must not trigger hidden retry attempts');
    noRetry.destroy();
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

test('timed-out HTTP scans retain slots until bounded RPC work settles, then scans recover', async () => {
  let time = 100_000, mode = 'bounded-fail', settledCount = 0, markSettled;
  const settled = new Promise(resolve => { markSettled = resolve; });
  const f = await fixture({ now: () => time, officialScanTimeoutMs: 30,
    discovery: (_rpc, options) => mode === 'success'
      ? { complete: true, chainBlock: options.blockNumber, candidates: [] }
      : new Promise((_resolve, reject) => setTimeout(() => {
        settledCount += 1;
        if (settledCount === 2) markSettled();
        reject(Error('bounded RPC timeout'));
      }, 100)) });
  try {
    const first = f.get(path(10)), second = f.get(path(11));
    assert.equal((await first).status, 503);
    assert.equal((await second).status, 503);
    time += 4_000; // Allow a third distinct graph proof; the two scans still own both slots.
    assert.equal((await f.get(path(12))).status, 503);
    await settled;
    mode = 'success';
    assert.equal((await f.get(path(12))).status, 200);
  } finally { await f.close(); }
});

test('anonymous rate budget rejects before any RPC and refills without losing the short cache', async () => {
  let time = 100_000, scans = 0;
  const f = await fixture({ now: () => time, discovery: async (_rpc, options) => {
    scans += 1;
    return { complete: true, chainBlock: options.blockNumber, candidates: [] };
  } });
  try {
    for (let i = 0; i < 6; i += 1) assert.equal((await f.get(path(10))).status, 200);
    assert.equal(scans, 1);
    const before = { ...f.state.activity };
    assert.equal((await f.get(path(10))).status, 429);
    assert.deepEqual(f.state.activity, before);
    time += 500;
    assert.equal((await f.get(path(10))).status, 200);
    assert.equal(scans, 1);
  } finally { await f.close(); }
});

test('global scan slots cap distinct blocks at two while same-block callers share discovery', async () => {
  let time = 100_000;
  const releases = [];
  const f = await fixture({ now: () => time, discovery: (_rpc, options) => new Promise(resolve => {
    releases.push(() => resolve({ complete: true, chainBlock: options.blockNumber, candidates: [] }));
  }) });
  try {
    const first = f.get(path(10));
    for (let i = 0; releases.length < 1 && i < 100; i += 1) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(releases.length, 1);
    const shared = f.get(path(10)), second = f.get(path(11));
    for (let i = 0; releases.length < 2 && i < 100; i += 1) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(releases.length, 2);
    time += 4_000; // Refill the independent graph budget so the scan limit is reached.
    assert.equal((await f.get(path(12))).status, 503);
    releases.forEach(release => release());
    assert.equal((await first).status, 200);
    assert.equal((await shared).status, 200);
    assert.equal((await second).status, 200);
  } finally { await f.close(); }
});

test('bogus pool identity is rejected before any full product graph proof', async () => {
  const f = await fixture();
  try {
    f.state.registered = false;
    assert.equal((await f.get(path(10))).status, 409);
    assert.equal(f.state.activity.graphs, 0);
    assert.ok(f.state.activity.calls >= 1, 'the lightweight Factory registration was checked');
    f.state.registered = true;
    f.state.funded = 2n;
    assert.equal((await f.get(path(10))).status, 409);
    assert.equal(f.state.activity.graphs, 0, 'non-Funded pool must not start a graph proof');
    f.state.funded = 1n;
    assert.equal((await f.get(path(10))).status, 200);
    assert.equal(f.state.activity.graphs, 1);
  } finally { await f.close(); }
});

test('distinct recent blocks consume a separate graph-proof budget while cache hits remain free', async () => {
  let time = 100_000;
  const f = await fixture({ now: () => time });
  try {
    assert.equal((await f.get(path(10))).status, 200);
    assert.equal((await f.get(path(11))).status, 200);
    assert.equal(f.state.activity.graphs, 2);
    assert.equal((await f.get(path(12))).status, 429);
    assert.equal(f.state.activity.graphs, 2, 'third distinct block must not start a graph proof');
    assert.equal((await f.get(path(10))).status, 200);
    assert.equal(f.state.activity.graphs, 2, 'cached proof must not consume the exhausted proof budget');
    time += 4_000;
    assert.equal((await f.get(path(12))).status, 200);
    assert.equal(f.state.activity.graphs, 3);
  } finally { await f.close(); }
});

test('graph proof is coalesced before candidate discovery and expires after five seconds', async () => {
  let time = 100_000, release;
  const gate = new Promise(resolve => { release = resolve; });
  const f = await fixture({ now: () => time, graphWork: () => gate });
  try {
    const first = f.get(path(10));
    for (let i = 0; f.state.activity.graphs < 1 && i < 100; i += 1) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(f.state.activity.graphs, 1);
    const shared = f.get(path(10));
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(f.state.activity.graphs, 1, 'second caller must await the same graph proof');
    release();
    assert.equal((await first).status, 200);
    assert.equal((await shared).status, 200);
    assert.equal((await f.get(path(10))).status, 200);
    assert.equal(f.state.activity.graphs, 1, 'completed proof stays cached briefly');
    time += 5_001;
    assert.equal((await f.get(path(10))).status, 200);
    assert.equal(f.state.activity.graphs, 2, 'expired proof must be recomputed');
  } finally { release(); await f.close(); }
});

test('historical and future block probes stop before graph verification, including after a cached proof', async () => {
  const f = await fixture();
  try {
    f.state.head = 130;
    assert.equal((await f.get(path(9))).status, 409, '121 blocks old is outside the allowed window');
    assert.equal((await f.get(path(131))).status, 409, 'a future block is unavailable');
    assert.equal(f.state.activity.graphs, 0);
    assert.equal(f.state.activity.calls, 0);
    assert.equal((await f.get(path(10))).status, 200, '120 blocks old is the boundary');
    assert.equal(f.state.activity.graphs, 1);
    f.state.head = 131;
    assert.equal((await f.get(path(10))).status, 409, 'a cached graph does not authorize an aged block');
    assert.equal(f.state.activity.graphs, 1);
  } finally { await f.close(); }
});

test('graph cache never bypasses per-request canonical block-hash validation', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.get(path(10))).status, 200);
    assert.equal(f.state.activity.graphs, 1);
    f.state.blockHashes.set(10, hash(99));
    assert.equal((await f.get(path(10))).status, 409);
    assert.equal(f.state.activity.graphs, 1, 'reorg is rejected before cached proof can be used');
  } finally { await f.close(); }
});
