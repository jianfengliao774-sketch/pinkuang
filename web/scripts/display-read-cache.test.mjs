import test from 'node:test';
import assert from 'node:assert/strict';
import { createDisplayReadCache } from '../lib/display-read-cache.mjs';

const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

test('display reads share pending work and expire or refresh without retaining failed results', async () => {
  const read = createDisplayReadCache(), provider = {}, first = deferred();
  let now = 100, count = 0;
  const work = () => { count++; return count === 1 ? first.promise : Promise.resolve(count); };
  const options = { now: () => now, cacheMs: 120_000 };
  const a = read(provider, 'pool:wallet', work, options), b = read(provider, 'pool:wallet', work, { ...options, force: true });
  await Promise.resolve(); assert.equal(count, 1); first.resolve(1);
  assert.deepEqual(await Promise.all([a, b]), [1, 1]);
  now += 119_999; assert.equal(await read(provider, 'pool:wallet', work, options), 1);
  now++; assert.equal(await read(provider, 'pool:wallet', work, options), 2);
  assert.equal(await read(provider, 'pool:wallet', work, { ...options, refreshToken: 1 }), 3);
  assert.equal(await read(provider, 'pool:wallet', work, { ...options, refreshToken: 1, force: true }), 4);
  await assert.rejects(read(provider, 'failure', () => Promise.reject(new Error('RPC failed')), options), /RPC failed/);
  assert.equal(await read(provider, 'failure', work, options), 5);
  await read(provider, 'partial', work, { ...options, shouldCache: () => false });
  await read(provider, 'partial', work, options); assert.equal(count, 7);
});

test('one aborted consumer cannot cancel another, but leaving the last consumer stops shared work', async () => {
  const read = createDisplayReadCache(), provider = {}, pending = deferred();
  let signal;
  const work = shared => { signal = shared; return pending.promise; };
  const first = new AbortController(), second = new AbortController();
  const a = read(provider, 'one', work, { signal: first.signal });
  const b = read(provider, 'one', work, { signal: second.signal });
  await Promise.resolve(); first.abort();
  await assert.rejects(a, error => error.name === 'AbortError'); assert.equal(signal.aborted, false);
  pending.resolve(42); assert.equal(await b, 42);
  const last = new AbortController(), blocked = deferred();
  const c = read(provider, 'last', shared => { signal = shared; return blocked.promise; }, { signal: last.signal });
  await Promise.resolve(); last.abort();
  await assert.rejects(c, error => error.name === 'AbortError'); assert.equal(signal.aborted, true);
  assert.equal(await read(provider, 'last', () => 9), 9, 'cancelled work cannot remain reusable');
  blocked.resolve(8);
});

test('provider and key identities are separate and the entry count is bounded', async () => {
  const read = createDisplayReadCache({ maxEntries: 2 }), first = {}, second = {}; let count = 0;
  const work = () => ++count;
  await read(first, 'account-a', work); await read(first, 'account-b', work);
  assert.equal(await read(second, 'account-a', work), 3);
  assert.equal(await read(first, 'account-a', work), 1);
  await read(first, 'account-c', work);
  assert.equal(await read(first, 'account-a', work), 5);
});
