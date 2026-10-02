import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchSaleReferenceStatus } from '../lib/sale-reference-status.mjs';

const address = n => '0x' + n.toString(16).padStart(40, '0');
const config = { origin: 'https://example.test', indexBaseUrl: 'https://example.test/api/chain-index',
  factory: address(1), shareMarket: address(2) }, pool = address(3);
const snapshot = changes => ({ schemaVersion: 1, chainId: 56, factory: config.factory, market: config.shareMarket,
  updatedAt: null, enabled: false, stale: false, item: { pool, status: 'disabled', proposalId: null }, ...changes });
const response = body => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });

test('reference status uses a single bounded public GET and preserves stale confirmed values', async () => {
  let calls = 0;
  const body = snapshot({ enabled: true, stale: true,
    item: { pool, status: 'confirmed', proposalId: '1', priceWei: '123456789012345678901', hash: '0x' + 'ab'.repeat(32) } });
  const result = await fetchSaleReferenceStatus(config, pool, { fetcher: async (url, options) => {
    calls++; assert.equal(url, `${config.indexBaseUrl}/v1/display/sale-reference/${pool}`);
    assert.equal(options.method, 'GET'); assert.equal(options.body, undefined);
    assert.equal(options.redirect, 'error'); return response(body);
  } });
  assert.equal(calls, 1); assert.equal(result.stale, true); assert.equal(result.item.priceWei, body.item.priceWei);
  assert.equal(result.item.status, 'confirmed', 'transport does not turn an old receipt into a new confirmation');
});

test('reference status cannot read another deployment or an arbitrary target and remains read only', async () => {
  for (const body of [snapshot({ factory: address(9) }), snapshot({ market: address(9) }),
    snapshot({ item: { pool: address(9), status: 'confirmed' } }), snapshot({ item: { pool, status: 'sending-secret' } }),
    snapshot({ item: { pool, status: 'confirmed', priceWei: 1 } })])
    await assert.rejects(fetchSaleReferenceStatus(config, pool, { fetcher: async () => response(body) }));
  let calls = 0;
  await assert.rejects(fetchSaleReferenceStatus({ ...config, indexBaseUrl: 'https://other.test/api' }, pool,
    { fetcher: async () => { calls++; return response(snapshot()); } }));
  assert.equal(calls, 0);
});
