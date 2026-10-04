import test from 'node:test';
import assert from 'node:assert/strict';
import { activityTimeUtc8 } from '../lib/activity-time.mjs';

test('event time uses UTC+8 across a UTC date boundary, regardless of browser timezone', () => {
  const timestamp = Date.parse('2026-10-03T17:24:39Z') / 1000;
  assert.deepEqual(activityTimeUtc8(timestamp), { iso: '2026-10-03T17:24:39.000Z', label: '2026-10-04 01:24:39' });
  assert.equal(activityTimeUtc8(0).label, '1970-01-01 08:00:00');
});
test('unknown or invalid event timestamps never become a fabricated record time', () => {
  for (const value of [null, undefined, '', '1791048279', -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER]) {
    assert.equal(activityTimeUtc8(value), null);
  }
});
