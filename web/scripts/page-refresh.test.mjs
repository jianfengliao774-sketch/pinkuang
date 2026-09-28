import test from 'node:test';
import assert from 'node:assert/strict';
import { pageRefreshDue, refreshIntervalMs } from '../lib/page-refresh.mjs';

test('refresh cadence is route-scoped and operator forms do not poll', () => {
  assert.equal(refreshIntervalMs('market'), 30_000);
  assert.equal(refreshIntervalMs('detail'), 30_000);
  assert.equal(refreshIntervalMs('overview'), 60_000);
  assert.equal(refreshIntervalMs('operator'), null);
});

test('polling pauses when hidden or busy and backs off after failure', () => {
  const state = { route: 'overview', lastAttempt: 1000, now: 61_000, visible: true, busy: false, failed: false };
  assert.equal(pageRefreshDue(state), true);
  assert.equal(pageRefreshDue({ ...state, visible: false }), false);
  assert.equal(pageRefreshDue({ ...state, busy: true }), false);
  assert.equal(pageRefreshDue({ ...state, failed: true }), false);
  assert.equal(pageRefreshDue({ ...state, failed: true, now: 121_000 }), true);
});
