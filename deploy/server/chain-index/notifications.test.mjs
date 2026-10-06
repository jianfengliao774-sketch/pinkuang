import assert from 'node:assert/strict';
import test from 'node:test';
import { replayNotificationPool, verifyNotificationPool, notificationPage } from './notifications.mjs';

const address = n => `0x${n.toString(16).padStart(40, '0')}`;
const hash = n => `0x${n.toString(16).padStart(64, '0')}`;
const zero = address(0), factory = address(1), market = address(2), pool = address(3), collection = address(4);
const alice = address(5), bob = address(6), carol = address(7), dave = address(8);
const timestamp = 1_800_000_000;
const metadata = { address: pool, collection, circuitId: '16210', createdBlock: 1 };

function history() {
  let logs = [];
  const add = (name, args, at = timestamp) => {
    logs.push({ name, args, timestamp: at, blockNumber: logs.length + 1, txHash: hash(logs.length + 1), logIndex: 0 });
  };
  add('Transfer', { from: zero, to: alice, value: '49' }, timestamp - 700000);
  add('Transfer', { from: zero, to: bob, value: '49' }, timestamp - 700000);
  add('Transfer', { from: zero, to: carol, value: '2' }, timestamp - 700000);
  add('Purchased', { cost: '100' }, timestamp - 650000);
  const propose = (id = '1', price = '100', at = timestamp) => {
    add('SaleProposed', { proposalId: id, proposer: bob, price, endsAt: timestamp + 86400 }, at);
    add('SaleSnapshotRecorded', { proposalId: id, snapshotTs: timestamp, members: '3', shares: '100' }, at);
  };
  return { logs, add, propose, replay: () => replayNotificationPool(metadata, logs, { factory, market, timestamp: timestamp + 100 }) };
}

test('snapshot is exact beneficial ownership; sellers retain locked shares and sold-out owners are excluded', () => {
  const h = history();
  h.add('Transfer', { from: alice, to: dave, value: '49' }, timestamp - 10);
  h.add('LockedSharesChanged', { member: bob, lockedShares: '20' }, timestamp - 5);
  h.propose();
  const p = h.replay().proposals[0];
  assert.deepEqual(p.owners, [{ account: bob, shares: '49' }, { account: carol, shares: '2' }, { account: dave, shares: '49' }]);
  assert(!p.owners.some(owner => owner.account === alice || owner.account === market));
  assert.equal(p.open, true);
});

test('custody-market ownership, missing snapshot, mismatched total and transfers in frozen round fail closed', () => {
  const custody = history(); custody.add('Transfer', { from: alice, to: market, value: '5' });
  assert.throws(custody.replay, /unsupported/);
  const missing = history(); missing.propose(); missing.logs.pop(); assert.throws(missing.replay, /unsupported/);
  const wrong = history(); wrong.propose(); wrong.logs.at(-1).args.members = '4'; assert.throws(wrong.replay, /unsupported/);
  const frozen = history(); frozen.propose(); frozen.add('Transfer', { from: alice, to: dave, value: '1' }, timestamp + 1);
  assert.throws(frozen.replay, /unsupported/);
});

test('competing proposals retain shared snapshot and actual deadline; early execution stops all round reminders', () => {
  const h = history(); h.propose(); h.propose('2', '110', timestamp + 60);
  h.add('Voted', { proposalId: '2', voter: bob, support: true, weight: '49' }, timestamp + 61);
  h.add('Voted', { proposalId: '2', voter: carol, support: true, weight: '2' }, timestamp + 62);
  let ps = h.replay().proposals;
  assert.equal(ps[1].passed, true); assert.equal(ps[1].executed, false); assert.equal(ps[1].open, true);
  assert.equal(ps[1].endsAt, ps[0].endsAt); assert.deepEqual(ps[1].owners, ps[0].owners);
  h.add('SaleListed', { proposalId: '2', price: '110', expiresAt: timestamp + 604863 }, timestamp + 63);
  const listed = h.replay();
  assert.equal(listed.state, 'Listed'); assert.equal(listed.saleCompleted, null);
  assert(listed.proposals.every(p => !p.open && p.roundExecuted));
  h.add('SaleCompleted', { gross: '110', toMembers: '109' }, timestamp + 65);
  const sold = h.replay(); assert.equal(sold.state, 'Closed'); assert.equal(sold.proposals[1].completed.grossWei, '110');
});

test('discounted sale follows dual majority; passing never means listed', () => {
  const h = history(); h.propose('1', '99');
  h.add('Voted', { proposalId: '1', voter: bob, support: true, weight: '49' }, timestamp + 1);
  h.add('Voted', { proposalId: '1', voter: carol, support: true, weight: '2' }, timestamp + 2);
  const p = h.replay().proposals[0];
  assert.equal(p.requiredYesCount, 2); assert.equal(p.requiredYesShares, 51); assert.equal(p.passed, true);
  assert.equal(p.listing, null);
});

function callsFor(replayed, override = {}) {
  return async (method, args = []) => {
    if (method in override) return typeof override[method] === 'function' ? override[method](args) : override[method];
    if (method === 'nextProposalId') return BigInt(replayed.proposalCount + 1);
    if (method === 'purchaseCost') return BigInt(replayed.purchaseCostWei);
    if (method === 'state') return { Active: 2, Listed: 3, Closed: 4 }[replayed.state];
    if (method === 'params') return { circuits: collection, circuitId: replayed.circuitId };
    if (method === 'activeProposalId') return replayed.activeProposalId;
    if (method === 'listedProposalId') return replayed.listedProposalId;
    if (method === 'getPastMemberCount') return 3;
    if (method === 'getPastShares') return replayed.proposals[0].owners.find(owner => owner.account === args[0]).shares;
    const p = replayed.proposals.find(proposal => proposal.proposalId === String(args[0]));
    if (method === 'hasVoted') return p.votes.some(vote => vote.account === args[1]);
    if (method === 'getProposal') return { ...p, price: p.priceWei, snapshotMemberCount: p.owners.length, snapshotTotalShares: '100' };
    throw new Error(`Unexpected read ${method}`);
  };
}

test('pinned contract verification detects missing proposals, hidden no-votes, ownership mismatch and unindexed listing', async () => {
  const h = history(); h.propose(); const pool = h.replay();
  assert.equal((await verifyNotificationPool(pool, callsFor(pool))).verified, true);
  for (const override of [{ nextProposalId: 3n }, { hasVoted: true }, { getPastShares: 0n }, { state: 3 },
    { purchaseCost: 99n }, { params: { circuits: collection, circuitId: '999' } }]) {
    await assert.rejects(verifyNotificationPool(pool, callsFor(pool, override)), /unsupported/);
  }
});

test('notification page verifies source pin, prior reorg anchor and canonical final header even for empty pages', async () => {
  const source = { complete: true, indexedThrough: 100, indexedBlockHash: hash(100) };
  const index = { status: () => source, pools: () => ({ items: [], nextCursor: null }), _header: () => ({ hash: hash(90) }),
    provider: { getBlock: async () => ({ hash: hash(100) }) } };
  assert.equal((await notificationPage(index, null, { anchorBlock: 90, anchorHash: hash(90) })).anchorVerified, true);
  await assert.rejects(notificationPage(index, null, { atBlock: 99, atHash: hash(99) }));
  await assert.rejects(notificationPage(index, null, { anchorBlock: 90, anchorHash: hash(91) }));
  index.provider.getBlock = async () => ({ hash: hash(999) });
  await assert.rejects(notificationPage(index, null));
});
