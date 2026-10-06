/** Serialize independent reads so complete graph proofs do not burst at the archive node.
 * This only queues read RPCs; wallet requests, results and errors are not rewritten.
 */
export function pacePortfolioDustRpc(send, { intervalMs = 1100, now = Date.now,
  wait = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  if (typeof send !== 'function' || !Number.isSafeInteger(intervalMs) || intervalMs < 0)
    throw new TypeError('A read RPC and a nonnegative pacing interval are required.');
  let tail = Promise.resolve(), lastStart = null;
  return (method, params) => {
    const task = tail.then(async () => {
      if (lastStart !== null) {
        const remaining = lastStart + intervalMs - now();
        if (remaining > 0) await wait(remaining);
      }
      lastStart = now();
      return send(method, params);
    });
    tail = task.then(() => undefined, () => undefined);
    return task;
  };
}
