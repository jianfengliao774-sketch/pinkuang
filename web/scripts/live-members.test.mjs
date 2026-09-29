import assert from 'node:assert/strict';
import { test } from 'node:test';
import { abi } from '../lib/chain-client.mjs';
import { readCurrentPoolMembers } from '../lib/live-members.mjs';

const factory = '0x1111111111111111111111111111111111111111';
const pool = '0x2222222222222222222222222222222222222222';
const holders = ['0x3333333333333333333333333333333333333333', '0x4444444444444444444444444444444444444444'];
const hash = `0x${'ab'.repeat(32)}`;

function provider({ registered = true, count = 2n, changed = false } = {}) {
  let headers = 0;
  return { request: async ({ method, params }) => {
    if (method === 'eth_chainId') return '0x38';
    if (method === 'eth_getBlockByNumber') {
      assert.equal(params[1], false);
      assert.ok(params[0] === 'latest' || params[0] === '0x64');
      headers++;
      return { number: '0x64', hash: changed && headers === 2 ? `0x${'cd'.repeat(32)}` : hash };
    }
    assert.equal(method, 'eth_call');
    assert.equal(params[1], '0x64');
    const { to, data } = params[0];
    if (to.toLowerCase() === factory.toLowerCase()) {
      assert.equal(abi.PoolFactory.parseTransaction({ data }).name, 'isPool');
      return abi.PoolFactory.encodeFunctionResult('isPool', [registered]);
    }
    assert.equal(to.toLowerCase(), pool.toLowerCase());
    const { name } = abi.PoolVault.parseTransaction({ data });
    return abi.PoolVault.encodeFunctionResult(name, {
      factory: [factory], activeMembers: [holders], memberCount: [count],
    }[name]);
  } };
}

test('holder list uses one current pinned block and verifies pool identity and count', async () => {
  const result = await readCurrentPoolMembers(provider(), { factory, pool });
  assert.deepEqual(result.members, holders);
  assert.equal(result.blockNumber, 100n);
});

test('holder list rejects an unregistered pool, count mismatch and reorg', async () => {
  await assert.rejects(readCurrentPoolMembers(provider({ registered: false }), { factory, pool }), /核对/);
  await assert.rejects(readCurrentPoolMembers(provider({ count: 1n }), { factory, pool }), /核对/);
  await assert.rejects(readCurrentPoolMembers(provider({ changed: true }), { factory, pool }), /变化/);
});
