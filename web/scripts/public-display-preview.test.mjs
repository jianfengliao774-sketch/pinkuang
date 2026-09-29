import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePublicDisplaySection, publicPreviewFresh, publicPreviewRemaining, publicPreviewNeedsRefresh,
  readPublicDisplaySection } from '../lib/public-display-preview.mjs';

const addr = byte => `0x${byte.repeat(20)}`;
const hash = byte => `0x${byte.repeat(32)}`;
const manifest = { factory: addr('11'), shareMarket: addr('22'), portfolioFactory: addr('33'),
  portfolioMarket: addr('44'), deployment: { blockNumber: 90 }, verifiedBlockNumber: 95 };
const now = Date.parse('2026-09-29T12:00:00Z');
const source = { chainId: 56, factory: manifest.factory, market: manifest.shareMarket,
  portfolioFactory: manifest.portfolioFactory, portfolioMarket: manifest.portfolioMarket,
  startBlock: 90, confirmations: 12, indexedThrough: 100, indexedBlockHash: hash('ab'),
  indexedTimestamp: 1700000000, observedSafeHead: 100, complete: true, unknownReason: null,
  registeredPoolCount: '1', standalonePoolCount: '1', childPoolCount: '0', reservedChildPoolCount: '0', portfolioCount: '1',
  poolsAvailable: true, portfoliosAvailable: true, ordersAvailable: true,
  checkedAt: new Date(now - 60_000).toISOString(), readMode: 'verified_snapshot', stale: true,
  refreshing: false, transactionReady: false };
const pool = { address: addr('55'), collection: addr('66'), circuitId: '17', createdBlock: 97,
  shares: '100', trusted: true, canDeposit: true };
const portfolio = { address: addr('77'), createdBlock: 98, budgetWei: '1000000000000000000',
  absoluteCapWei: '2000000000000000000', unitCapWei: '500000000000000000',
  kind: 'portfolio', factory: manifest.portfolioFactory, memberBalance: '25', isOperator: true };
const order = { orderId: '8', pool: addr('55'), seller: addr('88'), remaining: '5',
  pricePerUnitWei: '1000000000000000', openAtSourceBlock: true, executable: false,
  listedBlock: 99, expiresAt: '1700001000', canFill: true, walletBalance: '99' };
const stats = { scope: 'confirmed_indexed_history', registeredPoolCount: '1', everParticipantAddressCount: '3',
  standalonePoolCount: '1', topLevelProjectCount: '2', portfolioCount: '1' };
const reply = (section, data) => ({ source: { ...source },
  block: { number: 100, hash: hash('ab'), timestamp: 1700000000 },
  data: data ?? (section === 'stats' ? { ...stats }
    : { items: [section === 'pools' ? { ...pool } : section === 'portfolios' ? { ...portfolio } : { ...order }],
      nextCursor: null, ...(section === 'orders' ? { ordersAvailable: true } : {}) }) });

test('each section keeps its own historical proof and drops account, transaction and eligibility fields', () => {
  const pools = parsePublicDisplaySection(reply('pools'), manifest, 'pools', { now });
  const portfolios = parsePublicDisplaySection(reply('portfolios'), manifest, 'portfolios', { now });
  const orders = parsePublicDisplaySection(reply('orders'), manifest, 'orders', { now });
  const numbers = parsePublicDisplaySection(reply('stats'), manifest, 'stats', { now });
  assert.deepEqual(pools.items[0], { address: addr('55'), collection: addr('66'), circuitId: '17', createdBlock: 97 });
  assert.deepEqual(Object.keys(portfolios.items[0]), ['address', 'createdBlock', 'budgetWei', 'absoluteCapWei', 'unitCapWei']);
  assert.deepEqual(Object.keys(orders.items[0]), ['orderId', 'pool', 'seller', 'pricePerUnitWei', 'remaining', 'listedBlock']);
  assert.equal(numbers.stats.topLevelProjectCount, '2');
  for (const parsed of [pools, portfolios, orders, numbers]) {
    assert.equal(parsed.source.stale, true);
    assert.equal(parsed.source.transactionReady, false);
    assert.equal(parsed.source.checkedAt, source.checkedAt);
    assert.equal(Object.hasOwn(parsed, 'account'), false);
  }
});

test('one missing section cannot invalidate another independently parsed section', () => {
  assert.throws(() => parsePublicDisplaySection({ ...reply('orders'), data: { items: null } }, manifest, 'orders', { now }));
  assert.throws(() => parsePublicDisplaySection({ ...reply('orders'),
    data: { items: [], nextCursor: null, ordersAvailable: false } }, manifest, 'orders', { now }));
  assert.equal(parsePublicDisplaySection(reply('stats'), manifest, 'stats', { now }).stats.registeredPoolCount, '1');
  assert.equal(parsePublicDisplaySection(reply('pools'), manifest, 'pools', { now }).items[0].address, addr('55'));
});

test('section parser fails closed on proof, count, block and row errors', () => {
  const changed = (section, mutate) => { const value = reply(section); mutate(value); return value; };
  for (const [section, value] of [
    ['pools', changed('pools', v => { v.source.checkedAt = new Date(now - 30 * 60_000 - 1).toISOString(); })],
    ['pools', changed('pools', v => { v.source.factory = addr('99'); })],
    ['portfolios', changed('portfolios', v => { v.source.portfolioMarket = addr('99'); })],
    ['pools', changed('pools', v => { v.block.hash = hash('cd'); })],
    ['pools', changed('pools', v => { v.source.transactionReady = true; })],
    ['pools', changed('pools', v => { v.source.poolsAvailable = false; })],
    ['orders', changed('orders', v => { v.data.items[0].executable = true; })],
    ['pools', changed('pools', v => { v.data.items.push({ ...v.data.items[0] }); v.source.standalonePoolCount = '2'; v.source.registeredPoolCount = '2'; })],
    ['orders', changed('orders', v => { v.data.items[0].orderId = (1n << 256n).toString(); })],
    ['portfolios', changed('portfolios', v => { v.data.items[0].createdBlock = 101; })],
    ['orders', changed('orders', v => { v.data.items[0].seller = 'bad'; })],
    ['stats', changed('stats', v => { v.data.topLevelProjectCount = '5'; })],
  ]) assert.throws(() => parsePublicDisplaySection(value, manifest, section, { now }));
});

test('deep-link search reads at most two verified pages and does not claim a missing address is unregistered', async () => {
  const calls = [];
  const rows = Array.from({ length: 120 }, (_, index) => ({ ...pool,
    address: addr((index + 1).toString(16).padStart(2, '0')), circuitId: String(index + 1) }));
  const fetcher = async url => {
    calls.push(url);
    if (new URL(url).pathname.includes('/v1/snapshot/pools/')) return new Response(JSON.stringify({ error: 'not deployed' }),
      { status: 404, headers: { 'Content-Type': 'application/json' } });
    const cursor = Number(new URL(url).searchParams.get('cursor') ?? 0);
    const value = reply('pools', { items: rows.slice(cursor, cursor + 50), nextCursor: cursor + 50 < rows.length ? cursor + 50 : null });
    value.source.standalonePoolCount = '120';
    value.source.registeredPoolCount = '120';
    return new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
  };
  const found = await readPublicDisplaySection({ origin: 'https://example.test', manifest,
    section: 'pools', address: rows[70].address, fetcher, now: () => now });
  assert.equal(found.items[20].address, rows[70].address);
  assert.equal(calls.length, 3);
  calls.length = 0;
  const later = await readPublicDisplaySection({ origin: 'https://example.test', manifest,
    section: 'pools', address: rows[110].address, fetcher, now: () => now });
  assert.equal(later.items.some(row => row.address === rows[110].address), false);
  assert.equal(calls.length, 3);
  const driftFetcher = async url => {
    if (new URL(url).pathname.includes('/v1/snapshot/pools/')) return new Response(JSON.stringify({ error: 'not deployed' }),
      { status: 404, headers: { 'Content-Type': 'application/json' } });
    const cursor = Number(new URL(url).searchParams.get('cursor') ?? 0);
    const value = reply('pools', { items: rows.slice(cursor, cursor + 50), nextCursor: cursor + 50 });
    value.source.standalonePoolCount = '120';
    value.source.registeredPoolCount = '120';
    if (cursor) { value.source.indexedTimestamp++; value.block.timestamp++; }
    return new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
  };
  await assert.rejects(readPublicDisplaySection({ origin: 'https://example.test', manifest,
    section: 'pools', address: rows[70].address, fetcher: driftFetcher, now: () => now }));
});

test('new pool deep links use one exact historical snapshot lookup beyond the first hundred', async () => {
  const target = addr('ee'), calls = [];
  const fetcher = async url => {
    calls.push(url);
    const value = reply('pools', { items: [{ ...pool, address: target, createdBlock: 99 }],
      nextCursor: null, lookupAddress: target });
    value.source.standalonePoolCount = '150';
    value.source.registeredPoolCount = '150';
    return new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
  };
  const result = await readPublicDisplaySection({ origin: 'https://example.test', manifest,
    section: 'pools', address: target, fetcher, now: () => now });
  assert.equal(result.items[0].address.toLowerCase(), target.toLowerCase());
  assert.deepEqual(calls.map(url => new URL(url).pathname),
    [`/bemine-v4/api/chain-index/v1/snapshot/pools/${target.toLowerCase()}`]);
  const mismatched = reply('pools', { items: [{ ...pool, address: addr('dd') }],
    nextCursor: null, lookupAddress: target });
  mismatched.source.standalonePoolCount = '150';
  mismatched.source.registeredPoolCount = '150';
  assert.throws(() => parsePublicDisplaySection(mismatched, manifest, 'pools',
    { now, lookupAddress: target }), { code: 'index_coverage' });
  const absent = reply('pools', { items: [], nextCursor: null, lookupAddress: target });
  absent.source.standalonePoolCount = '150';
  absent.source.registeredPoolCount = '150';
  assert.equal(parsePublicDisplaySection(absent, manifest, 'pools', { now, lookupAddress: target }).items.length, 0);
  const large = reply('pools', { items: [{ ...pool, address: target }], nextCursor: null, lookupAddress: target });
  large.source.standalonePoolCount = '501';
  large.source.registeredPoolCount = '501';
  large.source.poolsAvailable = false;
  assert.equal(parsePublicDisplaySection(large, manifest, 'pools', { now, lookupAddress: target }).items.length, 1,
    'a separately verified exact row can preview beyond the bounded full-directory snapshot');
});

test('snapshot display validity advances with its original proof clock', () => {
  assert.equal(publicPreviewFresh(source, now + 30 * 60_000 - 60_000), true);
  assert.equal(publicPreviewFresh(source, now + 30 * 60_000 - 60_000 + 1), false);
  assert.equal(publicPreviewFresh({ ...source, checkedAt: new Date(now + 30_001).toISOString() }, now), false);
});

test('same-origin response Date keeps a verified preview usable when the local clock is two minutes slow', async () => {
  const localNow = now - 120_000;
  const fresh = reply('pools');
  fresh.source.indexedTimestamp = Math.floor(now / 1000) - 20;
  fresh.block.timestamp = fresh.source.indexedTimestamp;
  const fetcher = async () => new Response(JSON.stringify(fresh), {
    headers: { 'Content-Type': 'application/json', Date: new Date(now).toUTCString() },
  });
  const preview = await readPublicDisplaySection({ origin: 'https://example.test', manifest,
    section: 'pools', fetcher, now: () => localNow });
  assert.equal(publicPreviewFresh(preview.source, localNow), true);
  assert.equal(publicPreviewRemaining(preview.source, localNow), 29 * 60_000);
  assert.equal(publicPreviewFresh(preview.source, localNow + 29 * 60_000 + 1), false);
  assert.equal(publicPreviewRemaining(preview.source, localNow + 29 * 60_000 + 1), 0);
});

test('server Date never licenses future, expired, or block-inconsistent preview proofs', async () => {
  const good = reply('pools');
  good.source.indexedTimestamp = Math.floor(now / 1000) - 20;
  good.block.timestamp = good.source.indexedTimestamp;
  const read = async value => readPublicDisplaySection({ origin: 'https://example.test', manifest,
    section: 'pools', now: () => now - 120_000,
    fetcher: async () => new Response(JSON.stringify(value), {
      headers: { 'Content-Type': 'application/json', Date: new Date(now).toUTCString() },
    }) });
  for (const checkedAt of [now + 30_001, now - 30 * 60_000 - 1]) {
    const bad = structuredClone(good);
    bad.source.checkedAt = new Date(checkedAt).toISOString();
    await assert.rejects(read(bad), { code: 'index_stale' });
  }
  const oldBlock = structuredClone(good);
  oldBlock.source.indexedTimestamp = Math.floor(now / 1000) - 60 * 60;
  oldBlock.block.timestamp = oldBlock.source.indexedTimestamp;
  await assert.rejects(read(oldBlock), { code: 'index_stale' });
});

test('preview retries stop per resolved section and resume if that section loses current data', () => {
  const routeKey = 'home::shares';
  const before = { key: routeKey, sections: { pools: false, stats: false } };
  const partial = { key: routeKey, sections: { pools: true, stats: false } };
  const current = { key: routeKey, sections: { pools: true, stats: true } };
  assert.equal(publicPreviewNeedsRefresh(before, routeKey, 'pools'), true);
  assert.equal(publicPreviewNeedsRefresh(partial, routeKey, 'pools'), false);
  assert.equal(publicPreviewNeedsRefresh(partial, routeKey, 'stats'), true);
  assert.equal(publicPreviewNeedsRefresh(current, routeKey, 'stats'), false);
  assert.equal(publicPreviewNeedsRefresh(before, routeKey, 'stats'), true);
  assert.equal(publicPreviewNeedsRefresh(current, 'detail:0x123:shares', 'pools'), true,
    'a previous route cannot suppress the new route preview');
});

test('route-aware reads use only the requested same-origin section without browser caching', async () => {
  const calls = [];
  const fetcher = async (url, options) => {
    calls.push({ url, options });
    const section = new URL(url).pathname.split('/').at(-1);
    return new Response(JSON.stringify(reply(section)), { headers: { 'Content-Type': 'application/json' } });
  };
  await Promise.all(['pools', 'stats', 'orders'].map(section => readPublicDisplaySection({
    origin: 'https://example.test', manifest, section, fetcher, now: () => now })));
  assert.deepEqual(calls.map(call => new URL(call.url).pathname), ['pools', 'stats', 'orders']
    .map(section => `/bemine-v4/api/chain-index/v1/snapshot/${section}`));
  assert.equal(new URL(calls[2].url).searchParams.get('active'), 'true');
  for (const call of calls) {
    assert.equal(call.options.cache, 'no-store');
    assert.equal(call.options.credentials, 'same-origin');
  }
});

test('a retired server snapshot reports 503 for the owning preview section', async () => {
  const unavailable = async () => new Response(JSON.stringify({ error: 'No recent canonical verified display snapshot.' }),
    { status: 503, headers: { 'Content-Type': 'application/json' } });
  await assert.rejects(readPublicDisplaySection({ origin: 'https://example.test', manifest,
    section: 'stats', fetcher: unavailable, now: () => now }),
  { code: 'http_unavailable', details: { status: 503 } });
});
