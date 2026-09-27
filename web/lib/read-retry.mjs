// Only whole, read-only rounds belong here. Never wrap a wallet or transaction action.
export const READ_CANCELLED = Symbol('read cancelled');

export function isRetryableReadError(error) {
  return ['index_incomplete', 'index_stale', 'source_changed'].includes(error?.code)
    || (error?.code === 'http_unavailable' && [502, 503, 504].includes(error.details?.status));
}

/** Drain every started read before a failed round can be retried. */
export async function settleReadRound(reads) {
  const entries = Object.entries(reads);
  const results = await Promise.allSettled(entries.map(([, read]) => Promise.resolve().then(read)));
  const failures = results.filter(result => result.status === 'rejected');
  // A concurrent permission or integrity failure must not be hidden by a transient error.
  const failure = failures.find(result => !isRetryableReadError(result.reason)) || failures[0];
  if (failure) throw failure.reason;
  return Object.fromEntries(entries.map(([key], index) => [key, results[index].value]));
}

/** Up to three fresh rounds; obsolete route/account results are never returned for rendering. */
export async function retryReadRound(read, {
  isCurrent = () => true,
  onAttempt = () => {},
  wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
} = {}) {
  for (let attempt = 0; attempt < 3; attempt++) {
    if (!isCurrent()) return READ_CANCELLED;
    onAttempt();
    try {
      const result = await read();
      return isCurrent() ? result : READ_CANCELLED;
    } catch (error) {
      if (!isCurrent()) return READ_CANCELLED;
      if (!isRetryableReadError(error) || attempt === 2) throw error;
      await wait(1000);
    }
  }
}
