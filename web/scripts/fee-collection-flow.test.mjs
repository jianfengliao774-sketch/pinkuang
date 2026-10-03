import test from 'node:test';
import assert from 'node:assert/strict';
import { collectFeeBatches, feeCollectionDelay } from '../lib/fee-collection-flow.mjs';

const address = value => `0x${BigInt(value).toString(16).padStart(40, '0')}`;
const hash = value => `0x${BigInt(value).toString(16).padStart(64, '0')}`;
const batch = value => ({ markets: [address(value)], pools: [address(value + 100)] });
const receipt = (value, status = 'confirmed') => ({ kind: 'claimFees', hash: hash(value), status });
const turn = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
function fixture(overrides = {}) {
  let clock = 0;
  const actions = [], statuses = [], progress = [], waits = [];
  const options = { plan: { batches: [batch(1), batch(2)] }, recipient: address(9),
    now: () => clock, wait: async ms => { waits.push(ms); clock += ms; },
    onAction: async (kind, args) => { actions.push({ kind, args, at: clock }); return receipt(actions.length); },
    readStatus: async () => assert.fail('Unexpected status read'), onStatus: value => statuses.push(value),
    onProgress: value => progress.push(value), ...overrides };
  return { options, actions, statuses, progress, waits, run: () => collectFeeBatches(options) };
}

test('each batch binds every supplied source and current recipient, at least 15 seconds apart', async () => {
  const f = fixture(); assert.deepEqual(await f.run(), [hash(1), hash(2)]);
  assert.deepEqual(f.actions.map(entry => entry.at), [0, 15000]); assert.deepEqual(f.waits, [15000]);
  for (let n = 0; n < 2; n++) assert.deepEqual(f.actions[n], { kind: 'claimFees',
    args: { ...batch(n + 1), recipient: address(9) }, at: n * 15000 });
  assert.deepEqual(f.progress.at(-1).completed, [hash(1), hash(2)]);
});

test('pending batch is polled every 5 seconds and must confirm before the next signature', async () => {
  const pending = deferred(); let clock = 0, reads = 0; const calls = [], waits = [];
  const promise = collectFeeBatches({ plan: { batches: [batch(1), batch(2)] }, recipient: address(9),
    now: () => clock, wait: async ms => { waits.push(ms); clock += ms; },
    onAction: async (_kind, args) => { calls.push(args); return receipt(calls.length, calls.length === 1 ? 'pending' : 'confirmed'); },
    readStatus: async () => { reads++; return pending.promise; } });
  await turn(); assert.equal(calls.length, 1); assert.equal(reads, 1); assert.deepEqual(waits, [5000]);
  pending.resolve(receipt(1)); assert.deepEqual(await promise, [hash(1), hash(2)]);
  assert.equal(calls.length, 2); assert.deepEqual(waits, [5000, 10000]);
});

test('signature cancellation ends the run without retries or subsequent batches', async () => {
  let actions = 0;
  const f = fixture({ onAction: async () => { actions++; throw Object.assign(new Error('User rejected signature'), { code: 4001 }); } });
  await assert.rejects(f.run(), /User rejected/); assert.equal(actions, 1); assert.deepEqual(f.waits, []);
});

test('unknown submission without exact claimFees hash never retries or proceeds', async () => {
  for (const result of [null, { status: 'uncertain' }, { hash: hash(1), kind: 'reviewSale', status: 'confirmed' }]) {
    let actions = 0;
    const f = fixture({ onAction: async () => { actions++; return result; } });
    await assert.rejects(f.run(), /提交结果尚不明确/); assert.equal(actions, 1);
  }
});

test('changed hash or operation in status polling pauses without resubmission', async () => {
  for (const result of [receipt(2), { ...receipt(1), kind: 'reviewSale' }, { status: 'idle' }]) {
    let actions = 0;
    const f = fixture({ onAction: async () => { actions++; return receipt(1, 'pending'); }, readStatus: async () => result });
    await assert.rejects(f.run(), /代付状态已变化/); assert.equal(actions, 1);
  }
});

test('unknown transaction with a hash only polls and pauses after two minutes', async () => {
  let actions = 0, reads = 0;
  const f = fixture({ onAction: async () => { actions++; return receipt(1, 'uncertain'); },
    readStatus: async () => { reads++; return receipt(1, 'uncertain'); } });
  await assert.rejects(f.run(), /仍待确认/); assert.equal(actions, 1); assert.equal(reads, 24);
  assert(f.waits.every(ms => ms === 5000));
});

test('failed later batch preserves completed receipts in the latest progress event', async () => {
  let actions = 0;
  const f = fixture({ onAction: async () => receipt(++actions, actions === 1 ? 'confirmed' : 'failed') });
  await assert.rejects(f.run(), /第 2 批.*已完成 1 批/); assert.equal(actions, 2);
  assert.deepEqual(f.progress.at(-1).completed, [hash(1)]);
});

test('a batch accepts 24 total sources but rejects 25 before asking for a signature', async () => {
  const pools = Array.from({ length: 24 }, (_, n) => address(n + 100));
  const accepted = fixture({ plan: { batches: [{ markets: [], pools }] } });
  assert.deepEqual(await accepted.run(), [hash(1)]); assert.equal(accepted.actions[0].args.pools.length, 24);
  const rejected = fixture({ plan: { batches: [{ markets: [address(1)], pools }] } });
  await assert.rejects(rejected.run(), /来源分批无效/); assert.equal(rejected.actions.length, 0);
});

test('account or pane invalidation during inter-batch delay prevents the next signature', async () => {
  let current = true;
  const f = fixture({ current: () => current, wait: async () => { current = false; } });
  await assert.rejects(f.run(), /归集已停止/); assert.equal(f.actions.length, 1);
  assert.deepEqual(f.progress.at(-1).completed, [hash(1)]);
});

test('aborting a pending status read prevents the next batch even when a late receipt confirms', async () => {
  const controller = new AbortController(), pending = deferred(); let actions = 0;
  const f = fixture({ signal: controller.signal,
    onAction: async () => { actions++; return receipt(1, 'pending'); }, readStatus: () => pending.promise });
  const promise = f.run(); await turn(); controller.abort(); pending.resolve(receipt(1));
  await assert.rejects(promise, /归集已停止/); assert.equal(actions, 1);
});

test('real delay rejects promptly when aborted rather than waiting for its timer', async () => {
  const controller = new AbortController(); const promise = feeCollectionDelay(15000, controller.signal);
  controller.abort(); await assert.rejects(promise, /归集已停止/);
  await assert.rejects(feeCollectionDelay(15000, controller.signal), /归集已停止/);
});

test('direct Authority funds may use a zero-source batch; a zero-balance plan never signs', async () => {
  const direct = fixture({ plan: { batches: [{ markets: [], pools: [] }] } });
  assert.deepEqual(await direct.run(), [hash(1)]);
  const empty = fixture({ plan: { batches: [] } }); assert.deepEqual(await empty.run(), []);
  assert.equal(empty.actions.length, 0);
});
