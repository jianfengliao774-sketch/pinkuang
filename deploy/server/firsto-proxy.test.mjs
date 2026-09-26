import test from 'node:test';
import assert from 'node:assert/strict';
import {serverConfiguration} from './index.mjs';
import {upstreamUrl, proxyFirsto, createQuoteRateLimiter} from './firsto-proxy.mjs';

test('quote proxy pins the origin, read-only paths and official collections', () => {
  assert.equal(upstreamUrl('/firsto-api/v1/circuits?page=1&pageSize=20').searchParams.get('category'),'official_mining');
  assert.equal(upstreamUrl('/firsto-api/v1/circuit/0xb1024b89886b9a34aa4ff5f31c411d708b20a14c/16480').origin,'https://api-tapeout.firsto.ai');
  for(const path of ['//evil.example/v1/circuits','/firsto-api/v1/order-request','/firsto-api/v1/circuits?account=0x123','/firsto-api/v1/circuits?category=other','/firsto-api/v1/circuits?pageSize=999999','/firsto-api/v1/circuit/0x0000000000000000000000000000000000000001/1','/firsto-api/v1/circuit/0xb1024b89886b9a34aa4ff5f31c411d708b20a14c/'+(2n**256n).toString()]) assert.throws(()=>upstreamUrl(path));
});
test('quote proxy rejects POST before any network call', async()=>{
  const response={statusCode:0,setHeader(){},end(body){this.body=body;}};
  await proxyFirsto({url:'/firsto-api/v1/circuits',method:'POST'},response);
  assert.equal(response.statusCode,405);
  assert.match(response.body,/只读/);
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
