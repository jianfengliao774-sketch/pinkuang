import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createQuotePlan, fetchMineQuote, fetchQuotePage, formatExact, MAX_QUOTE_AGE_MS, OFFICIAL_COLLECTIONS, parseCapacityReference, parseQuotePage, quoteIssue, referenceIssue, verifyQuoteDetail } from './pricing';

const now = Date.now();
const seller = '0x1111111111111111111111111111111111111111';
const exchange = '0x33423244f9a5bf81b12b1a018af6f4e079b97f29';
const askId = `0x${'a'.repeat(64)}`;
const freshness = {
  'circuit_collections:0x68224f668083c29e9800be2a646d42d18cedf7e2': now - 1000,
  'official_circuit_mining:0x7e2e0dc66a3bd9103e69b766afa62d9f7b697b46': now - 1500,
  'blockfeed:bsc-tapeout-markets-shadow-v1:circuit-orders': now - 500,
  [`circuit_signed_ask_exchange:${exchange}`]: now - 2000,
  'circuit_container_state:unrelated': now - 10_000_000,
};
function row() {
  return {
    collection: String(OFFICIAL_COLLECTIONS.TapeOut), tokenId: '16480', processorName: 'TapeOut', owner: seller, category: 'official_mining', classification: 'official_mining',
    bestAsk: { id: askId, account: seller, venue: 'firsto', priceWei: '2355000000000000000', buyerCostWei: '2378550000000000000', expiresAt: new Date(now + 86_400_000).toISOString(), status: 'open', execution: { kind: 'signed_ask', chainId: 56, exchange, maker: seller, feeBps: 100, schemaVersion: '2', collection: OFFICIAL_COLLECTIONS.TapeOut, tokenId: '16480', priceWei: '2355000000000000000' } },
    bestBid: { sellerNetWei: '1234000000000000001' },
    mining: { status: 'verified', taskId: '220', verifiedWeight: '61', unverifiedWeight: '0', estimated24hAtomic: '28512000', tokenSymbol: 'BEM', tokenDecimals: 8 },
    listingReference: { priceWei: '2355000000000000000', dailyCapacityPriceWei: '8259680134680134680' },
  };
}
function page(rows = [row()]) { return { rows, page: 1, pageSize: 30, totalPages: 1, total: rows.length, viewId: 'test-view', sourceBlock: '124098316', sourceFreshness: { ...freshness } }; }
function reference() { return parseCapacityReference({ tokenSymbol: 'BEM', tokenDecimals: 8, marketStats: { dailyCapacityPriceWei: '8226495726495726495' }, asOf: new Date(now - 1000).toISOString(), sourceBlock: '124098316', viewId: 'holder-view' }, now); }
function detail() { const item = row(); return { asset: { ...item }, orders: { asksAndOnchainBids: [], signedAsks: [{ askHash: askId, maker: seller, status: 'open', priceWei: item.bestAsk.priceWei, buyerCostWei: item.bestAsk.buyerCostWei }] } }; }
function quote() { return verifyQuoteDetail(parseQuotePage(page(), now).rows[0], detail()); }

test('Firsto price, buyer total, bid proceeds and BEM decimals remain independent exact integers', () => {
  const result = parseQuotePage(page(), now).rows[0];
  assert.equal(result.ask?.priceWei, '2355000000000000000');
  assert.equal(result.ask?.buyerCostWei, '2378550000000000000');
  assert.equal(result.bestBidSellerNetWei, '1234000000000000001');
  assert.equal(formatExact(result.ask!.priceWei), '2.355');
  assert.equal(formatExact(result.estimated24hAtomic, 8), '0.28512');
  assert.equal(result.source.observedAt, now - 2000, 'unrelated container cache must not determine ask freshness');
  assert.equal(quoteIssue(result, now), null);
});

test('same-name fake official collection, wrong classification and incorrect units are excluded', () => {
  const counterfeit = row(); counterfeit.collection = '0x2222222222222222222222222222222222222222';
  const wrongUnit = row(); wrongUnit.mining.tokenDecimals = 18;
  const wrongCategory = row(); wrongCategory.classification = 'other';
  const wrongAmount = row(); (wrongAmount.bestAsk as unknown as { priceWei: number }).priceWei = 2355000000000000000;
  const result = parseQuotePage(page([counterfeit, wrongUnit, wrongCategory, wrongAmount, row()]), now);
  assert.equal(result.rows.length, 1); assert.equal(result.excluded, 4);
});

test('stale, missing or future source timestamps prevent quote use without guessing', () => {
  const result = quote();
  assert.match(quoteIssue(result, now + MAX_QUOTE_AGE_MS)!, /超过 5 分钟/);
  result.source.observedAt = now + 60_000;
  assert.match(quoteIssue(result, now)!, /超前/);
  const missing = page(); delete (missing.sourceFreshness as Record<string, number>)['blockfeed:bsc-tapeout-markets-shadow-v1:circuit-orders'];
  assert.match(quoteIssue(parseQuotePage(missing, now).rows[0], now)!, /缺少报价来源/);
  assert.throws(() => parseQuotePage({ ...page(), sourceFreshness: undefined }, now), /来源更新时间/);
  const mixedFuture = page(); mixedFuture.sourceFreshness['circuit_collections:0x68224f668083c29e9800be2a646d42d18cedf7e2'] = now + 60_000;
  assert.match(quoteIssue(parseQuotePage(mixedFuture, now).rows[0], now)!, /超前/, 'one future source must not be masked by another fresh timestamp');
});

test('an expired or absent ask is never replaced with listingReference', () => {
  const result = quote(); result.ask!.expiresAt = now - 1;
  assert.match(quoteIssue(result, now)!, /过期/);
  result.ask = null; assert.match(quoteIssue(result, now)!, /没有有效卖单/);
  assert.ok(result.listingReference);
});

test('reference requires positive precise data with a real asOf time and correct token units', () => {
  assert.equal(referenceIssue(reference(), now), null);
  assert.match(referenceIssue(reference(), now + MAX_QUOTE_AGE_MS)!, /超过/);
  assert.throws(() => parseCapacityReference({ tokenSymbol: 'BEM', tokenDecimals: 18, marketStats: {} }), /币种/);
  assert.throws(() => parseCapacityReference({ tokenSymbol: 'BEM', tokenDecimals: 8, marketStats: { dailyCapacityPriceWei: '0' } }), /暂不可用/);
});

test('detail must match the exact collection, token, owner, yield and actual ask amounts', () => {
  const original = parseQuotePage(page(), now).rows[0];
  assert.equal(verifyQuoteDetail(original, detail()).detailChecked, true);
  const changedOwner = detail(); changedOwner.asset.owner = exchange;
  assert.throws(() => verifyQuoteDetail(original, changedOwner), /持有人已变化/);
  const changedPrice = detail(); changedPrice.orders.signedAsks[0].buyerCostWei = '1';
  assert.throws(() => verifyQuoteDetail(original, changedPrice), /挂单不一致/);
  const changedYield = detail(); changedYield.asset.mining.estimated24hAtomic = '999';
  assert.throws(() => verifyQuoteDetail(original, changedYield), /产能已变化/);
  const changedTask = detail(); changedTask.asset.mining.taskId = '221';
  assert.throws(() => verifyQuoteDetail(original, changedTask), /型号/);
});

test('funding uses capacity reference, adds 10 percent, and rounds upward to 100 integer-wei shares', () => {
  const plan = createQuotePlan(quote(), reference(), 1000, '61', now);
  const numerator = BigInt(reference().dailyCapacityPriceWei) * 28512000n;
  const expectedBase = (numerator + 99999999n) / 100000000n;
  const expectedRaise = ((expectedBase * 11000n + 999999n) / 1000000n) * 100n;
  assert.equal(plan.flexiblePurchase.referencePriceWei, expectedBase.toString());
  assert.equal(plan.funding.targetRaiseWei, expectedRaise.toString());
  assert.equal(plan.funding.priceCapWei, expectedBase.toString(), 'additional funding must not raise the purchase cap');
  assert.equal(BigInt(plan.funding.pricePerShareWei) * 100n, expectedRaise);
  assert.notEqual(plan.funding.targetRaiseWei, quote().ask!.buyerCostWei);
  assert.equal(plan.flexiblePurchase.referenceObservedAt, Math.floor(reference().observedAt / 1000));
  assert.match(plan.sourceDigest, /^0x[0-9a-f]{64}$/);
  assert.equal(plan.flexiblePurchase.referenceDigest, plan.sourceDigest);
  assert.equal(plan.eligibility.expectedTaskId, '220');
  assert.equal(plan.eligibility.expectedReferenceVerifiedWeight, '61');
  assert.equal(plan.eligibility.modelSource, 'reference-nft-onchain');
  assert.equal(plan.eligibility.originalTargetFirst, true);
});

test('lowering minimum eligibility or increasing surplus funding never changes the reference pricing denominator', () => {
  const strict = createQuotePlan(quote(), reference(), 1000, '61', now);
  const relaxed = createQuotePlan(quote(), reference(), 10_000, '1', now);
  assert.equal(relaxed.flexiblePurchase.minVerifiedWeight, '1');
  assert.equal(relaxed.eligibility.expectedReferenceVerifiedWeight, '61');
  assert.equal(relaxed.eligibility.expectedReferenceVerifiedWeight, strict.eligibility.expectedReferenceVerifiedWeight);
  assert.equal(relaxed.funding.priceCapWei, strict.funding.priceCapWei);
  assert.ok(BigInt(relaxed.funding.targetRaiseWei) > BigInt(strict.funding.targetRaiseWei));
  assert.match(relaxed.notes.join(' '), /更低权重.*降价/);
  assert.match(relaxed.notes.join(' '), /链上.*锁定/);
});

test('purchase cap keeps exact reference wei even when funding requires rounding to one hundred shares', () => {
  const target = { ...quote(), estimated24hAtomic: '100000000' };
  const smallReference = { ...reference(), dailyCapacityPriceWei: '1001' };
  const plan = createQuotePlan(target, smallReference, 0, '61', now);
  assert.equal(plan.flexiblePurchase.referencePriceWei, '1001');
  assert.equal(plan.funding.targetRaiseWei, '1100');
  assert.equal(plan.funding.priceCapWei, '1001', 'rounding dust is not additional procurement authorization');
  assert.equal(plan.funding.pricePerShareWei, '11');
});

test('unsafe eligibility, unverified detail, stale reference and out-of-bounds budget cannot generate a plan', () => {
  const original = quote();
  assert.throws(() => createQuotePlan({ ...original, detailChecked: false }, reference(), 1000, '61', now), /核对/);
  assert.throws(() => createQuotePlan({ ...original, status: 'optimal' }, reference(), 1000, '61', now), /非最优/);
  assert.throws(() => createQuotePlan({ ...original, unverifiedWeight: '1' }, reference(), 1000, '61', now), /未验证权重/);
  assert.throws(() => createQuotePlan({ ...original, taskId: null }, reference(), 1000, '61', now), /任务型号/);
  assert.throws(() => createQuotePlan({ ...original, taskId: '4294967296' }, reference(), 1000, '61', now), /uint32/);
  assert.throws(() => createQuotePlan({ ...original, verifiedWeight: (1n << 128n).toString() }, reference(), 1000, '1', now), /uint128/);
  assert.throws(() => createQuotePlan(original, reference(), 1000, '62', now), /最低验证权重/);
  assert.throws(() => createQuotePlan(original, reference(), 10001, '61', now), /额外预算/);
  assert.throws(() => createQuotePlan(original, { ...reference(), observedAt: now - MAX_QUOTE_AGE_MS - 1 }, 1000, '61', now), /超过/);
});

test('fetches only bounded same-origin GET queries and cross-checks identity against detail', async () => {
  const seen: { url: string; method: string | undefined }[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input); seen.push({ url, method: init?.method });
    return new Response(JSON.stringify(url.includes('/v1/circuit/') ? detail() : page()), { headers: { 'content-type': 'application/json' } });
  };
  const result = await fetchMineQuote(OFFICIAL_COLLECTIONS.TapeOut, '16480', { baseUrl: '/firsto-api', fetcher });
  assert.equal(result.detailChecked, true); assert.equal(seen.length, 2);
  assert.ok(seen.every(item => item.method === 'GET' && item.url.startsWith('/firsto-api/v1/')));
  assert.match(seen[0].url, /category=official_mining/); assert.match(seen[0].url, /pageSize=50/);
  await assert.rejects(fetchMineQuote(seller, '16480', { fetcher }), /只接受官方/);
  assert.equal(seen.length, 2, 'counterfeit identity is rejected before network access');
});

test('HTTP, invalid content and excessive query cannot silently reuse cached quotations', async () => {
  await assert.rejects(fetchQuotePage({}, { baseUrl: '/firsto-api', fetcher: async () => new Response('down', { status: 503 }) }), /HTTP 503/);
  await assert.rejects(fetchQuotePage({}, { baseUrl: '/firsto-api', fetcher: async () => new Response('<html>SPA</html>', { headers: { 'content-type': 'text/html' } }) }), /未返回 JSON/);
  await assert.rejects(fetchQuotePage({ query: 'x'.repeat(129) }), /搜索内容/);
  await assert.rejects(fetchQuotePage({}, { baseUrl: '/firsto-api', fetcher: async () => new Response(' '.repeat(2_000_001), { headers: { 'content-type': 'application/json' } }) }), /读取上限/);
});
