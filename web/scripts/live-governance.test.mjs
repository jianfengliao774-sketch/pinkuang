import test from 'node:test';
import assert from 'node:assert/strict';
import { firstoProvider, runtime } from '../../deploy/scripts/fixtures/firsto-order.mjs';
import { FIRSTO_SIGNED_EXCHANGE } from '../../deploy/src/firsto-purchase.mjs';
import { Interface } from 'ethers';
const capability = new Interface(['function controlledFirstoSaleVersion() view returns(uint8)']);
const saleViews = new Interface([
  'function saleReference(address pool) view returns(uint128 marketPriceWei,uint64 observedAt,bytes32 sourceDigest)',
  'function saleReview(address pool,uint256 proposalId) view returns(uint8 status,uint128 priceWei)',
]);
import { abi } from '../lib/chain-client.mjs';
import { governanceAction, readGovernanceSnapshot } from '../lib/live-governance.mjs';

const factory = '0x1000000000000000000000000000000000000001';
const pool = '0x2000000000000000000000000000000000000002';
const account = '0x3000000000000000000000000000000000000003';
const market = '0x4000000000000000000000000000000000000004';
const blockHash = `0x${'ab'.repeat(32)}`;
const digest = `0x${'cd'.repeat(32)}`;
const proposal = (overrides = {}) => ({ proposer: account, snapshotTs: 1700000000n,
  endsAt: 1700086400n, refAt: 1699990000n, price: 20n, refPrice: 20n,
  snapshotMemberCount: 3n, snapshotTotalShares: 100n, yesCount: 0n,
  yesShares: 0n, executed: false, ...overrides });

function rpc({ chain = '0x38', timestamp = 1700000100n, state = 2n,
  activeId = 1n, proposals = [proposal(), proposal({ price: 9n, yesCount: 2n, yesShares: 51n })],
  purchased = 10n, listedId = 0n, salePrice = 0n, expiresAt = 0n,
  factoryBinding = factory, alreadyVoted = false, oldSale = false, firsto = {},
  referencePrice = 8n, referenceAt = timestamp - 100n, referenceDigest = digest,
  reviewStatus = 0n, reviewPrice = 0n, referenceReadError = false, reviewReadError = false } = {}) {
  const external = firstoProvider({ account }, firsto).provider;
  return { request: async ({ method, params = [] }) => {
    if (method === 'eth_getStorageAt' || method === 'eth_getCode' && [FIRSTO_SIGNED_EXCHANGE, runtime.implementation].some(a => a.toLowerCase() === params[0].toLowerCase()) || method === 'eth_call' && params[0].to.toLowerCase() === FIRSTO_SIGNED_EXCHANGE.toLowerCase()) return external.request({ method, params });
    if (method === 'eth_call' && params[0].data === capability.encodeFunctionData('controlledFirstoSaleVersion')) {
      if (oldSale) throw new Error('old implementation');
      return capability.encodeFunctionResult('controlledFirstoSaleVersion', [1]);
    }
    if (method === 'eth_call' && params[0].to.toLowerCase() === market.toLowerCase()) {
      const parsed = saleViews.parseTransaction({ data: params[0].data });
      if (parsed?.name === 'saleReference') {
        if (referenceReadError) throw new Error('reference unavailable');
        return saleViews.encodeFunctionResult('saleReference', [referencePrice, referenceAt, referenceDigest]);
      }
      if (parsed?.name === 'saleReview') {
        if (reviewReadError) throw new Error('review unavailable');
        return saleViews.encodeFunctionResult('saleReview', [reviewStatus, reviewPrice]);
      }
      return abi.ShareMarket.encodeFunctionResult('factory', [factoryBinding]);
    }
    if (method === 'eth_chainId') return chain;
    if (method === 'eth_getBlockByNumber') return { number: '0x1234', hash: blockHash, timestamp: `0x${timestamp.toString(16)}` };
    if (method === 'eth_getCode') return '0x1234';
    if (method !== 'eth_call') throw new Error(`Unexpected ${method}`);
    assert.equal(params[1], '0x1234');
    const tx = params[0];
    const iface = tx.to.toLowerCase() === factory.toLowerCase() ? abi.PoolFactory : abi.PoolVault;
    const parsed = iface.parseTransaction({ data: tx.data });
    const values = {
      isPool: true, factory: factoryBinding, OFFICIAL_FACTORY: factoryBinding, shareMarket: market,
      state, purchaseCost: purchased, activatedAt: 1699000000n,
      activeProposalId: activeId, nextProposalId: activeId === 0n ? 1n : activeId + BigInt(proposals.length),
      lastProposed: 0n, balanceOf: 30n, listedProposalId: listedId,
      expiresAt, salePrice, getPastShares: 30n,
      hasVoted: alreadyVoted,
    };
    if (parsed.name === 'getProposal') values.getProposal = proposals[Number(parsed.args[0] - activeId)];
    if (parsed.name === 'proposalPassed') {
      const p = proposals[Number(parsed.args[0] - activeId)];
      values.proposalPassed = p.yesCount * 2n > p.snapshotMemberCount
        && p.yesShares > 50n;
    }
    if (!(parsed.name in values)) throw new Error(`Unmocked ${parsed.name}`);
    return iface.encodeFunctionResult(parsed.name, [values[parsed.name]]);
  } };
}

test('enumerates competing prices in one frozen round and permits voting for either', async () => {
  const snap = await readGovernanceSnapshot(rpc(), { factory, pool, account });
  assert.deepEqual(snap.candidates.map(item => item.id), [1n, 2n]);
  assert.equal(snap.candidates[1].discounted, false, 'historical purchase cost does not set the discount');
  assert.equal(snap.candidates[1].requiredYesShares, 51n);
  assert.equal(snap.candidates[1].requiredYesCount, 2n);
  assert.equal(snap.candidates[1].passed, true);
  const vote = governanceAction(snap, account, { kind: 'vote', proposalId: '2', support: true });
  assert.deepEqual(Array.from(abi.PoolVault.parseTransaction({ data: vote.transaction.data }).args), [2n, true]);
  assert.equal(vote.transaction.value, '0x0');
  const oppose = governanceAction(snap, account, { kind: 'vote', proposalId: '1', support: false });
  assert.deepEqual(Array.from(abi.PoolVault.parseTransaction({ data: oppose.transaction.data }).args), [1n, false]);
  assert.equal(oppose.transaction.to, pool);
  const voted = await readGovernanceSnapshot(rpc({ alreadyVoted: true }), { factory, pool, account });
  assert.throws(() => governanceAction(voted, account, { kind: 'vote', proposalId: '1', support: false }), /cannot vote again/);
  const execution = governanceAction(snap, account, { kind: 'executeSale', proposalId: '2' });
  assert.equal(abi.PoolVault.parseTransaction({ data: execution.transaction.data }).name, 'executeSale');
  assert.throws(() => governanceAction(snap, account, { kind: 'executeSale', proposalId: '1' }), /threshold/);
});

test('execution requires a fresh Firsto reference and exact platform review below that reference', async () => {
  const input = { referencePrice: 10n };
  const pending = await readGovernanceSnapshot(rpc(input), { factory, pool, account });
  assert.equal(pending.candidates[1].passed, true);
  assert.equal(pending.candidates[1].discounted, true);
  assert.equal(pending.candidates[1].canExecute, false);
  assert.throws(() => governanceAction(pending, account, { kind: 'executeSale', proposalId: '2' }), /reference or required platform review/);

  const approved = await readGovernanceSnapshot(rpc({ ...input, reviewStatus: 1n, reviewPrice: 9n }), { factory, pool, account });
  assert.equal(approved.candidates[1].reviewApproved, true);
  assert.equal(approved.candidates[1].canExecute, true);
  assert.equal(governanceAction(approved, account, { kind: 'executeSale', proposalId: '2' }).quote.marketReferenceWei, 10n);

  for (const change of [{ reviewStatus: 1n, reviewPrice: 8n }, { reviewStatus: 2n, reviewPrice: 9n },
    { referenceAt: 1699999199n, reviewStatus: 1n, reviewPrice: 9n },
    { referenceDigest: `0x${'00'.repeat(32)}`, reviewStatus: 1n, reviewPrice: 9n },
    { referenceReadError: true }, { reviewReadError: true }]) {
    const blocked = await readGovernanceSnapshot(rpc({ ...input, ...change }), { factory, pool, account });
    assert.equal(blocked.candidates[1].canExecute, false);
    assert.throws(() => governanceAction(blocked, account, { kind: 'executeSale', proposalId: '2' }), /reference or required platform review/);
  }
});

test('rejects legacy timestamp-minus-one proposals and foreign pool bindings', async () => {
  const legacy = await readGovernanceSnapshot(rpc({ proposals: [proposal({ snapshotTs: 1699999999n })] }), { factory, pool, account });
  assert.equal(legacy.candidates.length, 0);
  assert.throws(() => governanceAction(legacy, account, { kind: 'vote', proposalId: '1', support: true }), /not open/);
  const expired = await readGovernanceSnapshot(rpc({ timestamp: 1700605000n,
    proposals: [proposal({ snapshotTs: 1699999999n })] }), { factory, pool, account });
  const nextRound = governanceAction(expired, account, { kind: 'propose',
    priceWei: '10', refPriceWei: '10', refAt: '1700604000' });
  assert.equal(abi.PoolVault.parseTransaction({ data: nextRound.transaction.data }).name, 'propose');
  await assert.rejects(readGovernanceSnapshot(rpc({ factoryBinding: pool }), { factory, pool, account }), /not registered/);
  await assert.rejects(readGovernanceSnapshot(rpc({ chain: '0x1' }), { factory, pool, account }), /BSC mainnet/);
});

test('reports the seven-day activation lock separately from valid sale prices', async () => {
  const fresh = await readGovernanceSnapshot(rpc({ timestamp: 1699000100n, activeId: 0n,
    proposals: [] }), { factory, pool, account });
  assert.equal(fresh.state, 2n);
  assert.equal(fresh.shares, 30n);
  assert.throws(() => governanceAction(fresh, account, { kind: 'propose',
    priceWei: '40000000000000000', refPriceWei: '40000000000000000',
    refAt: fresh.timestamp.toString() }), /激活满 7 天/);
});

test('sale payment uses the current listed price and never a UI-supplied amount', async () => {
  const live = await readGovernanceSnapshot(rpc({ state: 3n, proposals: [proposal({ price: 1000n, executed: true })],
    listedId: 1n, salePrice: 1000n, expiresAt: 1700000200n }), { factory, pool, account });
  const sale = governanceAction(live, account, { kind: 'completeFirstoSale', priceWei: '1' });
  assert.equal(sale.transaction.value, '0x3f2');
  assert.equal(sale.quote.sourceFeeWei, 10n);
  assert.deepEqual(Array.from(abi.PoolVault.parseTransaction(sale.transaction).args), [1n, 1000n, 100n, 1n]);
  for (const expected of [{expectedFeeBps:'200'}, {expectedFeeEpoch:'2'}, {expectedPriceWei:'999'}, {expectedProposalId:'2'}])
    assert.throws(() => governanceAction(live, account, {kind:'completeFirstoSale',...expected}), /changed/);
  assert.throws(() => governanceAction(live, account, {kind:'completeSale'}), /Unsupported/);
  assert.equal(sale.quote.feeWei, 10n);
  assert.equal(sale.quote.holderNetWei, 990n);
  assert.throws(() => governanceAction(live, account, { kind: 'vote', proposalId: '1', support: true }), /not open/);
  const expired = await readGovernanceSnapshot(rpc({ state: 3n, proposals: [proposal({ price: 1000n, executed: true })],
    listedId: 1n, salePrice: 1000n, expiresAt: 1700000100n }), { factory, pool, account });
  assert.throws(() => governanceAction(expired, account, { kind: 'completeFirstoSale' }), /not open/);
  assert.equal(abi.PoolVault.parseTransaction({ data: governanceAction(expired, account, { kind: 'cancelExpired' }).transaction.data }).name, 'cancelExpired');
});

test('old sale capability, changed Firsto implementation and fee epoch mismatch fail closed without blocking expiry cleanup', async () => {
  const listed = { state:3n, proposals:[proposal({price:1000n,executed:true})], listedId:1n,
    salePrice:1000n,expiresAt:1700000200n };
  for (const changes of [{oldSale:true},{firsto:{implementationCode:'0x6001'}},{firsto:{values:{feeBpsAtEpoch:200n}}},
    {firsto:{values:{paused:true}}},{firsto:{values:{SIGNED_ASK_SCHEMA_VERSION:3n}}}]) {
    const snapshot = await readGovernanceSnapshot(rpc({...listed,...changes}),{factory,pool,account});
    assert.equal(snapshot.firstoSale.available,false);
    assert.throws(()=>governanceAction(snapshot,account,{kind:'completeFirstoSale'}),/核验/);
  }
  const expired = await readGovernanceSnapshot(rpc({...listed,oldSale:true,timestamp:1700000200n}),{factory,pool,account});
  assert.equal(governanceAction(expired,account,{kind:'cancelExpired'}).quote.action,'cancelExpired');
});
