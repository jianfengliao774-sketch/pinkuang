// Only the mounted page refreshes. Forms and paid action/quote readers keep their own triggers.
export function refreshIntervalMs(route, { displayOnly = false } = {}) {
  if (displayOnly === true && ['home', 'pools', 'market', 'detail', 'overview', 'rewards', 'governance', 'records', 'portfolio'].includes(route)) return 30_000;
  if (['market', 'detail'].includes(route)) return 30_000;
  if (['home', 'pools', 'overview', 'rewards', 'governance', 'records', 'portfolio'].includes(route)) return 60_000;
  return null;
}

export function pageRefreshDue({ route, lastAttempt, now, visible, busy, failed, displayOnly = false }) {
  const interval = refreshIntervalMs(route, { displayOnly });
  return interval !== null && visible && !busy
    && Number.isFinite(lastAttempt) && now - lastAttempt >= (failed ? Math.max(interval, 120_000) : interval);
}
