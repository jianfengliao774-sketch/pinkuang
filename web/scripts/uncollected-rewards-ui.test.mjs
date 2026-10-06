import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// Execute the component's financial read effect, without a wallet or live RPC.
const source = await readFile(new URL('../components/LivePlatform.jsx', import.meta.url), 'utf8');
const start = source.indexOf('  useEffect(() => {\n    let cancelled = false;\n    setUncollectedRewards(null);');
const end = source.indexOf('\n  useEffect(', start + 1);
assert(start >= 0 && end > start);
const code = source.slice(start, end);
const turn = () => new Promise(resolve => setImmediate(resolve));
const account = '0x' + '11'.repeat(20), pool = '0x' + '22'.repeat(20);
const same = (a, b) => !!a && !!b && a.toLowerCase() === b.toLowerCase();
function fixture(overrides = {}) {
  const states = [], calls = [];
  let release, cleanup, dependencies;
  const client = { readUncollectedRewards: input => {
    calls.push(input); return new Promise(resolve => { release = resolve; });
  } };
  const context = { client, account, route: { route: 'rewards' }, positionsLoaded: true,
    positionsAccount: account, positions: [{ pool }], rewardPoolsKey: pool,
    rewardReadKey: 'factory:account:pool', refresh: 0, rewardsRefresh: 0,
    uncollectedRequest: { current: null }, same,
    setUncollectedRewards: value => states.push(value), ...overrides };
  const execute = (changes, respectDependencies = false) => {
    Object.assign(context, changes);
    new Function(...Object.keys(context), 'useEffect', code)(...Object.values(context), (fn, next) => {
      if (respectDependencies && dependencies && next.every((value, index) => Object.is(value, dependencies[index]))) return;
      if (respectDependencies) cleanup?.();
      dependencies = next;
      cleanup = fn();
    });
    return cleanup;
  };
  return { context, client, states, calls, run: changes => execute(changes),
    render: changes => execute(changes, true), resolve: value => release(value) };
}

test('overview and rewards read only the currently loaded account positions', () => {
  for (const route of ['overview', 'rewards']) {
    const f = fixture({ route: { route } }); f.run();
    assert.equal(f.calls.length, 1, route);
    assert.equal(f.calls[0].account, account);
    assert.deepEqual(f.calls[0].positions, [{ pool }]);
  }
});

test('other pages, disconnected wallets and mismatched or unloaded positions do not read miners', () => {
  for (const changes of [...['home', 'pools', 'detail', 'market'].map(route => ({ route: { route } })), { account: null },
    { positionsLoaded: false }, { positionsAccount: '0x' + '33'.repeat(20) }]) {
    const f = fixture(changes); f.run(); assert.equal(f.calls.length, 0);
  }
});

test('wallet/route cleanup discards the late financial result from the old request', async () => {
  const f = fixture(), cleanup = f.run();
  assert.equal(f.calls.length, 1);
  assert.equal(f.states.at(-1).status, 'loading');
  cleanup(); f.resolve({ status: 'ready', totals: { totalEstimatedBEM: 100n } });
  await turn(); assert.equal(f.states.at(-1).status, 'loading');
});

test('manual or confirmed-transaction revisions bypass TTL; unrelated display generations do not', async () => {
  const f = fixture();
  f.run(); assert.equal(f.calls[0].force, false);
  f.resolve({ status: 'partial', items: [{ pool, uncollectedBEM: null }] }); await turn();
  assert.equal(f.states.at(-1).requestKey, f.context.rewardReadKey);
  assert.equal(f.states.at(-1).client, f.client);
  f.run({ rewardsRefresh: 1 }); assert.equal(f.calls.at(-1).force, true);
  f.resolve({ status: 'ready' }); await turn();
  f.run(); assert.equal(f.calls.at(-1).force, false);
  // These callbacks cannot be triggered by price/SSE/index timer revisions.
  const dependencies = code.slice(code.lastIndexOf('}, ['));
  assert(!dependencies.includes('displayRefreshKey'));
  assert(!dependencies.includes('receiptDisplayRefresh'));
  assert(!dependencies.includes('capacityNow'));
  assert(!dependencies.includes('positionsReadSource'));
});

test('overview index, SSE and price rerenders keep the read revision, while manual refresh forces one new read', async () => {
  const f = fixture({ route: { route: 'overview' }, receiptDisplayRefresh: 0,
    displayRefreshKey: '0:0', capacityNow: 1000, positionsReadSource: { indexedThrough: 100 } });
  f.render(); assert.equal(f.calls.length, 1);
  f.resolve({ status: 'ready', totals: { totalEstimatedBEM: 100n } }); await turn();
  const current = f.states.at(-1);
  f.render({ receiptDisplayRefresh: 1, displayRefreshKey: '0:1' });
  f.render({ positionsReadSource: { indexedThrough: 101 } });
  f.render({ capacityNow: 2000 });
  assert.equal(f.calls.length, 1);
  assert.equal(f.context.rewardsRefresh, 0);
  assert.equal(f.states.at(-1), current);
  f.render({ rewardsRefresh: 1 });
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[1].force, true);
  f.resolve({ status: 'ready' }); await turn();
  f.render(); assert.equal(f.calls.length, 2, 'A settled rerender cannot duplicate the manual read.');
});
