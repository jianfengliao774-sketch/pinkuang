import assert from 'node:assert/strict';
import test from 'node:test';
import { ZeroAddress } from 'ethers';
import { abi } from '../lib/chain-client.mjs';
import { budgetApprovalDigest } from '../../deploy/shared/budget-queue.mjs';
import { discoverBudgetPurchasePlan, prepareBudgetQueueStep } from '../lib/budget-purchase-plan.mjs';
import { readPortfolioCurrent } from '../lib/live-portfolios.mjs';
import { portfolioFixture, PORTFOLIOS, address } from './portfolio-fixture.mjs';
import { parseFirstoSignedAsk } from '../../deploy/src/firsto-purchase.mjs';
import { signedSource, now as sourceNow } from '../../deploy/scripts/fixtures/firsto-order.mjs';

const collection = '0xb1024b89886B9a34Aa4ff5F31C411D708b20a14C';
const never = () => { throw new Error('browser proof helper must not run'); };
function fixture() {
  const f = portfolioFixture({ poolState: 1n });
  const config = { ...f.config, productFamily: 'fresh-v4', displayOnly: true, operationalReady: true,
    transactionReady: true, authority: address(0x990), gasWallet: address(0x991) };
  const plan = { version: 1, chainId: 56, id: 'test-direct-budget', revision: 0, approved: true,
    account: f.account, parent: PORTFOLIOS[0], factory: f.manifest.factory, portfolioFactory: f.manifest.portfolioFactory,
    artifactDigest: f.manifest.artifactDigest, budgetWei: '1000', startSpentWei: '0', limitWei: '200', absoluteCapWei: '500',
    unitCapWei: '100', purchaseDeadline: String(BigInt(f.source().indexedTimestamp) + 3n * 86400n),
    items: [{ collection, tokenId: '7', maxCostWei: '200', targetRaiseWei: '200', verifiedWeight: '10',
      venue: 'official', listingId: '9', status: 'ready' }] };
  plan.approvalDigest = budgetApprovalDigest(plan);
  return { ...f, config, plan };
}

test('display queue child creation uses the approved exact plan without parent, miner, runtime or operator rechecks', async () => {
  const f = fixture();
  const result = await prepareBudgetQueueStep({ config: f.config, provider: { request: never }, account: f.account,
    parent: PORTFOLIOS[0], plan: f.plan, index: 0, readParent: never, readMiner: never, prepareCreate: never, readOfficial: never });
  const tx = abi.PoolFactory.parseTransaction(result.transaction);
  assert.equal(tx.name, 'createBudgetChildPool'); assert.equal(tx.args[1], PORTFOLIOS[0]);
  assert.equal(tx.args[0].circuits, collection); assert.equal(tx.args[0].circuitId, 7n);
  assert.equal(tx.args[0].targetRaise, 200n); assert.equal(tx.args[0].priceCap, 200n);
  assert.equal(result.authority.kind, 'executeApprovedOperation'); assert.equal(result.transaction.value, '0x0');
  assert.equal(result.blockNumber, null); assert.equal(result.displayOnly, true);
});

test('display queue official purchase reads its price once and retains exact approval ceilings', async () => {
  const f = fixture(), plan = structuredClone(f.plan); plan.items[0].status = 'created'; plan.items[0].child = address(0x995);
  let reads = 0;
  const readMiner = async (_provider, actualCollection, token, options) => {
    reads++; assert.equal(actualCollection, collection); assert.equal(token, '7'); assert.equal(options.blockTag, 'latest');
    return { registry: null, blockHash: null, displayOnly: true, official: { id: '9', priceWei: '199' } };
  };
  const input = { config: f.config, provider: { request: never }, account: f.account, parent: PORTFOLIOS[0], plan,
    index: 0, readParent: never, readMiner, preparePurchase: never, readOfficial: never, verifyOrder: never };
  const result = await prepareBudgetQueueStep(input), tx = abi.BudgetPortfolioVault.parseTransaction(result.transaction);
  assert.equal(reads, 1); assert.equal(tx.name, 'buyOfficial'); assert.equal(tx.args[0], plan.items[0].child);
  assert.equal(tx.args[1], 9n); assert.equal(result.procurement.priceWei, 199n); assert.equal(result.procurement.capWei, 200n);
  assert.equal(result.authority.args.maxCost, '199'); assert.equal(result.blockNumber, null);
  await assert.rejects(prepareBudgetQueueStep({ ...input,
    readMiner: async () => ({ official: { id: '9', priceWei: '201' } }) }), /approved machine price/);
  await assert.rejects(prepareBudgetQueueStep({ ...input,
    readMiner: async () => ({ official: { id: '10', priceWei: '199' } }) }), /listing changed/);
});

test('display queue Firsto purchase locally decodes the approved order without another miner or signed-order verification', async () => {
  const f = fixture(), source = await signedSource({ price: '100' });
  const order = parseFirstoSignedAsk(source, { collection, tokenId: '7', owner: source.account, now: sourceNow });
  const plan = structuredClone(f.plan);
  Object.assign(plan.items[0], { venue: 'firsto', status: 'created', child: address(0x995), encodedOrder: order.encodedOrder,
    maxCostWei: '101', targetRaiseWei: '200' }); delete plan.items[0].listingId;
  plan.approvalDigest = budgetApprovalDigest(plan);
  const result = await prepareBudgetQueueStep({ config: f.config, provider: { request: never }, account: f.account,
    parent: PORTFOLIOS[0], plan, index: 0, readParent: never, readMiner: never, verifyOrder: never, readOfficial: never });
  assert.equal(result.action.kind, 'buyFirsto'); assert.equal(result.procurement.priceWei, 101n);
  assert.equal(result.authority.kind, 'buyBudgetFirsto'); assert.equal(result.authority.args.encodedOrder, order.encodedOrder);
});

test('display queue discovery uses cached parent business data without browser RPC calls', async () => {
  const f = fixture(), requests = [];
  const row = await readPortfolioCurrent(f.config, { request: input => f.request({ ...input,
    params: [input.params[0], '0x64'] }) }, PORTFOLIOS[0], f.account, { includeChildren: false });
  const provider = { async request(input) {
    requests.push(input); assert.equal(input.method, 'eth_call'); return f.request(input);
  } };
  const fetcher = async url => {
    const u = new URL(url, f.config.origin);
    if (u.pathname.includes('/v1/display/')) return new Response(JSON.stringify({ source: { ...f.source(),
      cacheOrigin: 'server', displayOnly: true, transactionReady: false, readMode: 'display' }, data: { item: row } },
      (_key, value) => typeof value === 'bigint' ? { $bemineBigInt: value.toString() } : value),
      { headers: { 'content-type': 'application/json' } });
    const body = u.pathname.endsWith('/budget-candidates') ? { complete: true, chainId: 56, parent: PORTFOLIOS[0],
      factory: f.manifest.portfolioFactory, legacyFactory: f.manifest.factory, artifactDigest: f.manifest.artifactDigest,
      budgetWei: '5000000000000000', spentWei: '0', absoluteCapWei: '3000000000000000', unitCapWei: '100000000000',
      snapshot: { complete: true, blockNumber: 100, blockHash: f.source().indexedBlockHash },
      candidates: [{ collection, tokenId: '7', costWei: '200', verifiedWeight: '10', venue: 'official', listingId: '9' }] }
      : f.index(u.href);
    if (!u.pathname.endsWith('/budget-candidates')) body.source = f.source();
    return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
  };
  const result = await discoverBudgetPurchasePlan({ config: f.config, provider, account: f.account, parent: PORTFOLIOS[0],
    limitWei: 200n, fetcher, quotePage: never });
  assert.equal(requests.length, 0); assert.equal(result.items[0].maxCostWei, '200');
  assert.equal(result.items[0].targetRaiseWei, '200');
  assert(requests.every(input => input.params[1] === '0x64'));
  assert(!requests.some(input => abi.BudgetPortfolioFactory.parseTransaction(input.params[0])?.name === 'operator'));
});
