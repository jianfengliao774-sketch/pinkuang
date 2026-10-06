import assert from 'node:assert/strict';
import test from 'node:test';
import { ZeroAddress } from 'ethers';
import { abi } from '../lib/chain-client.mjs';
import { createLiveDataClient, displayIndexSource, validateIndexSource } from '../lib/live-data.mjs';
import { readPortfolioPage, readPortfolioDisplayRow, readPortfolioOrders,
  preparePortfolioAction, portfolioSelectedActionReady } from '../lib/live-portfolios.mjs';
import { portfolioFixture, PORTFOLIOS } from './portfolio-fixture.mjs';

function fixture(options = {}) {
  const f = portfolioFixture(options);
  const config = { ...f.config, productFamily: 'fresh-v4', operationalReady: true,
    readMode: 'current', stale: false, transactionReady: true };
  const fetcher = async url => {
    const result = f.index(url);
    result.source = f.source();
    if (new URL(url).pathname.endsWith('/v1/pools') || new URL(url).pathname.endsWith('/v1/stats'))
      Object.assign(result.data, { registeredPoolCount: String(f.base.rows.length),
        standalonePoolCount: String(f.base.rows.length), childPoolCount: '0',
        reservedChildPoolCount: '0', reservedChildPoolAddresses: [], reservedChildPoolAddressesComplete: true });
    return new Response(JSON.stringify(result), { headers: { 'content-type': 'application/json' } });
  };
  const methods = [], provider = { async request(input) {
    methods.push(input);
    assert.equal(input.method, 'eth_call', 'ordinary browsing must not read headers, runtime code, storage, or chain identity');
    return f.request(input);
  } };
  const client = createLiveDataClient(config, { provider, fetcher, verificationStorage: null });
  return { ...f, config, fetcher, methods, provider, client };
}

test('fresh statistics, activity and yield use index data without any RPC', async () => {
  const f = fixture(), pool = f.base.rows[0].pool;
  const stats = await f.client.readStats();
  assert.equal(stats.data.scope, 'confirmed_indexed_history');
  assert.equal(stats.data.currentlyActivePoolCount, null);
  const activity = await f.client.readActivity();
  const yieldResult = await f.client.readYield({ pool, account: f.account, days: 7 });
  for (const result of [stats, activity, yieldResult]) {
    assert.equal(result.source.displayOnly, true);
    assert.equal(result.source.transactionReady, false);
  }
  assert.equal(f.methods.length, 0);
});

test('ordinary pool list and detail use one Lens business call, positions add only market credit', async () => {
  const f = fixture();
  const list = await f.client.readPools({ account: f.account });
  assert.equal(f.methods.length, 1);
  assert.equal(abi.PoolLens.parseTransaction(f.methods[0].params[0]).name, 'positions');
  assert.equal(list.items.length, 4);
  assert.equal(list.items[0].shares, f.base.rows[0].shares);
  assert.equal(list.snapshot.displayOnly, true);
  await f.client.readPool({ pool: f.base.rows[0].pool, account: f.account });
  assert.equal(f.methods.length, 2);
  const positions = await f.client.readPositions({ account: f.account });
  assert.equal(f.methods.length, 4);
  assert(positions.marketBnbOwed > 0n);
  assert.equal(positions.source.transactionReady, false);
});

test('display source remains exact and cannot disable local identity, expiry, or pagination parsing', async () => {
  const f = fixture(), source = displayIndexSource(f.source());
  assert.equal(validateIndexSource(source, f.manifest).transactionReady, false);
  assert.throws(() => validateIndexSource({ ...source, factory: f.account }, f.manifest), { code: 'index_identity' });
  assert.throws(() => validateIndexSource({ ...source, checkedAt: '2020-01-01T00:00:00Z' }, f.manifest), { code: 'index_stale' });
  const index = f.index;
  f.index = url => index(url);
  const brokenFetch = async url => {
    const reply = index(url); reply.source = f.source();
    reply.data.items = [...reply.data.items, reply.data.items[0]];
    return new Response(JSON.stringify(reply), { headers: { 'content-type': 'application/json' } });
  };
  const client = createLiveDataClient(f.config, { provider: f.provider, fetcher: brokenFetch });
  await assert.rejects(client.readActivity(), { code: 'invalid_activity' });
  assert.equal(f.methods.length, 0);
});

test('portfolio detail reads 27 real business fields without deployment, registration or canonical RPC', async () => {
  const f = fixture(), result = await readPortfolioDisplayRow(f.config, f.provider, PORTFOLIOS[0], f.account, { fetcher: f.fetcher });
  assert.equal(f.methods.length, 27);
  assert.equal(result.item.shares, 10n);
  assert.equal(result.item.availableShares, 10n);
  assert.equal(result.item.claimableBem, 100n);
  assert.equal(result.item.displayOnly, true);
  assert.equal(result.source.transactionReady, false);
  assert.equal(result.operator, null, 'static deployment must not pretend to grant an operator role');
  assert(f.methods.every(input => input.params[1] === '0x64'));
  const names = f.methods.map(input => abi.BudgetPortfolioVault.parseTransaction(input.params[0]).name);
  assert(!names.includes('isPool'));
  assert(names.includes('lockedShares') && names.includes('shareTradingAllowed'));
});

test('portfolio directory and details share a 12-call budget and preserve account-bound balances', async () => {
  const f = fixture(); let active = 0, peak = 0;
  const provider = { async request(input) {
    assert.equal(input.method, 'eth_call'); active++; peak = Math.max(peak, active);
    try { await new Promise(resolve => setTimeout(resolve, 2)); return await f.request(input); }
    finally { active--; }
  } };
  const [page, detail] = await Promise.all([
    readPortfolioPage(f.config, provider, { account: f.account, fetcher: f.fetcher }),
    readPortfolioDisplayRow(f.config, provider, PORTFOLIOS[0], ZeroAddress, { fetcher: f.fetcher }),
  ]);
  assert.equal(page.items.length, 2); assert.equal(page.items[0].shares, 10n);
  assert.equal(detail.item.shares, 0n); assert.equal(detail.item.account, ZeroAddress);
  assert(peak > 1 && peak <= 12, `peak=${peak}`); assert.equal(active, 0);
});

test('portfolio order page reads only the requested orders and expiry business fields', async () => {
  const f = fixture();
  const orders = await readPortfolioOrders(f.config, f.provider, PORTFOLIOS[0], { fetcher: f.fetcher });
  assert.equal(f.methods.length, 2);
  assert.equal(orders.items[0].remaining, 5n);
  assert.equal(orders.source.displayOnly, true);
});

test('display data can only open a preview; actual preparation independently rejects a bad deployment', async () => {
  const f = fixture();
  await readPortfolioDisplayRow(f.config, f.provider, PORTFOLIOS[0], f.account, { fetcher: f.fetcher });
  assert.equal(portfolioSelectedActionReady({ config: f.config, selectedProofCurrent: true, action: 'deposit' }), true);
  f.state.badCode = true;
  await assert.rejects(preparePortfolioAction({ config: f.config, provider: { request: f.request },
    account: f.account, pool: PORTFOLIOS[0], action: { kind: 'deposit', quantity: '1' } }), /代码与核验清单不一致/);
  assert(f.calls.some(input => input.method === 'eth_getCode'));
  assert.equal(f.simulations.length, 0);
});

function directFixture(options = {}) {
  const f = fixture(options), calls = [];
  const provider = { async request(input) {
    calls.push(input); assert.equal(input.method, 'eth_call'); assert.equal(input.params[1], 'latest');
    return f.request({ ...input, params: [input.params[0], '0x64'] });
  } };
  return { ...f, config: { ...f.config, displayOnly: true }, provider, calls };
}

test('display-mode portfolio creation and zero-value actions encode without role or deployment reads', async () => {
  const f = directFixture({ badCode: true, lockedShares: 10n, trading: false });
  const funding = String(Math.floor(Date.now() / 1000) + 86400), purchase = String(BigInt(funding) + 86400n);
  const created = await preparePortfolioAction({ config: f.config, provider: f.provider, account: f.account,
    action: { kind: 'createPortfolio', budget: '1', absoluteCap: '0.5', unitCap: '0.1', fundingDeadline: funding, purchaseDeadline: purchase } });
  assert.equal(created.blockNumber, null); assert.equal(created.displayOnly, true);
  assert.equal(abi.BudgetPortfolioFactory.parseTransaction(created.transaction).name, 'createPortfolio');
  for (const action of [{ kind: 'withdrawDeposit' }, { kind: 'marketCancel', orderId: '1' },
    { kind: 'transfer', recipient: PORTFOLIOS[1], quantity: '3' }, { kind: 'voteChildSale', proposalId: '1', support: true }]) {
    const result = await preparePortfolioAction({ config: f.config, provider: f.provider, account: f.account, pool: PORTFOLIOS[0], action });
    assert.equal(result.transaction.value, '0x0'); assert.equal(result.blockNumber, null);
  }
  assert.equal(f.calls.length, 0);
});

test('portfolio deposit and market fill read only exact amounts needed for calldata', async () => {
  const f = directFixture();
  const deposit = await preparePortfolioAction({ config: f.config, provider: f.provider, account: f.account,
    pool: PORTFOLIOS[0], action: { kind: 'deposit', quantity: '3' } });
  assert.equal(BigInt(deposit.transaction.value), 150000000000000n);
  assert.equal(f.calls.length, 1);
  assert.equal(abi.BudgetPortfolioVault.parseTransaction(f.calls[0].params[0]).name, 'budgetWei');
  const fill = await preparePortfolioAction({ config: f.config, provider: f.provider, account: f.account,
    pool: PORTFOLIOS[0], action: { kind: 'marketFill', orderId: '1', quantity: '3' } });
  assert.equal(BigInt(fill.transaction.value), 303n); assert.equal(f.calls.length, 4);
  const decoded = abi.ShareMarket.parseTransaction(fill.transaction);
  assert.equal(decoded.name, 'fill'); assert.deepEqual([...decoded.args], [1n, 3n]);
  await assert.rejects(preparePortfolioAction({ config: f.config, provider: f.provider, account: f.account,
    pool: PORTFOLIOS[0], action: { kind: 'deposit', quantity: '1.5' } }));
  assert.equal(f.calls.length, 4, 'invalid local quantity must fail before a business read');
});
