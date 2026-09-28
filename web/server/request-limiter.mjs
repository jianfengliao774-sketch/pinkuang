// The retired live API may be deployed separately from the integrated deploy service.
export function createRequestLimiter({ perClient, windowMs = 60_000, now = Date.now }) {
  let window = -1;
  const counts = new Map();
  return req => {
    const current = Math.floor(now() / windowMs);
    if (current !== window) { window = current; counts.clear(); }
    const peer = req.socket?.remoteAddress ?? 'unknown';
    const realIp = req.headers?.['x-real-ip'];
    const client = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(peer)
      && typeof realIp === 'string' && /^[\da-fA-F:.]{3,45}$/.test(realIp) ? realIp : peer;
    const count = counts.get(client) ?? 0;
    if (count >= perClient || count === 0 && counts.size >= 10_000) return false;
    counts.set(client, count + 1);
    return true;
  };
}
