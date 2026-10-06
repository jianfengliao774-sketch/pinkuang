import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pacePortfolioDustRpc } from './portfolio-dust-rpc.mjs';

test('concurrent proof reads serialize with a minimum start interval', async () => {
  let time = 0, active = 0, maxActive = 0;
  const calls = [];
  const send = pacePortfolioDustRpc(async (method, params) => {
    active++; maxActive = Math.max(maxActive, active); calls.push({ method, params, time });
    await Promise.resolve(); active--; return method;
  }, { now: () => time, wait: async ms => { time += ms; } });
  assert.deepEqual(await Promise.all([send('eth_call', [1]), send('eth_call', [2]), send('eth_getCode', [3])]),
    ['eth_call', 'eth_call', 'eth_getCode']);
  assert.deepEqual(calls.map(call => call.time), [0, 1100, 2200]);
  assert.deepEqual(calls.map(call => call.params), [[1], [2], [3]]);
  assert.equal(maxActive, 1);
});

test('a failure is propagated once and does not deadlock subsequent reads', async () => {
  let time = 0;
  const failure = new Error('archive unavailable'), methods = [];
  const send = pacePortfolioDustRpc(async method => {
    methods.push(method); if (method === 'failed') throw failure; return 'unchanged';
  }, { now: () => time, wait: async ms => { time += ms; } });
  const results = await Promise.allSettled([send('failed', []), send('next', [])]);
  assert.equal(results[0].reason, failure);
  assert.equal(results[1].value, 'unchanged');
  assert.deepEqual(methods, ['failed', 'next']);
  assert.equal(time, 1100);
});

test('slow reads consume the gap and are not delayed a second time', async () => {
  let time = 0, waits = 0;
  const send = pacePortfolioDustRpc(async () => { time += 1500; return null; },
    { now: () => time, wait: async ms => { waits++; time += ms; } });
  await Promise.all([send('one', []), send('two', [])]);
  assert.equal(waits, 0);
  assert.equal(time, 3000);
});
