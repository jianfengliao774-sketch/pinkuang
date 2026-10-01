import test from 'node:test';
import assert from 'node:assert/strict';
import { createLiveDataClient } from '../lib/live-data.mjs';
import { readMiningOverviewStats } from '../lib/mining-overview.mjs';
import { displayAmount } from '../lib/amount-display.mjs';
import { readDisplaySnapshot, writeDisplaySnapshot } from '../lib/display-snapshot.mjs';
import { startDisplayUpdates } from '../lib/display-updates.mjs';
import { portfolioFixture } from './portfolio-fixture.mjs';

function stats(values = {}) {
  return { scope: 'confirmed_indexed_history', registeredPoolCount: '4',
    standalonePoolCount: '4', portfolioCount: '2', topLevelProjectCount: '6',
    childPoolCount: '0', reservedChildPoolCount: '0', reservedChildPoolAddresses: [],
    reservedChildPoolAddressesComplete: true, everParticipantAddressCount: '3',
    purchasedCostWei: '1000000000000000000', shareMarketFilledGrossWei: '0',
    harvestedToMembersBemAtomic: '86666', currentlyActivePoolCount: '1',
    estimatedDailyBemAtomic: '432000', miningOverview: {
      basis: 'gross_estimated_output', minerCountComplete: true, dailyOutputComplete: true,
      quotedMinerCount: '1', missingMinerCount: '0', staleQuoteMinerCount: '0',
      observedAt: new Date().toISOString(),
    }, ...values };
}

function fixture(initial = stats()) {
  const f = portfolioFixture(), calls = [];
  let current = initial, failure = false;
  const config = { ...f.config, productFamily: 'fresh-v4', displayOnly: true };
  const client = createLiveDataClient(config, {
    provider: { request: async () => { throw new Error('Public totals must not read browser RPC'); } },
    fetcher: async url => {
      const path = new URL(url).pathname; calls.push(path);
      if (failure) throw new Error('Temporary server outage');
      assert.match(path, /\/v1\/(?:display\/)?stats$/);
      const source = path.includes('/display/') ? { ...f.source(), readMode: 'verified_snapshot',
        stale: true, refreshing: false, transactionReady: false, cacheOrigin: 'server' } : f.source();
      return new Response(JSON.stringify({ source, data: current }), {
        headers: { 'content-type': 'application/json' },
      });
    },
  });
  return { ...f, config, client, calls, update: value => { current = value; }, fail: () => { failure = true; } };
}

test('anonymous current and cached stats expose exact miner count and gross BEM output with zero browser RPC', async () => {
  const f = fixture();
  for (const result of [await f.client.readStats(), await f.client.readDisplayStats()]) {
    assert.equal(result.data.currentlyActivePoolCount, 1n);
    assert.equal(result.data.estimatedDailyBemAtomic, 432000n);
    assert.equal(displayAmount(result.data.estimatedDailyBemAtomic, 8), '0.00432');
    assert.equal(result.data.miningOverview.quotedMinerCount, 1n);
    assert.equal(result.source.transactionReady, false);
  }
  assert.equal(f.calls.length, 2);
});

test('incomplete output remains unknown rather than presenting the loaded subset as a full total', () => {
  const initial = stats();
  const partial = readMiningOverviewStats({ ...initial, estimatedDailyBemAtomic: '432000',
    miningOverview: { ...initial.miningOverview, dailyOutputComplete: false,
      quotedMinerCount: '0', missingMinerCount: '1' } });
  assert.equal(partial.currentlyActivePoolCount, 1n);
  assert.equal(partial.estimatedDailyBemAtomic, null);
  const unknown = readMiningOverviewStats({ ...initial, miningOverview: { ...initial.miningOverview,
    minerCountComplete: false, dailyOutputComplete: false } });
  assert.equal(unknown.currentlyActivePoolCount, null);
  assert.equal(unknown.estimatedDailyBemAtomic, null);
  assert.deepEqual(readMiningOverviewStats({}), { currentlyActivePoolCount: null, estimatedDailyBemAtomic: null });
});

test('complete empty inventory reports exact zero; large atomic values and bounded stale quotes remain exact', () => {
  const initial = stats();
  const empty = readMiningOverviewStats({ ...initial, currentlyActivePoolCount: '0', estimatedDailyBemAtomic: '0',
    miningOverview: { ...initial.miningOverview, quotedMinerCount: '0', observedAt: null } });
  assert.equal(empty.currentlyActivePoolCount, 0n);
  assert.equal(displayAmount(empty.estimatedDailyBemAtomic, 8), '0.00000');
  const stale = readMiningOverviewStats({ ...initial, estimatedDailyBemAtomic: '9007199254740993123456789',
    miningOverview: { ...initial.miningOverview, staleQuoteMinerCount: '1' } });
  assert.equal(stale.estimatedDailyBemAtomic, 9007199254740993123456789n);
  assert.equal(stale.miningOverview.staleQuoteMinerCount, 1n);
});

test('malformed or contradictory mining estimates cannot become exact public totals', () => {
  const initial = stats();
  for (const changed of [
    { currentlyActivePoolCount: 1 }, { estimatedDailyBemAtomic: '0.00432' },
    { estimatedDailyBemAtomic: '-1' }, { currentlyActivePoolCount: null },
    { miningOverview: { ...initial.miningOverview, basis: 'claimable_member_output' } },
    { miningOverview: { ...initial.miningOverview, missingMinerCount: '1' } },
    { miningOverview: { ...initial.miningOverview, quotedMinerCount: '2' } },
    { miningOverview: { ...initial.miningOverview, staleQuoteMinerCount: '2' } },
    { miningOverview: { ...initial.miningOverview, observedAt: 'invalid' } },
    { miningOverview: { ...initial.miningOverview, minerCountComplete: false } },
  ]) assert.throws(() => readMiningOverviewStats({ ...initial, ...changed }), { code: 'invalid_data' });
});

test('revisits reuse the cached public totals and a quote-only push replaces them without wallet calls', async () => {
  const f = fixture(), backing = new Map();
  const storage = { getItem: key => backing.get(key) ?? null, setItem: (key, value) => backing.set(key, value) };
  const before = await f.client.readDisplayStats();
  assert(writeDisplaySnapshot(storage, f.manifest, 'stats', before));
  const revisit = readDisplaySnapshot(storage, f.manifest, 'stats');
  assert.equal(revisit.data.estimatedDailyBemAtomic, 432000n);
  assert.equal(f.calls.length, 1, 'reading a persisted public snapshot does not repeat HTTP');
  let stream, flush, refreshed;
  class Source {
    constructor() { stream = this; }
    addEventListener(_name, handler) { this.handler = handler; }
    removeEventListener() {} close() {}
    emit(revision) { this.handler({ data: JSON.stringify({ revision }) }); }
  }
  const stop = startDisplayUpdates(f.config, { EventSourceImpl: Source,
    documentObject: { visibilityState: 'visible', addEventListener() {}, removeEventListener() {} },
    schedule: callback => { flush = callback; return 1; }, unschedule() {},
    onUpdate: () => { refreshed = f.client.readDisplayStats().then(result => {
      writeDisplaySnapshot(storage, f.manifest, 'stats', result); return result;
    }); },
  });
  stream.emit('same-chain-tip:quote-1');
  f.update(stats({ estimatedDailyBemAtomic: '864000' }));
  stream.emit('same-chain-tip:quote-2'); flush();
  assert.equal((await refreshed).data.estimatedDailyBemAtomic, 864000n);
  assert.equal(readDisplaySnapshot(storage, f.manifest, 'stats').data.estimatedDailyBemAtomic, 864000n);
  assert.equal(f.calls.length, 2, 'only the changed revision fetches the shared server snapshot');
  f.fail();
  await assert.rejects(f.client.readDisplayStats());
  assert.equal(readDisplaySnapshot(storage, f.manifest, 'stats').data.estimatedDailyBemAtomic, 864000n,
    'a failed refresh leaves the last displayed snapshot intact');
  stop();
});
