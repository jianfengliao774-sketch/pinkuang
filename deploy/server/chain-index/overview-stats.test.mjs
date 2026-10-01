import test from 'node:test';
import assert from 'node:assert/strict';
import { MiningOverviewStats, overviewQuoteLoader } from './overview-stats.mjs';

const collection = '0xb1024b89886b9a34aa4ff5f31c411d708b20a14c';
const behemoth = '0x1f5cb4aeae1807bf60c3b9c0d8adbcc14e91f12c';
const row = (state, id, circuits = collection) => ({ trusted: true, state: BigInt(state), params: { circuits, circuitId: BigInt(id) } });
const detail = (id, atomic = '432000', circuits = collection) => ({ asset: { collection: circuits, tokenId: String(id),
  mining: { status: 'verified', estimated24hAtomic: atomic, tokenSymbol: 'BEM', tokenDecimals: 8 } } });

test('overview counts owned Active/Listed NFT identities once across single pools and portfolio children', async () => {
  const calls = [], stats = new MiningOverviewStats({ quoteLoader: async (circuits, id) => {
    calls.push(`${circuits}:${id}`); return detail(id, '432000', circuits);
  } });
  try {
    const first = await stats.capture([row(0, 1), row(1, 2), row(2, 12962), row(2, 12962), row(3, 4, behemoth), row(4, 5), row(5, 6)]);
    assert.equal(first.currentlyActivePoolCount, '2'); assert.equal(first.estimatedDailyBemAtomic, '864000');
    assert.equal(first.miningOverview.basis, 'gross_estimated_output'); assert.equal(first.miningOverview.quotedMinerCount, '2');
    assert.match(first.miningOverview.minerIdentityDigest, /^[a-f\d]{64}$/); assert.equal(calls.length, 2);
    const second = await stats.capture([row(3, 4, behemoth), row(2, 12962)]);
    assert.equal(second.miningOverview.minerIdentityDigest, first.miningOverview.minerIdentityDigest); assert.equal(calls.length, 2);
    const changed = await stats.capture([row(2, 9)]); assert.notEqual(changed.miningOverview.minerIdentityDigest, first.miningOverview.minerIdentityDigest);
    assert.equal(stats.quotes.size, 1, 'sold or removed miner estimates are evicted');
  } finally { stats.close(); }
});

test('unknown pool state or active NFT identity does not produce a partial count or fabricated daily total', async () => {
  const stats = new MiningOverviewStats({ quoteLoader: async (_circuits, id) => detail(id) });
  try {
    for (const bad of [{ ...row(2, 2), state: null }, { ...row(2, 2), params: null }, { ...row(2, 2), trusted: false }]) {
      const value = await stats.capture([row(2, 12962), bad]);
      assert.equal(value.currentlyActivePoolCount, null); assert.equal(value.estimatedDailyBemAtomic, null);
      assert.equal(value.miningOverview.minerCountComplete, false); assert.equal(value.miningOverview.dailyOutputComplete, false);
    }
  } finally { stats.close(); }
});

test('one missing quote hides the aggregate instead of mixing a new miner count with an old total', async () => {
  const stats = new MiningOverviewStats({ quoteLoader: async (_circuits, id) => {
    if (id === '2') throw new Error('offline'); return detail(id);
  } });
  try {
    const value = await stats.capture([row(2, 1), row(3, 2)]);
    assert.equal(value.currentlyActivePoolCount, '2'); assert.equal(value.estimatedDailyBemAtomic, null);
    assert.equal(value.miningOverview.quotedMinerCount, '1'); assert.equal(value.miningOverview.missingMinerCount, '1');
    assert.equal(value.miningOverview.dailyOutputComplete, false);
  } finally { stats.close(); }
});

test('quote failures retain bounded last-good output and expire it without resetting its observation time', async () => {
  let time = 1_000_000, fail = false, calls = 0;
  const stats = new MiningOverviewStats({ now: () => time, quoteLoader: async (_circuits, id) => {
    calls++; if (fail) throw new Error('offline'); return detail(id);
  } });
  try {
    const initial = await stats.capture([row(2, 12962)]); const observed = initial.miningOverview.observedAt;
    time += 1000; await stats.capture([row(2, 12962)]); assert.equal(calls, 1);
    time += 120_000; fail = true;
    const retained = await stats.capture([row(2, 12962)]);
    assert.equal(retained.estimatedDailyBemAtomic, '432000'); assert.equal(retained.miningOverview.staleQuoteMinerCount, '1');
    assert.equal(retained.miningOverview.observedAt, observed);
    time += 10 * 60_000;
    const expired = await stats.capture([row(2, 12962)]);
    assert.equal(expired.estimatedDailyBemAtomic, null); assert.equal(expired.currentlyActivePoolCount, '1');
    assert.equal(expired.miningOverview.missingMinerCount, '1'); assert.equal(expired.miningOverview.observedAt, null);
  } finally { stats.close(); }
});

test('exact decimal source amounts and identity/unit metadata are required without converting unsafe JSON numbers', async () => {
  for (const change of [asset => { asset.tokenId = 12962; }, asset => { asset.mining.estimated24hAtomic = 9007199254740993; },
    asset => { asset.mining.tokenDecimals = 18; }, asset => { asset.mining.status = 'unverified'; },
    asset => { asset.collection = behemoth; }, asset => { asset.mining.estimated24hAtomic = '1e6'; }]) {
    const stats = new MiningOverviewStats({ quoteLoader: async () => { const result = detail(12962); change(result.asset); return result; } });
    try { const value = await stats.capture([row(2, 12962)]); assert.equal(value.estimatedDailyBemAtomic, null); }
    finally { stats.close(); }
  }
});

test('an empty managed-miner set is a complete zero and a valid zero output remains zero', async () => {
  const empty = new MiningOverviewStats();
  try {
    const value = await empty.capture([row(0, 1), row(4, 2)]);
    assert.equal(value.currentlyActivePoolCount, '0'); assert.equal(value.estimatedDailyBemAtomic, '0');
    assert.equal(value.miningOverview.dailyOutputComplete, true); assert.equal(value.miningOverview.observedAt, null);
  } finally { empty.close(); }
  const zero = new MiningOverviewStats({ quoteLoader: async () => detail(1, '0') });
  try { assert.equal((await zero.capture([row(2, 1)])).estimatedDailyBemAtomic, '0'); } finally { zero.close(); }
});

test('overview quote reads reuse the local fixed product display route without RPC or credentials', async () => {
  let calls = 0;
  const load = overviewQuoteLoader({ fetcher: async (url, options) => {
    calls++; assert.equal(url, `http://127.0.0.1:4187/firsto-api/v1/circuit/${collection}/12962?display=1`);
    assert.equal(options.method, 'GET'); assert.equal(options.redirect, 'error'); assert.deepEqual(options.headers, { Accept: 'application/json' });
    return Response.json(detail(12962));
  } });
  assert.equal((await load(collection, '12962')).asset.mining.estimated24hAtomic, '432000'); assert.equal(calls, 1);
  await assert.rejects(load('0x' + '12'.repeat(20), '1'), /Unsupported/); assert.equal(calls, 1);
  for (const baseUrl of ['https://example.org/firsto-api', 'http://127.0.0.1:4187/other', 'http://user:secret@127.0.0.1:4187/firsto-api'])
    assert.throws(() => overviewQuoteLoader({ baseUrl }), /local product display proxy/);
});

test('quote workers stay bounded and closing aborts pending display work', async () => {
  let active = 0, maximum = 0;
  const stats = new MiningOverviewStats({ quoteLoader: async (_circuits, id) => {
    maximum = Math.max(maximum, ++active); await new Promise(resolve => setImmediate(resolve)); active--; return detail(id);
  } });
  try { await stats.capture(Array.from({ length: 12 }, (_, i) => row(2, i))); assert.equal(maximum, 4); }
  finally { stats.close(); }
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  const stopping = new MiningOverviewStats({ quoteLoader: async (_circuits, _id, signal) => {
    started(); await new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
  } });
  const running = stopping.capture([row(2, 1)]); await ready; stopping.close(); await running;
  assert.equal(stopping.quotes.size, 0);
});

test('slow quotes at the front cannot starve healthy miners in later bounded passes', async () => {
  let time=1_000_000;
  const stats=new MiningOverviewStats({now:()=>time,captureTimeoutMs:25,quoteLoader:async (_circuits,id,signal)=>{
    if (Number(id)<4) await new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(new Error('timeout')),{once:true}));
    return detail(id);
  }});
  const keepAlive=setInterval(()=>{},1000);
  try {
    const rows=Array.from({length:12},(_,i)=>row(2,i));
    await stats.capture(rows);time+=100;
    const second=await stats.capture(rows);
    assert.equal(second.miningOverview.quotedMinerCount,'8');assert.equal(second.miningOverview.missingMinerCount,'4');
    assert.equal(second.estimatedDailyBemAtomic,null,'partial production estimates are never reported as the full output');
  } finally {clearInterval(keepAlive);stats.close();}
});
