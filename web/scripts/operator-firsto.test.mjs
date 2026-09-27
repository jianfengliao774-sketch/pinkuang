import test from 'node:test';
import assert from 'node:assert/strict';
import { ZeroAddress } from 'ethers';
import { abi, ARTIFACT_DIGEST } from '../lib/chain-client.mjs';
import { prepareAdminAction, readOperatorStatus, sameAdminPurchasePreview } from '../lib/live-admin.mjs';
import { loadOperatorQuote, operatorQuoteDraft, readMachineRegistry } from '../lib/operator-quotes.mjs';
import { operatorFirstoFixture } from './operator-firsto-fixture.mjs';

const quote = f => loadOperatorQuote({ collection: f.data.quote.collection, tokenId: '7', config: f.config,
  provider: f.provider, fetcher: f.api.fetcher });
const createParams = f => ({ circuits: f.data.quote.collection, circuitId: '7', targetRaiseWei: '10000000000000000',
  priceCapWei: '6000000000000000', fundingHours: '24', purchaseHours: '48' });
function officialCandidates(f, { candidates = [], complete = true } = {}) {
  return { complete, chainId: 56, factory: f.config.factory, artifactDigest: ARTIFACT_DIGEST, pool: f.pool,
    blockNumber: '100', blockHash: `0x${'12'.repeat(32)}`, flexible: true,
    model: { circuits: f.data.quote.collection, taskId: '220', minVerifiedWeight: '50',
      referenceVerifiedWeight: '61', referencePriceWei: '10000000000000000', priceCap: f.rows[0].params.priceCap.toString() },
    candidates };
}
const alternative = f => ({ listingId: '46', collection: f.data.quote.collection, tokenId: '8',
  seller: f.source.account, priceWei: '4000000000000000', verifiedWeight: '61' });
function marketFetcher(f, marketResponse, { firsto = true } = {}) {
  return async (input, init) => {
    if (new URL(input, 'https://local.example').pathname.endsWith('/api/journal/official-candidates')) {
      return new Response(JSON.stringify(marketResponse), { headers: { 'Content-Type': 'application/json' } });
    }
    if (!firsto) throw new Error('Firsto must not be read while an official purchase is executable.');
    return f.api.fetcher(input, init);
  };
}

test('new registry plus signed Firsto order produces a fixed draft with fee-inclusive cap and exact 100-share rounding', async () => {
  const f = await operatorFirstoFixture(), checked = await quote(f), draft = operatorQuoteDraft(checked);
  assert.equal(checked.chain.registry.supported, true); assert.equal(checked.chain.registry.pool, ZeroAddress);
  assert.equal(checked.chain.firsto.feeWei, '50000000000000');
  assert.equal(draft.params.priceCapWei, '5050000000000001');
  assert.equal(draft.params.targetRaiseWei, '5555000000000100');
  const flex = operatorQuoteDraft(checked, { mode: 'createFlexiblePoolChecked' });
  const cap = (3000000000000000001n * 123456789n + 99999999n) / 100000000n;
  assert.equal(flex.params.priceCapWei, cap.toString(), 'capacity cap formula is unchanged');
  assert(f.calls.every(call => !/send|sign|wallet_/.test(call.method)));
});

test('old deployment, incomplete migration and batch ask never enable Firsto procurement', async () => {
  for (const options of [{ old: true }, { ready: false }]) {
    const f = await operatorFirstoFixture(options), checked = await quote(f);
    assert.equal(checked.chain.firsto, null);
    assert.throws(() => operatorQuoteDraft(checked), /登记/);
    const status = await readOperatorStatus({ provider: f.provider, config: f.config, account: f.account });
    assert.equal(status.machineRegistry.ready, false);
  }
  const f = await operatorFirstoFixture();
  f.data.row.bestAsk.execution.kind = 'circuit_batch_ask';
  f.data.page.sourceFreshness[`circuit_batch_ask_exchange:${f.source.execution.exchange.toLowerCase()}`] = Date.now();
  const checked = await quote(f);
  assert.equal(checked.chain.firsto, null); assert.match(checked.chain.firstoError, /批量/);
});

test('duplicate target displays the existing pool and blocks both fixed and flexible creation before simulation', async () => {
  const f = await operatorFirstoFixture(); f.state.registryPool = f.pool;
  const checked = await quote(f);
  for (const mode of ['createPool', 'createFlexiblePoolChecked'])
    assert.throws(() => operatorQuoteDraft(checked, { mode }), error => error.message.includes(f.pool));
  await assert.rejects(prepareAdminAction({ provider: f.provider, config: f.config, account: f.account,
    kind: 'createPool', params: createParams(f) }), error => error.message.includes(f.pool));
  assert.equal(f.simulations.length, 0);
});

test('registry transport failure cannot be mistaken for an old compatible deployment', async () => {
  const failure = Object.assign(new Error('RPC timeout'), { code: -32005 });
  await assert.rejects(readMachineRegistry({ request: async () => { throw failure; } }, { factory: (await operatorFirstoFixture()).config.factory }), error => error === failure);
});

test('missing or unfinished registry rejects every new creation path, even with an official quote or manual parameters', async () => {
  for (const options of [{ old: true }, { ready: false }]) {
    const f = await operatorFirstoFixture(options), checked = await quote(f);
    const official = { ...checked, chain: { ...checked.chain, official: { id: '45', priceWei: '5000000000000001' } } };
    for (const kind of ['createPool', 'createFlexiblePoolChecked']) {
      assert.throws(() => operatorQuoteDraft(official, { mode: kind }), /登记/);
      await assert.rejects(prepareAdminAction({ provider: f.provider, config: f.config, account: f.account,
        kind, params: createParams(f), flexible: {} }), /登记/);
    }
    assert.equal(f.simulations.length, 0);
  }
});

test('pool automatically discovers original Firsto order; preview freezes bytes and reconfirmation never fetches a replacement', async t => {
  const f = await operatorFirstoFixture(); f.state.registryPool = f.pool;
  t.mock.method(globalThis, 'fetch', f.api.fetcher);
  const preview = await prepareAdminAction({ provider: f.provider, config: f.config, account: f.account, kind: 'buyFromFirsto', pool: f.pool });
  const parsed = abi.PoolVault.parseTransaction(preview.transaction);
  assert.equal(parsed.name, 'buyFromFirsto'); assert.equal(parsed.args[0], 0n);
  assert.equal(preview.transaction.value, '0x0'); assert.equal(preview.transaction.to, f.pool);
  assert.equal(preview.firsto.grossWei, '5050000000000001');
  assert.equal(preview.request.firstoOrder, parsed.args[1]); assert(Object.isFrozen(preview.request));
  const requests = f.api.requests.length;
  f.data.page.rows = []; // A newer API response must not silently change the already-reviewed order.
  const confirmed = await prepareAdminAction({ provider: f.provider, config: f.config, account: f.account, ...preview.request });
  assert.deepEqual(confirmed.transaction, preview.transaction); assert.equal(f.api.requests.length, requests);
  f.state.cancelled = true;
  await assert.rejects(prepareAdminAction({ provider: f.provider, config: f.config, account: f.account, ...preview.request }), /撤销/);
  assert.equal(f.api.requests.length, requests); assert.equal(f.simulations.length, 2);
});

test('automatic purchase takes the official listing first without reading Firsto, even when Firsto is unavailable', async t => {
  const f = await operatorFirstoFixture({ officialListing: true }); f.state.registryPool = f.pool;
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('Firsto unavailable'); });
  const preview = await prepareAdminAction({ provider: f.provider, config: f.config, account: f.account,
    kind: 'autoPurchase', pool: f.pool });
  const parsed = abi.PoolVault.parseTransaction(preview.transaction);
  assert.equal(parsed.name, 'buyFromMarket'); assert.equal(parsed.args[0], 45n);
  assert.equal(preview.kind, 'buyFromMarket'); assert.equal(preview.official.priceWei, '4000000000000000');
  assert.equal(preview.official.verifiedWeight, '61');
  assert.equal(f.api.requests.length, 0); assert.equal(f.simulations.length, 2);
  const unchanged = await prepareAdminAction({ provider: f.provider, config: f.config, account: f.account, ...preview.request });
  assert.equal(sameAdminPurchasePreview(preview, unchanged), true);
  f.officialMarket.listing.price = 4500000000000000n;
  const repriced = await prepareAdminAction({ provider: f.provider, config: f.config, account: f.account, ...preview.request });
  assert.equal(repriced.transaction.data, preview.transaction.data, 'listing ID and calldata stay the same');
  assert.equal(sameAdminPurchasePreview(preview, repriced), false, 'wallet confirmation must require a new price preview');
  f.officialMarket.listing.price = 4000000000000000n;
  f.state.registryPool = ZeroAddress;
  const checked = await loadOperatorQuote({ collection: f.data.quote.collection, tokenId: '7', config: f.config,
    provider: f.provider, fetcher: async () => { throw new Error('Firsto unavailable'); } });
  assert.equal(checked.quote, null); assert.equal(operatorQuoteDraft(checked).params.priceCapWei, '4000000000000000');
});

test('automatic purchase checks the official price cap before falling back to a verified Firsto order', async t => {
  const f = await operatorFirstoFixture({ officialListing: true }); f.state.registryPool = f.pool;
  f.officialMarket.listing.price = 20000000000000000n; // Valid but above this pool's approved cap.
  t.mock.method(globalThis, 'fetch', f.api.fetcher);
  const preview = await prepareAdminAction({ provider: f.provider, config: f.config, account: f.account,
    kind: 'autoPurchase', pool: f.pool });
  assert.equal(preview.kind, 'buyFromFirsto'); assert(preview.firsto);
  assert(f.api.requests.length > 0); assert.equal(f.simulations.length, 1);
  assert.equal(abi.PoolVault.parseTransaction(preview.transaction).name, 'buyFromFirsto');
});

test('flexible pool scans official same-task replacements before Firsto and repeats that order before signing', async t => {
  const f = await operatorFirstoFixture({ flexible: true, alternativeListing: { valid: true, price: 4000000000000000n } });
  f.config.journalBase = '/bemine/api/journal';
  f.state.registryPool = f.pool;
  const scans = []; const candidate = alternative(f);
  t.mock.method(globalThis, 'fetch', async (input, init) => {
    if (new URL(input, 'https://local.example').pathname.endsWith('/api/journal/official-candidates')) scans.push(input);
    return marketFetcher(f, officialCandidates(f, { candidates: [candidate] }), { firsto: false })(input, init);
  });
  const preview = await prepareAdminAction({ provider: f.provider, config: f.config, account: f.account,
    kind: 'autoPurchase', pool: f.pool });
  assert.equal(preview.kind, 'buyAlternativeFromMarket');
  assert.equal(preview.official.tokenId, '8'); assert.equal(preview.official.verifiedWeight, '61');
  assert.equal(abi.PoolVault.parseTransaction(preview.transaction).args[0], 46n);
  assert.equal(f.api.requests.length, 0); assert.equal(scans.length, 1);
  assert.equal(new URL(scans[0], 'https://local.example').pathname, '/bemine/api/journal/official-candidates');
  await assert.rejects(prepareAdminAction({ provider: f.provider, config: f.config, account: f.account,
    kind: 'buyFromFirsto', pool: f.pool }), /官网市场仍有可执行/);
  const confirmed = await prepareAdminAction({ provider: f.provider, config: f.config, account: f.account, ...preview.request });
  assert.equal(scans.length, 3); assert.deepEqual(confirmed.transaction, preview.transaction);
  assert.equal(sameAdminPurchasePreview(preview, confirmed), true);
  assert.equal(sameAdminPurchasePreview(preview, { ...confirmed, official: { ...confirmed.official, verifiedWeight: '62' } }), false);
});

test('an original miner that has left mining does not block a valid official replacement', async t => {
  const f = await operatorFirstoFixture({ flexible: true, officialListing: true, originalMiner: { status: 0n },
    alternativeListing: { valid: true, price: 4000000000000000n } });
  f.state.registryPool = f.pool;
  t.mock.method(globalThis, 'fetch', marketFetcher(f, officialCandidates(f, { candidates: [alternative(f)] }), { firsto: false }));
  const preview = await prepareAdminAction({ provider: f.provider, config: f.config, account: f.account,
    kind: 'autoPurchase', pool: f.pool });
  assert.equal(preview.kind, 'buyAlternativeFromMarket'); assert.equal(preview.official.tokenId, '8');
});

test('an original official miner below the locked minimum weight yields to a qualified replacement', async t => {
  const f = await operatorFirstoFixture({ flexible: true, officialListing: true,
    originalMiner: { verifWeight: 40n }, alternativeListing: { valid: true, price: 4000000000000000n } });
  f.state.registryPool = f.pool;
  const candidate = { ...alternative(f), verifiedWeight: '80' };
  t.mock.method(globalThis, 'fetch', marketFetcher(f, officialCandidates(f, { candidates: [candidate] }), { firsto: false }));
  const preview = await prepareAdminAction({ provider: f.provider, config: f.config, account: f.account,
    kind: 'autoPurchase', pool: f.pool });
  assert.equal(preview.kind, 'buyAlternativeFromMarket');
  assert.equal(preview.official.tokenId, '8');
  assert.equal(preview.official.verifiedWeight, '80');
  assert(f.simulations.length > 0 && f.simulations.every(call =>
    abi.PoolVault.parseTransaction(call.params[0]).name === 'buyAlternativeFromMarket'),
  'the ineligible original must not be simulated as a purchase');
});

test('a stale original seller hint cannot suppress another executable official miner', async t => {
  const f = await operatorFirstoFixture({ flexible: true, officialListing: true,
    originalOwner: '0x2222222222222222222222222222222222222222',
    alternativeListing: { valid: true, price: 4000000000000000n } });
  f.state.registryPool = f.pool;
  const originalHint = { ...alternative(f), listingId: '45', tokenId: '7' };
  t.mock.method(globalThis, 'fetch', marketFetcher(f, officialCandidates(f,
    { candidates: [originalHint, alternative(f)] }), { firsto: false }));
  const preview = await prepareAdminAction({ provider: f.provider, config: f.config, account: f.account,
    kind: 'autoPurchase', pool: f.pool });
  assert.equal(preview.kind, 'buyAlternativeFromMarket'); assert.equal(preview.official.tokenId, '8');
});

test('a reverting official purchase is uncertain and never licenses a Firsto fallback', async t => {
  const f = await operatorFirstoFixture({ flexible: true, alternativeExecutable: false,
    alternativeListing: { valid: true, price: 4000000000000000n } });
  f.state.registryPool = f.pool;
  t.mock.method(globalThis, 'fetch', marketFetcher(f, officialCandidates(f, { candidates: [alternative(f)] }), { firsto: false }));
  await assert.rejects(prepareAdminAction({ provider: f.provider, config: f.config, account: f.account,
    kind: 'autoPurchase', pool: f.pool }), /官网候选购机模拟未通过/);
  const original = await operatorFirstoFixture({ officialListing: true, originalExecutable: false });
  original.state.registryPool = original.pool;
  await assert.rejects(prepareAdminAction({ provider: original.provider, config: original.config,
    account: original.account, kind: 'autoPurchase', pool: original.pool }), /官网原目标挂单仍符合/);
  assert.equal(f.api.requests.length, 0);
});

test('complete empty official scan permits Firsto, while failed/incomplete scans never do', async t => {
  const f = await operatorFirstoFixture({ flexible: true }); f.state.registryPool = f.pool;
  const mock = t.mock.method(globalThis, 'fetch', marketFetcher(f, officialCandidates(f)));
  const firsto = await prepareAdminAction({ provider: f.provider, config: f.config, account: f.account,
    kind: 'autoPurchase', pool: f.pool });
  assert.equal(firsto.kind, 'buyFromFirsto'); assert(f.api.requests.length > 0);
  const apiCount = f.api.requests.length;
  mock.mock.mockImplementation(marketFetcher(f, officialCandidates(f, { complete: false })));
  await assert.rejects(prepareAdminAction({ provider: f.provider, config: f.config, account: f.account,
    kind: 'autoPurchase', pool: f.pool }), /扫描不完整/);
  assert.equal(f.api.requests.length, apiCount);
  mock.mock.mockImplementation(async input => {
    if (new URL(input, 'https://local.example').pathname.endsWith('/api/journal/official-candidates'))
      return new Response(JSON.stringify({ error: 'unavailable' }), { status: 503, headers: { 'Content-Type': 'application/json' } });
    throw new Error('Firsto must not be queried after official scan failure.');
  });
  await assert.rejects(prepareAdminAction({ provider: f.provider, config: f.config, account: f.account,
    kind: 'buyFromFirsto', pool: f.pool }), /503/);
  assert.equal(f.api.requests.length, apiCount);
  mock.mock.mockImplementation(async input => {
    if (new URL(input, 'https://local.example').pathname.endsWith('/api/journal/official-candidates'))
      return new Response(JSON.stringify({ error: 'busy' }), { status: 429, headers: { 'Content-Type': 'application/json' } });
    throw new Error('Firsto must not be queried after official scan throttling.');
  });
  await assert.rejects(prepareAdminAction({ provider: f.provider, config: f.config, account: f.account,
    kind: 'autoPurchase', pool: f.pool }), /官网候选扫描繁忙，请稍后重试/);
  assert.equal(f.api.requests.length, apiCount);
});

test('fee-inclusive cap, target identity and pool registration are checked before Firsto simulation', async t => {
  const f = await operatorFirstoFixture(); f.state.registryPool = f.pool;
  t.mock.method(globalThis, 'fetch', f.api.fetcher);
  const input = { provider: f.provider, config: f.config, account: f.account, kind: 'buyFromFirsto', pool: f.pool };
  f.rows[0].params.priceCap = 5000000000000001n; // Seller price fits, source fee does not.
  await assert.rejects(prepareAdminAction(input), /总价超过/);
  f.rows[0].params.priceCap = 10000000000000000n;
  const preview = await prepareAdminAction(input);
  f.rows[0].params.circuitId = 8n;
  await assert.rejects(prepareAdminAction({ ...input, ...preview.request }), /不是矿池原目标/);
  f.rows[0].params.circuitId = 7n; f.state.registryPool = ZeroAddress;
  await assert.rejects(prepareAdminAction({ ...input, ...preview.request }), /登记不属于/);
  assert.equal(f.simulations.length, 1);
});
