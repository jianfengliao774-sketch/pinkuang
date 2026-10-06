// Keep older snapshots for instant display, but only skip a server GET briefly.
export const DISPLAY_REFRESH_REUSE_MS = 15_000;
export function displayRefreshPageKey(route, account) {
  return JSON.stringify([route.route, route.pool?.toLowerCase() || '', account?.toLowerCase() || '']);
}

/** Push and periodic reads share a page/account budget. A paused push keeps
 * its latest dirty revision inside the stream until this budget is available. */
export function automaticDisplayRefreshDue({ lastAttempt, now = Date.now(), failed = false }) {
  if (!Number.isFinite(now)) return false;
  return !Number.isFinite(lastAttempt)
    || now - lastAttempt >= (failed ? 120_000 : DISPLAY_REFRESH_REUSE_MS);
}

export function canReuseDisplayRead(entry, generation, now = Date.now()) {
  return !!entry && entry.refresh === generation && Number.isFinite(entry.savedAt)
    && now >= entry.savedAt && now - entry.savedAt < DISPLAY_REFRESH_REUSE_MS;
}

/** Reading a materialized cache cannot submit or replace a transaction.
 * Preserve input previews and in-flight reads, while allowing pending/result
 * status to coexist with fresh balances and purchase progress. */
export function displayRefreshPaused(state = {}, {
  displayOnly = false, portfolioBusy = false, pastFirstRecordsPage = false,
} = {}) {
  return !!(state.loading || state.busy || state.inputModal || portfolioBusy || pastFirstRecordsPage
    || !displayOnly && (state.modal || state.pending));
}
