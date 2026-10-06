// Business pages can refresh server materialized GETs more often without
// increasing the cadence of verified chain, quote or wallet reads.
export function refreshIntervalMs(route, { displayOnly = false } = {}) {
  if (displayOnly === true && ['overview', 'rewards', 'detail', 'portfolio'].includes(route)) return 15_000;
  if (['market', 'detail'].includes(route)) return 30_000;
  if (['home', 'pools', 'overview', 'rewards', 'governance', 'records', 'portfolio'].includes(route)) return 60_000;
  return null;
}

export function pageRefreshDue({ route, lastAttempt, now, visible, busy, failed, displayOnly = false }) {
  const interval = refreshIntervalMs(route, { displayOnly });
  return interval !== null && visible && !busy
    && Number.isFinite(lastAttempt) && now - lastAttempt >= (failed ? Math.max(interval, 120_000) : interval);
}
