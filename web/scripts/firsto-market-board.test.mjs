import test from 'node:test';
import assert from 'node:assert/strict';
import { dataFixture, apiFixture } from './operator-quotes-fixture.mjs';
import {
  dailyCapacityPriceWei,
  marketQuoteView,
  marketReferenceView,
  readFirstoMarketBoard,
  formatMarketAmount,
} from '../components/firsto-market-board.mjs';

test('per-miner daily-capacity prices distinguish exact seller ask and buyer total', () => {
  const data = dataFixture(), quote = marketQuoteView(data.quote, data.now);
  const expected = BigInt(data.row.bestAsk.priceWei) * 100_000_000n / 123_456_789n;
  assert.equal(quote.dailyCapacityPriceWei, expected.toString());
  assert.equal(quote.buyerCostWei, data.row.bestAsk.buyerCostWei);
  assert.equal(quote.buyerDailyCapacityPriceWei,
    dailyCapacityPriceWei(data.row.bestAsk.buyerCostWei, data.row.mining.estimated24hAtomic));
  assert.notEqual(quote.dailyCapacityPriceWei, quote.buyerDailyCapacityPriceWei);
  assert.equal(dailyCapacityPriceWei('1', '300000000'), '0');
  assert.equal(dailyCapacityPriceWei('0', '100000000'), null);
  assert.equal(dailyCapacityPriceWei('1', '0'), null);
  assert.equal(formatMarketAmount(null), '暂不可用');
});

test('Firsto board floors the real 16736 ask and separately priced buyer total', () => {
  const data = dataFixture();
  const quote = marketQuoteView({ ...data.quote, estimated24hAtomic: '432000',
    ask: { ...data.quote.ask, priceWei: '15000000000000000', buyerCostWei: '15150000000000000' } }, data.now);
  assert.equal(quote.dailyCapacityPriceWei, '3472222222222222222');
  assert.equal(quote.buyerDailyCapacityPriceWei, '3506944444444444444');
  assert.equal(formatMarketAmount(quote.dailyCapacityPriceWei), '3.47222');
  assert.equal(formatMarketAmount(quote.buyerDailyCapacityPriceWei), '3.50694');
  assert.equal(dailyCapacityPriceWei('1', '3'), '33333333');
  assert.equal(dailyCapacityPriceWei('3', '3'), '100000000');
});

test('stale, changed-owner and invalid mining quotes expose no executable-looking prices', () => {
  const data = dataFixture();
  for (const change of [
    quote => { quote.source.observedAt = data.now - 300_001; },
    quote => { quote.owner = '0x2222222222222222222222222222222222222222'; },
    quote => { quote.status = 'unverified'; },
    quote => { quote.unverifiedWeight = '1'; },
    quote => { quote.estimated24hAtomic = null; },
    quote => { quote.ask.expiresAt = data.now; },
  ]) {
    const copy = structuredClone(data.quote); change(copy);
    const view = marketQuoteView(copy, data.now);
    assert(view.unavailable);
    assert.equal(view.sellerPriceWei, null);
    assert.equal(view.buyerCostWei, null);
    assert.equal(view.dailyCapacityPriceWei, null);
    assert.equal(view.buyerDailyCapacityPriceWei, null);
  }
});

test('market reference requires complete coverage, BEM units, positive wei and fresh source', () => {
  const data = dataFixture(); data.referenceRaw.coverage = { holders: 'complete', market24h: 'complete' };
  assert.equal(marketReferenceView(data.referenceRaw, data.now).dailyCapacityPriceWei,
    data.referenceRaw.marketStats.dailyCapacityPriceWei);
  for (const mutate of [
    raw => { raw.coverage.market24h = 'partial'; },
    raw => { raw.tokenDecimals = 18; },
    raw => { raw.marketStats.dailyCapacityPriceWei = '0'; },
    raw => { raw.asOf = new Date(data.now - 300_001).toISOString(); },
  ]) {
    const copy = structuredClone(data.referenceRaw); mutate(copy);
    assert.throws(() => marketReferenceView(copy, data.now));
  }
});

test('board reads only current public server-proxy quotes and leaves failed reference unavailable', async () => {
  const data = dataFixture(); data.referenceRaw.coverage = { holders: 'complete', market24h: 'complete' };
  const api = apiFixture(data);
  const board = await readFirstoMarketBoard({ fetcher: api.fetcher, now: data.now });
  assert.equal(board.rows.length, 1);
  assert.equal(board.rows[0].series, 'TapeOut');
  assert.equal(board.reference.dailyCapacityPriceWei, data.referenceRaw.marketStats.dailyCapacityPriceWei);
  assert.equal(board.sourceBlock, '100');
  assert.equal(api.requests.length, 2);
  assert(api.requests.every(item => item.init.method === 'GET' && item.init.cache === 'no-store'
    && item.init.credentials === 'omit'));
  assert.match(api.requests[0].input, /sort=daily_capacity_price_low/);
  assert.match(api.requests[0].input, /pageSize=30/);
  const failedReference = await readFirstoMarketBoard({ fetcher: apiFixture(data, { referenceFails: true }).fetcher,
    now: data.now });
  assert.equal(failedReference.reference, null);
  assert.match(failedReference.referenceError, /503/);
  assert.equal(failedReference.rows.length, 1);
  await assert.rejects(readFirstoMarketBoard({ fetcher: api.fetcher, viewId: 'different-view', now: data.now }),
    /快照已变化/);
});
