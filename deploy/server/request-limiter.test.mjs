import assert from 'node:assert/strict';
import test from 'node:test';
import { clientAddress, createKeyedLimiter, createRequestLimiter } from './request-limiter.mjs';

test('only loopback proxy identity can supply a client IP', () => {
  assert.equal(clientAddress({ socket: { remoteAddress: '127.0.0.1' }, headers: { 'x-real-ip': '203.0.113.10' } }), '203.0.113.10');
  assert.equal(clientAddress({ socket: { remoteAddress: '198.51.100.1' }, headers: { 'x-real-ip': '203.0.113.10' } }), '198.51.100.1');
  assert.equal(clientAddress({ socket: { remoteAddress: '127.0.0.1' }, headers: { 'x-real-ip': 'bad,ip' } }), '127.0.0.1');
});

test('public request limits are per client and reset after the bounded window', () => {
  let time = 0;
  const allowed = createRequestLimiter({ perClient: 2, windowMs: 1000, now: () => time });
  const client = address => ({ socket: { remoteAddress: address }, headers: {} });
  assert.equal(allowed(client('203.0.113.10')), true);
  assert.equal(allowed(client('203.0.113.10')), true);
  assert.equal(allowed(client('203.0.113.10')), false);
  assert.equal(allowed(client('203.0.113.11')), true);
  time = 1000;
  assert.equal(allowed(client('203.0.113.10')), true);
});

test('client table saturation does not lock out a new visitor', () => {
  const allowed = createRequestLimiter({ perClient: 2, maxClients: 2 });
  const client = address => ({ socket: { remoteAddress: address }, headers: {} });
  assert.equal(allowed(client('203.0.113.10')), true);
  assert.equal(allowed(client('203.0.113.11')), true);
  assert.equal(allowed(client('203.0.113.10')), true);
  assert.equal(allowed(client('203.0.113.12')), true);
  assert.equal(allowed(client('203.0.113.10')), false);
});

test('IPv6 interface addresses share a /64 quota and cannot fill the client table', () => {
  const allowed = createRequestLimiter({ perClient: 2, maxClients: 2 });
  const client = address => ({ socket: { remoteAddress: '127.0.0.1' }, headers: { 'x-real-ip': address } });
  assert.equal(clientAddress(client('2001:db8:0:1::a')), '2001:0db8:0000:0001::/64');
  assert.equal(clientAddress(client('2001:0db8:0000:0001:ffff::b')), '2001:0db8:0000:0001::/64');
  assert.equal(allowed(client('2001:db8:0:1::a')), true);
  assert.equal(allowed(client('2001:db8:0:1::b')), true);
  assert.equal(allowed(client('2001:db8:0:1::c')), false);
  assert.equal(allowed(client('2001:db8:0:2::a')), true);
  assert.equal(allowed(client('2001:db8:0:3::a')), true, 'a new prefix evicts rather than globally locking out visitors');
});

test('IPv4-mapped IPv6 addresses retain the IPv4 client quota', () => {
  const allowed = createRequestLimiter({ perClient: 1, maxClients: 2 });
  const client = address => ({ socket: { remoteAddress: address }, headers: {} });
  assert.equal(clientAddress(client('::ffff:192.0.2.3')), '192.0.2.3');
  assert.equal(clientAddress(client('::ffff:c000:204')), '192.0.2.4');
  assert.equal(allowed(client('::ffff:192.0.2.3')), true);
  assert.equal(allowed(client('192.0.2.3')), false);
  assert.equal(allowed(client('::ffff:192.0.2.4')), true);
});

test('authenticated identity quotas are independent of IP and of other identities', () => {
  let time=0;
  const allow=createKeyedLimiter({perKey:2,maxKeys:2,windowMs:1_000,now:()=>time});
  assert.equal(allow('admin-one'),true);
  assert.equal(allow('admin-one'),true);
  assert.equal(allow('admin-one'),false);
  assert.equal(allow('admin-two'),true);
  assert.equal(allow(''),false);
  time=1_000;
  assert.equal(allow('admin-one'),true);
});

test('keyed quota exhaustion never resets an existing identity', () => {
  let time=0;
  const allow=createKeyedLimiter({perKey:2,maxKeys:2,windowMs:1_000,now:()=>time});
  assert.equal(allow('admin-one'),true);
  assert.equal(allow('admin-two'),true);
  assert.equal(allow('admin-three'),false,'new keys are rejected when the bounded table is full');
  assert.equal(allow('admin-one'),true,'an existing key keeps its remaining quota');
  assert.equal(allow('admin-one'),false);
  assert.equal(allow('admin-three'),false,'rotating keys cannot evict and reset the first key');
  time=1_000;
  assert.equal(allow('admin-three'),true,'a new window admits new keys');
});
