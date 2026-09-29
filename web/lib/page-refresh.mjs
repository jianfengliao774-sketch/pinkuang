// Public market data changes more often; account and project pages can poll less often.
export function refreshIntervalMs(route) {
  if (['market', 'detail'].includes(route)) return 30_000;
  if (['home', 'pools', 'overview', 'rewards', 'governance', 'records', 'portfolio'].includes(route)) return 60_000;
  return null;
}

export function pageRefreshDue({ route, lastAttempt, now, visible, busy, failed }) {
  const interval = refreshIntervalMs(route);
  return interval !== null && visible && !busy
    && Number.isFinite(lastAttempt) && now - lastAttempt >= (failed ? Math.max(interval, 120_000) : interval);
}
