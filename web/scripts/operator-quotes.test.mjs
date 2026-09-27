import test from 'node:test';
import assert from 'node:assert/strict';
import { ZeroAddress, getAddress } from 'ethers';
import { dataFixture, chainFixture, apiFixture, MARKET, other, blockHash } from './operator-quotes-fixture.mjs';
import { checkMinerOnchain, loadOperatorQuote, listOperatorQuotes, operatorQuoteDraft, operatorQuoteError, parseOperatorImport } from '../lib/operator-quotes.mjs';

test('quote selection uses exact official NFT/Mining/Market ABI and pins every read to one BSC block', async () => {
  for (const series of ['TapeOut', 'Behemoth']) {
    const data = dataFixture({ series }), chain = chainFixture(data.quote);
    const result = await checkMinerOnchain(chain.provider, data.quote);
    assert.equal(result.blockNumber, '100'); assert.equal(result.blockHash, blockHash);
    assert.equal(result.official.id, '45'); assert.equal(result.official.priceWei, '2000000000000000001');
    assert.deepEqual(chain.calls, ['ownerOf', 'listingFor', 'minerKey', 'getMiner']);
    assert.equal(chain.requests.length, 8);
  }
});

test('wrong chain, final network change and canonical reorg invalidate quote verification', async () => {
  const data = dataFixture();
  for (const change of [{ chain: '0x1' }, { finalChain: '0x1' }, { reorg: true },
    { finalNumber: '0x65' }, { finalTimestamp: '0x6b49d201' }]) {
    const chain = chainFixture(data.quote, change);
    await assert.rejects(checkMinerOnchain(chain.provider, data.quote), /BSC|区块或网络/);
    if (change.chain) assert.equal(chain.calls.length, 0);
  }
});

test('changed owner, task, weight, NFT identity, inactive/optimal/unverified miner cannot pass', async () => {
  const data = dataFixture();
  for (const changes of [{ owner: other }, { miner: { taskId: 221n } }, { miner: { verifWeight: 62n } },
    { miner: { circuits: other } }, { miner: { circuitId: 16481n } }, { miner: { status: 0n } },
    { miner: { status: 2n } }, { miner: { optimal: true } }, { miner: { verifWeight: 0n } }, { miner: { unverWeight: 1n } }])
    await assert.rejects(checkMinerOnchain(chainFixture(data.quote, changes).provider, data.quote));
});

test('inactive or stale official listings remain reference-only and cannot create a fixed draft', async () => {
  const data = dataFixture();
  for (const listing of [{ valid: false }, { id: 0n }, { price: 0n }, { seller: other }]) {
    const chain = await checkMinerOnchain(chainFixture(data.quote, { listing }).provider, data.quote);
    assert.equal(chain.official, null);
    assert.throws(() => operatorQuoteDraft({ quote: data.quote, chain, reference: data.reference }), /没有.*官网挂单/);
  }
});

test('Firsto listing price/buyer total never replace the independently verified official purchase price', async () => {
  const data = dataFixture(), rpc = chainFixture(data.quote), api = apiFixture(data);
  const checked = await loadOperatorQuote({ collection: data.quote.collection, tokenId: data.quote.tokenId, provider: rpc.provider, fetcher: api.fetcher });
  const draft = operatorQuoteDraft(checked, { extraBps: 1000 });
  assert.equal(checked.quote.ask.priceWei, '2355000000000000001');
  assert.equal(checked.quote.ask.buyerCostWei, '2378550000000000002');
  assert.equal(draft.params.priceCapWei, '2000000000000000001');
  assert.equal(draft.params.targetRaiseWei, '2200000000000000100');
  assert.equal(draft.params.circuits, getAddress(data.quote.collection));
  assert(!Object.hasOwn(draft, 'transaction')); assert.equal(api.requests.length, 3);
});

test('flexible draft uses capacity reference times atomic BEM yield, exact rounding and bound task/weight', async () => {
  const data = dataFixture(), chain = await checkMinerOnchain(chainFixture(data.quote).provider, data.quote);
  const draft = operatorQuoteDraft({ quote: data.quote, chain, reference: data.reference }, { mode: 'createFlexiblePoolChecked', extraBps: 1234, fundingHours: '12', purchaseHours: '36' });
  const cap = (3000000000000000001n * 123456789n + 99999999n) / 100000000n;
  const target = ((cap * 11234n + 999999n) / 1000000n) * 100n;
  assert.equal(draft.params.priceCapWei, cap.toString()); assert.equal(draft.params.targetRaiseWei, target.toString());
  assert.equal(draft.params.directSeller, ZeroAddress); assert.equal(draft.params.directPrice, '0');
  assert.equal(draft.params.fundingHours, '12'); assert.equal(draft.params.purchaseHours, '36');
  assert.equal(draft.expectedTaskId, '220'); assert.equal(draft.expectedReferenceWeight, '61');
  assert.equal(draft.flexible.minVerifiedWeight, '61'); assert.equal(draft.flexible.targetDailyYieldAtomic, '123456789');
  assert.match(draft.flexible.referenceDigest, /^0x[\da-f]{64}$/i);
  assert.equal(draft.flexible.referenceBlock, data.reference.sourceBlock);
  assert.equal(draft.flexible.referenceObservedAt, Math.floor(data.reference.observedAt / 1000));
});

test('stale/future quotes, expired asks and stale/future chain checks never become drafts', async () => {
  const data = dataFixture(), chain = await checkMinerOnchain(chainFixture(data.quote).provider, data.quote), now = Date.now();
  const checked = { quote: data.quote, chain, reference: data.reference };
  for (const mutate of [item => { item.quote.source.observedAt = now - 300001; }, item => { item.quote.source.observedAt = now + 30001; },
    item => { item.quote.ask.expiresAt = now; }, item => { item.chain.checkedAt = now - 300001; }, item => { item.chain.checkedAt = now + 30001; }]) {
    const changed = structuredClone(checked); mutate(changed);
    assert.throws(() => operatorQuoteDraft(changed, {}, now), /超过|超前|过期/);
  }
  const staleReference = { ...checked, reference: { ...data.reference, observedAt: now - 300001 } };
  assert.throws(() => operatorQuoteDraft(staleReference, { mode: 'createFlexiblePoolChecked' }, now), /超过/);
  assert(operatorQuoteDraft(staleReference, {}, now), 'fixed official price does not depend on reference freshness');
  for (const extraBps of [-1, 10001, 0.5]) assert.throws(() => operatorQuoteDraft(checked, { extraBps }, now), /预算/);
  for (const fundingHours of ['0', '-1', '1.5']) assert.throws(() => operatorQuoteDraft(checked, { fundingHours }, now));
});

test('reference failure preserves a checked fixed quote but blocks flexible budget generation', async () => {
  const data = dataFixture(), rpc = chainFixture(data.quote), api = apiFixture(data, { referenceFails: true });
  const checked = await loadOperatorQuote({ collection: data.quote.collection, tokenId: data.quote.tokenId, provider: rpc.provider, fetcher: api.fetcher });
  assert.equal(checked.reference, null); assert.match(checked.referenceError, /Firsto.*503/);
  assert(operatorQuoteDraft(checked));
  assert.throws(() => operatorQuoteDraft(checked, { mode: 'createFlexiblePoolChecked' }), /503/);
});

test('non-official identities are excluded from discovery and cannot reach on-chain quote reads', async () => {
  const data = dataFixture(); data.page.rows[0].collection = other;
  const rpc = chainFixture(data.quote), api = apiFixture(data);
  const page = await listOperatorQuotes({}, { fetcher: api.fetcher });
  assert.equal(page.rows.length, 0); assert.equal(page.excluded, 1);
  assert.match(api.requests[0].input, /sort=price_low/);
  await listOperatorQuotes({ sort: 'daily_capacity_price_low' }, { fetcher: api.fetcher });
  assert.match(api.requests[1].input, /sort=daily_capacity_price_low/);
  await assert.rejects(loadOperatorQuote({ collection: other, tokenId: '16480', provider: rpc.provider, fetcher: api.fetcher }), /只接受官方/);
  await assert.rejects(checkMinerOnchain(rpc.provider, { ...data.quote, collection: other }), /官方矿机/);
  assert.equal(rpc.requests.length, 0);
});

test('failed concurrent owner read drains pending market reads and never continues to getMiner', async () => {
  const data = dataFixture(), rpc = chainFixture(data.quote), original = rpc.provider.request.bind(rpc.provider);
  let release, listingStarted;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { listingStarted = resolve; });
  rpc.provider.request = async input => {
    if (input.method === 'eth_call' && getAddress(input.params[0].to) === getAddress(data.quote.collection)) throw new Error('owner read unavailable');
    if (input.method === 'eth_call' && getAddress(input.params[0].to) === MARKET) { listingStarted(); await gate; }
    return original(input);
  };
  let settled = false;
  const result = checkMinerOnchain(rpc.provider, data.quote).then(() => assert.fail('must reject'), error => {
    settled = true; assert.match(error.message, /owner read unavailable/);
  });
  const timer = setTimeout(release, 1500);
  try {
    await started; await new Promise(resolve => setImmediate(resolve));
    assert.equal(settled, false); assert(!rpc.calls.includes('getMiner'));
  } finally { release(); clearTimeout(timer); await result; }
  assert(!rpc.calls.includes('getMiner'));
});

test('stale or mismatched HTTP detail fails before any on-chain request', async () => {
  for (const fault of ['owner', 'yield', 'stale']) {
    const data = dataFixture(), rpc = chainFixture(data.quote);
    if (fault === 'owner') data.detail.asset.owner = other;
    if (fault === 'yield') data.detail.asset.mining.estimated24hAtomic = '1';
    if (fault === 'stale') Object.keys(data.page.sourceFreshness).forEach(key => { data.page.sourceFreshness[key] = Date.now() - 300001; });
    const api = apiFixture(data);
    await assert.rejects(loadOperatorQuote({ collection: data.quote.collection, tokenId: data.quote.tokenId, provider: rpc.provider, fetcher: api.fetcher }));
    assert.equal(rpc.requests.length, 0, fault);
  }
});

test('empty/truncated imports and malformed public JSON explain recovery in plain language', async () => {
  for (const input of ['', '   ', null, undefined]) assert.throws(() => parseOperatorImport(input), /选择矿机.*完整报价/);
  for (const input of ['{', '{"params":', 'not json']) assert.throws(() => parseOperatorImport(input), /JSON.*不完整或格式错误/);
  for (const input of ['{}', 'null', '[]']) assert.throws(() => parseOperatorImport(input), /缺少建池参数/);
  const imported = { params: {}, flexible: {}, expectedTaskId: '220', expectedReferenceWeight: '61' };
  assert.deepEqual(parseOperatorImport(JSON.stringify(imported)), imported);
  const data = dataFixture(), api = apiFixture(data, { invalidJson: true });
  await assert.rejects(listOperatorQuotes({}, { fetcher: api.fetcher }), error => /内容不完整.*重新获取/.test(operatorQuoteError(error)));
  assert.match(operatorQuoteError(Object.assign(new Error('abort'), { name: 'AbortError' })), /超时.*重新获取/);
});
