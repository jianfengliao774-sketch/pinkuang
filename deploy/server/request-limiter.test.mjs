import assert from 'node:assert/strict';
import test from 'node:test';
import { clientAddress, createRequestLimiter } from './request-limiter.mjs';

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
