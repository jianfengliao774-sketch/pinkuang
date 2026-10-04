import test from 'node:test';
import assert from 'node:assert/strict';
import { capacityRequestKey, createCapacityRequestCache, CAPACITY_FAILURE_COOLDOWN_MS,
  CAPACITY_MANUAL_MIN_INTERVAL_MS } from '../lib/capacity-request-cache.mjs';

const address = value => `0x${value.repeat(40)}`;
const manifest = { artifactDigest: `0x${'ab'.repeat(32)}`, factory: address('1'),
  chainId: 56, shareMarket: address('2') };
const input = { manifest, pool: address('3'), pricePerUnitWei: 10n, displayOnly: true,
  params: { circuits: address('4'), circuitId: 16736n } };
const unavailable = { available: false, reason: 'missing_output' };
const deferred = () => { let resolve; return { promise: new Promise(yes => { resolve = yes; }), resolve }; };
const success = (now, context = input) => ({ available: true, pool: context.pool,
  pricePerUnitWei: context.pricePerUnitWei, forPriceWei: context.pricePerUnitWei.toString(),
  collection: context.params?.circuits ?? address('4'), tokenId: context.params?.circuitId?.toString() ?? '16736',
  displayOnly: context.displayOnly, includeOfficialAsk: context.includeOfficialAsk === true,
  allowUnownedTarget: context.allowUnownedTarget === true, officialAskStatus: context.includeOfficialAsk ? 'absent' : 'not_requested',
  minerAskPriceWei: null, minerAskSource: null, observedAt: now, validUntil: now + 300_000, estimated24hAtomic: 432000n });

test('overlapping page refreshes and explicit retries share one paid in-flight request', async () => {
  const wait = deferred(); let calls = 0, now = 1000;
  const cache = createCapacityRequestCache({ now: () => now });
  const load = () => { calls++; return wait.promise; };
  const first = cache.read(input, load);
  assert.equal(cache.read({ ...input, params: { ...input.params } }, load), first);
  assert.equal(cache.read(input, load, { force: true }), first);
  await Promise.resolve(); assert.equal(calls, 1);
  now += 30_000; wait.resolve(unavailable);
  const result = await first;
  assert.equal(result.retryAt, now + CAPACITY_FAILURE_COOLDOWN_MS);
  assert.equal(result.requestKey, capacityRequestKey(input));
});

test('thirty-second business page refreshes reuse a failure for five minutes, then retry once', async () => {
  let calls = 0, now = 1000;
  const cache = createCapacityRequestCache({ now: () => now });
  const load = () => { calls++; return unavailable; };
  const result = await cache.read(input, load);
  for (let refresh = 1; refresh < 10; refresh++) {
    now = 1000 + refresh * 30_000;
    assert.equal(await cache.read(input, load), result);
  }
  assert.equal(calls, 1);
  now = result.retryAt;
  await Promise.all([cache.read(input, load), cache.read(input, load)]);
  assert.equal(calls, 2);
});

test('successful quotes expire at their stated validUntil, without a premature paid refresh', async () => {
  let calls = 0, now = 1000;
  const cache = createCapacityRequestCache({ now: () => now });
  const load = () => { calls++; return { ...success(now), validUntil: now + 45_000 }; };
  const result = await cache.read(input, load);
  now = result.validUntil - 1;
  assert.equal(cache.peek(input), result);
  assert.equal(await cache.read(input, load), result); assert.equal(calls, 1);
  now = result.validUntil;
  assert.equal(cache.peek(input), null);
  await cache.read(input, load); assert.equal(calls, 2);
});

test('price, factory, artifact, market, read mode and replacement NFT separate quote reuse', async () => {
  let calls = 0;
  const cache = createCapacityRequestCache({ now: () => 1000 });
  const load = () => { calls++; return unavailable; };
  await cache.read(input, load);
  const equivalent = { ...input, pool: input.pool.toUpperCase().replace('0X', '0x'),
    manifest: { ...manifest, artifactDigest: manifest.artifactDigest.toUpperCase().replace('0X', '0x') } };
  await cache.read(equivalent, load); assert.equal(calls, 1);
  const others = [
    { ...input, pricePerUnitWei: 11n },
    { ...input, manifest: { ...manifest, factory: address('5') } },
    { ...input, manifest: { ...manifest, artifactDigest: `0x${'cd'.repeat(32)}` } },
    { ...input, manifest: { ...manifest, shareMarket: address('6') } },
    { ...input, displayOnly: false },
    { ...input, params: { ...input.params, circuitId: 16480n } },
  ];
  for (const changed of others) await cache.read(changed, load);
  assert.equal(calls, 1 + others.length);
  assert.equal(await cache.read(input, load), cache.peek(input)); assert.equal(calls, 7);
});

test('manual retry bypasses failure cooldown after minimum spacing and leaves other miners cached', async () => {
  let calls = 0, now = 1000;
  const cache = createCapacityRequestCache({ now: () => now });
  const second = { ...input, pool: address('7') };
  const load = () => { calls++; return unavailable; };
  const first = await cache.read(input, load), other = await cache.read(second, load);
  now += CAPACITY_MANUAL_MIN_INTERVAL_MS - 1;
  assert.equal(await cache.read(input, load, { force: true }), first); assert.equal(calls, 2);
  now++;
  assert.notEqual(await cache.read(input, load, { force: true }), first); assert.equal(calls, 3);
  assert.equal(await cache.read(second, load), other); assert.equal(calls, 3);
});

test('a thrown or already expired reply cools down rather than retrying on each rerender', async () => {
  for (const reply of [() => { throw new Error('HTTP 429'); }, () => ({ ...success(1000), validUntil: 999 })]) {
    let calls = 0;
    const cache = createCapacityRequestCache({ now: () => 1000 });
    const load = () => { calls++; return reply(); };
    const result = await cache.read(input, load);
    assert.equal(result.available, false); assert.equal(result.retryAt, 301000);
    await cache.read(input, load); assert.equal(calls, 1);
  }
});

test('the trusted persisted display seed must match this NFT, exact price and read mode', async () => {
  const savedQuote = success(1000);
  const cache = createCapacityRequestCache({ now: () => 2000 });
  let calls = 0;
  const load = () => { calls++; return unavailable; };
  const seeded = await cache.read(input, load, { savedQuote });
  assert.equal(seeded.available, true); assert.equal(calls, 0);
  for (const changed of [{ ...input, params: { ...input.params, circuitId: 1n } },
    { ...input, pricePerUnitWei: 11n }, { ...input, displayOnly: false }]) {
    assert.equal((await cache.read(changed, load, { savedQuote })).available, false);
  }
  assert.equal(calls, 3);
});

test('a malformed or mismatched deployment context never starts a paid request', async () => {
  const cache = createCapacityRequestCache({ now: () => 1000 });
  for (const changed of [{ ...input, factory: address('9') }, { ...input, pricePerUnitWei: '10' },
    { ...input, manifest: { ...manifest, artifactDigest: 'invalid' } },
    { ...input, params: { circuits: address('4'), circuitId: '-1' } }]) {
    assert.equal(capacityRequestKey(changed), null);
    assert.equal((await cache.read(changed, () => assert.fail('Invalid context must not spend quota'))).available, false);
  }
});


test('official ask opt-in isolates in-flight, successful and persisted daily-only estimates', async () => {
  let now = 1000, calls = 0;
  const cache = createCapacityRequestCache({ now: () => now });
  const withAsk = { ...input, includeOfficialAsk: true, allowUnownedTarget: true };
  const load = context => () => { calls++; return success(now, context); };
  const daily = await cache.read(input, load(input));
  assert.notEqual(capacityRequestKey(input), capacityRequestKey(withAsk));
  const funded = await cache.read(withAsk, load(withAsk), { savedQuote: daily });
  assert.equal(funded.includeOfficialAsk, true); assert.equal(calls, 2);
  // Funding -> Active uses acquisition cost and never inherits the fundraising ask policy.
  assert.equal(await cache.read(input, load(input), { savedQuote: funded }), daily);
  now += 30_000;
  assert.equal(await cache.read(withAsk, load(withAsk)), funded); assert.equal(calls, 2);
  const missingMarker = { ...funded }; delete missingMarker.includeOfficialAsk;
  const fresh = createCapacityRequestCache({ now: () => now });
  await fresh.read(withAsk, load(withAsk), { savedQuote: missingMarker }); assert.equal(calls, 3);
});

test('persisted strict fundraising estimates cannot bypass the pool-owned miner policy', async () => {
  let calls = 0;
  const cache = createCapacityRequestCache({ now: () => 2000 });
  const funding = { ...input, displayOnly: false, allowUnownedTarget: true };
  const active = { ...funding, allowUnownedTarget: false };
  const savedQuote = success(1000, funding);
  assert.equal((await cache.read(active, () => { calls++; return unavailable; }, { savedQuote })).available, false);
  assert.equal(calls, 1);
});
