import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePublicDisplaySection, publicPreviewFresh, readPublicDisplaySection } from '../lib/public-display-preview.mjs';

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
    const cursor = Number(new URL(url).searchParams.get('cursor') ?? 0);
    const value = reply('pools', { items: rows.slice(cursor, cursor + 50), nextCursor: cursor + 50 < rows.length ? cursor + 50 : null });
    value.source.standalonePoolCount = '120';
    value.source.registeredPoolCount = '120';
    return new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
  };
  const found = await readPublicDisplaySection({ origin: 'https://example.test', manifest,
    section: 'pools', address: rows[70].address, fetcher, now: () => now });
  assert.equal(found.items[20].address, rows[70].address);
  assert.equal(calls.length, 2);
  calls.length = 0;
  const later = await readPublicDisplaySection({ origin: 'https://example.test', manifest,
    section: 'pools', address: rows[110].address, fetcher, now: () => now });
  assert.equal(later.items.some(row => row.address === rows[110].address), false);
  assert.equal(calls.length, 2);
  const driftFetcher = async url => {
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

test('snapshot display validity advances with its original proof clock', () => {
  assert.equal(publicPreviewFresh(source, now + 30 * 60_000 - 60_000), true);
  assert.equal(publicPreviewFresh(source, now + 30 * 60_000 - 60_000 + 1), false);
  assert.equal(publicPreviewFresh({ ...source, checkedAt: new Date(now + 30_001).toISOString() }, now), false);
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
