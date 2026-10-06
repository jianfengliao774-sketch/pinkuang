import assert from 'node:assert/strict';
import test from 'node:test';
import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { parseEther } from 'ethers';
import { abi, readPoolSnapshot } from '../lib/chain-client.mjs';
import { prepareProductAction } from '../lib/live-actions.mjs';
import { createLiveBrowserFixture, FIXTURE_ACCOUNT, FIXTURE_POOLS, FIXTURE_CONTRACTS } from './live-browser-fixture.mjs';

const config = { status: 'ready', chainId: 56, ...FIXTURE_CONTRACTS };
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const inputs = Object.freeze({
  deposit: { pool: FIXTURE_POOLS.funding, kind: 'deposit', quantity: '4' },
  list: { pool: FIXTURE_POOLS.active, kind: 'list', quantity: '4', price: '0.083' },
  fill: { pool: FIXTURE_POOLS.active, kind: 'fill', quantity: '3', orderId: '1' },
});

function decodeRequest(input) {
  if (input.method !== 'eth_call') return { name: input.method, simulated: false };
  const transaction = input.params[0], to = transaction.to.toLowerCase();
  const iface = to === FIXTURE_CONTRACTS.factory.toLowerCase() ? abi.PoolFactory
    : to === FIXTURE_CONTRACTS.lens.toLowerCase() ? abi.PoolLens
      : to === FIXTURE_CONTRACTS.shareMarket.toLowerCase() ? abi.ShareMarket : abi.PoolVault;
  const parsed = iface.parseTransaction(transaction);
  return { name: parsed.name, simulated: Object.hasOwn(transaction, 'from'), iface, parsed };
}

/** Local fixture only; no HTTP, account permission, signing or transaction RPC is allowed. */
function measuredProvider({ latency = 0, intercept = async (_input, _meta, original) => original() } = {}) {
  const fixture = createLiveBrowserFixture({ timestamp: 1_800_000_000, confirmDeposit: true });
  const trace = []; let active = 0, peakActive = 0;
  const provider = { async request(input) {
    assert(['eth_chainId', 'eth_getBlockByNumber', 'eth_call'].includes(input.method), 'only read RPCs');
    const meta = decodeRequest(input), entry = { method: input.method, name: meta.name, simulated: meta.simulated,
      blockTag: input.method === 'eth_call' ? input.params[1] : undefined, started: performance.now() };
    trace.push(entry); active++; peakActive = Math.max(peakActive, active);
    try {
      await delay(typeof latency === 'function' ? latency(input, meta) : latency);
      return await intercept(input, meta, async () => {
        // Keep a fixture reply for older benchmark variants that request a simulated trade.
        if (meta.simulated && ['list', 'fill'].includes(meta.name)) {
          assert.equal(input.params[0].from, FIXTURE_ACCOUNT);
          assert.equal(input.params[0].to, FIXTURE_CONTRACTS.shareMarket);
          return meta.iface.encodeFunctionResult(meta.parsed.fragment, meta.parsed.fragment.outputs.map(() => 3n));
        }
        return fixture.request(input);
      });
    } finally { entry.finished = performance.now(); active--; }
  } };
  return { provider, trace, fixture, get active() { return active; }, get peakActive() { return peakActive; } };
}

async function runAction(kind, options = {}) {
  const measured = measuredProvider(options), started = performance.now();
  const result = await prepareProductAction({ provider: measured.provider, config, account: FIXTURE_ACCOUNT, ...inputs[kind] });
  const elapsedMs = performance.now() - started;
  assert.equal(measured.active, 0);
  assert.equal(result.checkedBlock.blockNumber, 100n);
  assert.equal(result.checkedBlock.timestamp, 1_800_000_000n);
  assert.equal(result.transaction.from, FIXTURE_ACCOUNT);
  const iface = kind === 'deposit' ? abi.PoolVault : abi.ShareMarket;
  assert.equal(iface.parseTransaction(result.transaction).name, kind);
  const fillGross = parseEther('0.243');
  assert.equal(BigInt(result.transaction.value), kind === 'deposit' ? parseEther('0.286')
    : kind === 'fill' ? fillGross + fillGross / 100n : 0n);
  assert(measured.trace.filter(row => row.method === 'eth_call').every(row => row.blockTag === '0x64'));
  assert.equal(measured.trace.filter(row => row.simulated).length, 0);
  return { ...measured, elapsedMs, result };
}

if (process.argv.includes('--benchmark')) {
  const output = process.argv[process.argv.indexOf('--benchmark') + 1];
  assert(output && !output.startsWith('--'), 'benchmark requires a JSON output path');
  const files = ['chain-client.mjs', 'live-actions.mjs'];
  const sourceSha256 = Object.fromEntries(await Promise.all(files.map(async file => [file,
    createHash('sha256').update(await readFile(new URL(`../lib/${file}`, import.meta.url))).digest('hex')])));
  const cases = [];
  for (const kind of Object.keys(inputs)) {
    const { elapsedMs, trace, peakActive, result } = await runAction(kind, { latency: 100 });
    cases.push({ kind, elapsedMs: Math.round(elapsedMs), rpcCount: trace.length, peakActive,
      transaction: result.transaction, checkedBlock: result.checkedBlock, trace });
  }
  const report = { measuredAt: new Date().toISOString(), sourceSha256, artificialRpcLatencyMs: 100,
    environment: 'local createLiveBrowserFixture; no transaction simulation or live chain', cases };
  await writeFile(output, JSON.stringify(report, (_key, value) => typeof value === 'bigint' ? value.toString() : value, 2));
  console.log(JSON.stringify(cases.map(({ kind, elapsedMs, rpcCount, peakActive }) => ({ kind, elapsedMs, rpcCount, peakActive })), null, 2));
} else {
  test('parallel previews retain pinned reads, amounts and both final canonical checks without simulation', async () => {
    for (const kind of Object.keys(inputs)) {
      const { trace, peakActive } = await runAction(kind, { latency: 5 });
      assert(peakActive >= 3, 'independent lens reads should overlap');
      assert.equal(trace.filter(row => row.name === 'eth_chainId').length, 4);
      assert.equal(trace.filter(row => row.name === 'eth_getBlockByNumber').length, 4);
      assert.deepEqual(trace.slice(-2).map(row => row.name).sort(), ['eth_chainId', 'eth_getBlockByNumber']);
    }
  });

  test('snapshot inputs are validated and copied before any asynchronous reads start', async () => {
    const measured = measuredProvider();
    for (const invalid of [{ pools: {} }, { pools: Array(21).fill(FIXTURE_POOLS.funding) }, { pools: ['not an address'] },
      { limit: 21n }, { offset: '-1' }, { blockNumber: '-1' }]) {
      await assert.rejects(readPoolSnapshot(measured.provider, { factory: config.factory, account: FIXTURE_ACCOUNT, ...invalid }));
    }
    assert.equal(measured.trace.length, 0, 'invalid input must not start reads');
    const pools = [FIXTURE_POOLS.funding];
    const snapshot = readPoolSnapshot(measured.provider, { factory: config.factory, account: FIXTURE_ACCOUNT, pools });
    pools[0] = FIXTURE_POOLS.active;
    assert.equal((await snapshot).pools[0].pool, FIXTURE_POOLS.funding, 'caller mutation cannot change the scheduled read');
  });

  test('a pinned Lens reads the page alongside the Factory binding and still rejects a changed binding', async () => {
    const measured = measuredProvider({ latency: (_input, meta) => meta.name === 'lens' ? 40 : 0 });
    const page = await readPoolSnapshot(measured.provider, { factory: config.factory, lens: config.lens,
      account: FIXTURE_ACCOUNT, pools: [FIXTURE_POOLS.funding] });
    assert.equal(page.lens, config.lens);
    const factoryBinding = measured.trace.find(row => row.name === 'lens');
    const positions = measured.trace.find(row => row.name === 'positions');
    assert(positions.started < factoryBinding.finished, 'Lens page must overlap the live Factory binding');
    assert.equal(measured.active, 0);

    const changed = measuredProvider({ intercept: async (_input, meta, original) => meta.name === 'lens'
      ? abi.PoolFactory.encodeFunctionResult('lens', [FIXTURE_POOLS.active]) : original() });
    await assert.rejects(readPoolSnapshot(changed.provider, { factory: config.factory, lens: config.lens,
      account: FIXTURE_ACCOUNT, pools: [FIXTURE_POOLS.funding] }), /Configured Lens differs/);
    assert.equal(changed.active, 0);
  });

  test('initial RPC failure drains the parallel block request and never starts contract reads', async () => {
    const failure = new Error('chain RPC failed');
    const measured = measuredProvider({ latency: (_input, meta) => meta.name === 'eth_getBlockByNumber' ? 40 : 0,
      intercept: async (_input, meta, original) => { if (meta.name === 'eth_chainId') throw failure; return original(); } });
    await assert.rejects(prepareProductAction({ provider: measured.provider, config, account: FIXTURE_ACCOUNT, ...inputs.deposit }), error => error === failure);
    assert.equal(measured.active, 0);
    assert.deepEqual(measured.trace.map(row => row.name).sort(), ['eth_chainId', 'eth_getBlockByNumber']);
    assert(measured.trace.every(row => row.finished !== undefined));
  });

  test('untrusted lens bindings and failed lens RPCs drain all reads without a preview or simulation', async () => {
    for (const fault of ['factory', 'VERSION', 'factory-rpc', 'positions-rpc']) {
      const measured = measuredProvider({ latency: (_input, meta) => meta.name === 'positions' ? 40 : 5,
        intercept: async (_input, meta, original) => {
          if (fault === 'factory' && meta.name === 'factory') return abi.PoolLens.encodeFunctionResult('factory', [FIXTURE_POOLS.active]);
          if (fault === 'VERSION' && meta.name === 'VERSION') return abi.PoolLens.encodeFunctionResult('VERSION', [2n]);
          if (fault === `${meta.name}-rpc`) throw new Error(`injected ${fault}`);
          return original();
        } });
      await assert.rejects(prepareProductAction({ provider: measured.provider, config, account: FIXTURE_ACCOUNT, ...inputs.deposit }));
      assert.equal(measured.active, 0, fault);
      for (const name of ['factory', 'VERSION', 'positions']) assert(measured.trace.some(row => row.name === name && row.finished !== undefined), `${fault}: ${name} drained`);
      assert.equal(measured.trace.filter(row => row.simulated).length, 0, fault);
    }
  });

  test('invalid market back references or order errors drain the concurrent market group before rejecting', async () => {
    for (const fault of ['factory', 'shareMarket', 'orders-rpc', 'orderExpiresAt-rpc']) {
      const measured = measuredProvider({ latency: (_input, meta) => meta.name === 'orderExpiresAt' ? 40 : 5,
        intercept: async (_input, meta, original) => {
          if (fault === meta.name && ['factory', 'shareMarket'].includes(meta.name))
            return meta.iface.encodeFunctionResult(meta.parsed.fragment, [FIXTURE_POOLS.funding]);
          if (fault === `${meta.name}-rpc`) throw new Error(`injected ${fault}`);
          return original();
        } });
      await assert.rejects(prepareProductAction({ provider: measured.provider, config, account: FIXTURE_ACCOUNT, ...inputs.fill }));
      assert.equal(measured.active, 0, fault);
      for (const name of ['factory', 'shareMarket', 'orders', 'orderExpiresAt']) assert(measured.trace.some(row => row.name === name && row.finished !== undefined), `${fault}: ${name} drained`);
      assert(!measured.trace.some(row => row.name === 'lens' || row.simulated), 'unverified market data cannot start pool preparation or simulation');
    }
  });

  test('final canonical block or chain changes reject and drain both checks', async () => {
    for (const fault of ['chain', 'hash', 'number', 'timestamp']) {
      const counts={eth_chainId:0,eth_getBlockByNumber:0};
      const measured = measuredProvider({ latency: (_input, meta) => ['eth_chainId', 'eth_getBlockByNumber'].includes(meta.name) ? 20 : 0,
        intercept: async (_input, meta, original) => {
          if (Object.hasOwn(counts,meta.name)) counts[meta.name]++;
          if (counts.eth_chainId===4 && fault === 'chain' && meta.name === 'eth_chainId') return '0x1';
          if (counts.eth_getBlockByNumber===4 && meta.name === 'eth_getBlockByNumber' && fault !== 'chain') {
            const header = await original();
            return { ...header, [fault]: fault === 'hash' ? `0x${'ee'.repeat(32)}` : '0x1' };
          }
          return original();
        } });
      await assert.rejects(prepareProductAction({ provider: measured.provider, config, account: FIXTURE_ACCOUNT, ...inputs.fill }), /Chain changed/);
      assert.equal(measured.active, 0, fault);
      assert.equal(measured.trace.filter(row => row.simulated).length, 0);
      assert.equal(measured.trace.filter(row => row.name === 'eth_chainId').length, 4);
      assert.equal(measured.trace.filter(row => row.name === 'eth_getBlockByNumber').length, 4);
    }
  });

  test('share previews never request a transaction simulation', async () => {
    for(const kind of Object.keys(inputs)){
      const measured=await runAction(kind);
      assert(!measured.trace.some(row=>row.simulated));
    }
  });

  test('repeated previews reread latest prices and positions; no previous quote is cached', async () => {
    const measured = measuredProvider();
    const prepare = input => prepareProductAction({ provider: measured.provider, config, account: FIXTURE_ACCOUNT, ...input });
    const first = await prepare(inputs.deposit), reads = measured.trace.length;
    measured.fixture.rows.find(row => row.pool === FIXTURE_POOLS.funding).unitPriceWei += 1n;
    const second = await prepare(inputs.deposit);
    assert.equal(BigInt(second.transaction.value), BigInt(first.transaction.value) + 4n);
    assert.equal(measured.trace.length, reads * 2, 'every read and canonical check is repeated');
    const fill = await prepare(inputs.fill);
    measured.fixture.orders.find(order => order.orderId === '1').pricePerUnitWei = '1';
    await assert.rejects(prepare({ ...inputs.fill, expectedPricePerUnitWei: fill.order.pricePerUnitWei.toString() }), /Order price changed/);
    assert.equal(measured.active, 0);
  });
}
