import assert from 'node:assert/strict';
import test from 'node:test';
import { Interface, getAddress, keccak256, toQuantity } from 'ethers';
import { abi, ARTIFACT_DIGEST } from '../lib/chain-client.mjs';
import { readFeeCollection } from '../lib/fee-collection.mjs';
import { createReadOnlyHttpProvider } from '../lib/live-config.mjs';

const address = value => getAddress(`0x${value.toString(16).padStart(40, '0')}`);
const digest = value => `0x${value.repeat(64)}`;
const token = getAddress('0x5ce033B2bFCa3Af30b3e8C8457DeaF776A8b695a');
const authority = address(501), gasWallet = address(502), first = address(503), second = address(504);
const code = '0x60006000', blockNumber = 200n, blockHash = digest('b');
const tokenAbi = new Interface(['function balanceOf(address) view returns(uint256)']);

function fixture(options = {}) {
  const keys = ['factory', 'shareMarket', 'lens', 'beacon', 'timelock', 'portfolioFactory',
    'portfolioMarket', 'portfolioBeacon', 'portfolioImplementation', 'portfolioFactoryImplementation'];
  const manifest = { schemaVersion: 1, chainId: 56, kind: 'integrated-v2',
    ...Object.fromEntries(keys.map((key, index) => [key, address(index + 100)])),
    codehash: Object.fromEntries(keys.map(key => [key, keccak256(code)])),
    sourceCommit: 'a'.repeat(40), artifactDigest: ARTIFACT_DIGEST, verifiedAt: '2026-09-30T10:00:00.000Z',
    verifiedBlockNumber: 100, deployment: { txHash: digest('a'), blockHash: digest('c'), blockNumber: 90 },
    authority, gasWallet, freshAuthority: { address: authority, gasWallet, administratorOne: first,
      administratorTwo: second, codehash: keccak256(code), deploymentTxHash: digest('d') } };
  const corePools = options.corePools ?? [address(1000), address(1001), address(1002)];
  const portfolios = options.portfolios ?? [address(2000)];
  const entries = new Map([...corePools.map(pool => [pool, { owner: manifest.factory,
    treasury: authority, amount: 10n }]), ...portfolios.map(pool => [pool, {
    owner: manifest.portfolioFactory, treasury: authority, amount: 20n }])]);
  for (const [pool, changes] of Object.entries(options.entries ?? {}))
    entries.set(getAddress(pool), { ...entries.get(getAddress(pool)), ...changes });
  const state = { directBnb: 5n, directBem: 7n, marketOwed: 30n, budgetMarketOwed: 40n, ...options };
  const config = { status: 'ready', stage: 'fresh-active', ...manifest, manifest };
  const calls = []; let active = 0, peak = 0, chainReads = 0, blockReads = 0;
  const request = async input => {
    calls.push(input); active++; peak = Math.max(peak, active);
    try {
      await options.beforeRead?.(input);
      if (options.delay) await new Promise(resolve => setTimeout(resolve, options.delay));
      const { method, params = [] } = input;
      if (method === 'eth_chainId') {
        chainReads++;
        return state.chain ?? (state.changedChain && chainReads > 1 ? '0x1' : '0x38');
      }
      if (method === 'eth_getBlockByNumber') {
        blockReads++;
        if (params[0] !== 'latest') assert.equal(params[0], toQuantity(blockNumber));
        return { number: toQuantity(state.wrongBlockNumber && blockReads > 1 ? blockNumber + 1n : blockNumber),
          hash: state.reorg && blockReads > 1 ? digest('f') : blockHash, timestamp: toQuantity(1800000000n) };
      }
      if (method === 'eth_getCode') {
        assert.equal(params[1], toQuantity(blockNumber));
        return params[0] === state.badCode ? '0x6001' : code;
      }
      if (method === 'eth_getBalance') {
        assert.deepEqual(params, [authority, toQuantity(blockNumber)]);
        return toQuantity(state.directBnb);
      }
      assert.equal(method, 'eth_call', 'fee discovery must not sign, send or simulate');
      const [tx, tag] = params;
      assert.equal(tag, toQuantity(blockNumber));
      assert.equal(tx.from, undefined, 'no transaction sender simulation');
      const entry = entries.get(tx.to);
      const iface = tx.to === authority ? abi.PlatformAuthority
        : tx.to === token ? tokenAbi
          : tx.to === manifest.factory ? abi.PoolFactory
            : tx.to === manifest.portfolioFactory ? abi.BudgetPortfolioFactory
              : tx.to === manifest.shareMarket || tx.to === manifest.portfolioMarket ? abi.ShareMarket
                : entry?.owner === manifest.portfolioFactory ? abi.BudgetPortfolioVault : abi.PoolVault;
      const decoded = iface.parseTransaction(tx), name = decoded.name;
      if (state.fail === name || state.fail === `${tx.to}:${name}`) throw new Error('fee RPC unavailable');
      if (name === 'allPools') return iface.encodeFunctionResult(name, [corePools[Number(decoded.args[0])]]);
      if (name === 'portfolioAt') return iface.encodeFunctionResult(name, [portfolios[Number(decoded.args[0])]]);
      if (name === 'isPool') return iface.encodeFunctionResult(name, [state.unregistered !== decoded.args[0]]);
      if (name === 'bnbOwed') {
        assert.equal(decoded.args[0], authority, 'only Authority platform liabilities are read');
        return iface.encodeFunctionResult(name, [tx.to === manifest.shareMarket ? state.marketOwed
          : tx.to === manifest.portfolioMarket ? state.budgetMarketOwed : entry.amount]);
      }
      if (name === 'balanceOf') {
        assert.equal(decoded.args[0], authority, 'only already-received platform BEM is read');
        return iface.encodeFunctionResult(name, [state.directBem]);
      }
      const values = { coreFactory: state.wrongCore ?? manifest.factory,
        budgetFactory: state.wrongBudget ?? manifest.portfolioFactory,
        gasWallet: state.wrongGasWallet ?? gasWallet,
        BEM: tx.to === authority ? state.wrongAuthorityBem ?? token : entry?.bem ?? token,
        shareMarket: tx.to === manifest.factory ? state.wrongMarket ?? manifest.shareMarket
          : state.wrongBudgetMarket ?? manifest.portfolioMarket,
        factory: tx.to === manifest.shareMarket ? state.wrongMarketFactory ?? manifest.factory
          : state.wrongBudgetMarketFactory ?? manifest.portfolioFactory,
        legacyFactory: state.wrongLegacy ?? manifest.factory,
        OFFICIAL_FACTORY: entry?.binding ?? entry?.owner, treasury: entry?.treasury,
        poolCount: BigInt(corePools.length), portfolioCount: BigInt(portfolios.length) };
      assert(name in values, `unexpected fee discovery read: ${name}`);
      return iface.encodeFunctionResult(name, [values[name]]);
    } finally { active--; }
  };
  return { config, provider: { request }, state, calls, corePools, portfolios, entries,
    peak: () => peak, active: () => active };
}

test('collects both markets, standalone/closed/child/reserved pools and budget project fees exactly', async () => {
  const f = fixture(), value = await readFeeCollection(f);
  assert.deepEqual(value.markets, [f.config.shareMarket, f.config.portfolioMarket]);
  assert.deepEqual(value.pools, [...f.corePools, ...f.portfolios]);
  assert.equal(value.sourceCount, 6);
  assert.equal(value.directBnbWei, 5n); assert.equal(value.directBemWei, 7n);
  assert.equal(value.totalBnbWei, 125n); assert.equal(value.totalBemWei, 7n);
  assert.equal(value.blockNumber, blockNumber); assert.equal(value.blockHash, blockHash);
  assert.deepEqual(value.batches, [{ markets: value.markets, pools: value.pools }]);
  assert(!f.calls.some(call => ['eth_getLogs', 'eth_estimateGas', 'eth_sendTransaction'].includes(call.method)));
});

test('deduplicates repeated directory addresses and ignores different treasuries only after registration', async () => {
  const pool = address(1000), foreignTreasury = address(1001);
  const f = fixture({ corePools: [pool, pool, foreignTreasury], portfolios: [],
    entries: { [foreignTreasury]: { treasury: address(999), amount: 100000n } } });
  const value = await readFeeCollection(f);
  assert.deepEqual(value.pools, [pool]); assert.equal(value.totalBnbWei, 85n);
  assert.equal(f.calls.filter(({ method, params }) => method === 'eth_call'
    && params[0].to === pool && abi.PoolVault.parseTransaction(params[0])?.name === 'bnbOwed').length, 1);
});

test('zero balances produce no claim batches and never invent a fee amount', async () => {
  const f = fixture({ directBnb: 0n, directBem: 0n, marketOwed: 0n, budgetMarketOwed: 0n });
  for (const entry of f.entries.values()) entry.amount = 0n;
  const value = await readFeeCollection(f);
  assert.deepEqual(value.markets, []); assert.deepEqual(value.pools, []); assert.deepEqual(value.batches, []);
  assert.equal(value.totalBnbWei, 0n); assert.equal(value.totalBemWei, 0n); assert.equal(value.sourceCount, 0);
});

test('direct BNB or BEM alone creates an empty-source claim and excludes member rewards', async () => {
  for (const balances of [{ directBnb: 1n, directBem: 0n }, { directBnb: 0n, directBem: 1n }]) {
    const value = await readFeeCollection(fixture({ corePools: [], portfolios: [],
      marketOwed: 0n, budgetMarketOwed: 0n, ...balances }));
    assert.deepEqual(value.batches, [{ markets: [], pools: [] }]);
    assert.equal(value.totalBnbWei, balances.directBnb); assert.equal(value.totalBemWei, balances.directBem);
  }
});

test('automatically batches at most 24 positive fee sources without omissions or repeated addresses', async () => {
  const f = fixture({ corePools: Array.from({ length: 49 }, (_, index) => address(1000 + index)), portfolios: [] });
  const value = await readFeeCollection(f);
  assert.deepEqual(value.batches.map(batch => batch.markets.length + batch.pools.length), [24, 24, 3]);
  const batched = value.batches.flatMap(batch => [...batch.markets, ...batch.pools]);
  assert.equal(batched.length, 51); assert.equal(new Set(batched).size, 51);
  assert.deepEqual(batched, [...value.markets, ...value.pools]);
});

test('fully scans over 500 registry entries, including trailing positive fee sources', async () => {
  const corePools = Array.from({ length: 501 }, (_, index) => address(1000 + index));
  const f = fixture({ corePools, portfolios: [], marketOwed: 0n, budgetMarketOwed: 0n, directBnb: 0n, directBem: 0n });
  for (const entry of f.entries.values()) entry.amount = 0n;
  f.entries.get(corePools.at(-1)).amount = 123n;
  const value = await readFeeCollection(f);
  assert.deepEqual(value.pools, [corePools.at(-1)]); assert.equal(value.totalBnbWei, 123n);
  assert.equal(f.calls.filter(call => call.method === 'eth_call'
    && call.params[0].to === f.config.factory && abi.PoolFactory.parseTransaction(call.params[0]).name === 'allPools').length, 501);
});

test('rejects changed Authority, Factory, market, Gas wallet, BEM and runtime bindings', async () => {
  for (const mutation of ['wrongCore', 'wrongBudget', 'wrongGasWallet', 'wrongAuthorityBem',
    'wrongMarket', 'wrongBudgetMarket', 'wrongMarketFactory', 'wrongBudgetMarketFactory', 'wrongLegacy']) {
    const f = fixture({ [mutation]: address(9999) });
    await assert.rejects(readFeeCollection(f), /绑定|市场/);
  }
  const f = fixture({ badCode: authority });
  await assert.rejects(readFeeCollection(f), /代码/);
});

test('accepts only the complete current formal manifest and rejects conflicting page configuration before RPC', async () => {
  for (const mutate of [f => { f.config.stage = 'genesis'; }, f => { f.config.authority = address(999); },
    f => { delete f.config.manifest.freshAuthority; }, f => { f.config.manifest.artifactDigest = digest('f'); },
    f => { f.config.stale = true; }]) {
    const f = fixture(); mutate(f);
    await assert.rejects(readFeeCollection(f)); assert.equal(f.calls.length, 0);
  }
});

test('read-only fee balances remain available when an unrelated worker is unavailable', async () => {
  const f = fixture(); f.config.operationalReady = false;
  assert.equal((await readFeeCollection(f)).totalBnbWei, 125n);
});

test('invalid pool registration, factory binding or BEM asset rejects the entire plan', async () => {
  const pool = address(1000);
  for (const options of [{ unregistered: pool }, { entries: { [pool]: { binding: address(999) } } },
    { entries: { [pool]: { bem: address(999) } } }])
    await assert.rejects(readFeeCollection(fixture(options)), /登记|BEM/);
});

test('failed registry or balance reads reject the plan rather than treating unavailable data as zero', async () => {
  for (const name of ['poolCount', 'allPools', 'portfolioAt', 'treasury', 'bnbOwed', 'balanceOf'])
    await assert.rejects(readFeeCollection(fixture({ fail: name })), /RPC unavailable/);
});

test('all view calls use one block and real RPC concurrency never exceeds four', async () => {
  const f = fixture({ corePools: Array.from({ length: 12 }, (_, index) => address(1000 + index)), delay: 1 });
  await readFeeCollection(f);
  assert.equal(f.peak(), 4); assert.equal(f.active(), 0);
});

test('abort stops queued reads promptly and prevents a cancelled plan from returning data', async () => {
  const pre = new AbortController(); pre.abort();
  const untouched = fixture();
  await assert.rejects(readFeeCollection({ ...untouched, signal: pre.signal }), error => error.name === 'AbortError');
  assert.equal(untouched.calls.length, 0);
  const controller = new AbortController();
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  const f = fixture({ beforeRead: input => input.method === 'eth_call' ? blocked : undefined });
  const task = readFeeCollection({ ...f, signal: controller.signal });
  while (f.calls.length < 6) await new Promise(resolve => setTimeout(resolve, 1));
  const readsAtAbort = f.calls.length;
  controller.abort();
  await assert.rejects(task, error => error.name === 'AbortError');
  release(); await new Promise(resolve => setTimeout(resolve, 2));
  assert.equal(f.calls.length, readsAtAbort); assert.equal(f.active(), 0);
});

test('canonical block and chain changes invalidate the entire fee snapshot', async () => {
  for (const options of [{ reorg: true }, { changedChain: true }, { wrongBlockNumber: true }])
    await assert.rejects(readFeeCollection(fixture(options)), /区块发生变化/);
  await assert.rejects(readFeeCollection(fixture({ chain: '0x1' })), /BSC/);
});

test('huge uint256 balances retain exact wei without floating point conversion', async () => {
  const huge = (1n << 240n) + 1234567890123456789n;
  const f = fixture({ directBnb: huge, directBem: huge, marketOwed: huge, budgetMarketOwed: 0n });
  for (const entry of f.entries.values()) entry.amount = huge;
  const value = await readFeeCollection(f);
  assert.equal(value.totalBnbWei, huge * 6n); assert.equal(value.totalBemWei, huge);
  assert.equal(typeof value.totalBnbWei, 'bigint'); assert.equal(typeof value.directBemWei, 'bigint');
});

test('a real restricted read-only HTTP provider uses the independent wallet only for balance and chain/block proof', async () => {
  const f = fixture(), wallet = fixture(), requests = [];
  const readonly = createReadOnlyHttpProvider({ status: 'ready', rpcUrl: 'https://example.test/api/rpc' }, {
    fetcher: async (_url, options) => {
      const input = JSON.parse(options.body); requests.push(input);
      const result = await f.provider.request(input);
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: input.id, result }), {
        headers: { 'content-type': 'application/json' },
      });
    },
  });
  await assert.rejects(readonly.request({ method: 'eth_getBalance', params: [authority, 'latest'] }),
    error => error.code === 'rpc_method_denied');
  const value = await readFeeCollection({ config: f.config, provider: readonly, balanceProvider: wallet.provider });
  assert.equal(value.directBnbWei, 5n); assert.equal(value.totalBnbWei, 125n);
  assert(!requests.some(request => request.method === 'eth_getBalance'));
  assert.equal(wallet.calls.filter(request => request.method === 'eth_getBalance').length, 1);
  assert(wallet.calls.every(request => ['eth_getBalance', 'eth_chainId', 'eth_getBlockByNumber'].includes(request.method)));
  assert.equal(wallet.calls.filter(request => request.method === 'eth_chainId').length, 2);
  assert.equal(wallet.calls.filter(request => request.method === 'eth_getBlockByNumber').length, 2);
});

test('independent wallet balance provider must prove the same chain and pinned block before and after reading', async () => {
  for (const mutation of ['chain', 'hash', 'number', 'changedChain', 'reorg']) {
    const f = fixture(), wallet = fixture({ changedChain: mutation === 'changedChain', reorg: mutation === 'reorg' });
    const balanceProvider = { async request(input) {
      const value = await wallet.provider.request(input);
      if (input.method === 'eth_chainId' && mutation === 'chain') return '0x1';
      if (input.method === 'eth_getBlockByNumber' && mutation === 'hash') return { ...value, hash: digest('f') };
      if (input.method === 'eth_getBlockByNumber' && mutation === 'number') return { ...value, number: toQuantity(blockNumber + 1n) };
      return value;
    } };
    await assert.rejects(readFeeCollection({ ...f, balanceProvider }), /余额服务的网络或区块/);
    if (['chain', 'hash', 'number'].includes(mutation)) {
      assert(!wallet.calls.some(input => input.method === 'eth_getBalance'));
      assert(!f.calls.some(input => input.method === 'eth_call'));
    }
  }
});

test('both providers share one four-request queue, including the independent balance read', async () => {
  const f = fixture(), wallet = fixture();
  let active = 0, peak = 0;
  const monitored = reader => ({ async request(input) {
    active++; peak = Math.max(peak, active);
    try { await new Promise(resolve => setTimeout(resolve, 1)); return await reader.request(input); }
    finally { active--; }
  } });
  await readFeeCollection({ config: f.config, provider: monitored(f.provider), balanceProvider: monitored(wallet.provider) });
  assert.equal(peak, 4); assert.equal(active, 0);
});

test('abort while proving the independent wallet balance provider prevents subsequent reads', async () => {
  const f = fixture(), controller = new AbortController();
  let release, walletCalls = 0;
  const pending = new Promise(resolve => { release = resolve; });
  const balanceProvider = { async request(input) {
    walletCalls++; await pending;
    return input.method === 'eth_chainId' ? '0x38'
      : { number: toQuantity(blockNumber), hash: blockHash, timestamp: '0x1' };
  } };
  const task = readFeeCollection({ ...f, signal: controller.signal, balanceProvider });
  while (walletCalls < 2) await new Promise(resolve => setTimeout(resolve, 1));
  controller.abort();
  await assert.rejects(task, error => error.name === 'AbortError');
  release(); await new Promise(resolve => setTimeout(resolve, 1));
  assert.equal(walletCalls, 2); assert.equal(f.calls.length, 2);
});
