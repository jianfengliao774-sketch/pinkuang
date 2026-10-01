import test from 'node:test';
import assert from 'node:assert/strict';
import {serverConfiguration} from './index.mjs';
import {upstreamUrl, proxyFirsto, createQuoteRateLimiter, createQuoteCache, verifiedQuotePage} from './firsto-proxy.mjs';

test('quote proxy pins the origin, read-only paths and official collections', () => {
  assert.equal(upstreamUrl('/firsto-api/v1/circuits?page=1&pageSize=20').searchParams.get('category'),'official_mining');
  assert.equal(upstreamUrl('/firsto-api/v1/circuits?page=1&pageSize=20').searchParams.get('miningStatus'),'verified');
  assert.equal(upstreamUrl('/firsto-api/v1/circuit/0xb1024b89886b9a34aa4ff5f31c411d708b20a14c/16480').origin,'https://api-tapeout.firsto.ai');
  assert.equal(upstreamUrl('/firsto-api/v1/circuit/0xb1024b89886b9a34aa4ff5f31c411d708b20a14c/16480?display=1').search, '',
    'the display marker must not be forwarded to Firsto');
  for(const path of ['//evil.example/v1/circuits','/firsto-api/v1/order-request','/firsto-api/v1/circuits?account=0x123','/firsto-api/v1/circuits?category=other','/firsto-api/v1/circuits?pageSize=999999','/firsto-api/v1/circuit/0x0000000000000000000000000000000000000001/1','/firsto-api/v1/circuit/0xb1024b89886b9a34aa4ff5f31c411d708b20a14c/'+(2n**256n).toString()]) assert.throws(()=>upstreamUrl(path));
});

test('miner verification is applied before source pagination and cannot be bypassed by query duplicates', () => {
  const url = upstreamUrl('/firsto-api/v1/circuits?sort=daily_capacity_price_low&page=3&miningStatus=verified&viewId=frozen-1');
  assert.equal(url.searchParams.get('sort'), 'daily_capacity_price_low');
  assert.equal(url.searchParams.get('page'), '3');
  assert.equal(url.searchParams.get('viewId'), 'frozen-1');
  assert.deepEqual(url.searchParams.getAll('miningStatus'), ['verified']);
  for (const query of ['miningStatus=unverified', 'miningStatus=optimal', 'miningStatus=',
    'miningStatus=verified&miningStatus=unverified', 'miningStatus=verified&miningStatus=verified',
    'sort=price_low&sort=daily_capacity_price_low', 'sort=arbitrary', 'page=1&page=2']) {
    assert.throws(() => upstreamUrl(`/firsto-api/v1/circuits?${query}`));
  }
  assert.equal(upstreamUrl('/firsto-api/v1/circuit-holders?page=1').searchParams.has('miningStatus'), false,
    'market reference statistics are a separate upstream endpoint');
});

function verifiedRow(tokenId = '1') {
  return { collection: '0xb1024b89886b9a34aa4ff5f31c411d708b20a14c', category: 'official_mining',
    classification: 'official_mining', tokenId,
    mining: { status: 'verified', verifiedWeight: '1204', unverifiedWeight: '0',
      estimated24hAtomic: '562896000', tokenSymbol: 'BEM', tokenDecimals: 8 },
    bestAsk: { priceWei: '40000000000000000000', buyerCostWei: '40400000000000000000',
      status: 'open', execution: { kind: 'signed_ask', signature: 'public-order-signature' } },
    listingReference: { priceWei: '46044892800000000000', dailyCapacityPriceWei: '8180000000000000000' } };
}

test('quote pages exclude unverified, mixed, optimal and malformed miners rather than interpreting order status as verification', () => {
  const good = verifiedRow(), changed = change => ({ ...good, mining: { ...good.mining, ...change } });
  const rows = [good, { ...good, collection: '0x1f5cb4aeae1807bf60c3b9c0d8adbcc14e91f12c', tokenId: '2' },
    changed({ status: 'unverified' }), changed({ status: 'optimal' }), changed({ status: 'not_started' }),
    changed({ verifiedWeight: '0' }), changed({ unverifiedWeight: '1' }), changed({ verifiedWeight: 1204 }),
    changed({ verifiedWeight: '-1' }), changed({ verifiedWeight: (2n ** 128n).toString() }),
    changed({ optimal: true }), changed({ tokenDecimals: 18 }), changed({ tokenSymbol: 'OTHER' }),
    { ...good, mining: null }, { ...good, collection: '0x0000000000000000000000000000000000000001' },
    { ...good, classification: 'other' }, { ...good, mining: { ...good.mining, status: 'unverified' }, bestAsk: { status: 'verified' } }];
  const raw = { rows, page: 3, pageSize: 50, totalPages: 355, total: 17720,
    viewId: 'frozen-1', sourceBlock: '124456466', sourceFreshness: { mining: '2026-09-28T03:00:00.000Z' } };
  const filtered = verifiedQuotePage(raw);
  assert.deepEqual(filtered.rows, rows.slice(0, 2));
  assert.equal(filtered.quoteFilter.excludedOnPage, rows.length - 2);
  for (const key of ['page', 'pageSize', 'totalPages', 'total', 'viewId', 'sourceBlock', 'sourceFreshness'])
    assert.deepEqual(filtered[key], raw[key]);
  assert.equal(raw.rows.length, rows.length, 'upstream input is not mutated');
  assert.deepEqual(verifiedQuotePage({ ...raw, rows: [] }).rows, []);
  for (const bad of [null, [], {}, { rows: null }, { rows: Array(51).fill(good) }]) assert.throws(() => verifiedQuotePage(bad));
});

test('quote filtering preserves exact sell price, daily units, reference price, order payload and source order', async () => {
  const first = verifiedRow('2465'), second = verifiedRow('2562');
  second.bestAsk = { ...second.bestAsk, priceWei: '13343616000000000000', buyerCostWei: '13477052160000000000' };
  second.mining = { ...second.mining, verifiedWeight: '366', estimated24hAtomic: '171072000' };
  const raw = { rows: [first, { ...first, mining: { ...first.mining, status: 'unverified' } }, second],
    page: 1, totalPages: 355, total: 17720, viewId: 'frozen-view', sourceBlock: '124456466' };
  const res = { headers: {}, setHeader(key, value) { this.headers[key.toLowerCase()] = value; }, end(value) { this.body = value; } };
  await proxyFirsto({ method: 'GET', url: '/firsto-api/v1/circuits?sort=daily_capacity_price_low&page=1',
    socket: { remoteAddress: '192.0.2.12' } }, res, { limiter: createQuoteRateLimiter(), fetcher: async url => {
    assert.equal(url.searchParams.get('miningStatus'), 'verified');
    assert.equal(url.searchParams.get('sort'), 'daily_capacity_price_low');
    return Response.json(raw, { headers: { 'x-tapeout-source-block': raw.sourceBlock } });
  } });
  assert.equal(res.statusCode, 200);
  const result = JSON.parse(res.body.toString());
  assert.deepEqual(result.rows, [first, second]);
  assert.equal(result.quoteFilter.excludedOnPage, 1);
  assert.equal(res.headers['x-tapeout-source-block'], raw.sourceBlock);
  // Compare the displayed seller-price / daily-BEM ratio using integers. The
  // unrelated per-model listing reference and Firsto buyer fee cannot replace it.
  assert(BigInt(first.bestAsk.priceWei) * BigInt(second.mining.estimated24hAtomic)
    < BigInt(second.bestAsk.priceWei) * BigInt(first.mining.estimated24hAtomic));
});

test('new official verified miner with pending enrichment retains its ask; unknown mining and foreign NFTs do not', () => {
  const fresh = { ...verifiedRow('16736'), classification: 'unknown' };
  const raw = { rows: [fresh,
    { ...fresh, mining: { ...fresh.mining, status: 'unknown' } },
    { ...fresh, collection: '0x0000000000000000000000000000000000000001' },
    { ...fresh, category: 'other' }], page: 1, total: 4, totalPages: 1 };
  const result = verifiedQuotePage(raw);
  assert.deepEqual(result.rows, [fresh]);
  assert.equal(result.quoteFilter.excludedOnPage, 3);
});
test('quote proxy rejects POST before any network call', async()=>{
  const response={statusCode:0,setHeader(){},end(body){this.body=body;}};
  await proxyFirsto({url:'/firsto-api/v1/circuits',method:'POST'},response);
  assert.equal(response.statusCode,405);
  assert.match(response.body,/只读/);
});

test('snapshot identity is a single bounded token supported only on the circuit list', () => {
  const viewId = `v91508-p163561:${'a'.repeat(64)}`;
  const valid = upstreamUrl(`/firsto-api/v1/circuits?page=2&viewId=${encodeURIComponent(viewId)}`);
  assert.equal(valid.searchParams.get('viewId'), viewId);
  assert.equal(valid.origin, 'https://api-tapeout.firsto.ai');
  assert.equal(valid.pathname, '/v1/circuits');
  assert.equal(upstreamUrl(`/firsto-api/v1/circuits?viewId=${'a'.repeat(120)}`).searchParams.get('viewId').length, 120);
  for (const value of ['', 'a'.repeat(121), 'two tokens', 'line\nbreak', '../other', 'https://evil.example', 'a&category=other', '%2fother']) {
    assert.throws(() => upstreamUrl(`/firsto-api/v1/circuits?viewId=${encodeURIComponent(value)}`));
  }
  assert.throws(() => upstreamUrl('/firsto-api/v1/circuits?viewId=first&viewId=second'));
  assert.throws(() => upstreamUrl('/firsto-api/v1/circuit-holders?page=1&viewId=first'));
  assert.throws(() => upstreamUrl('/firsto-api/v1/circuit/0xb1024b89886b9a34aa4ff5f31c411d708b20a14c/1?viewId=first'));
});


test('production server defaults to loopback and requires an explicit host to expose its listener', () => {
  assert.deepEqual(serverConfiguration({}), { host: '127.0.0.1', port: 4173 });
  assert.deepEqual(serverConfiguration({ HOST: '0.0.0.0', PORT: '8080' }), { host: '0.0.0.0', port: 8080 });
  assert.throws(() => serverConfiguration({ PORT: 'invalid' }), /PORT/);
});

test('per-peer quote limit ignores spoofed forwarding headers and expires without an unbounded client map', () => {
  let now = 1000;
  const limiter = createQuoteRateLimiter({ limit: 2, windowMs: 1000, maxClients: 2, now: () => now });
  const request = (remoteAddress, forwarded) => ({ socket: { remoteAddress }, headers: { 'x-forwarded-for': forwarded } });
  assert.equal(limiter.consume(request('::ffff:127.0.0.1', '1.1.1.1')).allowed, true);
  assert.equal(limiter.consume(request('127.0.0.1', '2.2.2.2')).allowed, true);
  assert.equal(limiter.consume(request('127.0.0.1', '3.3.3.3')).allowed, false);
  assert.equal(limiter.consume(request('192.0.2.1')).allowed, true);
  for (let i = 0; i < 100; i++) assert.equal(limiter.consume(request(`198.51.100.${i}`)).allowed, false);
  assert.equal(limiter.size, 2);
  now = 2001;
  assert.equal(limiter.consume(request('203.0.113.1')).allowed, true);
  assert.equal(limiter.size, 1);
});

test('nginx loopback peer may use its overwritten X-Real-IP without trusting a public peer or forwarded chain', () => {
  const limiter = createQuoteRateLimiter({ limit: 1 });
  const request = (peer, realIp, forwarded) => ({ socket: { remoteAddress: peer },
    headers: { 'x-real-ip': realIp, 'x-forwarded-for': forwarded } });
  assert.equal(limiter.consume(request('127.0.0.1', '192.0.2.1', '198.51.100.7')).allowed, true);
  assert.equal(limiter.consume(request('127.0.0.1', '192.0.2.2', '198.51.100.7')).allowed, true);
  assert.equal(limiter.consume(request('127.0.0.1', '192.0.2.1', '198.51.100.8')).allowed, false);
  assert.equal(limiter.consume(request('203.0.113.1', '192.0.2.3', '198.51.100.8')).allowed, true);
  assert.equal(limiter.consume(request('203.0.113.1', '192.0.2.4', '198.51.100.9')).allowed, false);
  assert.equal(limiter.consume(request('::1', '192.0.2.3, 192.0.2.4', '')).allowed, true,
    'a forged chain must fall back to the TCP peer');
});

test('loopback nginx clients have separate Firsto quotas but remote peers cannot spoof them', () => {
  const limiter = createQuoteRateLimiter({ limit: 1, maxClients: 3 });
  const request = (peer, realIp) => ({ socket: { remoteAddress: peer }, headers: { 'x-real-ip': realIp } });
  assert.equal(limiter.consume(request('127.0.0.1', '203.0.113.7')).allowed, true);
  assert.equal(limiter.consume(request('127.0.0.1', '203.0.113.8')).allowed, true);
  assert.equal(limiter.consume(request('127.0.0.1', '203.0.113.7')).allowed, false);
  assert.equal(limiter.consume(request('192.0.2.7', '203.0.113.9')).allowed, true);
  assert.equal(limiter.consume(request('192.0.2.7', '203.0.113.10')).allowed, false);
});

test('rate-limited requests return 429 before upstream IO; successful responses keep same-origin no-store policy', async () => {
  const limiter = createQuoteRateLimiter({ limit: 1 }); let upstreamCalls = 0;
  const options = { limiter, fetcher: async (_url, init) => {
    upstreamCalls += 1; assert.equal(init.redirect, 'error'); assert.deepEqual(Object.keys(init.headers), ['Accept']);
    return Response.json({ rows: [] });
  } };
  const req = { method: 'GET', url: '/firsto-api/v1/circuits', socket: { remoteAddress: '127.0.0.1' }, headers: { cookie: 'must-not-forward', authorization: 'must-not-forward' } };
  const response = () => ({ statusCode: 0, headers: {}, setHeader(key, value) { this.headers[key.toLowerCase()] = value; }, end(body) { this.body = body; } });
  const first = response(); await proxyFirsto(req, first, options);
  assert.equal(first.statusCode, 200); assert.equal(first.headers['cache-control'], 'no-store'); assert.equal(first.headers['access-control-allow-origin'], undefined);
  const blocked = response(); await proxyFirsto(req, blocked, options);
  assert.equal(blocked.statusCode, 429); assert.equal(blocked.headers['retry-after'], '60'); assert.equal(upstreamCalls, 1);
});

test('recent public list quote is returned from a bounded cache before spending another upstream quota', async () => {
  let now = 1000, calls = 0;
  const cache = createQuoteCache({ ttlMs: 3000, now: () => now });
  const limiter = createQuoteRateLimiter({ limit: 1, now: () => now });
  const fetcher = async () => { calls++; return Response.json({ rows: [] }, { headers: { 'x-tapeout-source-block': '123' } }); };
  const req = { method: 'GET', url: '/firsto-api/v1/circuits?page=1', socket: { remoteAddress: '127.0.0.1' } };
  const make = () => ({ headers: {}, setHeader(key, value) { this.headers[key.toLowerCase()] = value; }, end(value) { this.body = value; } });
  const first = make(); await proxyFirsto(req, first, { limiter, cache, fetcher });
  const second = make(); await proxyFirsto(req, second, { limiter, cache, fetcher });
  assert.equal(calls, 1);
  assert.equal(second.statusCode, 200);
  assert.equal(second.headers['x-firsto-cache'], 'HIT');
  assert.equal(second.headers['x-tapeout-source-block'], '123');
  assert.deepEqual(JSON.parse(second.body), JSON.parse(first.body));
  now += 3001;
  const expired = make(); await proxyFirsto(req, expired, { limiter, cache, fetcher });
  assert.equal(expired.statusCode, 429, 'expired quote cannot bypass the normal quota');
});

test('display detail is cached and coalesced, while an unmarked transaction detail remains fresh', async () => {
  const cache = createQuoteCache({ ttlMs: 30_000 });
  const limiter = createQuoteRateLimiter({ limit: 2 });
  const url = '/firsto-api/v1/circuit/0xb1024b89886b9a34aa4ff5f31c411d708b20a14c/16480';
  const make = () => ({ headers: {}, setHeader(key, value) { this.headers[key.toLowerCase()] = value; }, end(value) { this.body = value; } });
  let release, calls = 0;
  const fetcher = async upstream => {
    calls++;
    assert.equal(upstream.search, '');
    if (calls === 1) await new Promise(resolve => { release = resolve; });
    return Response.json({ asset: { tokenId: '16480', sequence: calls } });
  };
  const request = marked => ({ method: 'GET', url: url + (marked ? '?display=1' : ''), socket: { remoteAddress: '127.0.0.3' } });
  const first = make(), shared = make();
  const inFlight = proxyFirsto(request(true), first, { limiter, cache, fetcher });
  const duplicate = proxyFirsto(request(true), shared, { limiter, cache, fetcher });
  assert.equal(calls, 1);
  release();
  await Promise.all([inFlight, duplicate]);
  assert.equal(first.statusCode, 200);
  assert.equal(shared.statusCode, 200);
  assert.equal(shared.headers['x-firsto-cache'], 'HIT');
  assert.deepEqual(JSON.parse(shared.body), JSON.parse(first.body));
  const transaction = make();
  await proxyFirsto(request(false), transaction, { limiter, cache, fetcher });
  assert.equal(transaction.statusCode, 200);
  assert.equal(calls, 2, 'transaction checks must bypass the display cache');
  const cached = make();
  await proxyFirsto(request(true), cached, { limiter, cache, fetcher });
  assert.equal(cached.statusCode, 200);
  assert.equal(cached.headers['x-firsto-cache'], 'HIT');
  assert.equal(calls, 2);
});

test('proxy bounds simultaneous upstream work and releases slots after completion', async () => {
  const limiter = createQuoteRateLimiter({ limit: 100 });
  const replies = [], responses = [];
  const response = () => ({ statusCode: 0, setHeader() {}, end() {} });
  const req = { method: 'GET', url: '/firsto-api/v1/circuits', socket: { remoteAddress: '127.0.0.2' } };
  const options = { limiter, fetcher: () => new Promise(resolve => replies.push(resolve)) };
  const running = Array.from({ length: 8 }, () => { const res = response(); responses.push(res); return proxyFirsto(req, res, options); });
  assert.equal(replies.length, 8);
  const blocked = response(); await proxyFirsto(req, blocked, options);
  assert.equal(blocked.statusCode, 429); assert.equal(replies.length, 8);
  for (const reply of replies) reply(Response.json({ rows: [] }));
  await Promise.all(running);
  assert(responses.every(res => res.statusCode === 200));
  const later = response();
  await proxyFirsto(req, later, { limiter, fetcher: async () => Response.json({ rows: [] }) });
  assert.equal(later.statusCode, 200);
});
