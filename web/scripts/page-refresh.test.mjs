import test from 'node:test';
import assert from 'node:assert/strict';
import { pageRefreshDue, refreshIntervalMs } from '../lib/page-refresh.mjs';

test('refresh cadence is route-scoped and operator forms do not poll', () => {
  assert.equal(refreshIntervalMs('market'), 30_000);
  assert.equal(refreshIntervalMs('detail'), 30_000);
  assert.equal(refreshIntervalMs('overview'), 60_000);
  assert.equal(refreshIntervalMs('operator'), null);
});

test('only mounted business cache GETs receive faster refresh, verified chain cadence stays unchanged', () => {
  for (const route of ['overview', 'rewards', 'detail', 'portfolio']) {
    assert.equal(refreshIntervalMs(route, { displayOnly: true }), 15_000);
    assert.equal(refreshIntervalMs(route), route === 'detail' ? 30_000 : 60_000);
    assert.equal(refreshIntervalMs(route, { displayOnly: false }), refreshIntervalMs(route));
  }
  for (const route of ['home', 'pools', 'market', 'governance', 'records', 'operator'])
    assert.equal(refreshIntervalMs(route, { displayOnly: true }), refreshIntervalMs(route));
});

test('polling pauses when hidden or busy and backs off after failure', () => {
  const state = { route: 'overview', lastAttempt: 1000, now: 61_000, visible: true, busy: false, failed: false };
  assert.equal(pageRefreshDue(state), true);
  assert.equal(pageRefreshDue({ ...state, visible: false }), false);
  assert.equal(pageRefreshDue({ ...state, busy: true }), false);
  assert.equal(pageRefreshDue({ ...state, failed: true }), false);
  assert.equal(pageRefreshDue({ ...state, failed: true, now: 121_000 }), true);
});

test('a cache business page updates after 15 seconds while the same verified-chain page stays idle', () => {
  const state = { route: 'overview', lastAttempt: 1000, now: 15_999, visible: true, busy: false, failed: false,
    displayOnly: true };
  assert.equal(pageRefreshDue(state), false);
  assert.equal(pageRefreshDue({ ...state, now: 16_000 }), true);
  assert.equal(pageRefreshDue({ ...state, now: 16_000, displayOnly: false }), false);
  assert.equal(pageRefreshDue({ ...state, now: 16_000, visible: false }), false);
  assert.equal(pageRefreshDue({ ...state, now: 16_000, busy: true }), false);
  assert.equal(pageRefreshDue({ ...state, now: 16_000, failed: true }), false);
  assert.equal(pageRefreshDue({ ...state, now: 121_000, failed: true }), true);
  assert.equal(pageRefreshDue({ ...state, now: 121_000, route: 'operator' }), false);
});
