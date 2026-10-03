import assert from 'node:assert/strict';
import test from 'node:test';
import { ZeroAddress } from 'ethers';
import { readPortfolioCurrent, readPortfolioPage, readPortfolioDisplayRow, portfolioPageActionReady } from '../lib/live-portfolios.mjs';
import { portfolioFixture, PORTFOLIOS } from './portfolio-fixture.mjs';

const json = value => JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? { $bemineBigInt: item.toString() } : item);
async function fixture() {
  const f = portfolioFixture(), config = { ...f.config, productFamily: 'fresh-v4', displayOnly: true,
    operationalReady: false, transactionReady: false };
  const setupProvider = { request: input => f.request({ ...input, params: [input.params[0], '0x64'] }) };
  const row = await readPortfolioCurrent(config, setupProvider, PORTFOLIOS[0], f.account, { includeChildren: false });
  const source = { ...f.source(), readMode: 'display', displayOnly: true, transactionReady: false, stale: false,
    cacheOrigin: 'server', cacheAgeMs: 10, refreshing: false };
  let calls = 0; const provider = { request: () => { calls++; throw new Error('cached page must not call browser RPC'); } };
  return { ...f, config, row, source, provider, get calls() { return calls; } };
}

test('server portfolio directory and detail decode exact cached fields with zero browser RPC and no transaction proof', async () => {
  const f = await fixture(), urls = [];
  const fetcher = async url => {
    const u = new URL(url); urls.push(u);
    const data = u.pathname.endsWith('/portfolios') ? { items: [f.row], nextCursor: null } : { item: f.row };
    return new Response(json({ source: f.source, data }), { headers: { 'content-type': 'application/json' } });
  };
  const page = await readPortfolioPage(f.config, f.provider, { account: f.account, mine: true, fetcher });
  const detail = await readPortfolioDisplayRow(f.config, f.provider, PORTFOLIOS[0], f.account, { fetcher });
  assert.equal(f.calls, 0); assert.equal(page.items[0].shares, 10n); assert.equal(detail.item.budgetWei, 5000000000000000n);
  assert.equal(detail.item.blockNumber, null); assert.equal(detail.item.blockHash, null);
  assert.equal(page.source.transactionReady, false); assert.equal(page.source.displayOnly, true); assert.equal(page.operator, null);
  assert.equal(urls[0].searchParams.get('account'), f.account); assert.equal(urls[0].searchParams.get('mine'), 'true');
  assert.equal(urls[1].searchParams.get('children'), 'true');
  assert.equal(portfolioPageActionReady({ config: f.config, freshRead: true, listingSource: page.source }), true);
});

test('server portfolio cache rejects a different account, wrong project or duplicate page without falling back to RPC', async () => {
  const f = await fixture();
  const response = data => async () => new Response(json({ source: f.source, data }), { headers: { 'content-type': 'application/json' } });
  await assert.rejects(readPortfolioDisplayRow(f.config, f.provider, PORTFOLIOS[0], f.account,
    { fetcher: response({ item: { ...f.row, account: ZeroAddress } }) }), /账户不一致/);
  await assert.rejects(readPortfolioDisplayRow(f.config, f.provider, PORTFOLIOS[1], f.account,
    { fetcher: response({ item: f.row }) }), /与请求不一致/);
  await assert.rejects(readPortfolioPage(f.config, f.provider, { account: f.account,
    fetcher: response({ items: [f.row, f.row], nextCursor: null }) }), /分页重复/);
  assert.equal(f.calls, 0);
});

test('404 and unavailable portfolio cache never fan out into paid browser RPC calls', async () => {
  for (const status of [404,503]) {
    const f = await fixture(), calls = [];
    const provider = { async request(input) { calls.push(input); assert.equal(input.method, 'eth_call'); return f.request(input); } };
    const fetcher = async url => new URL(url).pathname.includes('/v1/display/')
      ? new Response('{}', { status })
      : new Response(json({ ...f.index(url), source: f.source }), { headers: { 'content-type': 'application/json' } });
    await assert.rejects(readPortfolioDisplayRow(f.config, provider, PORTFOLIOS[0], f.account, { fetcher }));
    assert.equal(calls.length, 0);
  }
});
