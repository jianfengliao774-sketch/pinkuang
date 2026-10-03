// Only whole, read-only rounds belong here. Never wrap a wallet or transaction action.
export const READ_CANCELLED = Symbol('read cancelled');
export const READ_RETRY_DELAYS_MS = Object.freeze([1000, 2000, 4000, 8000, 12000, 12000]);
export const READ_RETRY_MAX_ATTEMPTS = READ_RETRY_DELAYS_MS.length + 1;

export function isRetryableReadError(error) {
  return ['index_incomplete', 'index_stale', 'source_changed', 'rpc_error'].includes(error?.code)
    || (error?.code === 'http_unavailable' && [429, 502, 503, 504].includes(error.details?.status));
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

/** Bounded fresh rounds only. The elapsed budget stops scheduling further rounds;
 * an already-started round still drains under its own HTTP/RPC timeouts. */
export async function retryReadRound(read, {
  isCurrent = () => true,
  onAttempt = () => {},
  onRetry = () => {},
  wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
  now = () => Date.now(),
} = {}) {
  const startedAt = now();
  for (let attempt = 0; attempt < READ_RETRY_MAX_ATTEMPTS; attempt++) {
    if (!isCurrent()) return READ_CANCELLED;
    onAttempt({ attempt: attempt + 1, maxAttempts: READ_RETRY_MAX_ATTEMPTS });
    try {
      const result = await read();
      return isCurrent() ? result : READ_CANCELLED;
    } catch (error) {
      if (!isCurrent()) return READ_CANCELLED;
      const delayMs = READ_RETRY_DELAYS_MS[attempt];
      if (!isRetryableReadError(error) || delayMs === undefined || now() - startedAt + delayMs >= 45000) throw error;
      onRetry({ attempt: attempt + 2, maxAttempts: READ_RETRY_MAX_ATTEMPTS, delayMs });
      await wait(delayMs);
      if (!isCurrent()) return READ_CANCELLED;
      // Background-tab timer throttling must not restart old reads indefinitely.
      if (now() - startedAt >= 45000) throw error;
    }
  }
}
