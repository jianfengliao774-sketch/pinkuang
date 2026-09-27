import test from 'node:test';
import assert from 'node:assert/strict';
import { abi } from '../lib/chain-client.mjs';
import { governanceAction, readGovernanceSnapshot } from '../lib/live-governance.mjs';

const factory = '0x1000000000000000000000000000000000000001';
const pool = '0x2000000000000000000000000000000000000002';
const account = '0x3000000000000000000000000000000000000003';
const blockHash = `0x${'ab'.repeat(32)}`;
const proposal = (overrides = {}) => ({ proposer: account, snapshotTs: 1700000000n,
  endsAt: 1700086400n, refAt: 1699990000n, price: 20n, refPrice: 20n,
  snapshotMemberCount: 3n, snapshotTotalShares: 100n, yesCount: 0n,
  yesShares: 0n, executed: false, ...overrides });

function rpc({ chain = '0x38', timestamp = 1700000100n, state = 2n,
  activeId = 1n, proposals = [proposal(), proposal({ price: 9n, yesCount: 2n, yesShares: 60n })],
  purchased = 10n, listedId = 0n, salePrice = 0n, expiresAt = 0n,
  factoryBinding = factory } = {}) {
  return { request: async ({ method, params = [] }) => {
    if (method === 'eth_chainId') return chain;
    if (method === 'eth_getBlockByNumber') return { number: '0x1234', hash: blockHash, timestamp: `0x${timestamp.toString(16)}` };
    if (method === 'eth_getCode') return '0x1234';
    if (method !== 'eth_call') throw new Error(`Unexpected ${method}`);
    assert.equal(params[1], '0x1234');
    const tx = params[0];
    const iface = tx.to.toLowerCase() === factory.toLowerCase() ? abi.PoolFactory : abi.PoolVault;
    const parsed = iface.parseTransaction({ data: tx.data });
    const values = {
      isPool: true, factory: factoryBinding, OFFICIAL_FACTORY: factoryBinding,
      state, purchaseCost: purchased, activatedAt: 1699000000n,
      activeProposalId: activeId, nextProposalId: activeId === 0n ? 1n : activeId + BigInt(proposals.length),
      lastProposed: 0n, balanceOf: 30n, listedProposalId: listedId,
      expiresAt, salePrice, getPastShares: 30n,
      hasVoted: false,
    };
    if (parsed.name === 'getProposal') values.getProposal = proposals[Number(parsed.args[0] - activeId)];
    if (parsed.name === 'proposalPassed') {
      const p = proposals[Number(parsed.args[0] - activeId)];
      values.proposalPassed = p.yesCount * 2n > p.snapshotMemberCount
        && (p.price < purchased ? p.yesShares >= 60n : p.yesShares > 50n);
    }
    if (!(parsed.name in values)) throw new Error(`Unmocked ${parsed.name}`);
    return iface.encodeFunctionResult(parsed.name, [values[parsed.name]]);
  } };
}

test('enumerates competing prices in one frozen round and permits voting for either', async () => {
  const snap = await readGovernanceSnapshot(rpc(), { factory, pool, account });
  assert.deepEqual(snap.candidates.map(item => item.id), [1n, 2n]);
  assert.equal(snap.candidates[1].discounted, true);
  assert.equal(snap.candidates[1].requiredYesShares, 60n);
  assert.equal(snap.candidates[1].requiredYesCount, 2n);
  assert.equal(snap.candidates[1].passed, true);
  const vote = governanceAction(snap, account, { kind: 'vote', proposalId: '2', support: true });
  assert.deepEqual(Array.from(abi.PoolVault.parseTransaction({ data: vote.transaction.data }).args), [2n, true]);
  assert.equal(vote.transaction.value, '0x0');
  const execution = governanceAction(snap, account, { kind: 'executeSale', proposalId: '2' });
  assert.equal(abi.PoolVault.parseTransaction({ data: execution.transaction.data }).name, 'executeSale');
  assert.throws(() => governanceAction(snap, account, { kind: 'executeSale', proposalId: '1' }), /threshold/);
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

test('sale payment uses the current listed price and never a UI-supplied amount', async () => {
  const live = await readGovernanceSnapshot(rpc({ state: 3n, proposals: [proposal({ price: 1000n, executed: true })],
    listedId: 1n, salePrice: 1000n, expiresAt: 1700000200n }), { factory, pool, account });
  const sale = governanceAction(live, account, { kind: 'completeSale', priceWei: '1' });
  assert.equal(sale.transaction.value, '0x3e8');
  assert.equal(sale.quote.feeWei, 10n);
  assert.equal(sale.quote.holderNetWei, 990n);
  assert.throws(() => governanceAction(live, account, { kind: 'vote', proposalId: '1', support: true }), /not open/);
  const expired = await readGovernanceSnapshot(rpc({ state: 3n, proposals: [proposal({ price: 1000n, executed: true })],
    listedId: 1n, salePrice: 1000n, expiresAt: 1700000100n }), { factory, pool, account });
  assert.throws(() => governanceAction(expired, account, { kind: 'completeSale' }), /not open/);
  assert.equal(abi.PoolVault.parseTransaction({ data: governanceAction(expired, account, { kind: 'cancelExpired' }).transaction.data }).name, 'cancelExpired');
});
