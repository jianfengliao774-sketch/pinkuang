import assert from 'node:assert/strict';
import test from 'node:test';
import { Interface, ZeroAddress, toQuantity } from 'ethers';
import { abi } from '../lib/chain-client.mjs';
import { readSaleReviewRequests, refreshSaleReviewRequest } from '../lib/sale-review-requests.mjs';
import { portfolioFixture, address } from './portfolio-fixture.mjs';

const pool = address(0x1201), otherPool = address(0x1202), portfolio = address(0x1301);
const child = address(0x1401), collection = address(0x1501), proposer = address(0x1601);
const hash = digit => `0x${digit.repeat(64)}`;
const thresholdView = new Interface(['function saleReviewThresholdBps() view returns(uint16)']);

function fixture(options = {}) {
  const base = portfolioFixture(), manifest = base.manifest, config = base.config;
  const source = { ...base.source(), ...options.source };
  const timestamp = BigInt(source.indexedTimestamp), blockNumber = BigInt(source.indexedThrough);
  const state = { ...options }, calls = [], urls = [];
  let activeCalls = 0, peak = 0, blocksRead = 0;
  const proposal = changes => ({ proposer, snapshotTs: timestamp - 100n, endsAt: timestamp + 86300n,
    refAt: timestamp - 100n, price: 12345678901234567n, refPrice: 15000000000000000n,
    snapshotMemberCount: 3n, snapshotTotalShares: 100n, yesCount: 2n, yesShares: 51n, executed: false, ...changes });
  const proposals = options.proposals ?? [proposal()];
  const childProposals = options.childProposals ?? [{ child, price: 12345678901234567n,
    referencePrice: 15000000000000000n, referenceAt: timestamp - 100n, endsAt: timestamp + 86300n,
    memberCount: 3n, yesMembers: 2n, yesShares: 51n, executed: false }];
  const scope = options.scope ?? 'pool';
  const projects = scope === 'pool' ? options.projects ?? [pool] : [portfolio];
  const block = n => ({ number: toQuantity(n), hash: n === blockNumber ? source.indexedBlockHash : hash('c'),
    timestamp: toQuantity(n === blockNumber ? timestamp : timestamp - 100n) });
  const request = async input => {
    calls.push(input); activeCalls++; peak = Math.max(peak, activeCalls);
    try {
      if (options.delay) await new Promise(resolve => setTimeout(resolve, options.delay));
      const { method, params = [] } = input;
      if (method === 'eth_chainId') return state.chain ?? '0x38';
      if (method === 'eth_getBlockByNumber') {
        blocksRead++;
        const value = block(params[0] === 'latest' ? blockNumber : BigInt(params[0]));
        return state.reorg && blocksRead > 1 ? { ...value, hash: hash('d') } : value;
      }
      if (method === 'eth_getCode') return '0x6000';
      if (method === 'eth_getTransactionReceipt') {
        const p = childProposals[0];
        const event = abi.BudgetPortfolioVault.encodeEventLog('ChildSaleProposed', [state.wrongProposalEvent ? 2n : 1n,
          p.child, p.price, p.endsAt]);
        return { status: '0x1', transactionHash: hash('b'), blockHash: hash('c'),
          logs: [{ ...event, address: portfolio, logIndex: '0x0' }] };
      }
      if (method === 'eth_getTransactionByHash') {
        const p = childProposals[0];
        return { hash: hash('b'), from: proposer, to: state.forwarded ? otherPool : portfolio,
          blockHash: hash('c'), blockNumber: toQuantity(blockNumber - 1n),
          input: abi.BudgetPortfolioVault.encodeFunctionData('proposeChildSale',
            [p.child, p.price, p.referencePrice, p.referenceAt]) };
      }
      assert.equal(method, 'eth_call', `only view RPC calls are allowed, got ${method}`);
      const [tx, tag] = params;
      assert.equal(tag, toQuantity(blockNumber));
      assert.equal(tx.from, undefined, 'view reads never simulate a sender transaction');
      if (tx.data === thresholdView.encodeFunctionData('saleReviewThresholdBps')) {
        const threshold = tx.to === child ? state.childReviewThresholdBps : state.saleReviewThresholdBps;
        if (threshold === undefined) throw Error('old implementation');
        return thresholdView.encodeFunctionResult('saleReviewThresholdBps', [threshold]);
      }
      const iface = tx.to === manifest.factory ? abi.PoolFactory
        : tx.to === manifest.portfolioFactory ? abi.BudgetPortfolioFactory
          : tx.to === manifest.shareMarket ? abi.ShareMarket
            : tx.to === portfolio ? abi.BudgetPortfolioVault : abi.PoolVault;
      const parsed = iface.parseTransaction(tx), name = parsed.name;
      if (state.failedProject === tx.to) throw Error('project RPC unavailable');
      if (name === 'saleReference') {
        if (state.referenceFails) throw Error('reference unavailable');
        return iface.encodeFunctionResult(name, [state.referencePrice ?? 15000000000000000n,
          state.referenceAt ?? timestamp - 100n, hash('a')]);
      }
      if (name === 'saleReview') {
        if (state.reviewFails) throw Error('review unavailable');
        return iface.encodeFunctionResult(name, [state.reviewStatus ?? 0n,
          state.reviewPrice ?? proposals[Number(parsed.args[1] - 1n)]?.price ?? 0n]);
      }
      if (name === 'getProposal') return iface.encodeFunctionResult(name, [proposals[Number(parsed.args[0] - 1n)]]);
      if (name === 'proposals') return iface.encodeFunctionResult(name, Object.values(childProposals[Number(parsed.args[0] - 1n)]));
      if (name === 'childInfo') return iface.encodeFunctionResult(name, [collection, 13043n, 1000n, true, false]);
      const values = {
        isPool: state.foreign !== true, OFFICIAL_FACTORY: tx.to === portfolio ? manifest.portfolioFactory : manifest.factory,
        legacyFactory: manifest.factory, factory: manifest.factory, shareMarket: manifest.shareMarket,
        state: state.poolState ?? 2n, activeProposalId: state.activeId ?? 1n,
        poolCount: state.total ?? BigInt(projects.length), portfolioCount: state.total ?? BigInt(projects.length),
        nextProposalId: state.nextId ?? BigInt((tx.to === portfolio ? childProposals : proposals).length + 1),
        designatedSubscriber: state.subscriber ?? ZeroAddress,
        params: [collection, 13043n, 10000n, 9000n, ZeroAddress, 0n, timestamp + 1000n, timestamp + 2000n],
        childSaleReview: state.reviewStatus ?? 0n,
      };
      assert(name in values, `unexpected read ${name}`);
      return iface.encodeFunctionResult(name, [values[name]]);
    } finally { activeCalls--; }
  };
  const fetcher = async url => {
    const parsed = new URL(url); urls.push(parsed);
    let data;
    if (parsed.pathname.endsWith('/v1/activity')) {
      const p = childProposals[0];
      data = { items: state.noActivity ? [] : [{ event: 'ChildSaleProposed', source: 'portfolio',
        pool: portfolio, contract: portfolio, blockNumber: Number(blockNumber - 1n), blockHash: hash('c'),
        transactionHash: hash('b'), logIndex: 0, fields: { proposalId: '1', child: p.child,
          price: p.price.toString(), endsAt: p.endsAt.toString() } }], nextCursor: null };
    } else data = { items: projects.map(address => ({ address,
      ...(scope === 'portfolio' ? { kind: 'portfolio', factory: manifest.portfolioFactory } : {}) })),
    nextCursor: state.nextCursor ?? null, registeredPoolCount: String(state.total ?? projects.length),
    childPoolCount: '0', reservedChildPoolCount: '0', standalonePoolCount: String(state.total ?? projects.length) };
    return new Response(JSON.stringify({ source: { ...source, ...state.sourceChanges }, data }),
      { headers: { 'content-type': 'application/json', Date: new Date(Number(timestamp) * 1000).toUTCString() } });
  };
  const args = { config, provider: { request }, fetcher, now: () => Number(timestamp) * 1000, scope };
  return { args, source, state, calls, urls, proposals, childProposals, proposal,
    peak: () => peak, activeCalls: () => activeCalls, timestamp };
}

test('current round requests preserve exact prices, proposer, miner and double-majority votes', async () => {
  const f = fixture(), page = await readSaleReviewRequests(f.args), item = page.items[0];
  assert.equal(page.errors.length, 0); assert.equal(page.projectsRead, 1);
  assert.equal(item.project, pool); assert.equal(item.pool, pool); assert.equal(item.proposer, proposer);
  assert.equal(item.collection, collection); assert.equal(item.tokenId, 13043n);
  assert.equal(item.priceWei, 12345678901234567n); assert.equal(item.status, 'pending');
  assert.equal(item.canReview, true); assert.equal(item.passed, true);
  assert.equal(item.requiredYesShares, 51n); assert.equal(item.requiredYesCount, 2n);
  assert.equal(page.source.factory, f.args.config.manifest.factory);
  assert.equal(page.source.complete, true);
  assert(!f.calls.some(call => /estimateGas|sign|send/i.test(call.method)));
});

test('review requests distinguish an ordinary discount from the actual deployed review threshold', async () => {
  for (const [threshold, price, required] of [[8000n, 79999n, true], [8000n, 80000n, false],
    [8000n, 80001n, false], [8000n, 99000n, false], [undefined, 99000n, true]]) {
    const f = fixture({ saleReviewThresholdBps: threshold, referencePrice: 100000n });
    f.proposals[0].price = price;
    const args = { ...f.args, config: { ...f.args.config, displayOnly: true } };
    const page = await readSaleReviewRequests(args), item = page.items[0];
    assert.equal(item.saleReviewThresholdBps, threshold ?? 10000n);
    assert.equal(item.discounted, true); assert.equal(item.reviewRequired, required);
    assert.equal(item.status, required ? 'pending' : 'no-review'); assert.equal(item.canReview, required);
    const thresholdCalls = () => f.calls.filter(c => c.method === 'eth_call'
      && c.params[0].data === thresholdView.encodeFunctionData('saleReviewThresholdBps')).length;
    assert.equal(thresholdCalls(), 1);
    await readSaleReviewRequests(args); assert.equal(thresholdCalls(), 1, 'repeat visits use the existing display cache');
  }
});

test('budget review requests keep the stricter child rule in a mixed deployment', async () => {
  for (const [parent, childRule, required] of [[8000n, 8000n, false], [8000n, undefined, true],
    [undefined, 8000n, true]]) {
    const f = fixture({ scope: 'portfolio', saleReviewThresholdBps: parent, childReviewThresholdBps: childRule,
      referencePrice: 100000n });
    f.childProposals[0].price = 90000n;
    const item = (await readSaleReviewRequests(f.args)).items[0];
    assert.equal(item.saleReviewThresholdBps, required ? 10000n : 8000n);
    assert.equal(item.reviewRequired, required); assert.equal(item.canReview, required);
    assert.equal(f.calls.filter(c => c.method === 'eth_call'
      && c.params[0].data === thresholdView.encodeFunctionData('saleReviewThresholdBps')).length, 2);
  }
});

test('review status and terminal round states are distinct, missing reads never become pending', async () => {
  for (const [options, status, canReview] of [
    [{ reviewStatus: 1n }, 'approved', true], [{ reviewStatus: 2n }, 'rejected', false],
    [{ reviewStatus: 2n, referencePrice: 10n }, 'no-review', false],
    [{ referencePrice: 10n }, 'no-review', false], [{ referenceFails: true }, 'reference-missing', false],
    [{ reviewFails: true }, 'review-unavailable', false], [{ reviewStatus: 1n, reviewPrice: 1n }, 'review-unavailable', false],
    [{ poolState: 3n }, 'executed', false],
  ]) {
    const f = fixture(options), item = (await readSaleReviewRequests(f.args)).items[0];
    assert.equal(item.status, status); assert.equal(item.canReview, canReview);
  }
  const f = fixture(); f.proposals[0].endsAt = f.timestamp;
  f.proposals[0].snapshotTs = f.timestamp - 86400n;
  assert.equal((await readSaleReviewRequests(f.args)).items[0].status, 'expired');
});

test('early review is allowed before votes pass; sibling execution closes every candidate', async () => {
  const f = fixture(); f.proposals[0].yesCount = 0n; f.proposals[0].yesShares = 0n;
  let page = await readSaleReviewRequests(f.args);
  assert.equal(page.items[0].passed, false); assert.equal(page.items[0].canReview, true);
  f.proposals.push(f.proposal({ price: 2n })); f.proposals[0].executed = true;
  page = await readSaleReviewRequests(f.args);
  assert.equal(page.items.length, 2); assert(page.items.every(item => item.status === 'executed' && !item.canReview));
});

test('one failed project is reported separately without hiding other applications', async () => {
  const f = fixture({ projects: [pool, otherPool], failedProject: otherPool });
  const page = await readSaleReviewRequests(f.args);
  assert.equal(page.items.length, 1); assert.equal(page.errors.length, 1);
  assert.equal(page.errors[0].project, otherPool); assert.equal(page.complete, false);
  assert.equal(f.activeCalls(), 0);
});

test('directory binding, BSC identity and canonical block changes fail closed', async () => {
  for (const options of [{ chain: '0x1' }, { reorg: true }, { source: { factory: otherPool } }]) {
    const f = fixture(options); await assert.rejects(readSaleReviewRequests(f.args));
    assert.equal(f.activeCalls(), 0);
  }
  for (const options of [{ foreign: true }, { subscriber: portfolio }, { nextId: 102n }]) {
    const f = fixture(options), page = await readSaleReviewRequests(f.args);
    assert.equal(page.items.length, 0); assert.equal(page.errors.length, 1);
  }
});

test('directory pagination is explicit and malformed or repeated cursors are rejected', async () => {
  const f = fixture({ nextCursor: 1, total: 2n });
  const page = await readSaleReviewRequests({ ...f.args, limit: 1 });
  assert.equal(page.nextCursor, 1); assert.equal(f.urls[0].searchParams.get('limit'), '1');
  f.state.nextCursor = 2;
  await assert.rejects(readSaleReviewRequests({ ...f.args, limit: 1 }), /分页/);
  const omitted = fixture({ projects: [], total: 1n });
  await assert.rejects(readSaleReviewRequests(omitted.args), /覆盖/,
    'a claimed complete source cannot turn an omitted project directory into an empty request list');
});

test('only the current request is re-read before signing and changed price is rejected', async () => {
  const f = fixture(); f.proposals.push(f.proposal({ price: 3n }));
  const page = await readSaleReviewRequests(f.args), selected = page.items[0];
  f.calls.length = 0; f.urls.length = 0; f.state.reviewStatus = 2n;
  const latest = await refreshSaleReviewRequest({ ...f.args, item: selected });
  assert.equal(latest.status, 'rejected'); assert.equal(latest.canReview, false);
  assert.equal(f.urls.length, 0, 'selected read does not reload any directory');
  const proposalCalls = f.calls.filter(call => call.method === 'eth_call' && call.params[0].to === pool)
    .map(call => abi.PoolVault.parseTransaction(call.params[0])).filter(call => call?.name === 'getProposal');
  assert(proposalCalls.every(call => call.args[0] === 1n), 'unselected candidates are not re-read');
  f.proposals[0].price += 1n;
  await assert.rejects(refreshSaleReviewRequest({ ...f.args, item: selected }), /价格已变化/);
});

test('RPC concurrency stays bounded even with several projects and candidates', async () => {
  const f = fixture({ projects: [pool, otherPool], delay: 1 });
  for (let n = 0; n < 10; n++) f.proposals.push(f.proposal({ price: BigInt(n + 1) }));
  const page = await readSaleReviewRequests(f.args);
  assert.equal(page.items.length, 22); assert(f.peak() <= 4); assert.equal(f.activeCalls(), 0);
});

test('budget requests bind child identity and attribute only a proven direct proposal sender', async () => {
  const f = fixture({ scope: 'portfolio' }), page = await readSaleReviewRequests(f.args), item = page.items[0];
  assert.equal(page.errors.length, 0); assert.equal(item.kind, 'portfolio');
  assert.equal(item.project, portfolio); assert.equal(item.pool, child);
  assert.equal(item.tokenId, 13043n); assert.equal(item.proposer, proposer);
  assert.equal(item.proposerUnavailable, null); assert.equal(item.status, 'pending');
  for (const options of [{ forwarded: true }, { noActivity: true }, { wrongProposalEvent: true }]) {
    Object.assign(f.state, { forwarded: false, noActivity: false, wrongProposalEvent: false }, options);
    const unknown = (await readSaleReviewRequests(f.args)).items[0];
    assert.equal(unknown.proposer, null); assert.match(unknown.proposerUnavailable, /未记录申请人/);
  }
});

test('historical display snapshots remain non-actionable until a current selected read', async () => {
  const f = fixture({ source: { readMode: 'verified_snapshot', stale: true, transactionReady: false, refreshing: true } });
  const page = await readSaleReviewRequests(f.args), item = page.items[0];
  assert.equal(item.canReview, false); assert.equal(item.current, false);
  const latest = await refreshSaleReviewRequest({ ...f.args, item });
  assert.equal(latest.current, true); assert.equal(latest.canReview, true);
});
