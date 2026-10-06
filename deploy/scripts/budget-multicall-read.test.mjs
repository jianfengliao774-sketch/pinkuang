import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Interface, getAddress, keccak256 } from 'ethers';
import {
  createBudgetMulticallReader, MULTICALL_ADDRESS, MULTICALL_RUNTIME_HASH,
  MAX_READ_BATCH, MAX_READ_CONCURRENCY, MAX_AGGREGATE_RETURN_BYTES,
} from './budget-multicall-read.mjs';

// The exact runtime was read from two independent BSC RPCs at the same block
// and matched to the official repository's pre-signed deployment transaction.
const runtime = JSON.parse(readFileSync(new URL('./fixtures/multicall3-bsc-runtime.json', import.meta.url), 'utf8'));
const aggregate = new Interface([
  'function aggregate3(tuple(address target,bool allowFailure,bytes callData)[] calls) payable returns(tuple(bool success,bytes returnData)[])',
  'function getBlockNumber() view returns(uint256)',
]);
const views = new Interface(['function value(uint256 id) view returns(uint256)']);
const address = value => getAddress(`0x${value.toString(16).padStart(40, '0')}`);
const tag = '0x7b';
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => {
  let resolve;
  const promise = new Promise(yes => { resolve = yes; });
  return { promise, resolve };
};

function fixture(changes = {}) {
  const seen = [], state = { active: 0, peak: 0, ...changes };
  const provider = { async send(method, params) {
    seen.push({ method, params });
    if (method === 'eth_chainId') return state.chain ?? '0x38';
    if (method === 'eth_getCode') {
      assert.equal(getAddress(params[0]), getAddress(MULTICALL_ADDRESS));
      assert.equal(params[1], tag);
      return state.code ?? runtime.runtime;
    }
    assert.equal(method, 'eth_call', 'The reader must never invoke a signing or broadcast RPC');
    assert.equal(params[1], tag, 'Every batch is bound to the requested block');
    assert.equal(getAddress(params[0].to), getAddress(MULTICALL_ADDRESS));
    assert(!params[0].value || BigInt(params[0].value) === 0n);
    const calls = aggregate.decodeFunctionData('aggregate3', params[0].data)[0];
    assert(calls.length >= 2 && calls.length <= MAX_READ_BATCH + 1);
    const marker = calls.at(-1);
    assert.equal(getAddress(marker.target), getAddress(MULTICALL_ADDRESS));
    assert.equal(marker.callData, aggregate.encodeFunctionData('getBlockNumber'));
    assert(calls.every(call => call.allowFailure === false));
    state.active++; state.peak = Math.max(state.peak, state.active);
    try {
      if (state.wait) await state.wait.promise;
      if (state.rpcFailure) throw new Error('Aggregate RPC unavailable');
      if (state.raw !== undefined) return state.raw;
      const result = calls.map((call, index) => {
        if (index === calls.length - 1) return [!state.markerFailure,
          aggregate.encodeFunctionResult('getBlockNumber', [state.wrongBlock ? 124n : 123n])];
        const id = views.decodeFunctionData('value', call.callData)[0];
        return [!(state.subcallFailure && index === 0),
          state.invalidValue ? '0x' : views.encodeFunctionResult('value', [id * 2n])];
      });
      if (state.dropResult) result.pop();
      if (state.extraResult) result.push([true, '0x']);
      return aggregate.encodeFunctionResult('aggregate3', [result]);
    } finally { state.active--; }
  } };
  return { provider, seen, state };
}

test('Multicall address and runtime hash are pinned to independent chain/source evidence', () => {
  assert.equal(getAddress(MULTICALL_ADDRESS), getAddress(runtime.address));
  assert.equal(keccak256(runtime.runtime), MULTICALL_RUNTIME_HASH);
  assert.equal(runtime.runtimeHash, MULTICALL_RUNTIME_HASH);
  assert.equal(runtime.runtimeBytes, 3808);
  assert.equal(runtime.rpc.length, 2);
  assert(runtime.rpc.every(item => item.runtimeHash === MULTICALL_RUNTIME_HASH));
  assert.deepEqual(runtime.deploymentTransaction.matchingRuntimeProviders, [0, 1]);
});

test('same-block aggregation preserves exact request/result order across chunk boundaries', async () => {
  const f = fixture(), reader = await createBudgetMulticallReader({ provider: f.provider, blockNumber: 123 });
  const count = MAX_READ_BATCH * 2 + 7;
  const result = await Promise.all(Array.from({ length: count }, (_, index) => reader.call(address(1), views, 'value', [BigInt(index)])));
  assert.deepEqual(result.map(value => value[0]), Array.from({ length: count }, (_, index) => BigInt(index) * 2n));
  assert.equal(f.seen.filter(call => call.method === 'eth_call').length, 3);
});

test('bulk requests never exceed the fixed aggregate concurrency bound', async () => {
  const wait = deferred(), f = fixture({ wait });
  const reader = await createBudgetMulticallReader({ provider: f.provider, blockNumber: 123 });
  const calls = Array.from({ length: MAX_READ_BATCH * (MAX_READ_CONCURRENCY + 2) }, (_, index) => reader.call(address(1), views, 'value', [index]));
  const result = Promise.all(calls);
  await tick(); await tick();
  assert.equal(f.state.peak, MAX_READ_CONCURRENCY);
  assert.equal(f.seen.filter(call => call.method === 'eth_call').length, MAX_READ_CONCURRENCY);
  wait.resolve(); await result;
  assert(f.state.peak <= MAX_READ_CONCURRENCY);
});

test('wrong chain, absent bytecode and altered runtime reject before market reads', async () => {
  for (const change of [{ chain: '0x1' }, { code: '0x' }, { code: `${runtime.runtime.slice(0, -2)}00` }]) {
    const f = fixture(change);
    await assert.rejects(createBudgetMulticallReader({ provider: f.provider, blockNumber: 123 }));
    assert(!f.seen.some(call => call.method === 'eth_call'));
  }
});

test('a single failed aggregate item or malformed result rejects the complete submitted batch', async () => {
  for (const change of [{ rpcFailure: true }, { subcallFailure: true }, { markerFailure: true },
    { wrongBlock: true }, { dropResult: true }, { extraResult: true }, { raw: '0x' }, { invalidValue: true }]) {
    const f = fixture(change), reader = await createBudgetMulticallReader({ provider: f.provider, blockNumber: 123 });
    const result = await Promise.allSettled([reader.call(address(1), views, 'value', [1]), reader.call(address(1), views, 'value', [2])]);
    assert(result.every(item => item.status === 'rejected'), JSON.stringify(change));
    assert.equal(f.seen.filter(call => call.method === 'eth_call').length, 1, 'No hidden retry or single-call fallback');
  }
});

test('already aborted reads cannot initialize or submit a batch', async () => {
  const cancel = new AbortController(); cancel.abort(); const f = fixture();
  await assert.rejects(createBudgetMulticallReader({ provider: f.provider, blockNumber: 123, signal: cancel.signal }));
  assert.equal(f.seen.length, 0);
});

test('oversized aggregate responses are rejected before ABI decoding or candidate use', async () => {
  const f = fixture({ raw: `0x${'00'.repeat(MAX_AGGREGATE_RETURN_BYTES + 1)}` });
  const reader = await createBudgetMulticallReader({ provider: f.provider, blockNumber: 123 });
  await assert.rejects(reader.call(address(1), views, 'value', [1]), /response exceeds read limit/);
  assert.equal(f.seen.filter(call => call.method === 'eth_call').length, 1);
});

test('cancellation rejects queued results without starting further aggregates', async () => {
  const cancel = new AbortController(), wait = deferred(), f = fixture({ wait });
  const reader = await createBudgetMulticallReader({ provider: f.provider, blockNumber: 123, signal: cancel.signal });
  const pending = Promise.allSettled(Array.from({ length: MAX_READ_BATCH * (MAX_READ_CONCURRENCY + 1) }, (_, index) => reader.call(address(1), views, 'value', [index])));
  await tick(); cancel.abort(); wait.resolve(); const results = await pending;
  assert(results.every(item => item.status === 'rejected'));
  assert(f.seen.filter(call => call.method === 'eth_call').length <= MAX_READ_CONCURRENCY);
});
