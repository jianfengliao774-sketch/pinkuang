import test from 'node:test';
import assert from 'node:assert/strict';
import { Interface, getAddress, keccak256, toQuantity } from 'ethers';
import { abi } from '../lib/chain-client.mjs';
import { readFeeCollection } from '../lib/fee-collection.mjs';
import { readFeeCollectionHistory } from '../lib/fee-collection-history.mjs';
import { readSaleReviewRequests, refreshSaleReviewRequest } from '../lib/sale-review-requests.mjs';
import { portfolioFixture, address, PORTFOLIOS } from './portfolio-fixture.mjs';

const token = getAddress('0x5ce033B2bFCa3Af30b3e8C8457DeaF776A8b695a');
const hash = value => `0x${value.repeat(64)}`;
function configuration() {
  const base = portfolioFixture(), authority = address(501), gasWallet = address(502);
  const manifest = { ...base.manifest, authority, gasWallet, freshAuthority: {
    address: authority, gasWallet, administratorOne: base.account, administratorTwo: address(504),
    codehash: keccak256('0x6000'), deploymentTxHash: hash('d'),
  } };
  return { ...base.config, ...manifest, manifest, displayOnly: true, operationalReady: false, transactionReady: false };
}

test('direct fees retain all exact balances, source enumeration and batches without deployment proofs', async () => {
  const config = configuration(), corePool = address(1000), portfolio = address(2000), seen = [];
  const tokenAbi = new Interface(['function balanceOf(address) view returns(uint256)']);
  const provider = { request: async input => {
    seen.push(input);
    const { method, params } = input;
    if (method === 'eth_getBalance') { assert.deepEqual(params, [config.authority, 'latest']); return '0x5'; }
    assert.equal(method, 'eth_call'); assert.equal(params[1], 'latest');
    const target = getAddress(params[0].to);
    const contract = target === config.factory ? abi.PoolFactory : target === config.portfolioFactory ? abi.BudgetPortfolioFactory
      : target === token ? tokenAbi : [config.shareMarket, config.portfolioMarket].includes(target) ? abi.ShareMarket : abi.PoolVault;
    const call = contract.parseTransaction(params[0]);
    const values = { poolCount: 1n, portfolioCount: 1n, allPools: corePool, portfolioAt: portfolio,
      balanceOf: 7n, bnbOwed: target === config.shareMarket ? 30n : target === config.portfolioMarket ? 40n : target === corePool ? 10n : 20n };
    assert(Object.hasOwn(values, call.name), `unexpected proof getter ${call.name}`);
    return contract.encodeFunctionResult(call.fragment, [values[call.name]]);
  } };
  const plan = await readFeeCollection({ config, provider });
  assert.equal(plan.totalBnbWei, 105n); assert.equal(plan.totalBemWei, 7n);
  assert.deepEqual(plan.pools, [corePool, portfolio]); assert.equal(plan.blockNumber, null); assert.equal(plan.blockHash, null);
  assert.equal(seen.length, 10); assert.equal(plan.batches.length, 1);
  assert.equal(plan.displayOnly, true);
  const cached = await readFeeCollection({ config: { ...config }, provider });
  assert.equal(cached, plan); assert.equal(seen.length, 10, 'returning to fees reuses exact balances');
  await Promise.all([readFeeCollection({ config, provider, refreshToken: 1 }),
    readFeeCollection({ config, provider, refreshToken: 1 })]);
  assert.equal(seen.length, 20, 'pushed invalidation performs one shared scan');
  await readFeeCollection({ config, provider, refreshToken: 1, force: true });
  assert.equal(seen.length, 30, 'manual refresh bypasses cached balances');
  await readFeeCollection({ config, provider, refreshToken: 1, account: address(600) });
  assert.equal(seen.length, 40, 'another administrator has a separate read context');
});

test('direct fee history keeps pagination and administrator amounts with no receipt or deployment verification', async () => {
  const config = configuration(), seen = [], topic = abi.PlatformAuthority.getEvent('FeesClaimed');
  const blockNumber = 200n, logBlock = 150n, encoded = abi.PlatformAuthority.encodeEventLog(topic,
    [config.freshAuthority.administratorOne, 123456789012345n, 456n]);
  const event = { ...encoded, address: config.authority, removed: false,
    blockNumber: toQuantity(logBlock), transactionIndex: '0x0', logIndex: '0x0',
    blockHash: hash('c'), transactionHash: hash('e') };
  const provider = { request: async input => {
    seen.push(input);
    if (input.method === 'eth_getBlockByNumber') return { number: input.params[0] === 'finalized' ? toQuantity(blockNumber)
      : input.params[0] === 'latest' ? toQuantity(blockNumber + 2n) : input.params[0],
      hash: hash('c'), timestamp: '0x6b49d200' };
    assert.equal(input.method, 'eth_getLogs'); assert.equal(input.params[0].address, config.authority);
    assert.deepEqual(input.params[0].topics, [topic.topicHash]); return [event];
  } };
  const result = await readFeeCollectionHistory({ config, provider });
  assert.equal(result.rows.length, 1); assert.equal(result.rows[0].administrator, config.freshAuthority.administratorOne);
  assert.equal(result.rows[0].bnbAmountWei, 123456789012345n); assert.equal(result.rows[0].bemAmountWei, 456n);
  assert.equal(result.rows[0].timestamp, 1800000000n); assert.equal(result.complete, true); assert.equal(result.displayOnly, true);
  assert.deepEqual(seen[0], { method: 'eth_getBlockByNumber', params: ['finalized', false] });
  assert.equal(seen[1].params[0].toBlock, toQuantity(blockNumber), 'history starts at the settled head, not the newer latest block');
  assert.deepEqual(seen.map(input => input.method), ['eth_getBlockByNumber', 'eth_getLogs', 'eth_getBlockByNumber']);
  assert.equal(seen.some(input => ['eth_getTransactionReceipt', 'eth_getCode', 'eth_call', 'eth_chainId'].includes(input.method)), false,
    'direct history does not add receipt or deployment proof requests');
  const cached = await readFeeCollectionHistory({ config, provider });
  assert.equal(cached.cached, true); assert.equal(seen.length, 3, 'cached history must not issue another proof round');
});

test('direct review inbox keeps proposals and approval eligibility despite false graph readiness flags', async () => {
  const f = portfolioFixture({ poolState: 2n, activeProposalId: 1n, nextProposalId: 2n });
  const config = { ...f.config, displayOnly: true, operationalReady: false, transactionReady: false };
  const provider = { request: input => {
    assert.equal(input.method, 'eth_call');
    const contract = input.params[0].to === config.shareMarket ? abi.ShareMarket : abi.BudgetPortfolioVault;
    const parsed = contract.parseTransaction(input.params[0]);
    assert(!['OFFICIAL_FACTORY', 'legacyFactory', 'factory', 'isPool', 'portfolioCount'].includes(parsed.name));
    return f.request(input);
  } };
  const page = await readSaleReviewRequests({ config, provider, fetcher: f.fetcher,
    now: () => Number(f.source().indexedTimestamp) * 1000, scope: 'portfolio' });
  assert.equal(page.errors.length, 0); assert.equal(page.items.length, 2);
  assert(page.items.every(item => item.canReview && item.displayOnly && item.status === 'pending'));
  assert.equal(page.source.transactionReady, false);
  const callsBefore = f.calls.length;
  const item = await refreshSaleReviewRequest({ config, provider, item: page.items[0] });
  assert.equal(item.project, PORTFOLIOS[0]); assert.equal(f.calls.length, callsBefore, 'selected review must not repeat all project reads');
  await assert.rejects(refreshSaleReviewRequest({ config, provider, item: { ...item, priceWei: '-1' } }));
  const options = { config, provider, fetcher: f.fetcher, now: () => Number(f.source().indexedTimestamp) * 1000, scope: 'portfolio' };
  assert.equal(await readSaleReviewRequests(options), page); assert.equal(f.calls.length, callsBefore);
  const reread = await Promise.all([readSaleReviewRequests({ ...options, refreshToken: 1 }),
    readSaleReviewRequests({ ...options, refreshToken: 1 })]);
  assert.equal(reread[0], reread[1]); assert.equal(f.calls.length, callsBefore * 2, 'changed revision shares one proposal read');
  await readSaleReviewRequests({ ...options, refreshToken: 1, force: true });
  assert.equal(f.calls.length, callsBefore * 3);
});
