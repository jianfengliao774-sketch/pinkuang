import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequestLimiter } from '../server/request-limiter.mjs';

test('legacy live API limits each nginx client and ignores remote IP spoofing', () => {
  let now = 1000;
  const accept = createRequestLimiter({ perClient: 1, windowMs: 1000, now: () => now });
  const req = (peer, claimed) => ({ socket: { remoteAddress: peer }, headers: { 'x-real-ip': claimed } });
  assert.equal(accept(req('127.0.0.1', '203.0.113.1')), true);
  assert.equal(accept(req('127.0.0.1', '203.0.113.2')), true);
  assert.equal(accept(req('127.0.0.1', '203.0.113.1')), false);
  assert.equal(accept(req('192.0.2.1', '203.0.113.3')), true);
  assert.equal(accept(req('192.0.2.1', '203.0.113.4')), false);
  now = 2000;
  assert.equal(accept(req('127.0.0.1', '203.0.113.1')), true);
});
