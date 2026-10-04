import test from 'node:test';
import assert from 'node:assert/strict';
import { activityCompactTimeUtc8, activityTimeUtc8 } from '../lib/activity-time.mjs';

test('event time uses UTC+8 across a UTC date boundary, regardless of browser timezone', () => {
  const timestamp = Date.parse('2026-10-03T17:24:39Z') / 1000;
  assert.deepEqual(activityTimeUtc8(timestamp), { iso: '2026-10-03T17:24:39.000Z', label: '2026-10-04 01:24:39' });
  assert.equal(activityTimeUtc8(0).label, '1970-01-01 08:00:00');
});
test('unknown or invalid event timestamps never become a fabricated record time', () => {
  for (const value of [null, undefined, '', '1791048279', -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER]) {
    assert.equal(activityTimeUtc8(value), null);
    assert.equal(activityCompactTimeUtc8(value), null);
  }
});

test('compact time keeps the original UTC instant and exposes the UTC+8 date and clock', () => {
  const timestamp = Date.parse('2026-10-03T17:24:39Z') / 1000;
  assert.deepEqual(activityCompactTimeUtc8(timestamp), {
    iso: '2026-10-03T17:24:39.000Z', label: '26-10-04 01:24:39',
    date: '26-10-04', clock: '01:24:39', fullLabel: '2026-10-04 01:24:39',
  });
  assert.equal(activityTimeUtc8(timestamp).label, '2026-10-04 01:24:39');
  assert.deepEqual(activityCompactTimeUtc8(0), {
    iso: '1970-01-01T00:00:00.000Z', label: '70-01-01 08:00:00',
    date: '70-01-01', clock: '08:00:00', fullLabel: '1970-01-01 08:00:00',
  });
});

test('compact UTC+8 dates cross years and retain two-digit years without losing the full year', () => {
  assert.deepEqual(activityCompactTimeUtc8(Date.parse('2026-12-31T20:02:03Z') / 1000), {
    iso: '2026-12-31T20:02:03.000Z', label: '27-01-01 04:02:03',
    date: '27-01-01', clock: '04:02:03', fullLabel: '2027-01-01 04:02:03',
  });
  assert.deepEqual(activityCompactTimeUtc8(Date.parse('2099-12-31T16:00:00Z') / 1000), {
    iso: '2099-12-31T16:00:00.000Z', label: '00-01-01 00:00:00',
    date: '00-01-01', clock: '00:00:00', fullLabel: '2100-01-01 00:00:00',
  });
});

test('compact time is independent of the host timezone', () => {
  const original = process.env.TZ;
  try {
    for (const timezone of ['UTC', 'Pacific/Honolulu', 'Asia/Tokyo']) {
      process.env.TZ = timezone;
      const value = activityCompactTimeUtc8(Date.parse('2026-10-03T17:24:39Z') / 1000);
      assert.equal(value.date, '26-10-04');
      assert.equal(value.clock, '01:24:39');
      assert.equal(value.iso, '2026-10-03T17:24:39.000Z');
    }
  } finally {
    if (original === undefined) delete process.env.TZ;
    else process.env.TZ = original;
  }
});
