import test from 'node:test';
import assert from 'node:assert/strict';
import { firstoProvider, runtime } from '../../deploy/scripts/fixtures/firsto-order.mjs';
import { FIRSTO_SIGNED_EXCHANGE } from '../../deploy/src/firsto-purchase.mjs';
import { Interface } from 'ethers';
const capability = new Interface(['function controlledFirstoSaleVersion() view returns(uint8)']);
const thresholdView = new Interface(['function saleReviewThresholdBps() view returns(uint16)']);
const saleViews = new Interface([
  'function saleReference(address pool) view returns(uint128 marketPriceWei,uint64 observedAt,bytes32 sourceDigest)',
  'function saleReview(address pool,uint256 proposalId) view returns(uint8 status,uint128 priceWei)',
]);
import { abi } from '../lib/chain-client.mjs';
import { fetchNativeFirstoPublication, governanceAction, nativeGovernanceViews, proposalReferenceRecord, prepareGovernanceAction, readGovernanceSnapshot } from '../lib/live-governance.mjs';

const factory = '0x1000000000000000000000000000000000000001';
const pool = '0x2000000000000000000000000000000000000002';
const account = '0x3000000000000000000000000000000000000003';
const market = '0x4000000000000000000000000000000000000004';
const blockHash = `0x${'ab'.repeat(32)}`;
const digest = `0x${'cd'.repeat(32)}`;

test('proposal disclosure uses an existing chain price and its own timestamp without manual input', () => {
  const snapshot = { stage: 'fresh-active', purchaseCost: 100n, activatedAt: 120n,
    saleReference: { available: true, priceWei: 150n, observedAt: 200n } };
  assert.deepEqual(proposalReferenceRecord(snapshot), { refPriceWei: '150', refAt: '200' });
  assert.deepEqual(proposalReferenceRecord({ ...snapshot, saleReference: { ...snapshot.saleReference, available: false } }),
    { refPriceWei: '100', refAt: '120' });
  assert.deepEqual(proposalReferenceRecord({ ...snapshot, stage: 'genesis' }),
    { refPriceWei: '100', refAt: '120' });
});

const proposal = (overrides = {}) => ({ proposer: account, snapshotTs: 1700000000n,
  endsAt: 1700086400n, refAt: 1699990000n, price: 20n, refPrice: 20n,
  snapshotMemberCount: 3n, snapshotTotalShares: 100n, yesCount: 0n,
  yesShares: 0n, executed: false, ...overrides });

function rpc({ chain = '0x38', timestamp = 1700000100n, state = 2n,
  activeId = 1n, proposals = [proposal(), proposal({ price: 9n, yesCount: 2n, yesShares: 51n })],
  purchased = 10n, listedId = 0n, salePrice = 0n, expiresAt = 0n,
  factoryBinding = factory, alreadyVoted = false, oldSale = false, firsto = {},
  referencePrice = 8n, referenceAt = timestamp - 100n, referenceDigest = digest,
  reviewStatus = 0n, reviewPrice = 0n, referenceReadError = false, reviewReadError = false,
  genesis = false, displayOnly = false, saleReviewThresholdBps, nativeSale = false, cancellation } = {}) {
  const external = firstoProvider({ account }, firsto).provider;
  return { request: async ({ method, params = [] }) => {
    if (method === 'eth_call') {
      const nativeCall = nativeGovernanceViews.parseTransaction({ data: params[0].data });
      if (nativeCall) {
        if (!nativeSale) throw new Error('Old contract lacks native sale capability');
        if (nativeCall.name === 'nativeFirstoSaleVersion') return nativeGovernanceViews.encodeFunctionResult(nativeCall.name, [1]);
        if (nativeCall.name === 'nativeFirstoAsk') return nativeGovernanceViews.encodeFunctionResult(nativeCall.name,
          [[pool, account, 16736n, listedId, salePrice, expiresAt, pool, 100n, 1n, 2n], digest, true]);
        if (nativeCall.name === 'delistingProposal') {
          assert.equal(params[0].from, account);
          return nativeGovernanceViews.encodeFunctionResult(nativeCall.name,
            cancellation ?? [0n, '0x'+'00'.repeat(20), 0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n, false, false]);
        }
      }
    }
    if (method === 'eth_call' && params[0].data === thresholdView.encodeFunctionData('saleReviewThresholdBps')) {
      if (saleReviewThresholdBps === undefined) throw Error('old implementation');
      return thresholdView.encodeFunctionResult('saleReviewThresholdBps', [saleReviewThresholdBps]);
    }
    if (method === 'eth_getStorageAt' || method === 'eth_getCode' && [FIRSTO_SIGNED_EXCHANGE, runtime.implementation].some(a => a.toLowerCase() === params[0].toLowerCase()) || method === 'eth_call' && params[0].to.toLowerCase() === FIRSTO_SIGNED_EXCHANGE.toLowerCase()) return external.request({ method, params });
    if (method === 'eth_call' && params[0].data === capability.encodeFunctionData('controlledFirstoSaleVersion')) {
      if (oldSale) throw new Error('old implementation');
      return capability.encodeFunctionResult('controlledFirstoSaleVersion', [1]);
    }
    if (method === 'eth_call' && params[0].to.toLowerCase() === market.toLowerCase()) {
      const parsed = saleViews.parseTransaction({ data: params[0].data });
      if (parsed?.name === 'saleReference') {
        if (genesis) throw new Error('Genesis market does not implement saleReference');
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
    assert.equal(params[1], displayOnly ? 'latest' : '0x1234');
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
        && p.yesShares >= (genesis && p.price < purchased ? 60n : 51n);
    }
    if (!(parsed.name in values)) throw new Error(`Unmocked ${parsed.name}`);
    return iface.encodeFunctionResult(parsed.name, [values[parsed.name]]);
  } };
}

test('genesis discounted sale uses 60 shares and does not ask legacy market for sale reference', async () => {
  const genesisOptions = { factory, pool, account, stage: 'genesis' };
  const discounted = overrides => rpc({ genesis: true, proposals: [proposal({ price: 9n,
    yesCount: 2n, yesShares: 59n, ...overrides })] });
  const short = await readGovernanceSnapshot(discounted(), genesisOptions);
  assert.equal(short.saleReference, null);
  assert.equal(short.candidates[0].requiredYesShares, 60n);
  assert.equal(short.candidates[0].passed, false);
  assert.equal(short.candidates[0].canExecute, false);
  const passed = await readGovernanceSnapshot(discounted({ yesShares: 60n }), genesisOptions);
  assert.equal(passed.candidates[0].passed, true);
  assert.equal(passed.candidates[0].canExecute, true);
  assert.equal(governanceAction(passed, account, { kind: 'executeSale', proposalId: '1' }).quote.marketReferenceWei, null);
});

test('native listing reads exact authorization and a wallet-bound downlisting snapshot without extra proofs', async () => {
  const expiresAt = 1700000200n;
  const { provider, calls } = directRpc({ state: 3n, proposals: [proposal({ price: 1000n, executed: true })],
    listedId: 1n, salePrice: 1000n, expiresAt, nativeSale: true, saleReviewThresholdBps: 8000n,
    cancellation: [5n, account, 1n, 1700000000n, expiresAt, 3n, 2n, 51n, 1n, 10n, false, false] });
  const snapshot = await readGovernanceSnapshot(provider, directOptions);
  assert.equal(snapshot.nativeFirstoSale.enabled, true); assert.equal(snapshot.nativeFirstoSale.active, true);
  assert.equal(snapshot.nativeFirstoSale.orderHash, digest); assert.equal(snapshot.saleReviewThresholdBps, 8000n);
  assert.equal(snapshot.delisting.id, 5n); assert.equal(snapshot.delisting.canExecute, true);
  assert.equal(snapshot.delisting.requiredYesCount, 2n); assert.equal(snapshot.delisting.requiredYesShares, 51n);
  assert.equal(snapshot.delisting.noCount, 1n); assert.equal(snapshot.delisting.noShares, 10n);
  const getter = calls.find(input => input.params[0].data === nativeGovernanceViews.encodeFunctionData('delistingProposal', [0n]));
  assert.equal(getter.params[0].from, account); assert(calls.every(input => input.method === 'eth_call'));
  const prepared = governanceAction(snapshot, account, { kind: 'delist', delistAction: '2', cancellationId: '5',
    expectedListedProposalId: '1', support: false });
  assert.equal(prepared.transaction.value, '0x0'); assert.deepEqual([...nativeGovernanceViews.parseTransaction(prepared.transaction).args], [2n, 5n, 1n, false]);
});

test('downlisting requires both strict majorities and rejects duplicate votes, changed listings and completed sales', async () => {
  const read = (votes, more = {}) => readGovernanceSnapshot(directRpc({ state: 3n,
    proposals: [proposal({ price: 1000n, executed: true })], listedId: 1n, salePrice: 1000n,
    expiresAt: 1700000200n, nativeSale: true,
    cancellation: [5n, account, 1n, 1700000000n, 1700000200n, 4n, ...votes, false, false], ...more }).provider, directOptions);
  const action = { kind: 'delist', delistAction: '2', cancellationId: '5', expectedListedProposalId: '1', support: false };
  const halfCount = await read([2n, 51n, 1n, 10n]); assert.equal(halfCount.delisting.passed, false);
  assert.throws(() => governanceAction(halfCount, account, action), /严格过半/);
  const halfShares = await read([3n, 50n, 0n, 0n]); assert.equal(halfShares.delisting.passed, false);
  assert.throws(() => governanceAction(halfShares, account, action), /严格过半/);
  const passed = await read([3n, 51n, 0n, 0n]);
  assert.throws(() => governanceAction(passed, account, { ...action, expectedListedProposalId: '2' }), /挂牌提案已变化/);
  assert.throws(() => governanceAction(passed, account, { ...action, cancellationId: '4' }), /挂牌已变化/);
  assert.throws(() => governanceAction({ ...passed, state: 4n }, account, action), /已成交/);
  assert.throws(() => governanceAction({ ...passed, timestamp: passed.expiresAt }, account, action), /到期/);
  assert.throws(() => governanceAction({ ...passed, delisting: { ...passed.delisting, canVote: false, hasVoted: true } },
    account, { ...action, delistAction: '1', support: true }), /已投票/);
});

test('an empty downlisting round only permits held members to propose zero-id and can expire normally', async () => {
  const snapshot = await readGovernanceSnapshot(directRpc({ state: 3n, nativeSale: true,
    proposals: [proposal({ price: 1000n, executed: true })], listedId: 1n, salePrice: 1000n,
    expiresAt: 1700000200n }).provider, directOptions);
  assert.equal(snapshot.delisting.canPropose, true);
  const action = { kind: 'delist', delistAction: '0', cancellationId: '0', expectedListedProposalId: '1', support: false };
  assert.deepEqual([...nativeGovernanceViews.parseTransaction(governanceAction(snapshot, account, action).transaction).args], [0n, 0n, 1n, false]);
  assert.throws(() => governanceAction(snapshot, account, { ...action, cancellationId: '1' }), /不能发起/);
  assert.throws(() => governanceAction({ ...snapshot, delisting: { ...snapshot.delisting, canPropose: false } }, account, action), /不能发起/);
  const expired = { ...snapshot, timestamp: snapshot.expiresAt };
  assert.equal(governanceAction(expired, account, { kind: 'cancelExpired' }).quote.action, 'cancelExpired');
});

test('native publication uses only a same-site fixed GET and exact deployment, order and fresh official-book evidence', async () => {
  const now=1700000100000, config={origin:'https://test.example',indexBaseUrl:'https://test.example/api/chain-index',factory,testProfile:true};
  const reply={schemaVersion:1,chainId:56,profile:'full-test',factory,exchange:FIRSTO_SIGNED_EXCHANGE,
    enabled:true,stale:false,updatedAt:new Date(now).toISOString(),
    item:{pool,status:'published',askHash:digest,verifiedInOfficialBook:true,priceWei:'40000000000000000'}};
  const requests=[];
  const read=value=>fetchNativeFirstoPublication(config,pool,digest,{now:()=>now,
    fetcher:async(url,options)=>{requests.push({url,options});return new Response(JSON.stringify(value),{headers:{'content-type':'application/json'}});}});
  assert.equal((await read(reply)).item.status,'published');assert.equal(requests.length,1);
  assert.equal(requests[0].options.method,'GET');assert.equal(requests[0].options.body,undefined);
  assert.equal(new URL(requests[0].url).pathname,`/api/chain-index/v1/display/firsto-ask/${pool}`);
  for(const change of [{factory:account},{chainId:97},{profile:'formal'},{exchange:market},
    {item:{...reply.item,pool:account}},{item:{...reply.item,askHash:blockHash}},
    {item:{...reply.item,verifiedInOfficialBook:false}}])await assert.rejects(read({...reply,...change}));
  assert.equal((await read({...reply,updatedAt:new Date(now-90001).toISOString()})).stale,true);
  assert.equal((await read({...reply,item:{...reply.item,status:'publication-accepted',verifiedInOfficialBook:false}})).item.status,'publication-accepted');
  await assert.rejects(fetchNativeFirstoPublication({...config,indexBaseUrl:'https://other.example/api/chain-index'},pool,digest,
    {fetcher:()=>assert.fail('Foreign origins must fail before GET')}));
});

function directRpc(options = {}) {
  const calls = [], base = rpc({ ...options, displayOnly: true });
  const provider = { request: async input => {
    calls.push(input);
    assert.equal(input.method, 'eth_call', 'Direct governance must not read chain, headers, code or storage');
    assert.equal(input.params[1], 'latest');
    for (const data of [abi.PoolFactory.encodeFunctionData('isPool', [pool]),
      abi.PoolVault.encodeFunctionData('factory'), abi.PoolVault.encodeFunctionData('OFFICIAL_FACTORY'),
      capability.encodeFunctionData('controlledFirstoSaleVersion')]) assert.notEqual(input.params[0].data, data);
    return base.request(input);
  } };
  return { provider, calls };
}
const directOptions = { factory, pool, account, shareMarket: market, stage: 'fresh-active',
  displayOnly: true, now: () => 1700000100000 };

test('direct governance reads one deployed review rule and preview carries the actual requirement', async () => {
  for (const [saleReviewThresholdBps, price, required] of [[8000n, 79n, true], [8000n, 80n, false],
    [8000n, 81n, false], [undefined, 99n, true]]) {
    const f = directRpc({ saleReviewThresholdBps, referencePrice: 100n,
      proposals: [proposal({ price, yesCount: 2n, yesShares: 51n })] });
    const snapshot = await readGovernanceSnapshot(f.provider, directOptions), candidate = snapshot.candidates[0];
    assert.equal(snapshot.saleReviewThresholdBps, saleReviewThresholdBps ?? 10000n);
    assert.equal(candidate.discounted, true); assert.equal(candidate.reviewRequired, required);
    assert.equal(candidate.canExecute, !required);
    const thresholdCalls = () => f.calls.filter(input => input.params[0].data === thresholdView.encodeFunctionData('saleReviewThresholdBps')).length;
    assert.equal(thresholdCalls(), 1);
    if (!required) {
      const prepared = await prepareGovernanceAction(f.provider, { ...directOptions, snapshot,
        action: { kind: 'executeSale', proposalId: '1' } });
      assert.equal(prepared.quote.reviewRequired, false); assert.equal(prepared.quote.saleReviewThresholdBps, 8000n);
      assert.equal(thresholdCalls(), 1, 'preview reuses the existing display snapshot');
    }
  }
});

test('direct governance uses business getters only and preserves review and vote rules', async () => {
  const { provider, calls } = directRpc({ factoryBinding: pool, chain: '0x1', referencePrice: 10n,
    reviewStatus: 1n, reviewPrice: 9n });
  const snapshot = await readGovernanceSnapshot(provider, directOptions);
  assert.equal(snapshot.displayOnly, true);
  assert.equal(snapshot.timestampOrigin, 'local');
  assert.equal(snapshot.timestamp, 1700000100n);
  assert.equal(snapshot.blockNumber, null); assert.equal(snapshot.blockHash, null);
  assert.equal(snapshot.candidates[1].canExecute, true);
  const before = calls.length;
  const prepared = await prepareGovernanceAction(provider, { ...directOptions, snapshot,
    action: { kind: 'executeSale', proposalId: '2' } });
  assert.equal(calls.length, before, 'An unsigned preview reuses the displayed business data');
  assert.equal(prepared.quote.blockNumber, null);
  assert.deepEqual(Array.from(abi.PoolVault.parseTransaction(prepared.transaction).args), [2n]);
  await assert.rejects(prepareGovernanceAction(provider, { ...directOptions, snapshot,
    account: pool, action: { kind: 'vote', proposalId: '2', support: true } }), /another wallet/);
  await assert.rejects(prepareGovernanceAction(provider, { ...directOptions, snapshot,
    pool: market, action: { kind: 'executeSale', proposalId: '2' } }), /another pool/);
  await assert.rejects(prepareGovernanceAction(provider, { ...directOptions, snapshot,
    stage: 'code-upgraded', action: { kind: 'executeSale', proposalId: '2' } }), /another product/);
  const unavailable = await readGovernanceSnapshot(directRpc({ referencePrice: 10n,
    reviewStatus: 1n, reviewPrice: 8n }).provider, directOptions);
  assert.equal(unavailable.candidates[1].canExecute, false, 'Business approval remains tied to the actual price');
});

test('direct listing reads the current Firsto fee without proxy or capability proofs', async () => {
  const { provider, calls } = directRpc({ state: 3n, proposals: [proposal({ price: 1000n, executed: true })],
    listedId: 1n, salePrice: 1000n, expiresAt: 1700000200n, oldSale: true,
    firsto: { implementationCode: '0x6001', values: { defaultTakerFeeBps: 200n, feeEpoch: 3n } } });
  const snapshot = await readGovernanceSnapshot(provider, directOptions);
  const before = calls.length;
  const prepared = await prepareGovernanceAction(provider, { ...directOptions, snapshot,
    action: { kind: 'completeFirstoSale', expectedPriceWei: '1000', expectedFeeBps: '200', expectedFeeEpoch: '3' } });
  assert.equal(calls.length, before);
  assert.deepEqual(Array.from(abi.PoolVault.parseTransaction(prepared.transaction).args), [1n, 1000n, 200n, 3n]);
  assert.equal(prepared.transaction.value, '0x3fc'); assert.equal(prepared.quote.sourceFeeWei, 20n);
  assert.throws(() => governanceAction(snapshot, account, { kind: 'completeFirstoSale', expectedFeeBps: '100' }), /changed/);
  const paused = await readGovernanceSnapshot(directRpc({ state: 3n,
    proposals: [proposal({ price: 1000n, executed: true })], listedId: 1n, salePrice: 1000n,
    expiresAt: 1700000200n, firsto: { values: { paused: true } } }).provider, directOptions);
  assert.equal(paused.firstoSale.available, false);
  assert.throws(() => governanceAction(paused, account, { kind: 'completeFirstoSale' }), /费率暂不可用/);
});

test('direct cache isolates pool, wallet, provider and stage; pushed and manual refreshes read again', async () => {
  const { provider, calls } = directRpc({ activeId: 0n, proposals: [] });
  const options = { ...directOptions, cacheMs: 120000, refreshToken: 1 };
  const first = await readGovernanceSnapshot(provider, options), before = calls.length;
  assert.equal(await readGovernanceSnapshot(provider, options), first);
  assert.equal(calls.length, before, 'Returning to governance within the cache window does not read again');
  await readGovernanceSnapshot(provider, { ...options, account: market });
  assert(calls.length > before); let count = calls.length;
  await readGovernanceSnapshot(provider, { ...options, pool: account });
  assert(calls.length > count); count = calls.length;
  await readGovernanceSnapshot(provider, { ...options, stage: 'code-upgraded' });
  assert(calls.length > count); count = calls.length;
  const other = directRpc({ activeId: 0n, proposals: [] });
  await readGovernanceSnapshot(other.provider, options); assert(other.calls.length > 0);
  await readGovernanceSnapshot(provider, { ...options, refreshToken: 2 });
  assert(calls.length > count); count = calls.length;
  await readGovernanceSnapshot(provider, { ...options, refreshToken: 2, force: true });
  assert(calls.length > count); count = calls.length;
  await readGovernanceSnapshot(provider, { ...options, refreshToken: 2, now: () => 1700000220001 });
  assert(calls.length > count, 'Expired data reads again');
});

test('direct sale candidates use four bounded workers and retain strict round ordering and exact prices', async () => {
  const proposals = Array.from({ length: 12 }, (_, i) => proposal({ price: BigInt(i + 1) * 100n,
    yesCount: 2n, yesShares: 51n, ...(i === 6 ? { snapshotTs: 1700000001n } : {}) }));
  const base = directRpc({ proposals }); let active = 0, peak = 0;
  const provider = { async request(input) {
    const parsed = input.params[0].to.toLowerCase() === pool.toLowerCase()
      ? abi.PoolVault.parseTransaction(input.params[0]) : null;
    const candidateRead = ['getProposal', 'proposalPassed', 'hasVoted'].includes(parsed?.name);
    if (!candidateRead) return base.provider.request(input);
    active++; peak = Math.max(peak, active);
    try { await new Promise(resolve => setTimeout(resolve, Number(parsed.args[0] % 3n) + 2)); return await base.provider.request(input); }
    finally { active--; }
  } };
  const direct = await readGovernanceSnapshot(provider, directOptions);
  const strict = await readGovernanceSnapshot(rpc({ proposals }), { factory, pool, account, stage: 'fresh-active' });
  assert(peak > 2 && peak <= 8, `Four workers can each read at most two vote getters concurrently, peak=${peak}`);
  assert.equal(active, 0); assert.deepEqual(direct.candidates, strict.candidates);
  assert.deepEqual(direct.candidates.map(row => row.id), [1n, 2n, 3n, 4n, 5n, 6n, 8n, 9n, 10n, 11n, 12n]);
});

test('a failed concurrent governance candidate drains all started reads and returns no partial snapshot', async () => {
  const base = directRpc({ proposals: Array.from({ length: 12 }, (_, i) => proposal({ price: BigInt(i + 1) * 100n,
    yesCount: 2n, yesShares: 51n })) }), failure = new Error('proposal getter unavailable');
  let active = 0, siblingFinished = false, published = false;
  const provider = { async request(input) {
    const parsed = input.params[0].to.toLowerCase() === pool.toLowerCase()
      ? abi.PoolVault.parseTransaction(input.params[0]) : null;
    active++;
    try {
      if (parsed?.name === 'proposalPassed' && parsed.args[0] === 2n) throw failure;
      if (parsed?.name === 'hasVoted' && parsed.args[0] === 2n) {
        await new Promise(resolve => setTimeout(resolve, 20)); siblingFinished = true;
      } else await new Promise(resolve => setTimeout(resolve, 1));
      return await base.provider.request(input);
    } finally { active--; }
  } };
  const read = readGovernanceSnapshot(provider, directOptions).then(value => { published = true; return value; });
  await assert.rejects(read, error => error === failure);
  assert.equal(siblingFinished, true); assert.equal(active, 0); assert.equal(published, false);
});

test('enumerates competing prices in one frozen round and permits voting for either', async () => {
  const snap = await readGovernanceSnapshot(rpc(), { factory, pool, account, stage: 'fresh-active' });
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
  const voted = await readGovernanceSnapshot(rpc({ alreadyVoted: true }), { factory, pool, account, stage: 'fresh-active' });
  assert.throws(() => governanceAction(voted, account, { kind: 'vote', proposalId: '1', support: false }), /cannot vote again/);
  const execution = governanceAction(snap, account, { kind: 'executeSale', proposalId: '2' });
  assert.equal(abi.PoolVault.parseTransaction({ data: execution.transaction.data }).name, 'executeSale');
  assert.throws(() => governanceAction(snap, account, { kind: 'executeSale', proposalId: '1' }), /threshold/);
});

test('execution requires a fresh Firsto reference and exact platform review below that reference', async () => {
  const input = { referencePrice: 10n };
  const pending = await readGovernanceSnapshot(rpc(input), { factory, pool, account, stage: 'fresh-active' });
  assert.equal(pending.candidates[1].passed, true);
  assert.equal(pending.candidates[1].discounted, true);
  assert.equal(pending.candidates[1].canExecute, false);
  assert.throws(() => governanceAction(pending, account, { kind: 'executeSale', proposalId: '2' }), /reference or required platform review/);

  const approved = await readGovernanceSnapshot(rpc({ ...input, reviewStatus: 1n, reviewPrice: 9n }), { factory, pool, account, stage: 'fresh-active' });
  assert.equal(approved.candidates[1].reviewApproved, true);
  assert.equal(approved.candidates[1].canExecute, true);
  assert.equal(governanceAction(approved, account, { kind: 'executeSale', proposalId: '2' }).quote.marketReferenceWei, 10n);

  for (const change of [{ reviewStatus: 1n, reviewPrice: 8n }, { reviewStatus: 2n, reviewPrice: 9n },
    { referenceAt: 1699999199n, reviewStatus: 1n, reviewPrice: 9n },
    { referenceDigest: `0x${'00'.repeat(32)}`, reviewStatus: 1n, reviewPrice: 9n },
    { referenceReadError: true }, { reviewReadError: true }]) {
    const blocked = await readGovernanceSnapshot(rpc({ ...input, ...change }), { factory, pool, account, stage: 'fresh-active' });
    assert.equal(blocked.candidates[1].canExecute, false);
    assert.throws(() => governanceAction(blocked, account, { kind: 'executeSale', proposalId: '2' }), /reference or required platform review/);
  }
});

test('rejects legacy timestamp-minus-one proposals and foreign pool bindings', async () => {
  const legacy = await readGovernanceSnapshot(rpc({ proposals: [proposal({ snapshotTs: 1699999999n })] }), { factory, pool, account, stage: 'fresh-active' });
  assert.equal(legacy.candidates.length, 0);
  assert.throws(() => governanceAction(legacy, account, { kind: 'vote', proposalId: '1', support: true }), /not open/);
  const expired = await readGovernanceSnapshot(rpc({ timestamp: 1700605000n,
    proposals: [proposal({ snapshotTs: 1699999999n })] }), { factory, pool, account, stage: 'fresh-active' });
  const nextRound = governanceAction(expired, account, { kind: 'propose',
    priceWei: '10', refPriceWei: '10', refAt: '1700604000' });
  assert.equal(abi.PoolVault.parseTransaction({ data: nextRound.transaction.data }).name, 'propose');
  await assert.rejects(readGovernanceSnapshot(rpc({ factoryBinding: pool }), { factory, pool, account, stage: 'fresh-active' }), /not registered/);
  await assert.rejects(readGovernanceSnapshot(rpc({ chain: '0x1' }), { factory, pool, account, stage: 'fresh-active' }), /BSC mainnet/);
});

test('reports the three-day activation lock separately from valid sale prices', async () => {
  const fresh = await readGovernanceSnapshot(rpc({ timestamp: 1699000100n, activeId: 0n,
    proposals: [] }), { factory, pool, account, stage: 'fresh-active' });
  assert.equal(fresh.state, 2n);
  assert.equal(fresh.shares, 30n);
  assert.throws(() => governanceAction(fresh, account, { kind: 'propose',
    priceWei: '40000000000000000', refPriceWei: '40000000000000000',
    refAt: fresh.timestamp.toString() }), /激活满 3 天/);
});

test('sale payment uses the current listed price and never a UI-supplied amount', async () => {
  const live = await readGovernanceSnapshot(rpc({ state: 3n, proposals: [proposal({ price: 1000n, executed: true })],
    listedId: 1n, salePrice: 1000n, expiresAt: 1700000200n }), { factory, pool, account, stage: 'fresh-active' });
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
    listedId: 1n, salePrice: 1000n, expiresAt: 1700000100n }), { factory, pool, account, stage: 'fresh-active' });
  assert.throws(() => governanceAction(expired, account, { kind: 'completeFirstoSale' }), /not open/);
  assert.equal(abi.PoolVault.parseTransaction({ data: governanceAction(expired, account, { kind: 'cancelExpired' }).transaction.data }).name, 'cancelExpired');
});

test('old sale capability, changed Firsto implementation and fee epoch mismatch fail closed without blocking expiry cleanup', async () => {
  const listed = { state:3n, proposals:[proposal({price:1000n,executed:true})], listedId:1n,
    salePrice:1000n,expiresAt:1700000200n };
  for (const changes of [{oldSale:true},{firsto:{implementationCode:'0x6001'}},{firsto:{values:{feeBpsAtEpoch:200n}}},
    {firsto:{values:{paused:true}}},{firsto:{values:{SIGNED_ASK_SCHEMA_VERSION:3n}}}]) {
    const snapshot = await readGovernanceSnapshot(rpc({...listed,...changes}),{factory,pool,account,stage:'fresh-active'});
    assert.equal(snapshot.firstoSale.available,false);
    assert.throws(()=>governanceAction(snapshot,account,{kind:'completeFirstoSale'}),/核验/);
  }
  const expired = await readGovernanceSnapshot(rpc({...listed,oldSale:true,timestamp:1700000200n}),{factory,pool,account,stage:'fresh-active'});
  assert.equal(governanceAction(expired,account,{kind:'cancelExpired'}).quote.action,'cancelExpired');
});
